import type {
  CloudCatalogConnectionRuntime,
  CloudCatalogConnectionViewModel,
  CloudCatalogRuntime,
  CloudCatalogViewModel,
} from "../../src/catalog/cloud-catalog-runtime";
import type { CloudDirectoryDiscoveryRuntime } from "../../src/catalog/cloud-directory-discovery-service";
import type { CloudDirectoryLocatorRuntime } from "../../src/catalog/cloud-directory-locator";
import type { CatalogScanConfirmationPresenter } from "../../src/ui/catalog-scan-confirmation-modal";
import type { HybridCatalogRuntime } from "../../src/catalog/hybrid-catalog-runtime";
import type {
  HybridCatalogVerificationInput,
  HybridCatalogViewModel,
} from "../../src/catalog/hybrid-catalog-runtime";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../../src/catalog/hybrid-catalog-types";

const emptyViewModel = (): CloudCatalogViewModel => ({
  status: "no-snapshot",
  source: "none",
  pdfCount: 0,
  verificationCounts: { unverified: 0, verified: 0, difference: 0, cloudMissing: 0 },
  query: "",
  folderPrefix: "",
  verificationStatuses: [],
  differenceKinds: [],
  topLevelGroupId: "",
  hierarchyTag: "",
  includeCloudMissing: false,
  groups: [],
  hierarchyTags: [],
  page: 0,
  pageSize: 50,
  total: 0,
  items: [],
});

export class FakeCloudCatalogRuntime implements CloudCatalogRuntime {
  readonly queries: string[] = [];
  readonly folderPrefixes: string[] = [];
  readonly verificationStatuses: readonly CatalogVerificationStatus[][] = [];
  readonly differenceKinds: readonly CatalogDifferenceKind[][] = [];
  readonly topLevelGroupIds: string[] = [];
  readonly hierarchyTagValues: string[] = [];
  readonly includeCloudMissingValues: boolean[] = [];
  readonly pages: number[] = [];
  readonly copiedFilenames: string[] = [];
  readonly copiedPaths: string[] = [];
  openBaiduCalls = 0;
  initializeCalls = 0;
  disposeCalls = 0;
  private readonly listeners = new Set<() => void>();
  private viewModel: CloudCatalogViewModel;

  constructor(
    initial: Partial<CloudCatalogViewModel> = {},
    readonly connection?: CloudCatalogConnectionRuntime,
    readonly hybrid?: HybridCatalogRuntime,
    readonly directoryDiscovery?: CloudDirectoryDiscoveryRuntime,
    readonly directoryLocator?: CloudDirectoryLocatorRuntime,
  ) {
    this.viewModel = { ...emptyViewModel(), ...initial };
  }

  async initialize(): Promise<void> { this.initializeCalls += 1; }
  snapshot(): CloudCatalogViewModel { return structuredClone(this.viewModel); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  setQuery(value: string): void { this.queries.push(value); }
  setFolderPrefix(value: string): void { this.folderPrefixes.push(value); }
  setVerificationStatuses(values: readonly CatalogVerificationStatus[]): void {
    (this.verificationStatuses as CatalogVerificationStatus[][]).push([...values]);
  }
  setDifferenceKinds(values: readonly CatalogDifferenceKind[]): void {
    (this.differenceKinds as CatalogDifferenceKind[][]).push([...values]);
  }
  setTopLevelGroupId(value: string): void { this.topLevelGroupIds.push(value); }
  setHierarchyTag(value: string): void { this.hierarchyTagValues.push(value); }
  setIncludeCloudMissing(value: boolean): void { this.includeCloudMissingValues.push(value); }
  setPage(value: number): void { this.pages.push(value); }
  async copyFilename(fsId: string): Promise<void> { this.copiedFilenames.push(fsId); }
  async copyCloudPath(fsId: string): Promise<void> { this.copiedPaths.push(fsId); }
  async openBaidu(): Promise<void> { this.openBaiduCalls += 1; }
  dispose(): void {
    this.disposeCalls += 1;
    this.listeners.clear();
  }

  setSnapshot(value: CloudCatalogViewModel): void {
    this.viewModel = structuredClone(value);
    for (const listener of this.listeners) listener();
  }
}

export class FakeCloudCatalogConnectionRuntime implements CloudCatalogConnectionRuntime {
  readonly savedCredentials: Array<Readonly<{ appKey: string; secretKey: string }>> = [];
  readonly startScanCalls: string[] = [];
  beginAuthorizationCalls = 0;
  readonly submittedAuthorizationCodes: string[] = [];
  cancelAuthorizationCalls = 0;
  revokeCalls = 0;
  cancelScanCalls = 0;
  disposeCalls = 0;
  beforeStartScan: ((rootPath: string) => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private viewModel: CloudCatalogConnectionViewModel;

  constructor(initial: CloudCatalogConnectionViewModel = { status: "unconfigured" }) {
    this.viewModel = structuredClone(initial);
  }

  snapshot(): CloudCatalogConnectionViewModel { return structuredClone(this.viewModel); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async initialize(): Promise<void> {}
  async saveApplicationCredentials(input: Readonly<{ appKey: string; secretKey: string }>): Promise<void> {
    this.savedCredentials.push(structuredClone(input));
    this.viewModel = { status: "configured" };
    this.emit();
  }
  async beginAuthorization(): Promise<Readonly<{ expiresAt: number }>> {
    this.beginAuthorizationCalls += 1;
    this.viewModel = { status: "authorizing", authorizationExpiresAt: 601_000 };
    this.emit();
    return { expiresAt: 601_000 };
  }
  async submitAuthorizationCode(code: string): Promise<void> {
    this.submittedAuthorizationCodes.push(code);
    this.viewModel = { status: "authorized" };
    this.emit();
  }
  cancelAuthorization(): void {
    this.cancelAuthorizationCalls += 1;
    this.viewModel = { status: "configured" };
    this.emit();
  }
  async revoke(): Promise<void> {
    this.revokeCalls += 1;
    this.viewModel = { status: "unconfigured" };
    this.emit();
  }
  async startScan(rootPath: string): Promise<void> {
    this.beforeStartScan?.(rootPath);
    this.startScanCalls.push(rootPath);
  }
  cancelScan(): void { this.cancelScanCalls += 1; }
  dispose(): void {
    this.disposeCalls += 1;
    this.listeners.clear();
  }

  setSnapshot(value: CloudCatalogConnectionViewModel): void {
    this.viewModel = structuredClone(value);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export class FakeHybridCatalogRuntime implements HybridCatalogRuntime {
  readonly previewPaths: string[] = [];
  readonly importPaths: string[] = [];
  readonly startInputs: HybridCatalogVerificationInput[] = [];
  readonly resumeRoots: string[] = [];
  cancelCalls = 0;
  initializeCalls = 0;
  disposeCalls = 0;
  beforeImport: (() => void) | undefined;
  beforeStart: (() => void) | undefined;
  beforeResume: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private viewModel: HybridCatalogViewModel = { status: "empty" }) {}

  async initialize(): Promise<void> { this.initializeCalls += 1; }
  snapshot(): HybridCatalogViewModel { return structuredClone(this.viewModel); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async previewTxt(path: string): Promise<void> { this.previewPaths.push(path); }
  async importTxt(path: string): Promise<void> {
    this.beforeImport?.();
    this.importPaths.push(path);
  }
  async startLargeVerification(input: HybridCatalogVerificationInput): Promise<void> {
    this.beforeStart?.();
    this.startInputs.push(structuredClone(input));
  }
  async resumeLargeVerification(cloudRoot: string): Promise<void> {
    this.beforeResume?.();
    this.resumeRoots.push(cloudRoot);
  }
  cancelLargeVerification(): void { this.cancelCalls += 1; }
  dispose(): void {
    this.disposeCalls += 1;
    this.listeners.clear();
  }
  setSnapshot(value: HybridCatalogViewModel): void {
    this.viewModel = structuredClone(value);
    for (const listener of this.listeners) listener();
  }
}

export class FakeCatalogScanConfirmationPresenter implements CatalogScanConfirmationPresenter {
  readonly requests: string[] = [];
  constructor(private readonly result: boolean) {}
  async request(rootPath: string): Promise<boolean> {
    this.requests.push(rootPath);
    return this.result;
  }
}
