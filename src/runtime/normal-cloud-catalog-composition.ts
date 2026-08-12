import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { BaiduCatalogSourceAdapter } from "../adapters/baidu-catalog-source-adapter";
import { BaiduOAuthAdapter } from "../adapters/baidu-oauth-adapter";
import { LocalCatalogSnapshotAdapter } from "../adapters/local-catalog-snapshot-adapter";
import { LocalCatalogTxtSourceAdapter } from "../adapters/local-catalog-txt-source-adapter";
import { LocalHybridCatalogAdapter } from "../adapters/local-hybrid-catalog-adapter";
import {
  ObsidianBaiduCredentialAdapter,
  type ObsidianSecretStoragePort,
} from "../adapters/obsidian-baidu-credential-adapter";
import { CatalogScanService } from "../catalog/catalog-scan-service";
import { CatalogReconciliationService } from "../catalog/catalog-reconciliation-service";
import { CatalogTxtImportService } from "../catalog/catalog-txt-import-service";
import { CatalogTxtParser } from "../catalog/catalog-txt-parser";
import { SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET } from "../catalog/catalog-types";
import { CloudCatalogConnectionRuntimeService } from "../catalog/cloud-catalog-connection-runtime";
import { CloudDirectoryDiscoveryService } from "../catalog/cloud-directory-discovery-service";
import {
  CloudCatalogRuntimeService,
  type CloudCatalogActionPort,
  type CloudCatalogRuntime,
} from "../catalog/cloud-catalog-runtime";
import type {
  BaiduCatalogListRequest,
  BaiduCatalogListResponse,
  BaiduOAuthRequest,
  CatalogAuthorizationBrowserPort,
  CatalogCredentialPort,
} from "../catalog/catalog-ports";
import { HybridCatalogRuntimeService } from "../catalog/hybrid-catalog-runtime";
import { LargeCatalogVerificationService } from "../catalog/large-catalog-verification-service";
import { UnifiedCatalogProjectionService } from "../catalog/unified-catalog-projection-service";

export interface NormalCatalogEnvironment {
  readonly platform: string;
  readonly homeDirectory: string;
}

export interface NormalCatalogSecretHost {
  readonly secretStorage: ObsidianSecretStoragePort;
}

export interface NormalCatalogHost
  extends NormalCatalogSecretHost, CatalogAuthorizationBrowserPort, CloudCatalogActionPort {
  request(
    request: BaiduOAuthRequest | BaiduCatalogListRequest,
  ): Promise<BaiduCatalogListResponse>;
}

export interface NormalCloudCatalogOptions {
  readonly host: NormalCatalogHost;
  readonly catalogRoot: string;
  readonly createScanId?: () => string;
  readonly createImportId?: () => string;
  readonly createUnifiedSnapshotId?: () => string;
  readonly createOverlayId?: () => string;
  readonly createBatchId?: () => string;
  readonly now?: () => number;
}

export const createNormalCatalogCredentialPort = (
  host: NormalCatalogSecretHost,
): CatalogCredentialPort => new ObsidianBaiduCredentialAdapter(host.secretStorage);

const SYSTEM_CATALOG_ENVIRONMENT: NormalCatalogEnvironment = Object.freeze({
  platform: process.platform,
  homeDirectory: homedir(),
});

export const resolveCatalogRoot = (
  environment: NormalCatalogEnvironment = SYSTEM_CATALOG_ENVIRONMENT,
): string => {
  if (environment.platform !== "darwin") throw new Error("unsupported-catalog-platform");
  if (!isAbsolute(environment.homeDirectory)) throw new Error("invalid-catalog-home-root");
  const homeDirectory = resolve(environment.homeDirectory);
  if (homeDirectory === parse(homeDirectory).root) throw new Error("invalid-catalog-home-root");
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "Knowledge Workbench",
    "baidu-catalog",
  );
};

const requireCatalogRoot = (value: string): string => {
  if (!isAbsolute(value)) throw new Error("invalid-catalog-root");
  const root = resolve(value);
  if (root === parse(root).root) throw new Error("invalid-catalog-root");
  return root;
};

export const createNormalCloudCatalogRuntime = (
  options: NormalCloudCatalogOptions,
): CloudCatalogRuntime => {
  const root = requireCatalogRoot(options.catalogRoot);
  const now = options.now ?? Date.now;
  const snapshots = new LocalCatalogSnapshotAdapter(root);
  const hybridStore = new LocalHybridCatalogAdapter(
    root,
    undefined,
    options.createUnifiedSnapshotId ?? (() => `unified-${randomUUID()}`),
    options.createOverlayId ?? (() => `overlay-${randomUUID()}`),
  );
  const txtSource = new LocalCatalogTxtSourceAdapter();
  const imports = new CatalogTxtImportService(
    new CatalogTxtParser(),
    hybridStore,
    {
      createImportId: options.createImportId ?? (() => `import-${randomUUID()}`),
      now,
    },
  );
  const projection = new UnifiedCatalogProjectionService(hybridStore, { now });
  const reconciliation = new CatalogReconciliationService();
  const credentials = createNormalCatalogCredentialPort(options.host);
  const oauth = new BaiduOAuthAdapter({
    credentials,
    browser: options.host,
    request: (request) => options.host.request(request),
  });
  const baiduSource = new BaiduCatalogSourceAdapter({
    credentials,
    oauth,
    request: (request) => options.host.request(request),
  });
  const scanner = new CatalogScanService(baiduSource, snapshots, {
    budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
  });
  const directoryDiscovery = new CloudDirectoryDiscoveryService(baiduSource, { now });
  const verification = new LargeCatalogVerificationService({
    source: baiduSource,
    store: hybridStore,
    reconcile: reconciliation,
    project: projection,
    now,
  });
  const hybrid = new HybridCatalogRuntimeService({
    source: txtSource,
    imports,
    store: hybridStore,
    project: projection,
    verification,
    createBatchId: options.createBatchId ?? (() => `batch-${randomUUID()}`),
  });
  let runtime: CloudCatalogRuntimeService;
  const connection = new CloudCatalogConnectionRuntimeService({
    credentials,
    oauth,
    scanner,
    createScanId: options.createScanId ?? (() => `scan-${randomUUID()}`),
    onSnapshotChanged: async () => runtime.initialize(),
  });
  runtime = new CloudCatalogRuntimeService(
    snapshots,
    options.host,
    connection,
    hybrid,
    hybridStore,
    directoryDiscovery,
  );
  return runtime;
};
