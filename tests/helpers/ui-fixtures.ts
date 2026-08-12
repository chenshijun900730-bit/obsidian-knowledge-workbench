import type { WorkbenchActions, WorkbenchViewModel } from "../../src/ui/workbench-view";
import type { CloudCatalogRuntime } from "../../src/catalog/cloud-catalog-runtime";
import { FakeCloudCatalogRuntime } from "../fakes/fake-cloud-catalog-runtime";
import { FakeCatalogScanConfirmationPresenter } from "../fakes/fake-cloud-catalog-runtime";
import type { CatalogScanConfirmationPresenter } from "../../src/ui/catalog-scan-confirmation-modal";
import type { CatalogTxtImportConfirmationPresenter } from "../../src/ui/catalog-txt-import-confirmation-modal";
import type { CatalogLargeScanConfirmationPresenter } from "../../src/ui/catalog-large-scan-confirmation-modal";
import { ClassificationService } from "../../src/classification/classification-service";
import type { AiClientPort, Clock, VaultReadPort, WorkspacePort } from "../../src/core/ports";
import type { AiPayloadPreview } from "../../src/ui/ai-payload-preview-modal";
import type { DocumentRecord } from "../../src/core/types";
import type { IncrementalIndexQueue } from "../../src/indexing/incremental-index-queue";
import type { IndexService, ScanProgress } from "../../src/indexing/index-service";
import type { FocusMapInput, FocusedMap, MapSearchResult, MapService } from "../../src/map/map-service";
import type { PluginDataStore } from "../../src/storage/plugin-data-store";
import type { OperationalState, PluginSettings } from "../../src/storage/plugin-data";
import { TodayService } from "../../src/today/today-service";
import { SuggestionService, type RationaleEnhancer } from "../../src/suggestions/suggestion-service";
import { ChangePlanService, type ConfirmedPlan, type PlanPreview } from "../../src/plans/change-plan-service";
import type { ExecutionResult } from "../../src/transactions/transaction-service";
import type { JournalEntry } from "../../src/transactions/operation-journal";
import { WorkbenchController } from "../../src/ui/workbench-controller";
import type { App, CachedMetadata, EventRef, TAbstractFile, TFile, TFolder } from "obsidian";
import { ObsidianVaultAdapter } from "../../src/adapters/obsidian-vault-adapter";
import { ObsidianQuickCaptureAdapter } from "../../src/adapters/obsidian-quick-capture-adapter";
import type { VaultEvent } from "../../src/core/ports";
import { FakeVault } from "../fakes/fake-vault";
import { NORMAL_RUNTIME_POLICY, type RuntimeSafetyPolicy } from "../../src/runtime/safety-policy";

/** Structural contract for the production dependency that Task 2 will expose. */
export interface ProjectionSchedulerDependency {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ManualProjectionScheduler {
  readonly dependency: ProjectionSchedulerDependency;
  readonly pendingCount: number;
  readonly scheduleCalls: number;
  advanceBy(milliseconds: number): void;
  drain(): void;
}

export function manualProjectionScheduler(): ManualProjectionScheduler {
  interface ScheduledCallback {
    readonly handle: object;
    readonly callback: () => void;
    readonly dueAt: number;
    readonly order: number;
  }

  let now = 0;
  let order = 0;
  let scheduleCalls = 0;
  const pending = new Map<object, ScheduledCallback>();
  const nextDue = (atMost = Number.POSITIVE_INFINITY): ScheduledCallback | undefined => [...pending.values()]
    .filter((entry) => entry.dueAt <= atMost)
    .sort((left, right) => left.dueAt - right.dueAt || left.order - right.order)[0];
  const dependency: ProjectionSchedulerDependency = {
    now: () => now,
    schedule(callback, delayMs) {
      scheduleCalls += 1;
      const handle = {};
      pending.set(handle, {
        handle,
        callback,
        dueAt: now + Math.max(0, delayMs),
        order: order++,
      });
      return handle;
    },
    cancel(handle) {
      if (typeof handle === "object" && handle !== null) pending.delete(handle);
    },
  };
  const scheduler: ManualProjectionScheduler = {
    dependency,
    get pendingCount() { return pending.size; },
    get scheduleCalls() { return scheduleCalls; },
    advanceBy(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError("Manual scheduler advance must be a finite non-negative duration");
      }
      const target = now + milliseconds;
      let due = nextDue(target);
      while (due !== undefined) {
        now = due.dueAt;
        pending.delete(due.handle);
        due.callback();
        due = nextDue(target);
      }
      now = target;
    },
    drain() {
      let turns = 0;
      let due = nextDue();
      while (due !== undefined) {
        if (turns++ >= 10_000) throw new Error("Manual scheduler did not settle");
        scheduler.advanceBy(Math.max(0, due.dueAt - now));
        due = nextDue();
      }
    },
  };
  return scheduler;
}

export function populatedWorkbenchModel(): WorkbenchViewModel {
  return {
    locale: "zh-CN",
    status: "ready",
    activeTab: "workbench",
    startSection: "overview",
    catalog: {
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
    },
    verificationRoot: "",
    verificationRootLocked: false,
    selectedVerificationGroupKeys: [],
    selectedCatalogId: null,
    catalogFiltersExpanded: false,
    todayFilter: "all",
    today: {
      newItems: [{
        id: "a",
        path: "Notes/Alpha.md",
        title: "Alpha",
        kind: "note",
        reason: "unclassified",
        explanation: "Recently added",
        actionLabel: "Review note",
        score: 600,
        activityAt: 10,
      }],
      continueItems: [{
        id: "b",
        path: "References/Beta.md",
        title: "Beta",
        kind: "reference",
        reason: "recently-opened",
        explanation: "Opened recently",
        actionLabel: "Continue note",
        score: 80,
        activityAt: 9,
      }],
      nextItems: [],
    },
    suggestions: [],
    history: { entries: [] },
    map: {
      nodes: [
        { id: "a", nodeType: "document", path: "Notes/Alpha.md", title: "Alpha", kind: "note", shape: "circle" },
        { id: "b", nodeType: "document", path: "References/Beta.md", title: "Beta", kind: "reference", shape: "square" },
        { id: "topic:systems", nodeType: "topic", title: "Systems", kind: "topic", shape: "diamond" },
      ],
      edges: [
        { sourceId: "a", targetId: "b", score: 80, reasons: [{ code: "explicit-link", weight: 80 }], confirmed: true },
      ],
      selected: {
        nodeId: "a",
        path: "Notes/Alpha.md",
        topics: ["Systems"],
        connectedNodeIds: ["b"],
        relations: [
          { nodeId: "b", explanation: "explicit link (80)", confirmed: true },
          { nodeId: "topic:systems", explanation: "shared phrase (20)", confirmed: false },
        ],
      },
      truncated: false,
    },
    mapFilter: "all",
    searchQuery: "alpha",
    searchResults: [{ documentId: "a", path: "Notes/Alpha.md", title: "Alpha", matchedBy: ["title"] }],
    scanProgress: { status: "idle", completed: 0, label: "Index" },
    mapProgress: { status: "idle", completed: 0, label: "Map" },
  };
}

export function noOpWorkbenchActions(overrides: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return {
    onSelectTab: () => undefined,
    onSelectStartSection: () => undefined,
    onSelectTodayFilter: () => undefined,
    onSelectMapFilter: () => undefined,
    onOpenNote: () => undefined,
    onQuickCapture: () => undefined,
    onCancelScan: () => undefined,
    onCancelMap: () => undefined,
    onPin: () => undefined,
    onDismiss: () => undefined,
    onSearchMap: () => undefined,
    onSelectCenter: () => undefined,
    onPreviewSuggestion: () => undefined,
    onPreviewSuggestionIds: () => undefined,
    onRetryScan: () => undefined,
    onUndoHistory: () => undefined,
    onViewRecovery: () => undefined,
    onClearHistory: () => undefined,
    onExportHistory: () => undefined,
    onSummarize: () => undefined,
    onNameCluster: () => undefined,
    onExplainRelation: () => undefined,
    onSuggestLabels: () => undefined,
    onSuggestionSelectionChange: () => undefined,
    onSearchCatalog: () => undefined,
    onFilterCatalogFolder: () => undefined,
    onToggleCatalogStatus: () => undefined,
    onToggleCatalogDifference: () => undefined,
    onFilterCatalogGroup: () => undefined,
    onFilterCatalogTag: () => undefined,
    onToggleCatalogCloudMissing: () => undefined,
    onCatalogPage: () => undefined,
    onCopyCatalogFilename: () => undefined,
    onCopyCatalogPath: () => undefined,
    onOpenBaidu: () => undefined,
    onSelectCatalogRecord: () => undefined,
    onSetCatalogFiltersExpanded: () => undefined,
    onSetVerificationRoot: () => undefined,
    onToggleVerificationGroup: () => undefined,
    onStartSelectedVerification: async () => undefined,
    onResumeSelectedVerification: async () => undefined,
    onCancelSelectedVerification: () => undefined,
    ...overrides,
  };
}

const record = (id: string, path: string, kind: DocumentRecord["kind"]): DocumentRecord => ({
  id,
  path,
  basename: path.split("/").at(-1)?.replace(/\.md$/u, "") ?? id,
  kind,
  title: id === "a" ? "Alpha" : "Beta",
  aliases: [],
  headings: id === "a" ? ["Alpha heading"] : [],
  tags: [],
  ownedFields: {},
  relationFields: {},
  outgoingLinks: [],
  tokens: id === "a" ? ["alpha"] : ["beta"],
  mtime: 10,
  size: 10,
  contentHash: id,
});

const RECORDS: readonly DocumentRecord[] = [
  record("a", "Notes/Alpha.md", "note"),
  record("b", "References/Beta.md", "reference"),
];

const defaultSettings = (): PluginSettings => ({
  writeEnabled: false,
  writePreviewAcknowledged: false,
  locale: "zh-CN",
  openAtStartup: false,
  folderRules: [],
  excludedPrefixes: [],
  aiEnabled: false,
  aiEndpoint: "",
  aiModel: "",
  secretId: "",
});

const defaultOperational = (): OperationalState => ({ pins: {}, dismissals: {}, lastOpened: {}, journals: [] });
const detached = <T>(value: T): T => structuredClone(value);

class FixtureStore {
  failNext: Error | null = null;
  readonly saveSettingsCalls: PluginSettings[] = [];
  private settingsValue = defaultSettings();
  private operationalValue = defaultOperational();
  private active: { builtAt: number; records: readonly DocumentRecord[] } | null;

  constructor(active: boolean, private readonly records: readonly DocumentRecord[] = RECORDS) {
    this.active = active ? { builtAt: 1, records: detached(records) } : null;
  }

  settings(): PluginSettings { return detached(this.settingsValue); }
  setSettingsForTest(settings: PluginSettings): void { this.settingsValue = detached(settings); }
  operational(): OperationalState { return detached(this.operationalValue); }
  activeIndex(): { builtAt: number; records: readonly DocumentRecord[] } | null { return detached(this.active); }
  promoteForTest(): void { this.active = { builtAt: 100, records: detached(this.records) }; }

  async saveSettings(settings: PluginSettings): Promise<void> {
    this.saveSettingsCalls.push(detached(settings));
    this.throwIfFailing();
    this.settingsValue = detached(settings);
  }

  async setPin(id: string, pinnedAt: number | null): Promise<void> {
    this.throwIfFailing();
    const pins = { ...this.operationalValue.pins };
    if (pinnedAt === null) delete pins[id];
    else pins[id] = pinnedAt;
    this.operationalValue = { ...this.operationalValue, pins };
  }

  async setDismissal(id: string, value: { readonly dismissedAt: number; readonly mtime: number } | null): Promise<void> {
    this.throwIfFailing();
    const dismissals = { ...this.operationalValue.dismissals };
    if (value === null) delete dismissals[id];
    else dismissals[id] = detached(value);
    this.operationalValue = { ...this.operationalValue, dismissals };
  }

  async setLastOpened(id: string, openedAt: number): Promise<void> {
    this.throwIfFailing();
    this.operationalValue = {
      ...this.operationalValue,
      lastOpened: { ...this.operationalValue.lastOpened, [id]: openedAt },
    };
  }

  private throwIfFailing(): void {
    if (this.failNext === null) return;
    const error = this.failNext;
    this.failNext = null;
    throw error;
  }
}

interface ScanDeferred {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

class FixtureIndex {
  buildCalls = 0;
  reconcileCalls = 0;
  private scan: ScanDeferred | null = null;
  private records: readonly DocumentRecord[];
  private readonly listeners = new Set<(records: readonly DocumentRecord[]) => void>();

  constructor(
    private readonly store: FixtureStore,
    private readonly pauseScan: boolean,
    private readonly scanError?: Error,
    private readonly reconcileError?: Error,
    records: readonly DocumentRecord[] = RECORDS,
  ) { this.records = detached(records); }

  activeRecords(): readonly DocumentRecord[] { return this.records; }
  subscribe(listener: (records: readonly DocumentRecord[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async reconcilePathPolicy(): Promise<void> {
    this.reconcileCalls += 1;
    if (this.reconcileError !== undefined) throw this.reconcileError;
  }
  publishRecords(records: readonly DocumentRecord[]): void {
    this.records = detached(records);
    for (const listener of this.listeners) listener(this.records);
  }

  async buildInitial(signal: AbortSignal, onProgress: (progress: ScanProgress) => void): Promise<void> {
    this.buildCalls += 1;
    const first = this.records[0];
    if (first !== undefined) onProgress({ completed: 1, total: this.records.length, path: first.path });
    if (this.scanError !== undefined) throw this.scanError;
    if (this.pauseScan) {
      await new Promise<void>((resolve, reject) => {
        const rejectAbort = (): void => reject(new DOMException("canceled", "AbortError"));
        signal.addEventListener("abort", rejectAbort, { once: true });
        this.scan = {
          resolve: () => {
            signal.removeEventListener("abort", rejectAbort);
            this.store.promoteForTest();
            resolve();
          },
          reject: (error) => {
            signal.removeEventListener("abort", rejectAbort);
            reject(error);
          },
        };
      });
      return;
    }
    if (signal.aborted) throw new DOMException("canceled", "AbortError");
    this.store.promoteForTest();
  }

  resolveScan(): void { this.scan?.resolve(); }
  rejectScan(error: Error): void { this.scan?.reject(error); }
}

class FixtureQueue {
  pauseCalls = 0;
  resumeCalls = 0;

  constructor(private readonly flushError?: Error) {}
  async pauseAutoFlush(): Promise<void> { this.pauseCalls += 1; }
  async resumeAndFlush(): Promise<void> {
    this.resumeCalls += 1;
    if (this.flushError !== undefined) throw this.flushError;
  }
}

interface MapRequest {
  readonly input: FocusMapInput;
  readonly progress: (completed: number) => void;
  readonly resolve: (map: FocusedMap) => void;
  readonly reject: (error: Error) => void;
}

class FixtureMap {
  readonly inputs: FocusMapInput[] = [];
  private readonly requests: MapRequest[] = [];

  constructor(private readonly pauseMap: boolean) {}

  search(records: readonly DocumentRecord[], query: string): readonly MapSearchResult[] {
    const normalized = query.toLowerCase();
    return records.filter((value) => value.title.toLowerCase().includes(normalized)).map((value) => ({
      documentId: value.id,
      path: value.path,
      title: value.title,
      matchedBy: ["title"],
    }));
  }

  async focus(input: FocusMapInput, signal: AbortSignal, progress: (completed: number) => void): Promise<FocusedMap> {
    this.inputs.push(detached(input));
    if (!this.pauseMap) return this.focused(input.center.id, input.records);
    return await new Promise<FocusedMap>((resolve, reject) => {
      const rejectAbort = (): void => reject(new DOMException("canceled", "AbortError"));
      signal.addEventListener("abort", rejectAbort, { once: true });
      this.requests.push({
        input: detached(input),
        progress,
        resolve: (value) => {
          signal.removeEventListener("abort", rejectAbort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", rejectAbort);
          reject(error);
        },
      });
    });
  }

  progress(index: number, completed: number): void { this.requests[index]?.progress(completed); }
  resolve(index: number, id: string): void {
    const request = this.requests[index];
    request?.resolve(this.focused(id, request.input.records));
  }
  reject(index: number, error: Error): void { this.requests[index]?.reject(error); }

  private focused(id: string, records: readonly DocumentRecord[]): FocusedMap {
    const value = records.find((candidate) => candidate.id === id) ?? records[0] ?? RECORDS[0]!;
    return {
      nodes: [{
        id: value.id,
        nodeType: "document",
        path: value.path,
        title: value.title,
        kind: value.kind,
        shape: value.kind === "note" ? "circle" : "square",
      }],
      edges: [],
      selected: { nodeId: id, path: value.path, topics: [], connectedNodeIds: [], relations: [] },
      truncated: false,
    };
  }
}

export interface ControllerFixtureOptions {
  readonly policy?: RuntimeSafetyPolicy;
  readonly historicalWriteEnabled?: boolean;
  readonly historicalAiEnabled?: boolean;
  readonly pauseScan?: boolean;
  readonly pauseMap?: boolean;
  readonly activeIndex?: boolean;
  readonly scanError?: Error;
  readonly flushError?: Error;
  readonly reconcileError?: Error;
  readonly workspaceError?: Error;
  readonly quickCaptureError?: Error;
  readonly sampleAcknowledged?: boolean;
  readonly rationaleEnhancer?: RationaleEnhancer;
  readonly previewResult?: "confirm" | "cancel" | "escape";
  readonly transactionResult?: ExecutionResult;
  readonly pauseTransaction?: boolean;
  readonly writeOnExecute?: boolean;
  readonly blockAfterConfirmation?: boolean;
  readonly relockUserAfterConfirmation?: boolean;
  readonly organizationWritesBlocked?: boolean;
  readonly transactionError?: Error;
  readonly blockOnTransactionError?: boolean;
  readonly historyEntries?: readonly JournalEntry[];
  readonly historyConfirmation?: boolean;
  readonly historyClearError?: Error;
  readonly pauseHistoryConfirmation?: boolean;
  readonly undoAllDrift?: boolean;
  readonly aiEnabled?: boolean;
  readonly aiEndpoint?: string;
  readonly aiModel?: string;
  readonly aiSecretId?: string;
  readonly aiReads?: VaultReadPort;
  readonly aiPreviewResult?: boolean;
  readonly pauseAiPreview?: boolean;
  readonly aiSecret?: string | null;
  readonly aiSecretError?: Error;
  readonly aiClient?: AiClientPort;
  readonly aiDelay?: (milliseconds: number) => Promise<void>;
  readonly records?: readonly DocumentRecord[];
  readonly projectionScheduler?: ProjectionSchedulerDependency;
  readonly deferInitialProjection?: boolean;
  readonly catalog?: CloudCatalogRuntime;
  readonly catalogConfirmation?: CatalogScanConfirmationPresenter;
  readonly catalogTxtImportConfirmation?: CatalogTxtImportConfirmationPresenter;
  readonly catalogLargeScanConfirmation?: CatalogLargeScanConfirmationPresenter;
}

export function controllerFixture(options: ControllerFixtureOptions = {}) {
  const records = options.records ?? RECORDS;
  const store = new FixtureStore(options.activeIndex ?? false, records);
  if (options.historicalWriteEnabled !== undefined || options.historicalAiEnabled !== undefined) {
    store.setSettingsForTest({
      ...store.settings(),
      ...(options.historicalWriteEnabled === undefined ? {} : {
        writeEnabled: options.historicalWriteEnabled,
        writePreviewAcknowledged: options.historicalWriteEnabled || store.settings().writePreviewAcknowledged,
      }),
      ...(options.historicalAiEnabled === undefined ? {} : { aiEnabled: options.historicalAiEnabled }),
    });
  }
  if (options.aiEnabled !== undefined || options.aiEndpoint !== undefined || options.aiModel !== undefined || options.aiSecretId !== undefined) {
    store.setSettingsForTest({
      ...store.settings(),
      aiEnabled: options.aiEnabled ?? true,
      aiEndpoint: options.aiEndpoint ?? "https://example.test/v1",
      aiModel: options.aiModel ?? "fixture-model",
      secretId: options.aiSecretId ?? "fixture-secret",
    });
  }
  const index = new FixtureIndex(store, options.pauseScan ?? false, options.scanError, options.reconcileError, records);
  const queue = new FixtureQueue(options.flushError);
  const map = new FixtureMap(options.pauseMap ?? false);
  const projection = {
    classificationCalls: 0,
    suggestionCalls: 0,
    todayCalls: 0,
    mapSearchCalls: 0,
    failNext: null as Error | null,
    beforeNextSuggestion: null as (() => void) | null,
  };
  const quickCapture = {
    calls: 0,
    disposeCalls: 0,
    async capture(): Promise<string> {
      this.calls += 1;
      if (options.quickCaptureError !== undefined) throw options.quickCaptureError;
      return "Inbox/Captured.md";
    },
    dispose(): void { this.disposeCalls += 1; },
  };
  const catalog = options.catalog ?? new FakeCloudCatalogRuntime();
  const catalogConfirmation = options.catalogConfirmation
    ?? new FakeCatalogScanConfirmationPresenter(false);
  const clock: Clock = { now: () => 100 };
  const workspace: WorkspacePort = {
    openNote: async () => {
      if (options.workspaceError !== undefined) throw options.workspaceError;
    },
  };
  const vault = FakeVault.withNotes(records.map((value) => value.path));
  const changePlans = new ChangePlanService(vault, () => {
    const settings = store.settings();
    return settings.writePreviewAcknowledged && settings.writeEnabled;
  });
  const policy = options.policy ?? NORMAL_RUNTIME_POLICY;
  let organizationWritesBlocked = options.organizationWritesBlocked ?? false;
  let resumeTransaction: (() => void) | null = null;
  const transactionGate = options.pauseTransaction === true
    ? new Promise<void>((resolve) => { resumeTransaction = resolve; })
    : null;
  const transactions = {
    calls: [] as ConfirmedPlan[],
    organizationWritesBlockedCalls: 0,
    organizationWritesBlocked(): boolean {
      this.organizationWritesBlockedCalls += 1;
      return organizationWritesBlocked;
    },
    async execute(plan: ConfirmedPlan): Promise<ExecutionResult> {
      this.calls.push(plan);
      if (transactionGate !== null) await transactionGate;
      if (options.transactionError !== undefined) {
        if (options.blockOnTransactionError === true) organizationWritesBlocked = true;
        throw options.transactionError;
      }
      if (options.writeOnExecute === true) {
        const operation = plan.operations[0];
        if (operation !== undefined && !("sourcePath" in operation)) {
          await vault.setOwnedField(
            operation.path,
            operation.kind === "add-related-link" ? "knowledge-workbench-related" : operation.field,
            operation.before,
            operation.after,
          );
        }
      }
      return options.transactionResult ?? { status: "completed", journalId: "journal:fixture" };
    },
    setOrganizationWritesBlocked(value: boolean): void { organizationWritesBlocked = value; },
    resume(): void { resumeTransaction?.(); },
  };
  const changePreview = {
    planCalls: 0,
    sampleCalls: 0,
    lastPreview: null as PlanPreview | null,
    async request(preview: PlanPreview) {
      this.planCalls += 1;
      this.lastPreview = preview;
      if (policy.planConfirmation === "blocked") return null;
      if (options.previewResult === "cancel" || options.previewResult === "escape") return null;
      const confirmed = await changePlans.confirm(preview, preview.plan.operations.map((operation) => operation.id));
      if (options.blockAfterConfirmation === true) organizationWritesBlocked = true;
      if (options.relockUserAfterConfirmation === true) {
        store.setSettingsForTest({ ...store.settings(), writeEnabled: false });
      }
      return confirmed;
    },
    async requestSample(): Promise<boolean> {
      this.sampleCalls += 1;
      return options.sampleAcknowledged ?? true;
    },
  };
  let historyEntries = detached(options.historyEntries ?? []);
  let resumeHistoryConfirmation: ((value: boolean) => void) | null = null;
  const historyConfirmation = {
    calls: 0,
    request(): Promise<boolean> {
      this.calls += 1;
      if (options.pauseHistoryConfirmation === true) {
        return new Promise((resolve) => { resumeHistoryConfirmation = resolve; });
      }
      return Promise.resolve(options.historyConfirmation ?? true);
    },
    resume(value: boolean): void { resumeHistoryConfirmation?.(value); },
  };
  const journal = {
    listCalls: 0,
    clearCalls: 0,
    async list(): Promise<readonly JournalEntry[]> { this.listCalls += 1; return detached(historyEntries); },
    async clearHistory(): Promise<void> {
      this.clearCalls += 1;
      if (options.historyClearError !== undefined) throw options.historyClearError;
      historyEntries = historyEntries.filter((entry) => entry.status !== "completed" && entry.status !== "rolled-back");
    },
  };
  const undo = {
    calls: [] as string[],
    async preview(id: string): Promise<PlanPreview> {
      this.calls.push(id);
      if (options.undoAllDrift === true) {
        return await changePlans.previewOrdered([], [{
          operationId: "plan",
          code: "post-state-drift",
          paths: ["Notes/Alpha.md"],
          severity: "warning",
        }]);
      }
      const suggestion = controller.refreshSuggestions()[0];
      if (suggestion === undefined) throw new Error("No operation available for Undo preview");
      return await changePlans.previewOrdered([suggestion.operation]);
    },
  };
  let resumeAiPreview: ((value: boolean) => void) | null = null;
  const aiPreview = {
    calls: [] as AiPayloadPreview[],
    request(preview: AiPayloadPreview): Promise<boolean> {
      this.calls.push(detached(preview));
      if (options.pauseAiPreview === true) return new Promise((resolve) => { resumeAiPreview = resolve; });
      return Promise.resolve(options.aiPreviewResult ?? true);
    },
    resume(value: boolean): void { resumeAiPreview?.(value); },
  };
  const aiClient = options.aiClient ?? { complete: async () => ({ text: "AI fixture text" }) };
  const ai = {
    preview: aiPreview,
    secretCalls: [] as string[],
    clientCalls: [] as { endpoint: string; model: string; secretPresent: boolean }[],
    getSecret(id: string): string | null {
      this.secretCalls.push(id);
      if (options.aiSecretError !== undefined) throw options.aiSecretError;
      return options.aiSecret === undefined ? "fixture-secret-value" : options.aiSecret;
    },
    createClient(endpoint: string, model: string, secret: string): AiClientPort {
      this.clientCalls.push({ endpoint, model, secretPresent: secret.length > 0 });
      return aiClient;
    },
    delay: options.aiDelay ?? (async () => undefined),
  };
  const classificationBase = new ClassificationService();
  const classification = {
    classify(...args: Parameters<ClassificationService["classify"]>): ReturnType<ClassificationService["classify"]> {
      projection.classificationCalls += 1;
      return classificationBase.classify(...args);
    },
    isExcluded(...args: Parameters<ClassificationService["isExcluded"]>): ReturnType<ClassificationService["isExcluded"]> {
      return classificationBase.isExcluded(...args);
    },
  };
  const todayBase = new TodayService(clock);
  const today = {
    build(...args: Parameters<TodayService["build"]>): ReturnType<TodayService["build"]> {
      projection.todayCalls += 1;
      return todayBase.build(...args);
    },
  } as unknown as TodayService;
  const suggestionsBase = new SuggestionService(options.rationaleEnhancer);
  const suggestions = {
    generate(...args: Parameters<SuggestionService["generate"]>): ReturnType<SuggestionService["generate"]> {
      projection.suggestionCalls += 1;
      const before = projection.beforeNextSuggestion;
      projection.beforeNextSuggestion = null;
      before?.();
      if (projection.failNext !== null) {
        const error = projection.failNext;
        projection.failNext = null;
        throw error;
      }
      return suggestionsBase.generate(...args);
    },
  } as unknown as SuggestionService;
  const mapDependency = {
    search(...args: Parameters<MapService["search"]>): ReturnType<MapService["search"]> {
      projection.mapSearchCalls += 1;
      return map.search(...args);
    },
    focus(...args: Parameters<MapService["focus"]>): ReturnType<MapService["focus"]> {
      return map.focus(...args);
    },
  } as unknown as MapService;
  type ExpectedWorkbenchDependencies = ConstructorParameters<typeof WorkbenchController>[0] & Readonly<{
    projectionScheduler?: ProjectionSchedulerDependency;
  }>;
  const dependencies: ExpectedWorkbenchDependencies = {
    policy,
    reads: options.aiReads ?? vault,
    index: index as unknown as IndexService,
    indexQueue: queue as unknown as IncrementalIndexQueue,
    classification,
    today,
    map: mapDependency,
    suggestions,
    changePlans,
    changePreview,
    store: store as unknown as PluginDataStore,
    workspace,
    quickCapture,
    transactions,
    journal,
    undo,
    historyConfirmation,
    clock,
    ai,
    catalog,
    catalogConfirmation,
    ...(options.catalogTxtImportConfirmation === undefined
      ? {}
      : { catalogTxtImportConfirmation: options.catalogTxtImportConfirmation }),
    ...(options.catalogLargeScanConfirmation === undefined
      ? {}
      : { catalogLargeScanConfirmation: options.catalogLargeScanConfirmation }),
    ...(options.projectionScheduler === undefined ? {} : { projectionScheduler: options.projectionScheduler }),
  };
  const controller = new WorkbenchController(dependencies);
  if (options.deferInitialProjection !== true) controller.refreshSuggestions();
  return {
    controller,
    store,
    index,
    queue,
    map,
    quickCapture,
    vault,
    changePlans,
    changePreview,
    transactions,
    journal,
    undo,
    historyConfirmation,
    ai,
    aiPreview,
    aiClient,
    projection,
    catalog,
  };
}

interface QuickCaptureFixtureOptions {
  readonly parentPath?: string;
  readonly createRace?: boolean;
  readonly pauseCreate?: boolean;
}

export function quickCaptureFixture(options: QuickCaptureFixtureOptions = {}) {
  const queued: (string | null)[] = [];
  let settleActive: ((value: string | null) => void) | null = null;
  const deliver = (value: string | null): void => {
    if (settleActive === null) queued.push(value);
    else settleActive(value);
  };
  const modal = {
    instances: 0,
    submit(title: string): void { deliver(title); },
    cancel(): void { deliver(null); },
    escape(): void { deliver(null); },
    close(): void { deliver(null); },
    doubleSubmit(title: string): void { deliver(title); },
  };
  const files = new Map<string, TFile>([["Existing.md", markdownFile("Existing.md")]]);
  let resolveCreate: (() => void) | null = null;
  const vault = {
    createCalls: [] as [string, string][],
    getMarkdownFiles(): TFile[] { return [...files.values()]; },
    getAbstractFileByPath(path: string): TAbstractFile | null { return files.get(path) ?? null; },
    async create(path: string, content: string): Promise<TFile> {
      this.createCalls.push([path, content]);
      if (options.createRace === true) throw new Error("File already exists");
      const file = markdownFile(path);
      if (options.pauseCreate === true) {
        await new Promise<void>((resolve) => { resolveCreate = resolve; });
      }
      files.set(path, file);
      return file;
    },
    resolveCreate(): void { resolveCreate?.(); },
  };
  const fileManager = {
    parentArgs: [] as [string, string][],
    getNewFileParent(sourcePath: string, filename: string): TFolder {
      this.parentArgs.push([sourcePath, filename]);
      return hostDouble<TFolder>({
        path: options.parentPath ?? "",
        name: "",
        vault: null,
        parent: null,
        children: [],
        isRoot: () => true,
      });
    },
  };
  const workspace = {
    openCalls: [] as string[],
    getActiveFile: (): TFile => markdownFile("Active.md"),
    getLeaf: () => ({
      openFile: async (file: TFile): Promise<void> => { workspace.openCalls.push(file.path); },
    }),
  };
  const app = { vault, fileManager, workspace } as unknown as App;
  const adapter = new ObsidianQuickCaptureAdapter(app, () => {
    modal.instances += 1;
    let result: Promise<string | null> | null = null;
    let settled = false;
    let resolveResult: ((value: string | null) => void) | null = null;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      settleActive = null;
      resolveResult?.(value);
      resolveResult = null;
    };
    return {
      request(): Promise<string | null> {
        if (result !== null) return result;
        const queuedValue = queued.shift();
        if (queuedValue !== undefined || queued.length > 0) {
          settled = true;
          result = Promise.resolve(queuedValue ?? null);
          return result;
        }
        result = new Promise((resolve) => {
          resolveResult = resolve;
          settleActive = settle;
        });
        return result;
      },
      cancel(): void { settle(null); },
      dispose(): void { settle(null); },
    };
  });
  return { adapter, modal, vault, fileManager, workspace };
}

interface MetadataFixtureOptions {
  readonly resolved: boolean;
  readonly sourceLinks?: readonly string[];
  readonly frontmatterLinks?: readonly string[];
  readonly destinations?: Readonly<Record<string, string>>;
  readonly includeUnrelated?: boolean;
}

type EventCallback = (...values: readonly unknown[]) => void;
interface FixtureEventRef extends EventRef { readonly bucket: "metadata" | "vault"; readonly name: string; }

const hostDouble = <T>(value: object): T => value as unknown as T;

const markdownFile = (path: string): TFile => hostDouble<TFile>({
  path,
  name: path.split("/").at(-1) ?? path,
  basename: (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/u, ""),
  extension: path.split(".").at(-1)?.toLocaleLowerCase("en-US") ?? "",
  stat: { ctime: 1, mtime: 10, size: 20 },
  vault: null,
  parent: null,
});

export function metadataAdapterFixture(options: MetadataFixtureOptions) {
  const destinationPaths: Record<string, string> = { Target: "Target.md", ...options.destinations };
  const files = new Map<string, TFile>();
  const addFile = (path: string): TFile => {
    const existing = files.get(path);
    if (existing !== undefined) return existing;
    const file = markdownFile(path);
    files.set(path, file);
    return file;
  };
  addFile("Source.md");
  addFile("Target.md");
  for (const path of Object.values(destinationPaths)) addFile(path);
  if (options.includeUnrelated === true) addFile("Unrelated.md");

  const caches = new Map<string, CachedMetadata>();
  const linksFor = (values: readonly string[]) => values.map((link) => ({
    link,
    key: link,
    original: `[[${link}]]`,
    displayText: link,
    position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 1, offset: 1 } },
  }));
  caches.set("Source.md", {
    links: linksFor(options.sourceLinks ?? ["Target"]),
    frontmatterLinks: linksFor(options.frontmatterLinks ?? []),
    headings: [{
      heading: "A source H1",
      level: 1,
      position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 1, offset: 1 } },
    }],
    frontmatter: { title: "A source title", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 1, offset: 1 } } },
  });
  caches.set("Target.md", {
    headings: [{
      heading: "Destination title differs from filename",
      level: 1,
      position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 1, offset: 1 } },
    }],
  });
  for (const path of files.keys()) if (!caches.has(path)) caches.set(path, {});

  const metadataListeners = new Map<string, Set<EventCallback>>();
  const vaultListeners = new Map<string, Set<EventCallback>>();
  const addListener = (bucket: "metadata" | "vault", name: string, callback: EventCallback): FixtureEventRef => {
    const listeners = bucket === "metadata" ? metadataListeners : vaultListeners;
    const values = listeners.get(name) ?? new Set<EventCallback>();
    values.add(callback);
    listeners.set(name, values);
    return { bucket, name };
  };
  const removeListener = (ref: FixtureEventRef): void => {
    const listeners = ref.bucket === "metadata" ? metadataListeners : vaultListeners;
    listeners.get(ref.name)?.clear();
  };
  const emit = (listeners: Map<string, Set<EventCallback>>, name: string, ...values: readonly unknown[]): void => {
    for (const callback of listeners.get(name) ?? []) callback(...values);
  };

  const parsedPath = (link: string): string => link.split("|")[0]!.split(/[#^]/u)[0]!.trim();
  const destinationsFor = (path: string): Record<string, number> => {
    const cache = caches.get(path);
    const values = [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])];
    return Object.fromEntries(values.flatMap(({ link }) => {
      const destination = destinationPaths[parsedPath(link)];
      return destination === undefined ? [] : [[destination, 1]];
    }));
  };
  const unresolvedFor = (path: string): Record<string, number> => {
    const cache = caches.get(path);
    const values = [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])];
    return Object.fromEntries(values.flatMap(({ link }) => {
      const parsed = parsedPath(link);
      return destinationPaths[parsed] === undefined ? [[parsed, 1]] : [];
    }));
  };

  const resolvedLinks: Record<string, Record<string, number>> = {};
  const unresolvedLinks: Record<string, Record<string, number>> = {};
  const publishPath = (path: string): void => {
    resolvedLinks[path] = destinationsFor(path);
    unresolvedLinks[path] = unresolvedFor(path);
  };
  if (options.resolved) {
    for (const path of files.keys()) publishPath(path);
  }

  const metadataCache = {
    resolvedLinks,
    unresolvedLinks,
    on(name: string, callback: EventCallback): EventRef { return addListener("metadata", name, callback); },
    offref(ref: EventRef): void { removeListener(ref as FixtureEventRef); },
    getFileCache(file: TFile): CachedMetadata | null { return caches.get(file.path) ?? null; },
    getFirstLinkpathDest(link: string): TFile | null {
      const path = destinationPaths[link];
      return path === undefined ? null : files.get(path) ?? null;
    },
  };
  const contents = new Map([...files.keys()].map((path) => [path, path === "Source.md" ? "# A source H1\n[[Target]]" : "# Destination title differs"]));
  const vault = {
    on(name: string, callback: EventCallback): EventRef { return addListener("vault", name, callback); },
    offref(ref: EventRef): void { removeListener(ref as FixtureEventRef); },
    getMarkdownFiles(): TFile[] { return [...files.values()].filter((file) => file.extension === "md"); },
    getAbstractFileByPath(path: string): TAbstractFile | null { return files.get(path) ?? null; },
    async cachedRead(file: TFile): Promise<string> { return contents.get(file.path) ?? ""; },
  };
  const app = { metadataCache, vault } as unknown as App;
  const events: VaultEvent[] = [];
  const adapter = new ObsidianVaultAdapter(app, (event) => events.push(event), (linktext) => ({
    path: parsedPath(linktext),
    subpath: linktext.slice(parsedPath(linktext).length),
  }), {
    TFile: class FixtureTFile {},
    normalizePath: (path) => path,
    getFrontMatterInfo: () => ({ exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 }),
    parseYaml: () => ({}),
  });

  return {
    adapter,
    events,
    resolveAll(): void {
      for (const path of files.keys()) publishPath(path);
      emit(metadataListeners, "resolved");
    },
    change(path: string, links: readonly string[]): void {
      const current = caches.get(path) ?? {};
      caches.set(path, { ...current, links: linksFor(links) });
      emit(metadataListeners, "changed", files.get(path), "", caches.get(path));
    },
    resolve(path: string): void {
      publishPath(path);
      emit(metadataListeners, "resolve", files.get(path));
    },
    rename(oldPath: string, newPath: string): void {
      const file = files.get(oldPath)!;
      files.delete(oldPath);
      const renamed = {
        ...file,
        path: newPath,
        name: newPath,
        basename: newPath.replace(/\.[^.]+$/u, ""),
        extension: newPath.split(".").at(-1)?.toLocaleLowerCase("en-US") ?? "",
      };
      files.set(newPath, renamed);
      const cache = caches.get(oldPath) ?? {};
      caches.delete(oldPath);
      caches.set(newPath, cache);
      contents.set(newPath, contents.get(oldPath) ?? "");
      contents.delete(oldPath);
      delete resolvedLinks[oldPath];
      delete unresolvedLinks[oldPath];
      emit(vaultListeners, "rename", renamed, oldPath);
    },
    listenerCounts(): { metadata: number; vault: number } {
      return {
        metadata: [...metadataListeners.values()].reduce((sum, values) => sum + values.size, 0),
        vault: [...vaultListeners.values()].reduce((sum, values) => sum + values.size, 0),
      };
    },
  };
}
