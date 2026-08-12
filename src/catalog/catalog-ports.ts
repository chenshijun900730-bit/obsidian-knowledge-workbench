import type {
  BaiduCredentialBundle,
  BaiduListEntry,
  CatalogScanFinalization,
  CatalogScanFinalizationResult,
  CatalogScanCheckpoint,
  CatalogScanReceipt,
  CatalogSnapshotDescriptor,
  CatalogSnapshotRecord,
} from "./catalog-types";

export interface CatalogCredentialPort {
  read(): Promise<BaiduCredentialBundle | null>;
  replace(value: BaiduCredentialBundle): Promise<void>;
  replaceIfCurrent(
    value: BaiduCredentialBundle,
    isCurrent: () => boolean,
  ): Promise<boolean>;
  revoke(): Promise<void>;
}

export interface CatalogAuthorizationBrowserPort {
  openAuthorizationPage(url: string): Promise<void>;
}

export interface BaiduOAuthRequest {
  readonly method: "GET";
  readonly url: string;
  readonly body?: never;
}

export interface BaiduOAuthResponse {
  readonly status: number;
  readonly text: string;
}

export interface BaiduCatalogListRequest {
  readonly method: "GET";
  readonly url: string;
  readonly body?: never;
}

export interface BaiduCatalogListResponse {
  readonly status: number;
  readonly text: string;
}

export interface BaiduOAuthPort {
  beginAuthorization(): Promise<Readonly<{ expiresAt: number }>>;
  submitAuthorizationCode(code: string): Promise<void>;
  cancelAuthorization(): void;
  refresh(): Promise<void>;
  dispose(): void;
}

export interface BaiduCatalogSourcePort {
  listDirectory(input: Readonly<{
    path: string;
    start: number;
    limit: 1000;
    beforeRequest: CatalogListRequestPermit;
  }>): Promise<Readonly<{ entries: readonly BaiduListEntry[] }>>;
}

export type CatalogListRequestPermit = () => Promise<void>;

export interface CatalogSnapshotPort {
  createScan(checkpoint: CatalogScanCheckpoint): Promise<void>;
  commitPage(input: Readonly<{
    scanId: string;
    pageKey: string;
    records: readonly CatalogSnapshotRecord[];
    nextCheckpoint: CatalogScanCheckpoint;
  }>): Promise<void>;
  loadScan(scanId: string): Promise<Readonly<{
    checkpoint: CatalogScanCheckpoint;
    records: readonly CatalogSnapshotRecord[];
  }> | null>;
  saveScanState(checkpoint: CatalogScanCheckpoint): Promise<void>;
  finalizeScan(input: CatalogScanFinalization): Promise<CatalogScanFinalizationResult>;
  loadReceipt(scanId: string): Promise<CatalogScanReceipt | null>;
  promoteScan(scanId: string, completedAt: number): Promise<CatalogSnapshotDescriptor>;
  loadActive(): Promise<Readonly<{
    descriptor: CatalogSnapshotDescriptor;
    records: readonly CatalogSnapshotRecord[];
  }> | null>;
}
