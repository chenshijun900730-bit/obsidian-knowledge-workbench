import type {
  CloudCatalogConnectionRuntime,
  CloudCatalogConnectionViewModel,
  CloudCatalogRuntime,
  CloudCatalogViewModel,
} from "../../src/catalog/cloud-catalog-runtime";
import type { CloudDirectoryDiscoveryRuntime } from "../../src/catalog/cloud-directory-discovery-service";
import type { CloudDirectoryBrowserRuntime } from "../../src/catalog/cloud-directory-browser";
import type { CloudDirectoryLocatorRuntime } from "../../src/catalog/cloud-directory-locator";
import type { CatalogScanConfirmationPresenter } from "../../src/ui/catalog-scan-confirmation-modal";
import type { HybridCatalogRuntime } from "../../src/catalog/hybrid-catalog-runtime";
import type {
  HybridCatalogActiveSummary,
  HybridCatalogVerificationInput,
  HybridCatalogViewModel,
  LargeCatalogBatchSummary,
} from "../../src/catalog/hybrid-catalog-runtime";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../../src/catalog/hybrid-catalog-types";
import type {
  CloudVerificationAuthority,
  CloudVerificationScope,
} from "../../src/catalog/cloud-verification-scope";
import type { LegacyVerificationAdoptionV1 } from "../../src/storage/legacy-verification-adoption";

type FakeHybridCatalogViewModel = Omit<
  Partial<HybridCatalogViewModel>,
  "active" | "batch" | "status"
> & Readonly<{
  status: HybridCatalogViewModel["status"];
  active?: Partial<HybridCatalogActiveSummary>;
  batch?: Partial<LargeCatalogBatchSummary> & Pick<LargeCatalogBatchSummary, "status">;
}>;

const normalizeHybridViewModel = (
  value: FakeHybridCatalogViewModel,
): HybridCatalogViewModel => {
  const normalized: Record<string, unknown> = {
    executionActive: false,
    ...structuredClone(value),
  };
  if (value.active !== undefined) {
    normalized.active = {
      sourceImportSha256: "0".repeat(64),
      legacyArtifactSetSha256: null,
      ...structuredClone(value.active),
    };
  }
  if (value.batch !== undefined) {
    normalized.batch = {
      verificationScope: null,
      legacyPromotionRequired: false,
      ...structuredClone(value.batch),
    };
  }
  return normalized as unknown as HybridCatalogViewModel;
};

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
  readonly verificationAuthorities: Array<CloudVerificationAuthority | null> = [];
  private readonly listeners = new Set<() => void>();
  private viewModel: CloudCatalogViewModel;

  constructor(
    initial: Partial<CloudCatalogViewModel> = {},
    readonly connection?: CloudCatalogConnectionRuntime,
    readonly hybrid?: HybridCatalogRuntime,
    readonly directoryDiscovery?: CloudDirectoryDiscoveryRuntime,
    readonly directoryBrowser?: CloudDirectoryBrowserRuntime,
    readonly directoryLocator?: CloudDirectoryLocatorRuntime,
  ) {
    this.viewModel = { ...emptyViewModel(), ...initial };
  }

  async initialize(): Promise<void> { this.initializeCalls += 1; }
  setVerificationAuthority(authority: CloudVerificationAuthority | null): void {
    this.verificationAuthorities.push(structuredClone(authority));
    this.hybrid?.setVerificationAuthority(authority);
  }
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
  readonly resumeInputs: HybridCatalogVerificationInput[] = [];
  readonly verificationAuthorities: Array<CloudVerificationAuthority | null> = [];
  readonly preparedAdoptionScopes: CloudVerificationScope[] = [];
  readonly revalidatedAdoptions: Array<LegacyVerificationAdoptionV1 | null> = [];
  prepareLegacyLocalAuthorityCalls = 0;
  rebuildVerificationProjectionCalls = 0;
  cancelCalls = 0;
  initializeCalls = 0;
  disposeCalls = 0;
  beforeImport: (() => void) | undefined;
  beforeStart: (() => void) | undefined;
  beforeResume: (() => void) | undefined;
  legacyLocalAuthority: Extract<
    CloudVerificationAuthority,
    Readonly<{ kind: "legacy-local-only" }>
  > | null = null;
  preparedAdoption: LegacyVerificationAdoptionV1 | null = null;
  private readonly listeners = new Set<() => void>();
  private viewModel: HybridCatalogViewModel;

  constructor(
    viewModel: FakeHybridCatalogViewModel = {
      status: "empty",
    },
  ) {
    this.viewModel = normalizeHybridViewModel(viewModel);
  }

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
  setVerificationAuthority(authority: CloudVerificationAuthority | null): void {
    this.verificationAuthorities.push(structuredClone(authority));
  }
  async prepareLegacyLocalVerificationAuthority(): Promise<Extract<
    CloudVerificationAuthority,
    Readonly<{ kind: "legacy-local-only" }>
  > | null> {
    this.prepareLegacyLocalAuthorityCalls += 1;
    return structuredClone(this.legacyLocalAuthority);
  }
  async prepareLegacyVerificationAdoption(
    scope: CloudVerificationScope,
  ): Promise<LegacyVerificationAdoptionV1 | null> {
    this.preparedAdoptionScopes.push(structuredClone(scope));
    return structuredClone(this.preparedAdoption);
  }
  async revalidatePreparedLegacyAdoption(
    prepared: LegacyVerificationAdoptionV1 | null,
  ): Promise<void> {
    this.revalidatedAdoptions.push(structuredClone(prepared));
  }
  async rebuildVerificationProjection(): Promise<void> {
    this.rebuildVerificationProjectionCalls += 1;
  }
  async startLargeVerification(input: HybridCatalogVerificationInput): Promise<void> {
    this.beforeStart?.();
    this.startInputs.push(structuredClone(input));
  }
  async resumeLargeVerification(input: HybridCatalogVerificationInput): Promise<void> {
    this.beforeResume?.();
    this.resumeRoots.push(input.cloudRoot);
    this.resumeInputs.push(structuredClone(input));
  }
  cancelLargeVerification(): void { this.cancelCalls += 1; }
  dispose(): void {
    this.disposeCalls += 1;
    this.listeners.clear();
  }
  setSnapshot(
    value: FakeHybridCatalogViewModel,
  ): void {
    this.viewModel = normalizeHybridViewModel(value);
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
