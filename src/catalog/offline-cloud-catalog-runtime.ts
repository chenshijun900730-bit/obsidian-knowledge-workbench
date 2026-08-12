import type { CatalogSnapshotPort } from "./catalog-ports";
import {
  CloudCatalogRuntimeService,
  type CloudCatalogActionPort,
  type CloudCatalogConnectionRuntime,
  type CloudCatalogConnectionViewModel,
  type CloudCatalogRuntime,
} from "./cloud-catalog-runtime";
import { CatalogError } from "./catalog-types";

const unavailable = async (): Promise<never> => {
  throw new CatalogError("credentials-unavailable");
};

export const OFFLINE_CLOUD_CATALOG_CONNECTION_RUNTIME: CloudCatalogConnectionRuntime = Object.freeze({
  initialize: async () => undefined,
  snapshot: (): CloudCatalogConnectionViewModel => ({
    status: "unconfigured",
    messageCode: "credentials-unavailable",
  }),
  subscribe: () => () => undefined,
  saveApplicationCredentials: unavailable,
  beginAuthorization: unavailable,
  submitAuthorizationCode: unavailable,
  cancelAuthorization: () => undefined,
  revoke: async () => undefined,
  startScan: unavailable,
  cancelScan: () => undefined,
  dispose: () => undefined,
});

export const OFFLINE_CLOUD_CATALOG_ACTION_PORT: CloudCatalogActionPort = Object.freeze({
  copyText: unavailable,
  openBaidu: unavailable,
});

const OFFLINE_SNAPSHOT_PORT: CatalogSnapshotPort = Object.freeze({
  createScan: unavailable,
  commitPage: unavailable,
  loadScan: async () => null,
  saveScanState: unavailable,
  finalizeScan: unavailable,
  loadReceipt: async () => null,
  promoteScan: unavailable,
  loadActive: async () => null,
});

export const createOfflineCloudCatalogRuntime = (): CloudCatalogRuntime =>
  new CloudCatalogRuntimeService(
    OFFLINE_SNAPSHOT_PORT,
    OFFLINE_CLOUD_CATALOG_ACTION_PORT,
    OFFLINE_CLOUD_CATALOG_CONNECTION_RUNTIME,
  );
