import type { App, Modal } from "obsidian";
import type { AiAction } from "../core/ports";
export { renderAiSuggestion } from "./ai-suggestion";

export interface AiPayloadPreview {
  readonly action: AiAction;
  readonly endpointOrigin: string;
  readonly paths: readonly string[];
  readonly noteCount: number;
  readonly approximateCharacters: number;
}
export interface AiPayloadPreviewPresenter { request(preview: AiPayloadPreview): Promise<boolean> }
export type AiPreviewModalConstructor = abstract new (app: App) => Modal;

export function createAiPayloadPreviewModalClass(ModalBase: AiPreviewModalConstructor) {
  return class AiPayloadPreviewModal extends ModalBase implements AiPayloadPreviewPresenter {
    private preview: AiPayloadPreview | null = null;
    private result: Promise<boolean> | null = null;
    private settle: ((value: boolean) => void) | null = null;
    private settled = false;
    private opener: HTMLElement | null = null;

    request(preview: AiPayloadPreview): Promise<boolean> {
      if (this.result !== null) return this.result;
      this.preview = {
        action: preview.action,
        endpointOrigin: preview.endpointOrigin,
        paths: [...preview.paths],
        noteCount: preview.noteCount,
        approximateCharacters: preview.approximateCharacters,
      };
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.result = new Promise((resolve) => { this.settle = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      this.contentEl.replaceChildren();
      this.contentEl.addEventListener("keydown", this.handleEscape);
      const preview = this.preview;
      if (preview === null) return;
      this.setTitle("Confirm private AI payload");
      const doc = this.contentEl.ownerDocument;
      const summary = doc.createElement("p");
      summary.textContent = `Action: ${preview.action}; endpoint origin: ${preview.endpointOrigin}; ${preview.noteCount} notes; Approximate characters: ${preview.approximateCharacters}`;
      const paths = doc.createElement("ul");
      for (const path of preview.paths) {
        const item = doc.createElement("li");
        item.textContent = path;
        paths.append(item);
      }
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => this.finish(false));
      const confirm = doc.createElement("button");
      confirm.type = "button";
      confirm.dataset.action = "confirm";
      confirm.textContent = "Send selected note text";
      confirm.addEventListener("click", () => this.finish(true));
      this.contentEl.append(summary, paths, cancel, confirm);
      cancel.focus();
    }

    onClose(): void {
      this.contentEl.removeEventListener("keydown", this.handleEscape);
      if (!this.settled) this.resolve(false);
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }

    private finish(value: boolean): void {
      this.resolve(value);
      this.close();
    }

    private resolve(value: boolean): void {
      if (this.settled) return;
      this.settled = true;
      this.settle?.(value);
      this.settle = null;
    }

    private readonly handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.finish(false);
    };
  };
}
