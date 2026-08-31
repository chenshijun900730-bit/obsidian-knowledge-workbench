import type { App, Modal } from "obsidian";
import { normalizeCatalogScanRoot } from "../catalog/catalog-path";
import { LARGE_CATALOG_RUN_BUDGET } from "../catalog/hybrid-catalog-types";
import {
  validateCloudDirectorySelection,
  type CloudDirectoryPickerPurpose,
  type CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
} from "../i18n/workbench-i18n";

export interface CatalogLargeScanConfirmationGroup {
  readonly groupKey: string;
  readonly rootRelativePath: string;
  readonly label: string;
  readonly pdfCount: number;
}

export interface CatalogLargeScanConfirmationRequest {
  readonly kind: "start" | "resume";
  readonly cloudRoot: string;
  readonly groups: readonly CatalogLargeScanConfirmationGroup[];
  readonly directorySelection?: CloudDirectorySelection;
}

export interface CatalogLargeScanConfirmationPresenter {
  request(input: CatalogLargeScanConfirmationRequest): Promise<boolean>;
}

export type CatalogLargeScanModalConstructor = abstract new (app: App) => Modal;

const GROUP_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;

const checkedRequest = (
  input: CatalogLargeScanConfirmationRequest,
): CatalogLargeScanConfirmationRequest => {
  if (
    (input.kind !== "start" && input.kind !== "resume")
    || (input.kind === "start" && (
      input.groups.length < 1
      || input.groups.length > LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups
    ))
    || (input.kind === "resume" && (
      input.groups.length !== 0
      || input.directorySelection !== undefined
    ))
  ) throw new RangeError("invalid-large-catalog-selection");
  const seen = new Set<string>();
  const groups = input.groups.map((group) => {
    const label = group.label.normalize("NFC").trim();
    if (
      !GROUP_PATTERN.test(group.groupKey)
      || seen.has(group.groupKey)
      || typeof group.rootRelativePath !== "string"
      || label.length === 0
      || /\p{Cc}/u.test(label)
      || !Number.isSafeInteger(group.pdfCount)
      || group.pdfCount < 1
    ) throw new RangeError("invalid-large-catalog-selection");
    seen.add(group.groupKey);
    return {
      groupKey: group.groupKey,
      rootRelativePath: group.rootRelativePath,
      label,
      pdfCount: group.pdfCount,
    };
  });
  const cloudRoot = normalizeCatalogScanRoot(input.cloudRoot);
  if (input.kind === "resume") return { kind: "resume", cloudRoot, groups: [] };
  const purpose: CloudDirectoryPickerPurpose = {
    kind: "verification",
    groups: groups.map(({ groupKey, rootRelativePath, label }) => ({
      groupKey,
      rootRelativePath,
      label,
    })),
  };
  try {
    validateCloudDirectorySelection({
      kind: "directory",
      selectedPath: cloudRoot,
      effectiveRoot: cloudRoot,
    }, purpose);
  } catch {
    throw new RangeError("invalid-large-catalog-selection");
  }
  let directorySelection: CloudDirectorySelection | undefined;
  if (input.directorySelection !== undefined) {
    try {
      directorySelection = validateCloudDirectorySelection(input.directorySelection, purpose);
    } catch {
      throw new RangeError("invalid-large-catalog-selection");
    }
    if (directorySelection.effectiveRoot !== cloudRoot) {
      throw new RangeError("invalid-large-catalog-selection");
    }
    if (
      directorySelection.kind === "category"
      && (
        groups.length !== 1
        || groups[0]?.groupKey !== directorySelection.groupKey
      )
    ) throw new RangeError("invalid-large-catalog-selection");
  }
  return {
    kind: "start",
    cloudRoot,
    groups,
    ...(directorySelection === undefined ? {} : { directorySelection }),
  };
};

export function createCatalogLargeScanConfirmationModalClass(
  ModalBase: CatalogLargeScanModalConstructor,
  getLocale: WorkbenchLocaleProvider = () => "en",
) {
  return class CatalogLargeScanConfirmationModal extends ModalBase
    implements CatalogLargeScanConfirmationPresenter {
    private result: Promise<boolean> | null = null;
    private settleResult: ((value: boolean) => void) | null = null;
    private requestValue: CatalogLargeScanConfirmationRequest | null = null;
    private settled = false;
    private opener: HTMLElement | null = null;

    request(input: CatalogLargeScanConfirmationRequest): Promise<boolean> {
      if (this.result !== null) return this.result;
      this.requestValue = checkedRequest(input);
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.result = new Promise((resolve) => { this.settleResult = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      const request = this.requestValue;
      if (request === null) throw new RangeError("invalid-large-catalog-selection");
      const i18n = createWorkbenchI18n(getLocale());
      this.setTitle(i18n.t(request.kind === "start"
        ? "verification.confirm.start.title"
        : "verification.confirm.resume.title"));
      const doc = this.contentEl.ownerDocument;
      this.contentEl.replaceChildren();
      this.contentEl.classList.add("knowledge-workbench__catalog-large-scan-confirmation");
      this.contentEl.addEventListener("keydown", this.handleKeydown);

      const scope = doc.createElement("p");
      scope.textContent = i18n.t(request.kind === "start"
        ? "verification.confirm.start.scope"
        : "verification.confirm.resume.scope", { root: request.cloudRoot });
      const structuredSummary: HTMLElement[] = [];
      if (request.kind === "start" && request.directorySelection !== undefined) {
        const selectedFolder = doc.createElement("p");
        selectedFolder.textContent = i18n.t("directoryField.selection.selected", {
          path: request.directorySelection.selectedPath,
        });
        const effectiveRoot = doc.createElement("p");
        effectiveRoot.textContent = i18n.t("directoryField.selection.effectiveRoot", {
          path: request.cloudRoot,
        });
        structuredSummary.push(selectedFolder, effectiveRoot);
        if (request.directorySelection.kind === "category") {
          const category = doc.createElement("p");
          category.textContent = i18n.t("directoryField.selection.category", {
            category: request.groups[0]?.label ?? "",
          });
          structuredSummary.push(category);
        }
      }
      const selection = doc.createElement("p");
      selection.textContent = request.kind === "start"
        ? i18n.t("verification.confirm.start.selection", {
          selected: i18n.number(request.groups.length),
          maximum: i18n.number(LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups),
          count: i18n.number(request.groups.reduce((sum, group) => sum + group.pdfCount, 0)),
        })
        : i18n.t("verification.confirm.resume.selection");
      const budget = doc.createElement("p");
      budget.textContent = i18n.t("verification.confirm.budget", {
        pdfs: i18n.number(LARGE_CATALOG_RUN_BUDGET.maxPdfCount),
        directories: i18n.number(LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount),
        requests: i18n.number(LARGE_CATALOG_RUN_BUDGET.maxListRequestCount),
        minutes: i18n.number(LARGE_CATALOG_RUN_BUDGET.maxDurationMs / 60_000),
      });
      const safety = doc.createElement("p");
      safety.textContent = i18n.t("verification.confirm.safety");
      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__modal-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel-large-catalog-verification";
      cancel.textContent = i18n.t("verification.confirm.cancel");
      cancel.addEventListener("click", () => this.finish(false));
      const confirm = doc.createElement("button");
      confirm.type = "button";
      confirm.dataset.action = request.kind === "start"
        ? "start-large-catalog-verification"
        : "resume-large-catalog-verification";
      confirm.textContent = i18n.t(request.kind === "start"
        ? "verification.confirm.start.action"
        : "verification.confirm.resume.action");
      confirm.addEventListener("click", () => this.finish(true));
      actions.append(cancel, confirm);
      this.contentEl.append(scope, ...structuredSummary, selection, budget, safety, actions);
      confirm.focus();
    }

    onClose(): void {
      this.contentEl.removeEventListener("keydown", this.handleKeydown);
      if (!this.settled) this.resolve(false);
      this.requestValue = null;
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }

    private readonly handleKeydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.finish(false);
    };

    private finish(value: boolean): void {
      this.resolve(value);
      this.close();
    }

    private resolve(value: boolean): void {
      if (this.settled) return;
      this.settled = true;
      this.settleResult?.(value);
      this.settleResult = null;
    }
  };
}
