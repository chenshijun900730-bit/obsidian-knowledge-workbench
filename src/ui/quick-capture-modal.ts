import type { App, Modal } from "obsidian";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
} from "../i18n/workbench-i18n";

export interface QuickCaptureRequest {
  request(): Promise<string | null>;
  cancel(): void;
  dispose(): void;
}

export interface ModalConstructor {
  new (app: App): Modal;
}

export function createQuickCaptureModalClass(
  ModalBase: ModalConstructor,
  getLocale: WorkbenchLocaleProvider = () => "en",
) {
  return class QuickCaptureModal extends ModalBase implements QuickCaptureRequest {
    private result: Promise<string | null> | null = null;
    private settleResult: ((value: string | null) => void) | null = null;
    private settled = false;
    private opener: HTMLElement | null = null;

    request(): Promise<string | null> {
      if (this.result === null) {
        this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
        this.result = new Promise((resolve) => { this.settleResult = resolve; });
        this.open();
      }
      return this.result;
    }

    onOpen(): void {
      const i18n = createWorkbenchI18n(getLocale());
      this.setTitle(i18n.t("quickCapture.title"));
      this.contentEl.replaceChildren();
      const form = this.contentEl.ownerDocument.createElement("form");
      form.className = "knowledge-workbench__capture-form";
      const label = this.contentEl.ownerDocument.createElement("label");
      label.textContent = i18n.t("quickCapture.field.title");
      const input = this.contentEl.ownerDocument.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.required = true;
      label.append(input);
      const actions = this.contentEl.ownerDocument.createElement("div");
      actions.className = "knowledge-workbench__item-actions";
      const cancel = this.contentEl.ownerDocument.createElement("button");
      cancel.type = "button";
      cancel.textContent = i18n.t("quickCapture.cancel");
      cancel.addEventListener("click", () => this.cancel());
      const create = this.contentEl.ownerDocument.createElement("button");
      create.type = "submit";
      create.textContent = i18n.t("quickCapture.create");
      actions.append(cancel, create);
      form.append(label, actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const title = input.value.trim();
        if (title.length === 0) return;
        if (this.settle(title)) this.close();
      });
      form.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        this.cancel();
      });
      this.contentEl.append(form);
      input.focus();
    }

    onClose(): void {
      this.settle(null);
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }

    cancel(): void {
      if (this.settle(null)) this.close();
    }

    dispose(): void {
      this.cancel();
    }

    private settle(value: string | null): boolean {
      if (this.settled) return false;
      this.settled = true;
      this.settleResult?.(value);
      this.settleResult = null;
      return true;
    }
  };
}
