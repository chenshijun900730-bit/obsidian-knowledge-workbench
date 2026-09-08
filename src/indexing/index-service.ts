import { sha256 } from "../core/hash";
import type { Clock, VaultEvent, VaultReadPort } from "../core/ports";
import type { DocumentRecord } from "../core/types";
import type { PluginDataStore } from "../storage/plugin-data-store";
import { extractDocumentRecord } from "./markdown-record-extractor";

export interface ScanProgress {
  readonly completed: number;
  readonly total: number;
  readonly path: string;
}

export interface IndexPathPolicy {
  key(): string;
  includes(path: string): boolean;
}

const ALLOW_ALL: IndexPathPolicy = {
  key: () => "all",
  includes: () => true,
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException("Index scan canceled", "AbortError");
};

const sortRecords = (records: Iterable<DocumentRecord>): DocumentRecord[] => [...records].sort((left, right) => left.path.localeCompare(right.path));
const replaceEvent = (events: Map<string, VaultEvent>, event: VaultEvent): void => {
  events.delete(event.path);
  events.set(event.path, event);
};

export class IndexService {
  private records = new Map<string, DocumentRecord>();
  private readonly listeners = new Set<(records: readonly DocumentRecord[]) => void>();

  constructor(
    private readonly vault: VaultReadPort,
    private readonly store: PluginDataStore,
    private readonly clock: Clock,
    private readonly concurrency = 8,
    private readonly pathPolicy: IndexPathPolicy = ALLOW_ALL,
  ) {
    if (!Number.isInteger(concurrency) || concurrency <= 0) throw new RangeError("Index scan concurrency must be a positive integer");
    store.forEachActiveIndexRecord((record) => this.records.set(record.path, record));
  }

  activeRecords(): readonly DocumentRecord[] {
    return sortRecords(this.records.values());
  }

  subscribe(listener: (records: readonly DocumentRecord[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async buildInitial(signal: AbortSignal, onProgress: (progress: ScanProgress) => void): Promise<void> {
    throwIfAborted(signal);
    const files = [...await this.vault.listMarkdownFiles()]
      .filter((file) => this.pathPolicy.includes(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    const paths = files.map((file) => file.path);
    const scanId = await sha256(JSON.stringify({
      policy: this.pathPolicy.key(),
      files: files.map(({ path, mtime, size }) => [path, mtime, size]),
    }));
    const previous = this.store.staging();
    const canResume = previous?.scanId === scanId;
    const completed = new Set(canResume ? previous.completedPaths : []);
    const records = new Map((canResume ? previous.records : []).map((record) => [record.path, record]));

    if (!canResume) {
      await this.store.saveCheckpoint({ scanId, completedPaths: [], records: [] });
      throwIfAborted(signal);
    }

    const pending = paths.filter((path) => !completed.has(path));
    let sinceCheckpoint = 0;
    let offset = 0;
    while (offset < pending.length) {
      throwIfAborted(signal);
      const untilCheckpoint = 250 - sinceCheckpoint;
      const batch = pending.slice(offset, offset + Math.min(this.concurrency, untilCheckpoint));
      const values = await Promise.all(batch.map(async (path): Promise<DocumentRecord | null> => {
        throwIfAborted(signal);
        const note = await this.vault.readNote(path);
        return note === null ? null : extractDocumentRecord(note);
      }));
      throwIfAborted(signal);

      for (let index = 0; index < values.length; index += 1) {
        const path = batch[index];
        if (path === undefined) continue;
        const value = values[index];
        completed.add(path);
        sinceCheckpoint += 1;
        if (value !== null && value !== undefined) records.set(path, value);
        onProgress({ completed: completed.size, total: paths.length, path });
        throwIfAborted(signal);
      }

      offset += batch.length;
      if (sinceCheckpoint >= 250 || offset >= pending.length) {
        await this.store.saveCheckpoint({
          scanId,
          completedPaths: [...completed].sort(),
          records: sortRecords(records.values()),
        });
        sinceCheckpoint = 0;
        throwIfAborted(signal);
      }
    }

    throwIfAborted(signal);
    await this.store.promoteStaging(scanId, this.clock.now());
    this.records = new Map();
    this.store.forEachActiveIndexRecord((record) => this.records.set(record.path, record));
    this.emit();
  }

  async applyEvents(events: readonly VaultEvent[]): Promise<void> {
    const coalesced = new Map<string, VaultEvent>();
    for (const event of events) {
      if (event.kind === "rename") {
        replaceEvent(coalesced, { kind: "delete", path: event.oldPath });
        replaceEvent(coalesced, { kind: "create", path: event.path });
      } else replaceEvent(coalesced, event);
    }
    if (coalesced.size === 0) return;

    const next = new Map(this.records);
    const ordered = [...coalesced.values()].sort((left, right) => left.path.localeCompare(right.path));
    for (const event of ordered) {
      if (event.kind === "delete" || !this.pathPolicy.includes(event.path)) {
        next.delete(event.path);
        continue;
      }
      const note = await this.vault.readNote(event.path);
      if (note === null) next.delete(event.path);
      else next.set(event.path, await extractDocumentRecord(note));
    }

    await this.store.saveActiveIndex({ builtAt: this.clock.now(), records: sortRecords(next.values()) });
    this.records = next;
    this.emit();
  }

  async reconcilePathPolicy(): Promise<void> {
    const next = new Map([...this.records].filter(([path]) => this.pathPolicy.includes(path)));
    await this.store.saveActiveIndex({ builtAt: this.clock.now(), records: sortRecords(next.values()) });
    this.records = next;
    this.emit();
  }

  async reconcileInventory(): Promise<void> {
    const files = new Map((await this.vault.listMarkdownFiles())
      .filter((file) => this.pathPolicy.includes(file.path))
      .map((file) => [file.path, file]));
    const events: VaultEvent[] = [];
    for (const record of this.records.values()) {
      if (!files.has(record.path)) events.push({ kind: "delete", path: record.path });
    }
    for (const file of files.values()) {
      const record = this.records.get(file.path);
      if (record === undefined) events.push({ kind: "create", path: file.path });
      else if (record.mtime !== file.mtime || record.size !== file.size) events.push({ kind: "modify", path: file.path });
    }
    if (events.length > 0) await this.applyEvents(events);
  }

  private emit(): void {
    const records = this.activeRecords();
    for (const listener of this.listeners) listener(records);
  }
}
