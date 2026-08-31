import { normalizeCloudAbsolutePath } from "./catalog-path";
import type { BaiduCatalogSourcePort } from "./catalog-ports";
import { validateBaiduListEntry } from "./cloud-directory-page-validator";
import { CatalogError } from "./catalog-types";

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
  readonly directories: CloudDirectoryIdentity[];
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
}

type PausedBeforeRequestReason = Exclude<CloudDirectoryBrowserStopReason, "complete">;

class CloudDirectoryBrowserPause extends Error {
  constructor(readonly reason: PausedBeforeRequestReason) {
    super(reason);
    this.name = "CloudDirectoryBrowserPause";
  }
}

const invalidResponse = (): CatalogError => new CatalogError("invalid-baidu-response");

const invalidStart = (): RangeError => new RangeError(
  "cloud-directory-browser-start-invalid",
);

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

export class CloudDirectoryBrowserService implements CloudDirectoryBrowserRuntime {
  readonly #source: BaiduCatalogSourcePort;
  readonly #now: () => number;
  readonly #layers = new Map<string, CloudDirectoryLayerState>();
  readonly #listeners = new Set<(path: string) => void>();
  #rootAccessGranted = false;
  #disposed = false;

  constructor(
    source: BaiduCatalogSourcePort,
    options: CloudDirectoryBrowserServiceOptions = {},
  ) {
    this.#source = source;
    this.#now = options.now ?? Date.now;
  }

  rootAccessGranted(): boolean {
    return !this.#disposed && this.#rootAccessGranted;
  }

  grantRootAccess(): void {
    if (this.#disposed) return;
    this.#rootAccessGranted = true;
  }

  async loadLayer(
    input: Readonly<{ path: string; start: number }>,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryBrowseRound> {
    this.#assertAvailable();
    const path = normalizeCloudAbsolutePath(input.path);
    if (path === "/" && !this.#rootAccessGranted) {
      throw new Error("cloud-directory-root-consent-required");
    }
    this.#assertStart(input.start);

    let layer = this.#layers.get(path);
    if (layer === undefined) {
      if (input.start !== 0) throw invalidStart();
      layer = {
        path,
        directories: [],
        nextStart: 0,
        complete: false,
        cumulativeCheckedEntryCount: 0,
        cumulativeListRequestCount: 0,
        lastStopReason: null,
      };
      this.#layers.set(path, layer);
    } else if (layer.nextStart !== input.start) {
      throw invalidStart();
    }

    const round: RoundState = {
      startedAt: safeNow(this.#now),
      checkedEntryCount: 0,
      listRequestCount: 0,
    };

    while (true) {
      const beforePage = this.#stopReason(round, signal);
      if (beforePage !== null) return this.#finish(layer, round, beforePage);
      const pageStart = layer.nextStart;
      if (pageStart === null) return this.#finish(layer, round, "complete");

      let requestPermitGranted = false;
      let sourceEntries: unknown;
      try {
        sourceEntries = (await this.#source.listDirectory({
          path,
          start: pageStart,
          limit: 1000,
          beforeRequest: async () => {
            if (requestPermitGranted) return;
            const beforeRequest = this.#stopReason(round, signal);
            if (beforeRequest !== null) {
              throw new CloudDirectoryBrowserPause(beforeRequest);
            }
            requestPermitGranted = true;
            round.listRequestCount += 1;
          },
        })).entries;
      } catch (error) {
        if (error instanceof CloudDirectoryBrowserPause) {
          return this.#finish(layer, round, error.reason);
        }
        throw error;
      }

      if (!Array.isArray(sourceEntries) || sourceEntries.length > 1000) {
        throw invalidResponse();
      }
      const entries = (sourceEntries as readonly unknown[]).map((entry) => (
        validateBaiduListEntry({ entry, currentPath: path, traversalRoot: path })
      ));
      const directories = entries
        .filter((entry) => entry.isDirectory)
        .map((entry): CloudDirectoryIdentity => ({
          fsId: entry.fsId,
          path: entry.path,
          filename: entry.filename,
        }));

      layer.directories.push(...directories);
      layer.cumulativeCheckedEntryCount += entries.length;
      round.checkedEntryCount += entries.length;
      if (requestPermitGranted) layer.cumulativeListRequestCount += 1;
      if (entries.length < 1000) {
        layer.nextStart = null;
        layer.complete = true;
      } else {
        layer.nextStart = pageStart + 1000;
        layer.complete = false;
      }
      layer.lastStopReason = null;
      this.#notify(path);

      if (layer.complete) return this.#finish(layer, round, "complete");
    }
  }

  snapshot(path: string): CloudDirectoryLayerSnapshot | null {
    if (this.#disposed) return null;
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
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clear(): void {
    this.#layers.clear();
    this.#rootAccessGranted = false;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#listeners.clear();
    this.#disposed = true;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("cloud-directory-browser-unavailable");
  }

  #assertStart(start: number): void {
    if (!Number.isSafeInteger(start) || start < 0 || start % 1000 !== 0) {
      throw invalidStart();
    }
  }

  #stopReason(
    round: RoundState,
    signal: AbortSignal | undefined,
  ): PausedBeforeRequestReason | null {
    if (signal?.aborted === true) return "user-canceled";
    const at = safeNow(this.#now);
    if (elapsedAt(round.startedAt, at) >= CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxDurationMs) {
      return "time-limit";
    }
    if (round.checkedEntryCount >= CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxEntryCount) {
      return "entry-limit";
    }
    if (round.listRequestCount >= CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxListRequestCount) {
      return "list-request-limit";
    }
    return null;
  }

  #finish(
    layer: CloudDirectoryLayerState,
    round: RoundState,
    stopReason: CloudDirectoryBrowserStopReason,
  ): CloudDirectoryBrowseRound {
    layer.lastStopReason = stopReason;
    this.#notify(layer.path);
    const at = safeNow(this.#now);
    return {
      path: layer.path,
      status: statusFor(stopReason),
      stopReason,
      nextStart: layer.nextStart,
      checkedEntryCount: round.checkedEntryCount,
      cumulativeCheckedEntryCount: layer.cumulativeCheckedEntryCount,
      directoryCount: layer.directories.length,
      listRequestCount: round.listRequestCount,
      cumulativeListRequestCount: layer.cumulativeListRequestCount,
      elapsedMs: elapsedAt(round.startedAt, at),
    };
  }

  #notify(path: string): void {
    for (const listener of [...this.#listeners]) listener(path);
  }
}
