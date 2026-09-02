// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { NORMAL_RUNTIME_POLICY, READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";
import { renderStartPage } from "../../src/ui/start-page";
import type { WorkbenchRoute } from "../../src/ui/workbench-route";
import { noOpWorkbenchActions, populatedWorkbenchModel } from "../helpers/ui-fixtures";

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

describe("start page", () => {
  it("keeps Today, Map, suggestions, and Quick Capture under Start", () => {
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    renderStartPage(root, {
      model: {
        ...model,
        locale: "zh-CN",
        startSection: "overview",
        catalog: {
          ...model.catalog,
          status: "ready",
          source: "unified",
          pdfCount: 68_959,
          verificationCounts: {
            unverified: 68_707, verified: 252, difference: 0, cloudMissing: 0,
          },
        },
      },
      actions: noOpWorkbenchActions(),
      policy: NORMAL_RUNTIME_POLICY,
    });

    expect(root.textContent).toContain("统一目录 · 68,959 本 PDF");
    expect(root.textContent).toContain("68,959 本可搜索 PDF");
    expect(root.textContent).toContain("已核验 252 · 待核验 68,707 · 差异 0");
    expect(root.textContent).not.toContain("Unified catalog");
    expect(root.textContent).not.toContain("searchable PDFs");
    expect(root.textContent).not.toContain("verified");
    expect(root.querySelector('[aria-label="今日"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="知识地图"]')).not.toBeNull();
    expect(root.querySelector('[data-start-section="suggestions"]')).not.toBeNull();
    expect(root.querySelector('[data-action="quick-capture"]')).not.toBeNull();
  });

  it("routes catalog search and verification recommendations through shell navigation", () => {
    const root = createTestDiv();
    const selected: WorkbenchRoute[] = [];
    renderStartPage(root, {
      model: populatedWorkbenchModel(),
      actions: noOpWorkbenchActions({ onSelectRoute: (route) => selected.push(route) }),
      policy: NORMAL_RUNTIME_POLICY,
    });

    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "搜索检查")?.click();
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "云端核验")?.click();
    expect(selected).toEqual([
      { tab: "library" },
      { tab: "task", page: "overview" },
    ]);
  });

  it("keeps suggestion preview callbacks and read-only guards when switching sections", () => {
    const root = createTestDiv();
    const preview = vi.fn();
    const quickCapture = vi.fn();
    const model = populatedWorkbenchModel();
    const suggestion = {
      operation: {
        id: "start-suggestion",
        kind: "set-owned-field" as const,
        path: "Notes/Alpha.md",
        field: "knowledge-workbench-kind" as const,
        before: { present: false } as const,
        after: { present: true, value: "note" } as const,
      },
      localRationale: { source: "local" as const, summary: "Synthetic", signals: [], confidence: "high" as const, impact: 80 },
      rationale: { source: "local" as const, summary: "Synthetic", signals: [], confidence: "high" as const, impact: 80 },
    };
    renderStartPage(root, {
      model: { ...model, startSection: "suggestions", suggestions: [suggestion] },
      actions: noOpWorkbenchActions({ onPreviewSuggestionIds: preview, onQuickCapture: quickCapture }),
      policy: READ_ONLY_ACCEPTANCE_POLICY,
    });

    const selected = root.querySelector<HTMLInputElement>('input[value="start-suggestion"]')!;
    selected.checked = true;
    selected.dispatchEvent(new Event("change", { bubbles: true }));
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "预览所选")?.click();
    expect(preview).toHaveBeenCalledWith(["start-suggestion"]);
    expect(root.querySelector('[data-action="quick-capture"]')).toBeNull();
    expect(quickCapture).not.toHaveBeenCalled();
  });
});
