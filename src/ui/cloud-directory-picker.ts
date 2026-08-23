import type { App, Modal } from "obsidian";
import {
  rankCloudDirectoryCandidates,
  type CloudDirectoryCandidate,
  type CloudDirectoryCandidateRuntime,
  type CloudDirectoryCandidateSource,
  type RankedCloudDirectoryCandidate,
} from "../catalog/cloud-directory-candidates";
import {
  CLOUD_DIRECTORY_LOCATOR_BUDGET,
  type CloudDirectoryLocatorRuntime,
  type CloudDirectoryLocatorSummary,
  type CloudDirectoryLocatorStopReason,
} from "../catalog/cloud-directory-locator";
import { normalizeCatalogScanRoot } from "../catalog/catalog-path";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";

export interface CloudDirectoryPickerRequest {
  readonly initialPath: string | null;
  readonly candidates: CloudDirectoryCandidateRuntime;
  readonly locator?: CloudDirectoryLocatorRuntime;
}

export interface CloudDirectoryPickerPresenter {
  request(input: CloudDirectoryPickerRequest): Promise<string | null>;
}

export type CloudDirectoryPickerModalConstructor = abstract new (app: App) => Modal;
export type CloudDirectoryPickerNotice = (message: string) => void;

let pickerInstanceSequence = 0;

type PickerPhase = "closed" | "local" | "confirm" | "running" | "settling";

interface PickerUi {
  readonly i18n: WorkbenchI18n;
  readonly query: HTMLInputElement;
  readonly filters: HTMLElement;
  readonly results: HTMLElement;
  readonly selected: HTMLElement;
  readonly status: HTMLElement;
  readonly confirmation: HTMLElement;
  readonly confirmationQuery: HTMLElement;
  readonly locate: HTMLButtonElement;
  readonly clearRecent: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly use: HTMLButtonElement;
  readonly confirmLocate: HTMLButtonElement;
}

type ExactCandidate = Extract<CloudDirectoryCandidate, { readonly kind: "exact" }>;
type RankedExactCandidate = RankedCloudDirectoryCandidate & Readonly<{
  candidate: ExactCandidate;
}>;

const SOURCE_KEYS = {
  recent: "directoryPicker.filters.recent",
  "session-cache": "directoryPicker.filters.sessionCache",
  "txt-group": "directoryPicker.filters.txtGroup",
  "cloud-locator": "directoryPicker.filters.cloudLocator",
} as const satisfies Record<CloudDirectoryCandidateSource, WorkbenchMessageKey>;

const LOOKUP_REASON_KEYS = {
  "directory-limit": "directoryPicker.lookup.reason.directoryLimit",
  "list-request-limit": "directoryPicker.lookup.reason.listRequestLimit",
  "time-limit": "directoryPicker.lookup.reason.timeLimit",
} as const satisfies Partial<Record<CloudDirectoryLocatorStopReason, WorkbenchMessageKey>>;

const ALL_SOURCES: readonly CloudDirectoryCandidateSource[] = [
  "recent",
  "session-cache",
  "txt-group",
  "cloud-locator",
];

const leafName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const safeCandidate = (input: CloudDirectoryCandidate): CloudDirectoryCandidate | null => {
  try {
    if (input.kind === "name-hint") {
      const filename = input.filename.normalize("NFC");
      if (filename.length === 0 || /\p{Cc}/u.test(filename) || input.catalogGroupKey.length === 0) {
        return null;
      }
      return {
        kind: "name-hint",
        filename,
        source: "txt-group",
        catalogGroupKey: input.catalogGroupKey,
      };
    }
    const path = normalizeCatalogScanRoot(input.path);
    const filename = input.filename.normalize("NFC");
    if (filename !== leafName(path)) return null;
    if (input.kind === "conflict") {
      return {
        kind: "conflict",
        filename,
        path,
        source: "cloud-locator",
        reason: "same-path-different-identity",
      };
    }
    if (
      (input.source !== "recent"
        && input.source !== "session-cache"
        && input.source !== "cloud-locator")
      || (input.pathState !== "previously-used" && input.pathState !== "session-verified")
    ) return null;
    return {
      kind: "exact",
      path,
      filename,
      source: input.source,
      pathState: input.pathState,
      ...(typeof input.cloudFsId === "string" ? { cloudFsId: input.cloudFsId } : {}),
    };
  } catch {
    return null;
  }
};

const detachedCandidates = (
  values: readonly CloudDirectoryCandidate[],
): readonly CloudDirectoryCandidate[] => {
  const output: CloudDirectoryCandidate[] = [];
  try {
    for (const value of values) {
      const candidate = safeCandidate(value);
      if (candidate !== null) output.push(candidate);
    }
  } catch {
    return [];
  }
  return output;
};

const detachedLocatorCandidates = (
  values: readonly CloudDirectoryCandidate[],
): readonly CloudDirectoryCandidate[] => detachedCandidates(values).filter((candidate) => (
  candidate.kind === "conflict"
  || (candidate.kind === "exact"
    && candidate.source === "cloud-locator"
    && candidate.pathState === "session-verified")
));

const fixedStatus = (
  i18n: WorkbenchI18n,
  summary: CloudDirectoryLocatorSummary,
): string => {
  if (summary.status === "complete") {
    return i18n.t("directoryPicker.lookup.complete", {
      matches: summary.matchCount,
      directories: summary.directoryCount,
      requests: summary.listRequestCount,
    });
  }
  if (summary.status === "canceled") return i18n.t("directoryPicker.lookup.canceled");
  const reasonKey = summary.stopReason === "directory-limit"
    || summary.stopReason === "list-request-limit"
    || summary.stopReason === "time-limit"
    ? LOOKUP_REASON_KEYS[summary.stopReason]
    : undefined;
  if (reasonKey === undefined) return i18n.t("directoryPicker.lookup.error");
  return i18n.t("directoryPicker.lookup.partial", {
    reason: i18n.t(reasonKey),
    matches: summary.matchCount,
    directories: summary.directoryCount,
    requests: summary.listRequestCount,
  });
};

export function createCloudDirectoryPickerModalClass(
  ModalBase: CloudDirectoryPickerModalConstructor,
) {
  return class CloudDirectoryPickerModal extends ModalBase
    implements CloudDirectoryPickerPresenter {
    private phase: PickerPhase = "closed";
    private query = "";
    private readonly enabledSources = new Set<CloudDirectoryCandidateSource>(ALL_SOURCES);
    private locatedCandidates: readonly CloudDirectoryCandidate[] = [];
    private initialCandidate: CloudDirectoryCandidate | null = null;
    private selectedPath: string | null = null;
    private activeExactIndex = -1;
    private renderGeneration = 0;
    private lookupGeneration = 0;
    private frozenLookupQuery: string | null = null;
    private lifecycleController: AbortController | null = null;
    private lookupController: AbortController | null = null;
    private runtime: CloudDirectoryCandidateRuntime | null = null;
    private locator: CloudDirectoryLocatorRuntime | undefined;
    private ui: PickerUi | null = null;
    private result: Promise<string | null> | null = null;
    private settleResult: ((value: string | null) => void) | null = null;
    private settled = false;
    private disposed = false;
    private disposeAfterSettling = false;
    private hostClosedWhileSettling = false;
    private opener: HTMLElement | null = null;
    private readonly optionIdPrefix = `knowledge-workbench-directory-${++pickerInstanceSequence}`;

    constructor(
      app: App,
      private readonly getI18n: () => WorkbenchI18n,
      private readonly notify: CloudDirectoryPickerNotice = () => undefined,
    ) {
      super(app);
    }

    request(input: CloudDirectoryPickerRequest): Promise<string | null> {
      if (this.disposed) throw new Error("directory-picker-unavailable");
      if (this.result !== null) return this.result;
      const initialPath = input.initialPath === null
        ? null
        : normalizeCatalogScanRoot(input.initialPath);
      this.runtime = input.candidates;
      this.locator = input.locator;
      this.initialCandidate = initialPath === null ? null : {
        kind: "exact",
        path: initialPath,
        filename: leafName(initialPath),
        source: "recent",
        pathState: "previously-used",
      };
      this.selectedPath = initialPath;
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.lifecycleController = new AbortController();
      this.renderGeneration += 1;
      this.phase = "local";
      this.result = new Promise((resolve) => { this.settleResult = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      const runtime = this.runtime;
      const lifecycle = this.lifecycleController;
      if (runtime === null || lifecycle === null || this.phase !== "local") {
        throw new Error("directory-picker-unavailable");
      }
      const generation = this.renderGeneration;
      const { signal } = lifecycle;
      const i18n = this.getI18n();
      const doc = this.contentEl.ownerDocument;
      this.setTitle(i18n.t("directoryPicker.title"));
      this.contentEl.replaceChildren();
      this.contentEl.classList.add("knowledge-workbench__directory-picker");
      this.contentEl.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (this.phase === "settling") return;
        this.finish(null);
      }, { signal });

      const safety = doc.createElement("p");
      safety.className = "knowledge-workbench__directory-picker-safety";
      safety.textContent = i18n.t("directoryPicker.safety");

      const queryLabel = doc.createElement("label");
      queryLabel.className = "knowledge-workbench__directory-picker-query";
      queryLabel.textContent = i18n.t("directoryPicker.query.label");
      const query = doc.createElement("input");
      query.type = "search";
      query.autocomplete = "off";
      query.dataset.directoryQuery = "true";
      query.placeholder = i18n.t("directoryPicker.query.placeholder");
      query.value = this.query;
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
      tools.append(locate, clearRecent);

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
        clearRecent,
        cancel,
        use,
        confirmLocate,
      };
      this.contentEl.append(
        safety,
        queryLabel,
        filters,
        results,
        selected,
        status,
        tools,
        confirmation,
        actions,
      );

      query.addEventListener("input", () => {
        if (!this.isCurrent(generation)) return;
        this.query = query.value;
        if (this.phase === "confirm" || this.phase === "running") {
          this.invalidateLookup(this.phase === "running");
        }
        this.activeExactIndex = -1;
        this.renderLocal(generation);
      }, { signal });
      const keyboard = (event: KeyboardEvent): void => {
        if (!this.isCurrent(generation) || this.phase === "settling") return;
        const exacts = this.currentExactCandidates();
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (exacts.length === 0) return;
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const origin = this.activeExactIndex < 0
            ? (delta > 0 ? -1 : 0)
            : this.activeExactIndex;
          this.activeExactIndex = (origin + delta + exacts.length) % exacts.length;
          this.renderLocal(generation);
          this.ui?.results.querySelector<HTMLElement>(
            `[data-exact-index="${this.activeExactIndex}"]`,
          )?.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Enter" && this.activeExactIndex >= 0) {
          event.preventDefault();
          const candidate = exacts[this.activeExactIndex];
          if (candidate !== undefined) this.selectExact(candidate.candidate.path, generation);
        }
      };
      query.addEventListener("keydown", keyboard, { signal });
      results.addEventListener("keydown", keyboard, { signal });
      locate.addEventListener("click", () => this.revealLookup(generation), { signal });
      cancelLocate.addEventListener("click", () => {
        if (!this.isCurrent(generation)) return;
        this.invalidateLookup(this.phase === "running");
        this.renderLocal(generation);
      }, { signal });
      confirmLocate.addEventListener("click", () => {
        void this.confirmLookup(generation);
      }, { signal });
      clearRecent.addEventListener("click", () => {
        void this.clearRecent(generation);
      }, { signal });
      cancel.addEventListener("click", () => {
        if (this.phase !== "settling") this.finish(null);
      }, { signal });
      use.addEventListener("click", () => {
        void this.useSelected(generation);
      }, { signal });

      this.renderLocal(generation);
      query.focus();
    }

    onClose(): void {
      if (this.phase === "settling") {
        this.hostClosedWhileSettling = true;
        this.hideSettlingSurface();
        return;
      }
      this.cleanup();
    }

    dispose(): void {
      if (this.disposed) return;
      if (this.phase === "settling") {
        this.disposeAfterSettling = true;
        if (!this.hostClosedWhileSettling) this.close();
        return;
      }
      this.disposed = true;
      if (this.phase !== "closed") this.finish(null);
      else this.cleanup();
    }

    private currentRanked(): readonly RankedCloudDirectoryCandidate[] {
      const runtime = this.runtime;
      if (runtime === null) return [];
      let local: readonly CloudDirectoryCandidate[] = [];
      try {
        local = detachedCandidates(runtime.snapshot());
      } catch {
        local = [];
      }
      const candidates = [
        ...(this.initialCandidate === null ? [] : [this.initialCandidate]),
        ...local,
        ...detachedCandidates(this.locatedCandidates),
      ];
      try {
        return rankCloudDirectoryCandidates({
          candidates,
          query: this.query,
          enabledSources: this.enabledSources,
          selectedPath: this.selectedPath,
        });
      } catch {
        return [];
      }
    }

    private currentExactCandidates(): readonly RankedExactCandidate[] {
      return this.currentRanked().filter((ranked): ranked is RankedExactCandidate => (
        ranked.candidate.kind === "exact"
      ));
    }

    private renderLocal(generation: number): void {
      if (!this.isCurrent(generation)) return;
      const ui = this.ui;
      if (ui === null) return;
      const ranked = this.currentRanked();
      const exacts = ranked.filter((item) => item.candidate.kind === "exact");
      if (
        this.selectedPath !== null
        && !exacts.some((item) => item.candidate.kind === "exact"
          && item.candidate.path === this.selectedPath)
      ) this.selectedPath = null;
      if (this.activeExactIndex >= exacts.length) this.activeExactIndex = exacts.length - 1;

      ui.filters.replaceChildren();
      for (const source of ALL_SOURCES) {
        const button = ui.filters.ownerDocument.createElement("button");
        button.type = "button";
        button.dataset.directorySource = source;
        button.setAttribute("aria-pressed", String(this.enabledSources.has(source)));
        button.textContent = ui.i18n.t(SOURCE_KEYS[source]);
        button.disabled = this.phase === "settling";
        button.addEventListener("click", () => {
          if (!this.isCurrent(generation) || this.phase === "settling") return;
          if (this.enabledSources.has(source)) this.enabledSources.delete(source);
          else this.enabledSources.add(source);
          this.activeExactIndex = -1;
          this.renderLocal(generation);
        }, { signal: this.lifecycleController?.signal });
        ui.filters.append(button);
      }

      ui.results.replaceChildren();
      let exactIndex = 0;
      for (const item of ranked) {
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
          option.setAttribute("aria-selected", String(candidate.path === this.selectedPath));
          option.tabIndex = exactIndex === this.activeExactIndex ? 0 : -1;
          option.disabled = this.phase === "settling";
          this.appendIdentity(option, candidate.filename, candidate.path, item.sources, ui.i18n);
          const state = option.ownerDocument.createElement("span");
          state.className = "knowledge-workbench__directory-picker-state";
          state.textContent = item.sources.some((source) => (
            source === "session-cache" || source === "cloud-locator"
          )) || candidate.pathState === "session-verified"
            ? ui.i18n.t("directoryPicker.result.state.sessionVerified")
            : ui.i18n.t("directoryPicker.result.state.previouslyUsed");
          option.append(state);
          const path = candidate.path;
          option.addEventListener("click", () => this.selectExact(path, generation), {
            signal: this.lifecycleController?.signal,
          });
          ui.results.append(option);
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
      if (ranked.length === 0) {
        const empty = ui.results.ownerDocument.createElement("p");
        empty.className = "knowledge-workbench__empty";
        empty.setAttribute("role", "presentation");
        empty.textContent = ui.i18n.t("directoryPicker.results.empty");
        ui.results.append(empty);
      }
      if (this.activeExactIndex >= 0) {
        ui.results.setAttribute(
          "aria-activedescendant",
          this.optionId(this.activeExactIndex),
        );
      } else ui.results.removeAttribute("aria-activedescendant");

      ui.selected.replaceChildren();
      const selectedTitle = ui.selected.ownerDocument.createElement("strong");
      selectedTitle.textContent = ui.i18n.t("directoryPicker.selected.title");
      const selectedValue = ui.selected.ownerDocument.createElement("p");
      selectedValue.className = "knowledge-workbench__directory-picker-path";
      selectedValue.textContent = this.selectedPath === null
        ? ui.i18n.t("directoryPicker.selected.none")
        : ui.i18n.t("directoryPicker.selected.path", { path: this.selectedPath });
      ui.selected.append(selectedTitle, selectedValue);

      ui.confirmation.hidden = this.phase !== "confirm" && this.phase !== "running";
      ui.confirmationQuery.textContent = this.frozenLookupQuery === null
        ? ""
        : ui.i18n.t("directoryPicker.lookup.confirmation.query", {
          query: this.frozenLookupQuery,
        });
      ui.locate.disabled = this.locator === undefined
        || this.query.trim().length === 0
        || this.phase === "running"
        || this.phase === "settling";
      ui.clearRecent.disabled = this.phase === "running" || this.phase === "settling";
      ui.cancel.disabled = this.phase === "settling";
      ui.use.disabled = this.selectedPath === null || this.phase !== "local";
      ui.confirmLocate.disabled = this.phase !== "confirm";
      if (this.locator === undefined && (ui.status.textContent ?? "").length === 0) {
        ui.status.textContent = ui.i18n.t("directoryPicker.lookup.unavailable");
      }
    }

    private appendIdentity(
      target: HTMLElement,
      filename: string,
      path: string,
      sources: readonly CloudDirectoryCandidateSource[],
      i18n: WorkbenchI18n,
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

    private selectExact(path: string, generation: number): void {
      if (!this.isCurrent(generation) || this.phase !== "local") return;
      const exacts = this.currentExactCandidates();
      const index = exacts.findIndex((item) => item.candidate.path === path);
      if (index < 0) return;
      this.selectedPath = exacts[index]!.candidate.path;
      this.activeExactIndex = index;
      this.renderLocal(generation);
    }

    private revealLookup(generation: number): void {
      if (!this.isCurrent(generation) || this.phase !== "local" || this.locator === undefined) {
        return;
      }
      const query = this.query.normalize("NFC").trim();
      if (query.length === 0) return;
      this.frozenLookupQuery = query;
      this.phase = "confirm";
      const ui = this.ui;
      if (ui !== null) ui.status.textContent = "";
      this.renderLocal(generation);
      ui?.confirmLocate.focus({ preventScroll: true });
    }

    private async confirmLookup(generation: number): Promise<void> {
      if (!this.isCurrent(generation) || this.phase !== "confirm") return;
      const locator = this.locator;
      const query = this.frozenLookupQuery;
      const ui = this.ui;
      if (locator === undefined || query === null || ui === null) return;
      this.lookupController?.abort();
      const controller = new AbortController();
      this.lookupController = controller;
      const lookupGeneration = ++this.lookupGeneration;
      this.phase = "running";
      ui.status.textContent = ui.i18n.t("directoryPicker.lookup.running");
      this.renderLocal(generation);
      try {
        const value = await locator.locateByName(query, controller.signal);
        if (!this.isLookupCurrent(generation, lookupGeneration, controller.signal)) return;
        if (value.query.normalize("NFC").trim() !== query) {
          ui.status.textContent = ui.i18n.t("directoryPicker.lookup.error");
          this.phase = "local";
          return;
        }
        this.locatedCandidates = [
          ...this.locatedCandidates,
          ...detachedLocatorCandidates(value.candidates),
        ];
        ui.status.textContent = fixedStatus(ui.i18n, value);
        this.phase = "local";
        this.frozenLookupQuery = null;
        this.renderLocal(generation);
      } catch {
        if (!this.isLookupCurrent(generation, lookupGeneration, controller.signal)) return;
        ui.status.textContent = ui.i18n.t("directoryPicker.lookup.error");
        this.phase = "local";
        this.frozenLookupQuery = null;
        this.renderLocal(generation);
      } finally {
        if (this.ownsLookup(generation, lookupGeneration, controller)) {
          this.lookupController = null;
        }
      }
    }

    private invalidateLookup(showCanceled: boolean): void {
      this.lookupController?.abort();
      this.lookupController = null;
      this.lookupGeneration += 1;
      this.phase = "local";
      this.frozenLookupQuery = null;
      if (showCanceled && this.ui !== null) {
        this.ui.status.textContent = this.ui.i18n.t("directoryPicker.lookup.canceled");
      }
    }

    private async clearRecent(generation: number): Promise<void> {
      if (!this.isCurrent(generation) || this.phase !== "local") return;
      const runtime = this.runtime;
      const ui = this.ui;
      if (runtime === null || ui === null) return;
      ui.clearRecent.disabled = true;
      try {
        await runtime.clearRecent();
        if (!this.isCurrent(generation) || this.phase !== "local") return;
        this.showNotice(ui.i18n.t("directoryPicker.notice.recentCleared"));
        this.renderLocal(generation);
      } catch {
        if (!this.isCurrent(generation) || this.phase !== "local") return;
        this.showNotice(ui.i18n.t("directoryPicker.notice.recentClearFailed"));
      } finally {
        if (this.isCurrent(generation) && this.phase === "local" && this.ui !== null) {
          this.ui.clearRecent.disabled = false;
        }
      }
    }

    private async useSelected(generation: number): Promise<void> {
      if (!this.isCurrent(generation) || this.phase !== "local") return;
      const selectedPath = this.selectedPath;
      const runtime = this.runtime;
      const ui = this.ui;
      if (selectedPath === null || runtime === null || ui === null) return;
      const currentExact = this.currentExactCandidates()
        .find((item) => item.candidate.path === selectedPath);
      if (currentExact === undefined) {
        this.selectedPath = null;
        this.renderLocal(generation);
        return;
      }
      const path = normalizeCatalogScanRoot(currentExact.candidate.path);
      this.phase = "settling";
      this.renderLocal(generation);
      let saveFailed = false;
      try {
        await runtime.remember(path);
      } catch {
        saveFailed = true;
      }
      if (!this.isCurrent(generation) || this.phase !== "settling") return;
      if (saveFailed) this.showNotice(ui.i18n.t("directoryPicker.notice.persistenceFailure"));
      const disposeAfterSettling = this.disposeAfterSettling;
      const hostClosedWhileSettling = this.hostClosedWhileSettling;
      this.disposeAfterSettling = false;
      this.hostClosedWhileSettling = false;
      this.phase = "local";
      this.resolve(path);
      if (hostClosedWhileSettling) this.cleanup();
      else this.close();
      if (disposeAfterSettling) this.disposed = true;
    }

    private isCurrent(generation: number): boolean {
      return !this.disposed
        && this.phase !== "closed"
        && generation === this.renderGeneration
        && this.lifecycleController?.signal.aborted === false;
    }

    private isLookupCurrent(
      generation: number,
      lookupGeneration: number,
      signal: AbortSignal,
    ): boolean {
      return this.isCurrent(generation)
        && this.phase === "running"
        && lookupGeneration === this.lookupGeneration
        && !signal.aborted;
    }

    private ownsLookup(
      generation: number,
      lookupGeneration: number,
      controller: AbortController,
    ): boolean {
      return !this.disposed
        && generation === this.renderGeneration
        && lookupGeneration === this.lookupGeneration
        && this.lookupController === controller;
    }

    private showNotice(message: string): void {
      try {
        this.notify(message);
      } catch {
        // Notice delivery is best effort and never changes the committed selection.
      }
    }

    private optionId(index: number): string {
      return `${this.optionIdPrefix}-${this.renderGeneration}-${index}`;
    }

    private finish(value: string | null): void {
      this.resolve(value);
      this.close();
    }

    private resolve(value: string | null): void {
      if (this.settled) return;
      this.settled = true;
      this.settleResult?.(value);
      this.settleResult = null;
    }

    private hideSettlingSurface(): void {
      for (const input of Array.from(
        this.contentEl.querySelectorAll<HTMLInputElement>("input"),
      )) input.value = "";
      this.contentEl.replaceChildren();
      this.ui = null;
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }

    private cleanup(): void {
      if (this.phase === "closed" && this.lifecycleController === null) return;
      this.renderGeneration += 1;
      this.lookupGeneration += 1;
      this.lookupController?.abort();
      this.lookupController = null;
      this.lifecycleController?.abort();
      this.lifecycleController = null;
      for (const input of Array.from(
        this.contentEl.querySelectorAll<HTMLInputElement>("input"),
      )) input.value = "";
      if (!this.settled) this.resolve(null);
      this.phase = "closed";
      this.query = "";
      this.enabledSources.clear();
      for (const source of ALL_SOURCES) this.enabledSources.add(source);
      this.locatedCandidates = [];
      this.initialCandidate = null;
      this.selectedPath = null;
      this.activeExactIndex = -1;
      this.frozenLookupQuery = null;
      this.disposeAfterSettling = false;
      this.hostClosedWhileSettling = false;
      this.runtime = null;
      this.locator = undefined;
      this.ui = null;
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }
  };
}
