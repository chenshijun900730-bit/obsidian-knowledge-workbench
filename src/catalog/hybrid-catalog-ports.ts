import type { CloudCatalogRecord } from "./catalog-types";
import type {
  CloudVerificationAuthority,
  CloudVerificationScope,
  LegacyVerificationAllowlist,
} from "./cloud-verification-scope";
import type {
  ActiveCatalogOverlay,
  CandidateCatalogDescriptor,
  CatalogDifferenceKind,
  CatalogDifferenceRecordV1,
  CatalogOverlayDescriptor,
  CatalogOverlayDescriptorV2,
  CatalogReconciliationResult,
  CatalogVerificationStatus,
  CatalogTxtImportSummary,
  LargeCatalogBatchCheckpointV3,
  LargeCatalogBatchCheckpointV4,
  LargeCatalogPageIdentity,
  LargeCatalogRunReceipt,
  LargeCatalogRunReceiptV4,
  TxtCandidateRecordV1,
  UnifiedCatalogDescriptor,
  UnifiedCatalogDescriptorV2,
  UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";
import type {
  UnifiedCatalogSearchPage,
  UnifiedCatalogSearchQuery,
} from "./unified-catalog-search-service";
import type { LegacyVerificationAdoptionV1 } from "../storage/legacy-verification-adoption";

export interface CandidateCatalogGroupSummary {
  readonly groupKey: string;
  readonly label: string;
  readonly rootRelativePath: string;
  readonly pdfCount: number;
  readonly mode: "recursive" | "direct-files-only";
}

export interface ActiveCandidateCatalogSummary {
  readonly descriptor: CandidateCatalogDescriptor;
  readonly groups: readonly CandidateCatalogGroupSummary[];
}

export interface UnifiedCatalogAggregateSummary {
  readonly verificationCounts: Readonly<Record<CatalogVerificationStatus, number>> & Readonly<{
    cloudMissing: number;
  }>;
  readonly differenceGroupKeys: readonly string[];
  readonly groups: readonly Readonly<{
    groupKey: string;
    label: string;
    count: number;
  }>[];
  readonly hierarchyTags: readonly Readonly<{
    tag: string;
    label: string;
    count: number;
  }>[];
  readonly differenceKindCounts: Readonly<Record<CatalogDifferenceKind, number>>;
}

export interface ActiveUnifiedCatalogSummary {
  readonly descriptor: UnifiedCatalogDescriptor;
  readonly aggregate: UnifiedCatalogAggregateSummary;
}

export interface ActiveUnifiedCatalogQueryResult extends ActiveUnifiedCatalogSummary {
  readonly page: UnifiedCatalogSearchPage;
}

export type { LargeCatalogPageIdentity } from "./hybrid-catalog-types";

export interface HybridCatalogActivationSnapshot {
  readonly candidate: CandidateCatalogDescriptor | null;
  readonly unified: UnifiedCatalogDescriptor | null;
}

export interface CandidateImportWriter {
  append(record: TxtCandidateRecordV1): Promise<void>;
  commit(input: Readonly<{
    summary: CatalogTxtImportSummary;
    importedAt: number;
    signal?: AbortSignal;
  }>): Promise<CandidateCatalogDescriptor>;
  abort(): Promise<void>;
}

export interface CandidateCatalogStorePort {
  createCandidateImport(importId: string): Promise<CandidateImportWriter>;
  loadActiveCandidateDescriptor(
    authority?: CloudVerificationAuthority | null,
  ): Promise<CandidateCatalogDescriptor | null>;
  loadActiveCandidateSummary(
    authority?: CloudVerificationAuthority | null,
  ): Promise<ActiveCandidateCatalogSummary | null>;
  loadActiveCandidateGroups(
    groupKeys: readonly string[],
    authority?: CloudVerificationAuthority | null,
  ): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null>;
  loadActiveCandidates(
    authority?: CloudVerificationAuthority | null,
  ): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null>;
}

export interface LargeCatalogBatchStorePort {
  createBatch(checkpoint: LargeCatalogBatchCheckpointV4): Promise<void>;
  resumeBatch(checkpoint: LargeCatalogBatchCheckpointV4): Promise<void>;
  loadBatch(batchId: string): Promise<LoadedLargeCatalogBatch | null>;
  loadLatestBatch(): Promise<LoadedLargeCatalogBatch | null>;
  promoteAdoptedLegacyBatch(input: Readonly<{
    verificationScope: CloudVerificationScope;
    legacyBatch: NonNullable<LegacyVerificationAllowlist["resumableBatch"]>;
  }>): Promise<LoadedLargeCatalogBatchV4>;
  saveBatchPermit(checkpoint: LargeCatalogBatchCheckpointV4): Promise<void>;
  advanceBatchGroup(checkpoint: LargeCatalogBatchCheckpointV4): Promise<void>;
  commitBatchPage(input: Readonly<{
    batchId: string;
    pageKey: string;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    nextCheckpoint: LargeCatalogBatchCheckpointV4;
  }>): Promise<void>;
  finalizeBatchRun(input: Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV4;
    endedAt: number;
  }>): Promise<LargeCatalogRunReceiptV4>;
  loadBatchReceipt(batchId: string): Promise<LargeCatalogRunReceipt | null>;
}

export interface LegacyVerificationAdoptionStorePort {
  loadLegacyLocalAuthority(): Promise<Extract<
    CloudVerificationAuthority,
    Readonly<{ kind: "legacy-local-only" }>
  > | null>;
  prepareLegacyVerificationAdoption(
    scope: CloudVerificationScope,
  ): Promise<LegacyVerificationAdoptionV1 | null>;
  revalidatePreparedLegacyAdoption(
    prepared: LegacyVerificationAdoptionV1 | null,
  ): Promise<void>;
  loadLegacyArtifactSetSha256(): Promise<string | null>;
}

export interface LoadedLargeCatalogBatchV3 {
  readonly kind: "legacy-v3";
  readonly checkpoint: LargeCatalogBatchCheckpointV3;
  readonly checkpointSha256: string;
  readonly records: readonly CloudCatalogRecord[];
  readonly identities: readonly LargeCatalogPageIdentity[];
  readonly identitiesComplete: boolean;
}

export interface LoadedLargeCatalogBatchV4 {
  readonly kind: "scoped-v4";
  readonly checkpoint: LargeCatalogBatchCheckpointV4;
  readonly checkpointSha256: string;
  readonly records: readonly CloudCatalogRecord[];
  readonly identities: readonly LargeCatalogPageIdentity[];
  readonly identitiesComplete: true;
}

export type LoadedLargeCatalogBatch = LoadedLargeCatalogBatchV3 | LoadedLargeCatalogBatchV4;

export interface UnifiedCatalogStorePort extends CandidateCatalogStorePort {
  loadActiveOverlayDescriptors(
    authority: CloudVerificationAuthority | null,
  ): Promise<readonly CatalogOverlayDescriptor[]>;
  loadActiveOverlays(
    authority: CloudVerificationAuthority | null,
  ): Promise<readonly ActiveCatalogOverlay[]>;
  loadActiveUnifiedSummary(
    authority: CloudVerificationAuthority | null,
  ): Promise<ActiveUnifiedCatalogSummary | null>;
  queryActiveUnified(
    query: UnifiedCatalogSearchQuery,
    authority: CloudVerificationAuthority | null,
    signal?: AbortSignal,
  ): Promise<ActiveUnifiedCatalogQueryResult | null>;
  writeUnifiedSnapshot(input: Readonly<{
    sourceImportSha256: string;
    verificationScope: CloudVerificationScope | null;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
    completedAt: number;
    signal?: AbortSignal;
  }>): Promise<UnifiedCatalogDescriptorV2>;
  writeUnifiedGroupSnapshot(
    input: CatalogReconciliationResult & Readonly<{ signal?: AbortSignal }>,
  ): Promise<UnifiedCatalogDescriptorV2>;
  loadActiveUnified(authority: CloudVerificationAuthority | null): Promise<Readonly<{
    descriptor: UnifiedCatalogDescriptor;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
  }> | null>;
}

export interface HybridCatalogStorePort
  extends UnifiedCatalogStorePort,
    LargeCatalogBatchStorePort,
    LegacyVerificationAdoptionStorePort {
  restoreCatalogActivation(input: HybridCatalogActivationSnapshot): Promise<void>;
  writeCatalogOverlay(input: CatalogReconciliationResult): Promise<CatalogOverlayDescriptorV2>;
  restoreCatalogOverlayActivation(input: Readonly<{
    topLevelGroupId: string;
    descriptor: CatalogOverlayDescriptor | null;
  }>): Promise<void>;
}
