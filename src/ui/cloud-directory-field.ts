import type { WorkbenchI18n } from "../i18n/workbench-i18n";
import type { CloudDirectorySelection } from "../catalog/cloud-directory-selection";

export interface CloudDirectoryFieldModel {
  readonly path: string;
  readonly selection?: CloudDirectorySelection;
  readonly disabled: boolean;
  readonly locked: boolean;
}

export interface CloudDirectoryFieldActions {
  readonly onChoose: () => Promise<CloudDirectorySelection | null>;
  readonly onSelection: (selection: CloudDirectorySelection) => void;
  readonly onManualChange: (value: string) => void;
  readonly onValidate: (value: string) => string;
}

export interface CloudDirectoryFieldSurface {
  readonly root: HTMLElement;
  readonly manualInput: HTMLInputElement;
  readonly chooseButton: HTMLButtonElement;
  readonly valid: () => boolean;
  setPath(path: string): void;
  updateState(state: Readonly<{ disabled: boolean; locked: boolean }>): void;
  dispose(): void;
}

const directoryName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
let fieldSequence = 0;

export function createCloudDirectoryField(
  document: Document,
  i18n: WorkbenchI18n,
  model: CloudDirectoryFieldModel,
  actions: CloudDirectoryFieldActions,
): CloudDirectoryFieldSurface {
  const fieldOrdinal = ++fieldSequence;
  const eventController = new AbortController();
  let draft = model.path;
  let directorySelection = model.selection === undefined
    ? null
    : structuredClone(model.selection);
  let disabled = model.disabled;
  let locked = model.locked;
  let disposed = false;
  let chooseGeneration = 0;
  let choosePending = false;

  const root = document.createElement("section");
  root.className = "knowledge-workbench__directory-field";
  root.dataset.cloudDirectoryField = "true";
  const idFor = (offset: number): string => root.className + String((fieldOrdinal * 3) + offset);

  const current = document.createElement("article");
  current.className = "knowledge-workbench__directory-field-current";
  current.dataset.cloudDirectoryCurrent = "true";
  const currentTitle = document.createElement("strong");
  currentTitle.id = idFor(0);
  currentTitle.textContent = i18n.t("directoryField.current.title");
  current.setAttribute("aria-labelledby", currentTitle.id);
  const currentBody = document.createElement("div");
  currentBody.className = "knowledge-workbench__directory-field-identity";
  current.append(currentTitle, currentBody);

  const storage = document.createElement("p");
  storage.className = "knowledge-workbench__directory-field-storage";
  storage.textContent = i18n.t("directoryField.storage");

  const actionsRow = document.createElement("div");
  actionsRow.className = "knowledge-workbench__directory-field-actions";
  const chooseButton = document.createElement("button");
  chooseButton.type = "button";
  chooseButton.textContent = i18n.t("directoryField.choose");
  actionsRow.append(chooseButton);

  const advanced = document.createElement("details");
  advanced.className = "knowledge-workbench__directory-field-advanced";
  advanced.dataset.cloudDirectoryAdvanced = "true";
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = i18n.t("directoryField.advanced");
  const manualLabel = document.createElement("label");
  manualLabel.className = "knowledge-workbench__directory-field-manual";
  const manualText = document.createElement("span");
  manualText.textContent = i18n.t("directoryField.manual.label");
  const manualInput = document.createElement("input");
  manualInput.type = "text";
  manualInput.autocomplete = "off";
  manualInput.setAttribute("aria-required", "true");
  manualInput.placeholder = i18n.t("directoryField.manual.placeholder");
  manualInput.value = draft;
  manualLabel.append(manualText, manualInput);
  const validateButton = document.createElement("button");
  validateButton.type = "button";
  validateButton.dataset.action = "validate-cloud-directory";
  validateButton.textContent = i18n.t("directoryField.manual.validate");
  const validation = document.createElement("p");
  validation.className = "knowledge-workbench__directory-field-validation";
  validation.dataset.cloudDirectoryValidation = "true";
  validation.id = idFor(1);
  validation.setAttribute("role", "status");
  validation.setAttribute("aria-live", "polite");
  validation.setAttribute("aria-atomic", "true");
  advanced.append(advancedSummary, manualLabel, validateButton, validation);

  const lockedMessage = document.createElement("p");
  lockedMessage.className = "knowledge-workbench__directory-field-locked";
  lockedMessage.id = idFor(2);
  lockedMessage.textContent = i18n.t("directoryField.locked");
  lockedMessage.hidden = !locked;
  root.append(current, storage, actionsRow, advanced, lockedMessage);

  let cachedInput: string | undefined;
  let cachedNormalized = "";
  const normalized = (value: string): string => {
    if (value === cachedInput) return cachedNormalized;
    cachedInput = value;
    cachedNormalized = "";
    if (value.trim().length === 0 || value === "/") return cachedNormalized;
    try {
      const result = actions.onValidate(value);
      if (typeof result === "string" && result.length > 0 && result !== "/") {
        cachedNormalized = result;
      }
    } catch {
      // The field exposes one fixed localized validation state, never runtime details.
    }
    return cachedNormalized;
  };
  const valid = (): boolean => !disposed && normalized(draft).length > 0;

  const safeSelection = (value: CloudDirectorySelection): CloudDirectorySelection | null => {
    try {
      const selectedPath = actions.onValidate(value.selectedPath);
      const effectiveRoot = actions.onValidate(value.effectiveRoot);
      if (value.kind === "directory") {
        if (selectedPath !== effectiveRoot) return null;
        return { kind: "directory", selectedPath, effectiveRoot };
      }
      if (
        value.kind !== "category"
        || typeof value.groupKey !== "string"
        || value.groupKey.length === 0
        || selectedPath === effectiveRoot
      ) return null;
      return {
        kind: "category",
        selectedPath,
        effectiveRoot,
        groupKey: value.groupKey,
      };
    } catch {
      return null;
    }
  };

  const render = (message?: "failed"): void => {
    const safeDraft = normalized(draft);
    currentBody.replaceChildren();
    if (safeDraft.length === 0) {
      const empty = document.createElement("p");
      empty.className = "knowledge-workbench__directory-field-empty";
      empty.textContent = i18n.t("directoryField.current.empty");
      currentBody.append(empty);
    } else {
      const name = document.createElement("strong");
      name.className = "knowledge-workbench__directory-field-name";
      name.dataset.cloudDirectoryName = "true";
      name.textContent = directoryName(safeDraft);
      const path = document.createElement("p");
      path.className = "knowledge-workbench__directory-field-path";
      path.dataset.cloudDirectoryPath = "true";
      path.textContent = safeDraft;
      const state = document.createElement("span");
      state.className = "knowledge-workbench__directory-field-state";
      state.textContent = i18n.t("directoryField.current.selectedSession");
      currentBody.append(name, path, state);
      if (directorySelection !== null) {
        const selectedPath = document.createElement("p");
        selectedPath.className = "knowledge-workbench__directory-field-path";
        selectedPath.dataset.cloudDirectorySelectedPath = "true";
        selectedPath.textContent = i18n.t("directoryField.selection.selected", {
          path: directorySelection.selectedPath,
        });
        currentBody.append(selectedPath);
        if (directorySelection.kind === "category") {
          const effectiveRoot = document.createElement("p");
          effectiveRoot.className = "knowledge-workbench__directory-field-path";
          effectiveRoot.dataset.cloudDirectoryEffectiveRoot = "true";
          effectiveRoot.textContent = i18n.t("directoryField.selection.effectiveRoot", {
            path: directorySelection.effectiveRoot,
          });
          const category = document.createElement("p");
          category.dataset.cloudDirectoryCategory = directorySelection.groupKey;
          category.textContent = i18n.t("directoryField.selection.category", {
            category: directorySelection.groupKey,
          });
          currentBody.append(effectiveRoot, category);
        }
      }
    }
    const unavailable = disabled || locked;
    chooseButton.disabled = unavailable || choosePending;
    manualInput.disabled = unavailable;
    manualInput.setAttribute(
      "aria-invalid",
      draft.length > 0 && safeDraft.length === 0 ? "true" : "false",
    );
    validateButton.disabled = unavailable;
    lockedMessage.hidden = !locked;
    manualInput.setAttribute(
      "aria-describedby",
      locked ? `${validation.id} ${lockedMessage.id}` : validation.id,
    );
    if (locked) chooseButton.setAttribute("aria-describedby", lockedMessage.id);
    else chooseButton.removeAttribute("aria-describedby");
    if (message === "failed") {
      validation.textContent = i18n.t("directoryField.choose.failed");
    } else if (draft.length === 0) {
      validation.textContent = "";
    } else {
      validation.textContent = i18n.t(safeDraft.length > 0
        ? "directoryField.validation.valid"
        : "directoryField.validation.invalid");
    }
  };

  manualInput.addEventListener("input", () => {
    if (disposed || disabled || locked) return;
    if (choosePending) {
      chooseGeneration += 1;
      choosePending = false;
    }
    draft = manualInput.value;
    directorySelection = null;
    actions.onManualChange(draft);
    render();
  }, { signal: eventController.signal });

  validateButton.addEventListener("click", () => {
    if (disposed || disabled || locked) return;
    if (manualInput.value !== draft) {
      draft = manualInput.value;
      actions.onManualChange(draft);
    }
    render();
  }, { signal: eventController.signal });

  chooseButton.addEventListener("click", () => {
    if (disposed || disabled || locked || choosePending) return;
    const generation = ++chooseGeneration;
    choosePending = true;
    render();
    let failed = false;
    let choice: Promise<CloudDirectorySelection | null>;
    try {
      choice = actions.onChoose();
    } catch {
      choosePending = false;
      render("failed");
      return;
    }
    void choice.then((value) => {
      if (disposed || generation !== chooseGeneration || disabled || locked || value === null) return;
      const safeValue = safeSelection(value);
      if (safeValue === null) {
        failed = true;
        return;
      }
      try {
        actions.onSelection(structuredClone(safeValue));
      } catch {
        failed = true;
        return;
      }
      directorySelection = safeValue;
      draft = safeValue.effectiveRoot;
      manualInput.value = safeValue.effectiveRoot;
      if (!disposed && generation === chooseGeneration) render();
    }).catch(() => {
      failed = true;
    }).finally(() => {
      if (disposed || generation !== chooseGeneration) return;
      choosePending = false;
      render(failed ? "failed" : undefined);
    });
  }, { signal: eventController.signal });

  const surface: CloudDirectoryFieldSurface = {
    root,
    manualInput,
    chooseButton,
    valid,
    setPath(path: string): void {
      if (disposed) return;
      if (path !== draft && choosePending) {
        chooseGeneration += 1;
        choosePending = false;
      }
      draft = path;
      directorySelection = null;
      manualInput.value = path;
      render();
    },
    updateState(state): void {
      if (disposed) return;
      const availabilityChanged = disabled !== state.disabled || locked !== state.locked;
      disabled = state.disabled;
      locked = state.locked;
      if (availabilityChanged && choosePending) {
        chooseGeneration += 1;
        choosePending = false;
      }
      render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      chooseGeneration += 1;
      choosePending = false;
      eventController.abort();
      draft = "";
      manualInput.value = "";
      root.replaceChildren();
    },
  };
  render();
  return surface;
}
