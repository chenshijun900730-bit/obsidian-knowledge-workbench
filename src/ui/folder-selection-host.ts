import type {
  CloudDirectoryCandidateSource,
  RankedCloudDirectoryCandidate,
} from "../catalog/cloud-directory-candidates";
import type {
  CloudDirectoryBrowserStopReason,
  CloudDirectoryIdentity,
  CloudDirectoryLayerSnapshot,
} from "../catalog/cloud-directory-browser";
import type {
  CloudDirectoryLocatorStopReason,
} from "../catalog/cloud-directory-locator";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";
import type { DirectoryPickerI18n } from "../i18n/workbench-directory-picker-i18n";
import type { WorkbenchLocale } from "../i18n/workbench-i18n";

export type CloudDirectoryPickerPhase =
  | "local"
  | "lookup-consent"
  | "locating"
  | "root-consent"
  | "browsing"
  | "settling"
  | "closed";

export type CloudDirectoryPickerStatusCode =
  | "query-required"
  | "no-local-match"
  | "conflict"
  | "lookup-consent-required"
  | "lookup-running"
  | "lookup-complete"
  | "lookup-incomplete"
  | "root-consent-required"
  | "browser-loading"
  | "browser-incomplete"
  | "browser-error"
  | "selection-invalid"
  | "save-failed";

export interface CloudDirectoryPickerLookupDetail {
  readonly status: "complete" | "paused" | "canceled";
  readonly stopReason: CloudDirectoryLocatorStopReason;
  readonly query: string;
  readonly directoryCount: number;
  readonly matchCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
}

export type CloudDirectoryPickerBrowserFixedError =
  | "browser-unavailable"
  | "stale-directory"
  | "conflict"
  | "load-failed";

export interface CloudDirectoryPickerBrowserDetail {
  readonly round: Readonly<{
    checkedEntryCount: number;
    listRequestCount: number;
    elapsedMs: number;
    stopReason: CloudDirectoryBrowserStopReason | null;
  }> | null;
  readonly fixedError: CloudDirectoryPickerBrowserFixedError | null;
}

export interface CloudDirectoryPickerSessionState {
  readonly phase: CloudDirectoryPickerPhase;
  readonly purpose: CloudDirectoryPickerPurpose;
  readonly query: string;
  readonly enabledSources: readonly CloudDirectoryCandidateSource[];
  readonly rankedCandidates: readonly RankedCloudDirectoryCandidate[];
  readonly selectedPath: string | null;
  readonly draftSelection: CloudDirectorySelection | null;
  readonly lookupDetail: CloudDirectoryPickerLookupDetail | null;
  readonly browserPath: string | null;
  readonly browserHighlightedPath: string | null;
  readonly browserLayer: CloudDirectoryLayerSnapshot | null;
  readonly visibleBrowserDirectories: readonly CloudDirectoryIdentity[];
  readonly browserActivity:
    | "idle"
    | "running"
    | "complete"
    | "incomplete"
    | "canceled"
    | "error";
  readonly browserDetail: CloudDirectoryPickerBrowserDetail;
  readonly statusCode: CloudDirectoryPickerStatusCode | null;
}

export type FolderSelectionDraft = CloudDirectorySelection;
export type FolderSelectionFeedbackCode = "binding-failed";

export interface FolderSelectionSessionDriver {
  snapshot(): CloudDirectoryPickerSessionState;
  subscribe(listener: () => void): () => void;
  setQuery(value: string): void;
  toggleSource(source: CloudDirectoryCandidateSource): void;
  selectCandidate(path: string): void;
  clearRecent(): Promise<void>;
  requestLookupConsent(): void;
  confirmLookup(): Promise<void>;
  cancelLookup(): void;
  revealRootBrowser(): void;
  confirmRootBrowser(): void;
  cancelRootBrowser(): void;
  enterBrowserPath(path: string): void;
  navigateBreadcrumb(path: string): void;
  highlightBrowserPath(path: string | null): void;
  selectCurrentDirectory(): Promise<void>;
  selectHighlightedDirectory(): Promise<void>;
  selectCategory(path: string): Promise<void>;
  continueBrowser(): Promise<void>;
  retryBrowser(): Promise<void>;
  cancelBrowser(): void;
  useSelection(): Promise<FolderSelectionDraft | null>;
  cancel(): void;
  dispose(): void;
}

export interface FolderSelectionHostSnapshot {
  readonly revision: number;
  readonly i18n: DirectoryPickerI18n;
  readonly state: CloudDirectoryPickerSessionState;
  readonly returnLabel: string;
  readonly legacyProgressMode: "none" | "will-preserve" | "requires-fresh";
  readonly feedbackCode?: FolderSelectionFeedbackCode;
}

export interface FolderSelectionRenderState {
  readonly revision: number;
  readonly locale: WorkbenchLocale;
  readonly state: CloudDirectoryPickerSessionState;
  readonly returnLabel: string;
  readonly legacyProgressMode: "none" | "will-preserve" | "requires-fresh";
  readonly feedbackCode?: FolderSelectionFeedbackCode;
}

export interface FolderSelectionHostActions {
  readonly onBack: () => void;
  readonly onQuery: (value: string) => void;
  readonly onToggleSource: (source: CloudDirectoryCandidateSource) => void;
  readonly onSelectCandidate: (path: string) => void;
  readonly onUse: () => Promise<void> | void;
  readonly onBrowseOther: () => void;
  readonly onConfirmLookup: () => Promise<void> | void;
  readonly onRevealRoot: () => void;
  readonly onConfirmRoot: () => void;
  readonly onBrowserAction: Readonly<{
    onNavigate: (path: string) => void;
    onHighlight: (path: string | null) => void;
    onSelectCurrent: () => Promise<void> | void;
    onSelectHighlighted: () => Promise<void> | void;
    onSelectCategory: (path: string) => Promise<void> | void;
    onContinue: () => Promise<void> | void;
    onRetry: () => Promise<void> | void;
    onCancel: () => void;
  }>;
}

export interface DisposableSurface {
  dispose(): void;
}

export interface FolderSelectionHostCapability {
  readonly available: boolean;
  render(
    root: HTMLElement,
    state: FolderSelectionRenderState,
    actions: FolderSelectionHostActions,
  ): DisposableSurface;
}

export interface FolderSelectionSessionFactoryPort {
  readonly available: boolean;
  create(input: Readonly<{
    purpose: CloudDirectoryPickerPurpose;
    initialPath: string | null;
  }>): FolderSelectionSessionDriver;
}
