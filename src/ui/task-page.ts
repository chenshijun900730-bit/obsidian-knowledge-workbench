import type {
  HybridCatalogGroupViewModel,
  HybridCatalogViewModel,
} from "../catalog/hybrid-catalog-runtime";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";
import type {
  LibraryPrimaryAction,
  LibraryWorkflowKind,
  LibraryWorkflowState,
} from "./library-workflow-state";
import { renderVerificationProgress } from "./verification-progress";

export interface TaskPageModel {
  readonly i18n: WorkbenchI18n;
  readonly workflow: LibraryWorkflowState;
  readonly boundLibraryPath: string | null;
  readonly visibleGroupScope: readonly HybridCatalogGroupViewModel[];
  readonly taskActionRevision: number;
  readonly hybrid?: HybridCatalogViewModel;
  readonly actionPending: boolean;
  readonly pauseRequested: boolean;
}

export interface TaskPageActions {
  readonly onPrimary: (revision: number) => Promise<void> | void;
  readonly onChooseDifferentCategory: () => void;
  readonly onOpenDetails: () => void;
}

const ACTION_KEYS: Readonly<Record<LibraryPrimaryAction, WorkbenchMessageKey>> = {
  "choose-txt": "task.action.chooseTxt",
  "import-txt": "task.action.importTxt",
  "open-connection": "task.action.openConnection",
  "choose-library": "task.action.chooseLibrary",
  start: "task.action.start",
  pause: "task.action.pause",
  resume: "task.action.resume",
  retry: "task.action.retry",
  "open-library": "task.action.openLibrary",
};

const WORKFLOW_ACTION_KEYS: Readonly<Partial<Record<LibraryWorkflowKind, WorkbenchMessageKey>>> = {
  "repair-connection": "task.action.reconnect",
  "repair-library": "task.action.rechooseLibrary",
};

const PENDING_KEYS: Readonly<Record<LibraryPrimaryAction, WorkbenchMessageKey>> = {
  "choose-txt": "task.pending.opening",
  "import-txt": "task.pending.importing",
  "open-connection": "task.pending.opening",
  "choose-library": "task.pending.opening",
  start: "task.pending.starting",
  pause: "task.pending.pausing",
  resume: "task.pending.resuming",
  retry: "task.pending.resuming",
  "open-library": "task.pending.opening",
};

const libraryName = (path: string | null): string | null => {
  if (path === null) return null;
  const segments = path.normalize("NFC").split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
};

const taskCanChangeScope = (workflow: LibraryWorkflowState): boolean => (
  workflow.kind === "ready"
);

const scopeCount = (groups: readonly HybridCatalogGroupViewModel[]): number => (
  groups.reduce((total, group) => total + Math.max(0, group.pdfCount), 0)
);

const appendScope = (
  card: HTMLElement,
  model: TaskPageModel,
  actions: TaskPageActions,
): void => {
  if (model.visibleGroupScope.length === 0 && model.boundLibraryPath === null) return;
  const doc = card.ownerDocument;
  const scope = doc.createElement("section");
  scope.className = "knowledge-workbench__task-scope";
  scope.dataset.taskScope = "true";

  const title = doc.createElement("h3");
  title.textContent = model.i18n.t("task.details.scopeTitle");
  scope.append(title);

  const list = doc.createElement("dl");
  const appendMetric = (label: WorkbenchMessageKey, value: string): void => {
    const term = doc.createElement("dt");
    term.textContent = model.i18n.t(label);
    const description = doc.createElement("dd");
    description.textContent = value;
    list.append(term, description);
  };
  appendMetric(
    "task.details.library",
    libraryName(model.boundLibraryPath) ?? model.i18n.t("task.details.notSelected"),
  );
  if (model.visibleGroupScope.length > 0) {
    appendMetric(
      "task.details.categories",
      model.visibleGroupScope.map((group) => group.label).join("、"),
    );
    appendMetric(
      "task.details.candidates",
      model.i18n.t("task.details.candidateValue", {
        count: model.i18n.number(scopeCount(model.visibleGroupScope)),
      }),
    );
  }
  scope.append(list);

  if (taskCanChangeScope(model.workflow)) {
    const change = doc.createElement("button");
    change.type = "button";
    change.className = "knowledge-workbench__task-secondary";
    change.dataset.taskChooseCategory = "true";
    change.dataset.focusKey = "task-choose-category";
    change.textContent = model.i18n.t("task.action.chooseCategory");
    change.addEventListener("click", actions.onChooseDifferentCategory);
    scope.append(change);
  }
  card.append(scope);
};

const progressBatchFor = (model: TaskPageModel) => (
  ["running", "paused", "retry-later"].includes(model.workflow.kind)
    ? model.hybrid?.batch
    : undefined
);

export const renderTaskPage = (
  root: HTMLElement,
  model: TaskPageModel,
  actions: TaskPageActions,
  detailsOpen = false,
): void => {
  const doc = root.ownerDocument;
  root.replaceChildren();
  root.className = "knowledge-workbench__task-page";

  const card = doc.createElement("article");
  card.className = "knowledge-workbench__task-card";
  card.dataset.taskCard = model.workflow.kind;

  const eyebrow = doc.createElement("p");
  eyebrow.className = "knowledge-workbench__task-eyebrow";
  eyebrow.textContent = model.i18n.t("task.current");
  const heading = doc.createElement("h2");
  heading.textContent = model.i18n.t(model.workflow.titleKey);
  const description = doc.createElement("p");
  description.className = "knowledge-workbench__task-description";
  description.textContent = model.i18n.t(model.workflow.descriptionKey);
  card.append(eyebrow, heading, description);

  appendScope(card, model, actions);

  if (model.visibleGroupScope.length > 0) {
    const safety = doc.createElement("p");
    safety.className = "knowledge-workbench__task-safety";
    safety.dataset.taskSafety = "true";
    safety.textContent = model.i18n.t("task.readOnlyBoundary");
    card.append(safety);
  }

  const action = model.workflow.primaryAction;
  const primary = doc.createElement("button");
  primary.type = "button";
  primary.className = "mod-cta knowledge-workbench__task-primary";
  primary.dataset.taskPrimary = action;
  primary.dataset.focusKey = "task-primary";
  const externallyPending = action === "pause"
    ? model.pauseRequested
    : model.actionPending;
  const actionLabelKey = WORKFLOW_ACTION_KEYS[model.workflow.kind] ?? ACTION_KEYS[action];
  const label = externallyPending ? PENDING_KEYS[action] : actionLabelKey;
  primary.textContent = model.i18n.t(label);
  primary.disabled = externallyPending;
  primary.setAttribute("aria-busy", externallyPending ? "true" : "false");
  let invoked = false;
  primary.addEventListener("click", () => {
    if (invoked || primary.disabled) return;
    invoked = true;
    primary.disabled = true;
    primary.setAttribute("aria-busy", "true");
    primary.textContent = model.i18n.t(PENDING_KEYS[action]);
    // Promise.resolve(callback()) evaluates callback first, allowing a
    // synchronous host error to escape the DOM event handler. Preserve the
    // immediate callback invocation while explicitly converting that error to
    // the same promise path as an asynchronous rejection.
    let primaryResult: Promise<void> | void;
    try {
      primaryResult = actions.onPrimary(model.taskActionRevision);
    } catch (error) {
      primaryResult = Promise.reject(
        error instanceof Error ? error : new Error("task-primary-failed"),
      );
    }
    void Promise.resolve(primaryResult)
      .catch(() => undefined)
      .finally(() => {
        if (!primary.isConnected) return;
        invoked = false;
        primary.disabled = externallyPending;
        primary.setAttribute("aria-busy", externallyPending ? "true" : "false");
        primary.textContent = model.i18n.t(
          externallyPending ? PENDING_KEYS[action] : actionLabelKey,
        );
      });
  });
  card.append(primary);

  const active = model.hybrid?.active;
  if (active !== undefined) {
    const batch = progressBatchFor(model);
    const currentGroupLabel = batch === undefined
      ? null
      : active.groups.find((group) => group.groupKey === batch.currentGroupKey)?.label ?? null;
    const progress = renderVerificationProgress(doc, {
      active,
      ...(batch === undefined ? {} : { batch }),
      busy: model.hybrid?.executionActive === true,
      currentGroupLabel,
      detailsOpen,
      i18n: model.i18n,
    });
    progress.addEventListener("toggle", (event) => {
      const target = event.target;
      // `instanceof HTMLDetailsElement` is realm-specific. Embedded Obsidian
      // documents can dispatch the native event from a different window.
      if (
        target !== null
        && typeof target === "object"
        && (target as { tagName?: unknown }).tagName === "DETAILS"
        && (target as HTMLDetailsElement).open
      ) actions.onOpenDetails();
    }, true);
    card.append(progress);
  }

  root.append(card);
};
