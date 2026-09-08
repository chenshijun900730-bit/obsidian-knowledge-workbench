import type { CatalogTxtImportService } from "./catalog-txt-import-service";
import type { CatalogTxtByteSource } from "./catalog-txt-parser";
import type {
  HybridCatalogActivationSnapshot,
  HybridCatalogStorePort,
  LoadedLargeCatalogBatch,
} from "./hybrid-catalog-ports";
import {
  cloudVerificationScopesEqual,
  decodeCloudVerificationAuthority,
  type CloudVerificationAuthority,
  type CloudVerificationScope,
} from "./cloud-verification-scope";
import {
  LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  LARGE_CATALOG_RUN_BUDGET,
  HybridCatalogError,
  type CatalogTxtImportSummary,
  type CatalogVerificationStatus,
  type HybridCatalogErrorCode,
  type LargeCatalogErrorCode,
  type LargeCatalogGroupMode,
  type LargeCatalogStopReason,
} from "./hybrid-catalog-types";
import type {
  LargeCatalogVerificationService,
  LargeCatalogVerificationSummary,
  LargeVerificationProgressEvent,
} from "./large-catalog-verification-service";
import {
  hasDurableVerificationProgress,
  summarizeLargeCatalogVerification,
  type LargeVerificationProgressMarker,
} from "./large-catalog-verification-progress";
import type { UnifiedCatalogProjectionService } from "./unified-catalog-projection-service";
import type { LegacyVerificationAdoptionV1 } from "../storage/legacy-verification-adoption";

export interface CatalogTxtSourcePort {
  open(path: string): Promise<CatalogTxtByteSource>;
}

export interface HybridCatalogGroupViewModel {
  readonly groupKey: string;
  readonly rootRelativePath: string;
  readonly label: string;
  readonly pdfCount: number;
  readonly mode: LargeCatalogGroupMode;
  readonly verificationStatus: CatalogVerificationStatus;
}

export interface HybridCatalogActiveSummary {
  readonly sourceImportSha256: string;
  readonly legacyArtifactSetSha256: string | null;
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

export type LargeCatalogAutoResumeState =
  | "inactive"
  | "running"
  | "starting-next-segment"
  | "stopped-no-progress"
  | "stopped-limit";

export interface LargeCatalogBatchSummary {
  readonly batchId: string;
  readonly verificationScope: CloudVerificationScope | null;
  readonly legacyPromotionRequired: boolean;
  readonly status: "scanning" | "complete" | "paused" | "partial";
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
  readonly selectedGroupKeys: readonly string[];
  readonly completedGroupCount: number;
  readonly currentGroupIndex: number;
  readonly currentGroupKey: string | null;
  readonly committedPdfCount: number;
  readonly committedPageCount: number;
  readonly completedDirectoryCount: number;
  readonly pendingDirectoryCount: number;
  readonly autoResumeState: LargeCatalogAutoResumeState;
  readonly autoSegmentIndex: number;
  readonly autoSegmentLimit: number;
}

export type HybridCatalogViewMessageCode =
  | HybridCatalogErrorCode
  | LargeCatalogErrorCode
  | "catalog-unavailable";

export interface HybridCatalogViewModel {
  readonly executionActive: boolean;
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

export type ConsumeTxtPreviewResult = Readonly<{
  kind: "unchanged" | "activated";
  sourceSha256: string;
}>;

export interface HybridCatalogRuntime {
  initialize(): Promise<void>;
  snapshot(): HybridCatalogViewModel;
  subscribe(listener: () => void): () => void;
  previewTxt(path: string): Promise<CatalogTxtImportSummary>;
  consumeTxtPreview(input: Readonly<{
    path: string;
    expectedSourceSha256: string;
  }>): Promise<ConsumeTxtPreviewResult>;
  importTxt(path: string): Promise<void>;
  setVerificationAuthority(authority: CloudVerificationAuthority | null): void;
  prepareLegacyLocalVerificationAuthority(): Promise<Extract<
    CloudVerificationAuthority,
    Readonly<{ kind: "legacy-local-only" }>
  > | null>;
  prepareLegacyVerificationAdoption(
    scope: CloudVerificationScope,
  ): Promise<LegacyVerificationAdoptionV1 | null>;
  revalidatePreparedLegacyAdoption(
    prepared: LegacyVerificationAdoptionV1 | null,
  ): Promise<void>;
  rebuildVerificationProjection(): Promise<void>;
  startLargeVerification(input: HybridCatalogVerificationInput): Promise<void>;
  resumeLargeVerification(input: Readonly<{
    cloudRoot: string;
    groupKeys: readonly string[];
  }>): Promise<void>;
  cancelLargeVerification(): void;
  dispose(): void;
}

export interface HybridCatalogRuntimeDependencies {
  readonly source: CatalogTxtSourcePort;
  readonly imports: Pick<CatalogTxtImportService, "preview" | "import">;
  readonly store: Pick<
    HybridCatalogStorePort,
    | "loadActiveCandidateDescriptor"
    | "loadActiveCandidateSummary"
    | "loadActiveUnifiedSummary"
    | "loadActiveOverlayDescriptors"
    | "loadLatestBatch"
    | "promoteAdoptedLegacyBatch"
    | "loadLegacyLocalAuthority"
    | "prepareLegacyVerificationAdoption"
    | "revalidatePreparedLegacyAdoption"
    | "loadLegacyArtifactSetSha256"
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

type SelectedGroupProgress = Pick<
  LargeCatalogVerificationSummary,
  "selectedGroupCount" | "selectedGroupKeys" | "completedGroupCount" | "remainingGroupCount"
>;

const validatedSelectedGroupKeys = (value: SelectedGroupProgress): readonly string[] => {
  const selectedGroupKeys = [...value.selectedGroupKeys];
  if (
    value.selectedGroupCount !== selectedGroupKeys.length
    || value.completedGroupCount < 0
    || value.completedGroupCount > value.selectedGroupCount
    || value.remainingGroupCount !== value.selectedGroupCount - value.completedGroupCount
  ) throw new HybridCatalogError("hybrid-snapshot-corrupt");
  return selectedGroupKeys;
};

const cloneBatch = (value: LargeCatalogBatchSummary): LargeCatalogBatchSummary => {
  const selectedGroupKeys = validatedSelectedGroupKeys(value);
  return {
    ...value,
    verificationScope: cloneScope(value.verificationScope),
    selectedGroupKeys,
  };
};

type ScopedCloudVerificationAuthority = Extract<
  CloudVerificationAuthority,
  Readonly<{ kind: "scoped" }>
>;

const cloneScope = (value: CloudVerificationScope | null): CloudVerificationScope | null => (
  value === null ? null : { ...value }
);

const cloneAuthority = (
  value: CloudVerificationAuthority | null,
): CloudVerificationAuthority | null => {
  if (value === null) return null;
  const decoded = decodeCloudVerificationAuthority(value);
  if (decoded.kind === "legacy-local-only") return { ...decoded };
  return {
    kind: "scoped",
    scope: { ...decoded.scope },
    legacyAllowlist: decoded.legacyAllowlist === null ? null : {
      candidate: { ...decoded.legacyAllowlist.candidate },
      overlays: decoded.legacyAllowlist.overlays.map((item) => ({ ...item })),
      unified: decoded.legacyAllowlist.unified === null
        ? null
        : { ...decoded.legacyAllowlist.unified },
      resumableBatch: decoded.legacyAllowlist.resumableBatch === null
        ? null
        : { ...decoded.legacyAllowlist.resumableBatch },
    },
  };
};

const authoritiesEqual = (
  left: CloudVerificationAuthority | null,
  right: CloudVerificationAuthority | null,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const revokeActiveVerification = (
  value: HybridCatalogActiveSummary,
): HybridCatalogActiveSummary => ({
  ...value,
  legacyArtifactSetSha256: null,
  unverifiedCount: value.pdfCount,
  verifiedCount: 0,
  differenceCount: 0,
  cloudMissingCount: 0,
  verifiedGroupCount: 0,
  coveredCandidatePdfCount: 0,
  groups: value.groups.map((group) => ({
    ...group,
    verificationStatus: "unverified",
  })),
});

const safeError = (
  error: unknown,
  fallback: HybridCatalogErrorCode,
): HybridCatalogError => error instanceof HybridCatalogError
  ? new HybridCatalogError(error.code)
  : new HybridCatalogError(fallback);

const rejectCanceledTxtOperation = (): never => {
  throw new HybridCatalogError("hybrid-batch-unavailable");
};

const RETRYABLE_PARTIAL_REASONS = new Set<LargeCatalogStopReason>([
  "baidu-rate-limited",
  "baidu-token-expired",
  "baidu-access-unavailable",
]);

const AUTO_CONTINUE_REASONS = new Set<LargeCatalogStopReason>([
  "pdf-limit",
  "directory-limit",
  "list-request-limit",
  "time-limit",
]);

interface AutoChainView {
  readonly autoResumeState: LargeCatalogAutoResumeState;
  readonly autoSegmentIndex: number;
  readonly autoSegmentLimit: number;
}

const resumeAvailableFor = (
  status: "scanning" | "complete" | "paused" | "partial",
  stopReason: LargeCatalogStopReason | null,
): boolean => status === "paused"
  || (status === "partial" && stopReason !== null && RETRYABLE_PARTIAL_REASONS.has(stopReason));

const canAutoContinue = (result: LargeCatalogVerificationSummary): boolean => (
  result.status === "paused"
  && result.stopReason !== null
  && AUTO_CONTINUE_REASONS.has(result.stopReason)
);

const batchFromVerification = (
  summary: LargeCatalogVerificationSummary,
  autoView: AutoChainView = {
    autoResumeState: "inactive",
    autoSegmentIndex: 0,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  },
  resumeAllowed = true,
): LargeCatalogBatchSummary => {
  const status = summary.status;
  const selectedGroupKeys = validatedSelectedGroupKeys(summary);
  return {
    batchId: summary.batchId,
    verificationScope: cloneScope(summary.verificationScope),
    legacyPromotionRequired: summary.legacyPromotionRequired,
    status,
    stopReason: summary.stopReason,
    resumeAvailable: resumeAllowed && resumeAvailableFor(status, summary.stopReason),
    runOrdinal: summary.runOrdinal,
    remainingGroupCount: summary.remainingGroupCount,
    pdfCount: summary.pdfCount,
    directoryCount: summary.directoryCount,
    ignoredFileCount: summary.ignoredFileCount,
    listRequestCount: summary.listRequestCount,
    cumulativeListRequestCount: summary.cumulativeListRequestCount,
    selectedGroupCount: summary.selectedGroupCount,
    selectedGroupKeys,
    completedGroupCount: summary.completedGroupCount,
    currentGroupIndex: summary.currentGroupIndex,
    currentGroupKey: summary.currentGroupKey,
    committedPdfCount: summary.committedPdfCount,
    committedPageCount: summary.committedPageCount,
    completedDirectoryCount: summary.completedDirectoryCount,
    pendingDirectoryCount: summary.pendingDirectoryCount,
    autoResumeState: autoView.autoResumeState,
    autoSegmentIndex: autoView.autoSegmentIndex,
    autoSegmentLimit: autoView.autoSegmentLimit,
  };
};

const statusForBatch = (
  active: HybridCatalogActiveSummary | undefined,
  batch: LargeCatalogBatchSummary | undefined,
): HybridCatalogViewModel["status"] => {
  if (batch?.status === "scanning") return "scanning";
  if (batch?.status === "paused") return "paused";
  if (batch?.status === "partial") return "partial";
  return active === undefined ? "empty" : "ready";
};

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
  private viewModel: HybridCatalogViewModel = { status: "empty", executionActive: false };
  private readonly listeners = new Set<() => void>();
  private readonly selections = new Map<string, GroupSelection>();
  private activeSourceSha256: string | null = null;
  private verificationAuthority: CloudVerificationAuthority | null = null;
  private authorityRevision = 0;
  private currentBatchId: string | null = null;
  private scanController: AbortController | null = null;
  private scanGeneration = 0;
  private importController: AbortController | null = null;
  private busy = false;
  private disposed = false;

  constructor(private readonly dependencies: HybridCatalogRuntimeDependencies) {}

  async initialize(): Promise<void> {
    if (this.disposed) return;
    const authorityRevision = this.authorityRevision;
    const authority = cloneAuthority(this.verificationAuthority);
    try {
      const [active, latest] = await Promise.all([
        this.loadActive(authority, authorityRevision),
        this.dependencies.store.loadLatestBatch(),
      ]);
      if (!this.isAuthorityRevisionCurrent(authorityRevision)) return;
      let batch: LargeCatalogBatchSummary | undefined;
      this.currentBatchId = null;
      if (latest !== null && this.isBatchEligible(latest)) {
        this.currentBatchId = latest.checkpoint.batchId;
        const summary = this.summaryForEligibleBatch(latest);
        batch = batchFromVerification(latest.checkpoint.status === "scanning" ? {
          ...summary,
          status: "paused",
          stopReason: "user-canceled",
        } : summary, undefined, this.canResumeLoadedBatch(latest));
      }
      this.viewModel = {
        status: statusForBatch(active, batch),
        executionActive: false,
        ...(active === undefined ? {} : { active }),
        ...(batch === undefined ? {} : { batch }),
      };
      this.emit();
    } catch (error) {
      if (!this.isAuthorityRevisionCurrent(authorityRevision)) return;
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

  setVerificationAuthority(authority: CloudVerificationAuthority | null): void {
    if (this.disposed) return;
    const detached = cloneAuthority(authority);
    if (authoritiesEqual(this.verificationAuthority, detached)) return;
    this.assertIdle();
    this.authorityRevision += 1;
    this.verificationAuthority = detached;
    this.currentBatchId = null;
    const active = this.viewModel.active === undefined
      ? undefined
      : revokeActiveVerification(this.viewModel.active);
    this.activeSourceSha256 = active?.sourceImportSha256 ?? null;
    if (active === undefined) this.selections.clear();
    const candidate = this.viewModel.candidate;
    this.viewModel = {
      status: active === undefined
        ? candidate === undefined ? "empty" : "previewed"
        : "ready",
      executionActive: false,
      ...(candidate === undefined ? {} : { candidate: cloneCandidateSummary(candidate) }),
      ...(active === undefined ? {} : { active }),
    };
    this.emit();
  }

  async prepareLegacyLocalVerificationAuthority(): Promise<Extract<
    CloudVerificationAuthority,
    Readonly<{ kind: "legacy-local-only" }>
  > | null> {
    if (this.disposed) return null;
    this.assertIdle();
    const authority = await this.dependencies.store.loadLegacyLocalAuthority();
    if (authority === null) return null;
    const decoded = cloneAuthority(authority);
    if (decoded?.kind !== "legacy-local-only") {
      throw new HybridCatalogError("hybrid-snapshot-corrupt");
    }
    return decoded;
  }

  async prepareLegacyVerificationAdoption(
    scope: CloudVerificationScope,
  ): Promise<LegacyVerificationAdoptionV1 | null> {
    if (this.disposed) return null;
    this.assertIdle();
    return this.dependencies.store.prepareLegacyVerificationAdoption({ ...scope });
  }

  async revalidatePreparedLegacyAdoption(
    prepared: LegacyVerificationAdoptionV1 | null,
  ): Promise<void> {
    if (this.disposed) return;
    this.assertIdle();
    await this.dependencies.store.revalidatePreparedLegacyAdoption(prepared);
  }

  async rebuildVerificationProjection(): Promise<void> {
    if (this.disposed) return;
    this.assertIdle();
    const authorityRevision = this.authorityRevision;
    const authority = cloneAuthority(this.verificationAuthority);
    try {
      await this.dependencies.project.rebuild(authority);
      if (!this.isAuthorityRevisionCurrent(authorityRevision)) return;
      const [active, latest] = await Promise.all([
        this.loadActive(authority, authorityRevision),
        this.dependencies.store.loadLatestBatch(),
      ]);
      if (!this.isAuthorityRevisionCurrent(authorityRevision)) return;
      let batch: LargeCatalogBatchSummary | undefined;
      this.currentBatchId = null;
      if (latest !== null && this.isBatchEligible(latest)) {
        this.currentBatchId = latest.checkpoint.batchId;
        const summary = this.summaryForEligibleBatch(latest);
        batch = batchFromVerification(latest.checkpoint.status === "scanning" ? {
          ...summary,
          status: "paused",
          stopReason: "user-canceled",
        } : summary, undefined, this.canResumeLoadedBatch(latest));
      }
      this.viewModel = {
        status: statusForBatch(active, batch),
        executionActive: false,
        ...(active === undefined ? {} : { active }),
        ...(batch === undefined ? {} : { batch }),
      };
      this.emit();
    } catch (error) {
      if (!this.isAuthorityRevisionCurrent(authorityRevision)) return;
      throw error;
    }
  }

  async previewTxt(path: string): Promise<CatalogTxtImportSummary> {
    if (this.disposed) return rejectCanceledTxtOperation();
    this.assertIdle();
    this.busy = true;
    const controller = new AbortController();
    this.importController = controller;
    const isCurrent = (): boolean => (
      !this.disposed
      && this.importController === controller
      && !controller.signal.aborted
    );
    try {
      const source = await this.dependencies.source.open(path);
      if (!isCurrent()) return rejectCanceledTxtOperation();
      const candidate = await this.dependencies.imports.preview(source);
      if (!isCurrent()) return rejectCanceledTxtOperation();
      const detached = cloneCandidateSummary(candidate);
      this.viewModel = {
        ...this.viewModel,
        status: "previewed",
        candidate: cloneCandidateSummary(detached),
        messageCode: undefined,
      };
      this.emit();
      return detached;
    } catch (error) {
      if (!isCurrent()) return rejectCanceledTxtOperation();
      return this.fail(error, "txt-source-unavailable");
    } finally {
      if (this.importController === controller) this.importController = null;
      if (!this.disposed) this.busy = false;
    }
  }

  async importTxt(path: string): Promise<void> {
    if (this.disposed) return;
    const preview = this.viewModel.candidate;
    if (preview === undefined) throw new HybridCatalogError("txt-source-invalid");
    await this.consumeTxtPreview({ path, expectedSourceSha256: preview.sourceSha256 });
  }

  async consumeTxtPreview(input: Readonly<{
    path: string;
    expectedSourceSha256: string;
  }>): Promise<ConsumeTxtPreviewResult> {
    if (this.disposed) return rejectCanceledTxtOperation();
    this.assertIdle();
    const preview = this.viewModel.candidate;
    if (
      preview === undefined
      || preview.sourceSha256 !== input.expectedSourceSha256
    ) throw new HybridCatalogError("txt-source-invalid");
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
    let activationRestoreAttempts = 0;
    let staleCandidate = false;
    let priorActivation: HybridCatalogActivationSnapshot | null = null;
    const priorAuthority = this.verificationAuthority;
    const restorePriorActivation = async (): Promise<void> => {
      if (!activationChanged || activationRestored || priorActivation === null) return;
      while (activationRestoreAttempts < 2) {
        activationRestoreAttempts += 1;
        try {
          await this.dependencies.store.restoreCatalogActivation(priorActivation);
          activationRestored = true;
          return;
        } catch {
          if (activationRestoreAttempts === 2) {
            throw new HybridCatalogError("hybrid-snapshot-corrupt");
          }
        }
      }
      throw new HybridCatalogError("hybrid-snapshot-corrupt");
    };
    try {
      const verificationSource = await this.dependencies.source.open(input.path);
      if (!isCurrent()) return rejectCanceledTxtOperation();
      const verified = await this.dependencies.imports.preview(verificationSource);
      if (!isCurrent()) return rejectCanceledTxtOperation();
      if (verified.sourceSha256 !== input.expectedSourceSha256) {
        staleCandidate = true;
        throw new HybridCatalogError("txt-source-invalid");
      }
      if (verified.sourceSha256 === this.activeSourceSha256) {
        const active = this.viewModel.active;
        const batch = this.viewModel.batch;
        this.viewModel = {
          status: statusForBatch(active, batch),
          executionActive: false,
          ...(active === undefined ? {} : { active }),
          ...(batch === undefined ? {} : { batch }),
        };
        this.emit();
        return { kind: "unchanged", sourceSha256: verified.sourceSha256 };
      }
      const [priorCandidate, priorUnified] = await Promise.all([
        this.dependencies.store.loadActiveCandidateDescriptor(this.verificationAuthority),
        this.dependencies.store.loadActiveUnifiedSummary(this.verificationAuthority),
      ]);
      priorActivation = {
        candidate: priorCandidate,
        unified: priorUnified?.descriptor ?? null,
      };
      if (!isCurrent()) return rejectCanceledTxtOperation();
      const importSource = await this.dependencies.source.open(input.path);
      if (!isCurrent()) return rejectCanceledTxtOperation();
      const imported = await this.dependencies.imports.import(importSource, controller.signal);
      activationChanged = true;
      if (!isCurrent()) {
        await restorePriorActivation();
        return rejectCanceledTxtOperation();
      }
      if (imported.sourceSha256 !== input.expectedSourceSha256) {
        throw new HybridCatalogError("hybrid-snapshot-corrupt");
      }
      this.replaceVerificationAuthorityWithoutPublishing(null);
      const importedAuthorityRevision = this.authorityRevision;
      await this.dependencies.project.rebuild(null, controller.signal);
      if (!isCurrent()) {
        await restorePriorActivation();
        if (!this.disposed) this.replaceVerificationAuthorityWithoutPublishing(priorAuthority);
        return rejectCanceledTxtOperation();
      }
      const active = await this.loadActive(null, importedAuthorityRevision);
      if (!isCurrent()) {
        await restorePriorActivation();
        if (!this.disposed) this.replaceVerificationAuthorityWithoutPublishing(priorAuthority);
        return rejectCanceledTxtOperation();
      }
      activationChanged = false;
      this.currentBatchId = null;
      this.viewModel = {
        status: active === undefined ? "empty" : "ready",
        executionActive: false,
        ...(active === undefined ? {} : { active }),
      };
      this.emit();
      return { kind: "activated", sourceSha256: imported.sourceSha256 };
    } catch (error) {
      try {
        await restorePriorActivation();
        if (activationRestored && !this.disposed) {
          this.replaceVerificationAuthorityWithoutPublishing(priorAuthority);
        }
      } catch {
        return this.failWithoutCandidate(
          new HybridCatalogError("hybrid-snapshot-corrupt"),
          "hybrid-snapshot-corrupt",
        );
      }
      if (!isCurrent()) return rejectCanceledTxtOperation();
      if (staleCandidate) return this.failWithoutCandidate(error, "txt-source-invalid");
      return this.fail(error, "hybrid-snapshot-corrupt");
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
    const authority = this.requireScopedAuthority(sourceImportSha256);
    let batchId: string;
    try {
      batchId = this.dependencies.createBatchId();
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    this.busy = true;
    const controller = new AbortController();
    const generation = ++this.scanGeneration;
    this.scanController = controller;
    this.viewModel = {
      ...this.viewModel,
      status: "scanning",
      executionActive: true,
      messageCode: undefined,
    };
    this.emit();
    try {
      await this.runVerificationChain({
        authority,
        cloudRoot: input.cloudRoot,
        allowedGroupKeys: groups.map((group) => group.groupKey),
        controller,
        generation,
        first: (onProgress) => this.dependencies.verification.start({
          batchId,
          sourceImportSha256,
          authority,
          cloudRoot: input.cloudRoot,
          groups,
          signal: controller.signal,
          onProgress,
        }),
      });
    } catch (error) {
      if (
        !this.disposed
        && this.scanController === controller
        && this.scanGeneration === generation
      ) this.fail(error, "hybrid-batch-unavailable");
    } finally {
      if (this.scanController === controller && this.scanGeneration === generation) {
        this.scanController = null;
        this.busy = false;
        this.viewModel = { ...this.viewModel, executionActive: false };
        this.emit();
      }
    }
  }

  async resumeLargeVerification(input: Readonly<{
    cloudRoot: string;
    groupKeys: readonly string[];
  }>): Promise<void> {
    if (this.disposed) return;
    this.assertIdle();
    const batchId = this.currentBatchId;
    if (batchId === null || this.viewModel.batch?.resumeAvailable !== true) {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    const sourceImportSha256 = this.activeSourceSha256;
    if (sourceImportSha256 === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    const authority = this.requireScopedAuthority(sourceImportSha256);
    const selectedGroupKeys = this.viewModel.batch.selectedGroupKeys;
    if (
      input.groupKeys.length !== selectedGroupKeys.length
      || input.groupKeys.some((groupKey, index) => groupKey !== selectedGroupKeys[index])
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const allowedGroupKeys = this.selectedGroups(selectedGroupKeys).map((group) => group.groupKey);
    this.busy = true;
    try {
      if (this.viewModel.batch.legacyPromotionRequired) {
        const legacyBatch = authority.legacyAllowlist?.resumableBatch;
        if (legacyBatch === null || legacyBatch === undefined || legacyBatch.batchId !== batchId) {
          throw new HybridCatalogError("hybrid-batch-unavailable");
        }
        const promoted = await this.dependencies.store.promoteAdoptedLegacyBatch({
          verificationScope: { ...authority.scope },
          legacyBatch: { ...legacyBatch },
        });
        if (this.disposed) return;
        this.currentBatchId = promoted.checkpoint.batchId;
        this.viewModel = {
          ...this.viewModel,
          batch: batchFromVerification(summarizeLargeCatalogVerification(
            promoted.checkpoint,
            promoted.records.length,
          )),
        };
      }
    } catch (error) {
      this.busy = false;
      this.fail(error, "hybrid-batch-unavailable");
    }
    const controller = new AbortController();
    const generation = ++this.scanGeneration;
    this.scanController = controller;
    this.viewModel = {
      ...this.viewModel,
      status: "scanning",
      executionActive: true,
      messageCode: undefined,
    };
    this.emit();
    try {
      await this.runVerificationChain({
        authority,
        cloudRoot: input.cloudRoot,
        allowedGroupKeys,
        controller,
        generation,
        first: (onProgress) => this.dependencies.verification.runSegment({
          batchId,
          authority,
          cloudRoot: input.cloudRoot,
          allowedGroupKeys,
          signal: controller.signal,
          onProgress,
        }),
      });
    } catch (error) {
      if (
        !this.disposed
        && this.scanController === controller
        && this.scanGeneration === generation
      ) this.fail(error, "hybrid-batch-unavailable");
    } finally {
      if (this.scanController === controller && this.scanGeneration === generation) {
        this.scanController = null;
        this.busy = false;
        this.viewModel = { ...this.viewModel, executionActive: false };
        this.emit();
      }
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
    this.scanGeneration += 1;
    this.authorityRevision += 1;
    this.busy = false;
    this.activeSourceSha256 = null;
    this.verificationAuthority = null;
    this.currentBatchId = null;
    this.selections.clear();
    this.listeners.clear();
    this.viewModel = {
      status: "unavailable",
      executionActive: false,
      messageCode: "catalog-unavailable",
    };
  }

  private async loadActive(
    authority: CloudVerificationAuthority | null = cloneAuthority(this.verificationAuthority),
    authorityRevision = this.authorityRevision,
  ): Promise<HybridCatalogActiveSummary | undefined> {
    const candidates = await this.dependencies.store.loadActiveCandidateSummary(
      authority,
    );
    if (candidates === null) {
      const [unified, overlays] = await Promise.all([
        this.dependencies.store.loadActiveUnifiedSummary(authority),
        this.dependencies.store.loadActiveOverlayDescriptors(authority),
      ]);
      if (unified !== null || overlays.length > 0) {
        throw new HybridCatalogError("hybrid-snapshot-corrupt");
      }
      if (this.isAuthorityRevisionCurrent(authorityRevision)) {
        this.activeSourceSha256 = null;
        this.selections.clear();
      }
      return undefined;
    }
    const [unified, overlays, legacyArtifactSetSha256] = await Promise.all([
      this.dependencies.store.loadActiveUnifiedSummary(authority),
      this.dependencies.store.loadActiveOverlayDescriptors(authority),
      this.dependencies.store.loadLegacyArtifactSetSha256(),
    ]);
    if (
      unified !== null
      && unified.descriptor.sourceImportSha256 !== candidates.descriptor.sourceSha256
    ) throw new HybridCatalogError("hybrid-snapshot-corrupt");
    const unverifiedCount = unified?.aggregate.verificationCounts.unverified
      ?? candidates.descriptor.pdfCount;
    const verifiedCount = unified?.aggregate.verificationCounts.verified ?? 0;
    const cloudMissingCount = unified?.aggregate.verificationCounts.cloudMissing ?? 0;
    const differenceGroups = new Set(unified?.aggregate.differenceGroupKeys ?? []);

    const activeOverlays = overlays.filter((overlay) => (
      overlay.sourceImportSha256 === candidates.descriptor.sourceSha256
    ));
    const verifiedGroups = new Set(activeOverlays.map((overlay) => (
      overlay.topLevelGroupId
    )));
    const coveredCandidatePdfCount = candidates.groups.reduce(
      (total, candidateGroup) => (
        verifiedGroups.has(candidateGroup.groupKey) ? total + candidateGroup.pdfCount : total
      ),
      0,
    );
    const nextSelections = new Map<string, GroupSelection>();
    const groups = candidates.groups.map((candidateGroup) => {
      if (!GROUP_PATTERN.test(candidateGroup.groupKey)) {
        throw new HybridCatalogError("hybrid-snapshot-corrupt");
      }
      nextSelections.set(candidateGroup.groupKey, {
        groupKey: candidateGroup.groupKey,
        rootRelativePath: candidateGroup.rootRelativePath,
        mode: candidateGroup.mode,
      });
      const verificationStatus: CatalogVerificationStatus = !verifiedGroups.has(candidateGroup.groupKey)
        ? "unverified"
        : differenceGroups.has(candidateGroup.groupKey)
          ? "difference"
          : "verified";
      return {
        groupKey: candidateGroup.groupKey,
        rootRelativePath: candidateGroup.rootRelativePath,
        label: candidateGroup.label,
        pdfCount: candidateGroup.pdfCount,
        mode: candidateGroup.mode,
        verificationStatus,
      } satisfies HybridCatalogGroupViewModel;
    }).sort(groupCompare);
    const active = {
      sourceImportSha256: candidates.descriptor.sourceSha256,
      legacyArtifactSetSha256,
      importedAt: candidates.descriptor.importedAt,
      pdfCount: candidates.descriptor.pdfCount,
      unverifiedCount,
      verifiedCount,
      differenceCount: unified?.descriptor.differenceCount ?? 0,
      cloudMissingCount,
      groupCount: groups.length,
      verifiedGroupCount: verifiedGroups.size,
      coveredCandidatePdfCount,
      groups,
    } satisfies HybridCatalogActiveSummary;
    if (this.isAuthorityRevisionCurrent(authorityRevision)) {
      this.activeSourceSha256 = candidates.descriptor.sourceSha256;
      this.selections.clear();
      for (const [groupKey, selection] of nextSelections) {
        this.selections.set(groupKey, selection);
      }
    }
    return active;
  }

  private isAuthorityRevisionCurrent(authorityRevision: number): boolean {
    return !this.disposed && this.authorityRevision === authorityRevision;
  }

  private replaceVerificationAuthorityWithoutPublishing(
    authority: CloudVerificationAuthority | null,
  ): void {
    this.authorityRevision += 1;
    this.verificationAuthority = cloneAuthority(authority);
  }

  private isBatchEligible(batch: LoadedLargeCatalogBatch): boolean {
    if (this.activeSourceSha256 === null) return false;
    return batch.checkpoint.schemaVersion === 4
      ? batch.checkpoint.verificationScope.sourceImportSha256 === this.activeSourceSha256
      : batch.checkpoint.sourceImportSha256 === this.activeSourceSha256;
  }

  private canResumeLoadedBatch(batch: LoadedLargeCatalogBatch): boolean {
    const authority = this.verificationAuthority;
    if (authority?.kind !== "scoped") return false;
    if (batch.kind === "scoped-v4") {
      return cloudVerificationScopesEqual(batch.checkpoint.verificationScope, authority.scope);
    }
    const allowlisted = authority.legacyAllowlist?.resumableBatch;
    return allowlisted !== null
      && allowlisted !== undefined
      && allowlisted.batchId === batch.checkpoint.batchId
      && allowlisted.checkpointSha256 === batch.checkpointSha256
      && allowlisted.sourceImportSha256 === batch.checkpoint.sourceImportSha256
      && allowlisted.cloudRootSha256 === batch.checkpoint.cloudRootSha256
      && allowlisted.sourceImportSha256 === authority.scope.sourceImportSha256
      && allowlisted.cloudRootSha256 === authority.scope.cloudRootSha256;
  }

  private summaryForEligibleBatch(
    batch: LoadedLargeCatalogBatch,
  ): LargeCatalogVerificationSummary {
    const summary = summarizeLargeCatalogVerification(batch.checkpoint, batch.records.length);
    if (
      batch.kind === "legacy-v3"
      && this.canResumeLoadedBatch(batch)
      && this.verificationAuthority?.kind === "scoped"
    ) {
      return {
        ...summary,
        verificationScope: { ...this.verificationAuthority.scope },
        legacyPromotionRequired: true,
      };
    }
    return summary;
  }

  private requireScopedAuthority(
    sourceImportSha256: string,
  ): ScopedCloudVerificationAuthority {
    const authority = this.verificationAuthority;
    if (
      authority?.kind !== "scoped"
      || authority.scope.sourceImportSha256 !== sourceImportSha256
    ) throw new HybridCatalogError("hybrid-batch-unavailable");
    return cloneAuthority(authority) as ScopedCloudVerificationAuthority;
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
    autoView: AutoChainView,
    keepScanning: boolean,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const active = await this.loadActive();
    if (!isCurrent()) return;
    const batch = batchFromVerification(result, autoView);
    this.viewModel = {
      status: keepScanning
        ? "scanning"
        : result.status === "complete"
          ? active === undefined ? "empty" : "ready"
          : result.status === "partial" ? "partial" : "paused",
      executionActive: true,
      ...(active === undefined ? {} : { active: cloneActive(active) }),
      batch,
    };
    this.emit();
  }

  private async runVerificationChain(input: Readonly<{
    authority: ScopedCloudVerificationAuthority;
    cloudRoot: string;
    allowedGroupKeys: readonly string[];
    controller: AbortController;
    generation: number;
    first: (
      onProgress: (event: LargeVerificationProgressEvent) => Promise<void>,
    ) => Promise<LargeCatalogVerificationSummary>;
  }>): Promise<void> {
    let autoSegmentIndex = 1;
    let segmentStartMarker: LargeVerificationProgressMarker | null = null;
    let recoveredFromScanning = false;
    const isCurrent = (): boolean => !this.disposed
      && this.scanController === input.controller
      && !input.controller.signal.aborted
      && this.scanGeneration === input.generation;
    const autoView = (state: LargeCatalogAutoResumeState): AutoChainView => ({
      autoResumeState: state,
      autoSegmentIndex,
      autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
    });
    const onProgress = async (event: LargeVerificationProgressEvent): Promise<void> => {
      if (!isCurrent()) return;
      if (event.phase === "segment-started") {
        segmentStartMarker = event.summary.progressMarker;
        recoveredFromScanning = event.recoveredFromScanning;
      }
      const active = event.phase === "group-completed"
        ? await this.loadActive()
        : this.viewModel.active;
      if (!isCurrent()) return;
      this.currentBatchId = event.summary.batchId;
      this.viewModel = {
        status: "scanning",
        executionActive: true,
        ...(active === undefined ? {} : { active: cloneActive(active) }),
        batch: batchFromVerification(event.summary, autoView("running")),
      };
      this.emit();
    };

    let result = await input.first(onProgress);
    if (isCurrent()) this.currentBatchId = result.batchId;
    while (isCurrent() && canAutoContinue(result)) {
      const progressed = segmentStartMarker !== null
        && hasDurableVerificationProgress(segmentStartMarker, result.progressMarker);
      if (!progressed && !recoveredFromScanning) {
        await this.publishVerificationResult(
          result,
          autoView("stopped-no-progress"),
          false,
          isCurrent,
        );
        return;
      }
      segmentStartMarker = null;
      recoveredFromScanning = false;
      if (autoSegmentIndex >= LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS) {
        await this.publishVerificationResult(
          result,
          autoView("stopped-limit"),
          false,
          isCurrent,
        );
        return;
      }
      await this.publishVerificationResult(
        result,
        autoView("starting-next-segment"),
        true,
        isCurrent,
      );
      if (!isCurrent()) return;
      if (progressed) autoSegmentIndex += 1;
      result = await this.dependencies.verification.runSegment({
        batchId: result.batchId,
        authority: input.authority,
        cloudRoot: input.cloudRoot,
        allowedGroupKeys: input.allowedGroupKeys,
        signal: input.controller.signal,
        onProgress,
      });
      if (isCurrent()) this.currentBatchId = result.batchId;
    }
    if (isCurrent()) {
      await this.publishVerificationResult(result, autoView("inactive"), false, isCurrent);
    }
  }

  private assertIdle(): void {
    if (this.busy) throw new HybridCatalogError("hybrid-batch-unavailable");
  }

  private fail(error: unknown, fallback: HybridCatalogErrorCode): never {
    const fixed = safeError(error, fallback);
    if (!this.disposed) this.setFailure(fixed);
    throw fixed;
  }

  private failWithoutCandidate(error: unknown, fallback: HybridCatalogErrorCode): never {
    const fixed = safeError(error, fallback);
    if (!this.disposed) {
      const active = this.viewModel.active;
      const batch = this.viewModel.batch;
      this.viewModel = {
        status: "error",
        executionActive: false,
        ...(active === undefined ? {} : { active }),
        ...(batch === undefined ? {} : { batch }),
        messageCode: fixed.code,
      };
      this.emit();
    }
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
