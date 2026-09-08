import { createHash } from "node:crypto";
import type { CloudVerificationScope } from "./cloud-verification-scope";
import {
  HybridCatalogError,
  type LargeCatalogBatchCheckpoint,
  type LargeCatalogStopReason,
} from "./hybrid-catalog-types";

export interface LargeVerificationProgressMarker {
  readonly committedPdfCount: number;
  readonly committedPageCount: number;
  readonly completedDirectoryCount: number;
  readonly completedGroupCount: number;
  readonly currentGroupIndex: number;
  readonly pendingStateSha256: string;
}

export interface LargeCatalogVerificationSummary {
  readonly batchId: string;
  readonly verificationScope: CloudVerificationScope | null;
  readonly legacyPromotionRequired: boolean;
  readonly status: "scanning" | "complete" | "paused" | "partial";
  readonly stopReason: LargeCatalogStopReason | null;
  readonly runOrdinal: number;
  readonly selectedGroupCount: number;
  readonly selectedGroupKeys: readonly string[];
  readonly completedGroupCount: number;
  readonly remainingGroupCount: number;
  readonly currentGroupIndex: number;
  readonly currentGroupKey: string | null;
  readonly pdfCount: number;
  readonly directoryCount: number;
  readonly ignoredFileCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
  readonly committedPdfCount: number;
  readonly committedPageCount: number;
  readonly completedDirectoryCount: number;
  readonly pendingDirectoryCount: number;
  readonly progressMarker: LargeVerificationProgressMarker;
}

export type LargeVerificationProgressPhase =
  | "segment-started"
  | "request-permitted"
  | "page-committed"
  | "group-completed"
  | "segment-finalized";

export interface LargeVerificationProgressEvent {
  readonly phase: LargeVerificationProgressPhase;
  readonly summary: LargeCatalogVerificationSummary;
  readonly recoveredFromScanning: boolean;
}

const pendingStateHash = (checkpoint: LargeCatalogBatchCheckpoint): string => {
  const state = checkpoint.groups.map((group) => ({
    key: group.groupKey,
    status: group.status,
    pending: group.pending.map((page) => [page.relativePath, page.start] as const),
  }));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
};

export const summarizeLargeCatalogVerification = (
  checkpoint: LargeCatalogBatchCheckpoint,
  committedPdfCount: number,
): LargeCatalogVerificationSummary => {
  const selectedGroupKeys = checkpoint.groups.map((group) => group.groupKey);
  if (checkpoint.selectedGroupCount !== selectedGroupKeys.length) {
    throw new HybridCatalogError("hybrid-snapshot-corrupt");
  }
  const selectedGroupCount = checkpoint.selectedGroupCount;
  const completedGroupCount = checkpoint.groups.filter((group) => group.status === "complete").length;
  const committedPageCount = checkpoint.groups.reduce(
    (total, group) => total + group.committedPageKeys.length,
    0,
  );
  const completedDirectoryCount = checkpoint.groups.reduce(
    (total, group) => total + group.completedDirectoryCount,
    0,
  );
  const pendingDirectoryCount = checkpoint.groups.reduce(
    (total, group) => total + group.pending.length,
    0,
  );
  const currentGroupKey = checkpoint.groups[checkpoint.currentGroupIndex]?.groupKey ?? null;
  const progressMarker: LargeVerificationProgressMarker = {
    committedPdfCount,
    committedPageCount,
    completedDirectoryCount,
    completedGroupCount,
    currentGroupIndex: checkpoint.currentGroupIndex,
    pendingStateSha256: pendingStateHash(checkpoint),
  };
  return {
    batchId: checkpoint.batchId,
    verificationScope: checkpoint.schemaVersion === 4
      ? { ...checkpoint.verificationScope }
      : null,
    legacyPromotionRequired: checkpoint.schemaVersion === 3,
    status: checkpoint.status,
    stopReason: checkpoint.stopReason,
    runOrdinal: checkpoint.runOrdinal,
    selectedGroupCount,
    selectedGroupKeys,
    completedGroupCount,
    remainingGroupCount: selectedGroupCount - completedGroupCount,
    currentGroupIndex: checkpoint.currentGroupIndex,
    currentGroupKey,
    pdfCount: checkpoint.pdfCount,
    directoryCount: checkpoint.directoryCount,
    ignoredFileCount: checkpoint.ignoredFileCount,
    listRequestCount: checkpoint.listRequestCount,
    cumulativeListRequestCount: checkpoint.cumulativeListRequestCount,
    committedPdfCount,
    committedPageCount,
    completedDirectoryCount,
    pendingDirectoryCount,
    progressMarker,
  };
};

export const hasDurableVerificationProgress = (
  before: LargeVerificationProgressMarker,
  after: LargeVerificationProgressMarker,
): boolean => (
  after.committedPdfCount > before.committedPdfCount
  || after.committedPageCount > before.committedPageCount
  || after.completedDirectoryCount > before.completedDirectoryCount
  || after.completedGroupCount > before.completedGroupCount
  || after.currentGroupIndex > before.currentGroupIndex
  || after.pendingStateSha256 !== before.pendingStateSha256
);
