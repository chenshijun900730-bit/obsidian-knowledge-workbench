// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { ChangePlanService } from "../../src/plans/change-plan-service";
import { createChangePreviewModalClass, type ModalConstructor } from "../../src/ui/change-preview-modal";
import { FakeVault } from "../fakes/fake-vault";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
  type RuntimeSafetyPolicy,
} from "../../src/runtime/safety-policy";
import type { WorkbenchLocale } from "../../src/i18n/workbench-i18n";
import { SuggestionService } from "../../src/suggestions/suggestion-service";
import { suggestionFixture } from "../helpers/suggestion-fixtures";

class ModalSurface {
  readonly contentEl = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  readonly titleEl = document.createElementNS("http://www.w3.org/1999/xhtml", "h2") as HTMLHeadingElement;
  closed = false;

  constructor(readonly app: App) {}
  setTitle(title: string): this { this.titleEl.textContent = title; return this; }
  open(): void { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
  close(): void { this.closed = true; this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
  onOpen(): void {}
  onClose(): void {}
}

const createModal = (
  service: ChangePlanService,
  policy: RuntimeSafetyPolicy = NORMAL_RUNTIME_POLICY,
  locale: WorkbenchLocale = "en",
) => {
  const Concrete = createChangePreviewModalClass(
    ModalSurface as unknown as ModalConstructor,
    policy,
    () => locale,
  );
  return new Concrete({} as App, service);
};

describe("ChangePreviewModal", () => {
  it.each(["zh-CN", "en"] as const)(
    "preserves an AI-assisted rationale that collides with a built-in sentinel in %s",
    async (locale) => {
      const suggestion = new SuggestionService(() => ({
        source: "ai-assisted",
        summary: "Review move",
      })).generate(suggestionFixture().input).suggestions[0]!;
      const operation = suggestion.operation;
      const sourcePath = "sourcePath" in operation ? operation.sourcePath : operation.path;
      const service = new ChangePlanService(FakeVault.withNotes([sourcePath]), () => true);
      const preview = await service.preview(
        [operation],
        [],
        { [operation.id]: suggestion.rationale },
        { [operation.id]: suggestion.localRationale },
      );
      const modal = createModal(service, NORMAL_RUNTIME_POLICY, locale);
      const result = modal.request(preview);

      expect(modal.contentEl.textContent).toContain("Review move");
      expect(modal.contentEl.textContent).not.toContain("Review the move");
      expect(modal.contentEl.textContent).not.toContain("检查移动操作");
      modal.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await expect(result).resolves.toBeNull();
    },
  );

  it.each([
    ["zh-CN", "预览整理更改", "确认所选更改", "取消", "检查移动操作"],
    ["en", "Preview organization changes", "Confirm selected changes", "Cancel", "Review the move"],
  ] as const)("renders confirmation, ARIA, disabled state, and Escape in %s", async (
    locale,
    title,
    confirmLabel,
    cancelLabel,
    rationaleLabel,
  ) => {
    const service = new ChangePlanService(FakeVault.withNotes(["原文/Keep.md"]), () => true);
    const preview = await service.preview([{
      id: "move",
      kind: "move",
      sourcePath: "原文/Keep.md",
      targetPath: "Archive/Keep.md",
    }]);
    const modal = createModal(service, NORMAL_RUNTIME_POLICY, locale);
    const result = modal.request(preview);
    expect(modal.titleEl.textContent).toBe(title);
    expect(modal.contentEl.querySelector('[role="group"]')?.getAttribute("aria-label")).toBeTruthy();
    expect(modal.contentEl.textContent).toContain(confirmLabel);
    expect(modal.contentEl.textContent).toContain(cancelLabel);
    expect(modal.contentEl.textContent).toContain(rationaleLabel);
    expect(modal.contentEl.textContent).toContain("原文/Keep.md");
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.disabled).toBe(true);
    modal.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(result).resolves.toBeNull();
  });

  it("keeps acceptance previews visible but unreachable from every confirmation path", async () => {
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    const confirm = vi.spyOn(service, "confirm");
    const preview = await service.preview([
      { id: "a", kind: "move", sourcePath: "a.md", targetPath: "archive/a.md" },
    ]);
    const modal = createModal(service, READ_ONLY_ACCEPTANCE_POLICY);
    const result = modal.request(preview);

    expect(modal.titleEl.textContent).toBe("Change plan preview (read-only)");
    expect(modal.contentEl.textContent).toContain("a.md → archive/a.md");
    expect(modal.contentEl.textContent).toContain("Preview only. This build cannot confirm or execute changes.");
    expect(modal.contentEl.classList.contains("knowledge-workbench__change-preview--read-only")).toBe(true);
    const unavailable = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
    expect(unavailable.type).toBe("button");
    expect(unavailable.textContent).toBe("Confirmation unavailable");
    expect(unavailable.disabled).toBe(true);
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>('input[value="a"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(unavailable.disabled).toBe(true);
    unavailable.disabled = false;
    unavailable.click();
    modal.contentEl.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(confirm).not.toHaveBeenCalled();
    modal.cancel();
    await expect(result).resolves.toBeNull();
  });

  it("returns false for acceptance sample review without opening or retaining modal state", async () => {
    const service = new ChangePlanService(FakeVault.withNotes([]), () => true);
    const modal = createModal(service, READ_ONLY_ACCEPTANCE_POLICY);
    const open = vi.spyOn(modal, "open");

    await expect(modal.requestSample()).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(modal.contentEl.isConnected).toBe(false);
    expect(modal.contentEl.childElementCount).toBe(0);

    const preview = await service.preview([]);
    const result = modal.request(preview);
    expect(open).toHaveBeenCalledOnce();
    modal.cancel();
    await expect(result).resolves.toBeNull();
  });

  it("renders operations and updates selection-aware conflicts, affected count, and confirmation", async () => {
    const vault = FakeVault.withNotes(["blocked.md", "safe.md", "linked.md"]);
    vault.setInboundLinks("blocked.md", ["linked.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([
      { id: "blocked", kind: "move", sourcePath: "blocked.md", targetPath: "archive/blocked.md" },
      { id: "safe", kind: "move", sourcePath: "safe.md", targetPath: "archive/safe.md" },
    ], [], {
      blocked: { source: "local", summary: "Blocked move", signals: ["folder-rule"], confidence: "high", impact: 70 },
      safe: { source: "local", summary: "Safe move", signals: ["folder-rule"], confidence: "high", impact: 70 },
    });
    const modal = createModal(service);
    const result = modal.request(preview);
    expect(modal.contentEl.textContent).toContain("blocked.md → archive/blocked.md");
    expect(modal.contentEl.textContent).toContain("Blocked move");
    expect(modal.contentEl.textContent).toContain("Inbound links");
    expect(modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.disabled).toBe(true);
    expect(modal.contentEl.querySelector('[data-affected-count]')?.textContent).toContain("3");

    const blocked = modal.contentEl.querySelector<HTMLInputElement>('input[value="blocked"]')!;
    blocked.checked = false;
    blocked.dispatchEvent(new Event("change", { bubbles: true }));
    expect(modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.disabled).toBe(false);
    expect(modal.contentEl.querySelector('[data-affected-count]')?.textContent).toContain("1");
    expect(modal.contentEl.textContent).not.toContain("Inbound links");
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
    await expect(result).resolves.toMatchObject({ operations: [{ id: "safe" }] });
  });

  it("disables confirm with no selection and cancels on Escape while restoring focus", async () => {
    const trigger = document.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
    document.body.append(trigger);
    trigger.focus();
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    const preview = await service.preview([{ id: "a", kind: "move", sourcePath: "a.md", targetPath: "archive/a.md" }]);
    const modal = createModal(service);
    const result = modal.request(preview);
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>('input[value="a"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.disabled).toBe(true);
    modal.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("shows a relock error without closing", async () => {
    let enabled = true;
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => enabled);
    const preview = await service.preview([{ id: "a", kind: "move", sourcePath: "a.md", targetPath: "archive/a.md" }]);
    const modal = createModal(service);
    const result = modal.request(preview);
    enabled = false;
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain("The selected changes could not be confirmed");
    expect(modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.disabled).toBe(true);
    expect((modal as unknown as ModalSurface).closed).toBe(false);
    modal.cancel();
    await expect(result).resolves.toBeNull();
  });

  it.each(["zh-CN", "en"] as const)("never renders runtime confirmation detail in %s", async (locale) => {
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    const preview = await service.preview([{
      id: "a",
      kind: "move",
      sourcePath: "a.md",
      targetPath: "archive/a.md",
    }]);
    vi.spyOn(service, "confirm").mockRejectedValue(new Error("SECRET-RUNTIME-DETAIL"));
    const modal = createModal(service, NORMAL_RUNTIME_POLICY, locale);
    const result = modal.request(preview);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.contentEl.textContent).not.toContain("SECRET-RUNTIME-DETAIL");
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    modal.cancel();
    await expect(result).resolves.toBeNull();
  });

  it("uses a non-executable sample mode and requires explicit acknowledgement", async () => {
    const service = new ChangePlanService(FakeVault.withNotes([]), () => false);
    const modal = createModal(service);
    const result = modal.requestSample();
    expect(modal.contentEl.textContent).toContain("Example/Untitled.md");
    expect(modal.contentEl.querySelectorAll('[data-operation-id]')).toHaveLength(0);
    const acknowledge = modal.contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const confirm = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="acknowledge"]')!;
    expect(confirm.disabled).toBe(true);
    acknowledge.checked = true;
    acknowledge.dispatchEvent(new Event("change", { bubbles: true }));
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await expect(result).resolves.toBe(true);
  });
});
