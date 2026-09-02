import {
  rankCloudDirectoryCandidates,
  type CloudDirectoryCandidate,
  type CloudDirectoryCandidateRuntime,
  type CloudDirectoryCandidateSource,
  type RankedCloudDirectoryCandidate,
} from "../catalog/cloud-directory-candidates";
import type {
  CloudDirectoryBrowserRuntime,
  CloudDirectoryBrowserStopReason,
  CloudDirectoryIdentity,
  CloudDirectoryLayerSnapshot,
} from "../catalog/cloud-directory-browser";
import type {
  CloudDirectoryLocatorRuntime,
  CloudDirectoryLocatorStopReason,
  CloudDirectoryLocatorSummary,
} from "../catalog/cloud-directory-locator";
import {
  normalizeCatalogScanRoot,
  normalizeCloudAbsolutePath,
} from "../catalog/catalog-path";
import {
  resolveCloudDirectorySelection,
  validateCloudDirectorySelection,
  type CloudDirectoryPickerPurpose,
  type CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";
import type {
  CloudDirectoryPickerBrowserDetail,
  CloudDirectoryPickerBrowserFixedError,
  CloudDirectoryPickerLookupDetail,
  CloudDirectoryPickerPhase,
  CloudDirectoryPickerSessionState,
  CloudDirectoryPickerStatusCode,
  FolderSelectionDraft,
  FolderSelectionSessionDriver,
} from "./folder-selection-host";

export interface CloudDirectoryPickerSessionDependencies {
  readonly candidates: CloudDirectoryCandidateRuntime;
  readonly browser?: CloudDirectoryBrowserRuntime;
  readonly locator?: CloudDirectoryLocatorRuntime;
  readonly purpose: CloudDirectoryPickerPurpose;
  readonly initialPath: string | null;
}

export type CloudDirectoryPickerSession = FolderSelectionSessionDriver;

const ALL_SOURCES = Object.freeze([
  "recent",
  "session-cache",
  "txt-group",
  "cloud-locator",
] as const satisfies readonly CloudDirectoryCandidateSource[]);

const EMPTY_DIRECTORIES = Object.freeze([]) as readonly CloudDirectoryIdentity[];

const LOCATOR_STOP_REASONS = new Set<CloudDirectoryLocatorStopReason>([
  "complete",
  "user-canceled",
  "directory-limit",
  "list-request-limit",
  "time-limit",
]);

const BROWSER_STOP_REASONS = new Set<CloudDirectoryBrowserStopReason>([
  "complete",
  "entry-limit",
  "list-request-limit",
  "time-limit",
  "user-canceled",
]);

const locatorStatusFor = (
  reason: CloudDirectoryLocatorStopReason,
): CloudDirectoryLocatorSummary["status"] => {
  if (reason === "complete") return "complete";
  if (reason === "user-canceled") return "canceled";
  return "paused";
};

const browserStatusFor = (
  reason: CloudDirectoryBrowserStopReason,
): "complete" | "paused" | "canceled" => {
  if (reason === "complete") return "complete";
  if (reason === "user-canceled") return "canceled";
  return "paused";
};

const leafName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const parentPath = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
};

const isDirectChild = (parent: string, child: string): boolean => {
  const prefix = parent === "/" ? "/" : `${parent}/`;
  if (!child.startsWith(prefix)) return false;
  const remainder = child.slice(prefix.length);
  return remainder.length > 0 && !remainder.includes("/");
};

const safeInteger = (value: unknown): value is number => (
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
);

const frozenSelection = (value: CloudDirectorySelection): CloudDirectorySelection => (
  Object.freeze({ ...value })
);

const detachedPurpose = (value: CloudDirectoryPickerPurpose): CloudDirectoryPickerPurpose => {
  if (value.kind === "scan") return Object.freeze({ kind: "scan" });
  return Object.freeze({
    kind: "verification",
    groups: Object.freeze(value.groups.map((group) => Object.freeze({ ...group }))),
  });
};

const safeCandidate = (input: CloudDirectoryCandidate): CloudDirectoryCandidate | null => {
  try {
    if (input.kind === "name-hint") {
      const filename = input.filename.normalize("NFC");
      if (
        filename.length === 0
        || /\p{Cc}/u.test(filename)
        || input.catalogGroupKey.length === 0
      ) return null;
      return Object.freeze({
        kind: "name-hint",
        filename,
        source: "txt-group",
        catalogGroupKey: input.catalogGroupKey,
      });
    }
    const path = normalizeCatalogScanRoot(input.path);
    const filename = input.filename.normalize("NFC");
    if (filename !== leafName(path)) return null;
    if (input.kind === "conflict") {
      return Object.freeze({
        kind: "conflict",
        filename,
        path,
        source: "cloud-locator",
        reason: "same-path-different-identity",
      });
    }
    if (
      (input.source !== "recent"
        && input.source !== "session-cache"
        && input.source !== "cloud-locator")
      || (input.pathState !== "previously-used" && input.pathState !== "session-verified")
    ) return null;
    return Object.freeze({
      kind: "exact",
      path,
      filename,
      source: input.source,
      pathState: input.pathState,
      ...(typeof input.cloudFsId === "string" ? { cloudFsId: input.cloudFsId } : {}),
    });
  } catch {
    return null;
  }
};

const detachedCandidates = (
  input: readonly CloudDirectoryCandidate[],
): readonly CloudDirectoryCandidate[] => {
  const output: CloudDirectoryCandidate[] = [];
  try {
    for (const value of input) {
      const candidate = safeCandidate(value);
      if (candidate !== null) output.push(candidate);
    }
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(output);
};

const detachedLocatorCandidates = (
  input: readonly CloudDirectoryCandidate[],
): readonly CloudDirectoryCandidate[] => Object.freeze(
  detachedCandidates(input).filter((candidate) => (
    candidate.kind === "conflict"
    || (candidate.kind === "exact"
      && candidate.source === "cloud-locator"
      && candidate.pathState === "session-verified")
  )),
);

const freezeRanked = (
  input: readonly RankedCloudDirectoryCandidate[],
): readonly RankedCloudDirectoryCandidate[] => Object.freeze(input.map((item) => Object.freeze({
  candidate: Object.freeze({ ...item.candidate }),
  sources: Object.freeze([...item.sources]),
  score: item.score,
  selected: item.selected,
})));

const detachedLookupDetail = (
  value: CloudDirectoryLocatorSummary,
  expectedQuery: string,
): CloudDirectoryPickerLookupDetail => {
  const query = value.query.normalize("NFC").trim();
  if (
    query !== expectedQuery
    || (value.status !== "complete" && value.status !== "paused" && value.status !== "canceled")
    || !LOCATOR_STOP_REASONS.has(value.stopReason)
    || value.status !== locatorStatusFor(value.stopReason)
    || !safeInteger(value.directoryCount)
    || !safeInteger(value.matchCount)
    || !safeInteger(value.listRequestCount)
    || !safeInteger(value.elapsedMs)
  ) throw new RangeError("cloud-directory-locator-summary-invalid");
  return Object.freeze({
    status: value.status,
    stopReason: value.stopReason,
    query,
    directoryCount: value.directoryCount,
    matchCount: value.matchCount,
    listRequestCount: value.listRequestCount,
    elapsedMs: value.elapsedMs,
  });
};

const safeDirectory = (
  input: unknown,
  parent: string,
): CloudDirectoryIdentity => {
  if (input === null || typeof input !== "object") {
    throw new RangeError("cloud-directory-browser-snapshot-invalid");
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (
    typeof value.fsId !== "string"
    || value.fsId.length === 0
    || /\p{Cc}/u.test(value.fsId)
    || typeof value.path !== "string"
    || typeof value.filename !== "string"
  ) throw new RangeError("cloud-directory-browser-snapshot-invalid");
  const path = normalizeCatalogScanRoot(value.path);
  const filename = value.filename.normalize("NFC");
  if (
    filename.length === 0
    || /\p{Cc}/u.test(filename)
    || filename !== leafName(path)
    || !isDirectChild(parent, path)
  ) throw new RangeError("cloud-directory-browser-snapshot-invalid");
  return Object.freeze({ fsId: value.fsId, path, filename });
};

const detachedLayer = (
  value: CloudDirectoryLayerSnapshot | null,
  expectedPath: string,
): CloudDirectoryLayerSnapshot | null => {
  if (value === null) return null;
  const path = normalizeCloudAbsolutePath(value.path);
  if (
    path !== expectedPath
    || !Array.isArray(value.directories)
    || (value.nextStart !== null
      && (!safeInteger(value.nextStart) || value.nextStart % 1000 !== 0))
    || typeof value.complete !== "boolean"
    || !safeInteger(value.cumulativeCheckedEntryCount)
    || !safeInteger(value.cumulativeListRequestCount)
    || (value.lastStopReason !== null && !BROWSER_STOP_REASONS.has(value.lastStopReason))
  ) throw new RangeError("cloud-directory-browser-snapshot-invalid");
  const fsIds = new Set<string>();
  const paths = new Set<string>();
  const directories = value.directories.map((directory) => {
    const detached = safeDirectory(directory, path);
    if (fsIds.has(detached.fsId) || paths.has(detached.path)) {
      throw new RangeError("cloud-directory-browser-snapshot-invalid");
    }
    fsIds.add(detached.fsId);
    paths.add(detached.path);
    return detached;
  });
  return Object.freeze({
    path,
    directories: Object.freeze(directories),
    nextStart: value.nextStart,
    complete: value.complete,
    cumulativeCheckedEntryCount: value.cumulativeCheckedEntryCount,
    cumulativeListRequestCount: value.cumulativeListRequestCount,
    lastStopReason: value.lastStopReason,
  });
};

const sameDirectories = (
  left: readonly CloudDirectoryIdentity[],
  right: readonly CloudDirectoryIdentity[],
): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]!;
    const next = right[index]!;
    if (
      previous.fsId !== next.fsId
      || previous.path !== next.path
      || previous.filename !== next.filename
    ) return false;
  }
  return true;
};

const adoptLayer = (
  current: CloudDirectoryLayerSnapshot | null,
  next: CloudDirectoryLayerSnapshot | null,
): CloudDirectoryLayerSnapshot | null => {
  if (
    current === null
    || next === null
    || current.path !== next.path
    || !sameDirectories(current.directories, next.directories)
  ) return next;
  return Object.freeze({ ...next, directories: current.directories });
};

const detachedBrowserRound = (input: Readonly<{
  checkedEntryCount: number;
  listRequestCount: number;
  elapsedMs: number;
  stopReason: CloudDirectoryBrowserStopReason | null;
}>): NonNullable<CloudDirectoryPickerBrowserDetail["round"]> => {
  if (
    !safeInteger(input.checkedEntryCount)
    || !safeInteger(input.listRequestCount)
    || !safeInteger(input.elapsedMs)
    || (input.stopReason !== null && !BROWSER_STOP_REASONS.has(input.stopReason))
  ) throw new RangeError("cloud-directory-browser-round-invalid");
  return Object.freeze({ ...input });
};

class CloudDirectoryPickerSessionService implements FolderSelectionSessionDriver {
  readonly #candidates: CloudDirectoryCandidateRuntime;
  readonly #browser: CloudDirectoryBrowserRuntime | undefined;
  readonly #locator: CloudDirectoryLocatorRuntime | undefined;
  readonly #purpose: CloudDirectoryPickerPurpose;
  readonly #listeners = new Set<() => void>();
  readonly #enabledSources = new Set<CloudDirectoryCandidateSource>(ALL_SOURCES);
  readonly #browserHighlightsByLayer = new Map<string, string>();
  #phase: CloudDirectoryPickerPhase = "local";
  #query = "";
  #enabledSourceList: readonly CloudDirectoryCandidateSource[] = ALL_SOURCES;
  #initialCandidate: CloudDirectoryCandidate | null;
  #locatedCandidates: readonly CloudDirectoryCandidate[] = Object.freeze([]);
  #rankedCandidates: readonly RankedCloudDirectoryCandidate[] = Object.freeze([]);
  #selectedPath: string | null = null;
  #draftSelection: CloudDirectorySelection | null = null;
  #draftOrigin: "candidate" | "browser" | null = null;
  #statusCode: CloudDirectoryPickerStatusCode | null = null;
  #lookupDetail: CloudDirectoryPickerLookupDetail | null = null;
  #lookupController: AbortController | null = null;
  #lookupGeneration = 0;
  #frozenLookupQuery: string | null = null;
  #browserUnsubscribe: (() => void) | null = null;
  #browserPath: string | null = null;
  #browserHighlightedPath: string | null = null;
  #browserLayer: CloudDirectoryLayerSnapshot | null = null;
  #browserVisibleSource: readonly CloudDirectoryIdentity[] | null = null;
  #browserVisibleQuery = "";
  #visibleBrowserDirectories: readonly CloudDirectoryIdentity[] = EMPTY_DIRECTORIES;
  #browserActivity: CloudDirectoryPickerSessionState["browserActivity"] = "idle";
  #browserDetail: CloudDirectoryPickerBrowserDetail = Object.freeze({
    round: null,
    fixedError: null,
  });
  #browserRoundBaseline: Readonly<{ checked: number; requests: number }> | null = null;
  #browserController: AbortController | null = null;
  #browserGeneration = 0;
  #lifecycleGeneration = 0;
  #usePromise: Promise<FolderSelectionDraft | null> | null = null;
  #disposed = false;

  constructor(dependencies: CloudDirectoryPickerSessionDependencies) {
    this.#candidates = dependencies.candidates;
    this.#browser = dependencies.browser;
    this.#locator = dependencies.locator;
    this.#purpose = detachedPurpose(dependencies.purpose);
    this.#initialCandidate = dependencies.initialPath === null
      ? null
      : safeCandidate({
        kind: "exact",
        path: normalizeCatalogScanRoot(dependencies.initialPath),
        filename: leafName(normalizeCatalogScanRoot(dependencies.initialPath)),
        source: "recent",
        pathState: "previously-used",
      });
    this.#refreshRanking();
    if (this.#initialCandidate?.kind === "exact") {
      this.#selectCandidate(this.#initialCandidate.path);
    }
    if (this.#browser !== undefined) {
      try {
        this.#browserUnsubscribe = this.#browser.subscribe((path) => {
          this.#refreshBrowserSnapshot(path);
        });
      } catch {
        this.#setBrowserError("browser-unavailable", false);
      }
    }
  }

  snapshot(): CloudDirectoryPickerSessionState {
    return Object.freeze({
      phase: this.#phase,
      purpose: this.#purpose,
      query: this.#query,
      enabledSources: this.#enabledSourceList,
      rankedCandidates: this.#rankedCandidates,
      selectedPath: this.#selectedPath,
      draftSelection: this.#draftSelection,
      lookupDetail: this.#lookupDetail,
      browserPath: this.#browserPath,
      browserHighlightedPath: this.#browserHighlightedPath,
      browserLayer: this.#browserLayer,
      visibleBrowserDirectories: this.#currentBrowserDirectories(),
      browserActivity: this.#browserActivity,
      browserDetail: this.#browserDetail,
      statusCode: this.#statusCode,
    });
  }

  subscribe(listener: () => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  setQuery(value: string): void {
    if (!this.#interactive()) return;
    if (this.#phase === "locating" || this.#phase === "lookup-consent") {
      this.#invalidateLookup();
      this.#phase = this.#browserPath === null ? "local" : "browsing";
    }
    this.#query = value;
    this.#refreshRanking();
    this.#reconcileCandidateDraft();
    if (this.#browserPath !== null) this.#reconcileBrowserHighlight();
    this.#setLocalSearchStatus();
    this.#notify();
  }

  toggleSource(source: CloudDirectoryCandidateSource): void {
    if (!this.#selectionPhase() || !ALL_SOURCES.includes(source)) return;
    if (this.#enabledSources.has(source)) this.#enabledSources.delete(source);
    else this.#enabledSources.add(source);
    this.#enabledSourceList = Object.freeze(
      ALL_SOURCES.filter((candidate) => this.#enabledSources.has(candidate)),
    );
    this.#refreshRanking();
    this.#reconcileCandidateDraft();
    this.#setLocalSearchStatus();
    this.#notify();
  }

  selectCandidate(path: string): void {
    if (!this.#selectionPhase()) return;
    this.#selectCandidate(path);
    this.#notify();
  }

  async clearRecent(): Promise<void> {
    if (!this.#selectionPhase()) return;
    const generation = this.#lifecycleGeneration;
    try {
      await this.#candidates.clearRecent();
    } catch {
      if (!this.#isLifecycleCurrent(generation)) return;
      this.#statusCode = "save-failed";
      this.#notify();
      return;
    }
    if (!this.#isLifecycleCurrent(generation)) return;
    this.#refreshRanking();
    this.#reconcileCandidateDraft();
    this.#setLocalSearchStatus();
    this.#notify();
  }

  requestLookupConsent(): void {
    if (!this.#selectionPhase()) return;
    const query = this.#query.normalize("NFC").trim();
    if (query.length === 0) {
      this.#statusCode = "query-required";
      this.#notify();
      return;
    }
    if (this.#locator === undefined || this.#browserController !== null) {
      this.#statusCode = "lookup-incomplete";
      this.#notify();
      return;
    }
    this.#frozenLookupQuery = query;
    this.#phase = "lookup-consent";
    this.#statusCode = "lookup-consent-required";
    this.#notify();
  }

  async confirmLookup(): Promise<void> {
    if (this.#phase !== "lookup-consent" || this.#locator === undefined) return;
    const query = this.#frozenLookupQuery;
    if (query === null) return;
    this.#lookupController?.abort();
    const controller = new AbortController();
    const generation = ++this.#lookupGeneration;
    this.#lookupController = controller;
    this.#phase = "locating";
    this.#statusCode = "lookup-running";
    this.#lookupDetail = null;
    this.#notify();
    try {
      const value = await this.#locator.locateByName(query, controller.signal);
      if (!this.#isLookupCurrent(generation, controller)) return;
      const detail = detachedLookupDetail(value, query);
      this.#locatedCandidates = Object.freeze([
        ...this.#locatedCandidates,
        ...detachedLocatorCandidates(value.candidates),
      ]);
      this.#lookupDetail = detail;
      this.#phase = this.#browserPath === null ? "local" : "browsing";
      this.#statusCode = detail.status === "complete"
        ? "lookup-complete"
        : "lookup-incomplete";
      this.#frozenLookupQuery = null;
      this.#refreshRanking();
      this.#reconcileCandidateDraft();
      if (this.#phase === "browsing") this.#setBrowsingStatus();
      this.#notify();
    } catch {
      if (!this.#isLookupCurrent(generation, controller)) return;
      this.#lookupDetail = null;
      this.#phase = this.#browserPath === null ? "local" : "browsing";
      this.#statusCode = "lookup-incomplete";
      this.#frozenLookupQuery = null;
      if (this.#phase === "browsing") this.#setBrowsingStatus();
      this.#notify();
    } finally {
      if (this.#lookupGeneration === generation && this.#lookupController === controller) {
        this.#lookupController = null;
      }
    }
  }

  cancelLookup(): void {
    if (this.#phase !== "lookup-consent" && this.#phase !== "locating") return;
    this.#invalidateLookup();
    this.#phase = this.#browserPath === null ? "local" : "browsing";
    this.#setLocalSearchStatus();
    this.#notify();
  }

  revealRootBrowser(): void {
    if (!this.#selectionPhase()) return;
    if (this.#browser === undefined || this.#browserController !== null) {
      this.#setBrowserError("browser-unavailable");
      return;
    }
    try {
      if (this.#browser.rootAccessGranted()) {
        this.enterBrowserPath("/");
        return;
      }
    } catch {
      this.#setBrowserError("browser-unavailable");
      return;
    }
    this.#phase = "root-consent";
    this.#statusCode = "root-consent-required";
    this.#notify();
  }

  confirmRootBrowser(): void {
    if (this.#phase !== "root-consent" || this.#browser === undefined) return;
    try {
      this.#browser.grantRootAccess();
    } catch {
      this.#setBrowserError("browser-unavailable");
      return;
    }
    this.enterBrowserPath("/");
  }

  cancelRootBrowser(): void {
    if (this.#phase !== "root-consent") return;
    this.#phase = this.#browserPath === null ? "local" : "browsing";
    this.#setLocalSearchStatus();
    this.#notify();
  }

  enterBrowserPath(rawPath: string): void {
    if (
      (!this.#selectionPhase() && this.#phase !== "root-consent")
      || this.#browser === undefined
    ) return;
    let path: string;
    try {
      path = normalizeCloudAbsolutePath(rawPath);
      if (path === "/" && !this.#browser.rootAccessGranted()) {
        this.#phase = "root-consent";
        this.#statusCode = "root-consent-required";
        this.#notify();
        return;
      }
    } catch {
      this.#setBrowserError("stale-directory");
      return;
    }
    this.#abortBrowserOperation();
    if (this.#browserPath === null && this.#query.length > 0) {
      this.#query = "";
      this.#refreshRanking();
    }
    const previousPath = this.#browserPath;
    this.#browserPath = path;
    if (previousPath !== path) {
      this.#browserLayer = null;
      this.#browserVisibleSource = null;
      this.#browserVisibleQuery = "";
      this.#visibleBrowserDirectories = EMPTY_DIRECTORIES;
    }
    this.#browserHighlightedPath = this.#browserHighlightsByLayer.get(path) ?? null;
    this.#browserDetail = Object.freeze({ round: null, fixedError: null });
    this.#phase = "browsing";
    try {
      const snapshot = detachedLayer(this.#browser.snapshot(path), path);
      this.#browserLayer = adoptLayer(this.#browserLayer, snapshot);
      if (this.#browserLayer !== null) {
        this.#browserActivity = this.#browserLayer.complete
          ? "complete"
          : this.#browserLayer.lastStopReason === "user-canceled" ? "canceled" : "incomplete";
        this.#statusCode = this.#browserLayer.complete ? null : "browser-incomplete";
        this.#reconcileBrowserHighlight();
        this.#notify();
        return;
      }
    } catch {
      this.#browserLayer = null;
      this.#reconcileBrowserHighlight();
      this.#setBrowserError("browser-unavailable");
      return;
    }
    void this.#startBrowserLoad(path, 0);
  }

  navigateBreadcrumb(path: string): void {
    if (this.#browserPath === null) return;
    let normalized: string;
    try {
      normalized = normalizeCloudAbsolutePath(path);
    } catch {
      this.#statusCode = "selection-invalid";
      this.#notify();
      return;
    }
    if (
      normalized !== this.#browserPath
      && normalized !== "/"
      && !this.#browserPath.startsWith(`${normalized}/`)
    ) {
      this.#statusCode = "selection-invalid";
      this.#notify();
      return;
    }
    this.enterBrowserPath(normalized);
  }

  highlightBrowserPath(path: string | null): void {
    if (this.#phase !== "browsing" || this.#browserPath === null || this.#browserController !== null) {
      return;
    }
    if (path === null) {
      this.#browserHighlightedPath = null;
      this.#browserHighlightsByLayer.delete(this.#browserPath);
      this.#notify();
      return;
    }
    let normalized: string;
    try {
      normalized = normalizeCatalogScanRoot(path);
    } catch {
      return;
    }
    if (!this.#currentBrowserDirectories().some((directory) => directory.path === normalized)) {
      return;
    }
    this.#browserHighlightedPath = normalized;
    this.#browserHighlightsByLayer.set(this.#browserPath, normalized);
    this.#notify();
  }

  async selectCurrentDirectory(): Promise<void> {
    if (
      this.#phase !== "browsing"
      || this.#browserPath === null
      || this.#browserController !== null
    ) return;
    this.#setBrowserDraft("directory", this.#browserPath);
  }

  async selectHighlightedDirectory(): Promise<void> {
    if (
      this.#browserPath === null
      || this.#phase !== "browsing"
      || this.#browserHighlightedPath === null
      || this.#browserController !== null
      || !this.#currentBrowserDirectories().some((directory) => (
        directory.path === this.#browserHighlightedPath
      ))
    ) return;
    this.#setBrowserDraft("directory", this.#browserHighlightedPath);
  }

  async selectCategory(path: string): Promise<void> {
    if (
      this.#browserPath === null
      || this.#phase !== "browsing"
      || this.#browserController !== null
      || !this.#currentBrowserDirectories().some((directory) => directory.path === path)
    ) return;
    this.#setBrowserDraft("category", path);
  }

  async continueBrowser(): Promise<void> {
    if (
      this.#phase !== "browsing"
      || this.#browserPath === null
      || this.#browserController !== null
      || this.#browserLayer?.nextStart === null
      || this.#browserLayer?.nextStart === undefined
    ) return;
    await this.#startBrowserLoad(this.#browserPath, this.#browserLayer.nextStart);
  }

  async retryBrowser(): Promise<void> {
    if (
      this.#phase !== "browsing"
      || this.#browserPath === null
      || this.#browserController !== null
    ) return;
    await this.#startBrowserLoad(this.#browserPath, this.#browserLayer?.nextStart ?? 0);
  }

  cancelBrowser(): void {
    if (
      this.#phase !== "browsing"
      || this.#browserController === null
      || this.#browserPath === null
    ) return;
    const previousRound = this.#browserDetail.round;
    this.#abortBrowserOperation();
    this.#browserActivity = "canceled";
    this.#browserDetail = Object.freeze({
      round: Object.freeze({
        checkedEntryCount: previousRound?.checkedEntryCount ?? 0,
        listRequestCount: previousRound?.listRequestCount ?? 0,
        elapsedMs: previousRound?.elapsedMs ?? 0,
        stopReason: "user-canceled",
      }),
      fixedError: null,
    });
    this.#statusCode = "browser-incomplete";
    this.#notify();
  }

  useSelection(): Promise<FolderSelectionDraft | null> {
    if (this.#usePromise !== null) return this.#usePromise;
    if (
      !this.#selectionPhase()
      || this.#draftSelection === null
      || this.#lookupController !== null
      || this.#browserController !== null
    ) return Promise.resolve(null);
    const lifecycleGeneration = this.#lifecycleGeneration;
    const returnPhase = this.#browserPath === null ? "local" : "browsing";
    let selection: CloudDirectorySelection;
    try {
      selection = frozenSelection(validateCloudDirectorySelection(
        this.#draftSelection,
        this.#purpose,
      ));
    } catch {
      this.#statusCode = "selection-invalid";
      this.#notify();
      return Promise.resolve(null);
    }
    this.#phase = "settling";
    this.#statusCode = null;
    this.#notify();
    const operation = (async (): Promise<FolderSelectionDraft | null> => {
      try {
        await this.#candidates.remember(selection.selectedPath);
      } catch {
        if (!this.#isLifecycleCurrent(lifecycleGeneration) || this.#phase !== "settling") {
          return null;
        }
        this.#phase = returnPhase;
        this.#statusCode = "save-failed";
        this.#notify();
        return null;
      }
      if (!this.#isLifecycleCurrent(lifecycleGeneration) || this.#phase !== "settling") {
        return null;
      }
      this.#close();
      return frozenSelection(selection);
    })();
    this.#usePromise = operation;
    void operation.finally(() => {
      if (this.#usePromise === operation) this.#usePromise = null;
    });
    return operation;
  }

  cancel(): void {
    if (this.#phase === "closed") return;
    this.#close();
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#phase !== "closed") this.#close();
    this.#disposed = true;
    this.#listeners.clear();
  }

  #interactive(): boolean {
    return !this.#disposed && this.#phase !== "closed" && this.#phase !== "settling";
  }

  #selectionPhase(): boolean {
    return this.#interactive() && (this.#phase === "local" || this.#phase === "browsing");
  }

  #isLifecycleCurrent(generation: number): boolean {
    return !this.#disposed
      && this.#phase !== "closed"
      && this.#lifecycleGeneration === generation;
  }

  #refreshRanking(): void {
    let local: readonly CloudDirectoryCandidate[] = Object.freeze([]);
    try {
      local = detachedCandidates(this.#candidates.snapshot());
    } catch {
      local = Object.freeze([]);
    }
    try {
      this.#rankedCandidates = freezeRanked(rankCloudDirectoryCandidates({
        candidates: [
          ...(this.#initialCandidate === null ? [] : [this.#initialCandidate]),
          ...local,
          ...this.#locatedCandidates,
        ],
        query: this.#query,
        enabledSources: this.#enabledSources,
        selectedPath: this.#selectedPath,
      }));
    } catch {
      this.#rankedCandidates = Object.freeze([]);
    }
  }

  #selectCandidate(rawPath: string): void {
    let path: string;
    try {
      path = normalizeCatalogScanRoot(rawPath);
    } catch {
      this.#clearDraft("selection-invalid");
      return;
    }
    const exact = this.#rankedCandidates.find((item) => (
      item.candidate.kind === "exact" && item.candidate.path === path
    ));
    if (exact?.candidate.kind !== "exact") {
      const conflict = this.#rankedCandidates.some((item) => (
        item.candidate.kind === "conflict" && item.candidate.path === path
      ));
      this.#clearDraft(conflict ? "conflict" : "selection-invalid");
      return;
    }
    if (this.#purpose.kind === "verification") {
      const basename = leafName(path);
      const matches = this.#purpose.groups.filter((group) => (
        group.groupKey !== "txt-root-items"
        && group.rootRelativePath.normalize("NFC") === basename
      ));
      if (matches.length > 1) {
        this.#clearDraft("conflict");
        return;
      }
      if (matches.length === 1) {
        try {
          const selection = resolveCloudDirectorySelection({
            selectionKind: "category",
            purpose: this.#purpose,
            currentPath: parentPath(path),
            selectedPath: path,
          });
          this.#installDraft(selection, "candidate");
          return;
        } catch {
          this.#clearDraft("selection-invalid");
          return;
        }
      }
    }
    try {
      const selection = resolveCloudDirectorySelection({
        selectionKind: "directory",
        purpose: this.#purpose,
        currentPath: path,
        selectedPath: path,
      });
      this.#installDraft(selection, "candidate");
    } catch {
      this.#clearDraft("selection-invalid");
    }
  }

  #installDraft(
    selection: CloudDirectorySelection,
    origin: "candidate" | "browser",
  ): void {
    this.#draftSelection = frozenSelection(selection);
    this.#selectedPath = selection.selectedPath;
    this.#draftOrigin = origin;
    this.#statusCode = null;
    this.#refreshRanking();
  }

  #clearDraft(statusCode: CloudDirectoryPickerStatusCode): void {
    this.#draftSelection = null;
    this.#selectedPath = null;
    this.#draftOrigin = null;
    this.#statusCode = statusCode;
    this.#refreshRanking();
  }

  #reconcileCandidateDraft(): void {
    if (this.#draftOrigin !== "candidate" || this.#selectedPath === null) return;
    const stillExact = this.#rankedCandidates.some((item) => (
      item.candidate.kind === "exact" && item.candidate.path === this.#selectedPath
    ));
    if (!stillExact) {
      const conflict = this.#rankedCandidates.some((item) => (
        item.candidate.kind === "conflict" && item.candidate.path === this.#selectedPath
      ));
      this.#draftSelection = null;
      this.#selectedPath = null;
      this.#draftOrigin = null;
      if (conflict) this.#statusCode = "conflict";
      this.#refreshRanking();
    }
  }

  #setLocalSearchStatus(): void {
    if (this.#phase === "browsing") {
      this.#setBrowsingStatus();
      return;
    }
    if (this.#query.normalize("NFC").trim().length === 0) {
      this.#statusCode = null;
      return;
    }
    this.#statusCode = this.#rankedCandidates.length === 0 ? "no-local-match" : null;
  }

  #setBrowsingStatus(): void {
    if (this.#browserActivity === "running") {
      this.#statusCode = "browser-loading";
      return;
    }
    if (this.#browserActivity === "incomplete" || this.#browserActivity === "canceled") {
      this.#statusCode = "browser-incomplete";
      return;
    }
    if (this.#browserActivity === "error") {
      this.#statusCode = "browser-error";
      return;
    }
    this.#statusCode = null;
  }

  #invalidateLookup(): void {
    this.#lookupController?.abort();
    this.#lookupController = null;
    this.#lookupGeneration += 1;
    this.#frozenLookupQuery = null;
  }

  #isLookupCurrent(
    generation: number,
    controller: AbortController,
  ): boolean {
    return this.#interactive()
      && this.#phase === "locating"
      && this.#lookupGeneration === generation
      && this.#lookupController === controller
      && !controller.signal.aborted;
  }

  #currentBrowserDirectories(): readonly CloudDirectoryIdentity[] {
    const source = this.#browserLayer?.directories ?? null;
    const query = this.#query.normalize("NFC").trim().toLocaleLowerCase();
    if (source === null) {
      this.#browserVisibleSource = null;
      this.#browserVisibleQuery = query;
      this.#visibleBrowserDirectories = EMPTY_DIRECTORIES;
      return this.#visibleBrowserDirectories;
    }
    if (query.length === 0) {
      this.#browserVisibleSource = source;
      this.#browserVisibleQuery = query;
      this.#visibleBrowserDirectories = source;
      return source;
    }
    if (this.#browserVisibleSource === source && this.#browserVisibleQuery === query) {
      return this.#visibleBrowserDirectories;
    }
    this.#browserVisibleSource = source;
    this.#browserVisibleQuery = query;
    this.#visibleBrowserDirectories = Object.freeze(source.filter((directory) => (
      directory.filename.normalize("NFC").toLocaleLowerCase().includes(query)
      || directory.path.normalize("NFC").toLocaleLowerCase().includes(query)
    )));
    return this.#visibleBrowserDirectories;
  }

  #reconcileBrowserHighlight(): void {
    const browserPath = this.#browserPath;
    if (browserPath === null) return;
    const directories = this.#currentBrowserDirectories();
    const remembered = this.#browserHighlightsByLayer.get(browserPath)
      ?? this.#browserHighlightedPath;
    const next = remembered !== null
      && directories.some((directory) => directory.path === remembered)
      ? remembered
      : directories[0]?.path ?? null;
    this.#browserHighlightedPath = next;
    if (next === null) this.#browserHighlightsByLayer.delete(browserPath);
    else this.#browserHighlightsByLayer.set(browserPath, next);
  }

  #setBrowserDraft(
    selectionKind: "directory" | "category",
    selectedPath: string,
  ): void {
    const browserPath = this.#browserPath;
    if (browserPath === null) return;
    try {
      const selection = resolveCloudDirectorySelection({
        selectionKind,
        purpose: this.#purpose,
        currentPath: browserPath,
        selectedPath,
      });
      this.#installDraft(selection, "browser");
      this.#notify();
    } catch (error) {
      const status = error instanceof RangeError
        && error.message === "cloud-directory-category-ambiguous"
        ? "conflict"
        : "selection-invalid";
      this.#clearDraft(status);
      this.#notify();
    }
  }

  async #startBrowserLoad(path: string, start: number): Promise<void> {
    if (
      !this.#interactive()
      || this.#browser === undefined
      || this.#browserController !== null
      || !safeInteger(start)
    ) return;
    const browser = this.#browser;
    const controller = new AbortController();
    const generation = ++this.#browserGeneration;
    this.#browserController = controller;
    this.#browserPath = path;
    try {
      const baseline = detachedLayer(browser.snapshot(path), path);
      this.#browserLayer = adoptLayer(this.#browserLayer, baseline);
    } catch {
      this.#browserController = null;
      this.#setBrowserError("browser-unavailable");
      return;
    }
    this.#browserRoundBaseline = Object.freeze({
      checked: this.#browserLayer?.cumulativeCheckedEntryCount ?? 0,
      requests: this.#browserLayer?.cumulativeListRequestCount ?? 0,
    });
    this.#browserActivity = "running";
    this.#browserDetail = Object.freeze({
      round: Object.freeze({
        checkedEntryCount: 0,
        listRequestCount: 0,
        elapsedMs: 0,
        stopReason: null,
      }),
      fixedError: null,
    });
    this.#statusCode = "browser-loading";
    this.#phase = "browsing";
    this.#notify();
    const operation = browser.loadLayer({ path, start }, controller.signal).then((value) => {
      if (!this.#isBrowserCurrent(generation, controller)) return;
      if (
        value.path !== path
        || !BROWSER_STOP_REASONS.has(value.stopReason)
        || value.status !== browserStatusFor(value.stopReason)
        || (value.nextStart !== null
          && (!safeInteger(value.nextStart) || value.nextStart % 1000 !== 0))
        || !safeInteger(value.cumulativeCheckedEntryCount)
        || !safeInteger(value.directoryCount)
        || !safeInteger(value.cumulativeListRequestCount)
      ) throw new RangeError("cloud-directory-browser-round-invalid");
      const snapshot = detachedLayer(browser.snapshot(path), path);
      this.#browserLayer = adoptLayer(this.#browserLayer, snapshot);
      const round = detachedBrowserRound({
        checkedEntryCount: value.checkedEntryCount,
        listRequestCount: value.listRequestCount,
        elapsedMs: value.elapsedMs,
        stopReason: value.stopReason,
      });
      this.#browserDetail = Object.freeze({ round, fixedError: null });
      this.#browserActivity = value.status === "complete"
        ? "complete"
        : value.status === "canceled" ? "canceled" : "incomplete";
      this.#statusCode = value.status === "complete" ? null : "browser-incomplete";
      this.#reconcileBrowserHighlight();
    }).catch(() => {
      if (!this.#isBrowserCurrent(generation, controller)) return;
      this.#browserActivity = "error";
      this.#browserDetail = Object.freeze({ round: null, fixedError: "load-failed" });
      this.#statusCode = "browser-error";
    }).finally(() => {
      if (this.#browserGeneration !== generation || this.#browserController !== controller) return;
      this.#browserController = null;
      this.#browserRoundBaseline = null;
      if (this.#phase !== "closed") this.#notify();
    });
    await operation;
  }

  #refreshBrowserSnapshot(rawPath: string): void {
    if (
      this.#browser === undefined
      || this.#browserPath === null
      || this.#phase === "closed"
      || (this.#browserActivity === "canceled" && this.#browserController === null)
    ) return;
    let path: string;
    try {
      path = normalizeCloudAbsolutePath(rawPath);
    } catch {
      return;
    }
    if (path !== this.#browserPath) return;
    try {
      const snapshot = detachedLayer(this.#browser.snapshot(path), path);
      this.#browserLayer = adoptLayer(this.#browserLayer, snapshot);
      if (this.#browserActivity === "running" && this.#browserRoundBaseline !== null) {
        this.#browserDetail = Object.freeze({
          round: Object.freeze({
            checkedEntryCount: Math.max(
              0,
              (this.#browserLayer?.cumulativeCheckedEntryCount ?? 0)
                - this.#browserRoundBaseline.checked,
            ),
            listRequestCount: Math.max(
              0,
              (this.#browserLayer?.cumulativeListRequestCount ?? 0)
                - this.#browserRoundBaseline.requests,
            ),
            elapsedMs: 0,
            stopReason: null,
          }),
          fixedError: null,
        });
      }
      this.#reconcileBrowserHighlight();
      this.#notify();
    } catch {
      this.#setBrowserError("browser-unavailable");
    }
  }

  #setBrowserError(
    error: CloudDirectoryPickerBrowserFixedError,
    notify = true,
  ): void {
    this.#browserActivity = "error";
    this.#browserDetail = Object.freeze({ round: null, fixedError: error });
    this.#statusCode = "browser-error";
    if (notify) this.#notify();
  }

  #isBrowserCurrent(
    generation: number,
    controller: AbortController,
  ): boolean {
    return this.#interactive()
      && this.#browserGeneration === generation
      && this.#browserController === controller
      && !controller.signal.aborted;
  }

  #abortBrowserOperation(): void {
    this.#browserController?.abort();
    this.#browserController = null;
    this.#browserRoundBaseline = null;
    this.#browserGeneration += 1;
  }

  #close(): void {
    if (this.#phase === "closed") return;
    this.#lifecycleGeneration += 1;
    this.#invalidateLookup();
    this.#abortBrowserOperation();
    this.#browserUnsubscribe?.();
    this.#browserUnsubscribe = null;
    this.#phase = "closed";
    this.#selectedPath = null;
    this.#draftSelection = null;
    this.#draftOrigin = null;
    this.#statusCode = null;
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A host listener cannot change session authority or lifecycle.
      }
    }
  }
}

export function createCloudDirectoryPickerSession(
  dependencies: CloudDirectoryPickerSessionDependencies,
): CloudDirectoryPickerSession {
  return new CloudDirectoryPickerSessionService(dependencies);
}
