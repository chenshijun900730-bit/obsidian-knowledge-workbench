import type { App, Modal } from "obsidian";
import {
  CLOUD_DIRECTORY_DISCOVERY_BUDGET,
  type CloudDirectoryDiscoveryRuntime,
  type CloudDirectoryDiscoverySummary,
} from "../catalog/cloud-directory-discovery-service";
import type { RankedCloudDirectory } from "../catalog/cloud-directory-search";
import {
  rankCloudDirectoryCandidates,
  type CloudDirectoryCandidateRuntime,
} from "../catalog/cloud-directory-candidates";
import type { CloudDirectoryLocatorRuntime } from "../catalog/cloud-directory-locator";
import { normalizeCatalogScanRoot, normalizeCloudAbsolutePath } from "../catalog/catalog-path";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";

export interface CloudDirectoryPickerRequest {
  readonly initialPath: string | null;
  readonly candidates: CloudDirectoryCandidateRuntime;
  readonly locator?: CloudDirectoryLocatorRuntime;
}

interface LegacyCloudDirectoryPickerRequest {
  readonly initialRoot: string;
}

export interface CloudDirectoryPickerPresenter {
  request(input: CloudDirectoryPickerRequest): Promise<string | null>;
}

export type CloudDirectoryPickerModalConstructor = abstract new (app: App) => Modal;

const isPdfFilename = (value: string): boolean => value.toLocaleLowerCase("en-US").endsWith(".pdf");

const safeDirectory = (
  candidate: RankedCloudDirectory,
  rootPath: string,
): Readonly<{ path: string; filename: string }> | null => {
  if (
    typeof candidate.path !== "string"
    || typeof candidate.filename !== "string"
    || typeof candidate.score !== "number"
    || !Number.isFinite(candidate.score)
  ) return null;
  try {
    const path = normalizeCloudAbsolutePath(candidate.path);
    const filename = candidate.filename.normalize("NFC");
    if (
      (rootPath !== "/" && path !== rootPath && !path.startsWith(`${rootPath}/`))
      || path.slice(path.lastIndexOf("/") + 1) !== filename
      || isPdfFilename(filename)
    ) return null;
    return { path, filename };
  } catch {
    return null;
  }
};

type PartialDiscoverySummary = CloudDirectoryDiscoverySummary & Readonly<{
  status: "paused";
  stopReason: "directory-limit" | "list-request-limit" | "time-limit";
}>;

const partialDiscovery = (
  summary: CloudDirectoryDiscoverySummary,
): summary is PartialDiscoverySummary => (
  summary.status === "paused"
  && (
    summary.stopReason === "directory-limit"
    || summary.stopReason === "list-request-limit"
    || summary.stopReason === "time-limit"
  )
);

const PARTIAL_REASON_KEY = {
  "directory-limit": "directoryPicker.discovery.reason.directoryLimit",
  "list-request-limit": "directoryPicker.discovery.reason.listRequestLimit",
  "time-limit": "directoryPicker.discovery.reason.timeLimit",
} as const satisfies Partial<
  Record<CloudDirectoryDiscoverySummary["stopReason"], WorkbenchMessageKey>
>;

export function createCloudDirectoryPickerModalClass(
  ModalBase: CloudDirectoryPickerModalConstructor,
) {
  return class CloudDirectoryPickerModal extends ModalBase
    implements CloudDirectoryPickerPresenter {
    private query = "";
    private selectedPath: string | null = null;
    private confirmationVisible = false;
    private abortController: AbortController | null = null;
    private result: Promise<string | null> | null = null;
    private settleResult: ((value: string | null) => void) | null = null;
    private requestRoot: string | null = null;
    private settled = false;
    private opener: HTMLElement | null = null;
    private readonly discovery: CloudDirectoryDiscoveryRuntime | undefined;
    private readonly getI18n: () => WorkbenchI18n;
    private requestCandidates: CloudDirectoryCandidateRuntime | null = null;

    constructor(app: App, getI18n: () => WorkbenchI18n);
    constructor(
      app: App,
      discovery: CloudDirectoryDiscoveryRuntime,
      getI18n: () => WorkbenchI18n,
    );
    constructor(
      app: App,
      discoveryOrI18n: CloudDirectoryDiscoveryRuntime | (() => WorkbenchI18n),
      legacyGetI18n?: () => WorkbenchI18n,
    ) {
      super(app);
      if (typeof discoveryOrI18n === "function") {
        this.discovery = undefined;
        this.getI18n = discoveryOrI18n;
      } else {
        this.discovery = discoveryOrI18n;
        if (legacyGetI18n === undefined) throw new Error("missing-i18n-provider");
        this.getI18n = legacyGetI18n;
      }
    }

    request(input: CloudDirectoryPickerRequest): Promise<string | null>;
    request(input: LegacyCloudDirectoryPickerRequest): Promise<string | null>;
    request(
      input: CloudDirectoryPickerRequest | LegacyCloudDirectoryPickerRequest,
    ): Promise<string | null> {
      if (this.result !== null) return this.result;
      const rootPath = "initialRoot" in input
        ? normalizeCatalogScanRoot(input.initialRoot)
        : input.initialPath === null ? "/" : normalizeCatalogScanRoot(input.initialPath);
      this.requestCandidates = "candidates" in input ? input.candidates : null;
      this.requestRoot = rootPath;
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.abortController = new AbortController();
      this.result = new Promise((resolve) => { this.settleResult = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      const rootPath = this.requestRoot;
      const controller = this.abortController;
      if (rootPath === null || controller === null) throw new Error("invalid-scan-root");
      const { signal } = controller;
      const i18n = this.getI18n();
      const doc = this.contentEl.ownerDocument;
      this.setTitle(i18n.t("directoryPicker.title"));
      this.contentEl.replaceChildren();
      this.contentEl.classList.add("knowledge-workbench__directory-picker");
      this.contentEl.addEventListener("keydown", this.handleKeydown, { signal });

      const breadcrumb = doc.createElement("p");
      breadcrumb.className = "knowledge-workbench__directory-picker-breadcrumb";
      breadcrumb.dataset.directoryBreadcrumb = "true";
      breadcrumb.textContent = i18n.t("directoryPicker.scope", { root: rootPath });

      const safety = doc.createElement("p");
      safety.className = "knowledge-workbench__directory-picker-safety";
      safety.textContent = i18n.t("directoryPicker.safety");

      const queryLabel = doc.createElement("label");
      queryLabel.textContent = i18n.t("directoryPicker.query.label");
      const queryInput = doc.createElement("input");
      queryInput.type = "search";
      queryInput.autocomplete = "off";
      queryInput.dataset.directoryQuery = "true";
      queryInput.placeholder = i18n.t("directoryPicker.query.placeholder");
      queryInput.value = this.query;
      queryLabel.append(queryInput);

      const status = doc.createElement("p");
      status.className = "knowledge-workbench__directory-picker-status";
      status.dataset.directoryDiscoveryStatus = "true";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");

      const results = doc.createElement("div");
      results.className = "knowledge-workbench__directory-picker-results";
      results.dataset.directoryResults = "true";

      const selected = doc.createElement("p");
      selected.className = "knowledge-workbench__directory-picker-selected";
      selected.dataset.selectedDirectory = "true";
      const useDirectory = doc.createElement("button");
      useDirectory.type = "button";
      useDirectory.dataset.action = "use-directory";
      useDirectory.textContent = i18n.t("directoryPicker.use");
      useDirectory.disabled = true;

      const renderSelection = (): void => {
        selected.textContent = this.selectedPath === null
          ? i18n.t("directoryPicker.selected.none")
          : i18n.t("directoryPicker.selected.path", { path: this.selectedPath });
        useDirectory.disabled = this.selectedPath === null;
      };
      const renderResults = (candidates: readonly RankedCloudDirectory[]): void => {
        results.replaceChildren();
        const seen = new Set<string>();
        for (const candidate of candidates) {
          const directory = safeDirectory(candidate, rootPath);
          if (directory === null || seen.has(directory.path)) continue;
          seen.add(directory.path);
          const choice = doc.createElement("button");
          choice.type = "button";
          choice.className = "knowledge-workbench__directory-picker-result";
          choice.dataset.directoryPath = directory.path;
          choice.textContent = directory.filename;
          choice.title = directory.path;
          choice.addEventListener("click", () => {
            this.selectedPath = directory.path;
            renderSelection();
          }, { signal });
          results.append(choice);
        }
        if (results.childElementCount === 0) {
          const empty = doc.createElement("p");
          empty.className = "knowledge-workbench__empty";
          empty.textContent = i18n.t("directoryPicker.results.empty");
          results.append(empty);
        }
      };
      const searchCached = (): void => {
        try {
          const candidates = this.discovery?.searchCached(this.query) ?? rankCloudDirectoryCandidates({
            candidates: this.requestCandidates?.snapshot() ?? [],
            query: this.query,
            enabledSources: new Set(["recent", "session-cache", "cloud-locator", "txt-group"]),
            selectedPath: this.selectedPath,
          }).flatMap((ranked): readonly RankedCloudDirectory[] => (
            ranked.candidate.kind === "exact"
              ? [{
                path: ranked.candidate.path,
                filename: ranked.candidate.filename,
                score: ranked.score,
              }]
              : []
          ));
          renderResults(candidates);
          status.textContent = "";
        } catch {
          renderResults([]);
          status.textContent = i18n.t("directoryPicker.error");
        }
      };
      queryInput.addEventListener("input", () => {
        this.query = queryInput.value;
        this.selectedPath = null;
        renderSelection();
        searchCached();
      }, { signal });

      const discoveryActions = doc.createElement("div");
      discoveryActions.className = "knowledge-workbench__directory-picker-discovery-actions";
      const searchMore = doc.createElement("button");
      searchMore.type = "button";
      searchMore.dataset.action = "search-more-directories";
      searchMore.textContent = i18n.t("directoryPicker.searchMore");

      const confirmation = doc.createElement("section");
      confirmation.className = "knowledge-workbench__directory-picker-confirmation";
      confirmation.dataset.directoryDiscoveryConfirmation = "true";
      confirmation.hidden = !this.confirmationVisible;
      const confirmationTitle = doc.createElement("h3");
      confirmationTitle.textContent = i18n.t("directoryPicker.confirmation.title");
      const confirmationRoot = doc.createElement("p");
      confirmationRoot.className = "knowledge-workbench__directory-picker-confirmation-root";
      confirmationRoot.textContent = i18n.t("directoryPicker.confirmation.root", {
        root: rootPath,
      });
      const confirmationBudget = doc.createElement("p");
      confirmationBudget.textContent = i18n.t("directoryPicker.confirmation.budget", {
        directories: CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDirectoryCount,
        requests: CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxListRequestCount,
        minutes: CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDurationMs / 60_000,
      });
      const confirmDiscovery = doc.createElement("button");
      confirmDiscovery.type = "button";
      confirmDiscovery.dataset.action = "confirm-directory-discovery";
      confirmDiscovery.textContent = i18n.t("directoryPicker.confirmation.confirm");
      confirmation.append(
        confirmationTitle,
        confirmationRoot,
        confirmationBudget,
        confirmDiscovery,
      );
      searchMore.addEventListener("click", () => {
        this.confirmationVisible = true;
        confirmation.hidden = false;
        confirmDiscovery.focus();
      }, { signal });
      confirmDiscovery.addEventListener("click", () => {
        confirmDiscovery.disabled = true;
        status.textContent = i18n.t("directoryPicker.discovery.running");
        const discovery = this.discovery;
        if (discovery === undefined) {
          confirmDiscovery.disabled = false;
          status.textContent = i18n.t("directoryPicker.error");
          return;
        }
        void discovery.discoverMore(rootPath, signal).then((value) => {
          if (signal.aborted) return;
          searchCached();
          status.textContent = partialDiscovery(value)
            ? i18n.t("directoryPicker.discovery.partial", {
              reason: i18n.t(PARTIAL_REASON_KEY[value.stopReason]),
              directories: value.directoryCount,
              requests: value.listRequestCount,
            })
            : i18n.t("directoryPicker.discovery.complete", {
              directories: value.directoryCount,
              requests: value.listRequestCount,
            });
          this.confirmationVisible = false;
          confirmation.hidden = true;
        }).catch(() => {
          if (signal.aborted) return;
          searchCached();
          status.textContent = i18n.t("directoryPicker.error");
        }).finally(() => {
          if (!signal.aborted) confirmDiscovery.disabled = false;
        });
      }, { signal });
      discoveryActions.append(searchMore);

      const modalActions = doc.createElement("div");
      modalActions.className = "knowledge-workbench__modal-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel-directory-picker";
      cancel.textContent = i18n.t("directoryPicker.cancel");
      cancel.addEventListener("click", () => this.finish(null), { signal });
      useDirectory.addEventListener("click", () => {
        const path = this.selectedPath;
        if (path === null) return;
        this.finish(normalizeCatalogScanRoot(path));
      }, { signal });
      modalActions.append(cancel, useDirectory);

      renderSelection();
      this.contentEl.append(
        breadcrumb,
        safety,
        queryLabel,
        status,
        results,
        discoveryActions,
        confirmation,
        selected,
        modalActions,
      );
      queryInput.focus();
    }

    onClose(): void {
      this.abortController?.abort();
      this.abortController = null;
      for (const input of Array.from(
        this.contentEl.querySelectorAll<HTMLInputElement>("input"),
      )) {
        input.value = "";
      }
      if (!this.settled) this.resolve(null);
      this.query = "";
      this.selectedPath = null;
      this.confirmationVisible = false;
      this.requestRoot = null;
      this.requestCandidates = null;
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }

    private readonly handleKeydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.finish(null);
    };

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
  };
}
