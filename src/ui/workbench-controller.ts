import { classifyRecords, suggestFolderRules, type ClassificationResult, type ClassificationService } from "../classification/classification-service";
import type { Clock, QuickCapturePort, VaultReadPort, WorkspacePort } from "../core/ports";
import type { AiAction, AiClientPort, AiNotePayload } from "../core/ports";
import { AiEnhancementService, type AiResult } from "../ai/ai-enhancement-service";
import { normalizeAiEndpoint, normalizeAiModel, normalizeAiSecretId } from "../ai/ai-config";
import { normalizeVaultPath } from "../core/path-policy";
import type { DocumentRecord } from "../core/types";
import type { IncrementalIndexQueue } from "../indexing/incremental-index-queue";
import type { IndexService } from "../indexing/index-service";
import type { FocusedMap, MapFilter, MapSearchResult, MapService } from "../map/map-service";
import { buildConfirmedRelationCandidates, type OperationRationale, type SuggestedOperation, type SuggestionService } from "../suggestions/suggestion-service";
import type { ChangePlanService, ConfirmedPlan } from "../plans/change-plan-service";
import type { PluginDataStore } from "../storage/plugin-data-store";
import type {
  CloudVerificationSettings,
  FolderRule,
  FolderRuleProposal,
  PluginSettings,
} from "../storage/plugin-data";
import type { WorkbenchLocale } from "../i18n/workbench-i18n";
import type { TodayService } from "../today/today-service";
import type { ExecutionResult, TransactionService } from "../transactions/transaction-service";
import type { OperationJournal } from "../transactions/operation-journal";
import type { UndoService } from "../transactions/undo-service";
import type { ChangePreviewPresenter } from "./change-preview-modal";
import { exportJournalJson, type HistoryConfirmationPresenter } from "./history-tab";
import type { TodayFilter } from "./today-pane";
import type { StartSection, WorkbenchProgress, WorkbenchViewModel } from "./workbench-view";
import {
  defaultWorkbenchRoute,
  routeForTab,
  sameWorkbenchRoute,
  type WorkbenchRoute,
  type WorkbenchTab,
} from "./workbench-route";
import type { AiPayloadPreviewPresenter } from "./ai-payload-preview-modal";
import { effectiveSettings, type RuntimeSafetyPolicy } from "../runtime/safety-policy";
import { catalogPageContains, type CloudCatalogRuntime } from "../catalog/cloud-catalog-runtime";
import type { CloudCatalogConnectionViewModel } from "../catalog/cloud-catalog-runtime";
import { normalizeCatalogScanRoot } from "../catalog/catalog-path";
import {
  buildLocalCloudDirectoryCandidates,
  type CloudDirectoryCandidateRuntime,
} from "../catalog/cloud-directory-candidates";
import { CatalogError } from "../catalog/catalog-types";
import type { CatalogScanConfirmationPresenter } from "./catalog-scan-confirmation-modal";
import {
  refreshCatalogProjection,
  type CatalogInitializationErrorCode,
} from "../runtime/catalog-runtime-lifecycle";
import type { HybridCatalogViewModel } from "../catalog/hybrid-catalog-runtime";
import type { CatalogTxtImportConfirmationPresenter } from "./catalog-txt-import-confirmation-modal";
import type { CatalogLargeScanConfirmationPresenter } from "./catalog-large-scan-confirmation-modal";
import type { CloudDirectoryPickerPresenter } from "./cloud-directory-picker";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../catalog/hybrid-catalog-types";
import { HybridCatalogError, LARGE_CATALOG_RUN_BUDGET } from "../catalog/hybrid-catalog-types";
import {
  verificationConnectionSemanticKey,
  type VerificationConnectionSemanticKey,
} from "./verification-connection-semantics";
import {
  EMPTY_RECENT_CLOUD_DIRECTORIES,
  rememberRecentCloudDirectory,
} from "../storage/recent-cloud-directories";
import {
  cloudVerificationScopesEqual,
  deriveCloudVerificationScope,
  type CloudVerificationAuthority,
  type CloudVerificationRootHasher,
  type CloudVerificationScope,
  type LegacyVerificationAllowlist,
} from "../catalog/cloud-verification-scope";
import type { LegacyVerificationAdoptionV1 } from "../storage/legacy-verification-adoption";
import { repairVerificationBatchTombstones } from "../storage/verification-batch-tombstones";
import {
  deriveLibraryWorkflowState,
  type PendingCatalogTxtDraft,
} from "./library-workflow-state";
import {
  validateVerificationLaunchRequest,
  type VerificationLaunchGroup,
  type VerificationLaunchRequest,
} from "../catalog/verification-launch-request";
import type {
  FolderSelectionHostActions,
  FolderSelectionRenderState,
  FolderSelectionSessionDriver,
  FolderSelectionSessionFactoryPort,
} from "./folder-selection-host";

export interface AiSettingsInput {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly secretId: string;
}

export interface WorkbenchAiDependencies {
  readonly preview: AiPayloadPreviewPresenter;
  readonly getSecret: (id: string) => string | null;
  readonly createClient: (endpoint: string, model: string, secret: string) => AiClientPort;
  readonly delay: (milliseconds: number) => Promise<void>;
}

export interface WorkbenchProjectionScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export type CloudDirectorySelectionValidator = typeof import(
  "../catalog/cloud-directory-selection"
).validateCloudDirectorySelection;

export interface WorkbenchDependencies {
  readonly policy: RuntimeSafetyPolicy;
  readonly reads: VaultReadPort;
  readonly index: IndexService;
  readonly indexQueue: IncrementalIndexQueue;
  readonly classification: ClassificationService;
  readonly today: TodayService;
  readonly map: MapService;
  readonly suggestions: SuggestionService;
  readonly changePlans: ChangePlanService;
  readonly changePreview: ChangePreviewPresenter;
  readonly store: PluginDataStore;
  readonly workspace: WorkspacePort;
  readonly quickCapture: QuickCapturePort;
  readonly transactions: Pick<TransactionService, "execute" | "organizationWritesBlocked">;
  readonly journal: Pick<OperationJournal, "list" | "clearHistory">;
  readonly undo: Pick<UndoService, "preview">;
  readonly historyConfirmation: HistoryConfirmationPresenter;
  readonly clock: Clock;
  readonly ai?: WorkbenchAiDependencies;
  readonly projectionScheduler?: WorkbenchProjectionScheduler;
  readonly catalog: CloudCatalogRuntime;
  readonly cloudVerificationRootHasher: CloudVerificationRootHasher;
  readonly catalogConfirmation: CatalogScanConfirmationPresenter;
  readonly catalogTxtImportConfirmation?: CatalogTxtImportConfirmationPresenter;
  readonly catalogLargeScanConfirmation?: CatalogLargeScanConfirmationPresenter;
  readonly catalogDirectoryPicker?: CloudDirectoryPickerPresenter;
  readonly catalogDirectorySelectionValidator?: CloudDirectorySelectionValidator;
  readonly folderSelectionSessionFactory?: FolderSelectionSessionFactoryPort;
}

export type MapCenter = Readonly<{ kind: "document" | "topic"; id: string }>;

export type CatalogAuthorizationIntent = "repair-same-account" | "replace-identity";

type CloudAuthorityOperation =
  | "verification-launch"
  | "catalog-scan-launch"
  | "library-binding"
  | "authorization-repair"
  | "identity-change";

type CatalogAuthorizationAttempt = Readonly<{
  intent: CatalogAuthorizationIntent;
  preparedGeneration: number;
}>;

type TaskActionPermit = Readonly<{
  revision: number;
  nonce: symbol;
}>;

type FolderSelectionOwner = {
  readonly nonce: symbol;
  readonly purpose: CloudDirectoryPickerPurpose;
  readonly driver: FolderSelectionSessionDriver;
  readonly sourceImportSha256: string;
  unsubscribe: () => void;
  usePending: boolean;
  commitStarted: boolean;
  closeRequested: boolean;
  driverDisposed: boolean;
};

interface LegacyAdoptionFailureToken {
  readonly selectedEffectiveRootSha256: string;
  readonly activeSourceImportSha256: string;
  readonly legacyArtifactSetSha256: string;
}

type FolderBindingBaseline = Readonly<{
  activeSourceImportSha256: string;
  legacyArtifactSetSha256: string | null;
  groupsKey: string;
  settingsKey: string;
  batchKey: string;
}>;

const emptyMap = (): FocusedMap => ({ nodes: [], edges: [], selected: null, truncated: false });
const idleProgress = (label: string): WorkbenchProgress => ({ status: "idle", completed: 0, label });
const clone = <T>(value: T): T => structuredClone(value);
const isAbortError = (error: unknown): boolean => error instanceof DOMException
  ? error.name === "AbortError"
  : error instanceof Error && error.name === "AbortError";
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const requireCloudDirectorySelectionValidator = (
  validator: CloudDirectorySelectionValidator | undefined,
): CloudDirectorySelectionValidator => {
  if (validator === undefined) throw new Error("catalog-unavailable");
  return validator;
};
const RECOVERY_LOCK_MESSAGE = "Recovery required; organization writes are locked";
const PROJECTION_REFRESH_ERROR = "Workbench projection refresh failed";
const PROJECTION_QUIET_DELAY_MS = 50;
const PROJECTION_MAX_WAIT_MS = 500;
const assertVerificationLaunchBuildAvailable = (): void => {
  if (
    typeof __KNOWLEDGE_WORKBENCH_BUILD_MODE__ !== "undefined"
    && __KNOWLEDGE_WORKBENCH_BUILD_MODE__ === "read-only-acceptance"
  ) throw new Error("catalog-unavailable");
};
const verificationPickerPurpose = (
  groups: readonly Readonly<{
    groupKey: string;
    rootRelativePath: string;
    label: string;
  }>[],
): Extract<CloudDirectoryPickerPurpose, { kind: "verification" }> => ({
  kind: "verification",
  groups: groups
    .filter((group) => group.groupKey !== "txt-root-items")
    .map((group) => ({
      groupKey: group.groupKey,
      rootRelativePath: group.rootRelativePath,
      label: group.label,
    })),
});
const folderSelectionPurposeKey = (purpose: CloudDirectoryPickerPurpose): string => (
  JSON.stringify(purpose)
);
const isSelectedCategoryRoot = (
  cloudRoot: string,
  groups: readonly Readonly<{
    groupKey: string;
    rootRelativePath: string;
  }>[],
): boolean => {
  const rootLeaf = cloudRoot.slice(cloudRoot.lastIndexOf("/") + 1);
  return groups.some((group) => (
    group.groupKey !== "txt-root-items"
    && group.rootRelativePath.normalize("NFC") === rootLeaf
  ));
};
const defaultProjectionScheduler: WorkbenchProjectionScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: (handle) => window.clearTimeout(handle as number),
};
interface ProjectionTimer {
  readonly handle: unknown;
  readonly token: number;
}
type ProjectionRefreshResult = "failed" | "unchanged" | "changed";
const sourcePathOf = (suggestion: SuggestedOperation): string =>
  "sourcePath" in suggestion.operation ? suggestion.operation.sourcePath : suggestion.operation.path;
const actionLabel = (suggestion: SuggestedOperation): string => {
  if (suggestion.operation.kind === "move") return "Preview move";
  if (suggestion.operation.kind === "rename") return "Preview rename";
  if (suggestion.operation.kind === "set-owned-field") return "Review property";
  return "Review related link";
};
const aiFallback = (reason: Parameters<typeof asAiFallback>[0]): AiResult<string> => asAiFallback(reason);
const asAiFallback = (reason: import("../ai/ai-enhancement-service").AiFallbackReason) => ({ kind: "local-fallback" as const, reason });
const hasExactArrayShape = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1
    && keys.includes("length")
    && keys.every((key) => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)))
    && Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
    });
};
const decodeStrictStringArray = (value: unknown, maximum?: number): readonly string[] | null => {
  try {
    if (!hasExactArrayShape(value) || (maximum !== undefined && value.length > maximum)) return null;
    const detached: unknown = structuredClone(value);
    if (!hasExactArrayShape(detached) || !detached.every((item) => typeof item === "string")) return null;
    return [...detached] as string[];
  } catch {
    return null;
  }
};
const isCanonicalSafeMarkdownPath = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || normalizeVaultPath(value) !== value || value.startsWith("/")) return false;
  const segments = value.split("/");
  return value.toLocaleLowerCase("en-US").endsWith(".md")
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !/\p{Cc}/u.test(segment));
};
const rawAiActionKey = (action: AiAction, paths: unknown, targetSuggestionId: unknown): string | null => {
  const decoded = decodeStrictStringArray(paths, 20);
  if (decoded === null || (targetSuggestionId !== undefined && typeof targetSuggestionId !== "string")) return null;
  return JSON.stringify([action, decoded, targetSuggestionId ?? null]);
};
const stripInitialFrontmatter = (content: string): string => content.replace(/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/u, "");
const suggestionPath = (suggestion: SuggestedOperation): string => normalizeVaultPath(sourcePathOf(suggestion));
const verificationBatchAdvanced = (
  before: HybridCatalogViewModel | undefined,
  after: HybridCatalogViewModel | undefined,
): boolean => {
  const batch = after?.batch;
  if (after === undefined || batch === undefined) return false;
  const eligible = after.status === "scanning"
    || ((after.status === "paused" || after.status === "partial") && batch.resumeAvailable);
  if (!eligible) return false;
  const prior = before?.batch;
  return prior === undefined
    || batch.batchId !== prior.batchId
    || batch.runOrdinal > prior.runOrdinal;
};

const hybridWithoutMessage = (value: HybridCatalogViewModel): HybridCatalogViewModel => {
  const { messageCode: _messageCode, ...current } = value;
  return current;
};

const verificationValidationCode = (
  error: unknown,
): NonNullable<WorkbenchViewModel["verificationActionMessageCode"]> | undefined => {
  if (error instanceof CatalogError && error.code === "invalid-scan-root") {
    return "invalid-scan-root";
  }
  if (error instanceof Error && error.message === "invalid-large-catalog-root") {
    return "invalid-large-catalog-root";
  }
  return undefined;
};

const legacyAllowlistFor = (
  adoption: LegacyVerificationAdoptionV1,
  scope: CloudVerificationScope,
): LegacyVerificationAllowlist | null => {
  if (
    adoption.state !== "adopted"
    || adoption.verificationGeneration !== scope.generation
    || adoption.sourceImportSha256 !== scope.sourceImportSha256
    || adoption.cloudRootSha256 !== scope.cloudRootSha256
  ) return null;
  return {
    candidate: { ...adoption.candidate },
    overlays: adoption.overlays.map((overlay) => ({ ...overlay })),
    unified: adoption.unified === null ? null : { ...adoption.unified },
    resumableBatch: adoption.resumableBatch === null
      ? null
      : { ...adoption.resumableBatch },
  };
};

const scopedAuthorityForSettings = (
  settings: PluginSettings,
  hashRoot: CloudVerificationRootHasher,
): Extract<CloudVerificationAuthority, Readonly<{ kind: "scoped" }>> | null => {
  const binding = settings.boundCloudLibrary;
  if (
    binding === null
    || settings.cloudVerificationGeneration < 1
    || binding.verificationGeneration !== settings.cloudVerificationGeneration
  ) return null;
  const scope = deriveCloudVerificationScope(binding, hashRoot);
  if (scope === null) return null;
  if (
    settings.legacyVerificationAdoption.state === "pending"
    || settings.legacyVerificationAdoption.state === "invalid"
  ) return null;
  const legacyAllowlist = legacyAllowlistFor(settings.legacyVerificationAdoption, scope);
  return {
    kind: "scoped",
    scope: { ...scope },
    legacyAllowlist,
  };
};

const verificationAuthoritySettingsKey = (settings: PluginSettings): string => JSON.stringify({
  boundCloudLibrary: settings.boundCloudLibrary,
  cloudVerificationGeneration: settings.cloudVerificationGeneration,
  legacyVerificationAdoption: settings.legacyVerificationAdoption,
});

const cloudVerificationSettingsFrom = (settings: PluginSettings): CloudVerificationSettings => ({
  boundCloudLibrary: settings.boundCloudLibrary === null
    ? null
    : clone(settings.boundCloudLibrary),
  cloudVerificationGeneration: settings.cloudVerificationGeneration,
  verificationBatchTombstones: clone(settings.verificationBatchTombstones),
  legacyVerificationAdoption: clone(settings.legacyVerificationAdoption),
});

const cloudVerificationSettingsKey = (settings: PluginSettings): string => JSON.stringify(
  cloudVerificationSettingsFrom(settings),
);

const sameCloudVerificationSettings = (
  left: CloudVerificationSettings,
  right: CloudVerificationSettings,
): boolean => left.cloudVerificationGeneration === right.cloudVerificationGeneration
  && JSON.stringify(left.boundCloudLibrary) === JSON.stringify(right.boundCloudLibrary)
  && JSON.stringify(left.verificationBatchTombstones)
    === JSON.stringify(right.verificationBatchTombstones)
  && JSON.stringify(left.legacyVerificationAdoption)
    === JSON.stringify(right.legacyVerificationAdoption);

const checkedNextVerificationGeneration = (current: number): number => {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("cloud-verification-generation-overflow");
  }
  return current + 1;
};

const sameLegacyAdoptionFailureToken = (
  left: LegacyAdoptionFailureToken | null,
  right: LegacyAdoptionFailureToken | null,
): boolean => left === null || right === null
  ? left === right
  : left.selectedEffectiveRootSha256 === right.selectedEffectiveRootSha256
    && left.activeSourceImportSha256 === right.activeSourceImportSha256
    && left.legacyArtifactSetSha256 === right.legacyArtifactSetSha256;

const deterministicLegacyAdoptionConflict = (error: unknown): boolean => (
  error instanceof HybridCatalogError
  && [
    "hybrid-cloud-root-mismatch",
    "hybrid-snapshot-corrupt",
    "hybrid-batch-invalid",
  ].includes(error.code)
);

const bindingCasConflict = (error: unknown): boolean => error instanceof RangeError
  && error.message === "Cloud verification authority changed before the transaction committed";

const folderSelectionStale = (): Error => new Error("folder-selection-stale");

export class WorkbenchController {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeIndex: () => void;
  private readonly unsubscribeCatalog: () => void;
  private readonly unsubscribeCatalogConnection: () => void;
  private readonly unsubscribeHybridCatalog: () => void;
  private readonly projectionScheduler: WorkbenchProjectionScheduler;
  private model: WorkbenchViewModel;
  private records: readonly DocumentRecord[] = [];
  private classifications: Readonly<Record<string, ClassificationResult>> = {};
  private suggestions: readonly SuggestedOperation[] = [];
  private readonly confirmedSuggestionIds = new Set<string>();
  private transactionBusy = false;
  private scanController: AbortController | null = null;
  private scanPromise: Promise<void> | null = null;
  private mapController: AbortController | null = null;
  private mapGeneration = 0;
  private mapProjectionRevision = 0;
  private center: MapCenter | null = null;
  private disposed = false;
  private lifecycleEpoch = 0;
  private exclusionGeneration = 0;
  private aiConfigurationGeneration = 0;
  private aiSelectionGeneration = 0;
  #sessionAiSecret: string | null = null;
  private aiFlight: Readonly<{ rawKey: string; promise: Promise<AiResult<string>> }> | null = null;
  private aiOverrideSuggestionId: string | null = null;
  private aiOriginalRationale: OperationRationale | null = null;
  private lockedVerificationRoot: string | null = null;
  private dismissedVerificationHybridMessageCode: "hybrid-cloud-root-mismatch" | null = null;
  private verificationConnectionKey: VerificationConnectionSemanticKey;
  private projectionRevision = 1;
  private projectedRevision = 0;
  private projectionDirtySince: number | null = null;
  private projectionTimerToken = 0;
  private quietProjectionTimer: ProjectionTimer | null = null;
  private maxProjectionTimer: ProjectionTimer | null = null;
  private readonly cloudDirectoryCandidates: CloudDirectoryCandidateRuntime;
  private pendingCatalogTxt: PendingCatalogTxtDraft | null = null;
  private taskActionNonce: symbol | null = null;
  private taskSemanticKey = "";
  private cloudAuthorityOperation: Readonly<{
    kind: CloudAuthorityOperation;
    nonce: symbol;
  }> | null = null;
  private catalogAuthorizationAttempt: CatalogAuthorizationAttempt | null = null;
  private folderSelectionOwner: FolderSelectionOwner | null = null;
  private folderSelectionRevision = 0;
  private legacyAdoptionFailureToken: LegacyAdoptionFailureToken | null = null;

  constructor(private readonly dependencies: WorkbenchDependencies) {
    this.cloudDirectoryCandidates = Object.freeze({
      snapshot: () => buildLocalCloudDirectoryCandidates({
        recent: dependencies.store.settings().recentCloudDirectories,
        cached: dependencies.catalog.directoryDiscovery?.snapshotCached() ?? [],
        groups: dependencies.catalog.hybrid?.snapshot().active?.groups ?? [],
      }),
      remember: async (path: string) => {
        const usedAt = dependencies.clock.now();
        await dependencies.store.updateSettings((settings) => ({
          ...settings,
          recentCloudDirectories: rememberRecentCloudDirectory(
            settings.recentCloudDirectories,
            path,
            usedAt,
          ),
        }));
      },
      clearRecent: async () => {
        await dependencies.store.updateSettings((settings) => ({
          ...settings,
          recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        }));
      },
    });
    this.projectionScheduler = dependencies.projectionScheduler ?? defaultProjectionScheduler;
    this.verificationConnectionKey = verificationConnectionSemanticKey(
      dependencies.catalog.connection?.snapshot(),
    );
    const initialCatalogConnection = dependencies.catalog.connection?.snapshot();
    const initialHybridCatalog = dependencies.catalog.hybrid?.snapshot();
    const initialSettings = dependencies.store.settings();
    const initialWorkflow = deriveLibraryWorkflowState({
      connection: initialCatalogConnection,
      hybrid: initialHybridCatalog,
      boundCloudLibrary: initialSettings.boundCloudLibrary,
      cloudVerificationGeneration: initialSettings.cloudVerificationGeneration,
      verificationBatchTombstones: initialSettings.verificationBatchTombstones,
      legacyVerificationAdoption: initialSettings.legacyVerificationAdoption,
      pendingCatalogTxt: null,
      cloudVerificationRootHasher: dependencies.cloudVerificationRootHasher,
      capabilityAvailable: initialHybridCatalog !== undefined
        && initialHybridCatalog.status !== "unavailable",
    });
    this.model = {
      locale: effectiveSettings(dependencies.policy, dependencies.store.settings()).locale,
      status: "ready",
      route: defaultWorkbenchRoute(),
      startSection: "overview",
      catalog: dependencies.catalog.snapshot(),
      ...(initialCatalogConnection === undefined ? {} : {
        catalogConnection: clone(initialCatalogConnection),
      }),
      ...(initialHybridCatalog === undefined ? {} : {
        hybridCatalog: clone(initialHybridCatalog),
      }),
      pendingCatalogTxt: null,
      taskActionPending: false,
      taskActionRevision: 1,
      workflow: initialWorkflow,
      verificationRoot: "",
      verificationRootLocked: false,
      selectedVerificationGroupKeys: [],
      selectedCatalogId: null,
      catalogFiltersExpanded: false,
      todayFilter: "all",
      today: { newItems: [], continueItems: [], nextItems: [] },
      suggestions: [],
      history: { entries: [] },
      map: emptyMap(),
      mapFilter: "all",
      searchQuery: "",
      searchResults: [],
      scanProgress: idleProgress("Index"),
      mapProgress: idleProgress("Map"),
    };
    this.taskSemanticKey = this.taskProjectionSemanticKey(
      initialSettings,
      initialCatalogConnection,
      initialHybridCatalog,
      initialWorkflow.primaryAction,
    );
    this.projectionDirtySince = this.projectionNow();
    this.unsubscribeIndex = dependencies.index.subscribe(() => {
      if (this.disposed) return;
      this.markProjectionDirty();
    });
    this.unsubscribeCatalog = dependencies.catalog.subscribe(() => this.refreshCatalogViewState());
    this.unsubscribeCatalogConnection = dependencies.catalog.connection?.subscribe(
      () => {
        const nextKey = verificationConnectionSemanticKey(dependencies.catalog.connection?.snapshot());
        if (nextKey !== this.verificationConnectionKey) {
          this.dismissedVerificationHybridMessageCode = null;
          this.verificationConnectionKey = nextKey;
        }
        this.refreshCatalogViewState();
      },
    ) ?? (() => undefined);
    this.unsubscribeHybridCatalog = dependencies.catalog.hybrid?.subscribe(
      () => this.refreshCatalogViewState(),
    ) ?? (() => undefined);
  }

  snapshot(): WorkbenchViewModel {
    return clone(this.model);
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    this.scheduleProjection();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.center === null) this.cancelProjectionSchedule();
    };
  }

  /**
   * Performs the local authority bootstrap before the catalog runtime may initialize
   * its connection or issue any query.
   */
  async initializeCatalog(): Promise<void> {
    if (this.disposed) return;
    const hybrid = this.dependencies.catalog.hybrid;
    let settings = this.dependencies.store.settings();
    let authority: CloudVerificationAuthority | null = scopedAuthorityForSettings(
      settings,
      this.dependencies.cloudVerificationRootHasher,
    );
    if (
      authority === null
      && settings.boundCloudLibrary === null
      && settings.cloudVerificationGeneration === 0
      && settings.legacyVerificationAdoption.state === "pending"
      && hybrid !== undefined
    ) {
      const expectedSettingsKey = verificationAuthoritySettingsKey(settings);
      authority = await hybrid.prepareLegacyLocalVerificationAuthority();
      if (this.disposed) return;
      settings = this.dependencies.store.settings();
      if (verificationAuthoritySettingsKey(settings) !== expectedSettingsKey) {
        authority = scopedAuthorityForSettings(
          settings,
          this.dependencies.cloudVerificationRootHasher,
        );
        if (
          authority === null
          && settings.boundCloudLibrary === null
          && settings.cloudVerificationGeneration === 0
          && settings.legacyVerificationAdoption.state === "pending"
        ) {
          throw new Error("catalog-unavailable");
        }
      }
    }
    this.installVerificationAuthority(authority);
    if (!this.disposed) await this.dependencies.catalog.initialize();
  }

  selectRoute(route: WorkbenchRoute): void {
    if (this.disposed || sameWorkbenchRoute(route, this.model.route)) return;
    const leavingFolderSelection = this.model.route.tab === "task"
      && this.model.route.page === "folder-selection";
    if (leavingFolderSelection) this.disposeFolderSelection(true, false);
    this.model = { ...this.model, route: clone(route) };
    this.emit();
  }

  selectTab(tab: WorkbenchTab): void {
    this.selectRoute(routeForTab(tab));
  }

  selectStartSection(section: StartSection): void {
    if (this.disposed || section === this.model.startSection) return;
    this.model = { ...this.model, startSection: section };
    this.emit();
  }

  setVerificationRoot(value: string): void {
    if (
      this.disposed
      || this.lockedVerificationRoot !== null
      || (
        value === this.model.verificationRoot
        && this.model.verificationDirectorySelection === undefined
      )
    ) return;
    const runtimeMessageCode = this.dependencies.catalog.hybrid?.snapshot().messageCode;
    if (runtimeMessageCode === "hybrid-cloud-root-mismatch") {
      this.dismissedVerificationHybridMessageCode = runtimeMessageCode;
    }
    const {
      verificationActionMessageCode: _verificationActionMessageCode,
      verificationDirectorySelection: _verificationDirectorySelection,
      hybridCatalog,
      ...current
    } = this.model;
    const visibleHybrid = hybridCatalog?.messageCode === this.dismissedVerificationHybridMessageCode
      ? hybridWithoutMessage(hybridCatalog)
      : hybridCatalog;
    this.model = {
      ...current,
      ...(visibleHybrid === undefined ? {} : { hybridCatalog: visibleHybrid }),
      verificationRoot: value,
    };
    this.emit();
  }

  openVerificationFolderSelection(): void {
    if (this.disposed || this.lockedVerificationRoot !== null) return;
    if (this.folderSelectionOwner?.usePending === true) return;
    const factory = this.dependencies.folderSelectionSessionFactory;
    const active = this.dependencies.catalog.hybrid?.snapshot().active;
    if (factory?.available !== true || active === undefined) {
      throw new Error("catalog-unavailable");
    }
    const purpose = verificationPickerPurpose(active.groups);
    const currentSelectedPath = this.model.verificationDirectorySelection?.selectedPath;
    const rawInitialPath = currentSelectedPath ?? this.model.verificationRoot.trim();
    const initialPath = rawInitialPath.length === 0
      ? null
      : this.validateCatalogScanRoot(rawInitialPath);
    this.disposeFolderSelection(true, false);
    let owner: FolderSelectionOwner | null = null;
    try {
      const driver = factory.create({
        purpose: clone(purpose),
        initialPath,
      });
      owner = {
        nonce: Symbol("folder-selection"),
        purpose: clone(purpose),
        driver,
        sourceImportSha256: active.sourceImportSha256,
        unsubscribe: () => undefined,
        usePending: false,
        commitStarted: false,
        closeRequested: false,
        driverDisposed: false,
      };
      owner.unsubscribe = driver.subscribe(() => this.onFolderSelectionEmission(owner!));
      const state = clone(driver.snapshot());
      if (state.phase === "closed") throw new Error("folder-selection-open-closed");
      const folderSelection = this.folderSelectionRenderState(state);
      this.folderSelectionOwner = owner;
      this.model = {
        ...this.model,
        route: { tab: "task", page: "folder-selection" },
        folderSelection,
      };
      this.emit();
    } catch (error) {
      if (owner !== null) this.destroyFolderSelectionOwner(owner);
      this.removeFolderSelectionModel();
      this.emit();
      throw error;
    }
  }

  closeFolderSelection(): void {
    const onFolderSelectionRoute = this.model.route.tab === "task"
      && this.model.route.page === "folder-selection";
    if (this.folderSelectionOwner === null && !onFolderSelectionRoute) return;
    this.disposeFolderSelection(true, false);
    if (!this.disposed && onFolderSelectionRoute) {
      this.model = { ...this.model, route: { tab: "task", page: "overview" } };
    }
    if (!this.disposed) this.emit();
  }

  folderSelectionActions(expectedRevision: number): FolderSelectionHostActions {
    const current = (): FolderSelectionOwner | null => this.currentFolderSelection(
      expectedRevision,
    );
    const invoke = (action: (driver: FolderSelectionSessionDriver) => void): void => {
      const owner = current();
      if (owner !== null) action(owner.driver);
    };
    const invokeAsync = async (
      action: (driver: FolderSelectionSessionDriver) => Promise<void>,
    ): Promise<void> => {
      const owner = current();
      if (owner !== null) await action(owner.driver);
    };
    const actions: FolderSelectionHostActions = {
      onBack: () => {
        if (current() !== null) this.closeFolderSelection();
      },
      onQuery: (value) => invoke((driver) => driver.setQuery(value)),
      onToggleSource: (source) => invoke((driver) => driver.toggleSource(source)),
      onSelectCandidate: (path) => invoke((driver) => driver.selectCandidate(path)),
      onUse: () => this.useFolderSelection(expectedRevision),
      onBrowseOther: () => invoke((driver) => driver.requestLookupConsent()),
      onConfirmLookup: () => invokeAsync((driver) => driver.confirmLookup()),
      onRevealRoot: () => invoke((driver) => driver.revealRootBrowser()),
      onConfirmRoot: () => invoke((driver) => driver.confirmRootBrowser()),
      onBrowserAction: {
        onNavigate: (path) => invoke((driver) => driver.enterBrowserPath(path)),
        onHighlight: (path) => invoke((driver) => driver.highlightBrowserPath(path)),
        onSelectCurrent: () => invokeAsync((driver) => driver.selectCurrentDirectory()),
        onSelectHighlighted: () => invokeAsync((driver) => driver.selectHighlightedDirectory()),
        onSelectCategory: (path) => invokeAsync((driver) => driver.selectCategory(path)),
        onContinue: () => invokeAsync((driver) => driver.continueBrowser()),
        onRetry: () => invokeAsync((driver) => driver.retryBrowser()),
        onCancel: () => invoke((driver) => driver.cancelBrowser()),
      },
    };
    return Object.freeze(actions);
  }

  applyCatalogRootSelection(selection: CloudDirectorySelection): void {
    if (this.disposed || this.lockedVerificationRoot !== null) return;
    const activeGroups = this.dependencies.catalog.hybrid?.snapshot().active?.groups;
    if (activeGroups === undefined) throw new Error("catalog-unavailable");
    const validateSelection = requireCloudDirectorySelectionValidator(
      this.dependencies.catalogDirectorySelectionValidator,
    );
    let validated: CloudDirectorySelection;
    try {
      validated = validateSelection(
        selection,
        verificationPickerPurpose(activeGroups),
      );
    } catch {
      throw new RangeError("cloud-directory-selection-invalid");
    }
    const availableKeys = new Set(activeGroups.map((group) => group.groupKey));
    const selectedVerificationGroupKeys = validated.kind === "category"
      ? [validated.groupKey]
      : this.model.selectedVerificationGroupKeys.filter((groupKey) => availableKeys.has(groupKey));
    const {
      verificationActionMessageCode: _verificationActionMessageCode,
      ...current
    } = this.model;
    this.model = {
      ...current,
      verificationRoot: validated.effectiveRoot,
      verificationDirectorySelection: clone(validated),
      selectedVerificationGroupKeys,
    };
    this.emit();
  }

  toggleVerificationGroup(groupKey: string): void {
    if (this.disposed) return;
    const available = this.model.hybridCatalog?.active?.groups
      .some((group) => group.groupKey === groupKey) === true;
    if (!available) return;
    const selected = new Set(this.model.selectedVerificationGroupKeys);
    if (selected.has(groupKey)) selected.delete(groupKey);
    else {
      if (selected.size >= LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups) return;
      selected.add(groupKey);
    }
    if (this.model.verificationDirectorySelection?.kind === "category") {
      const {
        verificationDirectorySelection: _verificationDirectorySelection,
        ...current
      } = this.model;
      this.model = { ...current, selectedVerificationGroupKeys: [...selected] };
    } else {
      this.model = { ...this.model, selectedVerificationGroupKeys: [...selected] };
    }
    this.emit();
  }

  async startSelectedVerification(): Promise<void> {
    if (this.disposed) return;
    assertVerificationLaunchBuildAvailable();
    await this.runVerifiedLaunch({
      kind: "start",
      cloudRoot: this.model.verificationRoot,
      groupKeys: [...this.model.selectedVerificationGroupKeys],
      ...(this.model.verificationDirectorySelection === undefined
        ? {}
        : { directorySelection: this.model.verificationDirectorySelection }),
      confirm: true,
    });
  }

  async resumeSelectedVerification(): Promise<void> {
    if (this.disposed) return;
    assertVerificationLaunchBuildAvailable();
    const batch = this.dependencies.catalog.hybrid?.snapshot().batch;
    if (batch === undefined) throw new HybridCatalogError("hybrid-batch-unavailable");
    const boundRoot = this.dependencies.store.settings().boundCloudLibrary?.path;
    await this.runVerifiedLaunch({
      kind: "resume",
      cloudRoot: this.lockedVerificationRoot ?? boundRoot ?? this.model.verificationRoot,
      groupKeys: [...batch.selectedGroupKeys],
      confirm: true,
    });
  }

  cancelSelectedVerification(): void {
    this.cancelLargeCatalogVerification();
  }

  setTodayFilter(filter: TodayFilter): void {
    if (this.disposed || filter === this.model.todayFilter) return;
    this.model = { ...this.model, todayFilter: filter };
    this.emit();
  }

  setMapFilter(filter: MapFilter): Promise<void> {
    if (this.disposed || filter === this.model.mapFilter) return Promise.resolve();
    this.model = { ...this.model, mapFilter: filter };
    if (this.center === null) {
      this.emit();
      return Promise.resolve();
    }
    return this.selectCenter(this.center);
  }

  startInitialScan(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.scanPromise !== null) return this.scanPromise;
    const controller = new AbortController();
    const lifecycleEpoch = this.lifecycleEpoch;
    const hadActiveIndex = this.dependencies.store.hasActiveIndex();
    this.scanController = controller;
    this.model = {
      ...this.model,
      scanProgress: { status: "running", completed: 0, label: "Index" },
    };
    const operation = this.runInitialScan(controller, hadActiveIndex, lifecycleEpoch);
    this.scanPromise = operation;
    this.emit();
    return operation;
  }

  cancelScan(): void {
    this.scanController?.abort();
  }

  selectCenter(center: MapCenter): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.ensureProjectionCurrent() === "failed") {
      this.emit();
      return Promise.resolve();
    }
    this.invalidateAiSelection();
    this.center = clone(center);
    return this.startMapForCurrentCenter();
  }

  cancelMap(): void {
    this.mapController?.abort();
  }

  searchMap(query: string): void {
    if (this.disposed) return;
    if (this.ensureProjectionCurrent() === "failed") {
      this.emit();
      return;
    }
    const results = this.dependencies.map.search(this.records, query);
    this.model = { ...this.model, searchQuery: query, searchResults: clone(results) };
    if (!this.refocusCurrentCenterIfStale()) this.emit();
  }

  searchCatalog(query: string): void {
    if (this.disposed) return;
    this.dependencies.catalog.setQuery(query);
  }

  selectCatalogRecord(catalogId: string): void {
    if (this.disposed || !catalogPageContains(this.model.catalog, catalogId)) return;
    if (catalogId === this.model.selectedCatalogId) return;
    this.model = { ...this.model, selectedCatalogId: catalogId };
    this.emit();
  }

  setCatalogFiltersExpanded(expanded: boolean): void {
    if (this.disposed || expanded === this.model.catalogFiltersExpanded) return;
    this.model = { ...this.model, catalogFiltersExpanded: expanded };
    this.emit();
  }

  filterCatalogFolder(prefix: string): void {
    if (this.disposed) return;
    this.dependencies.catalog.setFolderPrefix(prefix);
  }

  toggleCatalogStatus(status: CatalogVerificationStatus): void {
    if (this.disposed) return;
    const active = this.dependencies.catalog.snapshot().verificationStatuses;
    this.dependencies.catalog.setVerificationStatuses(
      active.includes(status) ? active.filter((value) => value !== status) : [...active, status],
    );
  }

  toggleCatalogDifference(kind: CatalogDifferenceKind): void {
    if (this.disposed) return;
    const active = this.dependencies.catalog.snapshot().differenceKinds;
    this.dependencies.catalog.setDifferenceKinds(
      active.includes(kind) ? active.filter((value) => value !== kind) : [...active, kind],
    );
  }

  filterCatalogGroup(groupKey: string): void {
    if (this.disposed) return;
    this.dependencies.catalog.setTopLevelGroupId(groupKey);
  }

  filterCatalogTag(tag: string): void {
    if (this.disposed) return;
    this.dependencies.catalog.setHierarchyTag(tag);
  }

  toggleCatalogCloudMissing(include: boolean): void {
    if (this.disposed) return;
    this.dependencies.catalog.setIncludeCloudMissing(include);
  }

  selectCatalogPage(page: number): void {
    if (this.disposed) return;
    this.dependencies.catalog.setPage(page);
  }

  copyCatalogFilename(catalogId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.dependencies.catalog.copyFilename(catalogId);
  }

  copyCatalogPath(catalogId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.dependencies.catalog.copyCloudPath(catalogId);
  }

  openBaidu(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.dependencies.catalog.openBaidu();
  }

  catalogConnection(): CloudCatalogConnectionViewModel | undefined {
    return this.dependencies.catalog.connection?.snapshot();
  }

  subscribeCatalogConnection(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    return this.dependencies.catalog.subscribe(listener);
  }

  async connectCatalog(
    credentials: Readonly<{ appKey: string; secretKey: string }>,
    intent: CatalogAuthorizationIntent = "repair-same-account",
  ): Promise<void> {
    if (this.disposed) return;
    const operation = intent === "repair-same-account"
      ? "authorization-repair" as const
      : "identity-change" as const;
    await this.withCloudAuthorityPermit(operation, async () => {
      this.assertNoLiveCloudExecution();
      const connection = this.dependencies.catalog.connection;
      if (connection === undefined) throw new Error("catalog-unavailable");
      let preparedGeneration = this.dependencies.store.settings().cloudVerificationGeneration;
      let saveCredentials = intent === "replace-identity";
      if (intent === "replace-identity") {
        preparedGeneration = await this.replaceCatalogIdentityAuthority();
      } else {
        const settings = this.dependencies.store.settings();
        if (connection.snapshot().status === "unconfigured") {
          if (
            settings.cloudVerificationGeneration !== 0
            || settings.boundCloudLibrary !== null
          ) throw new Error("authorization-attempt-unavailable");
          saveCredentials = true;
        }
      }
      if (
        this.dependencies.store.settings().cloudVerificationGeneration !== preparedGeneration
      ) throw new Error("authorization-attempt-unavailable");
      this.clearCatalogDirectorySessions();
      if (saveCredentials) {
        await connection.saveApplicationCredentials(credentials);
      }
      if (this.disposed) return;
      await connection.beginAuthorization();
      if (this.disposed) return;
      if (
        this.dependencies.store.settings().cloudVerificationGeneration !== preparedGeneration
      ) throw new Error("authorization-attempt-unavailable");
      this.catalogAuthorizationAttempt = Object.freeze({ intent, preparedGeneration });
    });
  }

  async submitCatalogAuthorizationCode(
    code: string,
    expectedIntent?: CatalogAuthorizationIntent,
  ): Promise<void> {
    if (this.disposed) return;
    const attempt = this.catalogAuthorizationAttempt;
    if (attempt === null || (expectedIntent !== undefined && expectedIntent !== attempt.intent)) {
      throw new Error("authorization-attempt-unavailable");
    }
    const operation = attempt.intent === "repair-same-account"
      ? "authorization-repair" as const
      : "identity-change" as const;
    await this.withCloudAuthorityPermit(operation, async () => {
      this.assertNoLiveCloudExecution();
      if (
        this.catalogAuthorizationAttempt !== attempt
        || this.dependencies.store.settings().cloudVerificationGeneration
          !== attempt.preparedGeneration
      ) throw new Error("authorization-attempt-unavailable");
      const connection = this.dependencies.catalog.connection;
      if (connection === undefined) throw new Error("catalog-unavailable");
      await connection.submitAuthorizationCode(code);
      if (!this.disposed && this.catalogAuthorizationAttempt === attempt) {
        this.catalogAuthorizationAttempt = null;
      }
    });
  }

  cancelCatalogAuthorization(): void {
    if (this.disposed) return;
    if (this.cloudAuthorityOperation !== null) {
      this.failCloudAuthorityOperation("cloud-authority-operation-busy");
    }
    this.catalogAuthorizationAttempt = null;
    this.dependencies.catalog.connection?.cancelAuthorization();
  }

  async revokeCatalog(): Promise<void> {
    if (this.disposed) return;
    await this.withCloudAuthorityPermit("identity-change", async () => {
      this.assertNoLiveCloudExecution();
      const connection = this.dependencies.catalog.connection;
      if (connection === undefined) throw new Error("catalog-unavailable");
      await this.replaceCatalogIdentityAuthority();
      this.clearCatalogDirectorySessions();
      await connection.revoke();
    });
  }

  validateCatalogScanRoot(rootPath: string): string {
    return normalizeCatalogScanRoot(rootPath);
  }

  async chooseCatalogRoot(input: Readonly<{
    initialRoot: string;
    purpose: CloudDirectoryPickerPurpose;
  }>): Promise<CloudDirectorySelection | null> {
    if (this.disposed) return null;
    const trimmed = input.initialRoot.trim();
    const initialPath = trimmed.length === 0
      ? null
      : this.validateCatalogScanRoot(trimmed);
    const picker = this.dependencies.catalogDirectoryPicker;
    if (picker === undefined) throw new Error("catalog-unavailable");
    const validateSelection = requireCloudDirectorySelectionValidator(
      this.dependencies.catalogDirectorySelectionValidator,
    );
    const purpose = clone(input.purpose);
    const selection = await picker.request({
      initialPath,
      purpose,
      candidates: this.cloudDirectoryCandidates,
      ...(this.dependencies.catalog.directoryBrowser === undefined
        ? {}
        : { browser: this.dependencies.catalog.directoryBrowser }),
      ...(this.dependencies.catalog.directoryLocator === undefined
        ? {}
        : { locator: this.dependencies.catalog.directoryLocator }),
    });
    if (selection === null || this.disposed) return null;
    try {
      return validateSelection(selection, purpose);
    } catch {
      throw new RangeError("cloud-directory-selection-invalid");
    }
  }

  async requestCatalogScan(rootPath: string, onConfirmed?: () => void): Promise<void> {
    if (this.disposed) return;
    await this.withCloudAuthorityPermit("catalog-scan-launch", async () => {
      this.assertNoLiveCloudExecution();
      const normalized = this.validateCatalogScanRoot(rootPath);
      const connection = this.dependencies.catalog.connection;
      if (connection === undefined) throw new Error("catalog-unavailable");
      const confirmed = await this.dependencies.catalogConfirmation.request(normalized);
      if (this.disposed || !confirmed) return;
      this.assertNoLiveCloudExecution();
      onConfirmed?.();
      await connection.startScan(normalized);
    });
  }

  cancelCatalogScan(): void {
    if (this.disposed) return;
    this.dependencies.catalog.connection?.cancelScan();
  }

  hybridCatalog(): HybridCatalogViewModel | undefined {
    return this.dependencies.catalog.hybrid?.snapshot();
  }

  subscribeHybridCatalog(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    return this.dependencies.catalog.hybrid?.subscribe(listener) ?? (() => undefined);
  }

  async previewCatalogTxt(path: string): Promise<void> {
    if (this.disposed) return;
    await this.previewTaskCatalogTxt(path, this.model.taskActionRevision);
  }

  async previewTaskCatalogTxt(path: string, expectedRevision: number): Promise<void> {
    if (this.disposed) return;
    await this.withTaskActionPermit(expectedRevision, async () => {
      const hybrid = this.dependencies.catalog.hybrid;
      if (hybrid === undefined) throw new Error("catalog-unavailable");
      const priorDraft = this.pendingCatalogTxt;
      try {
        const preview = await hybrid.previewTxt(path);
        if (this.disposed) return;
        this.pendingCatalogTxt = Object.freeze({
          path,
          sourceSha256: preview.sourceSha256,
        });
        this.model = { ...this.model, pendingCatalogTxt: clone(this.pendingCatalogTxt) };
        this.emit();
      } catch (error) {
        if (!this.disposed) {
          const retainedCandidate = hybrid.snapshot().candidate;
          this.pendingCatalogTxt = priorDraft !== null
            && retainedCandidate?.sourceSha256 === priorDraft.sourceSha256
            ? priorDraft
            : null;
          this.model = {
            ...this.model,
            pendingCatalogTxt: this.pendingCatalogTxt === null
              ? null
              : clone(this.pendingCatalogTxt),
            status: "error",
            statusMessage: "task.txtImportFailed",
          };
          this.emit();
        }
        throw error;
      }
    });
  }

  async requestCatalogTxtImport(path: string, onConfirmed?: () => void): Promise<void> {
    if (this.disposed) return;
    await this.withTaskActionPermit(this.model.taskActionRevision, async () => {
      const candidate = this.dependencies.catalog.hybrid?.snapshot().candidate;
      if (candidate === undefined) throw new Error("catalog-unavailable");
      if (
        this.pendingCatalogTxt === null
        || this.pendingCatalogTxt.path !== path
        || this.pendingCatalogTxt.sourceSha256 !== candidate.sourceSha256
      ) {
        this.pendingCatalogTxt = Object.freeze({ path, sourceSha256: candidate.sourceSha256 });
        this.model = { ...this.model, pendingCatalogTxt: clone(this.pendingCatalogTxt) };
        this.emit();
      }
      await this.importCatalogTxtDraft(onConfirmed);
    });
  }

  async importPreviewedTaskCatalogTxt(): Promise<void> {
    if (this.disposed) return;
    await this.withTaskActionPermit(
      this.model.taskActionRevision,
      () => this.importCatalogTxtDraft(),
    );
  }

  async performTaskVerificationAction(
    kind: "start" | "resume",
    expectedRevision: number,
  ): Promise<void> {
    if (this.disposed) return;
    assertVerificationLaunchBuildAvailable();
    const priorRevision = this.model.taskActionRevision;
    this.reconcileTaskProjection();
    if (this.model.taskActionRevision !== priorRevision) this.emit();
    await this.withTaskActionPermit(expectedRevision, async (permit) => {
      const primaryAction = this.model.workflow.primaryAction;
      if (
        (kind === "start" && primaryAction !== "start")
        || (kind === "resume" && primaryAction !== "resume" && primaryAction !== "retry")
      ) throw new Error("task-action-stale");
      const hybrid = this.dependencies.catalog.hybrid;
      const settings = this.dependencies.store.settings();
      const binding = settings.boundCloudLibrary;
      if (hybrid === undefined || binding === null) {
        throw new HybridCatalogError("hybrid-batch-unavailable");
      }
      if (kind === "resume") {
        const batch = hybrid.snapshot().batch;
        if (batch === undefined) throw new HybridCatalogError("hybrid-batch-unavailable");
        await this.runVerifiedLaunch({
          kind,
          expectedRevision,
          cloudRoot: binding.path,
          groupKeys: [...batch.selectedGroupKeys],
          confirm: false,
        }, permit);
        return;
      }
      const selectedGroupKeys = this.model.selectedVerificationGroupKeys;
      const recommendedGroup = this.model.workflow.recommendedGroup;
      const groupKeys = selectedGroupKeys.length > 0
        ? [...selectedGroupKeys]
        : recommendedGroup === null
          ? []
          : [recommendedGroup.groupKey];
      await this.runVerifiedLaunch({
        kind,
        expectedRevision,
        cloudRoot: binding.path,
        groupKeys,
        ...(this.model.verificationDirectorySelection === undefined
          ? {}
          : { directorySelection: this.model.verificationDirectorySelection }),
        confirm: false,
      }, permit);
    });
  }

  async requestLargeCatalogVerification(
    rootPath: string,
    groupKeys: readonly string[],
    onConfirmed?: () => void,
    directorySelection?: CloudDirectorySelection,
  ): Promise<void> {
    if (this.disposed) return;
    assertVerificationLaunchBuildAvailable();
    await this.runVerifiedLaunch({
      kind: "start",
      cloudRoot: rootPath,
      groupKeys,
      ...(directorySelection === undefined ? {} : { directorySelection }),
      confirm: true,
      ...(onConfirmed === undefined ? {} : { onConfirmed }),
    });
  }

  async requestResumeLargeCatalogVerification(
    rootPath: string,
    groupKeys: readonly string[],
    onConfirmed?: () => void,
  ): Promise<void> {
    if (this.disposed) return;
    assertVerificationLaunchBuildAvailable();
    await this.runVerifiedLaunch({
      kind: "resume",
      cloudRoot: rootPath,
      groupKeys,
      confirm: true,
      ...(onConfirmed === undefined ? {} : { onConfirmed }),
    });
  }

  cancelLargeCatalogVerification(): void {
    if (this.disposed) return;
    this.dependencies.catalog.hybrid?.cancelLargeVerification();
  }

  reportCatalogError(code: CatalogInitializationErrorCode): void {
    if (this.disposed) return;
    this.model = {
      ...this.model,
      catalog: {
        ...this.model.catalog,
        status: code === "snapshot-corrupt" ? "error" : "unavailable",
        total: 0,
        items: [],
        messageCode: code,
      },
    };
    this.emit();
  }

  previewSuggestion(suggestionId: string): Promise<void> {
    return this.previewSuggestionIds([suggestionId]);
  }

  async previewSuggestionIds(suggestionIds: readonly string[]): Promise<void> {
    if (this.disposed || this.transactionBusy) return;
    if (this.dependencies.policy.contentWrites === "allowed"
      && this.dependencies.transactions.organizationWritesBlocked()) {
      this.model = { ...this.model, status: "ready", statusMessage: RECOVERY_LOCK_MESSAGE };
      this.emit();
      return;
    }
    const projectionRefresh = this.ensureProjectionCurrent();
    if (projectionRefresh === "failed") {
      this.emit();
      return;
    }
    const projectionPublished = this.refocusCurrentCenterIfStale();
    if (projectionRefresh === "changed" && !projectionPublished) this.emit();
    const selectedIds = new Set(suggestionIds);
    const selected = this.suggestions.filter((suggestion) => selectedIds.has(suggestion.operation.id));
    if (selected.length === 0) return;
    const rationales = Object.fromEntries(selected.map((suggestion) => [suggestion.operation.id, suggestion.localRationale]));
    const localRationales = Object.fromEntries(selected.map((suggestion) => [suggestion.operation.id, suggestion.localRationale]));
    const preview = await this.dependencies.changePlans.preview(
      selected.map((suggestion) => suggestion.operation),
      [],
      rationales,
      localRationales,
    );
    if (this.disposed) return;
    const confirmed = await this.dependencies.changePreview.request(preview);
    if (this.disposed || confirmed === null) return;
    await this.executeConfirmedPlan(confirmed, { origin: "suggestion" });
  }

  async executeConfirmedPlan(
    plan: ConfirmedPlan,
    options: Readonly<{ origin: "suggestion" | "undo" }>,
  ): Promise<ExecutionResult | null> {
    if (this.dependencies.policy.contentWrites === "blocked") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks organization writes");
      return null;
    }
    if (this.disposed || this.transactionBusy) return null;
    if (this.dependencies.transactions.organizationWritesBlocked()) {
      this.model = { ...this.model, status: "ready", statusMessage: RECOVERY_LOCK_MESSAGE };
      this.emit();
      return null;
    }
    this.transactionBusy = true;
    this.model = { ...this.model, status: "ready", statusMessage: "Executing changes" };
    this.emit();
    try {
      const result = await this.dependencies.transactions.execute(plan);
      if (this.disposed) return result;
      await this.refreshHistory();
      if (this.disposed) return result;
      let statusMessage: string;
      let projectionRefresh: ProjectionRefreshResult = "unchanged";
      if (result.status === "completed") {
        if (options.origin === "suggestion") {
          for (const operation of plan.operations) this.confirmedSuggestionIds.add(operation.id);
        }
        this.markProjectionDirty();
        projectionRefresh = this.ensureProjectionCurrent();
        statusMessage = projectionRefresh === "failed" ? PROJECTION_REFRESH_ERROR : "Changes completed";
      } else if (result.status === "rolled-back") statusMessage = "Changes rolled back";
      else if (result.status === "recovery-required") statusMessage = RECOVERY_LOCK_MESSAGE;
      else if (result.status === "stale") {
        const codes = [...new Set(result.conflicts.map((conflict) => conflict.code))].sort();
        statusMessage = `Plan not executed: ${codes.join(", ")}`;
      } else statusMessage = RECOVERY_LOCK_MESSAGE;
      this.model = {
        ...this.model,
        status: statusMessage === PROJECTION_REFRESH_ERROR ? "error" : "ready",
        statusMessage,
      };
      if (result.status === "completed") this.publishMaterializedProjection(projectionRefresh);
      else this.emit();
      return result;
    } catch (error) {
      if (!this.disposed) {
        this.model = this.dependencies.transactions.organizationWritesBlocked()
          ? { ...this.model, status: "ready", statusMessage: RECOVERY_LOCK_MESSAGE }
          : { ...this.model, status: "error", statusMessage: `Transaction failed: ${errorMessage(error)}` };
        this.emit();
      }
      return null;
    } finally {
      this.transactionBusy = false;
    }
  }

  async refreshHistory(): Promise<void> {
    if (this.disposed) return;
    const entries = await this.dependencies.journal.list();
    if (this.disposed) return;
    this.model = { ...this.model, history: { entries: clone(entries) } };
    this.emit();
  }

  async previewUndo(journalId: string): Promise<void> {
    if (this.dependencies.policy.contentWrites === "blocked") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks Undo");
      return;
    }
    if (this.disposed || this.transactionBusy) return;
    if (this.dependencies.transactions.organizationWritesBlocked()) {
      this.model = { ...this.model, status: "ready", statusMessage: RECOVERY_LOCK_MESSAGE };
      this.emit();
      return;
    }
    const preview = await this.dependencies.undo.preview(journalId);
    if (this.disposed) return;
    if (preview.plan.operations.length === 0 || preview.undoableOperationIds.length === 0) {
      this.model = { ...this.model, status: "ready", statusMessage: "Plan not executed: post-state-drift" };
      this.emit();
      return;
    }
    const confirmed = await this.dependencies.changePreview.request(preview);
    if (this.disposed || confirmed === null) return;
    if (this.dependencies.transactions.organizationWritesBlocked()) {
      this.model = { ...this.model, status: "ready", statusMessage: RECOVERY_LOCK_MESSAGE };
      this.emit();
      return;
    }
    await this.executeConfirmedPlan(confirmed, { origin: "undo" });
  }

  async requestClearHistory(): Promise<void> {
    if (this.dependencies.policy.history === "aggregate-only") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks history changes");
      return;
    }
    if (this.disposed) return;
    const confirmed = await this.dependencies.historyConfirmation.request();
    if (this.disposed || !confirmed) return;
    await this.dependencies.journal.clearHistory();
    if (this.disposed) return;
    await this.refreshHistory();
    if (this.disposed) return;
    this.model = { ...this.model, status: "ready", statusMessage: "History cleared" };
    this.emit();
  }

  async historyExportJson(exportedAt: string): Promise<string> {
    if (this.dependencies.policy.history === "aggregate-only") {
      throw new Error("Read-only acceptance mode blocks history details");
    }
    if (this.disposed) throw new Error("Workbench is disposed");
    const entries = await this.dependencies.journal.list();
    if (this.disposed) throw new Error("Workbench is disposed");
    return exportJournalJson(entries, exportedAt);
  }

  async viewRecovery(journalId: string): Promise<void> {
    if (this.dependencies.policy.history === "aggregate-only") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks history details");
      return;
    }
    if (this.disposed) return;
    const entries = await this.dependencies.journal.list();
    if (this.disposed) return;
    const entry = entries.find((value) => value.id === journalId);
    if (entry?.status !== "recovery-required" || entry.recovery === undefined) {
      throw new Error("Recovery information is unavailable");
    }
    this.model = {
      ...this.model,
      history: {
        entries: clone(entries),
        recoveryReport: {
          journalId: entry.id,
          issues: entry.recovery.unresolved.map((issue) => ({
            operationId: issue.operationId,
            comparison: issue.comparison,
            originalPaths: [...issue.originalPaths],
            currentPaths: [...issue.currentPaths],
          })),
        },
      },
    };
    this.emit();
  }

  reportReady(): void {
    if (this.disposed) return;
    this.model = { ...this.model, status: "ready", statusMessage: undefined };
    this.emit();
  }

  async previewSampleChange(): Promise<void> {
    if (this.dependencies.policy.configuration === "read-only") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks write configuration");
      return;
    }
    if (this.disposed) return;
    const acknowledged = await this.dependencies.changePreview.requestSample();
    if (this.disposed || !acknowledged) return;
    const settings = this.dependencies.store.settings();
    await this.dependencies.store.saveSettings({ ...settings, writePreviewAcknowledged: true });
    if (this.disposed) return;
    this.emit();
  }

  refreshSuggestions(): readonly SuggestedOperation[] {
    if (this.disposed) return [];
    this.markProjectionDirty();
    const projectionRefresh = this.ensureProjectionCurrent();
    this.publishMaterializedProjection(projectionRefresh);
    return clone(this.suggestions);
  }

  summarize(paths: readonly string[]): Promise<AiResult<string>> { return this.startAiAction("summarize", paths); }
  nameCluster(paths: readonly string[]): Promise<AiResult<string>> { return this.startAiAction("name-cluster", paths); }
  explainRelation(paths: readonly string[], targetSuggestionId?: string): Promise<AiResult<string>> {
    return this.startAiAction("explain-relation", paths, targetSuggestionId);
  }
  suggestLabels(paths: readonly string[]): Promise<AiResult<string>> { return this.startAiAction("suggest-labels", paths); }

  notifySuggestionSelectionChanged(): void {
    if (this.disposed) return;
    const hadAiDisplay = this.model.aiSuggestion !== undefined || this.aiOverrideSuggestionId !== null;
    this.aiSelectionGeneration += 1;
    this.clearAiDisplay();
    if (hadAiDisplay) this.emit();
  }

  async saveAiSettings(input: AiSettingsInput): Promise<void> {
    if (this.dependencies.policy.ai === "blocked") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks AI configuration");
      return;
    }
    if (this.disposed) return;
    let endpoint = "";
    let model = "";
    let secretId = "";
    try {
      endpoint = input.endpoint.trim().length === 0 ? "" : normalizeAiEndpoint(input.endpoint);
      model = input.model.trim().length === 0 ? "" : normalizeAiModel(input.model);
      secretId = input.secretId.trim().length === 0 ? "" : normalizeAiSecretId(input.secretId);
      if (input.enabled && (endpoint.length === 0 || model.length === 0)) throw new Error("invalid");
    } catch {
      this.invalidateAiConfiguration(true);
      const current = this.dependencies.store.settings();
      await this.dependencies.store.saveSettings({
        ...current,
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
      });
      throw new Error("Invalid AI configuration");
    }
    const current = this.dependencies.store.settings();
    this.invalidateAiConfiguration(
      input.enabled === false
      || secretId !== current.secretId
      || endpoint !== current.aiEndpoint
      || model !== current.aiModel,
    );
    await this.dependencies.store.saveSettings({
      ...current,
      aiEnabled: input.enabled,
      aiEndpoint: endpoint,
      aiModel: model,
      secretId,
    });
    if (!this.disposed) {
      this.clearAiDisplay();
      this.emit();
    }
  }

  setSessionAiSecret(secret: string): void {
    if (this.dependencies.policy.ai === "blocked") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks AI");
      return;
    }
    if (this.disposed) return;
    this.invalidateAiConfiguration(true);
    const settings = this.dependencies.store.settings();
    if (settings.secretId.length > 0 || typeof secret !== "string" || secret.length === 0) return;
    this.#sessionAiSecret = secret;
  }

  settings(): PluginSettings {
    return effectiveSettings(this.dependencies.policy, this.dependencies.store.settings());
  }

  folderRuleProposals(): readonly FolderRuleProposal[] {
    const projectionRefresh = this.ensureProjectionCurrent();
    if (projectionRefresh === "failed") {
      this.emit();
      return [];
    }
    const projectionPublished = this.refocusCurrentCenterIfStale();
    if (projectionRefresh === "changed" && !projectionPublished) this.emit();
    return clone(suggestFolderRules(this.records));
  }

  async setOpenAtStartup(value: boolean): Promise<void> {
    if (this.disposed) return;
    const settings = this.dependencies.store.settings();
    await this.dependencies.store.saveSettings({ ...settings, openAtStartup: value });
    if (this.disposed) return;
    this.emit();
  }

  async setLocale(locale: WorkbenchLocale): Promise<void> {
    if (this.disposed || locale === this.model.locale) return;
    const settings = this.dependencies.store.settings();
    await this.dependencies.store.saveSettings({ ...settings, locale });
    if (this.disposed) return;
    this.model = { ...this.model, locale };
    if (
      this.folderSelectionOwner === null
      || this.folderSelectionOwner.closeRequested
    ) this.emit();
    else this.publishFolderSelection(this.folderSelectionOwner);
  }

  async setWriteEnabled(value: boolean): Promise<void> {
    if (this.dependencies.policy.configuration === "read-only") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks write configuration");
      return;
    }
    if (this.disposed) return;
    const settings = this.dependencies.store.settings();
    await this.dependencies.store.saveSettings({
      ...settings,
      writeEnabled: value && settings.writePreviewAcknowledged,
    });
    if (this.disposed) return;
    this.emit();
  }

  async pin(id: string): Promise<void> {
    if (this.disposed) return;
    await this.dependencies.store.setPin(id, this.dependencies.clock.now());
    if (this.disposed) return;
    this.markProjectionDirty();
    this.publishMaterializedProjection(this.ensureProjectionCurrent());
  }

  async dismiss(id: string, mtime: number): Promise<void> {
    if (this.disposed) return;
    if (this.ensureProjectionCurrent() === "failed") {
      this.emit();
      return;
    }
    const currentMtime = this.records.find((record) => record.id === id)?.mtime ?? mtime;
    await this.dependencies.store.setDismissal(id, { dismissedAt: this.dependencies.clock.now(), mtime: currentMtime });
    if (this.disposed) return;
    this.markProjectionDirty();
    this.publishMaterializedProjection(this.ensureProjectionCurrent());
  }

  async recordFileOpen(id: string): Promise<void> {
    if (this.disposed) return;
    if (this.ensureProjectionCurrent() === "failed") {
      this.emit();
      return;
    }
    const normalizedPath = normalizeVaultPath(id);
    const record = this.records.find((candidate) => candidate.id === id || candidate.path === normalizedPath);
    await this.dependencies.store.setLastOpened(record?.id ?? normalizedPath, this.dependencies.clock.now());
    if (this.disposed) return;
    this.markProjectionDirty();
    this.publishMaterializedProjection(this.ensureProjectionCurrent());
  }

  openNote(path: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.dependencies.workspace.openNote(path);
  }

  startQuickCapture(): Promise<string | null> {
    if (this.dependencies.policy.quickCapture === "blocked") {
      this.reportAcceptanceBlock("Read-only acceptance mode blocks Quick Capture");
      return Promise.resolve(null);
    }
    if (this.disposed) return Promise.resolve(null);
    return this.dependencies.quickCapture.capture();
  }

  async applyFolderRules(rules: readonly FolderRule[]): Promise<void> {
    if (this.disposed) return;
    const settings = this.dependencies.store.settings();
    await this.dependencies.store.saveSettings({ ...settings, folderRules: clone(rules) });
    if (this.disposed) return;
    this.markProjectionDirty();
    this.publishMaterializedProjection(this.ensureProjectionCurrent());
  }

  async setExcludedPrefixes(prefixes: readonly string[]): Promise<void> {
    if (this.disposed) return;
    const lifecycleEpoch = this.lifecycleEpoch;
    const generation = ++this.exclusionGeneration;
    const hadActiveIndex = this.dependencies.store.hasActiveIndex();
    this.cancelScan();
    await this.scanPromise;
    if (!this.ownsExclusion(lifecycleEpoch, generation)) return;
    let paused = false;
    try {
      await this.dependencies.indexQueue.pauseAutoFlush();
      paused = true;
      if (!this.ownsExclusion(lifecycleEpoch, generation)) return;
      const settings = this.dependencies.store.settings();
      await this.dependencies.store.saveSettings({ ...settings, excludedPrefixes: [...prefixes] });
      if (!this.ownsExclusion(lifecycleEpoch, generation)) return;
      await this.dependencies.index.reconcilePathPolicy();
      if (!this.ownsExclusion(lifecycleEpoch, generation)) return;
      this.markProjectionDirty();
      this.publishMaterializedProjection(this.ensureProjectionCurrent());
      await this.startInitialScan();
      if (!this.ownsExclusion(lifecycleEpoch, generation)) return;
    } catch (error) {
      if (!this.ownsExclusion(lifecycleEpoch, generation)) return;
      let reported = error;
      if (hadActiveIndex && paused) {
        try {
          await this.dependencies.indexQueue.resumeAndFlush();
        } catch (resumeError) {
          reported = resumeError;
        }
        if (!this.ownsExclusion(lifecycleEpoch, generation)) return;
      }
      this.reportError(`Exclusion update failed: ${errorMessage(reported)}`);
      throw reported;
    }
  }

  reportError(message: string): void {
    if (this.disposed) return;
    this.model = { ...this.model, status: "error", statusMessage: message };
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeFolderSelection(true, false);
    this.cancelProjectionSchedule();
    this.lifecycleEpoch += 1;
    this.exclusionGeneration += 1;
    this.invalidateAiConfiguration(true);
    this.scanController?.abort();
    this.mapController?.abort();
    const quickCapture = this.dependencies.quickCapture as QuickCapturePort & { readonly dispose?: () => void };
    quickCapture.dispose?.();
    this.unsubscribeIndex();
    this.unsubscribeCatalogConnection();
    this.unsubscribeHybridCatalog();
    this.unsubscribeCatalog();
    this.dependencies.catalog.dispose();
    this.listeners.clear();
  }

  private refreshCatalogViewState(): void {
    if (this.disposed) return;
    const catalog = clone(this.dependencies.catalog.snapshot());
    const catalogConnection = this.dependencies.catalog.connection === undefined
      ? undefined
      : clone(this.dependencies.catalog.connection.snapshot());
    const incomingHybridCatalog = this.dependencies.catalog.hybrid === undefined
      ? undefined
      : clone(this.dependencies.catalog.hybrid.snapshot());
    if (
      this.folderSelectionOwner !== null
      && incomingHybridCatalog?.active?.sourceImportSha256
        !== this.folderSelectionOwner.sourceImportSha256
    ) this.disposeFolderSelection(true, false);
    const verificationCapabilityAvailable = incomingHybridCatalog !== undefined
      && incomingHybridCatalog.status !== "unavailable";
    if (!verificationCapabilityAvailable) {
      this.dismissedVerificationHybridMessageCode = null;
    } else if (
      this.dismissedVerificationHybridMessageCode !== null
      && incomingHybridCatalog.messageCode !== this.dismissedVerificationHybridMessageCode
    ) {
      this.dismissedVerificationHybridMessageCode = null;
    }
    const hybridCatalog = incomingHybridCatalog !== undefined
      && incomingHybridCatalog.messageCode === this.dismissedVerificationHybridMessageCode
      ? hybridWithoutMessage(incomingHybridCatalog)
      : incomingHybridCatalog;
    if (
      this.lockedVerificationRoot !== null
      && hybridCatalog?.status !== "scanning"
      && hybridCatalog?.batch?.resumeAvailable !== true
    ) this.lockedVerificationRoot = null;
    const availableGroupKeys = new Set(
      hybridCatalog?.active?.groups.map((group) => group.groupKey) ?? [],
    );
    const selectedVerificationGroupKeys = this.model.selectedVerificationGroupKeys
      .filter((groupKey) => availableGroupKeys.has(groupKey));
    let verificationDirectorySelection = this.model.verificationDirectorySelection;
    if (verificationDirectorySelection?.kind === "category") {
      try {
        verificationDirectorySelection = requireCloudDirectorySelectionValidator(
          this.dependencies.catalogDirectorySelectionValidator,
        )(
          verificationDirectorySelection,
          verificationPickerPurpose(hybridCatalog?.active?.groups ?? []),
        );
      } catch {
        verificationDirectorySelection = undefined;
      }
    }
    const {
      catalogConnection: _catalogConnection,
      hybridCatalog: _hybridCatalog,
      verificationActionMessageCode,
      verificationDirectorySelection: _verificationDirectorySelection,
      ...current
    } = this.model;
    this.model = {
      ...current,
      catalog,
      ...(catalogConnection === undefined ? {} : { catalogConnection }),
      ...(hybridCatalog === undefined ? {} : { hybridCatalog }),
      ...(verificationCapabilityAvailable && verificationActionMessageCode !== undefined
        ? { verificationActionMessageCode }
        : {}),
      ...(verificationDirectorySelection === undefined ? {} : { verificationDirectorySelection }),
      verificationRootLocked: this.lockedVerificationRoot !== null,
      selectedVerificationGroupKeys,
      selectedCatalogId: catalogPageContains(catalog, this.model.selectedCatalogId)
        ? this.model.selectedCatalogId
        : null,
    };
    const folderOwner = this.folderSelectionOwner;
    if (folderOwner !== null && !folderOwner.closeRequested) {
      try {
        const state = clone(folderOwner.driver.snapshot());
        if (state.phase !== "closed") {
          this.model = {
            ...this.model,
            folderSelection: {
              revision: this.nextFolderSelectionRevision(),
              locale: this.model.locale,
              state,
              returnLabel: this.model.locale === "zh-CN" ? "云端核验" : "Cloud verification",
              legacyProgressMode: this.folderSelectionLegacyProgressMode(state),
            },
          };
        }
      } catch {
        this.disposeFolderSelection(true, false);
      }
    }
    this.emit();
  }

  private lockVerificationRoot(root: string): void {
    if (this.disposed) return;
    this.lockedVerificationRoot = root;
    this.model = {
      ...this.model,
      verificationRoot: root,
      verificationRootLocked: true,
    };
    this.emit();
  }

  private unlockVerificationRoot(): void {
    if (this.disposed || this.lockedVerificationRoot === null) return;
    this.lockedVerificationRoot = null;
    this.model = { ...this.model, verificationRootLocked: false };
    this.emit();
  }

  private setVerificationActionMessage(
    code: NonNullable<WorkbenchViewModel["verificationActionMessageCode"]>,
  ): void {
    if (this.disposed || this.model.verificationActionMessageCode === code) return;
    this.model = { ...this.model, verificationActionMessageCode: code };
    this.emit();
  }

  private clearVerificationActionMessage(): void {
    if (this.disposed || this.model.verificationActionMessageCode === undefined) return;
    const { verificationActionMessageCode: _verificationActionMessageCode, ...current } = this.model;
    this.model = current;
    this.emit();
  }

  private captureVerificationValidation(error: unknown): void {
    const code = verificationValidationCode(error);
    if (code !== undefined) this.setVerificationActionMessage(code);
  }

  private clearVerificationHybridMessageSuppression(): void {
    if (this.dismissedVerificationHybridMessageCode === null) return;
    this.dismissedVerificationHybridMessageCode = null;
    this.refreshCatalogViewState();
  }

  private async runInitialScan(
    controller: AbortController,
    hadActiveIndex: boolean,
    lifecycleEpoch: number,
  ): Promise<void> {
    let promoted = false;
    let terminal: WorkbenchProgress["status"] = "complete";
    try {
      await this.dependencies.indexQueue.pauseAutoFlush();
      if (!this.ownsLifecycle(lifecycleEpoch)) return;
      if (controller.signal.aborted) throw new DOMException("Index scan canceled", "AbortError");
      await this.dependencies.index.buildInitial(controller.signal, (progress) => {
        if (this.disposed || this.scanController !== controller) return;
        this.model = {
          ...this.model,
          scanProgress: {
            status: "running",
            completed: progress.completed,
            total: progress.total,
            label: "Index",
          },
        };
        this.emit();
      });
      promoted = true;
      if (!this.ownsLifecycle(lifecycleEpoch)) return;
      await this.dependencies.indexQueue.resumeAndFlush();
      if (!this.ownsLifecycle(lifecycleEpoch)) return;
    } catch (error) {
      terminal = isAbortError(error) ? "canceled" : "error";
      if (!promoted && hadActiveIndex && this.ownsLifecycle(lifecycleEpoch)) {
        try {
          await this.dependencies.indexQueue.resumeAndFlush();
        } catch {
          terminal = "error";
        }
      }
    } finally {
      if (this.scanController === controller) this.scanController = null;
      this.scanPromise = null;
    }
    if (this.disposed) return;
    this.markProjectionDirty();
    const projectionRefresh = this.ensureProjectionCurrent();
    const projectionCurrent = projectionRefresh !== "failed";
    this.model = {
      ...this.model,
      status: projectionCurrent
        ? terminal === "error" ? "error" : terminal === "canceled" ? "canceled" : "ready"
        : "error",
      statusMessage: projectionCurrent ? undefined : PROJECTION_REFRESH_ERROR,
      scanProgress: {
        ...this.model.scanProgress,
        status: terminal,
        label: "Index",
      },
    };
    this.publishMaterializedProjection(projectionRefresh);
  }

  private startMapForCurrentCenter(): Promise<void> {
    const center = this.center;
    if (this.disposed || center === null) return Promise.resolve();
    this.mapController?.abort();
    const controller = new AbortController();
    const generation = ++this.mapGeneration;
    this.mapController = controller;
    this.mapProjectionRevision = this.projectedRevision;
    this.model = {
      ...this.model,
      mapProgress: { status: "running", completed: 0, label: "Map" },
    };
    this.emit();
    return this.runMap(center, controller, generation);
  }

  private refocusCurrentCenterIfStale(): boolean {
    if (this.center === null || this.mapProjectionRevision === this.projectedRevision) return false;
    void this.startMapForCurrentCenter();
    return true;
  }

  private publishMaterializedProjection(projectionRefresh: ProjectionRefreshResult): void {
    if (projectionRefresh === "failed" || !this.refocusCurrentCenterIfStale()) this.emit();
  }

  private async runMap(center: MapCenter, controller: AbortController, generation: number): Promise<void> {
    let latestCompleted = 0;
    let lastPublishedCompleted: number | null = null;
    try {
      const focused = await this.dependencies.map.focus({
        records: this.records,
        center,
        filter: this.model.mapFilter,
      }, controller.signal, (completed) => {
        if (!this.ownsMap(controller, generation)) return;
        latestCompleted = completed;
        if (lastPublishedCompleted !== null && completed - lastPublishedCompleted < 50_000) return;
        lastPublishedCompleted = completed;
        this.model = {
          ...this.model,
          mapProgress: { status: "running", completed, label: "Map" },
        };
        this.emit();
      });
      if (!this.ownsMap(controller, generation)) return;
      this.model = {
        ...this.model,
        status: "ready",
        statusMessage: undefined,
        map: clone(focused),
        mapProgress: { status: "complete", completed: latestCompleted, label: "Map" },
      };
      this.emit();
    } catch (error) {
      if (!this.ownsMap(controller, generation)) return;
      const status = isAbortError(error) ? "canceled" : "error";
      this.model = {
        ...this.model,
        status,
        statusMessage: status === "error" ? "Map calculation failed" : undefined,
        mapProgress: { status, completed: latestCompleted, label: "Map" },
      };
      this.emit();
    } finally {
      if (this.ownsMap(controller, generation)) this.mapController = null;
    }
  }

  private ownsMap(controller: AbortController, generation: number): boolean {
    return !this.disposed && this.mapController === controller && this.mapGeneration === generation;
  }

  private ownsLifecycle(epoch: number): boolean {
    return !this.disposed && this.lifecycleEpoch === epoch;
  }

  private ownsExclusion(lifecycleEpoch: number, generation: number): boolean {
    return this.ownsLifecycle(lifecycleEpoch) && this.exclusionGeneration === generation;
  }

  private computeProjection(): Readonly<{
    records: readonly DocumentRecord[];
    classifications: Readonly<Record<string, ClassificationResult>>;
    suggestions: readonly SuggestedOperation[];
    model: WorkbenchViewModel;
  }> {
    const settings = this.dependencies.store.settings();
    const classified = classifyRecords(this.dependencies.index.activeRecords(), this.dependencies.classification, settings);
    const records = classified.records;
    const classifications = clone(classified.resultsById);
    const generated = this.dependencies.suggestions.generate({
      records,
      classifications,
      folderRules: settings.folderRules,
      relations: buildConfirmedRelationCandidates(records),
    });
    const suggestions = generated.suggestions
      .filter((suggestion) => !this.confirmedSuggestionIds.has(suggestion.operation.id));
    const operational = this.dependencies.store.operational();
    const recordsByPath = new Map(records.map((record) => [normalizeVaultPath(record.path), record]));
    const todaySuggestions = suggestions.flatMap((suggestion) => {
      const record = recordsByPath.get(normalizeVaultPath(sourcePathOf(suggestion)));
      if (record === undefined) return [];
      return [{
        suggestionId: suggestion.operation.id,
        documentId: record.id,
        confidence: suggestion.localRationale.confidence,
        impact: suggestion.localRationale.impact,
        explanation: suggestion.localRationale.summary,
        actionLabel: actionLabel(suggestion),
      }];
    });
    const today = this.dependencies.today.build({ ...operational, records, suggestions: todaySuggestions });
    const searchResults: readonly MapSearchResult[] = this.model.searchQuery.length === 0
      ? []
      : this.dependencies.map.search(records, this.model.searchQuery);
    const modelWithProjectionStatus = this.model.statusMessage === PROJECTION_REFRESH_ERROR
      ? { ...this.model, status: "ready" as const, statusMessage: undefined }
      : this.model;
    const { aiSuggestion: _removed, ...modelWithoutAi } = modelWithProjectionStatus;
    const model: WorkbenchViewModel = {
      ...modelWithoutAi,
      today,
      suggestions: clone(suggestions),
      searchResults: clone(searchResults),
    };
    return { records, classifications, suggestions, model };
  }

  private ensureProjectionCurrent(): ProjectionRefreshResult {
    if (this.disposed) return "failed";
    let changed = false;
    this.cancelProjectionSchedule();
    while (this.projectedRevision !== this.projectionRevision) {
      const targetRevision = this.projectionRevision;
      let projection: ReturnType<WorkbenchController["computeProjection"]>;
      try {
        projection = this.computeProjection();
      } catch {
        if (!this.disposed) {
          this.model = { ...this.model, status: "error", statusMessage: PROJECTION_REFRESH_ERROR };
        }
        return "failed";
      }
      if (this.disposed) return "failed";
      this.records = projection.records;
      this.classifications = projection.classifications;
      this.suggestions = projection.suggestions;
      this.model = projection.model;
      this.aiOverrideSuggestionId = null;
      this.aiOriginalRationale = null;
      this.projectedRevision = targetRevision;
      changed = true;
      if (this.projectedRevision === this.projectionRevision) this.projectionDirtySince = null;
      this.cancelProjectionSchedule();
    }
    return changed ? "changed" : "unchanged";
  }

  private markProjectionDirty(): void {
    if (this.disposed) return;
    const wasCurrent = this.projectedRevision === this.projectionRevision;
    this.projectionRevision += 1;
    if (wasCurrent || this.projectionDirtySince === null) this.projectionDirtySince = this.projectionNow();
    this.aiSelectionGeneration += 1;
    const mapController = this.mapController;
    if (mapController !== null) {
      mapController.abort();
      this.mapController = null;
      this.mapGeneration += 1;
      if (this.model.mapProgress.status === "running") {
        this.model = {
          ...this.model,
          mapProgress: { ...this.model.mapProgress, status: "canceled" },
        };
      }
    }
    this.scheduleProjection();
  }

  private scheduleProjection(): void {
    if (this.disposed
      || this.projectedRevision === this.projectionRevision
      || (this.listeners.size === 0 && this.center === null)) return;
    const now = this.projectionNow();
    if (this.projectionDirtySince === null) this.projectionDirtySince = now;
    this.cancelQuietProjectionTimer();
    this.quietProjectionTimer = this.createProjectionTimer("quiet", PROJECTION_QUIET_DELAY_MS);
    if (this.maxProjectionTimer !== null) return;
    const elapsed = now === null || this.projectionDirtySince === null
      ? 0
      : Math.max(0, now - this.projectionDirtySince);
    this.maxProjectionTimer = this.createProjectionTimer(
      "max",
      Math.max(0, PROJECTION_MAX_WAIT_MS - elapsed),
    );
  }

  private createProjectionTimer(kind: "quiet" | "max", delayMs: number): ProjectionTimer | null {
    const token = ++this.projectionTimerToken;
    try {
      const handle = this.projectionScheduler.schedule(() => {
        const timer = kind === "quiet" ? this.quietProjectionTimer : this.maxProjectionTimer;
        if (this.disposed || timer?.token !== token) return;
        if (kind === "quiet") this.quietProjectionTimer = null;
        else this.maxProjectionTimer = null;
        this.runScheduledProjection();
      }, delayMs);
      return { handle, token };
    } catch {
      return null;
    }
  }

  private runScheduledProjection(): void {
    if (this.disposed) return;
    this.cancelProjectionSchedule();
    if (this.ensureProjectionCurrent() === "failed") {
      this.emit();
      return;
    }
    if (!this.refocusCurrentCenterIfStale()) this.emit();
  }

  private cancelQuietProjectionTimer(): void {
    const timer = this.quietProjectionTimer;
    this.quietProjectionTimer = null;
    if (timer === null) return;
    try {
      this.projectionScheduler.cancel(timer.handle);
    } catch {
      // A scheduler failure must not escape an index publication or action barrier.
    }
  }

  private cancelProjectionSchedule(): void {
    this.cancelQuietProjectionTimer();
    const timer = this.maxProjectionTimer;
    this.maxProjectionTimer = null;
    if (timer === null) return;
    try {
      this.projectionScheduler.cancel(timer.handle);
    } catch {
      // A scheduler failure must not escape an index publication or action barrier.
    }
  }

  private projectionNow(): number | null {
    try {
      const now = this.projectionScheduler.now();
      return Number.isFinite(now) ? now : null;
    } catch {
      return null;
    }
  }

  private startAiAction(action: AiAction, rawPaths: unknown, targetSuggestionId?: string): Promise<AiResult<string>> {
    if (this.dependencies.policy.ai === "blocked") return Promise.resolve(aiFallback("disabled"));
    if (this.disposed) return Promise.resolve(aiFallback("action-invalidated"));
    const rawKey = rawAiActionKey(action, rawPaths, targetSuggestionId);
    if (this.aiFlight !== null) {
      return rawKey !== null && this.aiFlight.rawKey === rawKey
        ? this.aiFlight.promise
        : Promise.resolve(aiFallback("busy"));
    }
    const ai = this.dependencies.ai;
    if (ai === undefined) return Promise.resolve(aiFallback("disabled"));
    const settings = this.dependencies.store.settings();
    if (!settings.aiEnabled) return Promise.resolve(aiFallback("disabled"));
    let endpoint: string;
    let model: string;
    try {
      endpoint = normalizeAiEndpoint(settings.aiEndpoint);
      model = normalizeAiModel(settings.aiModel);
      if (settings.secretId.length > 0) normalizeAiSecretId(settings.secretId);
    } catch {
      return Promise.resolve(aiFallback("invalid-configuration"));
    }
    const projectionRefresh = this.ensureProjectionCurrent();
    if (projectionRefresh === "failed") {
      this.emit();
      return Promise.resolve(aiFallback("action-invalidated"));
    }
    const projectionPublished = this.refocusCurrentCenterIfStale();
    if (projectionRefresh === "changed" && !projectionPublished) this.emit();
    const selection = this.validateAiSelection(rawPaths);
    if (selection.kind === "fallback") return Promise.resolve(aiFallback(selection.reason));
    if (action === "explain-relation" && targetSuggestionId !== undefined) {
      if (targetSuggestionId.length === 0) {
        return Promise.resolve(aiFallback("invalid-selection"));
      }
      const target = this.suggestions.find((suggestion) => suggestion.operation.id === targetSuggestionId);
      if (target === undefined || !selection.paths.includes(suggestionPath(target))) {
        return Promise.resolve(aiFallback("invalid-selection"));
      }
    }
    if (rawKey === null) return Promise.resolve(aiFallback("invalid-selection"));
    const token = {
      lifecycle: this.lifecycleEpoch,
      configuration: this.aiConfigurationGeneration,
      selection: this.aiSelectionGeneration,
      endpoint,
      model,
      secretId: settings.secretId,
      enabled: settings.aiEnabled,
    };
    const operation = this.runAiAction(action, selection.paths, selection.approximateCharacters, token, targetSuggestionId);
    this.aiFlight = { rawKey, promise: operation };
    void operation.finally(() => {
      if (this.aiFlight?.promise === operation) this.aiFlight = null;
    });
    return operation;
  }

  private reportAcceptanceBlock(message: string): void {
    if (this.disposed) return;
    this.model = { ...this.model, status: "ready", statusMessage: message };
    this.emit();
  }

  private validateAiSelection(value: unknown):
    | Readonly<{ kind: "ok"; paths: readonly string[]; approximateCharacters: number }>
    | Readonly<{ kind: "fallback"; reason: "empty-selection" | "invalid-selection" | "selection-limit" }> {
    try {
      const candidates = decodeStrictStringArray(value);
      if (candidates === null) return { kind: "fallback", reason: "invalid-selection" };
      if (candidates.length === 0) return { kind: "fallback", reason: "empty-selection" };
      if (candidates.length > 20) return { kind: "fallback", reason: "selection-limit" };
      const byPath = new Map<string, DocumentRecord[]>();
      const byId = new Map<string, DocumentRecord[]>();
      for (const record of this.records) {
        const pathRecords = byPath.get(record.path) ?? [];
        pathRecords.push(record);
        byPath.set(record.path, pathRecords);
        const idRecords = byId.get(record.id) ?? [];
        idRecords.push(record);
        byId.set(record.id, idRecords);
      }
      const settings = this.dependencies.store.settings();
      const paths: string[] = [];
      const seen = new Set<string>();
      let approximateCharacters = 0;
      for (const candidate of candidates) {
        const matches = new Set([...(byId.get(candidate) ?? []), ...(byPath.get(candidate) ?? [])]);
        if (matches.size !== 1) return { kind: "fallback", reason: "invalid-selection" };
        const record = [...matches][0]!;
        const path = record.path;
        if (!isCanonicalSafeMarkdownPath(path)
          || byPath.get(path)?.length !== 1
          || byId.get(record.id)?.length !== 1
          || seen.has(path)
          || this.dependencies.classification.isExcluded(path, settings)
          || !Number.isFinite(record.size)
          || record.size < 0) return { kind: "fallback", reason: "invalid-selection" };
        seen.add(path);
        paths.push(path);
        approximateCharacters += record.size;
        if (approximateCharacters > 100_000) return { kind: "fallback", reason: "selection-limit" };
      }
      return { kind: "ok", paths, approximateCharacters };
    } catch {
      return { kind: "fallback", reason: "invalid-selection" };
    }
  }

  private async runAiAction(
    action: AiAction,
    paths: readonly string[],
    approximateCharacters: number,
    token: Readonly<{
      lifecycle: number;
      configuration: number;
      selection: number;
      endpoint: string;
      model: string;
      secretId: string;
      enabled: boolean;
    }>,
    targetSuggestionId?: string,
  ): Promise<AiResult<string>> {
    const ai = this.dependencies.ai;
    if (ai === undefined) return aiFallback("disabled");
    try {
      const confirmed = await ai.preview.request({
        action,
        endpointOrigin: new URL(token.endpoint).origin,
        paths: [...paths],
        noteCount: paths.length,
        approximateCharacters,
      });
      if (!this.ownsAiToken(token)) return aiFallback("action-invalidated");
      if (!confirmed) return aiFallback("cancelled");
      const notes: AiNotePayload[] = [];
      let exactCharacters = 0;
      for (const path of paths) {
        if (!this.ownsAiToken(token)) return aiFallback("action-invalidated");
        const note = await this.dependencies.reads.readNote(path);
        if (!this.ownsAiToken(token)) return aiFallback("action-invalidated");
        if (note === null || normalizeVaultPath(note.path) !== path || note.path !== path) return aiFallback("note-unavailable");
        const content = stripInitialFrontmatter(note.content);
        exactCharacters += content.length;
        if (exactCharacters > 100_000) return aiFallback("selection-limit");
        notes.push(Object.freeze({ path, content }));
      }
      if (notes.length > 20) return aiFallback("selection-limit");
      if (!this.ownsAiToken(token)) return aiFallback("action-invalidated");
      let secret: string | null = this.#sessionAiSecret;
      if (token.secretId.length > 0) {
        try { secret = ai.getSecret(token.secretId); } catch { return aiFallback("secret-unavailable"); }
      }
      if (typeof secret !== "string" || secret.length === 0) return aiFallback("secret-unavailable");
      if (!this.ownsAiToken(token)) return aiFallback("action-invalidated");
      let client: AiClientPort;
      try { client = ai.createClient(token.endpoint, token.model, secret); } catch { return aiFallback("service-unavailable"); }
      const service = new AiEnhancementService(client, ai.delay, () => this.ownsAiToken(token));
      const method = action === "summarize"
        ? service.summarize.bind(service)
        : action === "name-cluster"
          ? service.nameCluster.bind(service)
          : action === "explain-relation"
            ? service.explainRelation.bind(service)
            : service.suggestLabels.bind(service);
      const result = await method(notes);
      if (!this.ownsAiToken(token)) return aiFallback("action-invalidated");
      if (result.kind !== "ok") return result;
      this.applyAiDisplay(action, result.value, targetSuggestionId);
      this.emit();
      return result;
    } catch {
      return this.ownsAiToken(token) ? aiFallback("service-unavailable") : aiFallback("action-invalidated");
    }
  }

  private ownsAiToken(token: Readonly<{
    lifecycle: number;
    configuration: number;
    selection: number;
    endpoint: string;
    model: string;
    secretId: string;
    enabled: boolean;
  }>): boolean {
    if (this.disposed
      || this.lifecycleEpoch !== token.lifecycle
      || this.aiConfigurationGeneration !== token.configuration
      || this.aiSelectionGeneration !== token.selection) return false;
    const settings = this.dependencies.store.settings();
    return settings.aiEnabled === token.enabled
      && settings.aiEndpoint === token.endpoint
      && settings.aiModel === token.model
      && settings.secretId === token.secretId;
  }

  private applyAiDisplay(action: AiAction, text: string, targetSuggestionId?: string): void {
    this.restoreAiOverride();
    if (action === "explain-relation" && targetSuggestionId !== undefined) {
      const target = this.suggestions.find((suggestion) => suggestion.operation.id === targetSuggestionId);
      this.aiOverrideSuggestionId = targetSuggestionId;
      this.aiOriginalRationale = target?.rationale ?? null;
      this.suggestions = this.suggestions.map((suggestion) => suggestion.operation.id === targetSuggestionId
        ? Object.freeze({
            operation: suggestion.operation,
            localRationale: suggestion.localRationale,
            rationale: Object.freeze({ ...suggestion.localRationale, source: "ai-assisted" as const, summary: text }),
          })
        : suggestion);
    }
    this.model = {
      ...this.model,
      suggestions: clone(this.suggestions),
      aiSuggestion: { action, text },
    };
  }

  private clearAiDisplay(): void {
    if (this.model.aiSuggestion === undefined && this.aiOverrideSuggestionId === null) return;
    this.restoreAiOverride();
    if (this.model.aiSuggestion === undefined) {
      this.model = { ...this.model, suggestions: clone(this.suggestions) };
      return;
    }
    const { aiSuggestion: _removed, ...model } = this.model;
    this.model = { ...model, suggestions: clone(this.suggestions) };
  }

  private restoreAiOverride(): void {
    if (this.aiOverrideSuggestionId !== null && this.aiOriginalRationale !== null) {
      const id = this.aiOverrideSuggestionId;
      const rationale = this.aiOriginalRationale;
      this.suggestions = this.suggestions.map((suggestion) => suggestion.operation.id === id
        ? Object.freeze({ operation: suggestion.operation, localRationale: suggestion.localRationale, rationale })
        : suggestion);
    }
    this.aiOverrideSuggestionId = null;
    this.aiOriginalRationale = null;
  }

  private invalidateAiSelection(): void {
    this.aiSelectionGeneration += 1;
    this.clearAiDisplay();
  }

  private invalidateAiConfiguration(clearSecret: boolean): void {
    this.aiConfigurationGeneration += 1;
    if (clearSecret) this.#sessionAiSecret = null;
    this.clearAiDisplay();
  }

  private validatedVerificationLaunch(input: Readonly<{
    kind: "start" | "resume";
    cloudRoot: string;
    groupKeys: readonly string[];
    directorySelection?: CloudDirectorySelection;
  }>): VerificationLaunchRequest {
    if (input.groupKeys.length === 0) throw new RangeError("verification-group-required");
    const active = this.dependencies.catalog.hybrid?.snapshot().active;
    if (active === undefined) throw new Error("catalog-unavailable");
    const groupsByKey = new Map(active.groups.map((group) => [group.groupKey, group]));
    const groups: VerificationLaunchGroup[] = input.groupKeys.map((groupKey) => {
      const group = groupsByKey.get(groupKey);
      if (group === undefined) throw new Error("catalog-unavailable");
      return {
        groupKey,
        rootRelativePath: group.rootRelativePath,
        label: group.label,
        pdfCount: group.pdfCount,
      };
    });
    const normalized = this.validateCatalogScanRoot(input.cloudRoot);
    if (input.kind === "start" && isSelectedCategoryRoot(normalized, groups)) {
      throw new Error("invalid-large-catalog-root");
    }
    const request: VerificationLaunchRequest = input.kind === "start"
      ? {
          kind: "start",
          cloudRoot: normalized,
          groups,
          ...(input.directorySelection === undefined
            ? {}
            : { directorySelection: input.directorySelection }),
        }
      : { kind: "resume", cloudRoot: normalized, groups };
    return validateVerificationLaunchRequest(
      request,
      this.dependencies.catalogDirectorySelectionValidator,
    );
  }

  private async runVerifiedLaunch(input: Readonly<{
    kind: "start" | "resume";
    expectedRevision?: number;
    cloudRoot: string;
    groupKeys: readonly string[];
    directorySelection?: CloudDirectorySelection;
    confirm: boolean;
    onConfirmed?: () => void;
  }>, permit?: TaskActionPermit): Promise<void> {
    if (this.disposed) return;
    if (input.expectedRevision !== undefined) {
      if (
        permit === undefined
        || permit.revision !== input.expectedRevision
        || this.taskActionNonce !== permit.nonce
      ) throw new Error("task-action-stale");
    } else if (permit !== undefined) {
      throw new Error("task-action-stale");
    }
    await this.withCloudAuthorityPermit("verification-launch", async () => {
      this.assertNoLiveCloudExecution();
      this.assertTaskActionPermit(permit);
      this.clearVerificationHybridMessageSuppression();
      const hybrid = this.dependencies.catalog.hybrid;
      if (hybrid === undefined) throw new Error("catalog-unavailable");
      const batchAtLaunch = input.kind === "resume" ? hybrid.snapshot().batch : undefined;
      if (input.kind === "resume" && batchAtLaunch === undefined) {
        throw new HybridCatalogError("hybrid-batch-unavailable");
      }
      const groupKeys = input.kind === "resume"
        ? [...batchAtLaunch!.selectedGroupKeys]
        : [...input.groupKeys];
      if (
        input.kind === "resume"
        && input.expectedRevision === undefined
        && (
          input.groupKeys.length !== groupKeys.length
          || input.groupKeys.some((groupKey, index) => groupKey !== groupKeys[index])
        )
      ) throw new HybridCatalogError("hybrid-batch-unavailable");
      const launchInput = { ...input, groupKeys };
      const before = hybrid.snapshot();
      const alreadyLocked = this.lockedVerificationRoot !== null;
      let lockedForAttempt = false;
      try {
        let request = this.validatedVerificationLaunch(launchInput);
        if (request.kind === "start") {
          this.assertStartAuthority(request.cloudRoot, groupKeys);
        } else {
          this.assertResumeAuthority(request.cloudRoot, groupKeys);
        }
        if (input.confirm) {
          const confirmation = this.dependencies.catalogLargeScanConfirmation;
          if (confirmation === undefined) throw new Error("catalog-unavailable");
          const confirmed = await confirmation.request(request);
          if (this.disposed || !confirmed) return;
          this.assertTaskActionPermit(permit);
        }
        this.assertNoLiveCloudExecution();
        request = this.validatedVerificationLaunch(launchInput);
        if (request.kind === "start") {
          this.assertStartAuthority(request.cloudRoot, groupKeys);
        } else {
          this.assertResumeAuthority(request.cloudRoot, groupKeys);
        }
        this.assertTaskActionPermit(permit);
        input.onConfirmed?.();
        if (!alreadyLocked) {
          lockedForAttempt = true;
          this.lockVerificationRoot(request.cloudRoot);
        }
        if (request.kind === "start") {
          await hybrid.startLargeVerification({
            cloudRoot: request.cloudRoot,
            groupKeys: request.groups.map((group) => group.groupKey),
          });
        } else {
          await hybrid.resumeLargeVerification({
            cloudRoot: request.cloudRoot,
            groupKeys: request.groups.map((group) => group.groupKey),
          });
        }
        if (!this.disposed) await refreshCatalogProjection(this.dependencies.catalog);
        if (lockedForAttempt && !verificationBatchAdvanced(before, hybrid.snapshot())) {
          this.unlockVerificationRoot();
        }
        this.clearVerificationActionMessage();
      } catch (error) {
        if (lockedForAttempt) this.unlockVerificationRoot();
        if (
          error instanceof HybridCatalogError
          && error.code === "hybrid-cloud-root-mismatch"
        ) {
          this.unlockVerificationRoot();
          this.setVerificationActionMessage("hybrid-cloud-root-mismatch");
        }
        this.captureVerificationValidation(error);
        throw error;
      }
    });
  }

  private assertTaskActionPermit(permit: TaskActionPermit | undefined): void {
    if (permit === undefined) return;
    this.reconcileTaskProjection();
    if (
      this.taskActionNonce !== permit.nonce
      || this.model.taskActionRevision !== permit.revision
    ) throw new Error("task-action-stale");
  }

  private async withTaskActionPermit<T>(
    expectedRevision: number,
    action: (permit: TaskActionPermit) => Promise<T>,
  ): Promise<T> {
    if (this.taskActionNonce !== null) throw new Error("task-action-busy");
    if (expectedRevision !== this.model.taskActionRevision) {
      throw new Error("task-action-stale");
    }
    const nonce = Symbol("task-action");
    const permit = Object.freeze({ revision: expectedRevision, nonce });
    this.taskActionNonce = nonce;
    this.model = { ...this.model, taskActionPending: true };
    this.emit();
    try {
      return await action(permit);
    } finally {
      if (this.taskActionNonce === nonce) {
        this.taskActionNonce = null;
        if (!this.disposed) {
          this.model = { ...this.model, taskActionPending: false };
          this.emit();
        }
      }
    }
  }

  private async importCatalogTxtDraft(onConfirmed?: () => void): Promise<void> {
    const hybrid = this.dependencies.catalog.hybrid;
    const confirmation = this.dependencies.catalogTxtImportConfirmation;
    const draft = this.pendingCatalogTxt;
    const candidate = hybrid?.snapshot().candidate;
    if (hybrid === undefined || confirmation === undefined || draft === null) {
      throw new Error("catalog-unavailable");
    }
    if (candidate === undefined || candidate.sourceSha256 !== draft.sourceSha256) {
      this.pendingCatalogTxt = null;
      this.model = {
        ...this.model,
        pendingCatalogTxt: null,
        status: "error",
        statusMessage: "task.txtImportFailed",
      };
      this.emit();
      throw new HybridCatalogError("txt-source-invalid");
    }
    await this.withCloudAuthorityPermit("library-binding", async () => {
      const confirmed = await confirmation.request(clone(candidate));
      if (this.disposed || !confirmed) return;
      let result: Awaited<ReturnType<typeof hybrid.consumeTxtPreview>>;
      try {
        result = await hybrid.consumeTxtPreview({
          path: draft.path,
          expectedSourceSha256: draft.sourceSha256,
        });
      } catch (error) {
        if (!this.disposed) {
          const retainedCandidate = hybrid.snapshot().candidate;
          if (retainedCandidate?.sourceSha256 !== draft.sourceSha256) {
            this.pendingCatalogTxt = null;
          }
          this.model = {
            ...this.model,
            pendingCatalogTxt: this.pendingCatalogTxt === null
              ? null
              : clone(this.pendingCatalogTxt),
            status: "error",
            statusMessage: "task.txtImportFailed",
          };
          this.emit();
        }
        throw error;
      }
      if (this.disposed) return;
      onConfirmed?.();
      this.pendingCatalogTxt = null;
      this.model = {
        ...this.model,
        pendingCatalogTxt: null,
        status: "ready",
        statusMessage: result.kind === "unchanged" ? "task.txtContentUnchanged" : undefined,
      };
      this.emit();
      if (result.kind === "unchanged") return;

      this.disposeFolderSelection(true, false);

      // Activation is the one-use boundary. Revoke old scope in memory before
      // any fallible persistence/rebuild await so cleanup failure stays closed.
      this.installVerificationAuthority(null);
      const current = this.dependencies.store.settings();
      const replacement: CloudVerificationSettings = {
        boundCloudLibrary: null,
        cloudVerificationGeneration: current.cloudVerificationGeneration,
        verificationBatchTombstones: clone(current.verificationBatchTombstones),
        legacyVerificationAdoption: clone(current.legacyVerificationAdoption),
      };
      await this.dependencies.store.updateCloudVerificationSettings(replacement, {
        kind: "txt-source-replacement",
        currentWorkflowBatchId: null,
      });
      if (this.disposed) return;
      await hybrid.rebuildVerificationProjection();
      if (!this.disposed) await refreshCatalogProjection(this.dependencies.catalog);
    });
  }

  private currentFolderSelection(expectedRevision: number): FolderSelectionOwner | null {
    const owner = this.folderSelectionOwner;
    if (
      this.disposed
      || owner === null
      || this.model.folderSelection?.revision !== expectedRevision
    ) return null;
    return owner;
  }

  private nextFolderSelectionRevision(): number {
    this.folderSelectionRevision = this.folderSelectionRevision >= Number.MAX_SAFE_INTEGER
      ? 1
      : this.folderSelectionRevision + 1;
    return this.folderSelectionRevision;
  }

  private legacyInputForSelection(
    state: FolderSelectionRenderState["state"],
  ): LegacyAdoptionFailureToken | null {
    const active = this.dependencies.catalog.hybrid?.snapshot().active;
    const effectiveRoot = state.draftSelection?.effectiveRoot;
    if (
      active === undefined
      || active.legacyArtifactSetSha256 === null
      || effectiveRoot === undefined
    ) return null;
    let normalizedRoot: string;
    try {
      normalizedRoot = this.validateCatalogScanRoot(effectiveRoot);
    } catch {
      return null;
    }
    const selectedEffectiveRootSha256 = this.dependencies.cloudVerificationRootHasher(
      normalizedRoot,
    );
    if (selectedEffectiveRootSha256 === null) return null;
    return {
      selectedEffectiveRootSha256,
      activeSourceImportSha256: active.sourceImportSha256,
      legacyArtifactSetSha256: active.legacyArtifactSetSha256,
    };
  }

  private folderSelectionLegacyProgressMode(
    state: FolderSelectionRenderState["state"],
  ): FolderSelectionRenderState["legacyProgressMode"] {
    const adoption = this.dependencies.store.settings().legacyVerificationAdoption;
    if (adoption.state === "invalid") return "requires-fresh";
    if (adoption.state !== "pending") return "none";
    const input = this.legacyInputForSelection(state);
    return input !== null
      && sameLegacyAdoptionFailureToken(this.legacyAdoptionFailureToken, input)
      ? "requires-fresh"
      : "will-preserve";
  }

  private publishFolderSelection(owner: FolderSelectionOwner): void {
    if (
      this.disposed
      || this.folderSelectionOwner !== owner
      || owner.closeRequested
    ) return;
    let state: FolderSelectionRenderState["state"];
    try {
      state = clone(owner.driver.snapshot());
    } catch {
      this.disposeFolderSelection(true, true);
      return;
    }
    if (state.phase === "closed") {
      if (!owner.usePending) this.disposeFolderSelection(true, true);
      return;
    }
    this.model = { ...this.model, folderSelection: this.folderSelectionRenderState(state) };
    this.emit();
  }

  private folderSelectionRenderState(
    state: FolderSelectionRenderState["state"],
    feedbackCode?: FolderSelectionRenderState["feedbackCode"],
  ): FolderSelectionRenderState {
    return {
      revision: this.nextFolderSelectionRevision(),
      locale: this.model.locale,
      state,
      returnLabel: this.model.locale === "zh-CN" ? "云端核验" : "Cloud verification",
      legacyProgressMode: this.folderSelectionLegacyProgressMode(state),
      ...(feedbackCode === undefined ? {} : { feedbackCode }),
    };
  }

  private onFolderSelectionEmission(owner: FolderSelectionOwner): void {
    if (
      this.folderSelectionOwner !== owner
      || this.disposed
      || owner.closeRequested
    ) return;
    let phase: FolderSelectionRenderState["state"]["phase"];
    try {
      phase = owner.driver.snapshot().phase;
    } catch {
      this.disposeFolderSelection(true, true);
      return;
    }
    if (phase === "closed" && owner.usePending) return;
    if (phase === "closed") {
      this.disposeFolderSelection(true, true);
      return;
    }
    this.publishFolderSelection(owner);
  }

  private destroyFolderSelectionOwner(owner: FolderSelectionOwner): void {
    if (owner.driverDisposed) return;
    owner.driverDisposed = true;
    const unsubscribe = owner.unsubscribe;
    owner.unsubscribe = () => undefined;
    try { unsubscribe(); } catch { /* best-effort listener detachment */ }
    try { owner.driver.cancel(); } catch { /* driver lifecycle is fail-closed below */ }
    try { owner.driver.dispose(); } catch { /* no shared runtime is cleared by disposal */ }
  }

  private removeFolderSelectionModel(): void {
    const { folderSelection: _folderSelection, ...current } = this.model;
    this.model = current.route.tab === "task" && current.route.page === "folder-selection"
      ? { ...current, route: { tab: "task", page: "overview" } }
      : current;
  }

  private finalizeFolderSelectionOwner(
    owner: FolderSelectionOwner,
    clearFailureToken: boolean,
    emit: boolean,
  ): void {
    if (this.folderSelectionOwner !== owner) return;
    this.folderSelectionOwner = null;
    if (clearFailureToken) this.legacyAdoptionFailureToken = null;
    this.destroyFolderSelectionOwner(owner);
    this.removeFolderSelectionModel();
    if (emit && !this.disposed) this.emit();
  }

  private disposeFolderSelection(clearFailureToken: boolean, emit: boolean): void {
    const owner = this.folderSelectionOwner;
    if (clearFailureToken) this.legacyAdoptionFailureToken = null;
    if (owner !== null && owner.commitStarted && owner.usePending) {
      owner.closeRequested = true;
      this.destroyFolderSelectionOwner(owner);
      this.removeFolderSelectionModel();
      if (emit && !this.disposed) this.emit();
      return;
    }
    if (owner !== null) {
      this.finalizeFolderSelectionOwner(owner, clearFailureToken, emit);
      return;
    }
    this.removeFolderSelectionModel();
    if (emit && !this.disposed) this.emit();
  }

  private rebuildFolderSelection(
    previousOwner: FolderSelectionOwner,
    selectedPath: string,
    baseline: FolderBindingBaseline,
    feedbackCode?: FolderSelectionRenderState["feedbackCode"],
  ): void {
    if (
      this.disposed
      || this.folderSelectionOwner !== previousOwner
      || previousOwner.closeRequested
    ) return;
    const factory = this.dependencies.folderSelectionSessionFactory;
    const active = this.dependencies.catalog.hybrid?.snapshot().active;
    const purpose = clone(previousOwner.purpose);
    if (
      factory?.available !== true
      || active === undefined
      || active.sourceImportSha256 !== previousOwner.sourceImportSha256
      || active.legacyArtifactSetSha256 !== baseline.legacyArtifactSetSha256
      || folderSelectionPurposeKey(verificationPickerPurpose(active.groups))
        !== folderSelectionPurposeKey(purpose)
    ) {
      this.legacyAdoptionFailureToken = null;
      this.finalizeFolderSelectionOwner(previousOwner, false, true);
      throw folderSelectionStale();
    }
    let owner: FolderSelectionOwner | null = null;
    try {
      const driver = factory.create({ purpose: clone(purpose), initialPath: selectedPath });
      owner = {
        nonce: Symbol("folder-selection"),
        purpose,
        driver,
        sourceImportSha256: active.sourceImportSha256,
        unsubscribe: () => undefined,
        usePending: false,
        commitStarted: false,
        closeRequested: false,
        driverDisposed: false,
      };
      owner.unsubscribe = driver.subscribe(() => this.onFolderSelectionEmission(owner!));
      const state = clone(driver.snapshot());
      if (state.phase === "closed") throw new Error("folder-selection-rebuild-closed");
      const folderSelection = this.folderSelectionRenderState(state, feedbackCode);
      this.folderSelectionOwner = owner;
      this.destroyFolderSelectionOwner(previousOwner);
      this.model = { ...this.model, folderSelection };
      this.emit();
    } catch (error) {
      if (owner !== null) this.destroyFolderSelectionOwner(owner);
      this.finalizeFolderSelectionOwner(previousOwner, false, true);
      throw error;
    }
  }

  private captureFolderBindingBaseline(owner: FolderSelectionOwner): FolderBindingBaseline {
    const hybrid = this.dependencies.catalog.hybrid?.snapshot();
    const active = hybrid?.active;
    if (
      active === undefined
      || active.sourceImportSha256 !== owner.sourceImportSha256
    ) throw folderSelectionStale();
    return {
      activeSourceImportSha256: active.sourceImportSha256,
      legacyArtifactSetSha256: active.legacyArtifactSetSha256,
      groupsKey: folderSelectionPurposeKey(verificationPickerPurpose(active.groups)),
      settingsKey: cloudVerificationSettingsKey(this.dependencies.store.settings()),
      batchKey: JSON.stringify(hybrid?.batch ?? null),
    };
  }

  private assertFolderBindingBaseline(
    owner: FolderSelectionOwner,
    baseline: FolderBindingBaseline,
    permitNonce: symbol,
  ): void {
    this.assertNoLiveCloudExecution();
    const hybrid = this.dependencies.catalog.hybrid?.snapshot();
    const active = hybrid?.active;
    if (
      this.disposed
      || this.cloudAuthorityOperation?.nonce !== permitNonce
      || this.folderSelectionOwner !== owner
      || owner.nonce !== this.folderSelectionOwner.nonce
      || active === undefined
      || active.sourceImportSha256 !== baseline.activeSourceImportSha256
      || active.legacyArtifactSetSha256 !== baseline.legacyArtifactSetSha256
      || folderSelectionPurposeKey(verificationPickerPurpose(active.groups)) !== baseline.groupsKey
      || cloudVerificationSettingsKey(this.dependencies.store.settings()) !== baseline.settingsKey
      || JSON.stringify(hybrid?.batch ?? null) !== baseline.batchKey
    ) throw folderSelectionStale();
  }

  private folderBindingSnapshotMatchesBaseline(
    owner: FolderSelectionOwner,
    baseline: FolderBindingBaseline,
    permitNonce: symbol,
    snapshot: HybridCatalogViewModel | undefined,
  ): boolean {
    if (snapshot === undefined) return false;
    const active = snapshot.active;
    return !this.disposed
      && this.cloudAuthorityOperation?.nonce === permitNonce
      && this.folderSelectionOwner === owner
      && active !== undefined
      && snapshot.executionActive !== true
      && active.sourceImportSha256 === baseline.activeSourceImportSha256
      && active.legacyArtifactSetSha256 === baseline.legacyArtifactSetSha256
      && folderSelectionPurposeKey(verificationPickerPurpose(active.groups)) === baseline.groupsKey
      && JSON.stringify(snapshot.batch ?? null) === baseline.batchKey;
  }

  private folderBindingProjectionMatches(
    owner: FolderSelectionOwner,
    baseline: FolderBindingBaseline,
    permitNonce: symbol,
    selection: CloudDirectorySelection,
    replacement: CloudVerificationSettings,
    scope: CloudVerificationScope,
    expectedBatchId: string | null,
  ): boolean {
    const snapshot = this.dependencies.catalog.hybrid?.snapshot();
    if (snapshot === undefined) return false;
    const active = snapshot.active;
    if (
      this.disposed
      || this.cloudAuthorityOperation?.nonce !== permitNonce
      || this.folderSelectionOwner !== owner
      || active === undefined
      || snapshot.executionActive === true
      || active.sourceImportSha256 !== baseline.activeSourceImportSha256
      || active.legacyArtifactSetSha256 !== baseline.legacyArtifactSetSha256
      || folderSelectionPurposeKey(verificationPickerPurpose(active.groups)) !== baseline.groupsKey
      || !sameCloudVerificationSettings(
        cloudVerificationSettingsFrom(this.dependencies.store.settings()),
        replacement,
      )
    ) return false;
    const availableGroupKeys = new Set(active.groups.map((group) => group.groupKey));
    if (selection.kind === "category" && !availableGroupKeys.has(selection.groupKey)) {
      return false;
    }
    const batch = snapshot.batch;
    if ((batch?.batchId ?? null) !== expectedBatchId) return false;
    if (batch === undefined) return true;
    if (
      replacement.verificationBatchTombstones.state !== "valid"
      || replacement.verificationBatchTombstones.batchIds.includes(batch.batchId)
      || !cloudVerificationScopesEqual(batch.verificationScope, scope)
      || batch.selectedGroupCount !== batch.selectedGroupKeys.length
      || new Set(batch.selectedGroupKeys).size !== batch.selectedGroupKeys.length
      || batch.selectedGroupKeys.some((groupKey) => !availableGroupKeys.has(groupKey))
    ) return false;
    if (!batch.legacyPromotionRequired) return true;
    const adoption = replacement.legacyVerificationAdoption;
    return adoption.state === "adopted"
      && adoption.verificationGeneration === scope.generation
      && adoption.sourceImportSha256 === scope.sourceImportSha256
      && adoption.cloudRootSha256 === scope.cloudRootSha256
      && adoption.resumableBatch?.batchId === batch.batchId
      && adoption.resumableBatch.sourceImportSha256 === scope.sourceImportSha256
      && adoption.resumableBatch.cloudRootSha256 === scope.cloudRootSha256;
  }

  private async useFolderSelection(expectedRevision: number): Promise<void> {
    const owner = this.currentFolderSelection(expectedRevision);
    if (owner === null) return;
    await this.withCloudAuthorityPermit("library-binding", async (permitNonce) => {
      this.assertNoLiveCloudExecution();
      if (this.folderSelectionOwner !== owner) throw folderSelectionStale();
      const baseline = this.captureFolderBindingBaseline(owner);
      owner.usePending = true;
      let selection: CloudDirectorySelection | null = null;
      try {
        selection = await owner.driver.useSelection();
        if (selection === null) return;
        this.assertFolderBindingBaseline(owner, baseline, permitNonce);
        await this.commitFolderSelection(owner, baseline, permitNonce, selection);
      } catch (error) {
        const stale = bindingCasConflict(error)
          || (error instanceof Error && error.message === "folder-selection-stale");
        let recovered = false;
        if (
          selection !== null
          && this.folderSelectionOwner === owner
          && !owner.closeRequested
          && !this.disposed
        ) {
          try {
            this.rebuildFolderSelection(
              owner,
              selection.selectedPath,
              baseline,
              stale ? undefined : "binding-failed",
            );
            recovered = true;
          } catch { /* original binding failure remains authoritative */ }
        }
        if (
          selection !== null
          && !stale
          && !recovered
          && !owner.closeRequested
          && !this.disposed
          && this.model.folderSelection === undefined
        ) {
          this.model = {
            ...this.model,
            status: "ready",
            statusMessage: "folder-selection-binding-failed",
          };
          this.emit();
        }
        if (bindingCasConflict(error)) throw folderSelectionStale();
        throw error;
      } finally {
        if (this.folderSelectionOwner === owner) {
          owner.usePending = false;
          if (owner.closeRequested || this.disposed) {
            this.finalizeFolderSelectionOwner(owner, false, false);
          }
        }
      }
    });
  }

  private async commitFolderSelection(
    owner: FolderSelectionOwner,
    baseline: FolderBindingBaseline,
    permitNonce: symbol,
    selection: CloudDirectorySelection,
  ): Promise<void> {
    const hybrid = this.dependencies.catalog.hybrid;
    if (hybrid === undefined) throw new Error("catalog-unavailable");
    const before = hybrid.snapshot();
    const active = before.active;
    if (active === undefined) throw folderSelectionStale();
    const effectiveRoot = this.validateCatalogScanRoot(selection.effectiveRoot);
    if (
      selection.kind === "category"
      && !active.groups.some((group) => group.groupKey === selection.groupKey)
    ) throw folderSelectionStale();

    const currentSettings = this.dependencies.store.settings();
    const currentBindingRoot = currentSettings.boundCloudLibrary === null
      ? null
      : this.validateCatalogScanRoot(currentSettings.boundCloudLibrary.path);
    const rootChanged = currentBindingRoot !== null && currentBindingRoot !== effectiveRoot;
    const rotateGeneration = currentSettings.cloudVerificationGeneration === 0 || rootChanged;
    const nextGeneration = rotateGeneration
      ? checkedNextVerificationGeneration(currentSettings.cloudVerificationGeneration)
      : currentSettings.cloudVerificationGeneration;
    const proposedBinding = {
      schemaVersion: 1 as const,
      path: effectiveRoot,
      sourceImportSha256: active.sourceImportSha256,
      verificationGeneration: nextGeneration,
    };
    const proposedScope = deriveCloudVerificationScope(
      proposedBinding,
      this.dependencies.cloudVerificationRootHasher,
    );
    if (proposedScope === null) throw new RangeError("cloud-verification-root-unavailable");
    const legacyInput: LegacyAdoptionFailureToken | null = active.legacyArtifactSetSha256 === null
      ? null
      : {
          selectedEffectiveRootSha256: proposedScope.cloudRootSha256,
          activeSourceImportSha256: active.sourceImportSha256,
          legacyArtifactSetSha256: active.legacyArtifactSetSha256,
        };
    const forceFreshByInvalid = currentSettings.legacyVerificationAdoption.state === "invalid";
    const forceFreshByToken = legacyInput !== null
      && sameLegacyAdoptionFailureToken(this.legacyAdoptionFailureToken, legacyInput);
    const forceFreshLegacy = forceFreshByInvalid || forceFreshByToken;
    let preparedAdoption: LegacyVerificationAdoptionV1 | null = null;
    if (
      !forceFreshLegacy
      && currentSettings.cloudVerificationGeneration === 0
      && currentSettings.legacyVerificationAdoption.state === "pending"
    ) {
      try {
        preparedAdoption = await hybrid.prepareLegacyVerificationAdoption(proposedScope);
        this.assertFolderBindingBaseline(owner, baseline, permitNonce);
        await hybrid.revalidatePreparedLegacyAdoption(preparedAdoption);
        this.assertFolderBindingBaseline(owner, baseline, permitNonce);
      } catch (error) {
        this.assertFolderBindingBaseline(owner, baseline, permitNonce);
        if (!deterministicLegacyAdoptionConflict(error)) throw error;
        if (legacyInput === null) {
          throw new RangeError("legacy-adoption-input-unavailable");
        }
        this.legacyAdoptionFailureToken = legacyInput;
        this.rebuildFolderSelection(owner, selection.selectedPath, baseline);
        return;
      }
    }

    this.assertFolderBindingBaseline(owner, baseline, permitNonce);
    const latest = hybrid.snapshot();
    const latestActive = latest.active;
    const latestLegacyInput: LegacyAdoptionFailureToken | null = latestActive?.legacyArtifactSetSha256 == null
      ? null
      : {
          selectedEffectiveRootSha256: proposedScope.cloudRootSha256,
          activeSourceImportSha256: latestActive.sourceImportSha256,
          legacyArtifactSetSha256: latestActive.legacyArtifactSetSha256,
        };
    if (
      forceFreshByToken
      && !sameLegacyAdoptionFailureToken(this.legacyAdoptionFailureToken, latestLegacyInput)
    ) {
      this.legacyAdoptionFailureToken = null;
      this.rebuildFolderSelection(owner, selection.selectedPath, baseline);
      return;
    }

    const batch = latest.batch;
    const currentBatchId = batch !== undefined && batch.status !== "complete"
      ? batch.batchId
      : null;
    const adoptedBatchId = preparedAdoption?.state === "adopted"
      ? preparedAdoption.resumableBatch?.batchId ?? null
      : legacyAllowlistFor(
          currentSettings.legacyVerificationAdoption,
          proposedScope,
        )?.resumableBatch?.batchId ?? null;
    const repairingCurrentBatch = currentBatchId !== null
      && deriveLibraryWorkflowState({
        connection: this.dependencies.catalog.connection?.snapshot(),
        hybrid: latest,
        boundCloudLibrary: currentSettings.boundCloudLibrary,
        cloudVerificationGeneration: currentSettings.cloudVerificationGeneration,
        verificationBatchTombstones: currentSettings.verificationBatchTombstones,
        legacyVerificationAdoption: currentSettings.legacyVerificationAdoption,
        pendingCatalogTxt: this.pendingCatalogTxt,
        cloudVerificationRootHasher: this.dependencies.cloudVerificationRootHasher,
        capabilityAvailable: latest.status !== "unavailable",
      }).kind === "repair-library";
    const requiresBatchRepair = rootChanged
      || forceFreshLegacy
      || repairingCurrentBatch
      || currentSettings.verificationBatchTombstones.state === "invalid";
    const adoptedBatchExempt = !rootChanged
      && !forceFreshLegacy
      && !repairingCurrentBatch
      && currentBatchId !== null
      && currentBatchId === adoptedBatchId;
    const currentWorkflowBatchId = requiresBatchRepair && !adoptedBatchExempt
      ? currentBatchId
      : null;
    const expectedPostBatchId = adoptedBatchId ?? (
      currentBindingRoot === effectiveRoot
      && !forceFreshLegacy
      && !repairingCurrentBatch
      && currentSettings.verificationBatchTombstones.state === "valid"
        ? latest.batch?.batchId ?? null
        : null
    );
    const replacement: CloudVerificationSettings = {
      boundCloudLibrary: proposedBinding,
      cloudVerificationGeneration: nextGeneration,
      legacyVerificationAdoption: forceFreshLegacy
        ? { schemaVersion: 1, state: "ineligible" }
        : preparedAdoption
          ?? (currentSettings.legacyVerificationAdoption.state === "pending"
            ? { schemaVersion: 1, state: "none" }
            : clone(currentSettings.legacyVerificationAdoption)),
      verificationBatchTombstones: repairVerificationBatchTombstones(
        currentSettings.verificationBatchTombstones,
        currentWorkflowBatchId,
      ),
    };
    this.assertFolderBindingBaseline(owner, baseline, permitNonce);
    owner.commitStarted = true;
    await this.dependencies.store.updateCloudVerificationSettings(replacement, {
      kind: "library-binding",
      currentWorkflowBatchId,
    });
    this.legacyAdoptionFailureToken = null;

    if (this.disposed) return;

    const saved = this.dependencies.store.settings();
    if (!sameCloudVerificationSettings(cloudVerificationSettingsFrom(saved), replacement)) {
      this.installVerificationAuthority(scopedAuthorityForSettings(
        saved,
        this.dependencies.cloudVerificationRootHasher,
      ));
      throw folderSelectionStale();
    }
    const beforeProjectionMatches = this.folderBindingSnapshotMatchesBaseline(
      owner,
      baseline,
      permitNonce,
      hybrid.snapshot(),
    );
    const authority = scopedAuthorityForSettings(
      saved,
      this.dependencies.cloudVerificationRootHasher,
    );
    if (authority === null) throw folderSelectionStale();
    try {
      this.installVerificationAuthority(authority);
      await hybrid.rebuildVerificationProjection();
      if (this.disposed) return;
      await refreshCatalogProjection(this.dependencies.catalog);
      if (this.disposed) return;
    } catch (error) {
      if (this.disposed) return;
      const durableSettings = this.dependencies.store.settings();
      this.installVerificationAuthority(scopedAuthorityForSettings(
        durableSettings,
        this.dependencies.cloudVerificationRootHasher,
      ));
      throw error;
    }

    const durableSettings = this.dependencies.store.settings();
    if (!sameCloudVerificationSettings(
      cloudVerificationSettingsFrom(durableSettings),
      replacement,
    )) {
      const durableAuthority = scopedAuthorityForSettings(
        durableSettings,
        this.dependencies.cloudVerificationRootHasher,
      );
      this.installVerificationAuthority(durableAuthority);
      await hybrid.rebuildVerificationProjection();
      throw folderSelectionStale();
    }
    if (
      !beforeProjectionMatches
      || !this.folderBindingProjectionMatches(
        owner,
        baseline,
        permitNonce,
        selection,
        replacement,
        proposedScope,
        expectedPostBatchId,
      )
    ) throw folderSelectionStale();
    if (owner.closeRequested) return;
    const afterActive = hybrid.snapshot().active;
    if (afterActive === undefined) throw folderSelectionStale();
    const availableGroupKeys = new Set(afterActive.groups.map((group) => group.groupKey));
    const selectedVerificationGroupKeys = selection.kind === "category"
      ? [selection.groupKey]
      : this.model.selectedVerificationGroupKeys.filter((groupKey) => (
          availableGroupKeys.has(groupKey)
        ));
    this.finalizeFolderSelectionOwner(owner, false, false);
    const {
      verificationActionMessageCode: _verificationActionMessageCode,
      statusMessage: _statusMessage,
      ...currentModel
    } = this.model;
    this.model = {
      ...currentModel,
      status: "ready",
      ...(preparedAdoption?.state === "adopted"
        ? { statusMessage: "folder-selection-preserved" }
        : {}),
      verificationRoot: effectiveRoot,
      verificationDirectorySelection: clone(selection),
      selectedVerificationGroupKeys,
    };
    this.emit();
  }

  private async withCloudAuthorityPermit<T>(
    kind: CloudAuthorityOperation,
    action: (nonce: symbol) => Promise<T>,
  ): Promise<T> {
    if (this.cloudAuthorityOperation !== null) {
      this.assertNoLiveCloudExecution();
      this.failCloudAuthorityOperation("cloud-authority-operation-busy");
    }
    const nonce = Symbol(kind);
    this.cloudAuthorityOperation = Object.freeze({ kind, nonce });
    try {
      return await action(nonce);
    } finally {
      if (this.cloudAuthorityOperation?.nonce === nonce) {
        this.cloudAuthorityOperation = null;
      }
    }
  }

  private assertNoLiveCloudExecution(): void {
    if (this.dependencies.catalog.hybrid?.snapshot().executionActive === true) {
      this.failCloudAuthorityOperation("verification-must-pause");
    }
    if (this.dependencies.catalog.connection?.snapshot().status === "scanning") {
      this.failCloudAuthorityOperation("scan-must-cancel");
    }
  }

  private failCloudAuthorityOperation(
    code: "verification-must-pause" | "scan-must-cancel" | "cloud-authority-operation-busy",
  ): never {
    if (!this.disposed) {
      this.model = { ...this.model, status: "ready", statusMessage: code };
      this.emit();
    }
    throw new Error(code);
  }

  private clearCatalogDirectorySessions(): void {
    this.dependencies.catalog.directoryLocator?.cancel();
    this.dependencies.catalog.directoryDiscovery?.clear();
    this.dependencies.catalog.directoryBrowser?.clear();
  }

  private async replaceCatalogIdentityAuthority(): Promise<number> {
    const current = this.dependencies.store.settings();
    if (current.cloudVerificationGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("cloud-verification-generation-overflow");
    }
    const nextGeneration = current.cloudVerificationGeneration + 1;
    const batch = this.dependencies.catalog.hybrid?.snapshot().batch;
    const currentWorkflowBatchId = batch !== undefined && batch.status !== "complete"
      ? batch.batchId
      : null;
    const replacement: CloudVerificationSettings = {
      boundCloudLibrary: null,
      cloudVerificationGeneration: nextGeneration,
      verificationBatchTombstones: repairVerificationBatchTombstones(
        current.verificationBatchTombstones,
        currentWorkflowBatchId,
      ),
      legacyVerificationAdoption: current.legacyVerificationAdoption.state === "pending"
        || current.legacyVerificationAdoption.state === "invalid"
        ? { schemaVersion: 1, state: "ineligible" }
        : clone(current.legacyVerificationAdoption),
    };
    await this.dependencies.store.updateCloudVerificationSettings(replacement, {
      kind: "identity-replacement",
      currentWorkflowBatchId,
    });
    if (this.disposed) return nextGeneration;

    this.disposeFolderSelection(true, false);
    this.pendingCatalogTxt = null;
    this.catalogAuthorizationAttempt = null;
    this.lockedVerificationRoot = null;
    const {
      verificationDirectorySelection: _verificationDirectorySelection,
      verificationActionMessageCode: _verificationActionMessageCode,
      ...currentModel
    } = this.model;
    this.model = {
      ...currentModel,
      pendingCatalogTxt: null,
      verificationRoot: "",
      verificationRootLocked: false,
      selectedVerificationGroupKeys: [],
    };
    this.installVerificationAuthority(null);
    this.emit();
    const hybrid = this.dependencies.catalog.hybrid;
    if (hybrid !== undefined) await hybrid.rebuildVerificationProjection();
    return nextGeneration;
  }

  private assertStartAuthority(rootPath: string, groupKeys: readonly string[]): void {
    const normalized = this.validateCatalogScanRoot(rootPath);
    const settings = this.dependencies.store.settings();
    const active = this.dependencies.catalog.hybrid?.snapshot().active;
    const binding = settings.boundCloudLibrary;
    if (
      active === undefined
      || binding === null
      || settings.cloudVerificationGeneration < 1
      || binding.verificationGeneration !== settings.cloudVerificationGeneration
      || binding.sourceImportSha256 !== active.sourceImportSha256
      || this.validateCatalogScanRoot(binding.path) !== normalized
      || settings.verificationBatchTombstones.state !== "valid"
      || settings.legacyVerificationAdoption.state === "pending"
      || settings.legacyVerificationAdoption.state === "invalid"
      || groupKeys.length < 1
      || groupKeys.length > LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups
      || new Set(groupKeys).size !== groupKeys.length
      || groupKeys.some((groupKey) => !active.groups.some((group) => group.groupKey === groupKey))
    ) throw new HybridCatalogError("hybrid-batch-unavailable");
  }

  private assertResumeAuthority(rootPath: string, groupKeys: readonly string[]): void {
    const normalized = this.validateCatalogScanRoot(rootPath);
    const settings = this.dependencies.store.settings();
    const hybrid = this.dependencies.catalog.hybrid?.snapshot();
    const active = hybrid?.active;
    const batch = hybrid?.batch;
    const binding = settings.boundCloudLibrary;
    if (
      hybrid === undefined
      || active === undefined
      || batch === undefined
      || batch.resumeAvailable !== true
      || binding === null
      || settings.cloudVerificationGeneration < 1
      || binding.verificationGeneration !== settings.cloudVerificationGeneration
      || binding.sourceImportSha256 !== active.sourceImportSha256
      || this.validateCatalogScanRoot(binding.path) !== normalized
      || settings.verificationBatchTombstones.state !== "valid"
      || settings.verificationBatchTombstones.batchIds.includes(batch.batchId)
      || settings.legacyVerificationAdoption.state === "pending"
      || settings.legacyVerificationAdoption.state === "invalid"
      || batch.selectedGroupCount !== groupKeys.length
      || batch.selectedGroupKeys.length !== groupKeys.length
      || groupKeys.some((groupKey, index) => batch.selectedGroupKeys[index] !== groupKey)
      || groupKeys.some((groupKey) => !active.groups.some((group) => group.groupKey === groupKey))
    ) throw new HybridCatalogError("hybrid-batch-unavailable");
    const scope = deriveCloudVerificationScope(
      binding,
      this.dependencies.cloudVerificationRootHasher,
    );
    if (scope === null || !cloudVerificationScopesEqual(batch.verificationScope, scope)) {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    if (!batch.legacyPromotionRequired) return;
    const adoption = settings.legacyVerificationAdoption;
    if (
      adoption.state !== "adopted"
      || adoption.verificationGeneration !== scope.generation
      || adoption.sourceImportSha256 !== scope.sourceImportSha256
      || adoption.cloudRootSha256 !== scope.cloudRootSha256
      || adoption.resumableBatch === null
      || adoption.resumableBatch.batchId !== batch.batchId
      || adoption.resumableBatch.sourceImportSha256 !== scope.sourceImportSha256
      || adoption.resumableBatch.cloudRootSha256 !== scope.cloudRootSha256
    ) throw new HybridCatalogError("hybrid-batch-unavailable");
  }

  private taskProjectionSemanticKey(
    settings: PluginSettings,
    connection: CloudCatalogConnectionViewModel | undefined,
    hybrid: HybridCatalogViewModel | undefined,
    primaryAction: WorkbenchViewModel["workflow"]["primaryAction"],
  ): string {
    const batch = hybrid?.batch;
    const tombstones = settings.verificationBatchTombstones;
    const currentBatchSuperseded = batch !== undefined
      && tombstones.state === "valid"
      && tombstones.batchIds.includes(batch.batchId);
    return JSON.stringify({
      activeSourceImportSha256: hybrid?.active?.sourceImportSha256 ?? null,
      pendingSourceImportSha256: this.pendingCatalogTxt?.sourceSha256 ?? null,
      boundSourceImportSha256: settings.boundCloudLibrary?.sourceImportSha256 ?? null,
      boundRoot: settings.boundCloudLibrary?.path ?? null,
      authorityGeneration: settings.cloudVerificationGeneration,
      legacyAdoptionStateAndFingerprint: settings.legacyVerificationAdoption,
      primaryAction,
      selectedGroupKeys: this.model?.selectedVerificationGroupKeys ?? [],
      batchId: batch?.batchId ?? null,
      runOrdinal: batch?.runOrdinal ?? null,
      hybridMessageCode: hybrid?.messageCode ?? null,
      connectionMessageCode: connection?.messageCode ?? null,
      currentBatchSuperseded,
      verificationBatchTombstoneState: tombstones,
    });
  }

  private reconcileTaskProjection(): void {
    const settings = this.dependencies.store.settings();
    const connection = this.dependencies.catalog.connection?.snapshot();
    const hybrid = this.dependencies.catalog.hybrid?.snapshot();
    const workflow = deriveLibraryWorkflowState({
      connection,
      hybrid,
      boundCloudLibrary: settings.boundCloudLibrary,
      cloudVerificationGeneration: settings.cloudVerificationGeneration,
      verificationBatchTombstones: settings.verificationBatchTombstones,
      legacyVerificationAdoption: settings.legacyVerificationAdoption,
      pendingCatalogTxt: this.pendingCatalogTxt,
      cloudVerificationRootHasher: this.dependencies.cloudVerificationRootHasher,
      capabilityAvailable: hybrid !== undefined && hybrid.status !== "unavailable",
    });
    const semanticKey = this.taskProjectionSemanticKey(
      settings,
      connection,
      hybrid,
      workflow.primaryAction,
    );
    const taskActionRevision = semanticKey === this.taskSemanticKey
      ? this.model.taskActionRevision
      : this.model.taskActionRevision >= Number.MAX_SAFE_INTEGER
        ? 1
        : this.model.taskActionRevision + 1;
    this.taskSemanticKey = semanticKey;
    this.model = {
      ...this.model,
      pendingCatalogTxt: this.pendingCatalogTxt === null ? null : clone(this.pendingCatalogTxt),
      taskActionPending: this.taskActionNonce !== null,
      taskActionRevision,
      workflow,
    };
  }

  private installVerificationAuthority(authority: CloudVerificationAuthority | null): void {
    if (this.dependencies.catalog.setVerificationAuthority !== undefined) {
      this.dependencies.catalog.setVerificationAuthority(authority);
      return;
    }
    this.dependencies.catalog.hybrid?.setVerificationAuthority(authority);
  }

  private emit(): void {
    if (this.disposed) return;
    this.reconcileTaskProjection();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A view failure must not corrupt index, queue, or persisted controller state.
      }
    }
  }
}
