import type { App, Modal } from "obsidian";
import { LARGE_CATALOG_RUN_BUDGET } from "../catalog/hybrid-catalog-types";
import {
  validateVerificationLaunchRequest,
  type VerificationLaunchGroup,
  type VerificationLaunchRequest,
  type VerificationLaunchSelectionValidator,
} from "../catalog/verification-launch-request";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
} from "../i18n/workbench-i18n";

export type CatalogLargeScanConfirmationGroup = VerificationLaunchGroup;
export type CatalogLargeScanConfirmationRequest = VerificationLaunchRequest;

export interface CatalogLargeScanConfirmationPresenter {
  request(input: CatalogLargeScanConfirmationRequest): Promise<boolean>;
}

export type CatalogLargeScanModalConstructor = abstract new (app: App) => Modal;

export function createCatalogLargeScanConfirmationModalClass(
  ModalBase: CatalogLargeScanModalConstructor,
  getLocale: WorkbenchLocaleProvider = () => "en",
  validateSelection?: VerificationLaunchSelectionValidator,
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
      this.requestValue = validateVerificationLaunchRequest(input, validateSelection);
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
        selectedFolder.textContent = i18n.t("verification.confirm.start.selectedFolder", {
          path: request.directorySelection.selectedPath,
        });
        const effectiveRoot = doc.createElement("p");
        effectiveRoot.textContent = i18n.t("verification.confirm.start.effectiveRoot", {
          path: request.cloudRoot,
        });
        structuredSummary.push(selectedFolder, effectiveRoot);
        if (request.directorySelection.kind === "category") {
          const category = doc.createElement("p");
          category.textContent = i18n.t("verification.confirm.start.category", {
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
