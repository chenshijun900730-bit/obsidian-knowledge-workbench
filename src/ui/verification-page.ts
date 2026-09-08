import type { CloudCatalogConnectionViewModel } from "../catalog/cloud-catalog-runtime";
import type { HybridCatalogViewModel } from "../catalog/hybrid-catalog-runtime";
import { LARGE_CATALOG_RUN_BUDGET } from "../catalog/hybrid-catalog-types";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";
import {
  isCatalogMessageCode,
  presentCatalogMessage,
  type CatalogMessageCode,
  type VerificationActionMessageCode,
} from "./catalog-message-presenter";
import { connectionCanVerify } from "./verification-connection-semantics";
import { normalizeCatalogScanRoot } from "../catalog/catalog-path";
import {
  createCloudDirectoryField,
} from "./cloud-directory-field";
import { renderVerificationProgress } from "./verification-progress";
import type { CloudDirectorySelection } from "../catalog/cloud-directory-selection";

export { connectionCanVerify } from "./verification-connection-semantics";

export interface VerificationPageActions {
  readonly onRootChange: (value: string) => void;
  readonly onToggleGroup: (groupKey: string) => void;
  readonly onStart: () => Promise<void>;
  readonly onResume: () => Promise<void>;
  readonly onCancel: () => void;
  readonly onBrowseRoot?: () => Promise<CloudDirectorySelection | null>;
  readonly onDirectorySelection: (selection: CloudDirectorySelection) => void;
}

export interface VerificationPageModel {
  readonly i18n: WorkbenchI18n;
  readonly rootPath: string;
  readonly directorySelection?: CloudDirectorySelection;
  readonly rootLocked: boolean;
  readonly selectedGroupKeys: readonly string[];
  readonly actionMessageCode?: VerificationActionMessageCode;
  readonly runDetailsOpen?: boolean;
  readonly connection?: CloudCatalogConnectionViewModel;
  readonly hybrid?: HybridCatalogViewModel;
  readonly actions: VerificationPageActions;
}

export interface VerificationPageSurface {
  dispose(): void;
}

export interface VerificationCategoryEditorModel {
  readonly i18n: WorkbenchI18n;
  readonly groups: NonNullable<HybridCatalogViewModel["active"]>["groups"];
  readonly selectedGroupKeys: readonly string[];
  readonly rootPath: string;
  /** The bound library API parent. A manual child path must never become actionable. */
  readonly expectedRootPath: string;
}

export interface VerificationCategoryEditorActions {
  readonly onSave: (input: Readonly<{
    rootPath: string;
    groupKeys: readonly string[];
  }>) => void;
  readonly onCancel: () => void;
}

const stateKey = (hybrid: HybridCatalogViewModel | undefined): WorkbenchMessageKey => {
  if (hybrid === undefined || hybrid.status === "unavailable") return "verification.state.unavailable";
  const status = hybrid.status;
  if (status === "scanning") return "verification.state.scanning";
  if (status === "paused") return "verification.state.paused";
  if (status === "partial" || status === "error") {
    return "verification.state.partial";
  }
  if (hybrid.active === undefined) {
    return "verification.state.empty";
  }
  return "verification.state.ready";
};

interface ResolvedViewMessage {
  readonly code: CatalogMessageCode;
  readonly source: "connection" | "capability" | "action" | "hybrid" | "batch";
}

const viewMessage = (model: VerificationPageModel): ResolvedViewMessage | undefined => {
  if (isCatalogMessageCode(model.connection?.messageCode)) {
    return { code: model.connection.messageCode, source: "connection" };
  }
  if (model.hybrid === undefined || model.connection === undefined) {
    return { code: "catalog-unavailable", source: "capability" };
  }
  if (!connectionCanVerify(model.connection)) {
    return {
      code: model.connection.status === "unconfigured"
        ? "credentials-unavailable"
        : "authorization-attempt-unavailable",
      source: "connection",
    };
  }
  if (model.actionMessageCode !== undefined) {
    return { code: model.actionMessageCode, source: "action" };
  }
  if (isCatalogMessageCode(model.hybrid.messageCode)) {
    return { code: model.hybrid.messageCode, source: "hybrid" };
  }
  const stopReason = model.hybrid.status === "paused" || model.hybrid.status === "partial"
    ? model.hybrid.batch?.stopReason
    : undefined;
  if (stopReason === "user-canceled") return { code: "verification-canceled", source: "batch" };
  if (isCatalogMessageCode(stopReason)) return { code: stopReason, source: "batch" };
  return undefined;
};

const renderMessage = (
  root: HTMLElement,
  code: CatalogMessageCode,
  i18n: WorkbenchI18n,
): HTMLElement => {
  const presentation = presentCatalogMessage(code, i18n);
  const article = root.ownerDocument.createElement("article");
  article.className = "knowledge-workbench__verification-message";
  article.dataset.catalogMessage = code;
  article.setAttribute("role", "status");
  const title = root.ownerDocument.createElement("h3");
  title.textContent = presentation.title;
  const preservation = root.ownerDocument.createElement("p");
  preservation.textContent = presentation.preservation;
  const nextAction = root.ownerDocument.createElement("p");
  nextAction.textContent = presentation.nextAction;
  article.append(title, preservation, nextAction);
  return article;
};

export const renderVerificationCategoryEditor = (
  root: HTMLElement,
  model: VerificationCategoryEditorModel,
  actions: VerificationCategoryEditorActions,
): VerificationPageSurface => {
  const doc = root.ownerDocument;
  const maximum = LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups;
  const available = new Set(model.groups.map((group) => group.groupKey));
  const initial = model.selectedGroupKeys.filter((key) => available.has(key)).slice(0, maximum);
  const selected = new Set(initial.length > 0
    ? initial
    : model.groups.length > 0 ? [model.groups[0]!.groupKey] : []);
  let disposed = false;
  let rootPath = model.rootPath;

  root.replaceChildren();
  root.className = "knowledge-workbench__category-page";
  const heading = doc.createElement("h2");
  heading.textContent = model.i18n.t("task.category.title");
  const hint = doc.createElement("p");
  hint.className = "knowledge-workbench__category-hint";
  hint.textContent = model.i18n.t("task.category.hint");
  root.append(heading, hint);

  const single = doc.createElement("fieldset");
  single.className = "knowledge-workbench__category-single";
  const legend = doc.createElement("legend");
  legend.textContent = model.i18n.t("task.category.single");
  single.append(legend);

  const radios = new Map<string, HTMLInputElement>();
  const checks = new Map<string, HTMLInputElement>();
  const sync = (): void => {
    const one = selected.size === 1 ? [...selected][0] : undefined;
    for (const [key, radio] of radios) radio.checked = key === one;
    for (const [key, check] of checks) {
      check.checked = selected.has(key);
      check.disabled = !check.checked && selected.size >= maximum;
    }
  };
  for (const group of model.groups) {
    const label = doc.createElement("label");
    const radio = doc.createElement("input");
    radio.type = "radio";
    radio.name = "knowledge-workbench-task-category";
    radio.value = group.groupKey;
    radio.dataset.taskCategoryRadio = group.groupKey;
    radio.addEventListener("change", () => {
      if (!radio.checked || disposed) return;
      selected.clear();
      selected.add(group.groupKey);
      sync();
    });
    const text = doc.createElement("span");
    text.textContent = model.i18n.t("verification.group.item", {
      label: group.label,
      count: model.i18n.number(group.pdfCount),
      status: model.i18n.t(`settings.status.${group.verificationStatus}`),
    });
    label.append(radio, text);
    single.append(label);
    radios.set(group.groupKey, radio);
  }
  root.append(single);

  const advanced = doc.createElement("details");
  advanced.className = "knowledge-workbench__category-advanced";
  advanced.dataset.taskCategoryAdvanced = "true";
  advanced.open = selected.size > 1;
  const advancedSummary = doc.createElement("summary");
  advancedSummary.textContent = model.i18n.t("task.category.advanced");
  const advancedHint = doc.createElement("p");
  advancedHint.textContent = model.i18n.t("task.category.advancedHint", { maximum });
  const pathLabel = doc.createElement("label");
  pathLabel.textContent = model.i18n.t("task.category.parent");
  const pathInput = doc.createElement("input");
  pathInput.type = "text";
  pathInput.value = rootPath;
  pathInput.dataset.taskCategoryRoot = "true";
  pathInput.addEventListener("input", () => { rootPath = pathInput.value; });
  pathLabel.append(pathInput);
  const multi = doc.createElement("div");
  multi.className = "knowledge-workbench__category-multiple";
  for (const group of model.groups) {
    const label = doc.createElement("label");
    const check = doc.createElement("input");
    check.type = "checkbox";
    check.dataset.taskCategoryCheck = group.groupKey;
    check.addEventListener("change", () => {
      if (disposed) return;
      if (check.checked) {
        if (selected.size < maximum) selected.add(group.groupKey);
      } else {
        selected.delete(group.groupKey);
      }
      sync();
    });
    const text = doc.createElement("span");
    text.textContent = model.i18n.t("verification.group.item", {
      label: group.label,
      count: model.i18n.number(group.pdfCount),
      status: model.i18n.t(`settings.status.${group.verificationStatus}`),
    });
    label.append(check, text);
    multi.append(label);
    checks.set(group.groupKey, check);
  }
  advanced.append(advancedSummary, advancedHint, pathLabel, multi);
  root.append(advanced);

  const error = doc.createElement("p");
  error.className = "knowledge-workbench__category-error";
  error.setAttribute("role", "status");
  const actionsRow = doc.createElement("div");
  actionsRow.className = "knowledge-workbench__category-actions";
  const back = doc.createElement("button");
  back.type = "button";
  back.dataset.focusKey = "task-category-cancel";
  back.textContent = model.i18n.t("task.category.cancel");
  back.addEventListener("click", actions.onCancel);
  const save = doc.createElement("button");
  save.type = "button";
  save.className = "mod-cta";
  save.dataset.taskCategorySave = "true";
  save.dataset.focusKey = "task-category-save";
  save.textContent = model.i18n.t("task.category.save");
  save.addEventListener("click", () => {
    if (disposed) return;
    if (selected.size === 0) {
      error.textContent = model.i18n.t("task.category.required");
      return;
    }
    try {
      if (
        normalizeCatalogScanRoot(rootPath)
        !== normalizeCatalogScanRoot(model.expectedRootPath)
      ) {
        error.textContent = model.i18n.t("task.category.parentInvalid");
        return;
      }
    } catch {
      error.textContent = model.i18n.t("task.category.parentInvalid");
      return;
    }
    actions.onSave({ rootPath, groupKeys: [...selected] });
  });
  actionsRow.append(back, save);
  root.append(error, actionsRow);
  sync();

  return {
    dispose(): void { disposed = true; },
  };
};

export function renderVerificationPage(
  root: HTMLElement,
  model: VerificationPageModel,
): VerificationPageSurface {
  const { i18n, actions } = model;
  const doc = root.ownerDocument;
  let disposed = false;
  let actionGeneration = 0;
  let actionPending = false;
  root.replaceChildren();
  root.className = "knowledge-workbench__verification-page";

  const heading = doc.createElement("h2");
  heading.textContent = i18n.t("verification.title");
  const state = doc.createElement("p");
  state.className = "knowledge-workbench__verification-state";
  state.textContent = i18n.t(stateKey(model.hybrid));
  root.append(heading, state);

  const messageHost = doc.createElement("div");
  messageHost.className = "knowledge-workbench__verification-message-host";
  const initialMessage = viewMessage(model);
  if (initialMessage !== undefined) {
    messageHost.append(renderMessage(root, initialMessage.code, i18n));
  }
  root.append(messageHost);

  const active = model.hybrid?.active;
  const activeGroupKeys = new Set(active?.groups.map((group) => group.groupKey) ?? []);
  const selected = new Set(model.selectedGroupKeys.filter((groupKey) => activeGroupKeys.has(groupKey)));
  const busy = model.hybrid?.status === "scanning";
  const authorized = connectionCanVerify(model.connection);
  const capabilityAvailable = model.hybrid !== undefined && model.hybrid.status !== "unavailable";
  const currentConnectionFault = initialMessage?.source === "connection"
    || initialMessage?.source === "capability";
  const batch = model.hybrid?.batch;
  let rootPathDraft = model.rootPath;
  const selectedCategoryIsRoot = (): boolean => {
    const rootLeaf = rootPathDraft.normalize("NFC").split("/").at(-1) ?? "";
    return active?.groups.some((group) => (
      group.groupKey !== "txt-root-items"
      && selected.has(group.groupKey)
      && group.label.normalize("NFC") === rootLeaf
    )) ?? false;
  };
  if (initialMessage === undefined && active !== undefined) {
    if (selected.size === 0) {
      messageHost.append(renderMessage(root, "verification-group-required", i18n));
    } else if (selectedCategoryIsRoot()) {
      messageHost.append(renderMessage(root, "invalid-large-catalog-root", i18n));
    }
  }
  const selectedPdfCount = active?.groups.reduce((total, group) => (
    selected.has(group.groupKey) ? total + group.pdfCount : total
  ), 0) ?? 0;
  const summary = doc.createElement("section");
  summary.className = "knowledge-workbench__verification-summary";
  const summaryTitle = doc.createElement("h3");
  summaryTitle.textContent = i18n.t("verification.summary.title");
  const scope = doc.createElement("p");
  scope.textContent = i18n.t(
    batch?.resumeAvailable === true
      ? "verification.summary.newScope"
      : "verification.summary.scope",
    {
    selected: i18n.number(selected.size),
    count: i18n.number(selectedPdfCount),
    },
  );
  const safety = doc.createElement("p");
  safety.className = "knowledge-workbench__verification-safety";
  safety.textContent = i18n.t("verification.safety");
  summary.append(summaryTitle, scope, safety);
  root.append(summary);

  const scopeEditor = doc.createElement("section");
  scopeEditor.className = "knowledge-workbench__verification-scope";
  let recomputeActions = (): void => undefined;
  const runAction = (action: () => Promise<void>): void => {
    if (disposed || actionPending) return;
    const generation = ++actionGeneration;
    actionPending = true;
    recomputeActions();
    void (async () => {
      try {
        await action();
      } catch {
        // The controller owns fixed user-facing failures.
      } finally {
        if (!disposed && generation === actionGeneration) {
          actionPending = false;
          recomputeActions();
        }
      }
    })();
  };
  const directoryField = createCloudDirectoryField(doc, i18n, {
    path: rootPathDraft,
    selection: model.directorySelection,
    disabled: busy,
    locked: model.rootLocked,
  }, {
    onChoose: actions.onBrowseRoot ?? (async () => null),
    onSelection: (selection) => {
      rootPathDraft = selection.effectiveRoot;
      actions.onDirectorySelection(selection);
      queueMicrotask(() => {
        if (!disposed) recomputeActions();
      });
    },
    onManualChange: (value) => {
      rootPathDraft = value;
      actions.onRootChange(value);
      recomputeActions();
    },
    onValidate: normalizeCatalogScanRoot,
  });
  directoryField.manualInput.dataset.verificationRoot = "true";
  directoryField.manualInput.dataset.focusKey = "verification-root";
  directoryField.chooseButton.dataset.action = "browse-verification-root";
  directoryField.chooseButton.dataset.focusKey = "verification-root-choose";
  if (actions.onBrowseRoot === undefined) {
    directoryField.chooseButton.hidden = true;
    directoryField.chooseButton.disabled = true;
  }
  const rootHint = doc.createElement("p");
  rootHint.textContent = i18n.t("verification.root.hint");
  scopeEditor.append(directoryField.root, rootHint);
  if (model.rootLocked) {
    const lockedHint = doc.createElement("p");
    lockedHint.className = "knowledge-workbench__verification-root-locked";
    lockedHint.textContent = i18n.t("verification.root.locked");
    scopeEditor.append(lockedHint);
  }

  const groupTitle = doc.createElement("h3");
  groupTitle.textContent = i18n.t("verification.groups.title", {
    maximum: LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups,
  });
  const choices = doc.createElement("div");
  choices.className = "knowledge-workbench__verification-groups";
  for (const group of active?.groups ?? []) {
    const label = doc.createElement("label");
    const choice = doc.createElement("input");
    choice.type = "checkbox";
    choice.checked = selected.has(group.groupKey);
    choice.disabled = busy || (!choice.checked && selected.size >= LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups);
    choice.dataset.groupKey = group.groupKey;
    choice.addEventListener("change", () => actions.onToggleGroup(group.groupKey));
    const text = doc.createElement("span");
    text.textContent = i18n.t("verification.group.item", {
      label: group.label,
      count: i18n.number(group.pdfCount),
      status: i18n.t(`settings.status.${group.verificationStatus}`),
    });
    label.append(choice, text);
    choices.append(label);
  }
  if (active === undefined) {
    const empty = doc.createElement("p");
    empty.className = "knowledge-workbench__empty";
    empty.textContent = i18n.t(stateKey(model.hybrid));
    choices.append(empty);
  }
  scopeEditor.append(groupTitle, choices);
  root.append(scopeEditor);

  if (active !== undefined && batch !== undefined) {
    const currentGroupLabel = active.groups.find(
      (group) => group.groupKey === batch.currentGroupKey,
    )?.label ?? null;
    const progressBatch = busy || currentConnectionFault
      ? { ...batch, stopReason: null }
      : batch;
    root.append(renderVerificationProgress(doc, {
      active,
      batch: progressBatch,
      busy,
      currentGroupLabel,
      detailsOpen: model.runDetailsOpen ?? false,
      i18n,
    }));
  }

  const actionRow = doc.createElement("div");
  actionRow.className = "knowledge-workbench__verification-actions";
  if (busy) {
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.dataset.action = "cancel-verification";
    cancel.textContent = i18n.t("verification.action.pause");
    cancel.addEventListener("click", () => {
      actions.onCancel();
      const requested = doc.createElement("p");
      requested.dataset.cancelRequested = "true";
      requested.setAttribute("role", "status");
      requested.textContent = i18n.t("verification.cancel.requested");
      messageHost.replaceChildren(requested);
    });
    actionRow.append(cancel);
  } else {
    const start = doc.createElement("button");
    start.type = "button";
    start.dataset.action = "start-verification";
    start.textContent = i18n.t("verification.action.start");
    const canStart = (): boolean => authorized
      && capabilityAvailable
      && !currentConnectionFault
      && active !== undefined
      && selected.size > 0
      && !selectedCategoryIsRoot()
      && directoryField.valid();
    start.addEventListener("click", () => {
      if (!canStart()) return;
      runAction(actions.onStart);
    });
    actionRow.append(start);
    let resume: HTMLButtonElement | null = null;
    if (batch?.resumeAvailable === true && authorized && capabilityAvailable) {
      resume = doc.createElement("button");
      resume.type = "button";
      resume.dataset.action = "resume-verification";
      resume.textContent = i18n.t("verification.action.resume");
      resume.addEventListener("click", () => {
        if (currentConnectionFault || !directoryField.valid()) return;
        runAction(actions.onResume);
      });
      actionRow.append(resume);
    }
    recomputeActions = () => {
      start.disabled = actionPending || !canStart();
      if (resume !== null) {
        resume.disabled = actionPending || currentConnectionFault || !directoryField.valid();
      }
    };
    recomputeActions();
  }
  root.append(actionRow);
  return {
    dispose(): void {
      disposed = true;
      actionGeneration += 1;
      actionPending = false;
      directoryField.dispose();
    },
  };
}
