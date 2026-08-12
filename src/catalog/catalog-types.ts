export interface CloudCatalogRecord {
  readonly schemaVersion: 1;
  readonly source: "baidu-netdisk";
  readonly fsId: string;
  readonly kind: "file";
  readonly path: string;
  readonly parentPath: string;
  readonly filename: string;
  readonly extension: "pdf";
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly sizeBytes: number;
  readonly serverModifiedAt: number;
}

export interface CloudCatalogDirectory {
  readonly schemaVersion: 1;
  readonly source: "baidu-netdisk";
  readonly fsId: string;
  readonly kind: "directory";
  readonly path: string;
  readonly parentPath: string;
  readonly filename: string;
  readonly sizeBytes: 0;
  readonly serverModifiedAt: number;
}

export type CatalogSnapshotRecord = CloudCatalogRecord | CloudCatalogDirectory;
export type CatalogErrorCode =
  | "authorization-canceled"
  | "authorization-attempt-unavailable"
  | "authorization-attempt-expired"
  | "authorization-code-invalid"
  | "authorization-exchange-failed"
  | "credentials-unavailable"
  | "invalid-scan-root"
  | "baidu-permission-denied"
  | "baidu-not-found"
  | "baidu-rate-limited"
  | "baidu-token-expired"
  | "baidu-access-unavailable"
  | "invalid-baidu-response"
  | "snapshot-corrupt";

export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode, readonly retryable = false) {
    super(code);
    this.name = "CatalogError";
  }
}

export interface BaiduListEntry {
  readonly fsId: string;
  readonly path: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly serverModifiedAt: number;
  readonly isDirectory: boolean;
}

export interface BaiduCredentialBundle {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly appKey: string;
  readonly secretKey: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: number;
}

export interface CatalogScanBudget {
  readonly maxPdfCount: number;
  readonly maxDirectoryCount: number;
  readonly maxListRequestCount: number;
  readonly maxDurationMs: number;
}

export const SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET = /* @__PURE__ */ Object.freeze({
  maxPdfCount: 1_000,
  maxDirectoryCount: 20,
  maxListRequestCount: 25,
  maxDurationMs: 120_000,
} as const satisfies CatalogScanBudget);

export type CatalogScanPauseReason =
  | "user-canceled"
  | "pdf-limit"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

export type CatalogScanStopReason = "complete" | CatalogScanPauseReason | CatalogErrorCode;

interface CatalogScanCheckpointBase {
  readonly scanId: string;
  readonly rootPath: string;
  readonly startedAt: number;
  readonly pending: readonly Readonly<{ path: string; start: number }>[];
  readonly committedPageKeys: readonly string[];
  readonly completedDirectoryCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly status: "scanning" | "paused" | "partial";
}

export interface CatalogScanCheckpointV1 extends CatalogScanCheckpointBase {
  readonly schemaVersion: 1;
}

export interface CatalogScanCheckpointV2 extends CatalogScanCheckpointBase {
  readonly schemaVersion: 2;
  readonly budget: CatalogScanBudget;
  readonly listRequestCount: number;
  readonly pauseReason: CatalogScanPauseReason | null;
}

export type CatalogScanCheckpoint = CatalogScanCheckpointV1 | CatalogScanCheckpointV2;

export interface CatalogSnapshotDescriptor {
  readonly snapshotId: string;
  readonly schemaVersion: 1;
  readonly completedAt: number;
  readonly recordCount: number;
  readonly pdfCount: number;
  readonly sha256: string;
}

export interface CatalogScanReceiptV1 {
  readonly schemaVersion: 1;
  readonly status: "complete" | "paused" | "partial";
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly snapshotSha256?: string;
}

export interface CatalogScanReceiptV2 {
  readonly schemaVersion: 2;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: CatalogScanStopReason;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly budget: CatalogScanBudget;
  readonly listRequestCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly downloadedPdfBytes: 0;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly snapshotSha256: string | null;
}

export type CatalogScanReceipt = CatalogScanReceiptV1 | CatalogScanReceiptV2;

export interface CatalogScanResult {
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: CatalogScanStopReason;
  readonly progress: CatalogScanProgress;
  readonly descriptor?: CatalogSnapshotDescriptor;
  readonly errorCode?: CatalogErrorCode;
}

export interface CatalogScanProgress {
  readonly status: "scanning" | "paused" | "partial" | "complete";
  readonly directoryCount: number;
  readonly completedDirectoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly pendingDirectoryCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
  readonly budget: CatalogScanBudget;
  readonly stopReason?: CatalogScanStopReason;
}

export interface CatalogScanFinalization {
  readonly checkpoint: CatalogScanCheckpointV2;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: CatalogScanStopReason;
  readonly endedAt: number;
}

export interface CatalogScanFinalizationResult {
  readonly receipt: CatalogScanReceiptV2;
  readonly descriptor?: CatalogSnapshotDescriptor;
}
