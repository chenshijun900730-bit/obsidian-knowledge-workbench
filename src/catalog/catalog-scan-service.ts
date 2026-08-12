import { createHash } from "node:crypto";
import { isbnCandidatesFromFilename } from "./catalog-codec";
import { normalizeCloudAbsolutePath } from "./catalog-path";
import type {
  BaiduCatalogSourcePort,
  CatalogSnapshotPort,
} from "./catalog-ports";
import {
  CatalogError,
  type BaiduListEntry,
  type CatalogErrorCode,
  type CatalogScanBudget,
  type CatalogScanCheckpointV2,
  type CatalogScanPauseReason,
  type CatalogScanProgress,
  type CatalogScanResult,
  type CatalogScanStopReason,
  type CatalogSnapshotRecord,
} from "./catalog-types";

export interface CatalogScanInput {
  readonly scanId: string;
  readonly rootPath: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CatalogScanProgress) => void;
}

export interface CatalogScanServiceOptions {
  readonly budget: CatalogScanBudget;
  readonly now?: () => number;
}

type ConvertedEntries = Readonly<{
  records: readonly CatalogSnapshotRecord[];
  identities: readonly Readonly<{ fsId: string; path: string }>[];
  childDirectories: readonly string[];
  directoryCount: number;
  pdfCount: number;
  ignoredFileCount: number;
}>;

type PauseObservation = Readonly<{
  reason: CatalogScanPauseReason | null;
  at: number;
}>;

class CatalogScanPause extends Error {
  constructor(
    readonly reason: CatalogScanPauseReason,
    readonly at: number,
  ) {
    super(reason);
    this.name = "CatalogScanPause";
  }
}

const safeNow = (now: () => number): number => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new CatalogError("snapshot-corrupt");
  return value;
};

const elapsedAt = (checkpoint: CatalogScanCheckpointV2, at: number): number => {
  if (at < checkpoint.startedAt) throw new CatalogError("snapshot-corrupt");
  return at - checkpoint.startedAt;
};

const validateBudget = (budget: CatalogScanBudget): CatalogScanBudget => {
  const values = [
    budget.maxPdfCount,
    budget.maxDirectoryCount,
    budget.maxListRequestCount,
    budget.maxDurationMs,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new CatalogError("snapshot-corrupt");
  }
  return Object.freeze({
    maxPdfCount: budget.maxPdfCount,
    maxDirectoryCount: budget.maxDirectoryCount,
    maxListRequestCount: budget.maxListRequestCount,
    maxDurationMs: budget.maxDurationMs,
  });
};

const fixedCompare = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const directParent = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

const validateSourceEntry = (entry: BaiduListEntry, currentPath: string): BaiduListEntry => {
  let path: string;
  try {
    path = normalizeCloudAbsolutePath(entry.path);
  } catch {
    throw new CatalogError("invalid-baidu-response");
  }
  const filename = entry.filename.normalize("NFC");
  if (
    path !== entry.path
    || directParent(path) !== currentPath
    || path.slice(path.lastIndexOf("/") + 1) !== filename
    || !/^(0|[1-9]\d*)$/u.test(entry.fsId)
    || !Number.isSafeInteger(entry.sizeBytes)
    || entry.sizeBytes < 0
    || !Number.isSafeInteger(entry.serverModifiedAt)
    || entry.serverModifiedAt < 0
  ) {
    throw new CatalogError("invalid-baidu-response");
  }
  return { ...entry, path, filename };
};

const convertEntries = (
  entries: readonly BaiduListEntry[],
  currentPath: string,
): ConvertedEntries => {
  const records: CatalogSnapshotRecord[] = [];
  const childDirectories: string[] = [];
  let directoryCount = 0;
  let pdfCount = 0;
  let ignoredFileCount = 0;
  const validated = entries
    .map((entry) => validateSourceEntry(entry, currentPath))
    .sort((left, right) => fixedCompare(left.path, right.path));
  for (const entry of validated) {
    const parentPath = directParent(entry.path);
    if (entry.isDirectory) {
      directoryCount += 1;
      childDirectories.push(entry.path);
      records.push({
        schemaVersion: 1,
        source: "baidu-netdisk",
        fsId: entry.fsId,
        kind: "directory",
        path: entry.path,
        parentPath,
        filename: entry.filename,
        sizeBytes: 0,
        serverModifiedAt: entry.serverModifiedAt,
      });
    } else if (entry.filename.toLocaleLowerCase("en-US").endsWith(".pdf")) {
      pdfCount += 1;
      records.push({
        schemaVersion: 1,
        source: "baidu-netdisk",
        fsId: entry.fsId,
        kind: "file",
        path: entry.path,
        parentPath,
        filename: entry.filename,
        extension: "pdf",
        title: entry.filename.slice(0, -4),
        isbnCandidates: isbnCandidatesFromFilename(entry.filename),
        sizeBytes: entry.sizeBytes,
        serverModifiedAt: entry.serverModifiedAt,
      });
    } else {
      ignoredFileCount += 1;
    }
  }
  return {
    records,
    identities: validated.map(({ fsId, path }) => ({ fsId, path })),
    childDirectories: childDirectories.sort(fixedCompare),
    directoryCount,
    pdfCount,
    ignoredFileCount,
  };
};

const catalogPageKey = (path: string, start: number): string =>
  createHash("sha256").update(`${path.normalize("NFC")}\u0000${String(start)}`).digest("hex");

const assertUniquePageIdentities = (
  identities: readonly Readonly<{ fsId: string; path: string }>[],
  seenFsIds: ReadonlySet<string>,
  seenPaths: ReadonlySet<string>,
): void => {
  const pageFsIds = new Set<string>();
  const pagePaths = new Set<string>();
  for (const identity of identities) {
    if (
      seenFsIds.has(identity.fsId)
      || seenPaths.has(identity.path)
      || pageFsIds.has(identity.fsId)
      || pagePaths.has(identity.path)
    ) throw new CatalogError("invalid-baidu-response");
    pageFsIds.add(identity.fsId);
    pagePaths.add(identity.path);
  }
};

const advanceCheckpoint = (
  checkpoint: CatalogScanCheckpointV2,
  current: Readonly<{ path: string; start: number }>,
  sourceEntryCount: number,
  converted: ConvertedEntries,
  pageKey: string,
): CatalogScanCheckpointV2 => {
  const pageContinues = sourceEntryCount === 1000;
  const tail = checkpoint.pending.slice(1);
  const nextHead = pageContinues ? [{ path: current.path, start: current.start + 1000 }] : [];
  const queued = new Set([...nextHead, ...tail].map((item) => item.path));
  const children = converted.childDirectories
    .filter((path) => {
      if (queued.has(path)) return false;
      queued.add(path);
      return true;
    })
    .map((path) => ({ path, start: 0 }));
  return {
    ...checkpoint,
    pending: [...nextHead, ...tail, ...children],
    committedPageKeys: [...checkpoint.committedPageKeys, pageKey],
    completedDirectoryCount: checkpoint.completedDirectoryCount + (pageContinues ? 0 : 1),
    directoryCount: checkpoint.directoryCount + converted.directoryCount,
    pdfCount: checkpoint.pdfCount + converted.pdfCount,
    ignoredFileCount: checkpoint.ignoredFileCount + converted.ignoredFileCount,
    status: "scanning",
    pauseReason: null,
  };
};

const progressFrom = (
  checkpoint: CatalogScanCheckpointV2,
  status: CatalogScanProgress["status"],
  at: number,
  stopReason?: CatalogScanStopReason,
): CatalogScanProgress => ({
  status,
  directoryCount: checkpoint.directoryCount,
  completedDirectoryCount: checkpoint.completedDirectoryCount,
  pdfCount: checkpoint.pdfCount,
  ignoredFileCount: checkpoint.ignoredFileCount,
  pendingDirectoryCount: new Set(checkpoint.pending.map((item) => item.path)).size,
  listRequestCount: checkpoint.listRequestCount,
  elapsedMs: elapsedAt(checkpoint, at),
  budget: checkpoint.budget,
  ...(stopReason === undefined ? {} : { stopReason }),
});

const incrementError = (
  checkpoint: CatalogScanCheckpointV2,
  code: CatalogErrorCode,
): Readonly<Partial<Record<CatalogErrorCode, number>>> => ({
  ...checkpoint.errorCodeCounts,
  [code]: (checkpoint.errorCodeCounts[code] ?? 0) + 1,
});

export class CatalogScanService {
  readonly #budget: CatalogScanBudget;
  readonly #now: () => number;

  constructor(
    private readonly source: BaiduCatalogSourcePort,
    private readonly snapshots: CatalogSnapshotPort,
    options: CatalogScanServiceOptions,
  ) {
    this.#budget = validateBudget(options.budget);
    this.#now = options.now ?? Date.now;
  }

  async scan(input: CatalogScanInput): Promise<CatalogScanResult> {
    const rootPath = normalizeCloudAbsolutePath(input.rootPath);
    if (await this.snapshots.loadScan(input.scanId) !== null) {
      throw new CatalogError("snapshot-corrupt");
    }
    const startedAt = safeNow(this.#now);
    let checkpoint: CatalogScanCheckpointV2 = {
      schemaVersion: 2,
      scanId: input.scanId,
      rootPath,
      startedAt,
      budget: this.#budget,
      listRequestCount: 0,
      pending: [{ path: rootPath, start: 0 }],
      committedPageKeys: [],
      completedDirectoryCount: 0,
      directoryCount: 0,
      pdfCount: 0,
      ignoredFileCount: 0,
      errorCodeCounts: {},
      retryCount: 0,
      status: "scanning",
      pauseReason: null,
    };
    await this.snapshots.createScan(checkpoint);
    input.onProgress?.(progressFrom(checkpoint, "scanning", safeNow(this.#now)));
    const seenFsIds = new Set<string>();
    const seenPaths = new Set<string>();

    while (checkpoint.pending.length > 0) {
      const beforePage = this.#observePause(checkpoint, input.signal);
      if (beforePage.reason !== null) {
        return this.#finalizePause(checkpoint, {
          reason: beforePage.reason,
          at: beforePage.at,
        }, input.onProgress);
      }
      const current = checkpoint.pending[0];
      if (current === undefined) throw new CatalogError("snapshot-corrupt");
      let entries: readonly BaiduListEntry[];
      let converted: ConvertedEntries;
      try {
        const page = await this.source.listDirectory({
          path: current.path,
          start: current.start,
          limit: 1000,
          beforeRequest: async () => {
            const observation = this.#observePause(checkpoint, input.signal);
            if (observation.reason !== null) {
              throw new CatalogScanPause(observation.reason, observation.at);
            }
            const permitted: CatalogScanCheckpointV2 = {
              ...checkpoint,
              listRequestCount: checkpoint.listRequestCount + 1,
            };
            await this.snapshots.saveScanState(permitted);
            checkpoint = permitted;
            input.onProgress?.(progressFrom(checkpoint, "scanning", observation.at));
          },
        });
        entries = page.entries;
        const afterResponse = this.#observePause(checkpoint, input.signal, false);
        if (afterResponse.reason !== null) {
          throw new CatalogScanPause(afterResponse.reason, afterResponse.at);
        }
        if (entries.length > 1000) throw new CatalogError("invalid-baidu-response");
        converted = convertEntries(entries, current.path);
        assertUniquePageIdentities(converted.identities, seenFsIds, seenPaths);
        if (checkpoint.pdfCount + converted.pdfCount > checkpoint.budget.maxPdfCount) {
          throw new CatalogScanPause("pdf-limit", afterResponse.at);
        }
        if (
          checkpoint.directoryCount + converted.directoryCount
          > checkpoint.budget.maxDirectoryCount
        ) {
          throw new CatalogScanPause("directory-limit", afterResponse.at);
        }
      } catch (error) {
        if (error instanceof CatalogScanPause) {
          return this.#finalizePause(checkpoint, {
            reason: error.reason,
            at: error.at,
          }, input.onProgress);
        }
        if (
          !(error instanceof CatalogError)
          || error.code === "snapshot-corrupt"
          || error.code === "invalid-scan-root"
        ) {
          throw error;
        }
        return this.#finalizeSourceError(checkpoint, error, input.onProgress);
      }

      const pageKey = catalogPageKey(current.path, current.start);
      const next = advanceCheckpoint(checkpoint, current, entries.length, converted, pageKey);
      await this.snapshots.commitPage({
        scanId: checkpoint.scanId,
        pageKey,
        records: converted.records,
        nextCheckpoint: next,
      });
      for (const identity of converted.identities) {
        seenFsIds.add(identity.fsId);
        seenPaths.add(identity.path);
      }
      checkpoint = next;
      input.onProgress?.(progressFrom(checkpoint, "scanning", safeNow(this.#now)));
    }

    return this.#finalizeComplete(checkpoint, input.onProgress);
  }

  #observePause(
    checkpoint: CatalogScanCheckpointV2,
    signal: AbortSignal | undefined,
    includeCountLimits = true,
  ): PauseObservation {
    const at = safeNow(this.#now);
    const elapsedMs = elapsedAt(checkpoint, at);
    let reason: CatalogScanPauseReason | null = null;
    if (signal?.aborted === true) reason = "user-canceled";
    else if (elapsedMs >= checkpoint.budget.maxDurationMs) reason = "time-limit";
    else if (includeCountLimits && checkpoint.pdfCount >= checkpoint.budget.maxPdfCount) {
      reason = "pdf-limit";
    } else if (
      includeCountLimits
      && checkpoint.directoryCount >= checkpoint.budget.maxDirectoryCount
    ) {
      reason = "directory-limit";
    } else if (
      includeCountLimits
      && checkpoint.listRequestCount >= checkpoint.budget.maxListRequestCount
    ) {
      reason = "list-request-limit";
    }
    return { reason, at };
  }

  async #finalizePause(
    checkpoint: CatalogScanCheckpointV2,
    observation: Readonly<{ reason: CatalogScanPauseReason; at: number }>,
    onProgress: CatalogScanInput["onProgress"],
  ): Promise<CatalogScanResult> {
    const paused: CatalogScanCheckpointV2 = {
      ...checkpoint,
      status: "paused",
      pauseReason: observation.reason,
    };
    return this.#finalize({
      checkpoint: paused,
      status: "paused",
      stopReason: observation.reason,
      endedAt: observation.at,
      onProgress,
    });
  }

  async #finalizeSourceError(
    checkpoint: CatalogScanCheckpointV2,
    error: CatalogError,
    onProgress: CatalogScanInput["onProgress"],
  ): Promise<CatalogScanResult> {
    const rateLimited = error.code === "baidu-rate-limited";
    const failed: CatalogScanCheckpointV2 = {
      ...checkpoint,
      status: rateLimited ? "paused" : "partial",
      pauseReason: null,
      errorCodeCounts: incrementError(checkpoint, error.code),
      retryCount: checkpoint.retryCount + (rateLimited ? 1 : 0),
    };
    return this.#finalize({
      checkpoint: failed,
      status: rateLimited ? "paused" : "partial",
      stopReason: error.code,
      endedAt: safeNow(this.#now),
      errorCode: error.code,
      onProgress,
    });
  }

  async #finalizeComplete(
    checkpoint: CatalogScanCheckpointV2,
    onProgress: CatalogScanInput["onProgress"],
  ): Promise<CatalogScanResult> {
    return this.#finalize({
      checkpoint,
      status: "complete",
      stopReason: "complete",
      endedAt: safeNow(this.#now),
      onProgress,
    });
  }

  async #finalize(input: Readonly<{
    checkpoint: CatalogScanCheckpointV2;
    status: "complete" | "paused" | "partial";
    stopReason: CatalogScanStopReason;
    endedAt: number;
    errorCode?: CatalogErrorCode;
    onProgress: CatalogScanInput["onProgress"];
  }>): Promise<CatalogScanResult> {
    const finalized = await this.snapshots.finalizeScan({
      checkpoint: input.checkpoint,
      status: input.status,
      stopReason: input.stopReason,
      endedAt: input.endedAt,
    });
    const progressStatus = input.status === "complete" ? "complete" : input.status;
    const progress = progressFrom(
      input.checkpoint,
      progressStatus,
      input.endedAt,
      input.stopReason,
    );
    input.onProgress?.(progress);
    return {
      status: input.status,
      stopReason: input.stopReason,
      progress,
      ...(finalized.descriptor === undefined ? {} : { descriptor: finalized.descriptor }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    };
  }
}
