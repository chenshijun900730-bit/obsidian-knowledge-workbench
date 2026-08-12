import { sha256 } from "../../src/core/hash";
import { normalizeVaultPath } from "../../src/core/path-policy";
import type { VaultEvent, VaultFileRef, VaultReadPort, VaultWritePort } from "../../src/core/ports";
import { sameFieldState, type FieldState, type FilePrecondition, type OwnedField, type VaultNote, type VaultPath } from "../../src/core/types";

export interface RenameFileCall {
  readonly sourcePath: VaultPath;
  readonly targetPath: VaultPath;
}

export interface SetOwnedFieldCall {
  readonly path: VaultPath;
  readonly field: OwnedField;
  readonly expected: FieldState;
  readonly next: FieldState;
}

export type VaultWriteCall =
  | Readonly<{ kind: "rename-file" } & RenameFileCall>
  | Readonly<{ kind: "set-owned-field" } & SetOwnedFieldCall>;

type ApplicableVaultEvent = Readonly<{ kind: "create" | "modify" | "delete"; path: VaultPath }>;

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const isString = (value: unknown): value is string => typeof value === "string";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const basenameOf = (path: VaultPath): string => {
  const leaf = path.split("/").at(-1) ?? path;
  return leaf.toLocaleLowerCase("en-US").endsWith(".md") ? leaf.slice(0, -3) : leaf;
};

const copyFieldState = (state: FieldState): FieldState => {
  if (!state.present) return { present: false };
  return { present: true, value: typeof state.value === "string" ? state.value : [...state.value] };
};

const fieldStateFrom = (value: unknown): FieldState | null => {
  if (typeof value === "string") return { present: true, value };
  if (Array.isArray(value)) {
    const strings = value.filter(isString);
    if (strings.length === value.length) return { present: true, value: [...strings] };
  }
  return null;
};

const cloneFrontmatter = (frontmatter: Readonly<Record<string, unknown>>): Record<string, unknown> => Object.fromEntries(
  Object.entries(frontmatter).map(([key, value]) => [key, Array.isArray(value) ? Array.from(value as readonly unknown[]) : value]),
);

const cloneNote = (note: VaultNote): VaultNote => ({
  ...note,
  frontmatter: cloneFrontmatter(note.frontmatter),
  headings: [...note.headings],
  outgoingLinks: [...note.outgoingLinks],
});

const yamlScalar = (value: string): string => JSON.stringify(value);

const renderContent = (note: VaultNote, frontmatter: Readonly<Record<string, unknown>>): string => {
  const body = note.content.startsWith("---\n") ? (note.content.split("\n---\n", 2)[1] ?? note.content) : note.content;
  const entries = Object.entries(frontmatter).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return body;
  const yaml = entries.map(([key, value]) => {
    if (typeof value === "string") return `${key}: ${yamlScalar(value)}`;
    if (Array.isArray(value)) return `${key}: [${value.map((item) => yamlScalar(String(item))).join(", ")}]`;
    return `${key}: ${JSON.stringify(value)}`;
  }).join("\n");
  return `---\n${yaml}\n---\n${body}`;
};

export class FakeVault implements VaultReadPort, VaultWritePort {
  private readonly notes = new Map<VaultPath, VaultNote>();
  private readonly inboundByPath = new Map<VaultPath, readonly VaultPath[]>();
  private readonly listeners = new Set<(event: VaultEvent) => void>();
  private metadataReady = true;
  private nextMtime = 1;
  private activeReads = 0;
  private pauseReadPath: VaultPath | null = null;
  private readPaused: Deferred | null = null;
  private resumeRead: Deferred | null = null;
  private writeTail: Promise<void> = Promise.resolve();

  readonly readCounts = new Map<VaultPath, number>();
  maxConcurrentReads = 0;
  readonly renameCalls: RenameFileCall[] = [];
  readonly renameFileCalls = this.renameCalls;
  readonly setOwnedFieldCalls: SetOwnedFieldCall[] = [];
  readonly writeCalls: VaultWriteCall[] = [];

  static withNotes(paths: readonly VaultPath[]): FakeVault {
    return new FakeVault().withNotes(paths);
  }

  withNotes(paths: readonly VaultPath[]): this {
    for (const path of paths) {
      const normalized = normalizeVaultPath(path);
      if (!this.notes.has(normalized)) this.notes.set(normalized, this.makeNote(normalized));
    }
    return this;
  }

  withGeneratedNotes(notes: readonly VaultNote[]): this {
    for (const source of notes) {
      const normalized = normalizeVaultPath(source.path);
      if (normalized !== source.path || !normalized.toLocaleLowerCase("en-US").endsWith(".md")) {
        throw new Error(`generated-note-path-invalid:${source.path}`);
      }
      if (!Number.isFinite(source.mtime) || source.mtime < 0 || source.size !== byteLength(source.content)) {
        throw new Error(`generated-note-metadata-invalid:${source.path}`);
      }
      this.notes.set(normalized, cloneNote(source));
      this.nextMtime = Math.max(this.nextMtime, Math.floor(source.mtime) + 1);
    }
    return this;
  }

  replaceWithNotes(paths: readonly VaultPath[]): this {
    this.notes.clear();
    this.inboundByPath.clear();
    this.nextMtime = 1;
    return this.withNotes(paths);
  }

  setInboundLinks(path: VaultPath, links: readonly VaultPath[]): this {
    this.inboundByPath.set(normalizeVaultPath(path), links.map(normalizeVaultPath));
    return this;
  }

  setMetadataReady(ready: boolean): this {
    this.metadataReady = ready;
    return this;
  }

  pauseReadAt(path: VaultPath): void {
    if (this.resumeRead !== null) throw new Error("A vault read pause is already armed");
    this.pauseReadPath = normalizeVaultPath(path);
    this.readPaused = deferred();
    this.resumeRead = deferred();
  }

  async waitUntilReadPaused(): Promise<void> {
    if (this.readPaused === null) throw new Error("No vault read pause is armed");
    await this.readPaused.promise;
  }

  resumeReads(): void {
    if (this.resumeRead === null) throw new Error("No vault read pause is armed");
    this.resumeRead.resolve();
  }

  setOwnedFieldExternally(path: VaultPath, field: OwnedField, state: unknown): this {
    if (state === undefined) this.updateOwnedFieldRaw(path, field, false, undefined);
    else if (typeof state === "object" && state !== null && "present" in state) {
      if (state.present === false) this.updateOwnedFieldRaw(path, field, false, undefined);
      else if (state.present === true) this.updateOwnedFieldRaw(path, field, true, "value" in state ? state.value : undefined);
      else this.updateOwnedFieldRaw(path, field, true, state);
    } else this.updateOwnedFieldRaw(path, field, true, state);
    return this;
  }

  applyEvent(event: ApplicableVaultEvent): void;
  applyEvent(kind: ApplicableVaultEvent["kind"], path: VaultPath): void;
  applyEvent(eventOrKind: ApplicableVaultEvent | ApplicableVaultEvent["kind"], path?: VaultPath): void {
    const event = typeof eventOrKind === "string"
      ? { kind: eventOrKind, path: normalizeVaultPath(path ?? "") }
      : { ...eventOrKind, path: normalizeVaultPath(eventOrKind.path) };
    if (event.kind === "create") {
      if (!this.notes.has(event.path)) this.notes.set(event.path, this.makeNote(event.path));
    } else if (event.kind === "modify") {
      this.modifyNote(event.path);
    } else {
      this.notes.delete(event.path);
      this.inboundByPath.delete(event.path);
      for (const [path, links] of this.inboundByPath) {
        const remaining = links.filter((link) => link !== event.path);
        if (remaining.length !== links.length) this.inboundByPath.set(path, remaining);
      }
    }
    this.emit(event);
  }

  rename(sourcePath: VaultPath, targetPath: VaultPath): void {
    const source = normalizeVaultPath(sourcePath);
    const target = normalizeVaultPath(targetPath);
    const note = this.requireNote(source);
    if (this.notes.has(target)) throw new Error(`target-exists:${target}`);
    this.notes.delete(source);
    this.notes.set(target, { ...cloneNote(note), path: target, basename: basenameOf(target) });
    const inbound = this.inboundByPath.get(source);
    if (inbound !== undefined) {
      this.inboundByPath.delete(source);
      this.inboundByPath.set(target, inbound);
    }
    for (const [path, links] of this.inboundByPath) {
      if (links.includes(source)) this.inboundByPath.set(path, links.map((link) => link === source ? target : link));
    }
    this.emit({ kind: "rename", path: target, oldPath: source });
  }

  modifyExternally(path: VaultPath, content?: string): void {
    this.modifyNote(normalizeVaultPath(path), content);
    this.emit({ kind: "modify", path: normalizeVaultPath(path) });
  }

  mtimeOf(path: VaultPath): number | null {
    return this.notes.get(normalizeVaultPath(path))?.mtime ?? null;
  }

  async listMarkdownFiles(): Promise<readonly VaultFileRef[]> {
    return [...this.notes.values()]
      .map(({ path, mtime, size }) => ({ path, mtime, size }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async listMarkdownPaths(): Promise<readonly VaultPath[]> {
    return [...this.notes.keys()].sort((left, right) => left.localeCompare(right));
  }

  async readNote(path: VaultPath): Promise<VaultNote | null> {
    const normalized = normalizeVaultPath(path);
    this.readCounts.set(normalized, (this.readCounts.get(normalized) ?? 0) + 1);
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    try {
      if (normalized === this.pauseReadPath && this.readPaused !== null && this.resumeRead !== null) {
        const reached = this.readPaused;
        const resume = this.resumeRead;
        this.pauseReadPath = null;
        reached.resolve();
        await resume.promise;
        this.readPaused = null;
        this.resumeRead = null;
      } else {
        await Promise.resolve();
      }
      const note = this.notes.get(normalized);
      return note === undefined ? null : cloneNote(note);
    } finally {
      this.activeReads -= 1;
    }
  }

  async readOwnedField(path: VaultPath, field: OwnedField): Promise<FieldState | null> {
    const note = this.notes.get(normalizeVaultPath(path));
    if (note === undefined) return null;
    if (!Object.prototype.hasOwnProperty.call(note.frontmatter, field)) return { present: false };
    return fieldStateFrom(note.frontmatter[field]);
  }

  async snapshot(path: VaultPath) {
    const normalized = normalizeVaultPath(path);
    const note = this.notes.get(normalized);
    if (note === undefined) return { path: normalized, exists: false } as const;
    return { path: normalized, exists: true, mtime: note.mtime, contentHash: await sha256(note.content) } as const;
  }

  async inboundLinks(path: VaultPath): Promise<readonly VaultPath[] | null> {
    if (!this.metadataReady) return null;
    return [...(this.inboundByPath.get(normalizeVaultPath(path)) ?? [])];
  }

  async pathExists(path: VaultPath): Promise<boolean> {
    return this.notes.has(normalizeVaultPath(path));
  }

  subscribe(listener: (event: VaultEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async renameFile(
    sourcePath: VaultPath,
    targetPath: VaultPath,
    expectedSource: FilePrecondition,
    expectedTarget: FilePrecondition,
  ): Promise<void> {
    const call = { sourcePath: normalizeVaultPath(sourcePath), targetPath: normalizeVaultPath(targetPath) };
    this.renameCalls.push(call);
    this.writeCalls.push({ kind: "rename-file", ...call });
    await this.runWriteExclusive(async () => {
      if (sourcePath !== call.sourcePath || targetPath !== call.targetPath) throw new Error("rename-path-not-normalized");
      const sourceSnapshot = await this.snapshot(call.sourcePath);
      const targetSnapshot = await this.snapshot(call.targetPath);
      if (!this.samePrecondition(sourceSnapshot, expectedSource)) throw new Error(`source-precondition-failed:${call.sourcePath}`);
      if (!this.samePrecondition(targetSnapshot, expectedTarget)) throw new Error(`target-precondition-failed:${call.targetPath}`);
      const sourceNote = this.notes.get(call.sourcePath);
      if (!sourceSnapshot.exists || sourceNote === undefined || sourceNote.mtime !== sourceSnapshot.mtime) {
        throw new Error(`source-changed-before-rename:${call.sourcePath}`);
      }
      if (this.notes.has(call.targetPath)) throw new Error(`target-exists:${call.targetPath}`);
      const targetKey = call.targetPath.toLocaleLowerCase("en-US");
      if ([...this.notes.keys()].some((path) => path !== call.sourcePath && path.toLocaleLowerCase("en-US") === targetKey)) {
        throw new Error(`case-collision:${call.targetPath}`);
      }
      if (!this.metadataReady) throw new Error(`metadata-not-ready:${call.sourcePath}`);
      if ((this.inboundByPath.get(call.sourcePath) ?? []).length > 0) throw new Error(`inbound-links:${call.sourcePath}`);
      this.rename(call.sourcePath, call.targetPath);
    });
  }

  async setOwnedField(path: VaultPath, field: OwnedField, expected: FieldState, next: FieldState): Promise<void> {
    const normalized = normalizeVaultPath(path);
    const call = { path: normalized, field, expected: copyFieldState(expected), next: copyFieldState(next) };
    this.setOwnedFieldCalls.push(call);
    this.writeCalls.push({ kind: "set-owned-field", ...call });
    const current = this.ownedFieldState(normalized, field);
    if (current === null) throw new Error(`file-not-found:${normalized}`);
    if (!sameFieldState(current, expected)) throw new Error(`field-precondition-failed:${normalized}:${field}`);
    this.updateOwnedField(normalized, field, next);
    this.emit({ kind: "modify", path: normalized });
  }

  private ownedFieldState(path: VaultPath, field: OwnedField): FieldState | null {
    const note = this.notes.get(path);
    if (note === undefined) return null;
    if (!Object.prototype.hasOwnProperty.call(note.frontmatter, field)) return { present: false };
    return fieldStateFrom(note.frontmatter[field]);
  }

  private samePrecondition(left: FilePrecondition, right: FilePrecondition): boolean {
    return left.path === right.path
      && left.exists === right.exists
      && (!left.exists || !right.exists || (left.mtime === right.mtime && left.contentHash === right.contentHash));
  }

  private runWriteExclusive(action: () => Promise<void>): Promise<void> {
    const operation = this.writeTail.catch(() => undefined).then(action);
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private makeNote(path: VaultPath): VaultNote {
    const basename = basenameOf(path);
    const content = `# ${basename}\n\nDeterministic content for ${path}.\n`;
    return {
      path,
      basename,
      mtime: this.takeMtime(),
      size: byteLength(content),
      content,
      frontmatter: {},
      headings: [basename],
      outgoingLinks: [],
    };
  }

  private requireNote(path: VaultPath): VaultNote {
    const note = this.notes.get(path);
    if (note === undefined) throw new Error(`file-not-found:${path}`);
    return note;
  }

  private modifyNote(path: VaultPath, content?: string): void {
    const note = this.requireNote(path);
    const mtime = this.takeMtime();
    const nextContent = content ?? `${note.content.trimEnd()}\n\nExternal modification ${mtime}.\n`;
    this.notes.set(path, { ...cloneNote(note), content: nextContent, mtime, size: byteLength(nextContent) });
  }

  private updateOwnedField(path: VaultPath, field: OwnedField, state: FieldState): void {
    this.updateOwnedFieldRaw(path, field, state.present, state.present ? state.value : undefined);
  }

  private updateOwnedFieldRaw(path: VaultPath, field: OwnedField, present: boolean, value: unknown): void {
    const normalized = normalizeVaultPath(path);
    const note = this.requireNote(normalized);
    const frontmatter = cloneFrontmatter(note.frontmatter);
    if (present) frontmatter[field] = Array.isArray(value) ? Array.from(value as readonly unknown[]) : value;
    else delete frontmatter[field];
    const content = renderContent(note, frontmatter);
    this.notes.set(normalized, {
      ...cloneNote(note),
      frontmatter,
      content,
      mtime: this.takeMtime(),
      size: byteLength(content),
    });
  }

  private takeMtime(): number {
    return this.nextMtime++;
  }

  private emit(event: VaultEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
