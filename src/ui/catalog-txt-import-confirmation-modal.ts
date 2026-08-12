import type { App, Modal } from "obsidian";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  type CatalogTxtImportSummary,
} from "../catalog/hybrid-catalog-types";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
} from "../i18n/workbench-i18n";

export interface CatalogTxtImportConfirmationPresenter {
  request(summary: CatalogTxtImportSummary): Promise<boolean>;
}

export type CatalogTxtImportModalConstructor = abstract new (app: App) => Modal;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const validSummary = (summary: CatalogTxtImportSummary): boolean => (
  HASH_PATTERN.test(summary.sourceSha256)
  && Number.isSafeInteger(summary.byteSize)
  && summary.byteSize > 0
  && summary.byteSize <= CATALOG_TXT_IMPORT_BUDGET.maxBytes
  && Number.isSafeInteger(summary.nonEmptyLineCount)
  && summary.nonEmptyLineCount > 0
  && summary.nonEmptyLineCount <= CATALOG_TXT_IMPORT_BUDGET.maxNonEmptyLineCount
  && Number.isSafeInteger(summary.pdfCount)
  && summary.pdfCount > 0
  && summary.pdfCount <= CATALOG_TXT_IMPORT_BUDGET.maxPdfCount
  && Number.isSafeInteger(summary.directoryCount)
  && summary.directoryCount >= 0
  && Number.isSafeInteger(summary.ignoredLeafCount)
  && summary.ignoredLeafCount >= 0
  && Number.isSafeInteger(summary.normalizedWhitespaceCount)
  && summary.normalizedWhitespaceCount >= 0
  && Number.isSafeInteger(summary.maxDepth)
  && summary.maxDepth > 0
  && summary.maxDepth <= CATALOG_TXT_IMPORT_BUDGET.maxDepth
);

export function createCatalogTxtImportConfirmationModalClass(
  ModalBase: CatalogTxtImportModalConstructor,
  getLocale: WorkbenchLocaleProvider = () => "en",
) {
  return class CatalogTxtImportConfirmationModal extends ModalBase
    implements CatalogTxtImportConfirmationPresenter {
    private result: Promise<boolean> | null = null;
    private settleResult: ((value: boolean) => void) | null = null;
    private summary: CatalogTxtImportSummary | null = null;
    private settled = false;
    private opener: HTMLElement | null = null;

    request(summary: CatalogTxtImportSummary): Promise<boolean> {
      if (this.result !== null) return this.result;
      if (!validSummary(summary)) throw new RangeError("invalid-catalog-txt-summary");
      this.summary = { ...summary };
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.result = new Promise((resolve) => { this.settleResult = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      const summary = this.summary;
      if (summary === null) throw new RangeError("invalid-catalog-txt-summary");
      const i18n = createWorkbenchI18n(getLocale());
      this.setTitle(i18n.t("catalog.confirm.txt.title"));
      const doc = this.contentEl.ownerDocument;
      this.contentEl.replaceChildren();
      this.contentEl.classList.add("knowledge-workbench__catalog-txt-confirmation");
      this.contentEl.addEventListener("keydown", this.handleKeydown);

      const pdfs = doc.createElement("p");
      pdfs.textContent = i18n.t("catalog.confirm.txt.pdfs", {
        current: i18n.number(summary.pdfCount),
        maximum: i18n.number(CATALOG_TXT_IMPORT_BUDGET.maxPdfCount),
      });
      const directories = doc.createElement("p");
      directories.textContent = i18n.t("catalog.confirm.txt.directories", {
        count: i18n.number(summary.directoryCount),
      });
      const ignored = doc.createElement("p");
      ignored.textContent = i18n.t("catalog.confirm.txt.ignored", {
        count: i18n.number(summary.ignoredLeafCount),
      });
      const source = doc.createElement("p");
      source.textContent = i18n.t("catalog.confirm.txt.source", {
        bytes: i18n.number(summary.byteSize),
        lines: i18n.number(summary.nonEmptyLineCount),
        depth: i18n.number(summary.maxDepth),
      });
      const safety = doc.createElement("p");
      safety.textContent = i18n.t("catalog.confirm.txt.safety");
      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__modal-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel-catalog-txt-import";
      cancel.textContent = i18n.t("catalog.confirm.txt.cancel");
      cancel.addEventListener("click", () => this.finish(false));
      const confirm = doc.createElement("button");
      confirm.type = "button";
      confirm.dataset.action = "confirm-catalog-txt-import";
      confirm.textContent = i18n.t("catalog.confirm.txt.import");
      confirm.addEventListener("click", () => this.finish(true));
      actions.append(cancel, confirm);
      this.contentEl.append(pdfs, directories, ignored, source, safety, actions);
      confirm.focus();
    }

    onClose(): void {
      this.contentEl.removeEventListener("keydown", this.handleKeydown);
      if (!this.settled) this.resolve(false);
      this.summary = null;
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
