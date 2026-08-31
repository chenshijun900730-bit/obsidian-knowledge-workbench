import {
  CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET,
  type CloudDirectoryBrowserStopReason,
  type CloudDirectoryLayerSnapshot,
} from "../catalog/cloud-directory-browser";
import {
  resolveCloudDirectorySelection,
  type CloudDirectoryPickerPurpose,
  type CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";
import type {
  DirectoryPickerI18n,
  DirectoryPickerMessageKey,
} from "../i18n/workbench-directory-picker-i18n";
import { createWindowedList, type WindowedListSurface } from "./windowed-list";

export type CloudDirectoryBrowserFixedError =
  | "browser-unavailable"
  | "stale-directory"
  | "conflict"
  | "load-failed";

export interface CloudDirectoryBrowserViewState {
  readonly currentPath: string;
  readonly ancestors: readonly Readonly<{ path: string; label: string }>[];
  readonly purpose: CloudDirectoryPickerPurpose;
  readonly layer: CloudDirectoryLayerSnapshot | null;
  readonly visibleDirectories?: CloudDirectoryLayerSnapshot["directories"];
  readonly highlightedPath: string | null;
  readonly activity: "idle" | "running" | "complete" | "incomplete" | "canceled" | "error";
  readonly round: Readonly<{
    checkedEntryCount: number;
    listRequestCount: number;
    elapsedMs: number;
    stopReason: CloudDirectoryBrowserStopReason | null;
  }> | null;
  readonly fixedError: CloudDirectoryBrowserFixedError | null;
}

export interface CloudDirectoryBrowserViewActions {
  readonly onEnter: (path: string) => void;
  readonly onHighlight: (path: string) => void;
  readonly onSelect: (selection: CloudDirectorySelection) => void;
  readonly onBreadcrumb: (path: string) => void;
  readonly onContinue: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}

export interface CloudDirectoryBrowserViewSurface {
  readonly root: HTMLElement;
  update(state: CloudDirectoryBrowserViewState): void;
  dispose(): void;
}

const STOP_REASON_KEYS = {
  complete: "directoryPicker.browser.stop.complete",
  "entry-limit": "directoryPicker.browser.stop.entryLimit",
  "list-request-limit": "directoryPicker.browser.stop.listRequestLimit",
  "time-limit": "directoryPicker.browser.stop.timeLimit",
  "user-canceled": "directoryPicker.browser.stop.userCanceled",
} as const satisfies Record<CloudDirectoryBrowserStopReason, DirectoryPickerMessageKey>;

const fixedErrorKey = (
  error: CloudDirectoryBrowserFixedError,
): DirectoryPickerMessageKey => {
  if (error === "conflict") return "directoryPicker.browser.conflict";
  if (error === "stale-directory") return "directoryPicker.browser.stale";
  if (error === "browser-unavailable") return "directoryPicker.browser.unavailable";
  return "directoryPicker.browser.error.fixed";
};

const safeCategorySelection = (
  state: CloudDirectoryBrowserViewState,
  selectedPath: string,
): CloudDirectorySelection | null => {
  if (state.purpose.kind !== "verification") return null;
  try {
    return resolveCloudDirectorySelection({
      selectionKind: "category",
      purpose: state.purpose,
      currentPath: state.currentPath,
      selectedPath,
    });
  } catch {
    return null;
  }
};

const safeDirectorySelection = (
  state: CloudDirectoryBrowserViewState,
  selectedPath: string,
): CloudDirectorySelection | null => {
  try {
    return resolveCloudDirectorySelection({
      selectionKind: "directory",
      purpose: state.purpose,
      currentPath: state.currentPath,
      selectedPath,
    });
  } catch {
    return null;
  }
};

let browserViewSequence = 0;

export function createCloudDirectoryBrowserView(
  host: HTMLElement,
  i18n: DirectoryPickerI18n,
  initialState: CloudDirectoryBrowserViewState,
  actions: CloudDirectoryBrowserViewActions,
): CloudDirectoryBrowserViewSurface {
  const doc = host.ownerDocument;
  const root = doc.createElement("section");
  root.className = "knowledge-workbench__directory-browser";
  root.dataset.directoryBrowser = "true";
  host.replaceChildren(root);
  let state = initialState;
  let disposed = false;
  let list: WindowedListSurface<CloudDirectoryLayerSnapshot["directories"][number]> | null = null;
  let listRows: CloudDirectoryLayerSnapshot["directories"] | null = null;
  let listPurpose: CloudDirectoryPickerPurpose | null = null;
  let listPath: string | null = null;
  let renderedPath = initialState.currentPath;
  const optionIdPrefix = `knowledge-workbench-directory-browser-${++browserViewSequence}`;
  const numberFormatter = new Intl.NumberFormat(i18n.locale);
  const number = (value: number): string => numberFormatter.format(value);
  const AbortControllerCtor = doc.defaultView?.AbortController ?? AbortController;
  const events = new AbortControllerCtor();

  root.addEventListener("click", (event) => {
    if (disposed) return;
    const target = event.target as Element | null;
    const button = target?.closest?.<HTMLButtonElement>("button[data-action]") ?? null;
    if (button === null || !root.contains(button) || button.disabled) return;
    const action = button.dataset.action;
    const path = button.dataset.directoryPath;
    const directories = state.visibleDirectories ?? state.layer?.directories ?? [];
    const isVisibleDirectory = path !== undefined
      && directories.some((directory) => directory.path === path);
    if (action === "enter-directory" && path !== undefined && isVisibleDirectory) {
      actions.onEnter(path);
    } else if (action === "highlight-directory" && path !== undefined && isVisibleDirectory) {
      actions.onHighlight(path);
    } else if (action === "select-category" && path !== undefined && isVisibleDirectory) {
      const selection = safeCategorySelection(state, path);
      if (selection?.kind === "category") actions.onSelect(selection);
    } else if (
      action === "browse-breadcrumb"
      && path !== undefined
      && state.ancestors.some((ancestor) => ancestor.path === path)
    ) {
      actions.onBreadcrumb(path);
    } else if (action === "select-current-directory") {
      const selection = safeDirectorySelection(state, state.currentPath);
      if (selection !== null && state.activity !== "running") actions.onSelect(selection);
    } else if (action === "select-highlighted-directory") {
      const highlightedPath = state.highlightedPath;
      const selection = highlightedPath === null
        ? null
        : safeDirectorySelection(state, highlightedPath);
      if (selection !== null && state.activity !== "running") actions.onSelect(selection);
    } else if (
      action === "continue-directory-layer"
      && state.activity === "incomplete"
      && state.layer?.nextStart !== null
    ) actions.onContinue();
    else if (action === "retry-directory-layer" && state.activity === "error") actions.onRetry();
    else if (action === "cancel-directory-layer" && state.activity === "running") actions.onCancel();
  }, { signal: events.signal });

  const paint = (): void => {
    if (disposed) return;
    const activeElement = doc.activeElement as HTMLElement | null;
    const preserveListFocus = renderedPath === state.currentPath
      && list !== null
      && activeElement !== null
      && list.element.contains(activeElement);
    const focusedAction = preserveListFocus ? activeElement.dataset.action ?? null : null;
    const focusedDirectoryPath = preserveListFocus
      ? activeElement.dataset.directoryPath ?? null
      : null;
    const focusedListItself = preserveListFocus && activeElement === list?.element;
    const previousScrollTop = renderedPath === state.currentPath
      ? list?.element.scrollTop ?? 0
      : 0;
    const detailsWasOpen = root.querySelector<HTMLDetailsElement>(
      "details.knowledge-workbench__directory-browser-details",
    )?.open ?? false;
    root.replaceChildren();

    const breadcrumb = doc.createElement("nav");
    breadcrumb.className = "knowledge-workbench__directory-browser-breadcrumb";
    breadcrumb.setAttribute("aria-label", i18n.t("directoryPicker.browser.currentPath", {
      path: state.currentPath,
    }));
    for (const ancestor of state.ancestors) {
      const item = doc.createElement("button");
      item.type = "button";
      item.dataset.action = "browse-breadcrumb";
      item.dataset.directoryPath = ancestor.path;
      item.textContent = ancestor.path === "/"
        ? i18n.t("directoryPicker.browser.breadcrumbRoot")
        : ancestor.label;
      breadcrumb.append(item);
    }

    const currentPath = doc.createElement("p");
    currentPath.className = "knowledge-workbench__directory-browser-path";
    currentPath.textContent = i18n.t("directoryPicker.browser.currentPath", {
      path: state.currentPath,
    });
    const selectCurrent = doc.createElement("button");
    selectCurrent.type = "button";
    selectCurrent.dataset.action = "select-current-directory";
    selectCurrent.textContent = i18n.t("directoryPicker.browser.selectFolder");
    const currentSelection = safeDirectorySelection(state, state.currentPath);
    selectCurrent.disabled = currentSelection === null || state.activity === "running";
    if (state.currentPath === "/") {
      const rootWarning = doc.createElement("p");
      rootWarning.className = "knowledge-workbench__directory-browser-warning";
      rootWarning.textContent = i18n.t("directoryPicker.browser.rootNotSelectable");
      root.append(breadcrumb, currentPath, selectCurrent, rootWarning);
    } else root.append(breadcrumb, currentPath, selectCurrent);

    const status = doc.createElement("p");
    status.className = "knowledge-workbench__directory-browser-status";
    status.dataset.state = state.activity;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    let statusText = "";
    if (state.activity === "running") statusText = i18n.t("directoryPicker.browser.loading");
    else if (state.activity === "complete") statusText = i18n.t("directoryPicker.browser.complete");
    else if (state.activity === "incomplete") statusText = i18n.t("directoryPicker.browser.incomplete");
    else if (state.activity === "canceled") statusText = i18n.t("directoryPicker.browser.canceled");
    else if (state.fixedError !== null) statusText = i18n.t(fixedErrorKey(state.fixedError));
    if (statusText.length > 0) {
      const icon = doc.createElement("span");
      icon.className = "knowledge-workbench__directory-browser-state-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = state.activity === "complete"
        ? "✓"
        : state.activity === "running" ? "…" : "⚠";
      status.append(icon, doc.createTextNode(statusText));
    }
    root.append(status);

    const progressSummary = doc.createElement("div");
    progressSummary.className = "knowledge-workbench__directory-browser-progress";
    const progress = doc.createElement("progress");
    progress.max = CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxEntryCount;
    progress.value = Math.min(
      state.round?.checkedEntryCount ?? 0,
      CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxEntryCount,
    );
    progress.dataset.directoryBrowserProgress = "true";
    progress.dataset.complete = String(state.activity === "complete");
    progress.setAttribute("aria-label", i18n.t("directoryPicker.browser.progress.checked", {
      checked: number(state.round?.checkedEntryCount ?? 0),
      maximum: number(CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxEntryCount),
    }));
    const checked = doc.createElement("p");
    checked.textContent = i18n.t("directoryPicker.browser.progress.checked", {
      checked: number(state.round?.checkedEntryCount ?? 0),
      maximum: number(CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxEntryCount),
    });
    const found = doc.createElement("p");
    found.textContent = i18n.t("directoryPicker.browser.progress.found", {
      found: number(state.layer?.directories.length ?? 0),
    });
    progressSummary.append(progress, checked, found);
    root.append(progressSummary);

    const details = doc.createElement("details");
    details.className = "knowledge-workbench__directory-browser-details";
    details.open = detailsWasOpen;
    const detailsSummary = doc.createElement("summary");
    detailsSummary.textContent = i18n.t("directoryPicker.browser.details.title");
    details.append(detailsSummary);
    const detail = (text: string): void => {
      const item = doc.createElement("p");
      item.textContent = text;
      details.append(item);
    };
    detail(i18n.t("directoryPicker.browser.progress.requests", {
      round: `${number(state.round?.listRequestCount ?? 0)}/${number(
        CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxListRequestCount,
      )}`,
      cumulative: number(state.layer?.cumulativeListRequestCount ?? 0),
    }));
    detail(i18n.t("directoryPicker.browser.progress.cursor", {
      cursor: state.layer?.nextStart === null || state.layer === null
        ? "—"
        : number(state.layer.nextStart),
    }));
    detail(i18n.t("directoryPicker.browser.progress.time", {
      milliseconds: `${number(state.round?.elapsedMs ?? 0)}/${number(
        CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxDurationMs,
      )}`,
    }));
    const stopReason = state.round?.stopReason ?? state.layer?.lastStopReason;
    const completeness = state.layer?.complete === true
      ? i18n.t("directoryPicker.browser.stop.complete")
      : i18n.t("directoryPicker.browser.incomplete");
    detail(i18n.t("directoryPicker.browser.progress.completeness", {
      state: stopReason === null || stopReason === undefined
        ? completeness
        : `${completeness} · ${i18n.t(STOP_REASON_KEYS[stopReason])}`,
    }));
    const cumulative = doc.createElement("p");
    cumulative.dataset.directoryBrowserCumulative = "true";
    cumulative.textContent = i18n.t("directoryPicker.browser.progress.cumulativeChecked", {
      checked: number(state.layer?.cumulativeCheckedEntryCount ?? 0),
    });
    details.append(cumulative);
    root.append(details);

    const directories = state.visibleDirectories ?? state.layer?.directories ?? [];
    if (
      list === null
      || listRows !== directories
      || listPurpose !== state.purpose
      || listPath !== state.currentPath
    ) {
      list?.dispose();
      list = createWindowedList(doc, {
        rows: directories,
        rowHeight: 44,
        windowSize: 100,
        overscan: 10,
        renderRow(directory, index) {
          const row = doc.createElement("li");
          row.className = "knowledge-workbench__directory-browser-row";
          row.dataset.directoryPath = directory.path;
          row.id = `${optionIdPrefix}-${index}`;
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", String(state.highlightedPath === directory.path));
          row.setAttribute("aria-posinset", String(index + 1));
          row.setAttribute("aria-setsize", String(directories.length));
          const enter = doc.createElement("button");
          enter.type = "button";
          enter.className = "knowledge-workbench__directory-browser-enter";
          enter.dataset.action = "enter-directory";
          enter.dataset.directoryPath = directory.path;
          enter.textContent = `${directory.filename} →`;
          enter.setAttribute("aria-label", `${i18n.t("directoryPicker.browser.enter")}: ${directory.filename}`);
          const highlight = doc.createElement("button");
          highlight.type = "button";
          highlight.className = "knowledge-workbench__directory-browser-highlight";
          highlight.dataset.action = "highlight-directory";
          highlight.dataset.directoryPath = directory.path;
          highlight.setAttribute("aria-pressed", String(state.highlightedPath === directory.path));
          highlight.textContent = i18n.t("directoryPicker.browser.highlight");
          row.append(enter, highlight);
          const category = safeCategorySelection(state, directory.path);
          if (category?.kind === "category") {
            const group = state.purpose.kind === "verification"
              ? state.purpose.groups.find((candidate) => candidate.groupKey === category.groupKey)
              : undefined;
            if (group !== undefined) {
              const selectCategory = doc.createElement("button");
              selectCategory.type = "button";
              selectCategory.className = "knowledge-workbench__directory-browser-category";
              selectCategory.dataset.action = "select-category";
              selectCategory.dataset.directoryPath = directory.path;
              selectCategory.dataset.groupKey = category.groupKey;
              selectCategory.textContent = i18n.t("directoryPicker.browser.selectCategory", {
                label: group.label,
              });
              row.append(selectCategory);
            }
          }
          return row;
        },
      });
      listRows = directories;
      listPurpose = state.purpose;
      listPath = state.currentPath;
    }
    list.element.dataset.directoryBrowserList = "true";
    list.element.setAttribute("role", "listbox");
    list.element.setAttribute("aria-label", i18n.t("directoryPicker.browser.currentPath", {
      path: state.currentPath,
    }));
    list.element.tabIndex = 0;
    const highlightedIndex = state.highlightedPath === null
      ? -1
      : directories.findIndex((directory) => directory.path === state.highlightedPath);
    if (highlightedIndex >= 0) list.element.setAttribute(
      "aria-activedescendant",
      `${optionIdPrefix}-${highlightedIndex}`,
    );
    else list.element.removeAttribute("aria-activedescendant");
    const windowStart = Math.max(0, Math.floor(previousScrollTop / 44) - 10);
    const nextScrollTop = highlightedIndex >= 0
      && (highlightedIndex < windowStart || highlightedIndex >= windowStart + 100)
      ? highlightedIndex * 44
      : previousScrollTop;
    list.element.scrollTop = nextScrollTop;
    const EventCtor = doc.defaultView?.Event ?? Event;
    list.element.dispatchEvent(new EventCtor("scroll"));
    for (const row of Array.from(
      list.element.querySelectorAll<HTMLElement>(".knowledge-workbench__directory-browser-row"),
    )) {
      const selected = row.dataset.directoryPath === state.highlightedPath;
      row.setAttribute("aria-selected", String(selected));
      row.querySelector<HTMLElement>('[data-action="highlight-directory"]')
        ?.setAttribute("aria-pressed", String(selected));
    }
    root.append(list.element);
    if (focusedListItself) list.element.focus({ preventScroll: true });
    else if (focusedAction !== null) {
      const focusedControl = Array.from(
        list.element.querySelectorAll<HTMLElement>("button[data-action]"),
      ).find((control) => (
        control.dataset.action === focusedAction
        && control.dataset.directoryPath === focusedDirectoryPath
      ));
      focusedControl?.focus({ preventScroll: true });
    }
    if (directories.length === 0 && state.activity === "complete") {
      const empty = doc.createElement("p");
      empty.className = "knowledge-workbench__empty";
      empty.textContent = i18n.t("directoryPicker.browser.empty");
      root.append(empty);
    }

    if (state.highlightedPath !== null) {
      const highlighted = doc.createElement("p");
      highlighted.textContent = i18n.t("directoryPicker.browser.highlighted", {
        path: state.highlightedPath,
      });
      const select = doc.createElement("button");
      select.type = "button";
      select.dataset.action = "select-highlighted-directory";
      select.textContent = i18n.t("directoryPicker.browser.selectFolder");
      const selection = safeDirectorySelection(state, state.highlightedPath);
      select.disabled = selection === null || state.activity === "running";
      root.append(highlighted, select);
    }

    const controls = doc.createElement("div");
    controls.className = "knowledge-workbench__directory-browser-actions";
    if (state.activity === "incomplete" && state.layer?.nextStart !== null) {
      const more = doc.createElement("button");
      more.type = "button";
      more.dataset.action = "continue-directory-layer";
      more.textContent = i18n.t("directoryPicker.browser.continue");
      controls.append(more);
    }
    if (state.activity === "error") {
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.dataset.action = "retry-directory-layer";
      retry.textContent = i18n.t("directoryPicker.browser.retry");
      controls.append(retry);
    }
    if (state.activity === "running") {
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel-directory-layer";
      cancel.textContent = i18n.t("directoryPicker.browser.cancel");
      controls.append(cancel);
    }
    root.append(controls);
    renderedPath = state.currentPath;
  };

  paint();
  return {
    root,
    update(nextState): void {
      if (disposed) return;
      state = nextState;
      paint();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      events.abort();
      list?.dispose();
      list = null;
      listRows = null;
      listPurpose = null;
      listPath = null;
    },
  };
}
