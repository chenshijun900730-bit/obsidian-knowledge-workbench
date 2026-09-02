import { describe, expect, it } from "vitest";
import {
  defaultWorkbenchRoute,
  routeForTab,
  sameWorkbenchRoute,
  type WorkbenchRoute,
  type WorkbenchTab,
} from "../../src/ui/workbench-route";

describe("workbench route", () => {
  it("defaults to the library without a subpage", () => {
    expect(defaultWorkbenchRoute()).toEqual({ tab: "library" });
  });

  it("maps exactly three shell tabs to their legal overview routes", () => {
    const tabs = ["library", "task", "more"] as const satisfies readonly WorkbenchTab[];

    expect(tabs.map((tab) => routeForTab(tab))).toEqual([
      { tab: "library" },
      { tab: "task", page: "overview" },
      { tab: "more", page: "overview" },
    ]);
  });

  it("compares both the tab and the legal subpage", () => {
    const routes: readonly WorkbenchRoute[] = [
      { tab: "library" },
      { tab: "task", page: "overview" },
      { tab: "task", page: "folder-selection" },
      { tab: "task", page: "category-selection" },
      { tab: "more", page: "overview" },
      { tab: "more", page: "connection" },
      { tab: "more", page: "catalog-data" },
      { tab: "more", page: "language" },
      { tab: "more", page: "history" },
      { tab: "more", page: "knowledge-tools" },
      { tab: "more", page: "advanced" },
    ];

    for (const route of routes) {
      expect(sameWorkbenchRoute(route, { ...route })).toBe(true);
    }
    expect(sameWorkbenchRoute(
      { tab: "task", page: "overview" },
      { tab: "task", page: "folder-selection" },
    )).toBe(false);
    expect(sameWorkbenchRoute(
      { tab: "task", page: "overview" },
      { tab: "more", page: "overview" },
    )).toBe(false);
    expect(sameWorkbenchRoute({ tab: "library" }, { tab: "more", page: "overview" })).toBe(false);
  });
});
