import type { CloudCatalogRecord } from "./catalog-types";
import type {
  ActiveCatalogOverlay,
  CandidateCatalogDescriptor,
  CatalogDifferenceKind,
  CatalogDifferenceRecordV1,
  CatalogOverlayDescriptor,
  CatalogReconciliationResult,
  CatalogVerificationStatus,
  CatalogTxtImportSummary,
  LargeCatalogBatchCheckpointV3,
  LargeCatalogRunReceiptV3,
  TxtCandidateRecordV1,
  UnifiedCatalogDescriptor,
  UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";
import type {
  UnifiedCatalogSearchPage,
  UnifiedCatalogSearchQuery,
} from "./unified-catalog-search-service";

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

export interface LargeCatalogPageIdentity {
  readonly fsId: string;
  readonly path: string;
}

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
  loadActiveCandidateDescriptor(): Promise<CandidateCatalogDescriptor | null>;
  loadActiveCandidateSummary(): Promise<ActiveCandidateCatalogSummary | null>;
  loadActiveCandidateGroups(groupKeys: readonly string[]): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null>;
  loadActiveCandidates(): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null>;
}

export interface LargeCatalogBatchStorePort {
  createBatch(checkpoint: LargeCatalogBatchCheckpointV3): Promise<void>;
  resumeBatch(checkpoint: LargeCatalogBatchCheckpointV3): Promise<void>;
  loadBatch(batchId: string): Promise<Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV3;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    identitiesComplete: boolean;
  }> | null>;
  loadLatestBatch(): Promise<Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV3;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    identitiesComplete: boolean;
  }> | null>;
  saveBatchPermit(checkpoint: LargeCatalogBatchCheckpointV3): Promise<void>;
  advanceBatchGroup(checkpoint: LargeCatalogBatchCheckpointV3): Promise<void>;
  commitBatchPage(input: Readonly<{
    batchId: string;
    pageKey: string;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    nextCheckpoint: LargeCatalogBatchCheckpointV3;
  }>): Promise<void>;
  finalizeBatchRun(input: Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV3;
    endedAt: number;
  }>): Promise<LargeCatalogRunReceiptV3>;
  loadBatchReceipt(batchId: string): Promise<LargeCatalogRunReceiptV3 | null>;
}

export interface UnifiedCatalogStorePort extends CandidateCatalogStorePort {
  loadActiveOverlayDescriptors(): Promise<readonly CatalogOverlayDescriptor[]>;
  loadActiveOverlays(): Promise<readonly ActiveCatalogOverlay[]>;
  loadActiveUnifiedSummary(): Promise<ActiveUnifiedCatalogSummary | null>;
  queryActiveUnified(
    query: UnifiedCatalogSearchQuery,
    signal?: AbortSignal,
  ): Promise<ActiveUnifiedCatalogQueryResult | null>;
  writeUnifiedSnapshot(input: Readonly<{
    sourceImportSha256: string;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
    completedAt: number;
    signal?: AbortSignal;
  }>): Promise<UnifiedCatalogDescriptor>;
  writeUnifiedGroupSnapshot(
    input: CatalogReconciliationResult & Readonly<{ signal?: AbortSignal }>,
  ): Promise<UnifiedCatalogDescriptor>;
  loadActiveUnified(): Promise<Readonly<{
    descriptor: UnifiedCatalogDescriptor;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
  }> | null>;
}

export interface HybridCatalogStorePort
  extends UnifiedCatalogStorePort, LargeCatalogBatchStorePort {
  restoreCatalogActivation(input: HybridCatalogActivationSnapshot): Promise<void>;
  writeCatalogOverlay(input: CatalogReconciliationResult): Promise<CatalogOverlayDescriptor>;
  restoreCatalogOverlayActivation(input: Readonly<{
    topLevelGroupId: string;
    descriptor: CatalogOverlayDescriptor | null;
  }>): Promise<void>;
}
