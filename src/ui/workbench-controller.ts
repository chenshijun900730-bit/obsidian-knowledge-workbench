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
import type { FolderRule, FolderRuleProposal, PluginSettings } from "../storage/plugin-data";
import type { TodayService } from "../today/today-service";
import type { ExecutionResult, TransactionService } from "../transactions/transaction-service";
import type { OperationJournal } from "../transactions/operation-journal";
import type { UndoService } from "../transactions/undo-service";
import type { ChangePreviewPresenter } from "./change-preview-modal";
import { exportJournalJson, type HistoryConfirmationPresenter } from "./history-tab";
import type { TodayFilter } from "./today-pane";
import type { WorkbenchProgress, WorkbenchTab, WorkbenchViewModel } from "./workbench-view";
import type { AiPayloadPreviewPresenter } from "./ai-payload-preview-modal";
import { effectiveSettings, type RuntimeSafetyPolicy } from "../runtime/safety-policy";

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
}

export type MapCenter = Readonly<{ kind: "document" | "topic"; id: string }>;

const emptyMap = (): FocusedMap => ({ nodes: [], edges: [], selected: null, truncated: false });
const idleProgress = (label: string): WorkbenchProgress => ({ status: "idle", completed: 0, label });
const clone = <T>(value: T): T => structuredClone(value);
const isAbortError = (error: unknown): boolean => error instanceof DOMException
  ? error.name === "AbortError"
  : error instanceof Error && error.name === "AbortError";
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const RECOVERY_LOCK_MESSAGE = "Recovery required; organization writes are locked";
const PROJECTION_REFRESH_ERROR = "Workbench projection refresh failed";
const PROJECTION_QUIET_DELAY_MS = 50;
const PROJECTION_MAX_WAIT_MS = 500;
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

export class WorkbenchController {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeIndex: () => void;
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
  private projectionRevision = 1;
  private projectedRevision = 0;
  private projectionDirtySince: number | null = null;
  private projectionTimerToken = 0;
  private quietProjectionTimer: ProjectionTimer | null = null;
  private maxProjectionTimer: ProjectionTimer | null = null;

  constructor(private readonly dependencies: WorkbenchDependencies) {
    this.projectionScheduler = dependencies.projectionScheduler ?? defaultProjectionScheduler;
    this.model = {
      status: "ready",
      activeTab: "workbench",
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
    this.projectionDirtySince = this.projectionNow();
    this.unsubscribeIndex = dependencies.index.subscribe(() => {
      if (this.disposed) return;
      this.markProjectionDirty();
    });
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

  selectTab(tab: WorkbenchTab): void {
    if (this.disposed || tab === this.model.activeTab) return;
    this.model = { ...this.model, activeTab: tab };
    this.emit();
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
    const hadActiveIndex = this.dependencies.store.activeIndex() !== null;
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
    const hadActiveIndex = this.dependencies.store.activeIndex() !== null;
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
    this.cancelProjectionSchedule();
    this.lifecycleEpoch += 1;
    this.exclusionGeneration += 1;
    this.invalidateAiConfiguration(true);
    this.scanController?.abort();
    this.mapController?.abort();
    const quickCapture = this.dependencies.quickCapture as QuickCapturePort & { readonly dispose?: () => void };
    quickCapture.dispose?.();
    this.unsubscribeIndex();
    this.listeners.clear();
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

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A view failure must not corrupt index, queue, or persisted controller state.
      }
    }
  }
}
