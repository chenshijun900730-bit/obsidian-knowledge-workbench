export interface CatalogTxtImportBudget {
  readonly maxBytes: number;
  readonly maxNonEmptyLineCount: number;
  readonly maxPdfCount: number;
  readonly maxDepth: number;
  readonly maxLineBytes: number;
}

export const CATALOG_TXT_IMPORT_BUDGET = /* @__PURE__ */ Object.freeze({
  maxBytes: 16_777_216,
  maxNonEmptyLineCount: 71_000,
  maxPdfCount: 70_000,
  maxDepth: 32,
  maxLineBytes: 16_384,
} as const satisfies CatalogTxtImportBudget);

export interface LargeCatalogRunBudget {
  readonly maxSelectedTopLevelGroups: number;
  readonly maxPdfCount: number;
  readonly maxDirectoryCount: number;
  readonly maxListRequestCount: number;
  readonly maxDurationMs: number;
}

export const LARGE_CATALOG_RUN_BUDGET = /* @__PURE__ */ Object.freeze({
  maxSelectedTopLevelGroups: 5,
  maxPdfCount: 10_000,
  maxDirectoryCount: 500,
  maxListRequestCount: 300,
  maxDurationMs: 1_800_000,
} as const satisfies LargeCatalogRunBudget);

export const LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS = 12 as const;

export const MAX_UNIFIED_CATALOG_PDF_COUNT = 70_000 as const;

export type HybridCatalogErrorCode =
  | "txt-source-unavailable"
  | "txt-source-invalid"
  | "txt-import-budget-exceeded"
  | "txt-tree-invalid"
  | "txt-duplicate-path"
  | "hybrid-record-invalid"
  | "hybrid-snapshot-corrupt"
  | "hybrid-cloud-root-mismatch"
  | "hybrid-batch-invalid"
  | "hybrid-batch-unavailable";

export class HybridCatalogError extends Error {
  constructor(readonly code: HybridCatalogErrorCode) {
    super(code);
    this.name = "HybridCatalogError";
  }
}

export type CatalogVerificationStatus = "unverified" | "verified" | "difference";
export type CatalogDifferenceKind = "cloud-added" | "cloud-missing" | "renamed" | "moved";

export interface TxtCandidateRecordV1 {
  readonly schemaVersion: 1;
  readonly source: "txt-candidate";
  readonly candidateId: string;
  readonly relativePath: string;
  readonly parentRelativePath: string;
  readonly filename: string;
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly topLevelGroupId: string;
  readonly hierarchyTags: readonly string[];
}

export interface CatalogTxtImportSummary {
  readonly sourceSha256: string;
  readonly byteSize: number;
  readonly nonEmptyLineCount: number;
  readonly pdfCount: number;
  readonly directoryCount: number;
  readonly ignoredLeafCount: number;
  readonly normalizedWhitespaceCount: number;
  readonly maxDepth: number;
}

export interface CandidateCatalogDescriptor extends CatalogTxtImportSummary {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly importedAt: number;
  readonly candidateSha256: string;
}

export interface UnifiedCatalogRecordV1 {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly candidateId: string | null;
  readonly fsId: string | null;
  readonly relativePath: string;
  readonly cloudPath: string | null;
  readonly filename: string;
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly sizeBytes: number | null;
  readonly serverModifiedAt: number | null;
  readonly topLevelGroupId: string;
  readonly hierarchyTags: readonly string[];
  readonly verificationStatus: CatalogVerificationStatus;
  readonly differenceKinds: readonly CatalogDifferenceKind[];
  readonly visibleByDefault: boolean;
}

export interface CatalogDifferenceRecordV1 {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly topLevelGroupId: string;
  readonly kind: CatalogDifferenceKind;
  readonly acknowledgedAt: number | null;
}

export interface UnifiedCatalogDescriptor {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly sourceImportSha256: string;
  readonly completedAt: number;
  readonly recordCount: number;
  readonly differenceCount: number;
  readonly catalogSha256: string;
  readonly differencesSha256: string;
}

export interface CatalogOverlayDescriptor {
  readonly schemaVersion: 1;
  readonly overlayId: string;
  readonly sourceImportSha256: string;
  readonly topLevelGroupId: string;
  readonly completedAt: number;
  readonly recordCount: number;
  readonly differenceCount: number;
  readonly supersededCount: number;
  readonly recordsSha256: string;
  readonly differencesSha256: string;
  readonly supersededSha256: string;
}

export interface ActiveCatalogOverlay {
  readonly descriptor: CatalogOverlayDescriptor;
  readonly records: readonly UnifiedCatalogRecordV1[];
  readonly differences: readonly CatalogDifferenceRecordV1[];
  readonly supersededCatalogIds: readonly string[];
}

export interface CatalogReconciliationResult {
  readonly sourceImportSha256: string;
  readonly topLevelGroupId: string;
  readonly completedAt: number;
  readonly records: readonly UnifiedCatalogRecordV1[];
  readonly differences: readonly CatalogDifferenceRecordV1[];
  readonly supersededCatalogIds: readonly string[];
}

export type LargeCatalogPauseReason =
  | "user-canceled"
  | "selection-limit"
  | "pdf-limit"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

export type LargeCatalogErrorCode =
  | "baidu-permission-denied"
  | "baidu-not-found"
  | "baidu-rate-limited"
  | "baidu-token-expired"
  | "baidu-access-unavailable"
  | "invalid-baidu-response"
  | "hybrid-snapshot-corrupt"
  | "hybrid-batch-invalid"
  | "hybrid-batch-unavailable";

export type LargeCatalogStopReason = "complete" | LargeCatalogPauseReason | LargeCatalogErrorCode;
export type LargeCatalogBatchStatus = "scanning" | "complete" | "paused" | "partial";
export type LargeCatalogGroupStatus = "pending" | "scanning" | "complete";
export type LargeCatalogGroupMode = "recursive" | "direct-files-only";

export interface LargeCatalogPendingPageV3 {
  readonly relativePath: string;
  readonly start: number;
}

export interface LargeCatalogBatchGroupV3 {
  readonly groupKey: string;
  readonly rootRelativePath: string;
  readonly mode: LargeCatalogGroupMode;
  readonly status: LargeCatalogGroupStatus;
  readonly pending: readonly LargeCatalogPendingPageV3[];
  readonly committedPageKeys: readonly string[];
  readonly completedDirectoryCount: number;
}

export interface LargeCatalogBatchCheckpointV3 {
  readonly schemaVersion: 3;
  readonly batchId: string;
  readonly sourceImportSha256: string;
  readonly cloudRootSha256: string;
  readonly startedAt: number;
  readonly runOrdinal: number;
  readonly budget: LargeCatalogRunBudget;
  readonly selectedGroupCount: number;
  readonly currentGroupIndex: number;
  readonly groups: readonly LargeCatalogBatchGroupV3[];
  readonly pdfCount: number;
  readonly directoryCount: number;
  readonly ignoredFileCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
  readonly status: LargeCatalogBatchStatus;
  readonly stopReason: LargeCatalogStopReason | null;
  readonly errorCodeCounts: Readonly<Partial<Record<LargeCatalogErrorCode, number>>>;
}

export interface LargeCatalogRunReceiptV3 {
  readonly schemaVersion: 3;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: LargeCatalogStopReason;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly budget: LargeCatalogRunBudget;
  readonly selectedGroupCount: number;
  readonly completedGroupCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly downloadedPdfBytes: 0;
  readonly errorCodeCounts: Readonly<Partial<Record<LargeCatalogErrorCode, number>>>;
}
