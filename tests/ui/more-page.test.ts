// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { renderMorePage } from "../../src/ui/more-page";

const createRoot = (): HTMLDivElement => document.createElement("div");

describe("More summary", () => {
  it("keeps concise summary rows and routes each row once", () => {
    const root = createRoot();
    const onSelectRoute = vi.fn();

    renderMorePage(root, {
      locale: "zh-CN",
      connectionStatus: "authorized",
      rememberedLibrary: "/科学文库",
      activeCatalogCount: 68_959,
      openAtStartup: false,
      onSelectRoute,
    });

    expect(root.textContent).toContain("连接");
    expect(root.textContent).toContain("已记住的书库");
    expect(root.textContent).toContain("68,959");
    expect(root.textContent).toContain("语言与启动");
    expect(root.textContent).toContain("笔记改动");
    expect(root.textContent).toContain("高级功能");
    const actions = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
    expect(actions).toHaveLength(6);
    actions[0]?.click();
    expect(onSelectRoute).toHaveBeenCalledWith({ tab: "more", page: "connection" });
    actions.at(-1)?.click();
    expect(onSelectRoute).toHaveBeenLastCalledWith({ tab: "more", page: "knowledge-tools" });
    expect(createWorkbenchI18n("zh-CN").t("history.title")).toBe("笔记改动");
  });
});
