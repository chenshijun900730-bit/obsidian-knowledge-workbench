import type { BaiduCatalogSourcePort } from "./catalog-ports";
import type { CloudDirectoryCandidate } from "./cloud-directory-candidates";
import { validateBaiduListEntry } from "./cloud-directory-page-validator";
import { scoreCloudDirectoryCandidate } from "./cloud-directory-search";
import { CatalogError, type BaiduListEntry } from "./catalog-types";

export const CLOUD_DIRECTORY_LOCATOR_BUDGET = /* @__PURE__ */ Object.freeze({
  maxDirectoryCount: 500,
  maxListRequestCount: 50,
  maxDurationMs: 120_000,
} as const);

export type CloudDirectoryLocatorStopReason =
  | "complete"
  | "user-canceled"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

export interface CloudDirectoryLocatorSummary {
  readonly status: "complete" | "paused" | "canceled";
  readonly stopReason: CloudDirectoryLocatorStopReason;
  readonly query: string;
  readonly directoryCount: number;
  readonly matchCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
  readonly candidates: readonly CloudDirectoryCandidate[];
}

export interface CloudDirectoryLocatorRuntime {
  locateByName(name: string, signal?: AbortSignal): Promise<CloudDirectoryLocatorSummary>;
  cancel(): void;
  dispose(): void;
}

export interface CloudDirectoryLocatorServiceOptions {
  readonly now?: () => number;
}

interface PendingPage {
  readonly path: string;
  readonly start: number;
}

interface PathIdentity {
  readonly kind: "directory" | "file";
  readonly filename: string;
  readonly fsIds: ReadonlySet<string>;
}

interface LocatorState {
  readonly query: string;
  readonly startedAt: number;
  readonly pending: readonly PendingPage[];
  readonly pathByFsId: ReadonlyMap<string, string>;
  readonly identityByPath: ReadonlyMap<string, PathIdentity>;
  readonly candidatesByPath: ReadonlyMap<string, CloudDirectoryCandidate>;
  readonly directoryCount: number;
  readonly listRequestCount: number;
}

type PauseReason = Exclude<CloudDirectoryLocatorStopReason, "complete">;

class CloudDirectoryLocatorPause extends Error {
  constructor(readonly reason: PauseReason) {
    super(reason);
    this.name = "CloudDirectoryLocatorPause";
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

const elapsedAt = (state: LocatorState, at: number): number => {
  if (at < state.startedAt) throw invalidResponse();
  return at - state.startedAt;
};

const statusFor = (
  reason: CloudDirectoryLocatorStopReason,
): CloudDirectoryLocatorSummary["status"] => {
  if (reason === "complete") return "complete";
  if (reason === "user-canceled") return "canceled";
  return "paused";
};

const cloneCandidate = (candidate: CloudDirectoryCandidate): CloudDirectoryCandidate => ({
  ...candidate,
});

const cloneIdentity = (identity: PathIdentity): PathIdentity => ({
  ...identity,
  fsIds: new Set(identity.fsIds),
});

const isMatch = (entry: BaiduListEntry, query: string): boolean => (
  scoreCloudDirectoryCandidate({ filename: entry.filename }, query) !== null
);

export class CloudDirectoryLocatorService implements CloudDirectoryLocatorRuntime {
  readonly #source: BaiduCatalogSourcePort;
  readonly #now: () => number;
  readonly #activeRuns = new Set<AbortController>();
  #disposed = false;

  constructor(
    source: BaiduCatalogSourcePort,
    options: CloudDirectoryLocatorServiceOptions = {},
  ) {
    this.#source = source;
    this.#now = options.now ?? Date.now;
  }

  async locateByName(
    name: string,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryLocatorSummary> {
    this.#assertAvailable();
    const query = name.normalize("NFC").trim();
    if (query.length === 0) throw new Error("cloud-directory-locator-query-required");

    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    this.#activeRuns.add(controller);

    try {
      let state: LocatorState = {
        query,
        startedAt: safeNow(this.#now),
        pending: [{ path: "/", start: 0 }],
        pathByFsId: new Map(),
        identityByPath: new Map(),
        candidatesByPath: new Map(),
        directoryCount: 0,
        listRequestCount: 0,
      };

      while (state.pending.length > 0) {
        const beforePage = this.#pauseReason(state, controller.signal, true);
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
              const beforeRequest = this.#pauseReason(state, controller.signal, true);
              if (beforeRequest !== null) throw new CloudDirectoryLocatorPause(beforeRequest);
              state = { ...state, listRequestCount: state.listRequestCount + 1 };
            },
          })).entries;
        } catch (error) {
          if (error instanceof CloudDirectoryLocatorPause) {
            return this.#summary(state, error.reason);
          }
          if (controller.signal.aborted) return this.#summary(state, "user-canceled");
          throw error;
        }

        const afterResponse = this.#pauseReason(state, controller.signal, false);
        if (afterResponse !== null) return this.#summary(state, afterResponse);
        if (!Array.isArray(sourceEntries) || sourceEntries.length > 1000) throw invalidResponse();

        const validated = sourceEntries
          .map((entry) => validateBaiduListEntry({
            entry,
            currentPath: current.path,
            traversalRoot: "/",
          }))
          .sort((left, right) => (
            fixedCompare(left.path, right.path) || fixedCompare(left.fsId, right.fsId)
          ));
        const directoryEntries = validated.filter((entry) => entry.isDirectory);

        const pathByFsId = new Map(state.pathByFsId);
        const identityByPath = new Map(
          [...state.identityByPath].map(([path, identity]) => [path, cloneIdentity(identity)]),
        );
        const candidatesByPath = new Map(
          [...state.candidatesByPath].map(([path, candidate]) => [path, cloneCandidate(candidate)]),
        );
        const newlyDiscoveredDirectories: BaiduListEntry[] = [];
        const conflictedPaths = new Set<string>();

        for (const entry of validated) {
          if (pathByFsId.has(entry.fsId)) throw invalidResponse();
          const existing = identityByPath.get(entry.path);
          if (existing !== undefined) {
            if (existing.kind !== "directory" || !entry.isDirectory) throw invalidResponse();
            const fsIds = new Set(existing.fsIds);
            fsIds.add(entry.fsId);
            identityByPath.set(entry.path, { ...existing, fsIds });
            conflictedPaths.add(entry.path);
            if (isMatch(entry, query)) {
              candidatesByPath.set(entry.path, {
                kind: "conflict",
                filename: entry.filename,
                path: entry.path,
                source: "cloud-locator",
                reason: "same-path-different-identity",
              });
            } else {
              candidatesByPath.delete(entry.path);
            }
          } else {
            identityByPath.set(entry.path, {
              kind: entry.isDirectory ? "directory" : "file",
              filename: entry.filename,
              fsIds: new Set([entry.fsId]),
            });
            if (entry.isDirectory) {
              newlyDiscoveredDirectories.push(entry);
              if (isMatch(entry, query)) {
                candidatesByPath.set(entry.path, {
                  kind: "exact",
                  path: entry.path,
                  filename: entry.filename,
                  source: "cloud-locator",
                  pathState: "session-verified",
                  cloudFsId: entry.fsId,
                });
              }
            }
          }
          pathByFsId.set(entry.fsId, entry.path);
        }

        if (
          state.directoryCount + directoryEntries.length
          > CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDirectoryCount
        ) return this.#summary(state, "directory-limit");

        const pageContinues = validated.length === 1000;
        const tail = state.pending
          .slice(1)
          .filter((page) => !conflictedPaths.has(page.path));
        const nextHead: readonly PendingPage[] = pageContinues
          ? [{ path: current.path, start: current.start + 1000 }]
          : [];
        const pending = [...nextHead, ...tail];
        const queuedPaths = new Set(pending.map((page) => page.path));
        for (const entry of newlyDiscoveredDirectories) {
          if (conflictedPaths.has(entry.path) || queuedPaths.has(entry.path)) continue;
          queuedPaths.add(entry.path);
          pending.push({ path: entry.path, start: 0 });
        }

        state = {
          ...state,
          pending,
          pathByFsId,
          identityByPath,
          candidatesByPath,
          directoryCount: state.directoryCount + directoryEntries.length,
        };
      }

      const beforeComplete = this.#pauseReason(state, controller.signal, false);
      return this.#summary(state, beforeComplete ?? "complete");
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      this.#activeRuns.delete(controller);
    }
  }

  cancel(): void {
    for (const controller of this.#activeRuns) {
      if (!controller.signal.aborted) controller.abort();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
  }

  #pauseReason(
    state: LocatorState,
    signal: AbortSignal,
    includeQuantityLimits: boolean,
  ): PauseReason | null {
    if (signal.aborted) return "user-canceled";
    const at = safeNow(this.#now);
    if (elapsedAt(state, at) >= CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDurationMs) {
      return "time-limit";
    }
    if (
      includeQuantityLimits
      && state.directoryCount >= CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDirectoryCount
    ) return "directory-limit";
    if (
      includeQuantityLimits
      && state.listRequestCount >= CLOUD_DIRECTORY_LOCATOR_BUDGET.maxListRequestCount
    ) return "list-request-limit";
    return null;
  }

  #summary(
    state: LocatorState,
    reason: CloudDirectoryLocatorStopReason,
  ): CloudDirectoryLocatorSummary {
    const candidates = [...state.candidatesByPath]
      .sort(([left], [right]) => fixedCompare(left, right))
      .map(([, candidate]) => cloneCandidate(candidate));
    return {
      status: statusFor(reason),
      stopReason: reason,
      query: state.query,
      directoryCount: state.directoryCount,
      matchCount: candidates.length,
      listRequestCount: state.listRequestCount,
      elapsedMs: elapsedAt(state, safeNow(this.#now)),
      candidates,
    };
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("catalog-unavailable");
  }
}
