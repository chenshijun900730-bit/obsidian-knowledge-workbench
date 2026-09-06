// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type {
  CatalogDisplayItem,
  CloudCatalogViewModel,
} from "../../src/catalog/cloud-catalog-runtime";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../../src/catalog/hybrid-catalog-types";
import {
  renderCloudCatalogTab,
  type CloudCatalogTabActions,
} from "../../src/ui/cloud-catalog-tab";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { renderWorkbench } from "../../src/ui/workbench-view";
import { FakeCloudCatalogRuntime } from "../fakes/fake-cloud-catalog-runtime";
import {
  controllerFixture,
  noOpWorkbenchActions,
  populatedWorkbenchModel,
} from "../helpers/ui-fixtures";

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

const fileRecord = (index: number): CatalogDisplayItem => {
  const id = String(index + 1).padStart(6, "0");
  return {
    catalogId: `fs-${id}`,
    filename: `第${id}本.pdf`,
    pathLabel: `/统计/第${id}本.pdf`,
    cloudPathAvailable: true,
    verificationStatus: "verified",
    differenceKinds: [],
    hierarchyTags: [],
  };
};

const readyCatalog = (
  overrides: Partial<CloudCatalogViewModel> = {},
): CloudCatalogViewModel => ({
  status: "ready",
  source: "legacy",
  snapshotCompletedAt: 1_723_000_000_000,
  pdfCount: 100_000,
  verificationCounts: { unverified: 0, verified: 100_000, difference: 0, cloudMissing: 0 },
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
  total: 100_000,
  items: Array.from({ length: 50 }, (_, index) => fileRecord(index)),
  ...overrides,
});

const actionFixture = (): CloudCatalogTabActions & Readonly<{
  searches: string[];
  folders: string[];
  pages: number[];
  filenames: string[];
  paths: string[];
  statuses: CatalogVerificationStatus[];
  differences: CatalogDifferenceKind[];
  groups: string[];
  tags: string[];
  cloudMissing: boolean[];
  opened: string[];
  selections: string[];
  detailOpens: string[];
  expandedStates: boolean[];
}> => {
  const searches: string[] = [];
  const folders: string[] = [];
  const pages: number[] = [];
  const filenames: string[] = [];
  const paths: string[] = [];
  const statuses: CatalogVerificationStatus[] = [];
  const differences: CatalogDifferenceKind[] = [];
  const groups: string[] = [];
  const tags: string[] = [];
  const cloudMissing: boolean[] = [];
  const opened: string[] = [];
  const selections: string[] = [];
  const detailOpens: string[] = [];
  const expandedStates: boolean[] = [];
  return {
    searches,
    folders,
    pages,
    filenames,
    paths,
    statuses,
    differences,
    groups,
    tags,
    cloudMissing,
    opened,
    selections,
    detailOpens,
    expandedStates,
    onSearchCatalog: (value) => searches.push(value),
    onFilterCatalogFolder: (value) => folders.push(value),
    onCatalogPage: (value) => pages.push(value),
    onCopyCatalogFilename: (value) => filenames.push(value),
    onCopyCatalogPath: (value) => paths.push(value),
    onToggleCatalogStatus: (value) => statuses.push(value),
    onToggleCatalogDifference: (value) => differences.push(value),
    onFilterCatalogGroup: (value) => groups.push(value),
    onFilterCatalogTag: (value) => tags.push(value),
    onToggleCatalogCloudMissing: (value) => cloudMissing.push(value),
    onOpenBaidu: () => opened.push("open"),
    onSelectCatalogRecord: (catalogId) => selections.push(catalogId),
    onOpenCatalogDetail: (catalogId) => detailOpens.push(catalogId),
    onSetCatalogFiltersExpanded: (expanded) => expandedStates.push(expanded),
  };
};

describe("Cloud Catalog tab", () => {
  it.each([false, true])("does not emit an advanced-filter action during a %s render", async (expanded) => {
    const root = createTestDiv();
    const actions = actionFixture();
    renderCloudCatalogTab(root, readyCatalog({ source: "unified" }), actions, {
      i18n: createWorkbenchI18n("zh-CN"),
      selectedCatalogId: null,
      filtersExpanded: expanded,
    });

    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(actions.expandedStates).toEqual([]);
  });

  it("emits one advanced-filter action for one user toggle", async () => {
    const root = createTestDiv();
    const actions = actionFixture();
    renderCloudCatalogTab(root, readyCatalog({ source: "unified" }), actions, {
      i18n: createWorkbenchI18n("zh-CN"),
      selectedCatalogId: null,
      filtersExpanded: false,
    });
    const summary = root.querySelector<HTMLElement>(
      '[data-catalog-advanced-filters="true"] > summary',
    )!;

    summary.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(actions.expandedStates).toEqual([true]);
  });

  it("renders explicitly opened details inline with the selected result", () => {
    const root = createTestDiv();
    const actions = actionFixture();
    renderCloudCatalogTab(root, readyCatalog({
      source: "unified",
      pdfCount: 68_959,
      total: 2,
      items: [
        {
          catalogId: "baidu:1",
          filename: "Synthetic literature.pdf",
          pathLabel: "Synthetic/9-Literature/Synthetic literature.pdf",
          cloudPathAvailable: true,
          verificationStatus: "verified",
          differenceKinds: [],
          hierarchyTags: ["folder/Synthetic", "folder/9-Literature"],
        },
        {
          catalogId: `txt:${"a".repeat(64)}`,
          filename: "Candidate.pdf",
          pathLabel: "Synthetic/Candidate.pdf",
          cloudPathAvailable: false,
          verificationStatus: "unverified",
          differenceKinds: [],
          hierarchyTags: ["folder/Synthetic"],
        },
      ],
    }), actions, {
      i18n: createWorkbenchI18n("zh-CN"),
      selectedCatalogId: "baidu:1",
      filtersExpanded: false,
    });

    expect(root.textContent).toContain("当前仅索引文件名和目录标签");
    expect(root.textContent).toContain("68,959 本 PDF");
    const search = root.querySelector('[data-catalog-search="true"]');
    expect(search).not.toBeNull();
    expect(root.querySelector("input, button")).toBe(search);
    const selected = root.querySelector<HTMLElement>('[data-catalog-result="baidu:1"]')!;
    const details = selected.querySelector<HTMLDetailsElement>(
      '[data-catalog-details="baidu:1"]',
    )!;
    expect(details.open).toBe(true);
    expect(root.querySelector("aside")).toBeNull();
    expect(root.querySelector(".knowledge-workbench__catalog-body")).toBeNull();
    expect(actions.detailOpens).toEqual([]);
    expect(root.querySelector('[data-action="copy-cloud-path"]')?.textContent).toBe("复制云端路径");
    expect(root.querySelector<HTMLDetailsElement>('[data-catalog-advanced-filters="true"]')?.open)
      .toBe(false);
  });

  it("opens details only from the native row disclosure and does not record a close", () => {
    const root = createTestDiv();
    const actions = actionFixture();
    const candidateId = `txt:${"b".repeat(64)}`;
    renderCloudCatalogTab(root, readyCatalog({
      source: "unified",
      total: 1,
      items: [{
        catalogId: candidateId,
        filename: "Candidate.pdf",
        pathLabel: "Synthetic/Candidate.pdf",
        cloudPathAvailable: false,
        verificationStatus: "unverified",
        differenceKinds: [],
        hierarchyTags: ["folder/Synthetic"],
      }],
    }), actions, {
      i18n: createWorkbenchI18n("zh-CN"),
      selectedCatalogId: null,
      filtersExpanded: true,
    });

    expect(root.querySelector('[role="listbox"]')).toBeNull();
    expect(root.querySelector('[role="option"]')).toBeNull();
    const result = root.querySelector<HTMLElement>(`[data-catalog-result="${candidateId}"]`)!;
    const details = result.querySelector<HTMLDetailsElement>(
      `[data-catalog-details="${candidateId}"]`,
    )!;
    const select = details.querySelector<HTMLElement>('[data-action="open-catalog-detail"]')!;
    expect(select.tagName).toBe("SUMMARY");
    expect(select.dataset.focusKey).toBe(`catalog-select-${candidateId}`);
    expect(select.textContent).toBe("选择记录");
    expect(details.open).toBe(false);
    select.click();
    expect(actions.detailOpens).toEqual([candidateId]);
    expect(actions.selections).toEqual([]);
    expect(details.open).toBe(true);
    select.click();
    expect(actions.detailOpens).toEqual([candidateId]);
    expect(details.open).toBe(false);
    expect(result.querySelector<HTMLButtonElement>('[data-action="copy-catalog-filename"]'))
      .not.toBe(select);
    expect(result.querySelector<HTMLButtonElement>('[data-action="copy-cloud-path"]')?.disabled)
      .toBe(true);
    expect(details.querySelector<HTMLButtonElement>('[data-action="copy-cloud-path"]')?.disabled)
      .toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('[data-catalog-advanced-filters="true"]')?.open)
      .toBe(true);
  });

  it("renders at most 50 accessible results and delegates explicit actions", () => {
    const root = createTestDiv();
    const actions = actionFixture();
    renderCloudCatalogTab(root, readyCatalog({
      items: Array.from({ length: 55 }, (_, index) => fileRecord(index)),
    }), actions);

    expect(root.textContent).toContain("100,000 PDFs");
    expect(root.querySelectorAll("[data-catalog-result]")).toHaveLength(50);
    expect(root.querySelectorAll("[data-catalog-disclosure]")).toHaveLength(50);
    expect(root.querySelector('[aria-label="My catalog"]')).not.toBeNull();
    const first = root.querySelector<HTMLElement>('[data-catalog-result="fs-000001"]')!;
    first.querySelector<HTMLButtonElement>('[data-action="copy-catalog-filename"]')!.click();
    first.querySelector<HTMLButtonElement>('[data-action="copy-cloud-path"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="open-baidu"]')!.click();
    expect(actions.filenames).toEqual(["fs-000001"]);
    expect(actions.paths).toEqual(["fs-000001"]);
    expect(actions.opened).toEqual(["open"]);
    expect(Array.from(root.querySelectorAll("button")).every((button) => button.type === "button")).toBe(true);
  });

  it("routes catalog filters and pagination without putting record content in live status", () => {
    const root = createTestDiv();
    const actions = actionFixture();
    const model = readyCatalog();
    renderCloudCatalogTab(root, model, actions);

    const search = root.querySelector<HTMLInputElement>('[data-catalog-search="true"]')!;
    search.value = "因果";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const folder = root.querySelector<HTMLInputElement>('[data-catalog-folder="true"]')!;
    folder.value = "/统计";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-action="catalog-next-page"]')!.click();

    expect(actions.searches).toEqual(["因果"]);
    expect(actions.folders).toEqual(["/统计"]);
    expect(actions.pages).toEqual([1]);
    const liveText = Array.from(root.querySelectorAll('[aria-live]'))
      .map((element) => element.textContent ?? "")
      .join(" ");
    expect(liveText).not.toContain(model.items[0]!.filename);
    expect(liveText).not.toContain(model.items[0]!.pathLabel);
  });

  it("renders unified aggregate filters, directory tags, differences, and safe copy states", () => {
    const root = createTestDiv();
    const actions = actionFixture();
    const candidateId = `txt:${"1".repeat(64)}`;
    renderCloudCatalogTab(root, readyCatalog({
      source: "unified",
      pdfCount: 4,
      total: 3,
      verificationCounts: { unverified: 2, verified: 1, difference: 1, cloudMissing: 1 },
      groups: [{ groupKey: `group:${"2".repeat(64)}`, label: "Science", count: 4 }],
      hierarchyTags: [{ tag: "folder/Science", label: "Science", count: 4 }],
      items: [
        {
          catalogId: candidateId,
          filename: "Candidate.pdf",
          pathLabel: "Science/Candidate.pdf",
          cloudPathAvailable: false,
          verificationStatus: "unverified",
          differenceKinds: [],
          hierarchyTags: ["folder/Science"],
        },
        {
          catalogId: "baidu:2",
          filename: "Moved.pdf",
          pathLabel: "Science/Moved.pdf",
          cloudPathAvailable: true,
          verificationStatus: "difference",
          differenceKinds: ["moved", "renamed"],
          hierarchyTags: ["folder/Science"],
        },
        {
          catalogId: "baidu:3",
          filename: "Verified.pdf",
          pathLabel: "Science/Verified.pdf",
          cloudPathAvailable: true,
          verificationStatus: "verified",
          differenceKinds: [],
          hierarchyTags: ["folder/Science"],
        },
      ],
    }), actions);

    expect(root.textContent).toContain("Unverified 2");
    expect(root.textContent).toContain("Verified 1");
    expect(root.textContent).toContain("Differences 1");
    expect(root.textContent).toContain("Directory tags only; PDF content is not indexed.");
    expect(root.textContent).toContain("Moved");
    expect(root.textContent).toContain("Renamed");
    expect(root.textContent).not.toContain("#Science");
    const candidate = root.querySelector<HTMLElement>(`[data-catalog-result="${candidateId}"]`)!;
    expect(candidate.querySelector<HTMLButtonElement>('[data-action="copy-cloud-path"]')?.disabled)
      .toBe(true);
    expect(root.querySelector<HTMLElement>('[data-catalog-result="baidu:2"]')
      ?.querySelector<HTMLButtonElement>('[data-action="copy-cloud-path"]')?.disabled).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-catalog-status="unverified"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-catalog-difference="moved"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-catalog-group]')!.click();
    root.querySelector<HTMLButtonElement>('[data-catalog-tag]')!.click();
    const missing = root.querySelector<HTMLInputElement>('[data-catalog-cloud-missing="true"]')!;
    missing.checked = true;
    missing.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions.statuses).toEqual(["unverified"]);
    expect(actions.differences).toEqual(["moved"]);
    expect(actions.groups).toEqual([`group:${"2".repeat(64)}`]);
    expect(actions.tags).toEqual(["folder/Science"]);
    expect(actions.cloudMissing).toEqual([true]);
  });

  it.each([
    ["no-snapshot", "No cloud catalog snapshot yet"],
    ["loading", "Loading cloud catalog"],
    ["error", "Cloud catalog snapshot is unavailable"],
    ["unavailable", "Cloud catalog is unavailable in this build"],
  ] as const)("renders a fixed %s state", (status, message) => {
    const root = createTestDiv();
    renderCloudCatalogTab(root, readyCatalog({
      status,
      total: 0,
      items: [],
      messageCode: status === "error" ? "snapshot-corrupt" : "catalog-unavailable",
    }), actionFixture());
    expect(root.textContent).toContain(message);
    expect(root.querySelectorAll("[data-catalog-result]")).toHaveLength(0);
  });

  it("keeps the catalog destination ARIA-linked and preserves search focus across rendering", () => {
    const root = createTestDiv();
    document.body.append(root);
    const actions = actionFixture();
    const base = populatedWorkbenchModel();
    const model = {
      ...base,
      route: { tab: "library" } as const,
      catalog: readyCatalog({ query: "统计" }),
    };
    renderWorkbench(root, model, noOpWorkbenchActions(actions));

    expect(root.querySelector('[data-workbench-page="library"]')?.textContent).toBe("文库");
    expect(root.querySelectorAll('[data-workbench-page]')).toHaveLength(3);
    const destination = root.querySelector<HTMLElement>('[data-workbench-page="library"]')!;
    expect(root.querySelector("main")?.getAttribute("aria-labelledby")).toBe(destination.id);
    const search = root.querySelector<HTMLInputElement>('[data-catalog-search="true"]')!;
    search.focus();
    search.setSelectionRange(2, 2);
    renderWorkbench(root, {
      ...model,
      catalog: readyCatalog({ query: "因果" }),
    }, noOpWorkbenchActions(actions));
    expect(document.activeElement).toBe(root.querySelector('[data-catalog-search="true"]'));
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(2);
    root.remove();
  });

  it("preserves a focused unified status chip across rendering", () => {
    const root = createTestDiv();
    document.body.append(root);
    const actions = actionFixture();
    const base = populatedWorkbenchModel();
    const model = {
      ...base,
      route: { tab: "library" } as const,
      catalog: readyCatalog({
        source: "unified",
        verificationCounts: { unverified: 2, verified: 1, difference: 1, cloudMissing: 0 },
      }),
    };
    renderWorkbench(root, model, noOpWorkbenchActions(actions));
    const chip = root.querySelector<HTMLButtonElement>('[data-catalog-status="unverified"]')!;
    chip.focus();
    renderWorkbench(root, model, noOpWorkbenchActions(actions));
    expect(document.activeElement).toBe(
      root.querySelector('[data-catalog-status="unverified"]'),
    );
    root.remove();
  });

  it("keeps catalog projection and commands isolated from Today and Map", () => {
    const catalog = new FakeCloudCatalogRuntime(readyCatalog());
    const fixture = controllerFixture({ catalog });
    const before = fixture.controller.snapshot();
    const listener = vi.fn();
    fixture.controller.subscribe(listener);

    fixture.controller.searchCatalog("因果");
    expect(catalog.queries).toEqual(["因果"]);
    expect(fixture.projection.mapSearchCalls).toBe(0);
    expect(fixture.controller.snapshot().today).toEqual(before.today);
    expect(fixture.controller.snapshot().map).toEqual(before.map);

    catalog.setSnapshot(readyCatalog({ query: "因果", total: 2, items: [fileRecord(0), fileRecord(1)] }));
    expect(fixture.controller.snapshot().catalog).toMatchObject({ query: "因果", total: 2 });
    expect(listener).toHaveBeenCalled();
    fixture.controller.dispose();
    expect(catalog.disposeCalls).toBe(1);
  });
});
