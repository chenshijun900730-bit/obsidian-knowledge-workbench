// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  createAiPayloadPreviewModalClass,
  renderAiSuggestion as reexportedRenderAiSuggestion,
  type AiPreviewModalConstructor,
} from "../../src/ui/ai-payload-preview-modal";
import { renderAiSuggestion } from "../../src/ui/ai-suggestion";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";

class ModalSurface {
  readonly contentEl = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  readonly titleEl = document.createElementNS("http://www.w3.org/1999/xhtml", "h2") as HTMLHeadingElement;
  constructor(readonly app: App) {}
  setTitle(value: string): this { this.titleEl.textContent = value; return this; }
  open(): void { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
  close(): void { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
  onOpen(): void {}
  onClose(): void {}
}

describe("AI payload preview", () => {
  it.each([
    ["zh-CN", "确认私有 AI 请求内容", "发送所选笔记正文", "AI 建议"],
    ["en", "Confirm private AI payload", "Send selected note text", "AI suggestion"],
  ] as const)("renders the payload and result surfaces in %s without secret or error detail", (
    locale,
    title,
    confirmLabel,
    suggestionLabel,
  ) => {
    const Concrete = createAiPayloadPreviewModalClass(
      ModalSurface as unknown as AiPreviewModalConstructor,
      () => locale,
    );
    const modal = new Concrete({} as App);
    void modal.request({
      action: "summarize",
      endpointOrigin: "https://example.test",
      paths: ["原文/Keep-Name.md"],
      noteCount: 2,
      approximateCharacters: 1234,
    });
    expect(modal.titleEl.textContent).toBe(title);
    expect(modal.contentEl.textContent).toContain(confirmLabel);
    expect(modal.contentEl.textContent).toContain("原文/Keep-Name.md");
    expect(modal.contentEl.textContent).not.toContain("SECRET-RUNTIME-DETAIL");

    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    renderAiSuggestion(root, "model-output", createWorkbenchI18n(locale));
    expect(root.textContent).toContain(suggestionLabel);
  });

  it("settles on Escape exactly once and restores the invoking element's focus", async () => {
    const trigger = document.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
    trigger.textContent = "Open AI preview";
    document.body.append(trigger);
    trigger.focus();
    const Concrete = createAiPayloadPreviewModalClass(ModalSurface as unknown as AiPreviewModalConstructor);
    const modal = new Concrete({} as App);
    const result = modal.request({
      action: "summarize",
      endpointOrigin: "https://example.test",
      paths: ["Notes/A.md"],
      noteCount: 1,
      approximateCharacters: 10,
    });

    modal.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    const closedByEscape = !modal.contentEl.isConnected;
    if (!closedByEscape) modal.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await expect(result).resolves.toBe(false);
    expect(closedByEscape).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("shows metadata only and never receives bodies, secrets, or endpoint paths", async () => {
    const Concrete = createAiPayloadPreviewModalClass(ModalSurface as unknown as AiPreviewModalConstructor);
    const modal = new Concrete({} as App);
    const result = modal.request({
      action: "summarize",
      endpointOrigin: "https://example.test",
      paths: ["Notes/A.md", "Notes/B.md"],
      noteCount: 2,
      approximateCharacters: 1234,
    });
    expect(modal.contentEl.textContent).toContain("Summarize");
    expect(modal.contentEl.textContent).toContain("https://example.test");
    expect(modal.contentEl.textContent).toContain("Notes/A.md");
    expect(modal.contentEl.textContent).toContain("2 notes");
    expect(modal.contentEl.textContent).toContain("Approximate characters: 1,234");
    expect(modal.contentEl.textContent).not.toContain("/v1");
    expect(modal.contentEl.textContent).not.toContain("secret");
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    await expect(result).resolves.toBe(false);
  });

  it("renders hostile model output as text only under the exact label", () => {
    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    renderAiSuggestion(root, '<img src=x onerror="globalThis.pwned=true">');
    expect(root.textContent).toContain("AI suggestion");
    expect(root.textContent).toContain("<img");
    expect(root.querySelector("img")).toBeNull();
  });

  it("keeps the modal's renderer export as a compatibility alias", () => {
    expect(reexportedRenderAiSuggestion).toBe(renderAiSuggestion);
  });
});
