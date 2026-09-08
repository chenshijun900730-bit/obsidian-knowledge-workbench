// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type {
  HybridCatalogGroupViewModel,
  HybridCatalogViewModel,
} from "../../src/catalog/hybrid-catalog-runtime";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import type {
  LibraryPrimaryAction,
  LibraryWorkflowKind,
  LibraryWorkflowState,
} from "../../src/ui/library-workflow-state";
import { renderTaskPage, type TaskPageModel } from "../../src/ui/task-page";
import {
  TEST_HYBRID_ACTIVE_AUTHORITY,
  TEST_INACTIVE_HYBRID_EXECUTION,
  TEST_LARGE_BATCH_AUTHORITY,
} from "../helpers/ui-fixtures";

const group = (suffix: string, label: string, pdfCount: number): HybridCatalogGroupViewModel => ({
  groupKey: `group:${suffix.repeat(64)}`,
  rootRelativePath: label,
  label,
  pdfCount,
  mode: "recursive",
  verificationStatus: "unverified",
});

const literature = group("1", "文学", 252);
const language = group("2", "语言文字", 1_192);

const PRESENTATION: Readonly<Record<LibraryWorkflowKind, readonly [LibraryPrimaryAction, string]>> = {
  "needs-txt": ["choose-txt", "选择目录 TXT"],
  "confirm-txt-import": ["import-txt", "导入目录"],
  "needs-connection": ["open-connection", "连接"],
  "needs-library": ["choose-library", "选择书库"],
  ready: ["start", "开始检查"],
  running: ["pause", "暂停"],
  paused: ["resume", "继续检查"],
  "repair-connection": ["open-connection", "重新连接"],
  "repair-library": ["choose-library", "重新选择书库"],
  "retry-later": ["retry", "稍后继续"],
  complete: ["open-library", "去文库搜索"],
  unavailable: ["open-library", "去文库搜索"],
};

const workflow = (kind: LibraryWorkflowKind): LibraryWorkflowState => ({
  kind,
  primaryAction: PRESENTATION[kind][0],
  titleKey: `workflow.${kind === "needs-txt" ? "needsTxt" : kind === "confirm-txt-import" ? "confirmTxtImport" : kind === "needs-connection" ? "needsConnection" : kind === "needs-library" ? "needsLibrary" : kind === "repair-connection" ? "repairConnection" : kind === "repair-library" ? "repairLibrary" : kind === "retry-later" ? "retryLater" : kind}.title`,
  descriptionKey: `workflow.${kind === "needs-txt" ? "needsTxt" : kind === "confirm-txt-import" ? "confirmTxtImport" : kind === "needs-connection" ? "needsConnection" : kind === "needs-library" ? "needsLibrary" : kind === "repair-connection" ? "repairConnection" : kind === "repair-library" ? "repairLibrary" : kind === "retry-later" ? "retryLater" : kind}.description`,
  recommendedGroup: kind === "ready" ? literature : null,
  canShowTechnicalDetails: ["running", "paused", "retry-later"].includes(kind),
});

const batch = {
  ...TEST_LARGE_BATCH_AUTHORITY,
  batchId: "batch-task-page",
  status: "paused" as const,
  stopReason: "user-canceled" as const,
  resumeAvailable: true,
  runOrdinal: 2,
  remainingGroupCount: 2,
  pdfCount: 250,
  directoryCount: 10,
  ignoredFileCount: 0,
  listRequestCount: 4,
  cumulativeListRequestCount: 12,
  selectedGroupCount: 2,
  selectedGroupKeys: [literature.groupKey, language.groupKey],
  completedGroupCount: 0,
  currentGroupIndex: 0,
  currentGroupKey: literature.groupKey,
  committedPdfCount: 100,
  committedPageCount: 1,
  completedDirectoryCount: 2,
  pendingDirectoryCount: 8,
  autoResumeState: "inactive" as const,
  autoSegmentIndex: 2,
  autoSegmentLimit: 12,
};

const hybrid = (executionActive = false): HybridCatalogViewModel => ({
  ...TEST_INACTIVE_HYBRID_EXECUTION,
  executionActive,
  status: executionActive ? "scanning" : "paused",
  active: {
    ...TEST_HYBRID_ACTIVE_AUTHORITY,
    importedAt: 1,
    pdfCount: 1_444,
    unverifiedCount: 1_444,
    verifiedCount: 0,
    differenceCount: 0,
    cloudMissingCount: 0,
    groupCount: 2,
    verifiedGroupCount: 0,
    coveredCandidatePdfCount: 100,
    groups: [literature, language],
  },
  batch: { ...batch, status: executionActive ? "scanning" : "paused" },
});

const model = (
  kind: LibraryWorkflowKind,
  overrides: Partial<TaskPageModel> = {},
): TaskPageModel => ({
  i18n: createWorkbenchI18n("zh-CN"),
  workflow: workflow(kind),
  boundLibraryPath: "/合成父目录/科学文库",
  visibleGroupScope: kind === "ready" ? [literature] : [],
  taskActionRevision: 7,
  actionPending: false,
  pauseRequested: false,
  ...overrides,
});

const render = (value: TaskPageModel, onPrimary = vi.fn()): HTMLDivElement => {
  const root = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  renderTaskPage(root, value, {
    onPrimary,
    onChooseDifferentCategory: vi.fn(),
    onOpenDetails: vi.fn(),
  });
  return root;
};

const visibleTextOutsideTechnicalDetails = (root: HTMLElement): string => (
  Array.from(root.querySelectorAll<HTMLElement>("*")).flatMap((element) => {
    if (element.closest("[data-technical-details]")) return [];
    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "");
  }).join(" ")
);

const TECHNICAL_TERMS = /API\s*(?:父目录|parent)|运行片段|\bsegment\b|列表请求|list\s+request|检查点|\bcheckpoint\b/iu;

describe("task page", () => {
  for (const kind of Object.keys(PRESENTATION) as LibraryWorkflowKind[]) {
    it(`renders one primary action for ${kind}`, () => {
      const root = render(model(kind));
      const actions = root.querySelectorAll<HTMLButtonElement>("[data-task-primary]");
      expect(actions).toHaveLength(1);
      expect(actions[0]?.textContent).toBe(PRESENTATION[kind][1]);
      expect(actions[0]?.disabled).toBe(false);
    });
  }

  it("keeps the ready scope and safety boundary in the same visible card", () => {
    const root = render(model("ready"));
    const card = root.querySelector<HTMLElement>("[data-task-card]")!;
    expect(card.textContent).toContain("科学文库");
    expect(card.textContent).not.toContain("合成父目录");
    expect(card.textContent).toContain("文学");
    expect(card.textContent).toContain("252 本候选 PDF");
    expect(card.textContent).toContain("只读取目录信息，不下载 PDF，不修改笔记");
    expect(card.querySelector("[data-task-choose-category]")).not.toBeNull();
    expect(card.querySelector("[data-group-key]")).toBeNull();
  });

  it("shows an exact advanced scope and preserves checkpoint scope for paused work", () => {
    const advanced = render(model("ready", { visibleGroupScope: [literature, language] }));
    expect(advanced.textContent).toContain("文学、语言文字");
    expect(advanced.textContent).toContain("1,444 本候选 PDF");

    const paused = render(model("paused", {
      workflow: { ...workflow("paused"), recommendedGroup: group("3", "新推荐", 1) },
      visibleGroupScope: [literature, language],
      hybrid: hybrid(),
    }));
    expect(paused.textContent).toContain("文学、语言文字");
    expect(paused.textContent).not.toContain("新推荐");
    expect(paused.querySelector("[data-task-choose-category]")).toBeNull();
  });

  it("keeps Pause usable while the launch promise still owns pending state", () => {
    const root = render(model("running", {
      visibleGroupScope: [literature, language],
      hybrid: hybrid(true),
      actionPending: true,
    }));
    const primary = root.querySelector<HTMLButtonElement>("[data-task-primary]")!;
    expect(primary.textContent).toBe("暂停");
    expect(primary.disabled).toBe(false);
    expect(primary.getAttribute("aria-busy")).toBe("false");
  });

  it("shows controller-owned pending state and blocks double submission immediately", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const onPrimary = vi.fn(() => pending);
    const root = render(model("ready"), onPrimary);
    const primary = root.querySelector<HTMLButtonElement>("[data-task-primary]")!;
    primary.click();
    primary.click();
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(primary.textContent).toBe("正在开始…");
    expect(primary.getAttribute("aria-busy")).toBe("true");
    release();
    await pending;

    const rerendered = render(model("ready", { actionPending: true }));
    const persisted = rerendered.querySelector<HTMLButtonElement>("[data-task-primary]")!;
    expect(persisted.textContent).toBe("正在开始…");
    expect(persisted.disabled).toBe(true);
  });

  it("contains a synchronous primary error in the promise error path", async () => {
    const onPrimary = vi.fn(() => { throw new Error("host-failed"); });
    const root = render(model("ready"), onPrimary);
    document.body.append(root);
    const primary = root.querySelector<HTMLButtonElement>("[data-task-primary]")!;

    expect(() => primary.click()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onPrimary).toHaveBeenCalledWith(7);
    expect(primary.disabled).toBe(false);
    expect(primary.textContent).toBe("开始检查");
    root.remove();
  });

  it("handles an opened details event from an adopted document", () => {
    const onOpenDetails = vi.fn();
    const root = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    renderTaskPage(root, model("paused", {
      visibleGroupScope: [literature],
      hybrid: hybrid(),
    }), {
      onPrimary: vi.fn(),
      onChooseDifferentCategory: vi.fn(),
      onOpenDetails,
    });
    const progress = root.querySelector(".knowledge-workbench__verification-progress")!;
    const foreign = document.implementation.createHTMLDocument("foreign").createElement("details");
    const details = document.adoptNode(foreign);
    progress.append(details);
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));

    expect(onOpenDetails).toHaveBeenCalledOnce();
  });

  it("shows truthful coverage while keeping quota and request counts collapsed", () => {
    const root = render(model("paused", {
      visibleGroupScope: [literature, language],
      hybrid: hybrid(),
    }));
    const coverage = root.querySelector<HTMLProgressElement>("[data-verification-overall-progress]")!;
    expect(coverage.value).toBe(100);
    expect(coverage.max).toBe(1_444);
    const current = root.querySelector<HTMLElement>("[data-verification-current-progress]")!;
    expect(current.hasAttribute("aria-valuenow")).toBe(false);
    const details = root.querySelector<HTMLDetailsElement>("[data-verification-run-details]")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("[data-verification-segment-budget]")).not.toBeNull();
    expect(details.querySelector("[data-verification-run-requests]")?.textContent).toContain("12");
  });

  it("keeps the primary task action named and implementation details closed", () => {
    const root = render(model("paused", { hybrid: hybrid() }));
    const primary = root.querySelector<HTMLButtonElement>("[data-task-primary]")!;
    expect(primary.textContent?.trim()).toBeTruthy();
    expect(primary.dataset.focusKey).toBe("task-primary");
    expect(primary.getAttribute("aria-busy")).toBe("false");
    expect(root.querySelector<HTMLDetailsElement>("[data-verification-run-details]")?.open).toBe(false);
  });

  it("marks the optional category action with a stable focus key", () => {
    const root = render(model("ready"));
    expect(root.querySelector<HTMLElement>("[data-task-choose-category]")?.dataset.focusKey)
      .toBe("task-choose-category");
  });

  it.each(["zh-CN", "en"] as const)("isolates technical copy in closed details for %s", (locale) => {
    const root = render(model("paused", {
      i18n: createWorkbenchI18n(locale),
      hybrid: hybrid(),
    }));
    const details = root.querySelector<HTMLDetailsElement>(
      "[data-verification-run-details][data-technical-details]",
    )!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent?.trim()).toBeTruthy();
    expect(details.textContent).toMatch(TECHNICAL_TERMS);
    expect(visibleTextOutsideTechnicalDetails(root)).not.toMatch(TECHNICAL_TERMS);
  });
});
