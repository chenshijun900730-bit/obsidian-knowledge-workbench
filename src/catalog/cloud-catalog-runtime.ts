import { normalizeCloudAbsolutePath } from "./catalog-path";
import type { CatalogSnapshotPort } from "./catalog-ports";
import { CatalogSearchService } from "./catalog-search-service";
import {
  CatalogError,
  type CatalogErrorCode,
  type CatalogScanProgress,
  type CloudCatalogRecord,
} from "./catalog-types";
import type { HybridCatalogRuntime } from "./hybrid-catalog-runtime";
import type {
  ActiveUnifiedCatalogQueryResult,
  UnifiedCatalogStorePort,
} from "./hybrid-catalog-ports";
import {
  HybridCatalogError,
  type CatalogDifferenceKind,
  type CatalogVerificationStatus,
  type UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";
import type { UnifiedCatalogSearchQuery } from "./unified-catalog-search-service";
import type { CloudDirectoryDiscoveryRuntime } from "./cloud-directory-discovery-service";
import type { CloudDirectoryBrowserRuntime } from "./cloud-directory-browser";
import type { CloudDirectoryLocatorRuntime } from "./cloud-directory-locator";
import {
  decodeCloudVerificationAuthority,
  type CloudVerificationAuthority,
} from "./cloud-verification-scope";

const PAGE_SIZE = 50 as const;
const STATUS_VALUES: readonly CatalogVerificationStatus[] = ["unverified", "verified", "difference"];
const DIFFERENCE_VALUES: readonly CatalogDifferenceKind[] = [
  "cloud-added",
  "cloud-missing",
  "renamed",
  "moved",
];

export interface CatalogDisplayItem {
  readonly catalogId: string;
  readonly filename: string;
  readonly pathLabel: string;
  readonly cloudPathAvailable: boolean;
  readonly verificationStatus: CatalogVerificationStatus;
  readonly differenceKinds: readonly CatalogDifferenceKind[];
  readonly hierarchyTags: readonly string[];
}

export interface CatalogFilterOption {
  readonly label: string;
  readonly count: number;
}

export interface CatalogGroupFilterOption extends CatalogFilterOption {
  readonly groupKey: string;
}

export interface CatalogTagFilterOption extends CatalogFilterOption {
  readonly tag: string;
}

export interface CatalogVerificationCounts {
  readonly unverified: number;
  readonly verified: number;
  readonly difference: number;
  readonly cloudMissing: number;
}

export interface CloudCatalogViewModel {
  readonly status:
    | "unconfigured"
    | "no-snapshot"
    | "loading"
    | "ready"
    | "partial"
    | "error"
    | "unavailable";
  readonly source: "none" | "legacy" | "unified";
  readonly snapshotCompletedAt?: number;
  readonly pdfCount: number;
  readonly verificationCounts: CatalogVerificationCounts;
  readonly query: string;
  readonly folderPrefix: string;
  readonly verificationStatuses: readonly CatalogVerificationStatus[];
  readonly differenceKinds: readonly CatalogDifferenceKind[];
  readonly topLevelGroupId: string;
  readonly hierarchyTag: string;
  readonly includeCloudMissing: boolean;
  readonly groups: readonly CatalogGroupFilterOption[];
  readonly hierarchyTags: readonly CatalogTagFilterOption[];
  readonly page: number;
  readonly pageSize: 50;
  readonly total: number;
  readonly items: readonly CatalogDisplayItem[];
  readonly messageCode?: CatalogErrorCode | "catalog-unavailable";
}

/** Selection is view-only; membership checks stay bounded to the emitted 50-row page. */
export const catalogPageContains = (
  model: CloudCatalogViewModel,
  catalogId: string | null,
): boolean => catalogId !== null && model.items.some((item) => item.catalogId === catalogId);

export interface CloudCatalogConnectionViewModel {
  readonly status:
    | "unconfigured"
    | "configured"
    | "authorizing"
    | "authorized"
    | "scanning"
    | "paused"
    | "partial";
  readonly messageCode?: CatalogErrorCode | "catalog-unavailable";
  readonly authorizationExpiresAt?: number;
  readonly scanProgress?: CatalogScanProgress;
}

export interface CloudCatalogConnectionRuntime {
  initialize(): Promise<void>;
  snapshot(): CloudCatalogConnectionViewModel;
  subscribe(listener: () => void): () => void;
  saveApplicationCredentials(input: Readonly<{
    appKey: string;
    secretKey: string;
  }>): Promise<void>;
  beginAuthorization(): Promise<Readonly<{ expiresAt: number }>>;
  submitAuthorizationCode(code: string): Promise<void>;
  cancelAuthorization(): void;
  revoke(): Promise<void>;
  startScan(rootPath: string): Promise<void>;
  cancelScan(): void;
  dispose(): void;
}

export interface CloudCatalogRuntime {
  readonly connection?: CloudCatalogConnectionRuntime;
  readonly hybrid?: HybridCatalogRuntime;
  readonly directoryDiscovery?: CloudDirectoryDiscoveryRuntime;
  readonly directoryBrowser?: CloudDirectoryBrowserRuntime;
  readonly directoryLocator?: CloudDirectoryLocatorRuntime;
  /** Installs detached query authority before initialization or projection refresh. */
  setVerificationAuthority?(authority: CloudVerificationAuthority | null): void;
  initialize(): Promise<void>;
  snapshot(): CloudCatalogViewModel;
  subscribe(listener: () => void): () => void;
  setQuery(value: string): void;
  setFolderPrefix(value: string): void;
  setVerificationStatuses(values: readonly CatalogVerificationStatus[]): void;
  setDifferenceKinds(values: readonly CatalogDifferenceKind[]): void;
  setTopLevelGroupId(value: string): void;
  setHierarchyTag(value: string): void;
  setIncludeCloudMissing(value: boolean): void;
  setPage(value: number): void;
  copyFilename(catalogId: string): Promise<void>;
  copyCloudPath(catalogId: string): Promise<void>;
  openBaidu(): Promise<void>;
  dispose(): void;
}

export interface CloudCatalogActionPort {
  copyText(value: string): Promise<void>;
  openBaidu(): Promise<void>;
}

interface ActionRecord {
  readonly filename: string;
  readonly cloudPath: string | null;
}

const zeroCounts = (): CatalogVerificationCounts => ({
  unverified: 0,
  verified: 0,
  difference: 0,
  cloudMissing: 0,
});

const initialViewModel = (): CloudCatalogViewModel => ({
  status: "no-snapshot",
  source: "none",
  pdfCount: 0,
  verificationCounts: zeroCounts(),
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
  pageSize: PAGE_SIZE,
  total: 0,
  items: [],
});

const cloneDisplayItem = (item: CatalogDisplayItem): CatalogDisplayItem => ({
  ...item,
  differenceKinds: [...item.differenceKinds],
  hierarchyTags: [...item.hierarchyTags],
});

const displayLegacy = (record: CloudCatalogRecord): CatalogDisplayItem => ({
  catalogId: record.fsId,
  filename: record.filename,
  pathLabel: record.path,
  cloudPathAvailable: true,
  verificationStatus: "verified",
  differenceKinds: [],
  hierarchyTags: [],
});

const displayUnified = (record: UnifiedCatalogRecordV1): CatalogDisplayItem => ({
  catalogId: record.catalogId,
  filename: record.filename,
  pathLabel: record.relativePath,
  cloudPathAvailable: record.cloudPath !== null,
  verificationStatus: record.verificationStatus,
  differenceKinds: [...record.differenceKinds],
  hierarchyTags: [...record.hierarchyTags],
});

const unavailableError = (): Error => new Error("catalog-unavailable");

const checkedEnumValues = <T extends string>(
  values: readonly T[],
  allowed: readonly T[],
): readonly T[] => {
  const unknownValues: unknown = values;
  if (!Array.isArray(unknownValues) || new Set(unknownValues).size !== unknownValues.length) {
    throw new RangeError("invalid-catalog-filter");
  }
  const decoded = unknownValues.map((value) => {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw new RangeError("invalid-catalog-filter");
    }
    return value as T;
  });
  return decoded;
};

const fixedOptionCompare = <T extends CatalogFilterOption>(left: T, right: T): number => {
  if (left.label < right.label) return -1;
  if (left.label > right.label) return 1;
  return 0;
};

export class CloudCatalogRuntimeService implements CloudCatalogRuntime {
  readonly connection?: CloudCatalogConnectionRuntime;
  readonly hybrid?: HybridCatalogRuntime;
  readonly directoryDiscovery?: CloudDirectoryDiscoveryRuntime;
  readonly directoryBrowser?: CloudDirectoryBrowserRuntime;
  readonly directoryLocator?: CloudDirectoryLocatorRuntime;
  private viewModel: CloudCatalogViewModel = initialViewModel();
  private legacySearch: CatalogSearchService | undefined;
  private unifiedQueryController: AbortController | undefined;
  private unifiedQueryGeneration = 0;
  private recordsById = new Map<string, ActionRecord>();
  private readonly listeners = new Set<() => void>();
  private unsubscribeConnection: (() => void) | undefined;
  private verificationAuthority: CloudVerificationAuthority | null = null;
  private disposed = false;

  constructor(
    private readonly snapshots: CatalogSnapshotPort,
    private readonly actions: CloudCatalogActionPort,
    connection?: CloudCatalogConnectionRuntime,
    hybrid?: HybridCatalogRuntime,
    private readonly unified?: Pick<UnifiedCatalogStorePort, "queryActiveUnified">,
    directoryDiscovery?: CloudDirectoryDiscoveryRuntime,
    directoryBrowser?: CloudDirectoryBrowserRuntime,
    directoryLocator?: CloudDirectoryLocatorRuntime,
  ) {
    this.connection = connection;
    this.hybrid = hybrid;
    this.directoryDiscovery = directoryDiscovery;
    this.directoryBrowser = directoryBrowser;
    this.directoryLocator = directoryLocator;
    this.unsubscribeConnection = connection?.subscribe(() => this.emit());
  }

  setVerificationAuthority(authority: CloudVerificationAuthority | null): void {
    this.assertAvailable();
    const detached = authority === null
      ? null
      : decodeCloudVerificationAuthority(structuredClone(authority));
    this.hybrid?.setVerificationAuthority(
      detached === null
        ? null
        : decodeCloudVerificationAuthority(structuredClone(detached)),
    );
    this.verificationAuthority = detached;
    this.clearSearch();
    this.viewModel = initialViewModel();
    this.emit();
  }

  async initialize(): Promise<void> {
    this.assertAvailable();
    this.clearSearch();
    const controller = new AbortController();
    this.unifiedQueryController = controller;
    const generation = ++this.unifiedQueryGeneration;
    this.viewModel = {
      ...this.viewModel,
      status: "loading",
      messageCode: undefined,
      total: 0,
      items: [],
    };
    this.emit();
    try {
      await this.hybrid?.initialize();
      await this.connection?.initialize();
      const activeUnified = await this.unified?.queryActiveUnified({
        text: "",
        includeCloudMissing: false,
        offset: 0,
        limit: PAGE_SIZE,
      }, this.detachedVerificationAuthority(), controller.signal) ?? null;
      if (this.disposed || controller.signal.aborted || generation !== this.unifiedQueryGeneration) return;
      if (activeUnified !== null) {
        this.initializeUnified(activeUnified);
        return;
      }
      if (this.verificationAuthority !== null) {
        this.clearSearch();
        this.viewModel = initialViewModel();
        this.emit();
        return;
      }
      const active = await this.snapshots.loadActive();
      if (this.disposed) return;
      if (active === null) {
        this.clearSearch();
        this.viewModel = initialViewModel();
        this.emit();
        return;
      }
      this.initializeLegacy(active.descriptor.completedAt, active.descriptor.pdfCount, active.records);
    } catch (error) {
      if (
        this.disposed
        || controller.signal.aborted
        || generation !== this.unifiedQueryGeneration
        || (error instanceof Error && error.name === "AbortError")
      ) return;
      this.clearSearch();
      const corrupt = (
        error instanceof CatalogError && error.code === "snapshot-corrupt"
      ) || (
        error instanceof HybridCatalogError && error.code === "hybrid-snapshot-corrupt"
      );
      this.viewModel = {
        ...initialViewModel(),
        status: corrupt ? "error" : "unavailable",
        messageCode: corrupt ? "snapshot-corrupt" : "catalog-unavailable",
      };
      this.emit();
    }
  }

  snapshot(): CloudCatalogViewModel {
    return {
      ...this.viewModel,
      verificationCounts: { ...this.viewModel.verificationCounts },
      verificationStatuses: [...this.viewModel.verificationStatuses],
      differenceKinds: [...this.viewModel.differenceKinds],
      groups: this.viewModel.groups.map((group) => ({ ...group })),
      hierarchyTags: this.viewModel.hierarchyTags.map((tag) => ({ ...tag })),
      items: this.viewModel.items.map(cloneDisplayItem),
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setQuery(value: string): void {
    if (this.disposed) return;
    this.viewModel = { ...this.viewModel, query: value, page: 0 };
    this.recompute();
  }

  setFolderPrefix(value: string): void {
    if (this.disposed) return;
    const folderPrefix = value.trim().length === 0 ? "" : normalizeCloudAbsolutePath(value);
    this.viewModel = { ...this.viewModel, folderPrefix, page: 0 };
    this.recompute();
  }

  setVerificationStatuses(values: readonly CatalogVerificationStatus[]): void {
    if (this.disposed) return;
    const verificationStatuses = checkedEnumValues(values, STATUS_VALUES);
    this.viewModel = { ...this.viewModel, verificationStatuses, page: 0 };
    this.recompute();
  }

  setDifferenceKinds(values: readonly CatalogDifferenceKind[]): void {
    if (this.disposed) return;
    const differenceKinds = checkedEnumValues(values, DIFFERENCE_VALUES);
    this.viewModel = { ...this.viewModel, differenceKinds, page: 0 };
    this.recompute();
  }

  setTopLevelGroupId(value: string): void {
    if (this.disposed) return;
    const topLevelGroupId = value.trim();
    this.viewModel = { ...this.viewModel, topLevelGroupId, page: 0 };
    this.recompute();
  }

  setHierarchyTag(value: string): void {
    if (this.disposed) return;
    const hierarchyTag = value.normalize("NFC").trim();
    this.viewModel = { ...this.viewModel, hierarchyTag, page: 0 };
    this.recompute();
  }

  setIncludeCloudMissing(value: boolean): void {
    if (this.disposed) return;
    if (typeof value !== "boolean") throw new RangeError("invalid-catalog-filter");
    this.viewModel = { ...this.viewModel, includeCloudMissing: value, page: 0 };
    this.recompute();
  }

  setPage(value: number): void {
    if (this.disposed) return;
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid-catalog-page");
    const maximum = this.viewModel.total === 0
      ? 0
      : Math.floor((this.viewModel.total - 1) / PAGE_SIZE);
    this.viewModel = { ...this.viewModel, page: Math.min(value, maximum) };
    this.recompute();
  }

  async copyFilename(catalogId: string): Promise<void> {
    await this.actions.copyText(this.record(catalogId).filename);
  }

  async copyCloudPath(catalogId: string): Promise<void> {
    const path = this.record(catalogId).cloudPath;
    if (path === null) throw new Error("catalog-record-unavailable");
    await this.actions.copyText(path);
  }

  async openBaidu(): Promise<void> {
    this.assertAvailable();
    await this.actions.openBaidu();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = undefined;
    this.directoryLocator?.dispose();
    this.directoryBrowser?.dispose();
    this.directoryDiscovery?.dispose();
    this.hybrid?.dispose();
    this.connection?.dispose();
    this.listeners.clear();
    this.clearSearch();
    this.viewModel = {
      ...initialViewModel(),
      status: "unavailable",
      messageCode: "catalog-unavailable",
    };
  }

  private initializeLegacy(
    completedAt: number,
    pdfCount: number,
    storedRecords: readonly Readonly<CloudCatalogRecord | { kind: "directory" }>[],
  ): void {
    const files = storedRecords
      .filter((record): record is CloudCatalogRecord => record.kind === "file")
      .map((record) => ({ ...record, isbnCandidates: [...record.isbnCandidates] }));
    this.legacySearch = new CatalogSearchService(files);
    this.unifiedQueryController?.abort();
    this.unifiedQueryController = undefined;
    this.unifiedQueryGeneration += 1;
    this.recordsById = new Map(files.map((record) => [record.fsId, {
      filename: record.filename,
      cloudPath: record.path,
    }]));
    this.viewModel = {
      ...initialViewModel(),
      status: "ready",
      source: "legacy",
      snapshotCompletedAt: completedAt,
      pdfCount,
      verificationCounts: { unverified: 0, verified: pdfCount, difference: 0, cloudMissing: 0 },
    };
    this.recompute();
  }

  private initializeUnified(result: ActiveUnifiedCatalogQueryResult): void {
    const { descriptor, aggregate, page } = result;
    this.legacySearch = undefined;
    this.recordsById = new Map(page.items.map((record) => [record.catalogId, {
      filename: record.filename,
      cloudPath: record.cloudPath,
    }]));
    this.viewModel = {
      ...initialViewModel(),
      status: "ready",
      source: "unified",
      snapshotCompletedAt: descriptor.completedAt,
      pdfCount: descriptor.recordCount,
      verificationCounts: { ...aggregate.verificationCounts },
      groups: aggregate.groups.map((group) => ({ ...group })).sort(fixedOptionCompare),
      hierarchyTags: aggregate.hierarchyTags.map((tag) => ({ ...tag })).sort(fixedOptionCompare),
      total: page.total,
      items: page.items.map(displayUnified),
    };
    this.emit();
  }

  private recompute(): void {
    if (this.viewModel.status !== "ready") {
      this.emit();
      return;
    }
    if (this.viewModel.source === "unified" && this.unified !== undefined) {
      this.recomputeUnified();
      return;
    }
    if (this.viewModel.source === "legacy" && this.legacySearch !== undefined) {
      this.recomputeLegacy();
      return;
    }
    this.emit();
  }

  private recomputeUnified(): void {
    const query: UnifiedCatalogSearchQuery = {
      text: this.viewModel.query,
      ...(this.viewModel.verificationStatuses.length === 0
        ? {}
        : { statuses: this.viewModel.verificationStatuses }),
      ...(this.viewModel.differenceKinds.length === 0
        ? {}
        : { differenceKinds: this.viewModel.differenceKinds }),
      ...(this.viewModel.topLevelGroupId.length === 0
        ? {}
        : { topLevelGroupId: this.viewModel.topLevelGroupId }),
      ...(this.viewModel.hierarchyTag.length === 0
        ? {}
        : { hierarchyTag: this.viewModel.hierarchyTag }),
      includeCloudMissing: this.viewModel.includeCloudMissing,
      offset: this.viewModel.page * PAGE_SIZE,
      limit: PAGE_SIZE,
    };
    this.unifiedQueryController?.abort();
    const controller = new AbortController();
    this.unifiedQueryController = controller;
    const generation = ++this.unifiedQueryGeneration;
    void this.runUnifiedQuery(query, generation, controller);
  }

  private async runUnifiedQuery(
    query: UnifiedCatalogSearchQuery,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      let result = await this.unified!.queryActiveUnified(
        query,
        this.detachedVerificationAuthority(),
        controller.signal,
      );
      if (result === null) throw new HybridCatalogError("hybrid-snapshot-corrupt");
      if (this.disposed || controller.signal.aborted || generation !== this.unifiedQueryGeneration) return;
      const maximum = result.page.total === 0 ? 0 : Math.floor((result.page.total - 1) / PAGE_SIZE);
      if (this.viewModel.page > maximum) {
        this.viewModel = { ...this.viewModel, page: maximum };
        result = await this.unified!.queryActiveUnified({
          ...query,
          offset: maximum * PAGE_SIZE,
        }, this.detachedVerificationAuthority(), controller.signal);
        if (result === null) throw new HybridCatalogError("hybrid-snapshot-corrupt");
      }
      if (this.disposed || controller.signal.aborted || generation !== this.unifiedQueryGeneration) return;
      this.recordsById = new Map(result.page.items.map((record) => [record.catalogId, {
        filename: record.filename,
        cloudPath: record.cloudPath,
      }]));
      this.viewModel = {
        ...this.viewModel,
        snapshotCompletedAt: result.descriptor.completedAt,
        pdfCount: result.descriptor.recordCount,
        verificationCounts: { ...result.aggregate.verificationCounts },
        groups: result.aggregate.groups.map((group) => ({ ...group })).sort(fixedOptionCompare),
        hierarchyTags: result.aggregate.hierarchyTags.map((tag) => ({ ...tag })).sort(fixedOptionCompare),
        total: result.page.total,
        items: result.page.items.map(displayUnified),
      };
      this.emit();
    } catch (error) {
      if (
        this.disposed
        || controller.signal.aborted
        || generation !== this.unifiedQueryGeneration
        || (error instanceof Error && error.name === "AbortError")
      ) return;
      this.recordsById.clear();
      this.viewModel = {
        ...this.viewModel,
        status: "error",
        total: 0,
        items: [],
        messageCode: "snapshot-corrupt",
      };
      this.emit();
    }
  }

  private recomputeLegacy(): void {
    const query = {
      text: this.viewModel.query,
      folderPrefix: this.viewModel.folderPrefix || undefined,
      offset: this.viewModel.page * PAGE_SIZE,
      limit: PAGE_SIZE,
    };
    let result = this.legacySearch!.query(query);
    const maximum = result.total === 0 ? 0 : Math.floor((result.total - 1) / PAGE_SIZE);
    if (this.viewModel.page > maximum) {
      this.viewModel = { ...this.viewModel, page: maximum };
      result = this.legacySearch!.query({ ...query, offset: maximum * PAGE_SIZE });
    }
    this.viewModel = {
      ...this.viewModel,
      total: result.total,
      items: result.items.map(displayLegacy),
    };
    this.emit();
  }

  private record(catalogId: string): ActionRecord {
    this.assertAvailable();
    const record = this.recordsById.get(catalogId);
    if (record === undefined) throw new Error("catalog-record-unavailable");
    return record;
  }

  private clearSearch(): void {
    this.recordsById.clear();
    this.legacySearch = undefined;
    this.unifiedQueryController?.abort();
    this.unifiedQueryController = undefined;
    this.unifiedQueryGeneration += 1;
  }

  private detachedVerificationAuthority(): CloudVerificationAuthority | null {
    return this.verificationAuthority === null
      ? null
      : decodeCloudVerificationAuthority(structuredClone(this.verificationAuthority));
  }

  private assertAvailable(): void {
    if (this.disposed) throw unavailableError();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
