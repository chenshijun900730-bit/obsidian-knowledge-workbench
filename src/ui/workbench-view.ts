import type { ItemView, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE } from "../constants";
import type { FocusedMap, MapFilter, MapSearchResult } from "../map/map-service";
import type { TodayViewModel } from "../today/today-service";
import type { SuggestedOperation } from "../suggestions/suggestion-service";
import { renderMapPane } from "./map-pane";
import { renderSuggestionsTab } from "./suggestions-tab";
import { renderTodayPane, type TodayFilter } from "./today-pane";
import { renderHistory, triggerHistoryDownload, type HistoryViewModel } from "./history-tab";
import type { AiAction } from "../core/ports";
import { renderAiSuggestion } from "./ai-suggestion";
import {
  NORMAL_RUNTIME_POLICY,
  type RuntimeSafetyPolicy,
} from "../runtime/safety-policy";

export type WorkbenchTab = "workbench" | "suggestions" | "history" | "settings";
export type ProgressStatus = "idle" | "running" | "canceled" | "error" | "complete";
export interface WorkbenchProgress {
  readonly status: ProgressStatus;
  readonly completed: number;
  readonly total?: number;
  readonly label: string;
}
export interface WorkbenchViewModel {
  readonly status: "ready" | "canceled" | "error";
  readonly statusMessage?: string;
  readonly activeTab: WorkbenchTab;
  readonly todayFilter: TodayFilter;
  readonly today: TodayViewModel;
  readonly suggestions?: readonly SuggestedOperation[];
  readonly history?: HistoryViewModel;
  readonly map: FocusedMap;
  readonly mapFilter: MapFilter;
  readonly searchQuery: string;
  readonly searchResults: readonly MapSearchResult[];
  readonly scanProgress: WorkbenchProgress;
  readonly mapProgress: WorkbenchProgress;
  readonly aiSuggestion?: Readonly<{ action: AiAction; text: string }>;
}
export interface WorkbenchActions {
  readonly onSelectTab: (tab: WorkbenchTab) => void;
  readonly onSelectTodayFilter: (filter: TodayFilter) => void;
  readonly onSelectMapFilter: (filter: MapFilter) => void;
  readonly onOpenNote: (path: string) => void;
  readonly onQuickCapture: () => void;
  readonly onCancelScan: () => void;
  readonly onCancelMap: () => void;
  readonly onPin: (id: string) => void;
  readonly onDismiss: (id: string, mtime: number) => void;
  readonly onSearchMap: (query: string) => void;
  readonly onSelectCenter: (center: Readonly<{ kind: "document" | "topic"; id: string }>) => void;
  readonly onPreviewSuggestion: (suggestionId: string) => void;
  readonly onPreviewSuggestionIds?: (suggestionIds: readonly string[]) => void;
  readonly onRetryScan: () => void;
  readonly onUndoHistory?: (id: string) => void;
  readonly onViewRecovery?: (id: string) => void;
  readonly onClearHistory?: () => void;
  readonly onExportHistory?: () => void;
  readonly onSummarize?: (paths: readonly string[]) => void;
  readonly onNameCluster?: (paths: readonly string[]) => void;
  readonly onExplainRelation?: (paths: readonly string[], targetSuggestionId?: string) => void;
  readonly onSuggestLabels?: (paths: readonly string[]) => void;
  readonly onSuggestionSelectionChange?: () => void;
}

const TABS: readonly Readonly<{ id: WorkbenchTab; label: string }>[] = [
  { id: "workbench", label: "Workbench" },
  { id: "suggestions", label: "Organization suggestions" },
  { id: "history", label: "Operation history" },
  { id: "settings", label: "Settings" },
];
const ACCEPTANCE_BANNER_TEXT = "Read-only acceptance build. Quick Capture, organization writes, Undo, and AI are unavailable. Derived index data is stored in the plugin's data file.";
let workbenchRootSequence = 0;
const workbenchRootIds = new WeakMap<HTMLElement, string>();
const idPrefixFor = (root: HTMLElement): string => {
  const existing = workbenchRootIds.get(root);
  if (existing !== undefined) return existing;
  const created = `knowledge-workbench-${++workbenchRootSequence}`;
  workbenchRootIds.set(root, created);
  return created;
};

export function renderWorkbenchTabs(
  doc: Document,
  activeTab: WorkbenchTab,
  onSelect: (tab: WorkbenchTab) => void,
  idPrefix = "knowledge-workbench",
): HTMLElement {
  const tabs = doc.createElement("div");
  tabs.className = "knowledge-workbench__tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Knowledge workbench sections");
  const buttons = TABS.map(({ id, label }) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.id = `${idPrefix}-tab-${id}`;
    button.dataset.tab = id;
    button.dataset.focusKey = `tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(id === activeTab));
    button.setAttribute("aria-controls", `${idPrefix}-panel`);
    button.tabIndex = id === activeTab ? 0 : -1;
    button.textContent = label;
    button.addEventListener("click", () => onSelect(id));
    tabs.append(button);
    return button;
  });
  tabs.addEventListener("keydown", (event) => {
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    let target = current;
    if (event.key === "ArrowRight") target = (current + 1) % buttons.length;
    else if (event.key === "ArrowLeft") target = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = buttons.length - 1;
    else return;
    event.preventDefault();
    const next = buttons[target]!;
    next.focus();
    onSelect(next.dataset.tab as WorkbenchTab);
  });
  return tabs;
}

const progressText = (progress: WorkbenchProgress): string => {
  const amount = `${progress.completed}${progress.total === undefined ? "" : ` / ${progress.total}`}`;
  if (progress.status === "running") return `${progress.label} running: ${amount}`;
  const status = `${progress.status[0]!.toLocaleUpperCase("en-US")}${progress.status.slice(1)}`;
  return `${progress.label} ${status}: ${amount}`;
};

const statusText = (model: WorkbenchViewModel): string => {
  const progress = [model.scanProgress, model.mapProgress]
    .filter((value) => value.status !== "idle")
    .map(progressText);
  if (model.statusMessage !== undefined) progress.push(model.statusMessage);
  if (progress.length > 0) return progress.join("; ");
  if (model.status === "error") return model.statusMessage ?? "Error";
  if (model.status === "canceled") return "Canceled";
  return "Ready";
};

const appendProgress = (
  parent: HTMLElement,
  progress: WorkbenchProgress,
  onCancel: () => void,
  onRetry?: () => void,
): void => {
  if (progress.status === "idle") return;
  const wrap = parent.ownerDocument.createElement("div");
  wrap.className = "knowledge-workbench__progress";
  const label = parent.ownerDocument.createElement("span");
  label.textContent = progressText(progress);
  wrap.append(label);
  if (progress.status === "running") {
    const cancel = parent.ownerDocument.createElement("button");
    cancel.type = "button";
    cancel.textContent = `Cancel ${progress.label}`;
    cancel.addEventListener("click", onCancel);
    wrap.append(cancel);
  } else if ((progress.status === "canceled" || progress.status === "error") && onRetry !== undefined) {
    const retry = parent.ownerDocument.createElement("button");
    retry.type = "button";
    retry.textContent = `Retry ${progress.label}`;
    retry.addEventListener("click", onRetry);
    wrap.append(retry);
  }
  parent.append(wrap);
};

export function renderWorkbench(
  root: HTMLElement,
  model: WorkbenchViewModel,
  actions: WorkbenchActions,
  policy: RuntimeSafetyPolicy = NORMAL_RUNTIME_POLICY,
): void {
  const doc = root.ownerDocument;
  const idPrefix = idPrefixFor(root);
  const active = doc.activeElement;
  const focusKey = active !== null && root.contains(active)
    ? (active as HTMLElement).dataset.focusKey
    : undefined;
  const selection = active !== null && active.matches("input, textarea")
    ? {
        start: (active as HTMLInputElement).selectionStart,
        end: (active as HTMLInputElement).selectionEnd,
        direction: (active as HTMLInputElement).selectionDirection,
      }
    : null;
  root.replaceChildren();
  root.classList.add("knowledge-workbench");
  const readOnlyAcceptance = policy.mode === "read-only-acceptance";
  root.classList.toggle("knowledge-workbench--read-only-acceptance", readOnlyAcceptance);
  const surfaceActions: WorkbenchActions = readOnlyAcceptance ? {
    ...actions,
    onSummarize: undefined,
    onNameCluster: undefined,
    onExplainRelation: undefined,
    onSuggestLabels: undefined,
  } : actions;
  const status = doc.createElement("div");
  status.className = "knowledge-workbench__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = statusText(model);
  const tabs = renderWorkbenchTabs(doc, model.activeTab, actions.onSelectTab, idPrefix);
  const progress = doc.createElement("div");
  progress.className = "knowledge-workbench__progress-row";
  appendProgress(progress, model.scanProgress, actions.onCancelScan, actions.onRetryScan);
  appendProgress(progress, model.mapProgress, actions.onCancelMap);
  const panel = doc.createElement("div");
  panel.id = `${idPrefix}-panel`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `${idPrefix}-tab-${model.activeTab}`);
  root.append(tabs);
  if (readOnlyAcceptance) {
    const banner = doc.createElement("div");
    banner.className = "knowledge-workbench__acceptance-banner";
    banner.dataset.acceptanceBanner = "true";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-label", "Read-only acceptance mode is active");
    banner.textContent = ACCEPTANCE_BANNER_TEXT;
    root.append(banner);
  }
  root.append(status, progress, panel);
  if (model.activeTab === "workbench") {
    const split = doc.createElement("div");
    split.className = "knowledge-workbench__split";
    const today = doc.createElement("section");
    today.className = "knowledge-workbench__today";
    today.setAttribute("aria-label", "Today");
    const map = doc.createElement("section");
    map.className = "knowledge-workbench__map";
    map.setAttribute("aria-label", "Knowledge map");
    split.append(today, map);
    panel.append(split);
    renderTodayPane(today, model.today, model.todayFilter, surfaceActions, policy);
    renderMapPane(map, model.map, model.mapFilter, model.searchQuery, model.searchResults, surfaceActions);
  } else if (model.activeTab === "suggestions") {
    renderSuggestionsTab(panel, model.suggestions ?? [], surfaceActions.onPreviewSuggestionIds ?? ((ids) => {
      for (const id of ids) surfaceActions.onPreviewSuggestion(id);
    }), surfaceActions.onExplainRelation, surfaceActions.onSuggestionSelectionChange, policy);
  } else if (model.activeTab === "history") {
    renderHistory(panel, model.history ?? { entries: [] }, {
      onUndo: surfaceActions.onUndoHistory ?? (() => undefined),
      onViewRecovery: surfaceActions.onViewRecovery ?? (() => undefined),
      onClear: surfaceActions.onClearHistory ?? (() => undefined),
      onExport: surfaceActions.onExportHistory ?? (() => undefined),
    }, policy);
  } else {
    const placeholder = doc.createElement("p");
    placeholder.className = "knowledge-workbench__placeholder";
    placeholder.textContent = "Settings are available from Obsidian's settings screen.";
    panel.append(placeholder);
  }
  if (!readOnlyAcceptance && model.aiSuggestion !== undefined) renderAiSuggestion(panel, model.aiSuggestion.text);
  if (focusKey !== undefined) {
    const target = Array.from(root.querySelectorAll<HTMLElement>("[data-focus-key]"))
      .find((candidate) => candidate.dataset.focusKey === focusKey);
    target?.focus({ preventScroll: true });
    if (selection !== null && target?.matches("input, textarea")) {
      const input = target as HTMLInputElement;
      const start = Math.min(selection.start ?? input.value.length, input.value.length);
      const end = Math.min(selection.end ?? start, input.value.length);
      input.setSelectionRange(start, end, selection.direction ?? "none");
    }
  }
}

export interface WorkbenchViewController {
  snapshot(): WorkbenchViewModel;
  subscribe(listener: () => void): () => void;
  selectTab(tab: WorkbenchTab): void;
  setTodayFilter(filter: TodayFilter): void;
  setMapFilter(filter: MapFilter): Promise<void>;
  openNote(path: string): Promise<void>;
  startQuickCapture(): Promise<string | null>;
  cancelScan(): void;
  cancelMap(): void;
  pin(id: string): Promise<void>;
  dismiss(id: string, mtime: number): Promise<void>;
  searchMap(query: string): void;
  selectCenter(center: Readonly<{ kind: "document" | "topic"; id: string }>): Promise<void>;
  previewSuggestion(suggestionId: string): Promise<void>;
  previewSuggestionIds(suggestionIds: readonly string[]): Promise<void>;
  previewUndo(id: string): Promise<void>;
  requestClearHistory(): Promise<void>;
  historyExportJson(exportedAt: string): Promise<string>;
  viewRecovery(id: string): Promise<void>;
  startInitialScan(): Promise<void>;
  reportError(message: string): void;
  summarize?(paths: readonly string[]): Promise<unknown>;
  nameCluster?(paths: readonly string[]): Promise<unknown>;
  explainRelation?(paths: readonly string[], targetSuggestionId?: string): Promise<unknown>;
  suggestLabels?(paths: readonly string[]): Promise<unknown>;
  notifySuggestionSelectionChanged?(): void;
}

export type ItemViewConstructor = abstract new (leaf: WorkspaceLeaf) => ItemView;

/** Injecting the narrow Obsidian base keeps pure DOM tests independent of the host runtime. */
export function createWorkbenchViewClass(
  ItemViewBase: ItemViewConstructor,
  policy: RuntimeSafetyPolicy,
) {
  return class WorkbenchView extends ItemViewBase {
    private unsubscribe: (() => void) | null = null;

    constructor(leaf: WorkspaceLeaf, private readonly controller: WorkbenchViewController) {
      super(leaf);
    }

    getViewType(): string { return VIEW_TYPE; }
    getDisplayText(): string { return "Knowledge workbench"; }
    getIcon(): string { return "network"; }

    async onOpen(): Promise<void> {
      this.unsubscribe?.();
      this.unsubscribe = this.controller.subscribe(() => this.render());
      this.render();
    }

    async onClose(): Promise<void> {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.contentEl.replaceChildren();
    }

    private render(): void {
      renderWorkbench(this.contentEl, this.controller.snapshot(), {
        onSelectTab: (tab) => this.controller.selectTab(tab),
        onSelectTodayFilter: (filter) => this.controller.setTodayFilter(filter),
        onSelectMapFilter: (filter) => this.runAction("Map filter failed", () => this.controller.setMapFilter(filter)),
        onOpenNote: (path) => this.runAction("Open note failed", () => this.controller.openNote(path)),
        onQuickCapture: () => this.runAction("Quick capture failed", () => this.controller.startQuickCapture()),
        onCancelScan: () => this.controller.cancelScan(),
        onCancelMap: () => this.controller.cancelMap(),
        onPin: (id) => this.runAction("Pin failed", () => this.controller.pin(id)),
        onDismiss: (id, mtime) => this.runAction("Dismiss failed", () => this.controller.dismiss(id, mtime)),
        onSearchMap: (query) => this.controller.searchMap(query),
        onSelectCenter: (center) => this.runAction("Map focus failed", () => this.controller.selectCenter(center)),
        onPreviewSuggestion: (suggestionId) => this.runAction("Change preview failed", () => this.controller.previewSuggestion(suggestionId)),
        onPreviewSuggestionIds: (suggestionIds) => this.runAction("Change preview failed", () => this.controller.previewSuggestionIds(suggestionIds)),
        onRetryScan: () => this.runAction("Index retry failed", () => this.controller.startInitialScan()),
        onUndoHistory: (id) => this.runAction("Undo preview failed", () => this.controller.previewUndo(id)),
        onViewRecovery: (id) => this.runAction("Recovery view failed", () => this.controller.viewRecovery(id)),
        onClearHistory: () => this.runAction("History clear failed", () => this.controller.requestClearHistory()),
        onExportHistory: () => this.runAction("History export failed", async () => {
          const exportedAt = new Date().toISOString();
          const json = await this.controller.historyExportJson(exportedAt);
          triggerHistoryDownload(this.contentEl, json, `knowledge-workbench-history-${exportedAt.slice(0, 10)}.json`);
        }),
        onSummarize: (paths) => this.runAction("AI suggestion unavailable", () => this.controller.summarize?.(paths) ?? Promise.resolve()),
        onNameCluster: (paths) => this.runAction("AI suggestion unavailable", () => this.controller.nameCluster?.(paths) ?? Promise.resolve()),
        onExplainRelation: (paths, targetSuggestionId) => this.runAction("AI suggestion unavailable", () => this.controller.explainRelation?.(paths, targetSuggestionId) ?? Promise.resolve()),
        onSuggestLabels: (paths) => this.runAction("AI suggestion unavailable", () => this.controller.suggestLabels?.(paths) ?? Promise.resolve()),
        onSuggestionSelectionChange: () => this.controller.notifySuggestionSelectionChanged?.(),
      }, policy);
    }

    private runAction(label: string, operation: () => Promise<unknown>): void {
      try {
        void operation().catch((error: unknown) => {
          this.controller.reportError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        this.controller.reportError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
