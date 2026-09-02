// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { renderWorkbenchShell } from "../../src/ui/workbench-shell";

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

describe("workbench shell", () => {
  it("renders exactly three fixed-left destinations in Chinese", () => {
    const root = createTestDiv();
    const selected: string[] = [];
    renderWorkbenchShell(root, {
      activePage: "library",
      i18n: createWorkbenchI18n("zh-CN"),
      connectionStatus: "authorized",
      onSelectPage: (page) => selected.push(page),
      onSetLocale: () => undefined,
    });
    expect(Array.from(root.querySelectorAll("[data-workbench-page]"))
      .map((node) => node.textContent?.trim())).toEqual(["文库", "任务", "更多"]);
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(root.querySelector('[data-workbench-sidebar="true"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-workbench-page="task"]')!.click();
    expect(selected).toEqual(["task"]);
  });

  it("moves and wraps focus across exactly three destinations without selecting", () => {
    const root = createTestDiv();
    const selected: string[] = [];
    document.body.append(root);
    renderWorkbenchShell(root, {
      activePage: "library",
      i18n: createWorkbenchI18n("zh-CN"),
      connectionStatus: "authorized",
      onSelectPage: (page) => selected.push(page),
      onSetLocale: () => undefined,
    });
    const first = root.querySelector<HTMLButtonElement>('[data-workbench-page="library"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("task");
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("more");
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("library");
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("more");
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("library");
    expect(selected).toEqual([]);
    root.remove();
  });

  it("keeps accessible names when narrow-mode CSS visually hides labels", () => {
    const root = createTestDiv();
    renderWorkbenchShell(root, {
      activePage: "task",
      i18n: createWorkbenchI18n("en"),
      connectionStatus: "authorized",
      onSelectPage: () => undefined,
      onSetLocale: () => undefined,
    });

    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-workbench-page]"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Library", "Task", "More",
    ]);
    expect(buttons.map((button) => button.querySelector(".knowledge-workbench__nav-label")?.textContent))
      .toEqual(["Library", "Task", "More"]);
    expect(root.querySelector('[data-workbench-page="task"]')?.getAttribute("aria-current"))
      .toBe("page");
  });
});
