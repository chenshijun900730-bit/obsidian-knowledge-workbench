import { createHash } from "node:crypto";
import { isbnCandidatesFromFilename } from "./catalog-codec";
import { normalizeCloudAbsolutePath } from "./catalog-path";
import type { BaiduCatalogSourcePort } from "./catalog-ports";
import type { CatalogReconciliationService } from "./catalog-reconciliation-service";
import {
  CatalogError,
  type BaiduListEntry,
  type CloudCatalogRecord,
} from "./catalog-types";
import type { HybridCatalogStorePort } from "./hybrid-catalog-ports";
import {
  LARGE_CATALOG_RUN_BUDGET,
  HybridCatalogError,
  type LargeCatalogBatchCheckpointV3,
  type LargeCatalogBatchGroupV3,
  type LargeCatalogErrorCode,
  type LargeCatalogGroupMode,
  type LargeCatalogPauseReason,
  type LargeCatalogStopReason,
} from "./hybrid-catalog-types";
import type { UnifiedCatalogProjectionService } from "./unified-catalog-projection-service";

export interface LargeCatalogVerificationSelection {
  readonly groupKey: string;
  readonly rootRelativePath: string;
  readonly mode: LargeCatalogGroupMode;
}

export interface LargeCatalogVerificationStartInput {
  readonly batchId: string;
  readonly sourceImportSha256: string;
  readonly cloudRoot: string;
  readonly groups: readonly LargeCatalogVerificationSelection[];
  readonly signal?: AbortSignal;
}

export interface LargeCatalogVerificationSegmentInput {
  readonly batchId: string;
  readonly cloudRoot: string;
  readonly signal?: AbortSignal;
}

export interface LargeCatalogVerificationSummary {
  readonly batchId: string;
  readonly status: "scanning" | "complete" | "paused" | "partial";
  readonly stopReason: LargeCatalogStopReason | null;
  readonly runOrdinal: number;
  readonly remainingGroupCount: number;
  readonly pdfCount: number;
  readonly directoryCount: number;
  readonly ignoredFileCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
}

export interface LargeCatalogVerificationDependencies {
  readonly source: BaiduCatalogSourcePort;
  readonly store: HybridCatalogStorePort;
  readonly reconcile: Pick<CatalogReconciliationService, "reconcile">;
  readonly project: Pick<UnifiedCatalogProjectionService, "rebuild">;
  readonly now?: () => number;
}

type ConvertedPage = Readonly<{
  records: readonly CloudCatalogRecord[];
  identities: readonly Readonly<{ fsId: string; path: string }>[];
  childRelativePaths: readonly string[];
  directoryCount: number;
  pdfCount: number;
  ignoredFileCount: number;
}>;

class LargeCatalogPause extends Error {
  constructor(readonly reason: LargeCatalogPauseReason) {
    super(reason);
    this.name = "LargeCatalogPause";
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GROUP_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const fixedCompare = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const safeNow = (now: () => number): number => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HybridCatalogError("hybrid-batch-invalid");
  }
  return value;
};

const joinCloud = (root: string, relativePath: string): string => (
  relativePath === "" ? root : `${root}/${relativePath}`
);

const directParent = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

const assertUniquePageIdentities = (
  identities: readonly Readonly<{ fsId: string; path: string }>[],
  seenFsIds: ReadonlySet<string>,
  seenPaths: ReadonlySet<string>,
): void => {
  for (const identity of identities) {
    if (seenFsIds.has(identity.fsId) || seenPaths.has(identity.path)) {
      throw new CatalogError("invalid-baidu-response");
    }
  }
};

const summaryFrom = (
  checkpoint: LargeCatalogBatchCheckpointV3,
): LargeCatalogVerificationSummary => ({
  batchId: checkpoint.batchId,
  status: checkpoint.status,
  stopReason: checkpoint.stopReason,
  runOrdinal: checkpoint.runOrdinal,
  remainingGroupCount: checkpoint.groups.filter((group) => group.status !== "complete").length,
  pdfCount: checkpoint.pdfCount,
  directoryCount: checkpoint.directoryCount,
  ignoredFileCount: checkpoint.ignoredFileCount,
  listRequestCount: checkpoint.listRequestCount,
  cumulativeListRequestCount: checkpoint.cumulativeListRequestCount,
});

const errorCode = (error: unknown): LargeCatalogErrorCode => {
  if (error instanceof CatalogError) {
    if (
      error.code === "baidu-permission-denied"
      || error.code === "baidu-not-found"
      || error.code === "baidu-rate-limited"
      || error.code === "baidu-token-expired"
      || error.code === "baidu-access-unavailable"
      || error.code === "invalid-baidu-response"
    ) return error.code;
    return "baidu-access-unavailable";
  }
  if (error instanceof HybridCatalogError) {
    if (
      error.code === "hybrid-snapshot-corrupt"
      || error.code === "hybrid-batch-invalid"
      || error.code === "hybrid-batch-unavailable"
    ) return error.code;
  }
  return "hybrid-batch-unavailable";
};

export class LargeCatalogVerificationService {
  readonly #source: BaiduCatalogSourcePort;
  readonly #store: HybridCatalogStorePort;
  readonly #reconcile: Pick<CatalogReconciliationService, "reconcile">;
  readonly #project: Pick<UnifiedCatalogProjectionService, "rebuild">;
  readonly #now: () => number;
  #active = false;

  constructor(dependencies: LargeCatalogVerificationDependencies) {
    this.#source = dependencies.source;
    this.#store = dependencies.store;
    this.#reconcile = dependencies.reconcile;
    this.#project = dependencies.project;
    this.#now = dependencies.now ?? Date.now;
  }

  async prepare(input: Omit<LargeCatalogVerificationStartInput, "signal">): Promise<void> {
    const cloudRoot = this.#normalizedSessionRoot(input.cloudRoot);
    if (!HASH_PATTERN.test(input.sourceImportSha256)) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const candidates = await this.#store.loadActiveCandidates();
    if (candidates === null || candidates.descriptor.sourceSha256 !== input.sourceImportSha256) {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    if (
      input.groups.length < 1
      || input.groups.length > LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const groupKeys = new Set<string>();
    const groups: LargeCatalogBatchGroupV3[] = input.groups.map((selection, index) => {
      if (
        !GROUP_PATTERN.test(selection.groupKey)
        || groupKeys.has(selection.groupKey)
        || selection.rootRelativePath.includes("/")
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      groupKeys.add(selection.groupKey);
      const matching = candidates.records.filter((record) => (
        record.topLevelGroupId === selection.groupKey
      ));
      if (matching.length === 0) throw new HybridCatalogError("hybrid-batch-invalid");
      if (selection.groupKey === "txt-root-items") {
        if (selection.rootRelativePath !== "" || selection.mode !== "direct-files-only") {
          throw new HybridCatalogError("hybrid-batch-invalid");
        }
      } else if (
        selection.rootRelativePath === ""
        || selection.mode !== "recursive"
        || matching.some((record) => (
          record.relativePath.split("/")[0] !== selection.rootRelativePath
        ))
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      return {
        groupKey: selection.groupKey,
        rootRelativePath: selection.rootRelativePath,
        mode: selection.mode,
        status: index === 0 ? "scanning" : "pending",
        pending: [{ relativePath: "", start: 0 }],
        committedPageKeys: [],
        completedDirectoryCount: 0,
      };
    });
    const checkpoint: LargeCatalogBatchCheckpointV3 = {
      schemaVersion: 3,
      batchId: input.batchId,
      sourceImportSha256: input.sourceImportSha256,
      cloudRootSha256: sha256(cloudRoot),
      startedAt: safeNow(this.#now),
      runOrdinal: 1,
      budget: LARGE_CATALOG_RUN_BUDGET,
      selectedGroupCount: groups.length,
      currentGroupIndex: 0,
      groups,
      pdfCount: 0,
      directoryCount: 0,
      ignoredFileCount: 0,
      listRequestCount: 0,
      cumulativeListRequestCount: 0,
      status: "scanning",
      stopReason: null,
      errorCodeCounts: {},
    };
    await this.#store.createBatch(checkpoint);
  }

  async start(input: LargeCatalogVerificationStartInput): Promise<LargeCatalogVerificationSummary> {
    await this.prepare(input);
    return this.runSegment({
      batchId: input.batchId,
      cloudRoot: input.cloudRoot,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async loadPaused(batchId: string): Promise<LargeCatalogVerificationSummary> {
    const loaded = await this.#store.loadBatch(batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    return summaryFrom(loaded.checkpoint);
  }

  async runSegment(
    input: LargeCatalogVerificationSegmentInput,
  ): Promise<LargeCatalogVerificationSummary> {
    if (this.#active) throw new HybridCatalogError("hybrid-batch-unavailable");
    this.#active = true;
    try {
      const cloudRoot = this.#normalizedSessionRoot(input.cloudRoot);
      const loaded = await this.#store.loadBatch(input.batchId);
      if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
      let checkpoint = loaded.checkpoint;
      if (checkpoint.cloudRootSha256 !== sha256(cloudRoot)) {
        throw new HybridCatalogError("hybrid-cloud-root-mismatch");
      }
      if (checkpoint.status === "complete") return summaryFrom(checkpoint);
      if (
        !loaded.identitiesComplete
        && checkpoint.groups.some((group) => group.committedPageKeys.length > 0)
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      if (checkpoint.status === "paused" || checkpoint.status === "partial") {
        checkpoint = {
          ...checkpoint,
          startedAt: safeNow(this.#now),
          runOrdinal: checkpoint.runOrdinal + 1,
          pdfCount: 0,
          directoryCount: 0,
          ignoredFileCount: 0,
          listRequestCount: 0,
          status: "scanning",
          stopReason: null,
          errorCodeCounts: {},
        };
        await this.#store.resumeBatch(checkpoint);
      }
      const seenFsIds = new Set(loaded.identities.map((identity) => identity.fsId));
      const seenPaths = new Set(loaded.identities.map((identity) => identity.path));
      return await this.#execute(checkpoint, cloudRoot, input.signal, seenFsIds, seenPaths);
    } finally {
      this.#active = false;
    }
  }

  async #execute(
    initial: LargeCatalogBatchCheckpointV3,
    cloudRoot: string,
    signal: AbortSignal | undefined,
    seenFsIds: Set<string>,
    seenPaths: Set<string>,
  ): Promise<LargeCatalogVerificationSummary> {
    let checkpoint = initial;
    while (true) {
      const group = checkpoint.groups[checkpoint.currentGroupIndex];
      if (group === undefined || group.status !== "scanning") {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      const current = group.pending[0];
      if (current === undefined) {
        try {
          await this.#publishCompleteGroup(checkpoint, group, cloudRoot);
        } catch (error) {
          return this.#finalizePartial(checkpoint, errorCode(error));
        }
        if (checkpoint.currentGroupIndex === checkpoint.groups.length - 1) {
          const groups = checkpoint.groups.map((value, index) => (
            index === checkpoint.currentGroupIndex ? { ...value, status: "complete" as const } : value
          ));
          const terminal: LargeCatalogBatchCheckpointV3 = {
            ...checkpoint,
            currentGroupIndex: groups.length,
            groups,
            status: "complete",
            stopReason: "complete",
          };
          await this.#store.finalizeBatchRun({ checkpoint: terminal, endedAt: safeNow(this.#now) });
          return summaryFrom(terminal);
        }
        const nextIndex = checkpoint.currentGroupIndex + 1;
        const groups = checkpoint.groups.map((value, index) => {
          if (index === checkpoint.currentGroupIndex) return { ...value, status: "complete" as const };
          if (index === nextIndex) return { ...value, status: "scanning" as const };
          return value;
        });
        checkpoint = { ...checkpoint, currentGroupIndex: nextIndex, groups };
        await this.#store.advanceBatchGroup(checkpoint);
        continue;
      }

      let entries: readonly BaiduListEntry[];
      try {
        const currentPath = this.#absolutePendingPath(cloudRoot, group, current.relativePath);
        entries = (await this.#source.listDirectory({
          path: currentPath,
          start: current.start,
          limit: 1000,
          beforeRequest: async () => {
            const pause = this.#preRequestPause(checkpoint, signal);
            if (pause !== null) throw new LargeCatalogPause(pause);
            const permitted: LargeCatalogBatchCheckpointV3 = {
              ...checkpoint,
              listRequestCount: checkpoint.listRequestCount + 1,
              cumulativeListRequestCount: checkpoint.cumulativeListRequestCount + 1,
            };
            await this.#store.saveBatchPermit(permitted);
            checkpoint = permitted;
          },
        })).entries;
      } catch (error) {
        if (error instanceof LargeCatalogPause) {
          return this.#finalizePaused(checkpoint, error.reason);
        }
        return this.#finalizePartial(checkpoint, errorCode(error));
      }

      const pauseAfterRequest = this.#postRequestPause(checkpoint, signal);
      if (pauseAfterRequest !== null) return this.#finalizePaused(checkpoint, pauseAfterRequest);
      let converted: ConvertedPage;
      try {
        converted = this.#convertPage(
          entries,
          this.#absolutePendingPath(cloudRoot, group, current.relativePath),
          this.#groupRoot(cloudRoot, group),
          group.mode,
        );
        assertUniquePageIdentities(converted.identities, seenFsIds, seenPaths);
      } catch (error) {
        return this.#finalizePartial(checkpoint, errorCode(error));
      }
      if (checkpoint.pdfCount + converted.pdfCount > checkpoint.budget.maxPdfCount) {
        return this.#finalizePaused(checkpoint, "pdf-limit");
      }
      if (checkpoint.directoryCount + converted.directoryCount > checkpoint.budget.maxDirectoryCount) {
        return this.#finalizePaused(checkpoint, "directory-limit");
      }
      const pageKey = sha256(`${group.groupKey}\u0000${current.relativePath}\u0000${current.start}`);
      const next = this.#nextPageCheckpoint(checkpoint, group, current, entries.length, converted, pageKey);
      try {
        await this.#store.commitBatchPage({
          batchId: checkpoint.batchId,
          pageKey,
          records: converted.records,
          identities: converted.identities,
          nextCheckpoint: next,
        });
      } catch (error) {
        return this.#finalizePartial(checkpoint, errorCode(error));
      }
      for (const identity of converted.identities) {
        seenFsIds.add(identity.fsId);
        seenPaths.add(identity.path);
      }
      checkpoint = next;
    }
  }

  #preRequestPause(
    checkpoint: LargeCatalogBatchCheckpointV3,
    signal: AbortSignal | undefined,
  ): LargeCatalogPauseReason | null {
    if (signal?.aborted) return "user-canceled";
    const now = safeNow(this.#now);
    if (now < checkpoint.startedAt) throw new HybridCatalogError("hybrid-batch-invalid");
    if (now - checkpoint.startedAt >= checkpoint.budget.maxDurationMs) return "time-limit";
    if (checkpoint.listRequestCount >= checkpoint.budget.maxListRequestCount) {
      return "list-request-limit";
    }
    if (checkpoint.pdfCount >= checkpoint.budget.maxPdfCount) return "pdf-limit";
    if (checkpoint.directoryCount >= checkpoint.budget.maxDirectoryCount) return "directory-limit";
    return null;
  }

  #postRequestPause(
    checkpoint: LargeCatalogBatchCheckpointV3,
    signal: AbortSignal | undefined,
  ): LargeCatalogPauseReason | null {
    if (signal?.aborted) return "user-canceled";
    const now = safeNow(this.#now);
    if (now < checkpoint.startedAt) throw new HybridCatalogError("hybrid-batch-invalid");
    return now - checkpoint.startedAt >= checkpoint.budget.maxDurationMs ? "time-limit" : null;
  }

  #convertPage(
    entries: readonly BaiduListEntry[],
    currentPath: string,
    groupRoot: string,
    mode: LargeCatalogGroupMode,
  ): ConvertedPage {
    if (entries.length > 1000) throw new CatalogError("invalid-baidu-response");
    const records: CloudCatalogRecord[] = [];
    const childRelativePaths: string[] = [];
    const fsIds = new Set<string>();
    const paths = new Set<string>();
    let directoryCount = 0;
    let pdfCount = 0;
    let ignoredFileCount = 0;
    const validated = entries.map((entry) => {
      let path: string;
      try {
        path = normalizeCloudAbsolutePath(entry.path);
      } catch {
        throw new CatalogError("invalid-baidu-response");
      }
      const filename = path.slice(path.lastIndexOf("/") + 1);
      if (
        path !== entry.path
        || directParent(path) !== currentPath
        || filename !== entry.filename.normalize("NFC")
        || !/^(?:0|[1-9]\d*)$/u.test(entry.fsId)
        || !Number.isSafeInteger(entry.sizeBytes)
        || entry.sizeBytes < 0
        || !Number.isSafeInteger(entry.serverModifiedAt)
        || entry.serverModifiedAt < 0
        || fsIds.has(entry.fsId)
        || paths.has(path)
      ) throw new CatalogError("invalid-baidu-response");
      fsIds.add(entry.fsId);
      paths.add(path);
      return { ...entry, path, filename };
    }).sort((left, right) => fixedCompare(left.path, right.path));
    for (const entry of validated) {
      if (entry.isDirectory) {
        if (entry.sizeBytes !== 0) throw new CatalogError("invalid-baidu-response");
        directoryCount += 1;
        if (mode === "recursive") {
          const prefix = `${groupRoot}/`;
          if (!entry.path.startsWith(prefix)) throw new CatalogError("invalid-baidu-response");
          childRelativePaths.push(entry.path.slice(prefix.length));
        }
      } else if (entry.filename.toLocaleLowerCase("en-US").endsWith(".pdf")) {
        pdfCount += 1;
        records.push({
          schemaVersion: 1,
          source: "baidu-netdisk",
          fsId: entry.fsId,
          kind: "file",
          path: entry.path,
          parentPath: directParent(entry.path),
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
      childRelativePaths: childRelativePaths.sort(fixedCompare),
      directoryCount,
      pdfCount,
      ignoredFileCount,
    };
  }

  #nextPageCheckpoint(
    checkpoint: LargeCatalogBatchCheckpointV3,
    group: LargeCatalogBatchGroupV3,
    current: Readonly<{ relativePath: string; start: number }>,
    sourceEntryCount: number,
    converted: ConvertedPage,
    pageKey: string,
  ): LargeCatalogBatchCheckpointV3 {
    const continues = sourceEntryCount === 1000;
    const tail = group.pending.slice(1);
    const nextHead = continues
      ? [{ relativePath: current.relativePath, start: current.start + 1000 }]
      : [];
    const queued = new Set([...nextHead, ...tail].map((item) => item.relativePath));
    const children = converted.childRelativePaths
      .filter((relativePath) => {
        if (queued.has(relativePath)) return false;
        queued.add(relativePath);
        return true;
      })
      .map((relativePath) => ({ relativePath, start: 0 }));
    const nextGroup: LargeCatalogBatchGroupV3 = {
      ...group,
      pending: [...nextHead, ...tail, ...children],
      committedPageKeys: [...group.committedPageKeys, pageKey],
      completedDirectoryCount: group.completedDirectoryCount + (continues ? 0 : 1),
    };
    return {
      ...checkpoint,
      groups: checkpoint.groups.map((value, index) => (
        index === checkpoint.currentGroupIndex ? nextGroup : value
      )),
      pdfCount: checkpoint.pdfCount + converted.pdfCount,
      directoryCount: checkpoint.directoryCount + converted.directoryCount,
      ignoredFileCount: checkpoint.ignoredFileCount + converted.ignoredFileCount,
    };
  }

  async #publishCompleteGroup(
    checkpoint: LargeCatalogBatchCheckpointV3,
    group: LargeCatalogBatchGroupV3,
    cloudRoot: string,
  ): Promise<void> {
    const activeCandidates = await this.#store.loadActiveCandidates();
    const loaded = await this.#store.loadBatch(checkpoint.batchId);
    if (
      activeCandidates === null
      || loaded === null
      || activeCandidates.descriptor.sourceSha256 !== checkpoint.sourceImportSha256
    ) throw new HybridCatalogError("hybrid-batch-unavailable");
    const groupRoot = this.#groupRoot(cloudRoot, group);
    const cloudRecords = loaded.records.filter((record) => (
      group.mode === "direct-files-only"
        ? record.parentPath === cloudRoot
        : record.path.startsWith(`${groupRoot}/`)
    ));
    const activeOverlays = await this.#store.loadActiveOverlays();
    const priorOverlay = activeOverlays.find((overlay) => (
      overlay.descriptor.topLevelGroupId === group.groupKey
    ));
    const result = this.#reconcile.reconcile({
      sourceImportSha256: checkpoint.sourceImportSha256,
      topLevelGroupId: group.groupKey,
      cloudRoot: groupRoot,
      candidates: activeCandidates.records.filter((record) => (
        record.topLevelGroupId === group.groupKey
      )),
      activeOverlays,
      cloudRecords,
      completedAt: safeNow(this.#now),
      complete: true,
    });
    await this.#store.writeCatalogOverlay(result);
    try {
      await this.#project.rebuild();
    } catch (error) {
      await this.#store.restoreCatalogOverlayActivation({
        topLevelGroupId: group.groupKey,
        descriptor: priorOverlay?.descriptor ?? null,
      });
      throw error;
    }
  }

  async #finalizePaused(
    checkpoint: LargeCatalogBatchCheckpointV3,
    reason: LargeCatalogPauseReason,
  ): Promise<LargeCatalogVerificationSummary> {
    const terminal: LargeCatalogBatchCheckpointV3 = {
      ...checkpoint,
      status: "paused",
      stopReason: reason,
    };
    await this.#store.finalizeBatchRun({ checkpoint: terminal, endedAt: safeNow(this.#now) });
    return summaryFrom(terminal);
  }

  async #finalizePartial(
    checkpoint: LargeCatalogBatchCheckpointV3,
    code: LargeCatalogErrorCode,
  ): Promise<LargeCatalogVerificationSummary> {
    const terminal: LargeCatalogBatchCheckpointV3 = {
      ...checkpoint,
      status: "partial",
      stopReason: code,
      errorCodeCounts: {
        ...checkpoint.errorCodeCounts,
        [code]: (checkpoint.errorCodeCounts[code] ?? 0) + 1,
      },
    };
    await this.#store.finalizeBatchRun({ checkpoint: terminal, endedAt: safeNow(this.#now) });
    return summaryFrom(terminal);
  }

  #normalizedSessionRoot(value: string): string {
    let root: string;
    try {
      root = normalizeCloudAbsolutePath(value);
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (root === "/") throw new HybridCatalogError("hybrid-batch-invalid");
    return root;
  }

  #groupRoot(cloudRoot: string, group: LargeCatalogBatchGroupV3): string {
    return joinCloud(cloudRoot, group.rootRelativePath);
  }

  #absolutePendingPath(
    cloudRoot: string,
    group: LargeCatalogBatchGroupV3,
    pendingRelativePath: string,
  ): string {
    return joinCloud(this.#groupRoot(cloudRoot, group), pendingRelativePath);
  }
}
