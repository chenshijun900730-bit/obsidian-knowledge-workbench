import type { App, Modal } from "obsidian";
import {
  type CloudDirectoryCandidateRuntime,
  type CloudDirectoryCandidateSource,
  type RankedCloudDirectoryCandidate,
} from "../catalog/cloud-directory-candidates";
import type { CloudDirectoryBrowserRuntime } from "../catalog/cloud-directory-browser";
import {
  CLOUD_DIRECTORY_LOCATOR_BUDGET,
  type CloudDirectoryLocatorRuntime,
  type CloudDirectoryLocatorStopReason,
} from "../catalog/cloud-directory-locator";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";
import type {
  DirectoryPickerI18n,
  DirectoryPickerMessageKey,
} from "../i18n/workbench-directory-picker-i18n";
import {
  createCloudDirectoryBrowserView,
  type CloudDirectoryBrowserViewSurface,
} from "./cloud-directory-browser-view";
import {
  createCloudDirectoryPickerSession,
  type CloudDirectoryPickerSession,
} from "./cloud-directory-picker-session";
import type { CloudDirectoryPickerSessionState } from "./folder-selection-host";

export interface CloudDirectoryPickerRequest {
  readonly initialPath: string | null;
  readonly purpose: CloudDirectoryPickerPurpose;
  readonly candidates: CloudDirectoryCandidateRuntime;
  readonly browser?: CloudDirectoryBrowserRuntime;
  readonly locator?: CloudDirectoryLocatorRuntime;
}

export interface CloudDirectoryPickerPresenter {
  request(input: CloudDirectoryPickerRequest): Promise<CloudDirectorySelection | null>;
}

export type CloudDirectoryPickerModalConstructor = abstract new (app: App) => Modal;
export type CloudDirectoryPickerNotice = (message: string) => void;

interface PickerUi {
  readonly i18n: DirectoryPickerI18n;
  readonly query: HTMLInputElement;
  readonly filters: HTMLElement;
  readonly results: HTMLElement;
  readonly selected: HTMLElement;
  readonly status: HTMLElement;
  readonly confirmation: HTMLElement;
  readonly confirmationQuery: HTMLElement;
  readonly locate: HTMLButtonElement;
  readonly browseRoot: HTMLButtonElement;
  readonly rootDisclosure: HTMLElement;
  readonly rootDisclosureCancel: HTMLButtonElement;
  readonly rootDisclosureConfirm: HTMLButtonElement;
  readonly browserHost: HTMLElement;
  readonly clearRecent: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly use: HTMLButtonElement;
  readonly confirmLocate: HTMLButtonElement;
}

type RankedExactCandidate = RankedCloudDirectoryCandidate & Readonly<{
  candidate: Extract<
    RankedCloudDirectoryCandidate["candidate"],
    { readonly kind: "exact" }
  >;
}>;

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

const ALL_SOURCES = Object.freeze([
  "recent",
  "session-cache",
  "txt-group",
  "cloud-locator",
] as const satisfies readonly CloudDirectoryCandidateSource[]);

const parentPath = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
};

const browserAncestors = (
  path: string,
  i18n: DirectoryPickerI18n,
): readonly Readonly<{ path: string; label: string }>[] => {
  const output: Array<Readonly<{ path: string; label: string }>> = [{
    path: "/",
    label: i18n.t("directoryPicker.browser.breadcrumbRoot"),
  }];
  if (path === "/") return output;
  let current = "";
  for (const segment of path.slice(1).split("/")) {
    current += `/${segment}`;
    output.push({ path: current, label: segment });
  }
  return output;
};

const lookupStatus = (
  i18n: DirectoryPickerI18n,
  state: CloudDirectoryPickerSessionState,
): string => {
  const detail = state.lookupDetail;
  if (state.statusCode === "lookup-running") {
    return i18n.t("directoryPicker.lookup.running");
  }
  if (state.statusCode !== "lookup-complete" && state.statusCode !== "lookup-incomplete") {
    return "";
  }
  if (detail === null) return i18n.t("directoryPicker.lookup.error");
  if (detail.status === "complete") {
    return i18n.t("directoryPicker.lookup.complete", {
      matches: detail.matchCount,
      directories: detail.directoryCount,
      requests: detail.listRequestCount,
    });
  }
  if (detail.status === "canceled") return i18n.t("directoryPicker.lookup.canceled");
  const reasonKey = detail.stopReason === "directory-limit"
    || detail.stopReason === "list-request-limit"
    || detail.stopReason === "time-limit"
    ? LOOKUP_REASON_KEYS[detail.stopReason]
    : undefined;
  if (reasonKey === undefined) return i18n.t("directoryPicker.lookup.error");
  return i18n.t("directoryPicker.lookup.partial", {
    reason: i18n.t(reasonKey),
    matches: detail.matchCount,
    directories: detail.directoryCount,
    requests: detail.listRequestCount,
  });
};

let pickerInstanceSequence = 0;

export function createCloudDirectoryPickerModalClass(
  ModalBase: CloudDirectoryPickerModalConstructor,
) {
  return class CloudDirectoryPickerModal extends ModalBase
    implements CloudDirectoryPickerPresenter {
    private session: CloudDirectoryPickerSession | null = null;
    private unsubscribeSession: (() => void) | null = null;
    private browserSurface: CloudDirectoryBrowserViewSurface | null = null;
    private lifecycleController: AbortController | null = null;
    private ui: PickerUi | null = null;
    private result: Promise<CloudDirectorySelection | null> | null = null;
    private settleResult: ((value: CloudDirectorySelection | null) => void) | null = null;
    private settled = false;
    private cleaned = false;
    private disposed = false;
    private hasBrowser = false;
    private hasLocator = false;
    private hostGeneration = 0;
    private activeExactIndex = -1;
    private opener: HTMLElement | null = null;
    private readonly optionIdPrefix = `knowledge-workbench-directory-${++pickerInstanceSequence}`;

    constructor(
      app: App,
      private readonly getI18n: () => DirectoryPickerI18n,
      private readonly notify: CloudDirectoryPickerNotice = () => undefined,
    ) {
      super(app);
    }

    request(input: CloudDirectoryPickerRequest): Promise<CloudDirectorySelection | null> {
      if (this.disposed) throw new Error("directory-picker-unavailable");
      if (this.result !== null) return this.result;
      this.hasBrowser = input.browser !== undefined;
      this.hasLocator = input.locator !== undefined;
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.lifecycleController = new AbortController();
      this.hostGeneration += 1;
      this.session = createCloudDirectoryPickerSession({
        candidates: input.candidates,
        purpose: input.purpose,
        initialPath: input.initialPath,
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        ...(input.locator === undefined ? {} : { locator: input.locator }),
      });
      this.result = new Promise((resolve) => { this.settleResult = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      const session = this.session;
      const lifecycle = this.lifecycleController;
      if (session === null || lifecycle === null || this.cleaned) {
        throw new Error("directory-picker-unavailable");
      }
      const generation = this.hostGeneration;
      const { signal } = lifecycle;
      const i18n = this.getI18n();
      const doc = this.contentEl.ownerDocument;
      this.setTitle(i18n.t("directoryPicker.title"));
      this.contentEl.replaceChildren();
      this.contentEl.classList.add("knowledge-workbench__directory-picker");

      const safety = doc.createElement("p");
      safety.className = "knowledge-workbench__directory-picker-safety";
      safety.textContent = i18n.t("directoryPicker.safety");

      const localTitle = doc.createElement("h3");
      localTitle.textContent = i18n.t("directoryPicker.browser.recent.title");

      const queryLabel = doc.createElement("label");
      queryLabel.className = "knowledge-workbench__directory-picker-query";
      queryLabel.textContent = i18n.t("directoryPicker.query.label");
      const query = doc.createElement("input");
      query.type = "search";
      query.autocomplete = "off";
      query.dataset.directoryQuery = "true";
      query.placeholder = i18n.t("directoryPicker.query.placeholder");
      query.value = session.snapshot().query;
      queryLabel.append(query);

      const filters = doc.createElement("div");
      filters.className = "knowledge-workbench__directory-picker-filters";
      filters.setAttribute("role", "group");
      filters.setAttribute("aria-label", i18n.t("directoryPicker.aria.filters"));

      const results = doc.createElement("div");
      results.className = "knowledge-workbench__directory-picker-results";
      results.dataset.directoryResults = "true";
      results.setAttribute("role", "listbox");
      results.setAttribute("aria-label", i18n.t("directoryPicker.aria.results"));

      const selected = doc.createElement("section");
      selected.className = "knowledge-workbench__directory-picker-selected";
      selected.dataset.selectedPath = "true";
      selected.setAttribute("aria-label", i18n.t("directoryPicker.aria.selection"));

      const status = doc.createElement("p");
      status.className = "knowledge-workbench__directory-picker-status";
      status.dataset.directoryPickerStatus = "true";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.setAttribute("aria-atomic", "true");

      const locate = doc.createElement("button");
      locate.type = "button";
      locate.dataset.action = "locate-directory";
      locate.textContent = i18n.t("directoryPicker.lookup.action");

      const browseRoot = doc.createElement("button");
      browseRoot.type = "button";
      browseRoot.dataset.action = "browse-directory-root";
      browseRoot.textContent = i18n.t("directoryPicker.browser.browseRoot");

      const clearRecent = doc.createElement("button");
      clearRecent.type = "button";
      clearRecent.dataset.action = "clear-recent";
      clearRecent.textContent = i18n.t("directoryPicker.clearRecent");

      const confirmation = doc.createElement("section");
      confirmation.className = "knowledge-workbench__directory-picker-confirmation";
      confirmation.dataset.directoryLocatorConfirmation = "true";
      confirmation.hidden = true;
      const confirmationTitle = doc.createElement("h3");
      confirmationTitle.textContent = i18n.t("directoryPicker.lookup.confirmation.title");
      const confirmationQuery = doc.createElement("p");
      confirmationQuery.className = "knowledge-workbench__directory-picker-path";
      const root = doc.createElement("p");
      root.className = "knowledge-workbench__directory-picker-path";
      root.textContent = i18n.t("directoryPicker.lookup.confirmation.root", { root: "/" });
      const budget = doc.createElement("p");
      budget.textContent = i18n.t("directoryPicker.lookup.confirmation.budget", {
        directories: CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDirectoryCount,
        requests: CLOUD_DIRECTORY_LOCATOR_BUDGET.maxListRequestCount,
        seconds: CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDurationMs / 1000,
      });
      const confirmationActions = doc.createElement("div");
      confirmationActions.className = "knowledge-workbench__directory-picker-actions";
      const cancelLocate = doc.createElement("button");
      cancelLocate.type = "button";
      cancelLocate.dataset.action = "cancel-directory-location";
      cancelLocate.textContent = i18n.t("directoryPicker.lookup.confirmation.cancel");
      const confirmLocate = doc.createElement("button");
      confirmLocate.type = "button";
      confirmLocate.dataset.action = "confirm-directory-location";
      confirmLocate.textContent = i18n.t("directoryPicker.lookup.confirmation.confirm");
      confirmationActions.append(cancelLocate, confirmLocate);
      confirmation.append(
        confirmationTitle,
        confirmationQuery,
        root,
        budget,
        confirmationActions,
      );

      const tools = doc.createElement("div");
      tools.className = "knowledge-workbench__directory-picker-tools";
      tools.append(browseRoot, locate, clearRecent);

      const rootDisclosure = doc.createElement("section");
      rootDisclosure.className = "knowledge-workbench__directory-picker-confirmation";
      rootDisclosure.dataset.directoryRootDisclosure = "true";
      rootDisclosure.hidden = true;
      const rootDisclosureTitle = doc.createElement("h3");
      rootDisclosureTitle.textContent = i18n.t("directoryPicker.browser.rootDisclosure.title");
      const rootDisclosureBody = doc.createElement("p");
      rootDisclosureBody.textContent = i18n.t("directoryPicker.browser.rootDisclosure.body");
      const rootDisclosureActions = doc.createElement("div");
      rootDisclosureActions.className = "knowledge-workbench__directory-picker-actions";
      const rootDisclosureCancel = doc.createElement("button");
      rootDisclosureCancel.type = "button";
      rootDisclosureCancel.dataset.action = "cancel-directory-root-disclosure";
      rootDisclosureCancel.textContent = i18n.t("directoryPicker.browser.rootDisclosure.cancel");
      const rootDisclosureConfirm = doc.createElement("button");
      rootDisclosureConfirm.type = "button";
      rootDisclosureConfirm.dataset.action = "confirm-directory-root-disclosure";
      rootDisclosureConfirm.textContent = i18n.t("directoryPicker.browser.rootDisclosure.confirm");
      rootDisclosureActions.append(rootDisclosureCancel, rootDisclosureConfirm);
      rootDisclosure.append(rootDisclosureTitle, rootDisclosureBody, rootDisclosureActions);

      const browserHost = doc.createElement("div");
      browserHost.dataset.directoryBrowserHost = "true";

      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__directory-picker-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel-directory-picker";
      cancel.textContent = i18n.t("directoryPicker.cancel");
      const use = doc.createElement("button");
      use.type = "button";
      use.dataset.action = "use-directory";
      use.textContent = i18n.t("directoryPicker.use");
      actions.append(cancel, use);

      this.ui = {
        i18n,
        query,
        filters,
        results,
        selected,
        status,
        confirmation,
        confirmationQuery,
        locate,
        browseRoot,
        rootDisclosure,
        rootDisclosureCancel,
        rootDisclosureConfirm,
        browserHost,
        clearRecent,
        cancel,
        use,
        confirmLocate,
      };
      this.contentEl.append(
        safety,
        localTitle,
        queryLabel,
        filters,
        results,
        selected,
        status,
        tools,
        rootDisclosure,
        browserHost,
        confirmation,
        actions,
      );

      query.addEventListener("input", () => {
        if (!this.isCurrent(generation)) return;
        this.activeExactIndex = -1;
        this.session?.setQuery(query.value);
      }, { signal });
      locate.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        this.session?.requestLookupConsent();
      }, { signal });
      browseRoot.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        this.session?.revealRootBrowser();
      }, { signal });
      rootDisclosureCancel.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        this.session?.cancelRootBrowser();
      }, { signal });
      rootDisclosureConfirm.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        this.session?.confirmRootBrowser();
      }, { signal });
      cancelLocate.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        this.session?.cancelLookup();
      }, { signal });
      confirmLocate.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        void this.session?.confirmLookup();
      }, { signal });
      clearRecent.addEventListener("click", () => {
        void this.handleClearRecent(generation);
      }, { signal });
      cancel.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        this.cancelAndClose();
      }, { signal });
      use.addEventListener("click", () => {
        void this.handleUse(generation);
      }, { signal });
      this.contentEl.addEventListener("keydown", (event) => {
        this.handleKeyboard(event, generation);
      }, { signal });

      let previousPhase = session.snapshot().phase;
      this.unsubscribeSession = session.subscribe(() => {
        if (!this.isCurrent(generation)) return;
        const next = session.snapshot();
        this.render(next, generation);
        if (next.phase === "lookup-consent" && previousPhase !== "lookup-consent") {
          this.ui?.confirmLocate.focus({ preventScroll: true });
        } else if (next.phase === "root-consent" && previousPhase !== "root-consent") {
          this.ui?.rootDisclosureConfirm.focus({ preventScroll: true });
        }
        previousPhase = next.phase;
      });
      this.render(session.snapshot(), generation);
      query.focus();
    }

    onClose(): void {
      this.cleanup();
    }

    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      if (this.cleaned) return;
      if (this.contentEl.isConnected) this.close();
      else this.cleanup();
    }

    private render(state: CloudDirectoryPickerSessionState, generation: number): void {
      if (!this.isCurrent(generation)) return;
      const ui = this.ui;
      if (ui === null) return;
      const exacts = state.rankedCandidates.filter(
        (item): item is RankedExactCandidate => item.candidate.kind === "exact",
      );
      if (this.activeExactIndex >= exacts.length) this.activeExactIndex = exacts.length - 1;
      if (ui.query.value !== state.query) ui.query.value = state.query;

      ui.filters.replaceChildren();
      for (const source of ALL_SOURCES) {
        const button = ui.filters.ownerDocument.createElement("button");
        button.type = "button";
        button.dataset.directorySource = source;
        button.setAttribute("aria-pressed", String(state.enabledSources.includes(source)));
        button.textContent = ui.i18n.t(SOURCE_KEYS[source]);
        button.disabled = state.phase === "settling";
        button.addEventListener("click", () => {
          if (!this.isCurrent(generation)) return;
          this.activeExactIndex = -1;
          this.session?.toggleSource(source);
        }, { signal: this.lifecycleController?.signal });
        ui.filters.append(button);
      }

      ui.results.replaceChildren();
      let exactIndex = 0;
      for (const item of state.rankedCandidates) {
        const candidate = item.candidate;
        if (candidate.kind === "exact") {
          const option = ui.results.ownerDocument.createElement("button");
          option.type = "button";
          option.id = this.optionId(exactIndex);
          option.className = "knowledge-workbench__directory-picker-result";
          option.dataset.candidateKind = "exact";
          option.dataset.directoryPath = candidate.path;
          option.dataset.exactIndex = String(exactIndex);
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", String(candidate.path === state.selectedPath));
          option.tabIndex = exactIndex === this.activeExactIndex ? 0 : -1;
          option.disabled = state.phase === "settling";
          this.appendIdentity(option, candidate.filename, candidate.path, item.sources, ui.i18n);
          const pathState = option.ownerDocument.createElement("span");
          pathState.className = "knowledge-workbench__directory-picker-state";
          pathState.textContent = item.sources.some((source) => (
            source === "session-cache" || source === "cloud-locator"
          )) || candidate.pathState === "session-verified"
            ? ui.i18n.t("directoryPicker.result.state.sessionVerified")
            : ui.i18n.t("directoryPicker.result.state.previouslyUsed");
          option.append(pathState);
          const path = candidate.path;
          const index = exactIndex;
          option.addEventListener("click", () => {
            if (!this.isCurrent(generation)) return;
            this.activeExactIndex = index;
            this.session?.selectCandidate(path);
          }, { signal: this.lifecycleController?.signal });

          const enter = ui.results.ownerDocument.createElement("button");
          enter.type = "button";
          enter.dataset.action = "browse-candidate-directory";
          enter.dataset.directoryPath = path;
          enter.textContent = ui.i18n.t("directoryPicker.browser.enter");
          enter.disabled = !this.hasBrowser
            || state.browserActivity === "running"
            || state.phase === "settling";
          enter.addEventListener("click", () => {
            if (!this.isCurrent(generation)) return;
            const currentSession = this.session;
            const current = currentSession?.snapshot();
            if (current?.browserActivity === "running" || current?.phase === "settling") return;
            currentSession?.enterBrowserPath(path);
          }, { signal: this.lifecycleController?.signal });
          ui.results.append(option, enter);
          exactIndex += 1;
          continue;
        }

        const explanation = ui.results.ownerDocument.createElement("article");
        explanation.className = candidate.kind === "conflict"
          ? "knowledge-workbench__directory-picker-result knowledge-workbench__directory-picker-result--conflict"
          : "knowledge-workbench__directory-picker-result knowledge-workbench__directory-picker-result--hint";
        explanation.dataset.candidateKind = candidate.kind;
        explanation.setAttribute("role", "note");
        this.appendIdentity(
          explanation,
          candidate.filename,
          candidate.kind === "conflict"
            ? candidate.path
            : ui.i18n.t("directoryPicker.result.pathUnverified"),
          item.sources,
          ui.i18n,
        );
        const detail = explanation.ownerDocument.createElement("p");
        detail.className = "knowledge-workbench__directory-picker-explanation";
        detail.textContent = candidate.kind === "conflict"
          ? ui.i18n.t("directoryPicker.result.conflict")
          : ui.i18n.t("directoryPicker.result.hint");
        explanation.append(detail);
        ui.results.append(explanation);
      }
      if (state.rankedCandidates.length === 0) {
        const empty = ui.results.ownerDocument.createElement("p");
        empty.className = "knowledge-workbench__empty";
        empty.setAttribute("role", "presentation");
        empty.textContent = ui.i18n.t("directoryPicker.results.empty");
        ui.results.append(empty);
      }
      if (this.activeExactIndex >= 0) {
        ui.results.setAttribute("aria-activedescendant", this.optionId(this.activeExactIndex));
      } else ui.results.removeAttribute("aria-activedescendant");

      ui.selected.replaceChildren();
      const selectedTitle = ui.selected.ownerDocument.createElement("strong");
      selectedTitle.textContent = ui.i18n.t("directoryPicker.selected.title");
      const selectedValue = ui.selected.ownerDocument.createElement("p");
      selectedValue.className = "knowledge-workbench__directory-picker-path";
      selectedValue.textContent = state.selectedPath === null
        ? ui.i18n.t("directoryPicker.selected.none")
        : ui.i18n.t("directoryPicker.selected.path", { path: state.selectedPath });
      ui.selected.append(selectedTitle, selectedValue);

      ui.confirmation.hidden = state.phase !== "lookup-consent" && state.phase !== "locating";
      ui.confirmationQuery.textContent = state.phase === "lookup-consent" || state.phase === "locating"
        ? ui.i18n.t("directoryPicker.lookup.confirmation.query", { query: state.query })
        : "";
      ui.rootDisclosure.hidden = state.phase !== "root-consent";
      ui.locate.disabled = !this.hasLocator
        || state.query.trim().length === 0
        || state.phase === "locating"
        || state.phase === "settling";
      ui.browseRoot.disabled = !this.hasBrowser
        || state.browserActivity === "running"
        || state.phase === "locating"
        || state.phase === "settling";
      ui.rootDisclosureCancel.disabled = state.phase !== "root-consent";
      ui.rootDisclosureConfirm.disabled = !this.hasBrowser || state.phase !== "root-consent";
      ui.clearRecent.disabled = state.phase === "locating" || state.phase === "settling";
      ui.cancel.disabled = state.phase === "settling";
      ui.use.disabled = state.draftSelection === null
        || (state.phase !== "local" && state.phase !== "browsing");
      ui.confirmLocate.disabled = state.phase !== "lookup-consent";
      ui.status.textContent = this.renderStatus(state, ui.i18n);

      this.renderBrowser(state, generation);
    }

    private renderBrowser(state: CloudDirectoryPickerSessionState, generation: number): void {
      const ui = this.ui;
      if (!this.isCurrent(generation) || ui === null) return;
      if (state.browserPath === null) {
        this.browserSurface?.dispose();
        this.browserSurface = null;
        ui.browserHost.replaceChildren();
        return;
      }
      const viewState = {
        currentPath: state.browserPath,
        ancestors: browserAncestors(state.browserPath, ui.i18n),
        purpose: state.purpose,
        layer: state.browserLayer,
        visibleDirectories: state.visibleBrowserDirectories,
        highlightedPath: state.browserHighlightedPath,
        activity: state.browserActivity,
        round: state.browserDetail.round,
        fixedError: state.browserDetail.fixedError,
      } as const;
      const actions = {
        onEnter: (path: string) => this.session?.enterBrowserPath(path),
        onHighlight: (path: string) => this.session?.highlightBrowserPath(path),
        onSelectCurrent: () => { void this.session?.selectCurrentDirectory(); },
        onSelectHighlighted: () => { void this.session?.selectHighlightedDirectory(); },
        onSelectCategory: (path: string) => { void this.session?.selectCategory(path); },
        onBreadcrumb: (path: string) => this.session?.navigateBreadcrumb(path),
        onContinue: () => { void this.session?.continueBrowser(); },
        onRetry: () => { void this.session?.retryBrowser(); },
        onCancel: () => this.session?.cancelBrowser(),
      };
      if (this.browserSurface === null) {
        this.browserSurface = createCloudDirectoryBrowserView(
          ui.browserHost,
          ui.i18n,
          viewState,
          actions,
        );
      } else this.browserSurface.update(viewState);
    }

    private renderStatus(
      state: CloudDirectoryPickerSessionState,
      i18n: DirectoryPickerI18n,
    ): string {
      const lookup = lookupStatus(i18n, state);
      if (lookup.length > 0) return lookup;
      if (state.browserPath === null && state.statusCode === "browser-error") {
        return i18n.t(
          state.browserDetail.fixedError === "browser-unavailable"
            ? "directoryPicker.browser.unavailable"
            : "directoryPicker.browser.error.fixed",
        );
      }
      if (state.browserPath === null && !this.hasLocator) {
        return i18n.t("directoryPicker.lookup.unavailable");
      }
      return "";
    }

    private appendIdentity(
      target: HTMLElement,
      filename: string,
      path: string,
      sources: readonly CloudDirectoryCandidateSource[],
      i18n: DirectoryPickerI18n,
    ): void {
      const name = target.ownerDocument.createElement("strong");
      name.className = "knowledge-workbench__directory-picker-name";
      name.textContent = filename;
      const fullPath = target.ownerDocument.createElement("span");
      fullPath.className = "knowledge-workbench__directory-picker-path";
      fullPath.textContent = path;
      const chips = target.ownerDocument.createElement("span");
      chips.className = "knowledge-workbench__directory-picker-sources";
      for (const source of sources) {
        const chip = target.ownerDocument.createElement("span");
        chip.className = "knowledge-workbench__directory-picker-source";
        chip.textContent = i18n.t(SOURCE_KEYS[source]);
        chips.append(chip);
      }
      target.append(name, fullPath, chips);
    }

    private handleKeyboard(event: KeyboardEvent, generation: number): void {
      if (!this.isCurrent(generation) || event.isComposing) return;
      const session = this.session;
      const ui = this.ui;
      if (session === null || ui === null) return;
      const state = session.snapshot();
      if (event.key === "Escape") {
        if (state.phase === "settling") return;
        event.preventDefault();
        if (state.phase === "locating") {
          session.cancelLookup();
          return;
        }
        if (state.phase === "browsing" && state.browserActivity === "running") {
          session.cancelBrowser();
          return;
        }
        this.cancelAndClose();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || state.phase === "settling") return;
      const target = event.target as Element | null;
      const browserList = target?.closest('[data-directory-browser-list="true"]') ?? null;
      const browserButton = target?.closest("button") ?? null;
      const browserNavigationTarget = target === ui.query
        || (browserList !== null && browserButton === null);
      if (state.browserPath !== null && browserNavigationTarget) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const directories = state.visibleBrowserDirectories;
          if (directories.length === 0) return;
          const current = state.browserHighlightedPath === null
            ? -1
            : directories.findIndex((directory) => directory.path === state.browserHighlightedPath);
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const origin = current < 0 ? (delta > 0 ? -1 : 0) : current;
          session.highlightBrowserPath(
            directories[(origin + delta + directories.length) % directories.length]!.path,
          );
          return;
        }
        if (event.key === "Enter" && state.browserHighlightedPath !== null) {
          event.preventDefault();
          session.enterBrowserPath(state.browserHighlightedPath);
          return;
        }
        if (
          event.key === "Backspace"
          && target === ui.query
          && ui.query.value.length === 0
          && state.browserPath !== "/"
        ) {
          event.preventDefault();
          session.navigateBreadcrumb(parentPath(state.browserPath));
        }
        return;
      }

      if (target !== ui.query && target !== ui.results) return;
      const exacts = state.rankedCandidates.filter(
        (item): item is RankedExactCandidate => item.candidate.kind === "exact",
      );
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (exacts.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const origin = this.activeExactIndex < 0
          ? (delta > 0 ? -1 : 0)
          : this.activeExactIndex;
        this.activeExactIndex = (origin + delta + exacts.length) % exacts.length;
        this.render(state, generation);
        this.ui?.results.querySelector<HTMLElement>(
          `[data-exact-index="${this.activeExactIndex}"]`,
        )?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Enter" && this.activeExactIndex >= 0) {
        event.preventDefault();
        const candidate = exacts[this.activeExactIndex];
        if (candidate !== undefined) session.selectCandidate(candidate.candidate.path);
      }
    }

    private async handleClearRecent(generation: number): Promise<void> {
      if (!this.isCurrent(generation)) return;
      const session = this.session;
      const ui = this.ui;
      if (session === null || ui === null) return;
      await session.clearRecent();
      if (!this.isCurrent(generation) || this.session !== session) return;
      this.showNotice(ui.i18n.t(
        session.snapshot().statusCode === "save-failed"
          ? "directoryPicker.notice.recentClearFailed"
          : "directoryPicker.notice.recentCleared",
      ));
    }

    private async handleUse(generation: number): Promise<void> {
      if (!this.isCurrent(generation)) return;
      const session = this.session;
      const i18n = this.ui?.i18n;
      if (session === null || i18n === undefined) return;
      const value = await session.useSelection();
      if (!this.isCurrent(generation) || this.session !== session) return;
      if (value === null) {
        if (session.snapshot().statusCode === "save-failed") {
          this.showNotice(i18n.t("directoryPicker.notice.persistenceFailure"));
        }
        return;
      }
      this.resolve(value);
      this.close();
    }

    private cancelAndClose(): void {
      if (this.cleaned) return;
      this.session?.cancel();
      this.resolve(null);
      this.close();
    }

    private optionId(index: number): string {
      return `${this.optionIdPrefix}-${this.hostGeneration}-${index}`;
    }

    private showNotice(message: string): void {
      try {
        this.notify(message);
      } catch {
        // Notice delivery is best effort and never changes session state.
      }
    }

    private resolve(value: CloudDirectorySelection | null): void {
      if (this.settled) return;
      this.settled = true;
      this.settleResult?.(value);
      this.settleResult = null;
    }

    private isCurrent(generation: number): boolean {
      return !this.cleaned
        && generation === this.hostGeneration
        && this.lifecycleController?.signal.aborted === false;
    }

    private cleanup(): void {
      if (this.cleaned) return;
      this.cleaned = true;
      this.hostGeneration += 1;
      this.unsubscribeSession?.();
      this.unsubscribeSession = null;
      this.lifecycleController?.abort();
      this.lifecycleController = null;
      this.browserSurface?.dispose();
      this.browserSurface = null;
      this.session?.cancel();
      this.session?.dispose();
      this.session = null;
      for (const input of Array.from(
        this.contentEl.querySelectorAll<HTMLInputElement>("input"),
      )) input.value = "";
      this.contentEl.replaceChildren();
      this.ui = null;
      if (!this.settled) this.resolve(null);
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }
  };
}
