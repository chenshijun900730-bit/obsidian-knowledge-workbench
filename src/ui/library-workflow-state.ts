import type { CloudCatalogConnectionViewModel } from "../catalog/cloud-catalog-runtime";
import {
  cloudVerificationScopesEqual,
  deriveCloudVerificationScope,
  type CloudVerificationScope,
} from "../catalog/cloud-verification-scope";
import type {
  HybridCatalogGroupViewModel,
  HybridCatalogViewModel,
  LargeCatalogBatchSummary,
} from "../catalog/hybrid-catalog-runtime";
import type { WorkbenchMessageKey } from "../i18n/workbench-i18n";
import type { LegacyVerificationAdoptionV1 } from "../storage/legacy-verification-adoption";
import type { BoundCloudLibraryV1 } from "../storage/plugin-data";
import type { VerificationBatchTombstonesV1 } from "../storage/verification-batch-tombstones";

export type LibraryWorkflowKind =
  | "needs-txt"
  | "confirm-txt-import"
  | "needs-connection"
  | "needs-library"
  | "ready"
  | "running"
  | "paused"
  | "repair-connection"
  | "repair-library"
  | "retry-later"
  | "complete"
  | "unavailable";

export type LibraryPrimaryAction =
  | "choose-txt"
  | "import-txt"
  | "open-connection"
  | "choose-library"
  | "start"
  | "pause"
  | "resume"
  | "retry"
  | "open-library";

export interface PendingCatalogTxtDraft {
  readonly path: string;
  readonly sourceSha256: string;
}

export interface LibraryWorkflowState {
  readonly kind: LibraryWorkflowKind;
  readonly primaryAction: LibraryPrimaryAction;
  readonly titleKey: WorkbenchMessageKey;
  readonly descriptionKey: WorkbenchMessageKey;
  readonly recommendedGroup: HybridCatalogGroupViewModel | null;
  readonly canShowTechnicalDetails: boolean;
}

export interface LibraryWorkflowInput {
  readonly connection: CloudCatalogConnectionViewModel | undefined;
  readonly hybrid: HybridCatalogViewModel | undefined;
  readonly boundCloudLibrary: BoundCloudLibraryV1 | null;
  readonly cloudVerificationGeneration: number;
  readonly verificationBatchTombstones: VerificationBatchTombstonesV1;
  readonly legacyVerificationAdoption: LegacyVerificationAdoptionV1;
  readonly pendingCatalogTxt: PendingCatalogTxtDraft | null;
  readonly capabilityAvailable: boolean;
}

type WorkflowPresentation = Readonly<{
  primaryAction: LibraryPrimaryAction;
  titleKey: WorkbenchMessageKey;
  descriptionKey: WorkbenchMessageKey;
  canShowTechnicalDetails: boolean;
}>;

const PRESENTATION: Readonly<Record<LibraryWorkflowKind, WorkflowPresentation>> = {
  "needs-txt": {
    primaryAction: "choose-txt",
    titleKey: "workflow.needsTxt.title",
    descriptionKey: "workflow.needsTxt.description",
    canShowTechnicalDetails: false,
  },
  "confirm-txt-import": {
    primaryAction: "import-txt",
    titleKey: "workflow.confirmTxtImport.title",
    descriptionKey: "workflow.confirmTxtImport.description",
    canShowTechnicalDetails: false,
  },
  "needs-connection": {
    primaryAction: "open-connection",
    titleKey: "workflow.needsConnection.title",
    descriptionKey: "workflow.needsConnection.description",
    canShowTechnicalDetails: false,
  },
  "needs-library": {
    primaryAction: "choose-library",
    titleKey: "workflow.needsLibrary.title",
    descriptionKey: "workflow.needsLibrary.description",
    canShowTechnicalDetails: false,
  },
  ready: {
    primaryAction: "start",
    titleKey: "workflow.ready.title",
    descriptionKey: "workflow.ready.description",
    canShowTechnicalDetails: false,
  },
  running: {
    primaryAction: "pause",
    titleKey: "workflow.running.title",
    descriptionKey: "workflow.running.description",
    canShowTechnicalDetails: true,
  },
  paused: {
    primaryAction: "resume",
    titleKey: "workflow.paused.title",
    descriptionKey: "workflow.paused.description",
    canShowTechnicalDetails: true,
  },
  "repair-connection": {
    primaryAction: "open-connection",
    titleKey: "workflow.repairConnection.title",
    descriptionKey: "workflow.repairConnection.description",
    canShowTechnicalDetails: true,
  },
  "repair-library": {
    primaryAction: "choose-library",
    titleKey: "workflow.repairLibrary.title",
    descriptionKey: "workflow.repairLibrary.description",
    canShowTechnicalDetails: true,
  },
  "retry-later": {
    primaryAction: "retry",
    titleKey: "workflow.retryLater.title",
    descriptionKey: "workflow.retryLater.description",
    canShowTechnicalDetails: true,
  },
  complete: {
    primaryAction: "open-library",
    titleKey: "workflow.complete.title",
    descriptionKey: "workflow.complete.description",
    canShowTechnicalDetails: false,
  },
  unavailable: {
    primaryAction: "open-library",
    titleKey: "workflow.unavailable.title",
    descriptionKey: "workflow.unavailable.description",
    canShowTechnicalDetails: true,
  },
};

const CONNECTION_REPAIR = new Set<string>([
  "baidu-token-expired",
  "baidu-permission-denied",
  "credentials-unavailable",
  "authorization-attempt-unavailable",
]);

const LIBRARY_REPAIR = new Set<string>([
  "baidu-not-found",
  "hybrid-cloud-root-mismatch",
  "invalid-large-catalog-root",
  "invalid-scan-root",
]);

const RETRY_LATER = new Set<string>([
  "baidu-rate-limited",
  "baidu-access-unavailable",
]);

const INTEGRITY_REPAIR = new Set<string>([
  "invalid-baidu-response",
  "hybrid-snapshot-corrupt",
  "hybrid-batch-invalid",
]);

const cloneGroup = (
  value: HybridCatalogGroupViewModel,
): HybridCatalogGroupViewModel => ({ ...value });

export const recommendNextVerificationGroup = (
  groups: readonly HybridCatalogGroupViewModel[],
): HybridCatalogGroupViewModel | null => {
  let selected: HybridCatalogGroupViewModel | null = null;
  for (const candidate of groups) {
    if (
      candidate.groupKey === "txt-root-items"
      || candidate.verificationStatus !== "unverified"
    ) continue;
    if (selected === null || candidate.pdfCount < selected.pdfCount) selected = candidate;
  }
  return selected === null ? null : cloneGroup(selected);
};

const state = (
  kind: LibraryWorkflowKind,
  recommendedGroup: HybridCatalogGroupViewModel | null = null,
  technicalDetailsOverride?: boolean,
): LibraryWorkflowState => ({
  kind,
  ...PRESENTATION[kind],
  recommendedGroup: recommendedGroup === null ? null : cloneGroup(recommendedGroup),
  canShowTechnicalDetails: technicalDetailsOverride
    ?? PRESENTATION[kind].canShowTechnicalDetails,
});

const isConnected = (
  value: CloudCatalogConnectionViewModel | undefined,
): boolean => value !== undefined && [
  "authorized",
  "scanning",
  "paused",
  "partial",
].includes(value.status);

const currentScopeFor = (
  binding: BoundCloudLibraryV1 | null,
  generation: number,
  activeSourceSha256: string,
): CloudVerificationScope | null => {
  if (
    binding === null
    || !Number.isSafeInteger(generation)
    || generation < 1
    || binding.verificationGeneration !== generation
    || binding.sourceImportSha256 !== activeSourceSha256
  ) return null;
  try {
    return deriveCloudVerificationScope(binding);
  } catch {
    return null;
  }
};

const isExactlyAdoptedBatch = (
  adoption: LegacyVerificationAdoptionV1,
  batch: LargeCatalogBatchSummary,
  scope: CloudVerificationScope,
): boolean => adoption.state === "adopted"
  && adoption.verificationGeneration === scope.generation
  && adoption.sourceImportSha256 === scope.sourceImportSha256
  && adoption.cloudRootSha256 === scope.cloudRootSha256
  && adoption.resumableBatch !== null
  && adoption.resumableBatch.batchId === batch.batchId
  && adoption.resumableBatch.sourceImportSha256 === scope.sourceImportSha256
  && adoption.resumableBatch.cloudRootSha256 === scope.cloudRootSha256;

const isEligibleBatch = (
  batch: LargeCatalogBatchSummary,
  scope: CloudVerificationScope,
  adoption: LegacyVerificationAdoptionV1,
): boolean => cloudVerificationScopesEqual(batch.verificationScope, scope)
  && (
    batch.legacyPromotionRequired === false
    || isExactlyAdoptedBatch(adoption, batch, scope)
  );

const isSuperseded = (
  tombstones: VerificationBatchTombstonesV1,
  batch: LargeCatalogBatchSummary,
): boolean => tombstones.state === "valid" && tombstones.batchIds.includes(batch.batchId);

const batchFault = (
  hybrid: HybridCatalogViewModel,
  batch: LargeCatalogBatchSummary | undefined,
): string | undefined => hybrid.messageCode ?? batch?.stopReason ?? undefined;

export const deriveLibraryWorkflowState = (
  input: LibraryWorkflowInput,
): LibraryWorkflowState => {
  const hybrid = input.hybrid;
  if (hybrid?.executionActive === true) return state("running");

  if (
    !input.capabilityAvailable
    || hybrid?.status === "unavailable"
    || hybrid?.messageCode === "catalog-unavailable"
  ) return state("unavailable");

  if (hybrid === undefined || hybrid.active === undefined) {
    const previewMatches = input.pendingCatalogTxt !== null
      && input.pendingCatalogTxt.path.trim().length > 0
      && hybrid?.candidate !== undefined
      && hybrid.candidate.sourceSha256 === input.pendingCatalogTxt.sourceSha256;
    if (previewMatches) return state("confirm-txt-import");
    return state("needs-txt", null, hybrid?.messageCode === "hybrid-snapshot-corrupt");
  }
  const active = hybrid.active;

  const connectionMessage = input.connection?.messageCode;
  if (connectionMessage !== undefined && CONNECTION_REPAIR.has(connectionMessage)) {
    return state("repair-connection");
  }
  if (hybrid.messageCode !== undefined && CONNECTION_REPAIR.has(hybrid.messageCode)) {
    return state("repair-connection");
  }
  if (!isConnected(input.connection)) return state("needs-connection");

  if (
    input.verificationBatchTombstones.state === "invalid"
    || input.legacyVerificationAdoption.state === "invalid"
  ) return state("repair-library");

  const currentScope = currentScopeFor(
    input.boundCloudLibrary,
    input.cloudVerificationGeneration,
    active.sourceImportSha256,
  );
  if (currentScope === null) return state("needs-library");
  if (input.legacyVerificationAdoption.state === "pending") return state("repair-library");

  const batch = hybrid.batch;
  const batchIsCurrent = batch !== undefined
    && !isSuperseded(input.verificationBatchTombstones, batch)
    && isEligibleBatch(batch, currentScope, input.legacyVerificationAdoption);
  const fault = batchFault(hybrid, batch);

  if ((batch === undefined || batchIsCurrent) && fault !== undefined) {
    if (CONNECTION_REPAIR.has(fault)) return state("repair-connection");
    if (LIBRARY_REPAIR.has(fault) || INTEGRITY_REPAIR.has(fault)) {
      return state("repair-library");
    }
  }

  if (
    batchIsCurrent
    && batch.resumeAvailable
    && batch.stopReason !== null
    && RETRY_LATER.has(batch.stopReason)
  ) return state("retry-later");

  if (batchIsCurrent && batch.resumeAvailable) return state("paused");

  const recommendedGroup = recommendNextVerificationGroup(active.groups);
  return recommendedGroup === null
    ? state("complete")
    : state("ready", recommendedGroup);
};
