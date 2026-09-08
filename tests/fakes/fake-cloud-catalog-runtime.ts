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
  ConsumeTxtPreviewResult,
  HybridCatalogActiveSummary,
  HybridCatalogVerificationInput,
  HybridCatalogViewModel,
  LargeCatalogBatchSummary,
} from "../../src/catalog/hybrid-catalog-runtime";
import type {
  CatalogTxtImportSummary,
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../../src/catalog/hybrid-catalog-types";
import { HybridCatalogError } from "../../src/catalog/hybrid-catalog-types";
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

const statusAfterTxtNoOp = (
  active: HybridCatalogActiveSummary | undefined,
  batch: LargeCatalogBatchSummary | undefined,
): HybridCatalogViewModel["status"] => {
  if (active === undefined) return "empty";
  if (batch?.status === "scanning") return "scanning";
  if (batch?.status === "paused") return "paused";
  if (batch?.status === "partial") return "partial";
  return "ready";
};

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
  beforeSaveApplicationCredentials: ((input: Readonly<{ appKey: string; secretKey: string }>) => void | Promise<void>) | undefined;
  beforeBeginAuthorization: (() => void | Promise<void>) | undefined;
  beforeSubmitAuthorizationCode: ((code: string) => void | Promise<void>) | undefined;
  beforeRevoke: (() => void | Promise<void>) | undefined;
  beforeStartScan: ((rootPath: string) => void | Promise<void>) | undefined;
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
    await this.beforeSaveApplicationCredentials?.(input);
    this.savedCredentials.push(structuredClone(input));
    this.viewModel = { status: "configured" };
    this.emit();
  }
  async beginAuthorization(): Promise<Readonly<{ expiresAt: number }>> {
    await this.beforeBeginAuthorization?.();
    this.beginAuthorizationCalls += 1;
    this.viewModel = { status: "authorizing", authorizationExpiresAt: 601_000 };
    this.emit();
    return { expiresAt: 601_000 };
  }
  async submitAuthorizationCode(code: string): Promise<void> {
    await this.beforeSubmitAuthorizationCode?.(code);
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
    await this.beforeRevoke?.();
    this.revokeCalls += 1;
    this.viewModel = { status: "unconfigured" };
    this.emit();
  }
  async startScan(rootPath: string): Promise<void> {
    await this.beforeStartScan?.(rootPath);
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
  readonly consumeTxtPreviewInputs: Array<Readonly<{
    path: string;
    expectedSourceSha256: string;
  }>> = [];
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
  beforePreview: ((path: string) => void | Promise<void>) | undefined;
  beforeConsumeTxtPreview: ((input: Readonly<{
    path: string;
    expectedSourceSha256: string;
  }>) => void | Promise<void>) | undefined;
  beforeImport: (() => void | Promise<void>) | undefined;
  beforeRebuildVerificationProjection: (() => void | Promise<void>) | undefined;
  beforeStart: (() => void | Promise<void>) | undefined;
  beforeResume: (() => void | Promise<void>) | undefined;
  previewSummary: CatalogTxtImportSummary = {
    sourceSha256: "b".repeat(64),
    byteSize: 100,
    nonEmptyLineCount: 10,
    pdfCount: 8,
    directoryCount: 2,
    ignoredLeafCount: 0,
    normalizedWhitespaceCount: 0,
    maxDepth: 2,
  };
  consumeTxtPreviewResult: ConsumeTxtPreviewResult | undefined;
  activatedActive: HybridCatalogActiveSummary | undefined;
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
  async previewTxt(path: string): Promise<CatalogTxtImportSummary> {
    this.previewPaths.push(path);
    await this.beforePreview?.(path);
    const summary = structuredClone(this.previewSummary);
    this.viewModel = {
      ...this.viewModel,
      status: "previewed",
      candidate: summary,
    };
    this.emit();
    return structuredClone(summary);
  }
  async consumeTxtPreview(input: Readonly<{
    path: string;
    expectedSourceSha256: string;
  }>): Promise<ConsumeTxtPreviewResult> {
    const detached = structuredClone(input);
    this.consumeTxtPreviewInputs.push(detached);
    await this.beforeConsumeTxtPreview?.(detached);
    const candidate = this.viewModel.candidate;
    if (candidate?.sourceSha256 !== input.expectedSourceSha256) {
      throw new HybridCatalogError("txt-source-invalid");
    }
    const result = this.consumeTxtPreviewResult ?? {
      kind: this.viewModel.active?.sourceImportSha256 === input.expectedSourceSha256
        ? "unchanged" as const
        : "activated" as const,
      sourceSha256: input.expectedSourceSha256,
    };
    const active = result.kind === "activated"
      ? structuredClone(this.activatedActive ?? (this.viewModel.active === undefined
        ? {
            sourceImportSha256: result.sourceSha256,
            legacyArtifactSetSha256: null,
            importedAt: 1,
            pdfCount: candidate.pdfCount,
            unverifiedCount: candidate.pdfCount,
            verifiedCount: 0,
            differenceCount: 0,
            cloudMissingCount: 0,
            groupCount: 0,
            verifiedGroupCount: 0,
            coveredCandidatePdfCount: 0,
            groups: [],
          }
        : { ...this.viewModel.active, sourceImportSha256: result.sourceSha256 }))
      : this.viewModel.active;
    const { candidate: _candidate, ...current } = this.viewModel;
    this.viewModel = result.kind === "activated"
      ? {
          status: "ready",
          executionActive: false,
          active,
        }
      : {
          ...current,
          status: statusAfterTxtNoOp(active, this.viewModel.batch),
          ...(active === undefined ? {} : { active }),
        };
    this.emit();
    return structuredClone(result);
  }
  async importTxt(path: string): Promise<void> {
    await this.beforeImport?.();
    this.importPaths.push(path);
    const candidate = this.viewModel.candidate;
    if (candidate === undefined) throw new HybridCatalogError("txt-source-invalid");
    await this.consumeTxtPreview({ path, expectedSourceSha256: candidate.sourceSha256 });
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
    await this.beforeRebuildVerificationProjection?.();
    this.rebuildVerificationProjectionCalls += 1;
  }
  async startLargeVerification(input: HybridCatalogVerificationInput): Promise<void> {
    await this.beforeStart?.();
    this.startInputs.push(structuredClone(input));
  }
  async resumeLargeVerification(input: HybridCatalogVerificationInput): Promise<void> {
    await this.beforeResume?.();
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
    this.emit();
  }

  private emit(): void {
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
