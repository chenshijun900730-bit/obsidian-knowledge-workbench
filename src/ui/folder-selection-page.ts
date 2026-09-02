import type {
  CloudDirectoryCandidateSource,
  RankedCloudDirectoryCandidate,
} from "../catalog/cloud-directory-candidates";
import {
  CLOUD_DIRECTORY_LOCATOR_BUDGET,
  type CloudDirectoryLocatorStopReason,
} from "../catalog/cloud-directory-locator";
import {
  createDirectoryPickerI18n,
  type DirectoryPickerMessageKey,
} from "../i18n/workbench-directory-picker-i18n";
import {
  createCloudDirectoryBrowserView,
  type CloudDirectoryBrowserViewSurface,
} from "./cloud-directory-browser-view";
import type {
  DisposableSurface,
  FolderSelectionHostActions,
  FolderSelectionHostCapability,
  FolderSelectionRenderState,
  FolderSelectionHostSnapshot,
} from "./folder-selection-host";

export type {
  FolderSelectionHostActions as FolderSelectionPageActions,
  FolderSelectionHostSnapshot as FolderSelectionPageModel,
  FolderSelectionRenderState,
} from "./folder-selection-host";

const ALL_SOURCES = [
  "recent",
  "session-cache",
  "txt-group",
  "cloud-locator",
] as const satisfies readonly CloudDirectoryCandidateSource[];

const SOURCE_KEYS = {
  recent: "directoryPicker.filters.recent",
  "session-cache": "directoryPicker.filters.sessionCache",
  "txt-group": "directoryPicker.filters.txtGroup",
  "cloud-locator": "directoryPicker.filters.cloudLocator",
} as const satisfies Record<CloudDirectoryCandidateSource, DirectoryPickerMessageKey>;

const LOOKUP_REASON_KEYS = {
  "directory-limit": "directoryPicker.lookup.reason.directoryLimit",
  "list-request-limit": "directoryPicker.lookup.reason.listRequestLimit",
  "time-limit": "directoryPicker.lookup.reason.timeLimit",
} as const satisfies Partial<Record<CloudDirectoryLocatorStopReason, DirectoryPickerMessageKey>>;

const parentPath = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
};

const browserAncestors = (
  path: string,
): readonly Readonly<{ path: string; label: string }>[] => {
  if (path === "/") return [{ path: "/", label: "/" }];
  const output: Array<Readonly<{ path: string; label: string }>> = [{
    path: "/",
    label: "/",
  }];
  let current = "";
  for (const segment of path.split("/").filter((value) => value.length > 0)) {
    current += `/${segment}`;
    output.push({ path: current, label: segment });
  }
  return output;
};

const advancedVisible = (snapshot: FolderSelectionHostSnapshot): boolean => {
  const { state } = snapshot;
  return state.phase === "lookup-consent"
    || state.phase === "locating"
    || state.phase === "root-consent"
    || state.phase === "browsing"
    || state.lookupDetail !== null
    || state.browserPath !== null
    || state.browserActivity !== "idle"
    || state.statusCode === "query-required"
    || state.statusCode === "lookup-complete"
    || state.statusCode === "lookup-incomplete";
};

const initialCandidate = (item: RankedCloudDirectoryCandidate): boolean => (
  item.candidate.kind === "conflict"
  || (item.candidate.kind === "exact"
    && item.sources.some((source) => source === "recent" || source === "session-cache"))
);

const fire = (
  action: () => Promise<void> | void,
  onRejected: () => void = () => undefined,
): void => {
  try {
    void Promise.resolve(action()).catch(onRejected);
  } catch {
    onRejected();
  }
};

const pageFeedback = (
  i18n: FolderSelectionHostSnapshot["i18n"],
  state: FolderSelectionHostSnapshot["state"],
  feedbackCode: FolderSelectionHostSnapshot["feedbackCode"],
): string => {
  if (feedbackCode === "binding-failed") {
    return i18n.t("folderSelection.bindingFailed");
  }
  if (state.statusCode === "save-failed") {
    return i18n.t("directoryPicker.notice.persistenceFailure");
  }
  if (state.statusCode === "selection-invalid") {
    return i18n.t("folderSelection.selectionInvalid");
  }
  if (state.statusCode === "query-required") {
    return i18n.t("folderSelection.queryRequired");
  }
  if (state.browserPath === null && state.statusCode === "browser-error") {
    return i18n.t(
      state.browserDetail.fixedError === "browser-unavailable"
        ? "directoryPicker.browser.unavailable"
        : "directoryPicker.browser.error.fixed",
    );
  }
  return "";
};

const lookupFeedback = (
  i18n: FolderSelectionHostSnapshot["i18n"],
  state: FolderSelectionHostSnapshot["state"],
): string => {
  if (state.statusCode === "lookup-running") {
    return i18n.t("directoryPicker.lookup.running");
  }
  if (state.statusCode !== "lookup-complete" && state.statusCode !== "lookup-incomplete") {
    return "";
  }
  const detail = state.lookupDetail;
  if (detail === null) return i18n.t("directoryPicker.lookup.error");
  const values = {
    directories: detail.directoryCount,
    matches: detail.matchCount,
    requests: detail.listRequestCount,
    milliseconds: detail.elapsedMs,
  };
  if (detail.status === "complete") {
    return i18n.t("folderSelection.lookup.complete", values);
  }
  if (detail.status === "canceled") {
    return i18n.t("folderSelection.lookup.canceled", values);
  }
  const reasonKey = detail.stopReason === "directory-limit"
    || detail.stopReason === "list-request-limit"
    || detail.stopReason === "time-limit"
    ? LOOKUP_REASON_KEYS[detail.stopReason]
    : undefined;
  if (reasonKey === undefined) return i18n.t("directoryPicker.lookup.error");
  return i18n.t("folderSelection.lookup.partial", {
    ...values,
    reason: i18n.t(reasonKey),
  });
};

export function renderFolderSelectionPage(
  root: HTMLElement,
  snapshot: FolderSelectionHostSnapshot,
  actions: FolderSelectionHostActions,
): DisposableSurface {
  const doc = root.ownerDocument;
  const AbortControllerCtor = doc.defaultView?.AbortController ?? AbortController;
  const events = new AbortControllerCtor();
  const { i18n, state } = snapshot;
  const showAdvanced = advancedVisible(snapshot);
  let disposed = false;
  let browserSurface: CloudDirectoryBrowserViewSurface | null = null;

  root.replaceChildren();
  root.className = "knowledge-workbench__folder-selection-page";
  root.dataset.folderSelectionPage = "true";

  const header = doc.createElement("header");
  header.className = "knowledge-workbench__folder-selection-header";
  const back = doc.createElement("button");
  back.type = "button";
  back.dataset.action = "folder-selection-back";
  back.textContent = snapshot.returnLabel;
  back.addEventListener("click", actions.onBack, { signal: events.signal });
  const title = doc.createElement("h2");
  title.textContent = i18n.t("folderSelection.title");
  header.append(back, title);

  const search = doc.createElement("label");
  search.className = "knowledge-workbench__folder-selection-search";
  const searchLabel = doc.createElement("span");
  searchLabel.textContent = i18n.t("directoryPicker.query.label");
  const query = doc.createElement("input");
  query.type = "search";
  query.autocomplete = "off";
  query.dataset.folderSelectionQuery = "true";
  query.dataset.focusKey = "folder-selection-query";
  query.placeholder = i18n.t("directoryPicker.query.placeholder");
  query.value = state.query;
  query.addEventListener("input", () => actions.onQuery(query.value), {
    signal: events.signal,
  });
  search.append(searchLabel, query);

  const browseOther = doc.createElement("button");
  browseOther.type = "button";
  browseOther.dataset.action = "browse-other-folders";
  browseOther.textContent = i18n.t("folderSelection.browseOther");
  browseOther.addEventListener("click", actions.onBrowseOther, { signal: events.signal });

  const results = doc.createElement("section");
  results.className = "knowledge-workbench__folder-selection-results";
  results.dataset.folderSelectionResults = "true";
  results.setAttribute("aria-label", i18n.t("directoryPicker.aria.results"));
  const candidates = showAdvanced
    ? state.rankedCandidates
    : state.rankedCandidates.filter(initialCandidate);
  for (const item of candidates) {
    const { candidate } = item;
    if (candidate.kind === "exact") {
      const option = doc.createElement("button");
      option.type = "button";
      option.className = "knowledge-workbench__folder-selection-candidate";
      option.dataset.candidateKind = "exact";
      option.dataset.directoryPath = candidate.path;
      option.setAttribute("aria-pressed", String(item.selected));
      option.disabled = state.phase === "settling" || state.phase === "closed";
      const name = doc.createElement("strong");
      name.textContent = candidate.filename;
      const path = doc.createElement("span");
      path.className = "knowledge-workbench__folder-selection-parent";
      path.textContent = parentPath(candidate.path);
      path.title = candidate.path;
      option.append(name, path);
      option.addEventListener("click", () => actions.onSelectCandidate(candidate.path), {
        signal: events.signal,
      });
      results.append(option);
      continue;
    }

    const note = doc.createElement("article");
    note.className = candidate.kind === "conflict"
      ? "knowledge-workbench__folder-selection-candidate knowledge-workbench__folder-selection-candidate--conflict"
      : "knowledge-workbench__folder-selection-candidate knowledge-workbench__folder-selection-candidate--hint";
    note.dataset.candidateKind = candidate.kind;
    note.setAttribute("role", "note");
    const name = doc.createElement("strong");
    name.textContent = candidate.filename;
    const identity = doc.createElement("span");
    identity.className = "knowledge-workbench__folder-selection-parent";
    identity.textContent = candidate.kind === "conflict"
      ? candidate.path
      : i18n.t("directoryPicker.result.pathUnverified");
    const explanation = doc.createElement("p");
    explanation.textContent = candidate.kind === "conflict"
      ? i18n.t("directoryPicker.result.conflict")
      : i18n.t("directoryPicker.result.hint");
    note.append(name, identity, explanation);
    results.append(note);
  }
  if (candidates.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "knowledge-workbench__empty";
    empty.textContent = i18n.t("directoryPicker.results.empty");
    results.append(empty);
  }

  const selected = doc.createElement("section");
  selected.className = "knowledge-workbench__folder-selection-selected";
  selected.dataset.folderSelectionSelected = "true";
  selected.setAttribute("aria-label", i18n.t("directoryPicker.aria.selection"));
  const selectedTitle = doc.createElement("strong");
  selectedTitle.textContent = i18n.t("directoryPicker.selected.title");
  const selectedPath = doc.createElement("p");
  const draftPath = state.draftSelection?.selectedPath ?? null;
  selectedPath.textContent = draftPath === null
    ? i18n.t("directoryPicker.selected.none")
    : i18n.t("directoryPicker.selected.path", { path: draftPath });
  const use = doc.createElement("button");
  use.type = "button";
  use.dataset.action = "use-folder-selection";
  use.textContent = snapshot.legacyProgressMode === "requires-fresh"
    ? i18n.t("folderSelection.useFresh")
    : i18n.t("directoryPicker.use");
  use.disabled = state.draftSelection === null
    || (state.phase !== "local" && state.phase !== "browsing")
    || state.browserActivity === "running";
  const feedback = doc.createElement("p");
  feedback.className = "knowledge-workbench__folder-selection-feedback";
  feedback.dataset.folderSelectionFeedback = "true";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.setAttribute("aria-atomic", "true");
  const setFeedback = (message: string): void => {
    feedback.textContent = message;
    feedback.hidden = message.length === 0;
  };
  setFeedback(pageFeedback(i18n, state, snapshot.feedbackCode));
  const showBindingFailure = (): void => {
    if (disposed) return;
    setFeedback(i18n.t("folderSelection.bindingFailed"));
  };
  use.addEventListener("click", () => {
    setFeedback("");
    fire(actions.onUse, showBindingFailure);
  }, { signal: events.signal });
  selected.append(selectedTitle, selectedPath);
  if (snapshot.legacyProgressMode !== "none") {
    const legacy = doc.createElement("p");
    legacy.className = "knowledge-workbench__folder-selection-legacy";
    legacy.dataset.legacyProgressMode = snapshot.legacyProgressMode;
    legacy.textContent = i18n.t(
      snapshot.legacyProgressMode === "will-preserve"
        ? "folderSelection.willPreserve"
        : "folderSelection.requiresFresh",
    );
    selected.append(legacy);
  }
  selected.append(feedback, use);

  root.append(header, search, results, selected, browseOther);

  if (showAdvanced) {
    const advanced = doc.createElement("section");
    advanced.className = "knowledge-workbench__folder-selection-advanced";
    advanced.dataset.folderSelectionAdvanced = "true";
    const advancedTitle = doc.createElement("h3");
    advancedTitle.textContent = i18n.t("folderSelection.advanced");
    advanced.append(advancedTitle);

    const filters = doc.createElement("fieldset");
    filters.setAttribute("aria-label", i18n.t("directoryPicker.aria.filters"));
    const legend = doc.createElement("legend");
    legend.textContent = i18n.t("directoryPicker.filters.label");
    filters.append(legend);
    for (const source of ALL_SOURCES) {
      const filter = doc.createElement("button");
      filter.type = "button";
      filter.dataset.directorySource = source;
      filter.setAttribute("aria-pressed", String(state.enabledSources.includes(source)));
      filter.textContent = i18n.t(SOURCE_KEYS[source]);
      filter.addEventListener("click", () => actions.onToggleSource(source), {
        signal: events.signal,
      });
      filters.append(filter);
    }
    advanced.append(filters);

    const lookup = doc.createElement("section");
    lookup.className = "knowledge-workbench__folder-selection-lookup";
    const lookupTitle = doc.createElement("strong");
    lookupTitle.textContent = i18n.t("directoryPicker.lookup.confirmation.title");
    const lookupBudget = doc.createElement("p");
    lookupBudget.textContent = i18n.t("directoryPicker.lookup.confirmation.budget", {
      directories: CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDirectoryCount,
      requests: CLOUD_DIRECTORY_LOCATOR_BUDGET.maxListRequestCount,
      seconds: CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDurationMs / 1000,
    });
    lookup.append(lookupTitle, lookupBudget);
    const lookupMessage = lookupFeedback(i18n, state);
    if (lookupMessage.length > 0) {
      const lookupStatus = doc.createElement("p");
      lookupStatus.className = "knowledge-workbench__folder-selection-lookup-status";
      lookupStatus.dataset.folderSelectionLookupStatus = "true";
      lookupStatus.setAttribute("role", "status");
      lookupStatus.setAttribute("aria-live", "polite");
      lookupStatus.setAttribute("aria-atomic", "true");
      lookupStatus.textContent = lookupMessage;
      lookup.append(lookupStatus);
    }
    if (state.phase === "lookup-consent") {
      const confirmLookup = doc.createElement("button");
      confirmLookup.type = "button";
      confirmLookup.dataset.action = "confirm-directory-lookup";
      confirmLookup.textContent = i18n.t("directoryPicker.lookup.confirmation.confirm");
      confirmLookup.addEventListener("click", () => fire(actions.onConfirmLookup), {
        signal: events.signal,
      });
      lookup.append(confirmLookup);
    } else if (state.phase === "locating") {
      const running = doc.createElement("p");
      running.setAttribute("role", "status");
      running.textContent = i18n.t("directoryPicker.lookup.running");
      lookup.append(running);
    }
    advanced.append(lookup);

    const revealRoot = doc.createElement("button");
    revealRoot.type = "button";
    revealRoot.dataset.action = "reveal-root-browser";
    revealRoot.textContent = i18n.t("directoryPicker.browser.browseRoot");
    revealRoot.addEventListener("click", actions.onRevealRoot, { signal: events.signal });
    advanced.append(revealRoot);

    if (state.phase === "root-consent") {
      const rootDisclosure = doc.createElement("section");
      rootDisclosure.className = "knowledge-workbench__folder-selection-root-disclosure";
      const disclosureTitle = doc.createElement("strong");
      disclosureTitle.textContent = i18n.t("directoryPicker.browser.rootDisclosure.title");
      const disclosureBody = doc.createElement("p");
      disclosureBody.textContent = i18n.t("directoryPicker.browser.rootDisclosure.body");
      const confirmRoot = doc.createElement("button");
      confirmRoot.type = "button";
      confirmRoot.dataset.action = "confirm-root-browser";
      confirmRoot.textContent = i18n.t("directoryPicker.browser.rootDisclosure.confirm");
      confirmRoot.addEventListener("click", actions.onConfirmRoot, { signal: events.signal });
      rootDisclosure.append(disclosureTitle, disclosureBody, confirmRoot);
      advanced.append(rootDisclosure);
    }

    if (state.browserPath !== null) {
      const browserHost = doc.createElement("div");
      browserHost.dataset.folderSelectionBrowser = "true";
      advanced.append(browserHost);
      browserSurface = createCloudDirectoryBrowserView(
        browserHost,
        i18n,
        {
          currentPath: state.browserPath,
          ancestors: browserAncestors(state.browserPath),
          purpose: state.purpose,
          layer: state.browserLayer,
          visibleDirectories: state.visibleBrowserDirectories,
          highlightedPath: state.browserHighlightedPath,
          activity: state.browserActivity,
          round: state.browserDetail.round,
          fixedError: state.browserDetail.fixedError,
        },
        {
          onEnter: actions.onBrowserAction.onNavigate,
          onHighlight: (path) => actions.onBrowserAction.onHighlight(path),
          onSelectCurrent: () => fire(actions.onBrowserAction.onSelectCurrent),
          onSelectHighlighted: () => fire(actions.onBrowserAction.onSelectHighlighted),
          onSelectCategory: (path) => fire(() => actions.onBrowserAction.onSelectCategory(path)),
          onBreadcrumb: actions.onBrowserAction.onNavigate,
          onContinue: () => fire(actions.onBrowserAction.onContinue),
          onRetry: () => fire(actions.onBrowserAction.onRetry),
          onCancel: actions.onBrowserAction.onCancel,
        },
      );
    }
    root.append(advanced);
  }

  if (state.phase === "local") query.focus({ preventScroll: true });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      events.abort();
      browserSurface?.dispose();
      browserSurface = null;
    },
  };
}

export const createFolderSelectionHostCapability = (): FolderSelectionHostCapability => ({
  available: true,
  render(root, state: FolderSelectionRenderState, actions) {
    return renderFolderSelectionPage(root, {
      revision: state.revision,
      i18n: createDirectoryPickerI18n(state.locale),
      state: state.state,
      returnLabel: state.returnLabel,
      legacyProgressMode: state.legacyProgressMode,
      ...(state.feedbackCode === undefined ? {} : { feedbackCode: state.feedbackCode }),
    }, actions);
  },
});
