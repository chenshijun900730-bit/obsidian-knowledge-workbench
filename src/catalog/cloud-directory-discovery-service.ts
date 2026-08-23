import { normalizeCatalogScanRoot } from "./catalog-path";
import type { BaiduCatalogSourcePort } from "./catalog-ports";
import { validateBaiduListEntry } from "./cloud-directory-page-validator";
import { rankCloudDirectories, type RankedCloudDirectory } from "./cloud-directory-search";
import { CatalogError } from "./catalog-types";

export const CLOUD_DIRECTORY_DISCOVERY_BUDGET = /* @__PURE__ */ Object.freeze({
  maxDirectoryCount: 500,
  maxListRequestCount: 300,
  maxDurationMs: 1_800_000,
} as const);

export type CloudDirectoryDiscoveryStopReason =
  | "complete"
  | "user-canceled"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

export interface CloudDirectoryDiscoverySummary {
  readonly status: "complete" | "paused" | "canceled";
  readonly stopReason: CloudDirectoryDiscoveryStopReason;
  readonly rootPath: string;
  readonly directoryCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
}

export interface CloudDirectoryDiscoveryRuntime {
  searchCached(query: string): readonly RankedCloudDirectory[];
  snapshotCached(): readonly CachedCloudDirectory[];
  discoverMore(
    rootPath: string,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryDiscoverySummary>;
  clear(): void;
  dispose(): void;
}

export interface CloudDirectoryDiscoveryServiceOptions {
  readonly now?: () => number;
}

interface PendingPage {
  readonly path: string;
  readonly start: number;
}

export interface CachedCloudDirectory {
  readonly fsId: string;
  readonly path: string;
  readonly filename: string;
}

interface DiscoveryState {
  readonly rootPath: string;
  readonly startedAt: number;
  readonly pending: readonly PendingPage[];
  readonly seenFsIds: ReadonlySet<string>;
  readonly seenPaths: ReadonlySet<string>;
  readonly directoryCount: number;
  readonly listRequestCount: number;
}

type PauseReason = Exclude<CloudDirectoryDiscoveryStopReason, "complete">;

class CloudDirectoryDiscoveryPause extends Error {
  constructor(readonly reason: PauseReason) {
    super(reason);
    this.name = "CloudDirectoryDiscoveryPause";
  }
}

const invalidResponse = (): CatalogError => new CatalogError("invalid-baidu-response");

const fixedCompare = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const safeNow = (now: () => number): number => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
};

const elapsedAt = (state: DiscoveryState, at: number): number => {
  if (at < state.startedAt) throw invalidResponse();
  return at - state.startedAt;
};

const statusFor = (
  stopReason: CloudDirectoryDiscoveryStopReason,
): CloudDirectoryDiscoverySummary["status"] => {
  if (stopReason === "complete") return "complete";
  if (stopReason === "user-canceled") return "canceled";
  return "paused";
};

export class CloudDirectoryDiscoveryService implements CloudDirectoryDiscoveryRuntime {
  readonly #source: BaiduCatalogSourcePort;
  readonly #now: () => number;
  readonly #cachedByPath = new Map<string, CachedCloudDirectory>();
  readonly #cachedPathByFsId = new Map<string, string>();
  #disposed = false;

  constructor(
    source: BaiduCatalogSourcePort,
    options: CloudDirectoryDiscoveryServiceOptions = {},
  ) {
    this.#source = source;
    this.#now = options.now ?? Date.now;
  }

  searchCached(query: string): readonly RankedCloudDirectory[] {
    if (this.#disposed) return [];
    return rankCloudDirectories(
      [...this.#cachedByPath.values()].map(({ path, filename }) => ({ path, filename })),
      query,
    );
  }

  snapshotCached(): readonly CachedCloudDirectory[] {
    if (this.#disposed) return [];
    return [...this.#cachedByPath.values()]
      .sort((left, right) => fixedCompare(left.path, right.path))
      .map((directory) => ({ ...directory }));
  }

  async discoverMore(
    rootPath: string,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryDiscoverySummary> {
    this.#assertAvailable();
    const normalizedRoot = normalizeCatalogScanRoot(rootPath);
    let state: DiscoveryState = {
      rootPath: normalizedRoot,
      startedAt: safeNow(this.#now),
      pending: [{ path: normalizedRoot, start: 0 }],
      seenFsIds: new Set(),
      seenPaths: new Set(),
      directoryCount: 0,
      listRequestCount: 0,
    };

    while (state.pending.length > 0) {
      const beforePage = this.#pauseReason(state, signal, true);
      if (beforePage !== null) return this.#summary(state, beforePage);
      const current = state.pending[0];
      if (current === undefined) throw invalidResponse();
      let sourceEntries: unknown;
      try {
        sourceEntries = (await this.#source.listDirectory({
          path: current.path,
          start: current.start,
          limit: 1000,
          beforeRequest: async () => {
            const beforeRequest = this.#pauseReason(state, signal, true);
            if (beforeRequest !== null) throw new CloudDirectoryDiscoveryPause(beforeRequest);
            state = { ...state, listRequestCount: state.listRequestCount + 1 };
          },
        })).entries;
      } catch (error) {
        if (error instanceof CloudDirectoryDiscoveryPause) {
          return this.#summary(state, error.reason);
        }
        throw error;
      }

      this.#assertAvailable();
      const afterResponse = this.#pauseReason(state, signal, false);
      if (afterResponse !== null) return this.#summary(state, afterResponse);
      if (!Array.isArray(sourceEntries) || sourceEntries.length > 1000) throw invalidResponse();
      const entries = sourceEntries as readonly unknown[];

      const seenFsIds = new Set(state.seenFsIds);
      const seenPaths = new Set(state.seenPaths);
      const directories: CachedCloudDirectory[] = [];
      const validated = entries.map((entry) => {
        const value = validateBaiduListEntry({
          entry,
          currentPath: current.path,
          traversalRoot: state.rootPath,
        });
        if (seenFsIds.has(value.fsId) || seenPaths.has(value.path)) throw invalidResponse();
        const cachedAtPath = this.#cachedByPath.get(value.path);
        const cachedPathForFsId = this.#cachedPathByFsId.get(value.fsId);
        if (
          (cachedAtPath !== undefined && cachedAtPath.fsId !== value.fsId)
          || (cachedPathForFsId !== undefined && cachedPathForFsId !== value.path)
        ) throw invalidResponse();
        seenFsIds.add(value.fsId);
        seenPaths.add(value.path);
        return value;
      }).sort((left, right) => fixedCompare(left.path, right.path));
      for (const entry of validated) {
        if (entry.isDirectory) {
          directories.push({
            fsId: entry.fsId,
            path: entry.path,
            filename: entry.filename,
          });
        }
      }
      if (
        state.directoryCount + directories.length
        > CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDirectoryCount
      ) return this.#summary(state, "directory-limit");

      for (const directory of directories) {
        this.#cachedByPath.set(directory.path, directory);
        this.#cachedPathByFsId.set(directory.fsId, directory.path);
      }
      const pageContinues = entries.length === 1000;
      const tail = state.pending.slice(1);
      const nextHead: readonly PendingPage[] = pageContinues
        ? [{ path: current.path, start: current.start + 1000 }]
        : [];
      const queuedPaths = new Set([...nextHead, ...tail].map((page) => page.path));
      const children = directories
        .filter((directory) => {
          if (queuedPaths.has(directory.path)) return false;
          queuedPaths.add(directory.path);
          return true;
        })
        .map((directory): PendingPage => ({ path: directory.path, start: 0 }));
      state = {
        ...state,
        pending: [...nextHead, ...tail, ...children],
        seenFsIds,
        seenPaths,
        directoryCount: state.directoryCount + directories.length,
      };
    }

    return this.#summary(state, "complete");
  }

  clear(): void {
    this.#cachedByPath.clear();
    this.#cachedPathByFsId.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clear();
  }

  #pauseReason(
    state: DiscoveryState,
    signal: AbortSignal | undefined,
    includeQuantityLimits: boolean,
  ): PauseReason | null {
    if (signal?.aborted === true) return "user-canceled";
    const at = safeNow(this.#now);
    if (elapsedAt(state, at) >= CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDurationMs) {
      return "time-limit";
    }
    if (
      includeQuantityLimits
      && state.directoryCount >= CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDirectoryCount
    ) return "directory-limit";
    if (
      includeQuantityLimits
      && state.listRequestCount >= CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxListRequestCount
    ) return "list-request-limit";
    return null;
  }

  #summary(
    state: DiscoveryState,
    stopReason: CloudDirectoryDiscoveryStopReason,
  ): CloudDirectoryDiscoverySummary {
    const at = safeNow(this.#now);
    return {
      status: statusFor(stopReason),
      stopReason,
      rootPath: state.rootPath,
      directoryCount: state.directoryCount,
      listRequestCount: state.listRequestCount,
      elapsedMs: elapsedAt(state, at),
    };
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("catalog-unavailable");
  }
}
