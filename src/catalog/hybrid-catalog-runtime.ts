import type { CatalogTxtImportService } from "./catalog-txt-import-service";
import type { CatalogTxtByteSource } from "./catalog-txt-parser";
import type {
  HybridCatalogActivationSnapshot,
  HybridCatalogStorePort,
} from "./hybrid-catalog-ports";
import {
  LARGE_CATALOG_RUN_BUDGET,
  HybridCatalogError,
  type CatalogDifferenceKind,
  type CatalogTxtImportSummary,
  type CatalogVerificationStatus,
  type HybridCatalogErrorCode,
  type LargeCatalogErrorCode,
  type LargeCatalogGroupMode,
  type LargeCatalogStopReason,
  type TxtCandidateRecordV1,
  type UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";
import type {
  LargeCatalogVerificationService,
  LargeCatalogVerificationSummary,
} from "./large-catalog-verification-service";
import { summarizeLargeCatalogVerification } from "./large-catalog-verification-progress";
import type { UnifiedCatalogProjectionService } from "./unified-catalog-projection-service";

export interface CatalogTxtSourcePort {
  open(path: string): Promise<CatalogTxtByteSource>;
}

export interface HybridCatalogGroupViewModel {
  readonly groupKey: string;
  readonly label: string;
  readonly pdfCount: number;
  readonly mode: LargeCatalogGroupMode;
  readonly verificationStatus: CatalogVerificationStatus;
}

export interface HybridCatalogActiveSummary {
  readonly importedAt: number;
  readonly pdfCount: number;
  readonly unverifiedCount: number;
  readonly verifiedCount: number;
  readonly differenceCount: number;
  readonly cloudMissingCount: number;
  readonly groupCount: number;
  readonly verifiedGroupCount: number;
  readonly coveredCandidatePdfCount: number;
  readonly groups: readonly HybridCatalogGroupViewModel[];
}

export interface LargeCatalogBatchSummary {
  readonly batchId: string;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: LargeCatalogStopReason | null;
  readonly resumeAvailable: boolean;
  readonly runOrdinal: number;
  readonly remainingGroupCount: number;
  readonly pdfCount: number;
  readonly directoryCount: number;
  readonly ignoredFileCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
  readonly selectedGroupCount: number;
  readonly completedGroupCount: number;
  readonly currentGroupIndex: number;
  readonly currentGroupKey: string | null;
  readonly committedPdfCount: number;
  readonly committedPageCount: number;
  readonly completedDirectoryCount: number;
  readonly pendingDirectoryCount: number;
}

export type HybridCatalogViewMessageCode =
  | HybridCatalogErrorCode
  | LargeCatalogErrorCode
  | "catalog-unavailable";

export interface HybridCatalogViewModel {
  readonly status:
    | "empty"
    | "previewed"
    | "importing"
    | "ready"
    | "scanning"
    | "paused"
    | "partial"
    | "error"
    | "unavailable";
  readonly candidate?: CatalogTxtImportSummary;
  readonly active?: HybridCatalogActiveSummary;
  readonly batch?: LargeCatalogBatchSummary;
  readonly messageCode?: HybridCatalogViewMessageCode;
}

export interface HybridCatalogVerificationInput {
  readonly cloudRoot: string;
  readonly groupKeys: readonly string[];
}

export interface HybridCatalogRuntime {
  initialize(): Promise<void>;
  snapshot(): HybridCatalogViewModel;
  subscribe(listener: () => void): () => void;
  previewTxt(path: string): Promise<void>;
  importTxt(path: string): Promise<void>;
  startLargeVerification(input: HybridCatalogVerificationInput): Promise<void>;
  resumeLargeVerification(cloudRoot: string): Promise<void>;
  cancelLargeVerification(): void;
  dispose(): void;
}

export interface HybridCatalogRuntimeDependencies {
  readonly source: CatalogTxtSourcePort;
  readonly imports: Pick<CatalogTxtImportService, "preview" | "import">;
  readonly store: Pick<
    HybridCatalogStorePort,
    | "loadActiveCandidates"
    | "loadActiveUnified"
    | "loadActiveOverlays"
    | "loadLatestBatch"
    | "restoreCatalogActivation"
  >;
  readonly project: Pick<UnifiedCatalogProjectionService, "rebuild">;
  readonly verification: Pick<LargeCatalogVerificationService, "start" | "runSegment">;
  readonly createBatchId: () => string;
}

type GroupSelection = Readonly<{
  groupKey: string;
  rootRelativePath: string;
  mode: LargeCatalogGroupMode;
}>;

const GROUP_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;

const cloneCandidateSummary = (value: CatalogTxtImportSummary): CatalogTxtImportSummary => ({
  ...value,
});

const cloneGroup = (value: HybridCatalogGroupViewModel): HybridCatalogGroupViewModel => ({
  ...value,
});

const cloneActive = (value: HybridCatalogActiveSummary): HybridCatalogActiveSummary => ({
  ...value,
  groups: value.groups.map(cloneGroup),
});

const cloneBatch = (value: LargeCatalogBatchSummary): LargeCatalogBatchSummary => ({ ...value });

const safeError = (
  error: unknown,
  fallback: HybridCatalogErrorCode,
): HybridCatalogError => error instanceof HybridCatalogError
  ? new HybridCatalogError(error.code)
  : new HybridCatalogError(fallback);

const RETRYABLE_PARTIAL_REASONS = new Set<LargeCatalogStopReason>([
  "baidu-rate-limited",
  "baidu-token-expired",
  "baidu-access-unavailable",
]);

const resumeAvailableFor = (
  status: "complete" | "paused" | "partial",
  stopReason: LargeCatalogStopReason | null,
): boolean => status === "paused"
  || (status === "partial" && stopReason !== null && RETRYABLE_PARTIAL_REASONS.has(stopReason));

const batchFromVerification = (
  summary: LargeCatalogVerificationSummary,
): LargeCatalogBatchSummary => {
  const status = summary.status === "scanning" ? "paused" : summary.status;
  return {
    batchId: summary.batchId,
    status,
    stopReason: summary.stopReason,
    resumeAvailable: resumeAvailableFor(status, summary.stopReason),
    runOrdinal: summary.runOrdinal,
    remainingGroupCount: summary.remainingGroupCount,
    pdfCount: summary.pdfCount,
    directoryCount: summary.directoryCount,
    ignoredFileCount: summary.ignoredFileCount,
    listRequestCount: summary.listRequestCount,
    cumulativeListRequestCount: summary.cumulativeListRequestCount,
    selectedGroupCount: summary.selectedGroupCount,
    completedGroupCount: summary.completedGroupCount,
    currentGroupIndex: summary.currentGroupIndex,
    currentGroupKey: summary.currentGroupKey,
    committedPdfCount: summary.committedPdfCount,
    committedPageCount: summary.committedPageCount,
    completedDirectoryCount: summary.completedDirectoryCount,
    pendingDirectoryCount: summary.pendingDirectoryCount,
  };
};

const statusForBatch = (
  active: HybridCatalogActiveSummary | undefined,
  batch: LargeCatalogBatchSummary | undefined,
): HybridCatalogViewModel["status"] => {
  if (batch?.status === "paused") return "paused";
  if (batch?.status === "partial") return "partial";
  return active === undefined ? "empty" : "ready";
};

const firstSegment = (record: TxtCandidateRecordV1): string =>
  record.relativePath.split("/")[0] ?? "";

const groupLabel = (record: TxtCandidateRecordV1): string => (
  record.topLevelGroupId === "txt-root-items" ? "Root items" : firstSegment(record)
);

const groupCompare = (
  left: HybridCatalogGroupViewModel,
  right: HybridCatalogGroupViewModel,
): number => {
  if (left.groupKey === "txt-root-items" && right.groupKey !== "txt-root-items") return -1;
  if (right.groupKey === "txt-root-items" && left.groupKey !== "txt-root-items") return 1;
  if (left.label < right.label) return -1;
  if (left.label > right.label) return 1;
  return left.groupKey < right.groupKey ? -1 : left.groupKey > right.groupKey ? 1 : 0;
};

export class HybridCatalogRuntimeService implements HybridCatalogRuntime {
  private viewModel: HybridCatalogViewModel = { status: "empty" };
  private readonly listeners = new Set<() => void>();
  private readonly selections = new Map<string, GroupSelection>();
  private activeSourceSha256: string | null = null;
  private currentBatchId: string | null = null;
  private scanController: AbortController | null = null;
  private importController: AbortController | null = null;
  private busy = false;
  private disposed = false;

  constructor(private readonly dependencies: HybridCatalogRuntimeDependencies) {}

  async initialize(): Promise<void> {
    if (this.disposed) return;
    try {
      const [active, latest] = await Promise.all([
        this.loadActive(),
        this.dependencies.store.loadLatestBatch(),
      ]);
      if (this.disposed) return;
      let batch: LargeCatalogBatchSummary | undefined;
      this.currentBatchId = null;
      if (
        latest !== null
        && this.activeSourceSha256 !== null
        && latest.checkpoint.sourceImportSha256 === this.activeSourceSha256
      ) {
        this.currentBatchId = latest.checkpoint.batchId;
        batch = batchFromVerification(summarizeLargeCatalogVerification(
          latest.checkpoint,
          latest.records.length,
        ));
      }
      this.viewModel = {
        status: statusForBatch(active, batch),
        ...(active === undefined ? {} : { active }),
        ...(batch === undefined ? {} : { batch }),
      };
      this.emit();
    } catch (error) {
      if (this.disposed) return;
      this.setFailure(safeError(error, "hybrid-snapshot-corrupt"));
    }
  }

  snapshot(): HybridCatalogViewModel {
    return {
      ...this.viewModel,
      ...(this.viewModel.candidate === undefined
        ? {}
        : { candidate: cloneCandidateSummary(this.viewModel.candidate) }),
      ...(this.viewModel.active === undefined
        ? {}
        : { active: cloneActive(this.viewModel.active) }),
      ...(this.viewModel.batch === undefined
        ? {}
        : { batch: cloneBatch(this.viewModel.batch) }),
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async previewTxt(path: string): Promise<void> {
    if (this.disposed) return;
    this.assertIdle();
    try {
      const source = await this.dependencies.source.open(path);
      const candidate = await this.dependencies.imports.preview(source);
      if (this.disposed) return;
      this.viewModel = {
        ...this.viewModel,
        status: "previewed",
        candidate: cloneCandidateSummary(candidate),
        messageCode: undefined,
      };
      this.emit();
    } catch (error) {
      this.fail(error, "txt-source-unavailable");
    }
  }

  async importTxt(path: string): Promise<void> {
    if (this.disposed) return;
    this.assertIdle();
    const preview = this.viewModel.candidate;
    if (preview === undefined) throw new HybridCatalogError("txt-source-invalid");
    this.busy = true;
    const controller = new AbortController();
    this.importController = controller;
    const isCurrent = (): boolean => (
      !this.disposed
      && this.importController === controller
      && !controller.signal.aborted
    );
    this.viewModel = { ...this.viewModel, status: "importing", messageCode: undefined };
    this.emit();
    let activationChanged = false;
    let activationRestored = false;
    let priorActivation: HybridCatalogActivationSnapshot | null = null;
    const restorePriorActivation = async (): Promise<void> => {
      if (!activationChanged || activationRestored || priorActivation === null) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.dependencies.store.restoreCatalogActivation(priorActivation);
          activationRestored = true;
          return;
        } catch {
          if (attempt === 1) throw new HybridCatalogError("hybrid-snapshot-corrupt");
        }
      }
    };
    try {
      const [priorCandidates, priorUnified] = await Promise.all([
        this.dependencies.store.loadActiveCandidates(),
        this.dependencies.store.loadActiveUnified(),
      ]);
      priorActivation = {
        candidate: priorCandidates?.descriptor ?? null,
        unified: priorUnified?.descriptor ?? null,
      };
      if (!isCurrent()) return;
      const verificationSource = await this.dependencies.source.open(path);
      if (!isCurrent()) return;
      const verified = await this.dependencies.imports.preview(verificationSource);
      if (!isCurrent()) return;
      if (verified.sourceSha256 !== preview.sourceSha256) {
        throw new HybridCatalogError("txt-source-invalid");
      }
      const importSource = await this.dependencies.source.open(path);
      if (!isCurrent()) return;
      const imported = await this.dependencies.imports.import(importSource, controller.signal);
      activationChanged = true;
      if (!isCurrent()) {
        await restorePriorActivation();
        return;
      }
      if (imported.sourceSha256 !== preview.sourceSha256) {
        throw new HybridCatalogError("hybrid-snapshot-corrupt");
      }
      await this.dependencies.project.rebuild(controller.signal);
      if (!isCurrent()) {
        await restorePriorActivation();
        return;
      }
      const active = await this.loadActive();
      if (!isCurrent()) {
        await restorePriorActivation();
        return;
      }
      activationChanged = false;
      this.currentBatchId = null;
      this.viewModel = {
        status: active === undefined ? "empty" : "ready",
        ...(active === undefined ? {} : { active }),
      };
      this.emit();
    } catch (error) {
      try {
        await restorePriorActivation();
      } catch {
        if (!this.disposed) this.fail(new HybridCatalogError("hybrid-snapshot-corrupt"), "hybrid-snapshot-corrupt");
        return;
      }
      if (!isCurrent()) return;
      this.fail(error, "hybrid-snapshot-corrupt");
    } finally {
      if (this.importController === controller) this.importController = null;
      if (!this.disposed) this.busy = false;
    }
  }

  async startLargeVerification(input: HybridCatalogVerificationInput): Promise<void> {
    if (this.disposed) return;
    this.assertIdle();
    const groups = this.selectedGroups(input.groupKeys);
    const sourceImportSha256 = this.activeSourceSha256;
    if (sourceImportSha256 === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    let batchId: string;
    try {
      batchId = this.dependencies.createBatchId();
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    this.busy = true;
    const controller = new AbortController();
    this.scanController = controller;
    this.viewModel = { ...this.viewModel, status: "scanning", messageCode: undefined };
    this.emit();
    try {
      const result = await this.dependencies.verification.start({
        batchId,
        sourceImportSha256,
        cloudRoot: input.cloudRoot,
        groups,
        signal: controller.signal,
      });
      if (this.disposed) return;
      this.currentBatchId = result.batchId;
      await this.publishVerificationResult(result);
    } catch (error) {
      this.fail(error, "hybrid-batch-unavailable");
    } finally {
      if (this.scanController === controller) this.scanController = null;
      this.busy = false;
    }
  }

  async resumeLargeVerification(cloudRoot: string): Promise<void> {
    if (this.disposed) return;
    this.assertIdle();
    const batchId = this.currentBatchId;
    if (batchId === null || this.viewModel.batch?.resumeAvailable !== true) {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    this.busy = true;
    const controller = new AbortController();
    this.scanController = controller;
    this.viewModel = { ...this.viewModel, status: "scanning", messageCode: undefined };
    this.emit();
    try {
      const result = await this.dependencies.verification.runSegment({
        batchId,
        cloudRoot,
        signal: controller.signal,
      });
      if (this.disposed) return;
      await this.publishVerificationResult(result);
    } catch (error) {
      this.fail(error, "hybrid-batch-unavailable");
    } finally {
      if (this.scanController === controller) this.scanController = null;
      this.busy = false;
    }
  }

  cancelLargeVerification(): void {
    if (this.disposed) return;
    this.scanController?.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.importController?.abort();
    this.importController = null;
    this.scanController?.abort();
    this.scanController = null;
    this.busy = false;
    this.activeSourceSha256 = null;
    this.currentBatchId = null;
    this.selections.clear();
    this.listeners.clear();
    this.viewModel = { status: "unavailable", messageCode: "catalog-unavailable" };
  }

  private async loadActive(): Promise<HybridCatalogActiveSummary | undefined> {
    const [candidates, unified, overlays] = await Promise.all([
      this.dependencies.store.loadActiveCandidates(),
      this.dependencies.store.loadActiveUnified(),
      this.dependencies.store.loadActiveOverlays(),
    ]);
    this.selections.clear();
    if (candidates === null) {
      this.activeSourceSha256 = null;
      if (unified !== null || overlays.length > 0) {
        throw new HybridCatalogError("hybrid-snapshot-corrupt");
      }
      return undefined;
    }
    this.activeSourceSha256 = candidates.descriptor.sourceSha256;
    if (
      unified !== null
      && unified.descriptor.sourceImportSha256 !== candidates.descriptor.sourceSha256
    ) throw new HybridCatalogError("hybrid-snapshot-corrupt");
    const activeOverlays = overlays.filter((overlay) => (
      overlay.descriptor.sourceImportSha256 === candidates.descriptor.sourceSha256
    ));
    const records = unified?.records ?? candidates.records.map((record) => ({
      schemaVersion: 1 as const,
      catalogId: record.candidateId,
      candidateId: record.candidateId,
      fsId: null,
      relativePath: record.relativePath,
      cloudPath: null,
      filename: record.filename,
      title: record.title,
      isbnCandidates: [...record.isbnCandidates],
      sizeBytes: null,
      serverModifiedAt: null,
      topLevelGroupId: record.topLevelGroupId,
      hierarchyTags: [...record.hierarchyTags],
      verificationStatus: "unverified" as const,
      differenceKinds: [] as readonly CatalogDifferenceKind[],
      visibleByDefault: true,
    } satisfies UnifiedCatalogRecordV1));
    const recordsByGroup = new Map<string, UnifiedCatalogRecordV1[]>();
    for (const record of records) {
      const values = recordsByGroup.get(record.topLevelGroupId) ?? [];
      values.push(record);
      recordsByGroup.set(record.topLevelGroupId, values);
    }
    const candidatesByGroup = new Map<string, TxtCandidateRecordV1[]>();
    for (const record of candidates.records) {
      if (!GROUP_PATTERN.test(record.topLevelGroupId)) {
        throw new HybridCatalogError("hybrid-snapshot-corrupt");
      }
      const values = candidatesByGroup.get(record.topLevelGroupId) ?? [];
      values.push(record);
      candidatesByGroup.set(record.topLevelGroupId, values);
    }
    const verifiedGroups = new Set(activeOverlays.map((overlay) => (
      overlay.descriptor.topLevelGroupId
    )));
    const coveredCandidatePdfCount = [...candidatesByGroup.entries()].reduce(
      (total, [groupKey, candidateRecords]) => (
        verifiedGroups.has(groupKey) ? total + candidateRecords.length : total
      ),
      0,
    );
    const groups = [...candidatesByGroup.entries()].map(([groupKey, values]) => {
      const first = values[0];
      if (first === undefined) throw new HybridCatalogError("hybrid-snapshot-corrupt");
      const label = groupLabel(first);
      const rootRelativePath = groupKey === "txt-root-items" ? "" : firstSegment(first);
      if (
        (groupKey === "txt-root-items" && values.some((record) => record.relativePath.includes("/")))
        || (groupKey !== "txt-root-items" && (
          rootRelativePath.length === 0
          || values.some((record) => firstSegment(record) !== rootRelativePath)
        ))
      ) throw new HybridCatalogError("hybrid-snapshot-corrupt");
      const mode: LargeCatalogGroupMode = groupKey === "txt-root-items"
        ? "direct-files-only"
        : "recursive";
      this.selections.set(groupKey, { groupKey, rootRelativePath, mode });
      const projected = recordsByGroup.get(groupKey) ?? [];
      const verificationStatus: CatalogVerificationStatus = !verifiedGroups.has(groupKey)
        ? "unverified"
        : projected.some((record) => record.verificationStatus === "difference")
          ? "difference"
          : "verified";
      return {
        groupKey,
        label,
        pdfCount: values.length,
        mode,
        verificationStatus,
      } satisfies HybridCatalogGroupViewModel;
    }).sort(groupCompare);
    return {
      importedAt: candidates.descriptor.importedAt,
      pdfCount: candidates.descriptor.pdfCount,
      unverifiedCount: records.filter((record) => record.verificationStatus === "unverified").length,
      verifiedCount: records.filter((record) => record.verificationStatus === "verified").length,
      differenceCount: unified?.descriptor.differenceCount ?? 0,
      cloudMissingCount: records.filter((record) => (
        record.differenceKinds.includes("cloud-missing")
      )).length,
      groupCount: groups.length,
      verifiedGroupCount: verifiedGroups.size,
      coveredCandidatePdfCount,
      groups,
    };
  }

  private selectedGroups(groupKeys: readonly string[]): readonly GroupSelection[] {
    if (
      groupKeys.length < 1
      || groupKeys.length > LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups
      || new Set(groupKeys).size !== groupKeys.length
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    return groupKeys.map((groupKey) => {
      const selection = this.selections.get(groupKey);
      if (selection === undefined) throw new HybridCatalogError("hybrid-batch-invalid");
      return { ...selection };
    });
  }

  private async publishVerificationResult(
    result: LargeCatalogVerificationSummary,
  ): Promise<void> {
    const batch = batchFromVerification(result);
    const active = await this.loadActive();
    if (this.disposed) return;
    this.viewModel = {
      status: result.status === "complete"
        ? active === undefined ? "empty" : "ready"
        : result.status === "partial" ? "partial" : "paused",
      ...(active === undefined ? {} : { active: cloneActive(active) }),
      batch,
    };
    this.emit();
  }

  private assertIdle(): void {
    if (this.busy) throw new HybridCatalogError("hybrid-batch-unavailable");
  }

  private fail(error: unknown, fallback: HybridCatalogErrorCode): never {
    const fixed = safeError(error, fallback);
    if (!this.disposed) this.setFailure(fixed);
    throw fixed;
  }

  private setFailure(error: HybridCatalogError): void {
    this.viewModel = {
      ...this.viewModel,
      status: "error",
      messageCode: error.code,
    };
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
