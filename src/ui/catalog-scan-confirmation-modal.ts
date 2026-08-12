import type { App, Modal } from "obsidian";
import { normalizeCloudAbsolutePath } from "../catalog/catalog-path";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
} from "../i18n/workbench-i18n";

export interface CatalogScanConfirmationPresenter {
  request(rootPath: string): Promise<boolean>;
}

export type CatalogScanModalConstructor = abstract new (app: App) => Modal;

export function createCatalogScanConfirmationModalClass(
  ModalBase: CatalogScanModalConstructor,
  getLocale: WorkbenchLocaleProvider = () => "en",
) {
  return class CatalogScanConfirmationModal extends ModalBase implements CatalogScanConfirmationPresenter {
    private result: Promise<boolean> | null = null;
    private settleResult: ((value: boolean) => void) | null = null;
    private rootPath = "/";
    private settled = false;
    private opener: HTMLElement | null = null;

    request(rootPath: string): Promise<boolean> {
      if (this.result !== null) return this.result;
      this.rootPath = normalizeCloudAbsolutePath(rootPath);
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.result = new Promise((resolve) => { this.settleResult = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      const i18n = createWorkbenchI18n(getLocale());
      this.setTitle(i18n.t("catalog.confirm.scan.title"));
      const doc = this.contentEl.ownerDocument;
      this.contentEl.replaceChildren();
      this.contentEl.classList.add("knowledge-workbench__catalog-scan-confirmation");
      this.contentEl.addEventListener("keydown", this.handleKeydown);
      const scope = doc.createElement("p");
      scope.textContent = i18n.t("catalog.confirm.scan.scope", { path: this.rootPath });
      const noDownload = doc.createElement("p");
      noDownload.textContent = i18n.t("catalog.confirm.scan.noDownload");
      const preservation = doc.createElement("p");
      preservation.textContent = i18n.t("catalog.confirm.scan.preservation");
      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__modal-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel-catalog-scan";
      cancel.textContent = i18n.t("catalog.confirm.scan.cancel");
      cancel.addEventListener("click", () => this.finish(false));
      const start = doc.createElement("button");
      start.type = "button";
      start.dataset.action = "start-catalog-scan";
      start.textContent = i18n.t("catalog.confirm.scan.start");
      start.addEventListener("click", () => this.finish(true));
      actions.append(cancel, start);
      this.contentEl.append(scope, noDownload, preservation, actions);
      start.focus();
    }

    onClose(): void {
      this.contentEl.removeEventListener("keydown", this.handleKeydown);
      if (!this.settled) this.resolve(false);
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
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
