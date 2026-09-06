import type { ItemView, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE } from "../constants";
import type { FocusedMap, MapFilter, MapSearchResult } from "../map/map-service";
import type { TodayViewModel } from "../today/today-service";
import type { SuggestedOperation } from "../suggestions/suggestion-service";
import type { TodayFilter } from "./today-pane";
import { renderHistory, triggerHistoryDownload, type HistoryViewModel } from "./history-tab";
import type { AiAction } from "../core/ports";
import type { AiResult } from "../ai/ai-enhancement-service";
import { renderAiSuggestion } from "./ai-suggestion";
import {
  NORMAL_RUNTIME_POLICY,
  type RuntimeSafetyPolicy,
} from "../runtime/safety-policy";
import type {
  CloudCatalogConnectionViewModel,
  CloudCatalogViewModel,
} from "../catalog/cloud-catalog-runtime";
import type {
  HybridCatalogGroupViewModel,
  HybridCatalogViewModel,
} from "../catalog/hybrid-catalog-runtime";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../catalog/hybrid-catalog-types";
import {
  createWorkbenchI18n,
  type WorkbenchI18n,
  type WorkbenchLocale,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";
import { renderWorkbenchShell } from "./workbench-shell";
import { renderStartPage, type StartSection } from "./start-page";
import { renderMorePage } from "./more-page";
import {
  routeForTab,
  type WorkbenchRoute,
} from "./workbench-route";
import type { SettingsSectionsSurface } from "./settings-sections";
import {
  renderVerificationCategoryEditor,
  renderVerificationPage,
  type VerificationPageSurface,
} from "./verification-page";
import type { VerificationActionMessageCode } from "./catalog-message-presenter";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";
import type {
  LibraryWorkflowState,
  PendingCatalogTxtDraft,
} from "./library-workflow-state";
import {
  renderLibraryPage,
  type RecentLibraryItem,
} from "./library-page";
import { renderTaskPage } from "./task-page";
import { createLocalCatalogTxtPicker } from "./local-catalog-txt-picker";
import type {
  DisposableSurface,
  FolderSelectionHostActions,
  FolderSelectionHostCapability,
  FolderSelectionRenderState,
} from "./folder-selection-host";

export type { WorkbenchRoute, WorkbenchTab } from "./workbench-route";
export type { StartSection } from "./start-page";
export type ProgressStatus = "idle" | "running" | "canceled" | "error" | "complete";
type HostActionMessageKey = Extract<WorkbenchMessageKey, `host.action.${string}`>;
type AiStatusMessageKey = Extract<WorkbenchMessageKey, `ai.${string}`>;
export interface WorkbenchProgress {
  readonly status: ProgressStatus;
  readonly completed: number;
  readonly total?: number;
  readonly label: string;
}
export interface WorkbenchViewModel {
  readonly locale: WorkbenchLocale;
  readonly openAtStartup?: boolean;
  readonly status: "ready" | "canceled" | "error";
  readonly statusMessage?: string;
  readonly route: WorkbenchRoute;
  readonly startSection: StartSection;
  readonly catalog: CloudCatalogViewModel;
  readonly catalogConnection?: CloudCatalogConnectionViewModel;
  readonly hybridCatalog?: HybridCatalogViewModel;
  readonly pendingCatalogTxt: PendingCatalogTxtDraft | null;
  readonly taskActionPending: boolean;
  readonly taskActionRevision: number;
  readonly taskPauseRequested: boolean;
  readonly boundLibraryPath: string | null;
  readonly workflow: LibraryWorkflowState;
  readonly folderSelection?: FolderSelectionRenderState;
  readonly verificationRoot: string;
  readonly verificationRootLocked: boolean;
  readonly verificationDirectorySelection?: CloudDirectorySelection;
  readonly verificationActionMessageCode?: VerificationActionMessageCode;
  readonly selectedVerificationGroupKeys: readonly string[];
  readonly selectedCatalogId: string | null;
  readonly catalogFiltersExpanded: boolean;
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
  readonly onSelectRoute: (route: WorkbenchRoute) => void;
  readonly onOpenTaskOverview?: () => void;
  readonly onSelectStartSection: (section: StartSection) => void;
  readonly onSetLocale?: (locale: WorkbenchLocale) => void | Promise<void>;
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
  readonly onSearchCatalog: (query: string) => void;
  readonly onFilterCatalogFolder: (prefix: string) => void;
  readonly onToggleCatalogStatus: (status: CatalogVerificationStatus) => void;
  readonly onToggleCatalogDifference: (kind: CatalogDifferenceKind) => void;
  readonly onFilterCatalogGroup: (groupKey: string) => void;
  readonly onFilterCatalogTag: (tag: string) => void;
  readonly onToggleCatalogCloudMissing: (include: boolean) => void;
  readonly onCatalogPage: (page: number) => void;
  readonly onCopyCatalogFilename: (catalogId: string) => void;
  readonly onCopyCatalogPath: (catalogId: string) => void;
  readonly onOpenBaidu: () => void;
  readonly onSelectCatalogRecord: (catalogId: string) => void;
  readonly onSetCatalogFiltersExpanded: (expanded: boolean) => void;
  readonly onSetVerificationRoot: (value: string) => void;
  readonly onToggleVerificationGroup: (groupKey: string) => void;
  readonly onStartSelectedVerification: () => Promise<void>;
  readonly onResumeSelectedVerification: () => Promise<void>;
  readonly onCancelSelectedVerification: () => void;
  readonly onTaskPrimary: (revision: number) => Promise<void> | void;
  readonly onTaskChooseDifferentCategory: () => void;
  readonly onTaskSaveCategorySelection: (
    revision: number,
    input: Readonly<{ rootPath: string; groupKeys: readonly string[] }>,
  ) => void;
  readonly onTaskCancelCategorySelection: () => void;
  readonly onTaskOpenDetails: () => void;
  readonly onBrowseVerificationRoot?: () => Promise<CloudDirectorySelection | null>;
  readonly onApplyVerificationDirectorySelection?: (selection: CloudDirectorySelection) => void;
  readonly onOpenVerificationFolderSelection?: () => void;
  readonly folderSelectionActions?: (
    expectedRevision: number,
  ) => FolderSelectionHostActions;
}

const PROGRESS_LABEL_KEYS = {
  Index: "progress.label.index",
  Map: "progress.label.map",
} as const satisfies Record<string, WorkbenchMessageKey>;

const progressLabel = (label: string, i18n: WorkbenchI18n): string => {
  const key = PROGRESS_LABEL_KEYS[label as keyof typeof PROGRESS_LABEL_KEYS];
  return key === undefined ? label : i18n.t(key);
};

const progressText = (progress: WorkbenchProgress, i18n: WorkbenchI18n): string => {
  const amount = progress.total === undefined
    ? i18n.number(progress.completed)
    : `${i18n.number(progress.completed)} / ${i18n.number(progress.total)}`;
  const label = progressLabel(progress.label, i18n);
  if (progress.status === "running") return i18n.t("progress.workbench.running", { label, amount });
  return i18n.t("progress.workbench.state", {
    label,
    status: i18n.t(`progress.status.${progress.status}`),
    amount,
  });
};

const STATUS_MESSAGE_KEYS: Readonly<Record<string, WorkbenchMessageKey>> = {
  "Executing changes": "host.status.executing",
  "Changes completed": "host.status.changesCompleted",
  "Changes rolled back": "host.status.changesRolledBack",
  "Recovery required; organization writes are locked": "host.status.recoveryLocked",
  "History cleared": "host.status.historyCleared",
  "Map calculation failed": "host.status.mapFailed",
  "Workbench projection refresh failed": "host.status.projectionFailed",
  "task.txtContentUnchanged": "task.txtContentUnchanged",
  "task.txtImportFailed": "task.txtImportFailed",
  "verification-must-pause": "cloudAuthority.verificationMustPause",
  "scan-must-cancel": "cloudAuthority.scanMustCancel",
  "cloud-authority-operation-busy": "cloudAuthority.operationBusy",
  "authorization-attempt-unavailable": "cloudAuthority.authorizationAttemptUnavailable",
  "folder-selection-preserved": "folderSelection.preserved",
  "folder-selection-binding-failed": "host.status.actionFailed",
};

const verificationPageSurfaces = new WeakMap<HTMLElement, VerificationPageSurface>();
const folderSelectionPageSurfaces = new WeakMap<HTMLElement, DisposableSurface>();
const settingsPageSurfaces = new WeakMap<HTMLElement, SettingsSectionsSurface>();
const settingsPageSections = new WeakMap<HTMLElement, string>();
const recentLibraryItems = new WeakMap<HTMLElement, readonly RecentLibraryItem[]>();

const recordRecentLibraryItem = (
  root: HTMLElement,
  model: WorkbenchViewModel,
  catalogId: string,
): void => {
  const record = model.catalog.items.find((item) => item.catalogId === catalogId);
  if (record === undefined) return;
  const filenameSuffix = `/${record.filename}`;
  const pathDirectory = record.pathLabel.endsWith(filenameSuffix)
    ? record.pathLabel.slice(0, -filenameSuffix.length)
    : record.pathLabel;
  const directoryTag = record.hierarchyTags
    .map((tag) => tag.startsWith("folder/") ? tag.slice("folder/".length) : tag)
    .join(" › ") || pathDirectory || "/";
  const recent = Object.freeze({
    catalogId: record.catalogId,
    filename: record.filename,
    directoryTag,
  });
  recentLibraryItems.set(root, Object.freeze([
    recent,
    ...(recentLibraryItems.get(root) ?? []).filter((item) => item.catalogId !== catalogId),
  ].slice(0, 5)));
};

const verificationPickerPurpose = (
  model: WorkbenchViewModel,
): Extract<CloudDirectoryPickerPurpose, { kind: "verification" }> => ({
  kind: "verification",
  groups: (model.hybridCatalog?.active?.groups ?? [])
    .filter((group) => group.groupKey !== "txt-root-items")
    .map((group) => ({
      groupKey: group.groupKey,
      rootRelativePath: group.rootRelativePath,
      label: group.label,
    })),
});

const visibleTaskGroupScope = (
  model: WorkbenchViewModel,
): readonly HybridCatalogGroupViewModel[] => {
  const groups = model.hybridCatalog?.active?.groups ?? [];
  const byKey = new Map(groups.map((group) => [group.groupKey, group]));
  const batchOwnsScope = ["running", "paused", "retry-later"].includes(model.workflow.kind);
  const keys = batchOwnsScope && model.hybridCatalog?.batch !== undefined
    ? model.hybridCatalog.batch.selectedGroupKeys
    : model.selectedVerificationGroupKeys.length > 0
      ? model.selectedVerificationGroupKeys
      : model.workflow.recommendedGroup === null
        ? []
        : [model.workflow.recommendedGroup.groupKey];
  return keys.flatMap((key) => {
    const group = byKey.get(key);
    return group === undefined ? [] : [{ ...group }];
  });
};

const acceptanceTaskWorkflow = (): LibraryWorkflowState => ({
  kind: "unavailable",
  primaryAction: "open-library",
  titleKey: "workflow.unavailable.title",
  descriptionKey: "workflow.unavailable.description",
  recommendedGroup: null,
  canShowTechnicalDetails: true,
});

const disposeVerificationPage = (root: HTMLElement): void => {
  verificationPageSurfaces.get(root)?.dispose();
  verificationPageSurfaces.delete(root);
};

const isSettingsRoute = (route: WorkbenchRoute): boolean => (
  route.tab === "more"
  && route.page !== "overview"
  && route.page !== "history"
  && route.page !== "knowledge-tools"
);

const disposeSettingsPage = (root: HTMLElement): void => {
  settingsPageSurfaces.get(root)?.dispose();
  settingsPageSurfaces.delete(root);
  settingsPageSections.delete(root);
};

const settingsSectionForRoute = (route: WorkbenchRoute) => {
  if (route.tab !== "more") return undefined;
  switch (route.page) {
    case "connection": return "baidu" as const;
    case "catalog-data": return "catalog-data" as const;
    case "language": return "language" as const;
    case "advanced": return "cloud-scan-advanced" as const;
    case "privacy-ai": return "privacy-ai" as const;
    default: return undefined;
  }
};

const localizedStatusMessage = (
  message: string | undefined,
  status: WorkbenchViewModel["status"],
  i18n: WorkbenchI18n,
): string | undefined => {
  if (message === undefined) return undefined;
  const key = STATUS_MESSAGE_KEYS[message];
  if (key !== undefined) return i18n.t(key);
  if (message.startsWith("host.action.")) {
    return i18n.t(message as HostActionMessageKey);
  }
  if (message === "ai.disabled" || message === "ai.error.safe") return i18n.t(message);
  if (message.startsWith("Plan not executed:")) return i18n.t("host.status.planNotExecuted");
  if (message.startsWith("Read-only acceptance mode blocks")) return i18n.t("acceptance.unavailable");
  return status === "error" ? i18n.t("status.error") : i18n.t("host.status.actionFailed");
};

const statusText = (model: WorkbenchViewModel, i18n: WorkbenchI18n): string => {
  const progress = [model.scanProgress, model.mapProgress]
    .filter((value) => value.status !== "idle")
    .map((value) => progressText(value, i18n));
  const message = localizedStatusMessage(model.statusMessage, model.status, i18n);
  if (message !== undefined) progress.push(message);
  if (progress.length > 0) return progress.join("; ");
  return i18n.t(`status.${model.status}`);
};

const appendProgress = (
  parent: HTMLElement,
  progress: WorkbenchProgress,
  onCancel: () => void,
  i18n: WorkbenchI18n,
  onRetry?: () => void,
): void => {
  if (progress.status === "idle") return;
  const wrap = parent.ownerDocument.createElement("div");
  wrap.className = "knowledge-workbench__progress";
  const label = parent.ownerDocument.createElement("span");
  label.textContent = progressText(progress, i18n);
  wrap.append(label);
  if (progress.status === "running") {
    const cancel = parent.ownerDocument.createElement("button");
    cancel.type = "button";
    cancel.textContent = i18n.t("progress.workbench.cancel", {
      label: progressLabel(progress.label, i18n),
    });
    cancel.addEventListener("click", onCancel);
    wrap.append(cancel);
  } else if ((progress.status === "canceled" || progress.status === "error") && onRetry !== undefined) {
    const retry = parent.ownerDocument.createElement("button");
    retry.type = "button";
    retry.textContent = i18n.t("progress.workbench.retry", {
      label: progressLabel(progress.label, i18n),
    });
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
  settingsSurface?: SettingsSectionsSurface,
  folderSelectionHost?: FolderSelectionHostCapability,
): void {
  const doc = root.ownerDocument;
  const i18n = createWorkbenchI18n(model.locale);
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
  const verificationRunDetailsOpen = root.querySelector<HTMLDetailsElement>(
    "details[data-verification-run-details]",
  )?.open ?? false;
  const verificationDirectoryAdvancedOpen = root.querySelector<HTMLDetailsElement>(
    "details[data-cloud-directory-advanced]",
  )?.open ?? false;
  const renderedSettingsSurface = settingsPageSurfaces.get(root);
  const nextSettingsSection = settingsSectionForRoute(model.route);
  if (
    renderedSettingsSurface !== undefined
    && (
      !isSettingsRoute(model.route)
      || renderedSettingsSurface !== settingsSurface
      || settingsPageSections.get(root) !== nextSettingsSection
    )
  ) {
    disposeSettingsPage(root);
  }
  disposeVerificationPage(root);
  folderSelectionPageSurfaces.get(root)?.dispose();
  folderSelectionPageSurfaces.delete(root);
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
  const shell = renderWorkbenchShell(root, {
    activePage: model.route.tab,
    i18n,
    connectionStatus: model.catalog.status === "unavailable"
      ? "unavailable"
      : model.catalogConnection?.status ?? "unavailable",
    onSelectPage: (tab) => actions.onSelectRoute(routeForTab(tab)),
    onSetLocale: (locale) => { void actions.onSetLocale?.(locale); },
  });
  shell.status.textContent = statusText(model, i18n);
  appendProgress(shell.progress, model.scanProgress, actions.onCancelScan, i18n, actions.onRetryScan);
  appendProgress(shell.progress, model.mapProgress, actions.onCancelMap, i18n);
  if (readOnlyAcceptance) {
    const banner = doc.createElement("div");
    banner.className = "knowledge-workbench__acceptance-banner";
    banner.dataset.acceptanceBanner = "true";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-label", i18n.t("acceptance.banner.aria"));
    banner.textContent = i18n.t("acceptance.banner");
    shell.status.before(banner);
  }
  const panel = shell.panel;
  if (model.route.tab === "library") {
    renderLibraryPage(panel, {
      catalog: model.catalog,
      selectedCatalogId: model.selectedCatalogId,
      recentItems: recentLibraryItems.get(root) ?? [],
      filtersExpanded: model.catalogFiltersExpanded,
      workflow: model.workflow,
      i18n: createWorkbenchI18n(model.locale),
    }, {
      ...surfaceActions,
      onOpenTask: () => surfaceActions.onSelectRoute({
        tab: "task",
        page: "overview",
      }),
      onOpenCatalogDetail: (catalogId) => {
        recordRecentLibraryItem(root, model, catalogId);
        surfaceActions.onSelectCatalogRecord(catalogId);
      },
    });
  } else if (
    model.route.tab === "task"
    && model.route.page === "folder-selection"
  ) {
    if (
      !readOnlyAcceptance
      && model.folderSelection !== undefined
      && folderSelectionHost?.available === true
      && surfaceActions.folderSelectionActions !== undefined
    ) {
      folderSelectionPageSurfaces.set(root, folderSelectionHost.render(
        panel,
        model.folderSelection,
        surfaceActions.folderSelectionActions(model.folderSelection.revision),
      ));
    } else {
      verificationPageSurfaces.set(root, renderVerificationPage(panel, {
        i18n,
        rootPath: model.verificationRoot,
        directorySelection: model.verificationDirectorySelection,
        rootLocked: model.verificationRootLocked,
        actionMessageCode: model.verificationActionMessageCode,
        runDetailsOpen: verificationRunDetailsOpen,
        selectedGroupKeys: model.selectedVerificationGroupKeys,
        connection: model.catalogConnection,
        hybrid: model.hybridCatalog,
        actions: {
          onRootChange: surfaceActions.onSetVerificationRoot,
          onToggleGroup: surfaceActions.onToggleVerificationGroup,
          onStart: surfaceActions.onStartSelectedVerification,
          onResume: surfaceActions.onResumeSelectedVerification,
          onCancel: surfaceActions.onCancelSelectedVerification,
          onDirectorySelection: surfaceActions.onApplyVerificationDirectorySelection
            ?? (() => undefined),
          ...(surfaceActions.onBrowseVerificationRoot === undefined ? {} : {
            onBrowseRoot: surfaceActions.onBrowseVerificationRoot,
          }),
        },
      }));
    }
  } else if (
    model.route.tab === "task"
    && model.route.page === "category-selection"
  ) {
    const groups = model.hybridCatalog?.active?.groups ?? [];
    const selectedGroupKeys = model.selectedVerificationGroupKeys.length > 0
      ? model.selectedVerificationGroupKeys
      : model.workflow.recommendedGroup === null
        ? []
        : [model.workflow.recommendedGroup.groupKey];
    verificationPageSurfaces.set(root, renderVerificationCategoryEditor(panel, {
      i18n,
      groups,
      selectedGroupKeys,
      rootPath: model.verificationRoot || model.boundLibraryPath || "",
      expectedRootPath: model.boundLibraryPath || "",
    }, {
      onSave: (input) => surfaceActions.onTaskSaveCategorySelection(
        model.taskActionRevision,
        input,
      ),
      onCancel: surfaceActions.onTaskCancelCategorySelection,
    }));
  } else if (model.route.tab === "task") {
    const taskWorkflow = readOnlyAcceptance ? acceptanceTaskWorkflow() : model.workflow;
    renderTaskPage(panel, {
      i18n,
      workflow: taskWorkflow,
      boundLibraryPath: model.boundLibraryPath,
      visibleGroupScope: readOnlyAcceptance ? [] : visibleTaskGroupScope(model),
      taskActionRevision: model.taskActionRevision,
      hybrid: model.hybridCatalog,
      actionPending: model.taskActionPending,
      pauseRequested: model.taskPauseRequested,
    }, {
      onPrimary: surfaceActions.onTaskPrimary,
      onChooseDifferentCategory: surfaceActions.onTaskChooseDifferentCategory,
      onOpenDetails: surfaceActions.onTaskOpenDetails,
    }, verificationRunDetailsOpen);
  } else if (model.route.tab === "more" && model.route.page === "overview") {
    renderMorePage(panel, {
      locale: model.locale,
      connectionStatus: model.catalogConnection?.status,
      rememberedLibrary: model.boundLibraryPath,
      activeCatalogCount: model.hybridCatalog?.active?.pdfCount ?? model.catalog.pdfCount,
      openAtStartup: model.openAtStartup ?? false,
      onSelectRoute: surfaceActions.onSelectRoute,
    });
  } else if (model.route.page === "history") {
    renderHistory(panel, model.history ?? { entries: [] }, {
      onUndo: surfaceActions.onUndoHistory ?? (() => undefined),
      onViewRecovery: surfaceActions.onViewRecovery ?? (() => undefined),
      onClear: surfaceActions.onClearHistory ?? (() => undefined),
      onExport: surfaceActions.onExportHistory ?? (() => undefined),
    }, policy, i18n);
  } else if (model.route.page === "knowledge-tools") {
    renderStartPage(panel, { model, actions: surfaceActions, policy });
  } else if (settingsSurface !== undefined) {
    const section = settingsSectionForRoute(model.route);
    if (section === undefined) {
      settingsSurface.render(panel, model.locale);
    } else {
      const subpage = doc.createElement("div");
      subpage.className = "knowledge-workbench__more-subpage";
      panel.append(subpage);
      settingsSurface.render(subpage, model.locale, {
        section,
        onBackToMore: () => surfaceActions.onSelectRoute({ tab: "more", page: "overview" }),
        onOpenTaskOverview: () => surfaceActions.onOpenTaskOverview?.(),
      });
      if (model.route.tab === "more" && model.route.page === "advanced") {
        const privacyAi = doc.createElement("button");
        privacyAi.type = "button";
        privacyAi.dataset.action = "open-privacy-ai";
        privacyAi.textContent = i18n.t("settings.section.privacyAi");
        privacyAi.addEventListener("click", () => surfaceActions.onSelectRoute({
          tab: "more", page: "privacy-ai",
        }));
        const knowledgeTools = doc.createElement("button");
        knowledgeTools.type = "button";
        knowledgeTools.dataset.action = "open-knowledge-tools";
        knowledgeTools.textContent = i18n.t("more.advanced.title");
        knowledgeTools.addEventListener("click", () => surfaceActions.onSelectRoute({
          tab: "more", page: "knowledge-tools",
        }));
        subpage.prepend(knowledgeTools, privacyAi);
      }
    }
    settingsPageSurfaces.set(root, settingsSurface);
    if (section !== undefined) settingsPageSections.set(root, section);
  } else {
    const placeholder = doc.createElement("p");
    placeholder.className = "knowledge-workbench__placeholder";
    placeholder.textContent = i18n.t(readOnlyAcceptance
      ? "acceptance.settings.placeholder"
      : "host.settings.openObsidian");
    panel.append(placeholder);
  }
  if (!readOnlyAcceptance && model.aiSuggestion !== undefined) {
    renderAiSuggestion(panel, model.aiSuggestion.text, i18n);
  }
  if (verificationDirectoryAdvancedOpen) {
    const advanced = root.querySelector<HTMLDetailsElement>(
      "details[data-cloud-directory-advanced]",
    );
    if (advanced !== null) advanced.open = true;
  }
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
  selectRoute(route: WorkbenchRoute): void;
  openTaskOverview?(): void;
  selectStartSection(section: StartSection): void;
  setTodayFilter(filter: TodayFilter): void;
  setLocale(locale: WorkbenchLocale): Promise<void>;
  setMapFilter(filter: MapFilter): Promise<void>;
  openNote(path: string): Promise<void>;
  startQuickCapture(): Promise<string | null>;
  cancelScan(): void;
  cancelMap(): void;
  pin(id: string): Promise<void>;
  dismiss(id: string, mtime: number): Promise<void>;
  searchMap(query: string): void;
  searchCatalog(query: string): void;
  selectCatalogRecord(catalogId: string): void;
  setCatalogFiltersExpanded(expanded: boolean): void;
  filterCatalogFolder(prefix: string): void;
  toggleCatalogStatus(status: CatalogVerificationStatus): void;
  toggleCatalogDifference(kind: CatalogDifferenceKind): void;
  filterCatalogGroup(groupKey: string): void;
  filterCatalogTag(tag: string): void;
  toggleCatalogCloudMissing(include: boolean): void;
  selectCatalogPage(page: number): void;
  copyCatalogFilename(catalogId: string): Promise<void>;
  copyCatalogPath(catalogId: string): Promise<void>;
  openBaidu(): Promise<void>;
  setVerificationRoot(value: string): void;
  chooseCatalogRoot?(input: Readonly<{
    initialRoot: string;
    purpose: CloudDirectoryPickerPurpose;
  }>): Promise<CloudDirectorySelection | null>;
  applyCatalogRootSelection?(selection: CloudDirectorySelection): void;
  openVerificationFolderSelection?(): void;
  folderSelectionActions?(expectedRevision: number): FolderSelectionHostActions;
  closeFolderSelection?(): void;
  toggleVerificationGroup(groupKey: string): void;
  startSelectedVerification(): Promise<void>;
  resumeSelectedVerification(): Promise<void>;
  cancelSelectedVerification(): void;
  performTaskPrimaryAction?(expectedRevision: number): Promise<void>;
  performTaskTxtSelection?(
    expectedRevision: number,
    requestPath: () => Promise<string | null>,
  ): Promise<void>;
  saveTaskCategorySelection?(
    expectedRevision: number,
    input: Readonly<{ rootPath: string; groupKeys: readonly string[] }>,
  ): void;
  selectCenter(center: Readonly<{ kind: "document" | "topic"; id: string }>): Promise<void>;
  previewSuggestion(suggestionId: string): Promise<void>;
  previewSuggestionIds(suggestionIds: readonly string[]): Promise<void>;
  previewUndo(id: string): Promise<void>;
  requestClearHistory(): Promise<void>;
  historyExportJson(exportedAt: string): Promise<string>;
  viewRecovery(id: string): Promise<void>;
  startInitialScan(): Promise<void>;
  reportError(message: string): void;
  summarize?(paths: readonly string[]): Promise<AiResult<string>>;
  nameCluster?(paths: readonly string[]): Promise<AiResult<string>>;
  explainRelation?(paths: readonly string[], targetSuggestionId?: string): Promise<AiResult<string>>;
  suggestLabels?(paths: readonly string[]): Promise<AiResult<string>>;
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
    private readonly localCatalogTxtPicker = createLocalCatalogTxtPicker();
    private localCatalogTxtHost: HTMLElement | null = null;

    constructor(
      leaf: WorkspaceLeaf,
      private readonly controller: WorkbenchViewController,
      private readonly settingsSurface?: SettingsSectionsSurface,
      private readonly folderSelectionHost?: FolderSelectionHostCapability,
    ) {
      super(leaf);
    }

    getViewType(): string { return VIEW_TYPE; }
    getDisplayText(): string {
      return createWorkbenchI18n(this.controller.snapshot().locale).t("host.view.title");
    }
    getIcon(): string { return "network"; }

    async onOpen(): Promise<void> {
      this.unsubscribe?.();
      this.unsubscribe = this.controller.subscribe(() => this.render());
      this.render();
    }

    async onClose(): Promise<void> {
      this.unsubscribe?.();
      this.unsubscribe = null;
      disposeSettingsPage(this.contentEl);
      disposeVerificationPage(this.contentEl);
      folderSelectionPageSurfaces.get(this.contentEl)?.dispose();
      folderSelectionPageSurfaces.delete(this.contentEl);
      recentLibraryItems.delete(this.contentEl);
      this.controller.closeFolderSelection?.();
      this.localCatalogTxtHost?.remove();
      this.localCatalogTxtHost = null;
      this.contentEl.replaceChildren();
    }

    private render(): void {
      const chooseCatalogRoot = policy.mode === "normal"
        ? this.controller.chooseCatalogRoot?.bind(this.controller)
        : undefined;
      const applyCatalogRootSelection = policy.mode === "normal"
        ? this.controller.applyCatalogRootSelection?.bind(this.controller)
        : undefined;
      const openFolderSelectionMethod = this.controller.openVerificationFolderSelection
        ?.bind(this.controller);
      const folderSelectionActionsMethod = this.controller.folderSelectionActions
        ?.bind(this.controller);
      const inlineFolderSelectionAvailable = policy.mode === "normal"
        && this.folderSelectionHost?.available === true
        && openFolderSelectionMethod !== undefined
        && folderSelectionActionsMethod !== undefined;
      const openFolderSelection = inlineFolderSelectionAvailable
        ? openFolderSelectionMethod
        : undefined;
      const folderSelectionActions = inlineFolderSelectionAvailable
        ? folderSelectionActionsMethod
        : undefined;
      const snapshot = this.controller.snapshot();
      renderWorkbench(this.contentEl, snapshot, {
        onSelectRoute: (route) => this.controller.selectRoute(route),
        onOpenTaskOverview: () => {
          if (this.controller.openTaskOverview !== undefined) this.controller.openTaskOverview();
          else this.controller.selectRoute({ tab: "task", page: "overview" });
        },
        onSelectStartSection: (section) => this.controller.selectStartSection(section),
        onSetLocale: (locale) => this.runAction("host.action.languageFailed", () => this.controller.setLocale(locale)),
        onSelectTodayFilter: (filter) => this.controller.setTodayFilter(filter),
        onSelectMapFilter: (filter) => this.runAction("host.action.mapFilterFailed", () => this.controller.setMapFilter(filter)),
        onOpenNote: (path) => this.runAction("host.action.openNoteFailed", () => this.controller.openNote(path)),
        onQuickCapture: () => this.runAction("host.action.quickCaptureFailed", () => this.controller.startQuickCapture()),
        onCancelScan: () => this.controller.cancelScan(),
        onCancelMap: () => this.controller.cancelMap(),
        onPin: (id) => this.runAction("host.action.pinFailed", () => this.controller.pin(id)),
        onDismiss: (id, mtime) => this.runAction("host.action.dismissFailed", () => this.controller.dismiss(id, mtime)),
        onSearchMap: (query) => this.controller.searchMap(query),
        onSelectCenter: (center) => this.runAction("host.action.mapFocusFailed", () => this.controller.selectCenter(center)),
        onPreviewSuggestion: (suggestionId) => this.runAction("host.action.changePreviewFailed", () => this.controller.previewSuggestion(suggestionId)),
        onPreviewSuggestionIds: (suggestionIds) => this.runAction("host.action.changePreviewFailed", () => this.controller.previewSuggestionIds(suggestionIds)),
        onRetryScan: () => this.runAction("host.action.indexRetryFailed", () => this.controller.startInitialScan()),
        onUndoHistory: (id) => this.runAction("host.action.undoPreviewFailed", () => this.controller.previewUndo(id)),
        onViewRecovery: (id) => this.runAction("host.action.recoveryViewFailed", () => this.controller.viewRecovery(id)),
        onClearHistory: () => this.runAction("host.action.historyClearFailed", () => this.controller.requestClearHistory()),
        onExportHistory: () => this.runAction("host.action.historyExportFailed", async () => {
          const exportedAt = new Date().toISOString();
          const json = await this.controller.historyExportJson(exportedAt);
          triggerHistoryDownload(this.contentEl, json, `knowledge-workbench-history-${exportedAt.slice(0, 10)}.json`);
        }),
        onSummarize: (paths) => this.runAiAction(() => this.controller.summarize?.(paths)),
        onNameCluster: (paths) => this.runAiAction(() => this.controller.nameCluster?.(paths)),
        onExplainRelation: (paths, targetSuggestionId) => this.runAiAction(
          () => this.controller.explainRelation?.(paths, targetSuggestionId),
        ),
        onSuggestLabels: (paths) => this.runAiAction(() => this.controller.suggestLabels?.(paths)),
        onSuggestionSelectionChange: () => this.controller.notifySuggestionSelectionChanged?.(),
        onSearchCatalog: (query) => this.controller.searchCatalog(query),
        onFilterCatalogFolder: (prefix) => this.controller.filterCatalogFolder(prefix),
        onToggleCatalogStatus: (status) => this.controller.toggleCatalogStatus(status),
        onToggleCatalogDifference: (kind) => this.controller.toggleCatalogDifference(kind),
        onFilterCatalogGroup: (groupKey) => this.controller.filterCatalogGroup(groupKey),
        onFilterCatalogTag: (tag) => this.controller.filterCatalogTag(tag),
        onToggleCatalogCloudMissing: (include) => this.controller.toggleCatalogCloudMissing(include),
        onCatalogPage: (page) => this.controller.selectCatalogPage(page),
        onCopyCatalogFilename: (catalogId) => this.runAction("host.action.copyFilenameFailed", () => this.controller.copyCatalogFilename(catalogId)),
        onCopyCatalogPath: (catalogId) => this.runAction("host.action.copyPathFailed", () => this.controller.copyCatalogPath(catalogId)),
        onOpenBaidu: () => this.runAction("host.action.openBaiduFailed", () => this.controller.openBaidu()),
        onSelectCatalogRecord: (catalogId) => this.controller.selectCatalogRecord(catalogId),
        onSetCatalogFiltersExpanded: (expanded) => this.controller.setCatalogFiltersExpanded(expanded),
        onSetVerificationRoot: (value) => this.controller.setVerificationRoot(value),
        onToggleVerificationGroup: (groupKey) => this.controller.toggleVerificationGroup(groupKey),
        onStartSelectedVerification: () => this.controller.startSelectedVerification(),
        onResumeSelectedVerification: () => this.controller.resumeSelectedVerification(),
        onCancelSelectedVerification: () => this.controller.cancelSelectedVerification(),
        onTaskPrimary: (revision) => this.runTaskAction(async () => {
          if (
            policy.mode === "normal"
            && this.controller.snapshot().workflow.primaryAction === "choose-txt"
          ) {
            const select = this.controller.performTaskTxtSelection?.bind(this.controller);
            if (select === undefined) throw new Error("catalog-unavailable");
            await select(
              revision,
              () => this.localCatalogTxtPicker.request(this.localCatalogTxtPickerHost()),
            );
            return;
          }
          const perform = this.controller.performTaskPrimaryAction?.bind(this.controller);
          if (perform === undefined) throw new Error("catalog-unavailable");
          await perform(revision);
        }),
        onTaskChooseDifferentCategory: () => this.controller.selectRoute({
          tab: "task",
          page: "category-selection",
        }),
        onTaskSaveCategorySelection: (revision, input) => {
          try {
            const save = this.controller.saveTaskCategorySelection?.bind(this.controller);
            if (save === undefined) throw new Error("catalog-unavailable");
            save(revision, input);
          } catch {
            this.controller.reportError("host.action.taskFailed");
          }
        },
        onTaskCancelCategorySelection: () => this.controller.selectRoute({
          tab: "task",
          page: "overview",
        }),
        onTaskOpenDetails: () => undefined,
        ...(openFolderSelection === undefined
          ? (chooseCatalogRoot === undefined ? {} : {
              onBrowseVerificationRoot: () => chooseCatalogRoot({
                initialRoot: this.controller.snapshot().verificationRoot,
                purpose: verificationPickerPurpose(this.controller.snapshot()),
              }),
            })
          : {
              onBrowseVerificationRoot: async () => {
                openFolderSelection();
                return null;
              },
              onOpenVerificationFolderSelection: openFolderSelection,
            }),
        ...(folderSelectionActions === undefined ? {} : { folderSelectionActions }),
        ...(applyCatalogRootSelection === undefined ? {} : {
          onApplyVerificationDirectorySelection: applyCatalogRootSelection,
        }),
      }, policy, this.settingsSurface, this.folderSelectionHost);
    }

    private runAction(labelKey: HostActionMessageKey, operation: () => Promise<unknown>): void {
      try {
        void operation().catch(() => {
          this.controller.reportError(labelKey);
        });
      } catch {
        this.controller.reportError(labelKey);
      }
    }

    private async runTaskAction(operation: () => Promise<void>): Promise<void> {
      try {
        await operation();
      } catch {
        this.controller.reportError("host.action.taskFailed");
      }
    }

    /** A sibling of the rerendered page root; removed only when the view closes. */
    private localCatalogTxtPickerHost(): HTMLElement {
      if (this.localCatalogTxtHost?.isConnected) return this.localCatalogTxtHost;
      const host = this.contentEl.ownerDocument.createElement("div");
      host.dataset.localCatalogTxtHost = "true";
      host.setAttribute("aria-hidden", "true");
      (this.contentEl.parentElement ?? this.contentEl.ownerDocument.body).append(host);
      this.localCatalogTxtHost = host;
      return host;
    }

    private runAiAction(operation: () => Promise<AiResult<string>> | undefined): void {
      try {
        const result = operation();
        if (result === undefined) {
          this.controller.reportError("ai.disabled" satisfies AiStatusMessageKey);
          return;
        }
        void result.then((value) => {
          if (value.kind === "local-fallback") {
            this.controller.reportError((value.reason === "disabled"
              ? "ai.disabled"
              : "ai.error.safe") satisfies AiStatusMessageKey);
          }
        }).catch(() => {
          this.controller.reportError("ai.error.safe" satisfies AiStatusMessageKey);
        });
      } catch {
        this.controller.reportError("ai.error.safe" satisfies AiStatusMessageKey);
      }
    }
  };
}
