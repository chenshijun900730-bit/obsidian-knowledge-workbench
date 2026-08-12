import type { CloudCatalogRecord } from "./catalog-types";
import type {
  ActiveCatalogOverlay,
  CandidateCatalogDescriptor,
  CatalogDifferenceRecordV1,
  CatalogOverlayDescriptor,
  CatalogReconciliationResult,
  CatalogTxtImportSummary,
  LargeCatalogBatchCheckpointV3,
  LargeCatalogRunReceiptV3,
  TxtCandidateRecordV1,
  UnifiedCatalogDescriptor,
  UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";

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
  loadActiveOverlays(): Promise<readonly ActiveCatalogOverlay[]>;
  writeUnifiedSnapshot(input: Readonly<{
    sourceImportSha256: string;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
    completedAt: number;
    signal?: AbortSignal;
  }>): Promise<UnifiedCatalogDescriptor>;
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
