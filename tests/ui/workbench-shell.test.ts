// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { renderWorkbenchShell } from "../../src/ui/workbench-shell";

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

describe("workbench shell", () => {
  it("renders exactly five fixed-left destinations in Chinese", () => {
    const root = createTestDiv();
    const selected: string[] = [];
    renderWorkbenchShell(root, {
      activePage: "workbench",
      i18n: createWorkbenchI18n("zh-CN"),
      connectionStatus: "authorized",
      onSelectPage: (page) => selected.push(page),
      onSetLocale: () => undefined,
    });
    expect(Array.from(root.querySelectorAll("[data-workbench-page]"))
      .map((node) => node.textContent?.trim())).toEqual([
      "开始", "我的目录", "云端核验", "操作记录", "设置",
    ]);
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(root.querySelector('[data-workbench-sidebar="true"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-workbench-page="cloud-catalog"]')!.click();
    expect(selected).toEqual(["cloud-catalog"]);
  });

  it("moves focus vertically without moving the sidebar to the top", () => {
    const root = createTestDiv();
    document.body.append(root);
    renderWorkbenchShell(root, {
      activePage: "workbench",
      i18n: createWorkbenchI18n("zh-CN"),
      connectionStatus: "authorized",
      onSelectPage: () => undefined,
      onSetLocale: () => undefined,
    });
    const first = root.querySelector<HTMLButtonElement>('[data-workbench-page="workbench"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("cloud-catalog");
    root.remove();
  });

  it("wraps ArrowUp without selecting a page", () => {
    const root = createTestDiv();
    const selected: string[] = [];
    document.body.append(root);
    renderWorkbenchShell(root, {
      activePage: "workbench",
      i18n: createWorkbenchI18n("zh-CN"),
      connectionStatus: "authorized",
      onSelectPage: (page) => selected.push(page),
      onSetLocale: () => undefined,
    });
    const first = root.querySelector<HTMLButtonElement>('[data-workbench-page="workbench"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("settings");
    expect(selected).toEqual([]);
    root.remove();
  });
});
