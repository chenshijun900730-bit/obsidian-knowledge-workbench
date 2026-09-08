import { normalizeCloudAbsolutePath } from "./catalog-path";
import type { BaiduCatalogSourcePort } from "./catalog-ports";
import { validateBaiduListEntry } from "./cloud-directory-page-validator";
import { CatalogError, type BaiduListEntry } from "./catalog-types";

export const CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET = /* @__PURE__ */ Object.freeze({
  maxEntryCount: 20_000,
  maxListRequestCount: 20,
  maxDurationMs: 120_000,
} as const);

export type CloudDirectoryBrowserStopReason =
  | "complete"
  | "entry-limit"
  | "list-request-limit"
  | "time-limit"
  | "user-canceled";

export interface CloudDirectoryIdentity {
  readonly fsId: string;
  readonly path: string;
  readonly filename: string;
}

export interface CloudDirectoryLayerSnapshot {
  readonly path: string;
  readonly directories: readonly CloudDirectoryIdentity[];
  readonly nextStart: number | null;
  readonly complete: boolean;
  readonly cumulativeCheckedEntryCount: number;
  readonly cumulativeListRequestCount: number;
  readonly lastStopReason: CloudDirectoryBrowserStopReason | null;
}

export interface CloudDirectoryBrowseRound {
  readonly path: string;
  readonly status: "complete" | "paused" | "canceled";
  readonly stopReason: CloudDirectoryBrowserStopReason;
  readonly nextStart: number | null;
  readonly checkedEntryCount: number;
  readonly cumulativeCheckedEntryCount: number;
  readonly directoryCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
  readonly elapsedMs: number;
}

export interface CloudDirectoryBrowserRuntime {
  rootAccessGranted(): boolean;
  grantRootAccess(): void;
  loadLayer(
    input: Readonly<{ path: string; start: number }>,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryBrowseRound>;
  snapshot(path: string): CloudDirectoryLayerSnapshot | null;
  subscribe(listener: (path: string) => void): () => void;
  clear(): void;
  dispose(): void;
}

export interface CloudDirectoryBrowserServiceOptions {
  readonly now?: () => number;
}

interface CloudDirectoryLayerState {
  readonly path: string;
  directories: CloudDirectoryIdentity[];
  directoryFsIdByPath: Map<string, string>;
  directoryPathByFsId: Map<string, string>;
  nextStart: number | null;
  complete: boolean;
  cumulativeCheckedEntryCount: number;
  cumulativeListRequestCount: number;
  lastStopReason: CloudDirectoryBrowserStopReason | null;
}

interface RoundState {
  readonly startedAt: number;
  checkedEntryCount: number;
  listRequestCount: number;
  deniedPermitReason: PauseReason | null;
}

interface ActiveOperation {
  readonly generation: number;
  readonly controller: AbortController;
}

interface ValidatedPage {
  readonly entries: readonly BaiduListEntry[];
  readonly directories: CloudDirectoryIdentity[];
  readonly directoryFsIdByPath: Map<string, string>;
  readonly directoryPathByFsId: Map<string, string>;
}

type PauseReason = Exclude<CloudDirectoryBrowserStopReason, "complete">;

class CloudDirectoryBrowserPause extends Error {
  constructor(readonly reason: PauseReason) {
    super(reason);
    this.name = "CloudDirectoryBrowserPause";
  }
}

const invalidResponse = (): CatalogError => new CatalogError("invalid-baidu-response");

const invalidStart = (): RangeError => new RangeError(
  "cloud-directory-browser-start-invalid",
);

const unavailable = (): Error => new Error("cloud-directory-browser-unavailable");

const safeNow = (now: () => number): number => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
};

const elapsedAt = (startedAt: number, at: number): number => {
  if (at < startedAt) throw invalidResponse();
  return at - startedAt;
};

const statusFor = (
  reason: CloudDirectoryBrowserStopReason,
): CloudDirectoryBrowseRound["status"] => {
  if (reason === "complete") return "complete";
  if (reason === "user-canceled") return "canceled";
  return "paused";
};

const cloneDirectory = (
  directory: CloudDirectoryIdentity,
): CloudDirectoryIdentity => ({ ...directory });

const createLayer = (path: string): CloudDirectoryLayerState => ({
  path,
  directories: [],
  directoryFsIdByPath: new Map(),
  directoryPathByFsId: new Map(),
  nextStart: 0,
  complete: false,
  cumulativeCheckedEntryCount: 0,
  cumulativeListRequestCount: 0,
  lastStopReason: null,
});

export class CloudDirectoryBrowserService implements CloudDirectoryBrowserRuntime {
  readonly #source: BaiduCatalogSourcePort;
  readonly #now: () => number;
  readonly #layers = new Map<string, CloudDirectoryLayerState>();
  readonly #listeners = new Set<(path: string) => void>();
  #rootAccessGranted = false;
  #disposed = false;
  #generation = 0;
  #active: ActiveOperation | null = null;

  constructor(
    source: BaiduCatalogSourcePort,
    options: CloudDirectoryBrowserServiceOptions = {},
  ) {
    this.#source = source;
    this.#now = options.now ?? Date.now;
  }

  rootAccessGranted(): boolean {
    this.#assertAvailable();
    return this.#rootAccessGranted;
  }

  grantRootAccess(): void {
    this.#assertAvailable();
    this.#rootAccessGranted = true;
  }

  async loadLayer(
    input: Readonly<{ path: string; start: number }>,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryBrowseRound> {
    this.#assertAvailable();
    if (this.#active !== null) throw new Error("cloud-directory-browser-busy");

    const path = normalizeCloudAbsolutePath(input.path);
    if (path === "/" && !this.#rootAccessGranted) {
      throw new Error("cloud-directory-root-consent-required");
    }
    this.#assertStart(input.start);

    let layer = this.#layers.get(path);
    if (layer === undefined) {
      if (input.start !== 0) throw invalidStart();
      layer = createLayer(path);
      this.#layers.set(path, layer);
    } else if (layer.nextStart !== input.start) {
      throw invalidStart();
    }

    const startedAt = safeNow(this.#now);
    const operation: ActiveOperation = {
      generation: this.#generation + 1,
      controller: new AbortController(),
    };
    this.#generation = operation.generation;
    this.#active = operation;
    const abortFromCaller = (): void => operation.controller.abort();
    if (signal?.aborted === true) operation.controller.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });

    const round: RoundState = {
      startedAt,
      checkedEntryCount: 0,
      listRequestCount: 0,
      deniedPermitReason: null,
    };

    try {
      while (true) {
        const beforePage = this.#pauseReason(operation, round, true);
        if (beforePage !== null) {
          return this.#finish(
            layer,
            round,
            beforePage,
            operation,
            this.#isCurrent(operation),
          );
        }
        const pageStart = layer.nextStart;
        if (pageStart === null) return this.#finish(layer, round, "complete", operation);

        let sourceEntries: unknown;
        try {
          sourceEntries = (await this.#source.listDirectory({
            path,
            start: pageStart,
            limit: 1000,
            beforeRequest: async () => {
              const beforeRequest = this.#pauseReason(operation, round, true);
              if (beforeRequest !== null) {
                round.deniedPermitReason = beforeRequest;
                throw new CloudDirectoryBrowserPause(beforeRequest);
              }
              round.listRequestCount += 1;
              layer.cumulativeListRequestCount += 1;
            },
          })).entries;
        } catch (error) {
          if (error instanceof CloudDirectoryBrowserPause) {
            return this.#finish(
              layer,
              round,
              error.reason,
              operation,
              this.#isCurrent(operation),
            );
          }
          const afterError = this.#pauseReason(operation, round, false);
          if (afterError === "user-canceled") {
            return this.#finish(layer, round, afterError, operation, false);
          }
          throw error;
        }

        if (round.deniedPermitReason !== null) {
          return this.#finish(
            layer,
            round,
            round.deniedPermitReason,
            operation,
            this.#isCurrent(operation),
          );
        }
        const afterResponse = this.#pauseReason(operation, round, false);
        if (afterResponse !== null) {
          return this.#finish(
            layer,
            round,
            afterResponse,
            operation,
            this.#isCurrent(operation),
          );
        }

        const page = this.#validatePage(sourceEntries, path, layer);
        const beforeCommit = this.#pauseReason(operation, round, false);
        if (beforeCommit !== null) {
          return this.#finish(
            layer,
            round,
            beforeCommit,
            operation,
            this.#isCurrent(operation),
          );
        }

        this.#commitPage(layer, round, pageStart, page);
        this.#notify(path, operation);
        if (!this.#isCurrent(operation)) {
          return this.#finish(layer, round, "user-canceled", operation, false);
        }

        if (layer.complete) return this.#finish(layer, round, "complete", operation);
      }
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.#active === operation) this.#active = null;
    }
  }

  snapshot(path: string): CloudDirectoryLayerSnapshot | null {
    this.#assertAvailable();
    const normalizedPath = normalizeCloudAbsolutePath(path);
    const layer = this.#layers.get(normalizedPath);
    if (layer === undefined) return null;
    return {
      path: layer.path,
      directories: layer.directories.map(cloneDirectory),
      nextStart: layer.nextStart,
      complete: layer.complete,
      cumulativeCheckedEntryCount: layer.cumulativeCheckedEntryCount,
      cumulativeListRequestCount: layer.cumulativeListRequestCount,
      lastStopReason: layer.lastStopReason,
    };
  }

  subscribe(listener: (path: string) => void): () => void {
    this.#assertAvailable();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clear(): void {
    this.#assertAvailable();
    this.#resetSession();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#resetSession();
    this.#listeners.clear();
    this.#disposed = true;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw unavailable();
  }

  #assertStart(start: number): void {
    if (!Number.isSafeInteger(start) || start < 0 || start % 1000 !== 0) {
      throw invalidStart();
    }
  }

  #isCurrent(operation: ActiveOperation): boolean {
    return !this.#disposed
      && this.#active === operation
      && this.#generation === operation.generation
      && !operation.controller.signal.aborted;
  }

  #pauseReason(
    operation: ActiveOperation,
    round: RoundState,
    includeQuantityLimits: boolean,
  ): PauseReason | null {
    if (!this.#isCurrent(operation)) return "user-canceled";
    const at = safeNow(this.#now);
    if (elapsedAt(round.startedAt, at) >= CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxDurationMs) {
      return "time-limit";
    }
    if (
      includeQuantityLimits
      && round.checkedEntryCount >= CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxEntryCount
    ) return "entry-limit";
    if (
      includeQuantityLimits
      && round.listRequestCount >= CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxListRequestCount
    ) return "list-request-limit";
    return null;
  }

  #validatePage(
    sourceEntries: unknown,
    path: string,
    layer: CloudDirectoryLayerState,
  ): ValidatedPage {
    if (!Array.isArray(sourceEntries) || sourceEntries.length > 1000) {
      throw invalidResponse();
    }
    const entries = (sourceEntries as readonly unknown[]).map((entry) => (
      validateBaiduListEntry({ entry, currentPath: path, traversalRoot: path })
    ));
    const directories = layer.directories.map(cloneDirectory);
    const directoryFsIdByPath = new Map(layer.directoryFsIdByPath);
    const directoryPathByFsId = new Map(layer.directoryPathByFsId);
    const pagePaths = new Set<string>();
    const pageFsIds = new Set<string>();

    for (const entry of entries) {
      if (pagePaths.has(entry.path) || pageFsIds.has(entry.fsId)) throw invalidResponse();
      pagePaths.add(entry.path);
      pageFsIds.add(entry.fsId);

      if (
        directoryFsIdByPath.has(entry.path)
        || directoryPathByFsId.has(entry.fsId)
      ) throw invalidResponse();

      if (!entry.isDirectory) continue;
      directoryFsIdByPath.set(entry.path, entry.fsId);
      directoryPathByFsId.set(entry.fsId, entry.path);
      directories.push({
        fsId: entry.fsId,
        path: entry.path,
        filename: entry.filename,
      });
    }

    return {
      entries,
      directories,
      directoryFsIdByPath,
      directoryPathByFsId,
    };
  }

  #commitPage(
    layer: CloudDirectoryLayerState,
    round: RoundState,
    pageStart: number,
    page: ValidatedPage,
  ): void {
    let nextStart: number | null = null;
    if (page.entries.length === 1000) {
      nextStart = pageStart + 1000;
      if (!Number.isSafeInteger(nextStart)) throw invalidResponse();
    }

    layer.directories = page.directories;
    layer.directoryFsIdByPath = page.directoryFsIdByPath;
    layer.directoryPathByFsId = page.directoryPathByFsId;
    layer.cumulativeCheckedEntryCount += page.entries.length;
    round.checkedEntryCount += page.entries.length;
    layer.nextStart = nextStart;
    layer.complete = nextStart === null;
    layer.lastStopReason = null;
  }

  #finish(
    layer: CloudDirectoryLayerState,
    round: RoundState,
    stopReason: CloudDirectoryBrowserStopReason,
    operation: ActiveOperation,
    notify = true,
  ): CloudDirectoryBrowseRound {
    let finalStopReason = stopReason;
    layer.lastStopReason = finalStopReason;
    if (notify) {
      this.#notify(layer.path, operation);
      if (!this.#isCurrent(operation)) {
        finalStopReason = "user-canceled";
        layer.lastStopReason = finalStopReason;
      }
    }
    const at = safeNow(this.#now);
    return {
      path: layer.path,
      status: statusFor(finalStopReason),
      stopReason: finalStopReason,
      nextStart: layer.nextStart,
      checkedEntryCount: round.checkedEntryCount,
      cumulativeCheckedEntryCount: layer.cumulativeCheckedEntryCount,
      directoryCount: layer.directories.length,
      listRequestCount: round.listRequestCount,
      cumulativeListRequestCount: layer.cumulativeListRequestCount,
      elapsedMs: elapsedAt(round.startedAt, at),
    };
  }

  #notify(path: string, operation: ActiveOperation): void {
    for (const listener of [...this.#listeners]) {
      if (!this.#isCurrent(operation)) break;
      try {
        listener(path);
      } catch {
        // Listener failures are isolated from durable browser state and other listeners.
      }
    }
  }

  #resetSession(): void {
    this.#generation += 1;
    const active = this.#active;
    this.#active = null;
    if (active !== null && !active.controller.signal.aborted) active.controller.abort();
    this.#layers.clear();
    this.#rootAccessGranted = false;
  }
}
