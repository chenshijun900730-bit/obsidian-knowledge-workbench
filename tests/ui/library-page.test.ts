// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type {
  CatalogDisplayItem,
  CloudCatalogViewModel,
} from "../../src/catalog/cloud-catalog-runtime";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../../src/catalog/hybrid-catalog-types";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import {
  renderLibraryPage,
  type LibraryPageActions,
  type LibraryPageModel,
} from "../../src/ui/library-page";
import type {
  LibraryPrimaryAction,
  LibraryWorkflowKind,
  LibraryWorkflowState,
} from "../../src/ui/library-workflow-state";

const record = (id: string, filename = `${id}.pdf`): CatalogDisplayItem => ({
  catalogId: id,
  filename,
  pathLabel: `/合成目录/${filename}`,
  cloudPathAvailable: true,
  verificationStatus: "verified",
  differenceKinds: [],
  hierarchyTags: ["folder/合成目录"],
});

const catalog = (overrides: Partial<CloudCatalogViewModel> = {}): CloudCatalogViewModel => ({
  status: "ready",
  source: "unified",
  snapshotCompletedAt: 1_723_000_000_000,
  pdfCount: 68_959,
  verificationCounts: {
    unverified: 57_000,
    verified: 11_959,
    difference: 0,
    cloudMissing: 0,
  },
  query: "",
  folderPrefix: "",
  verificationStatuses: [],
  differenceKinds: [],
  topLevelGroupId: "",
  hierarchyTag: "",
  includeCloudMissing: false,
  groups: [],
  hierarchyTags: [],
  page: 0,
  pageSize: 50,
  total: 2,
  items: [record("book-1", "第一本.pdf"), record("book-2", "第二本.pdf")],
  ...overrides,
});

const PRESENTATION = {
  "needs-txt": ["choose-txt", "workflow.needsTxt.title", "workflow.needsTxt.description"],
  "confirm-txt-import": ["import-txt", "workflow.confirmTxtImport.title", "workflow.confirmTxtImport.description"],
  "needs-connection": ["open-connection", "workflow.needsConnection.title", "workflow.needsConnection.description"],
  "needs-library": ["choose-library", "workflow.needsLibrary.title", "workflow.needsLibrary.description"],
  ready: ["start", "workflow.ready.title", "workflow.ready.description"],
  running: ["pause", "workflow.running.title", "workflow.running.description"],
  paused: ["resume", "workflow.paused.title", "workflow.paused.description"],
  "repair-connection": ["open-connection", "workflow.repairConnection.title", "workflow.repairConnection.description"],
  "repair-library": ["choose-library", "workflow.repairLibrary.title", "workflow.repairLibrary.description"],
  "retry-later": ["retry", "workflow.retryLater.title", "workflow.retryLater.description"],
  complete: ["open-library", "workflow.complete.title", "workflow.complete.description"],
  unavailable: ["open-library", "workflow.unavailable.title", "workflow.unavailable.description"],
} as const satisfies Record<
  LibraryWorkflowKind,
  readonly [LibraryPrimaryAction, LibraryWorkflowState["titleKey"], LibraryWorkflowState["descriptionKey"]]
>;

const workflow = (kind: LibraryWorkflowKind): LibraryWorkflowState => ({
  kind,
  primaryAction: PRESENTATION[kind][0],
  titleKey: PRESENTATION[kind][1],
  descriptionKey: PRESENTATION[kind][2],
  recommendedGroup: null,
  canShowTechnicalDetails: false,
});

const pageModel = (
  overrides: Partial<LibraryPageModel> = {},
): LibraryPageModel => ({
  catalog: catalog(),
  selectedCatalogId: null,
  recentItems: Array.from({ length: 6 }, (_, index) => ({
    catalogId: `recent-${index + 1}`,
    filename: `最近第 ${index + 1} 本.pdf`,
    directoryTag: `目录 ${index + 1}`,
  })),
  filtersExpanded: false,
  workflow: workflow("needs-txt"),
  i18n: createWorkbenchI18n("zh-CN"),
  ...overrides,
});

const actionFixture = (): LibraryPageActions & Readonly<{
  taskOpens: string[];
  detailOpens: string[];
  catalogEffects: string[];
}> => {
  const taskOpens: string[] = [];
  const detailOpens: string[] = [];
  const catalogEffects: string[] = [];
  return {
    taskOpens,
    detailOpens,
    catalogEffects,
    onOpenTask: () => taskOpens.push("task"),
    onOpenCatalogDetail: (catalogId) => detailOpens.push(catalogId),
    onSearchCatalog: (query) => catalogEffects.push(`search:${query}`),
    onFilterCatalogFolder: (prefix) => catalogEffects.push(`folder:${prefix}`),
    onToggleCatalogStatus: (status: CatalogVerificationStatus) => catalogEffects.push(`status:${status}`),
    onToggleCatalogDifference: (kind: CatalogDifferenceKind) => catalogEffects.push(`difference:${kind}`),
    onFilterCatalogGroup: (groupKey) => catalogEffects.push(`group:${groupKey}`),
    onFilterCatalogTag: (tag) => catalogEffects.push(`tag:${tag}`),
    onToggleCatalogCloudMissing: (include) => catalogEffects.push(`missing:${String(include)}`),
    onCatalogPage: (page) => catalogEffects.push(`page:${page}`),
    onCopyCatalogFilename: (catalogId) => catalogEffects.push(`filename:${catalogId}`),
    onCopyCatalogPath: (catalogId) => catalogEffects.push(`path:${catalogId}`),
    onOpenBaidu: () => catalogEffects.push("baidu"),
    onSelectCatalogRecord: (catalogId) => catalogEffects.push(`legacy-select:${catalogId}`),
    onSetCatalogFiltersExpanded: (expanded) => catalogEffects.push(`expanded:${String(expanded)}`),
  };
};

const render = (
  model = pageModel(),
  actions = actionFixture(),
) => {
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  document.body.append(root);
  renderLibraryPage(root, model, actions);
  return { root, actions };
};

afterEach(() => document.body.replaceChildren());

describe("library page", () => {
  it("renders a search-first Chinese library without technical task terms", () => {
    const opener = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
    document.body.append(opener);
    opener.focus();
    const { root, actions } = render();

    expect(root.querySelector("h1, h2, h3")?.textContent).toBe("在文库里找书");
    expect(root.querySelector("input, button, select, textarea")?.getAttribute(
      "data-catalog-search",
    )).toBe("true");
    expect(root.textContent).toContain("只搜索文件名和目录信息，不下载 PDF");
    expect(root.textContent).not.toMatch(/API\s*父目录|列表请求|检查点/iu);
    expect(document.activeElement).toBe(opener);
    expect(actions.catalogEffects).toEqual([]);

    const advanced = root.querySelector<HTMLDetailsElement>(
      '[data-catalog-advanced-filters="true"]',
    );
    expect(advanced?.open).toBe(false);
  });

  it("shows at most five detached recent items only for an empty query", () => {
    const { root, actions } = render();
    const recent = root.querySelector('[data-library-recent="true"]');
    expect(recent).not.toBeNull();
    expect(recent?.querySelectorAll('[data-library-recent-item]')).toHaveLength(5);
    expect(recent?.querySelector("button, input, select, textarea")).toBeNull();
    expect(recent?.textContent).toContain("最近第 1 本.pdf");
    expect(recent?.textContent).not.toContain("最近第 6 本.pdf");
    expect(actions.detailOpens).toEqual([]);

    const searched = render(pageModel({
      catalog: catalog({ query: "统计" }),
    }));
    expect(searched.root.querySelector('[data-library-recent="true"]')).toBeNull();
  });

  it("passes explicit result detail opens to the shared catalog renderer", () => {
    const { root, actions } = render();
    const detail = root.querySelector<HTMLElement>(
      '[data-action="open-catalog-detail"]',
    )!;

    detail.click();

    expect(actions.detailOpens).toEqual(["book-1"]);
    expect(actions.catalogEffects).not.toContain("legacy-select:book-1");
  });

  it.each([
    "needs-txt",
    "confirm-txt-import",
    "needs-connection",
    "needs-library",
    "ready",
    "running",
    "paused",
    "repair-connection",
    "repair-library",
    "retry-later",
  ] as const)("shows one inert-on-render task reminder for actionable %s", (kind) => {
    const { root, actions } = render(pageModel({ workflow: workflow(kind) }));
    const reminder = root.querySelector<HTMLElement>('[data-library-task-reminder="true"]')!;
    expect(reminder).not.toBeNull();
    expect(actions.taskOpens).toEqual([]);
    expect(actions.catalogEffects).toEqual([]);

    reminder.querySelector<HTMLButtonElement>('[data-action="open-library-task"]')!.click();

    expect(actions.taskOpens).toEqual(["task"]);
    expect(actions.catalogEffects).toEqual([]);
  });

  it.each(["complete", "unavailable"] as const)(
    "hides the task reminder for non-actionable %s",
    (kind) => {
      const { root } = render(pageModel({ workflow: workflow(kind) }));
      expect(root.querySelector('[data-library-task-reminder="true"]')).toBeNull();
    },
  );

  it("keeps empty and English states concise and safe", () => {
    const { root } = render(pageModel({
      catalog: catalog({ total: 0, items: [] }),
      recentItems: [],
      workflow: workflow("complete"),
      i18n: createWorkbenchI18n("en"),
    }));

    expect(root.querySelector("h1, h2, h3")?.textContent).toBe("Find a book in your library");
    expect(root.textContent).toContain("Searches filenames and directory information only");
    expect(root.textContent).toContain("No PDFs match");
    expect(root.textContent).not.toMatch(/API\s*parent|list request|checkpoint/iu);
    expect(root.querySelector('[data-library-recent="true"]')).toBeNull();
    expect(root.querySelector('[data-library-task-reminder="true"]')).toBeNull();
  });
});
