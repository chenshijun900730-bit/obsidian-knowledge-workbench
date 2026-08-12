import type { App, Modal } from "obsidian";
import type { AiAction } from "../core/ports";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";
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

const AI_ACTION_KEYS = {
  summarize: "ai.action.summarize",
  "name-cluster": "ai.action.nameCluster",
  "explain-relation": "ai.action.explainRelation",
  "suggest-labels": "ai.action.suggestLabels",
} as const satisfies Record<AiAction, WorkbenchMessageKey>;

export function createAiPayloadPreviewModalClass(
  ModalBase: AiPreviewModalConstructor,
  getLocale: WorkbenchLocaleProvider = () => "en",
) {
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
      const i18n = createWorkbenchI18n(getLocale());
      this.setTitle(i18n.t("ai.preview.title"));
      const doc = this.contentEl.ownerDocument;
      const summary = doc.createElement("p");
      summary.textContent = i18n.t("ai.preview.summary", {
        action: i18n.t(AI_ACTION_KEYS[preview.action]),
        origin: preview.endpointOrigin,
        count: i18n.number(preview.noteCount),
        characters: i18n.number(preview.approximateCharacters),
      });
      const paths = doc.createElement("ul");
      for (const path of preview.paths) {
        const item = doc.createElement("li");
        item.textContent = path;
        paths.append(item);
      }
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = "cancel";
      cancel.textContent = i18n.t("ai.preview.cancel");
      cancel.addEventListener("click", () => this.finish(false));
      const confirm = doc.createElement("button");
      confirm.type = "button";
      confirm.dataset.action = "confirm";
      confirm.textContent = i18n.t("ai.preview.confirm");
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
