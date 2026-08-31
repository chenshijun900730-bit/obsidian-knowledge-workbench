// @vitest-environment jsdom
import type { WorkspaceLeaf } from "obsidian";
import { expect, it } from "vitest";
import type { CloudDirectoryLayerSnapshot } from "../../src/catalog/cloud-directory-browser";
import type { DocumentRecord } from "../../src/core/types";
import { createDirectoryPickerI18n } from "../../src/i18n/workbench-directory-picker-i18n";
import { NORMAL_RUNTIME_POLICY } from "../../src/runtime/safety-policy";
import { createCloudDirectoryBrowserView } from "../../src/ui/cloud-directory-browser-view";
import { createWorkbenchViewClass, type ItemViewConstructor } from "../../src/ui/workbench-view";
import { FakeCloudCatalogRuntime } from "../fakes/fake-cloud-catalog-runtime";
import { controllerFixture } from "../helpers/ui-fixtures";
import { benchmarkWorkbenchOpen, percentile95 } from "./index-benchmark";

const records = Array.from({ length: 5_000 }, (_, index): DocumentRecord => ({
  id: `record-${index}`,
  path: `Generated/${String(index).padStart(4, "0")}.md`,
  basename: String(index).padStart(4, "0"),
  kind: index % 2 === 0 ? "note" : "reference",
  title: `Generated ${index}`,
  aliases: [],
  headings: [`Generated ${index}`],
  tags: [],
  ownedFields: {},
  relationFields: {},
  outgoingLinks: [],
  tokens: ["generated", String(index)],
  mtime: index + 1,
  size: 128,
  contentHash: `hash-${index}`,
}));

it("opens a preloaded 5000-record workbench within the DOM-render p95 gate", async () => {
  const result = await benchmarkWorkbenchOpen(records, 20);
  const scope = "ItemView construction, subscription, snapshot clone, and jsdom render over an already materialized controller; excludes projection and Obsidian-host launch";
  process.stdout.write(`[knowledge-workbench open performance]\n${JSON.stringify({
    ...result,
    p95Ms: percentile95(result.openTimesMs),
    sampleCount: result.openTimesMs.length,
    scope,
  }, null, 2)}\n`);
  expect(scope).toBe("ItemView construction, subscription, snapshot clone, and jsdom render over an already materialized controller; excludes projection and Obsidian-host launch");
  expect(result.openTimesMs).toHaveLength(20);
  expect(percentile95(result.openTimesMs)).toBeLessThanOrEqual(2_000);
}, 60_000);

it("reports the detached preloaded index count instead of a later-mutated input length", async () => {
  const mutable = [...records];
  const pending = benchmarkWorkbenchOpen(mutable, 1);
  mutable.length = 0;
  await expect(pending).resolves.toMatchObject({ recordCount: 5_000 });
}, 60_000);

it("keeps a 68,959-entry catalog and one 20,000-folder browser surface allocation-bounded", async () => {
  const catalogCount = 68_959;
  const rawCatalogStore = Array.from({ length: catalogCount }, (_, index) => ({
    catalogId: `catalog-${index}`,
    filename: `Catalog-only-${index}.pdf`,
    pathLabel: `Group-${index % 24}/Catalog-only-${index}.pdf`,
    cloudPathAvailable: false,
    verificationStatus: "unverified" as const,
    differenceKinds: [] as const,
    hierarchyTags: [] as const,
  }));
  let catalogStoreSliceCount = 0;
  const catalogStore = new Proxy(rawCatalogStore, {
    get(target, property, receiver) {
      if (property === "slice") {
        return (start?: number, end?: number) => {
          catalogStoreSliceCount += 1;
          return target.slice(start, end);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const catalog = new FakeCloudCatalogRuntime({
    status: "ready",
    source: "unified",
    pdfCount: catalogCount,
    total: catalogCount,
    items: catalogStore.slice(0, 50),
  });
  const fixture = controllerFixture({ activeIndex: true, records, catalog });
  fixture.controller.selectTab("cloud-catalog");
  class ItemViewSurface {
    readonly contentEl = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
  }
  const WorkbenchView = createWorkbenchViewClass(
    ItemViewSurface as unknown as ItemViewConstructor,
    NORMAL_RUNTIME_POLICY,
  );
  const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
  document.body.append(view.contentEl);
  await view.onOpen();

  const rawDirectories = Array.from({ length: 20_000 }, (_, index) => ({
    fsId: String(index + 1),
    path: `/Pressure/目录-${index}`,
    filename: `目录-${index}`,
  }));
  let directoryArraySliceCount = 0;
  const directories = new Proxy(rawDirectories, {
    get(target, property, receiver) {
      if (property === "slice") {
        return (start?: number, end?: number) => {
          directoryArraySliceCount += 1;
          return target.slice(start, end);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const layer: CloudDirectoryLayerSnapshot = {
    path: "/Pressure",
    directories,
    nextStart: 20_000,
    complete: false,
    cumulativeCheckedEntryCount: 20_000,
    cumulativeListRequestCount: 20,
    lastStopReason: "entry-limit",
  };
  const browserHost = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  view.contentEl.append(browserHost);
  const browserSurface = createCloudDirectoryBrowserView(
    browserHost,
    createDirectoryPickerI18n("zh-CN"),
    {
      currentPath: "/Pressure",
      ancestors: [{ path: "/Pressure", label: "Pressure" }],
      purpose: { kind: "scan" },
      layer,
      highlightedPath: null,
      activity: "incomplete",
      round: {
        checkedEntryCount: 20_000,
        listRequestCount: 20,
        elapsedMs: 1,
        stopReason: "entry-limit",
      },
      fixedError: null,
    },
    {
      onEnter: () => undefined,
      onHighlight: () => undefined,
      onSelect: () => undefined,
      onBreadcrumb: () => undefined,
      onContinue: () => undefined,
      onRetry: () => undefined,
      onCancel: () => undefined,
    },
  );

  try {
    expect(catalogStore).toHaveLength(catalogCount);
    expect(catalogStoreSliceCount).toBe(1);
    expect(view.contentEl.textContent).toContain("68,959");
    expect(browserSurface.root.textContent).not.toContain("Catalog-only-");
    expect(layer.directories).toBe(directories);
    expect(directoryArraySliceCount).toBe(1);
    const list = browserSurface.root.querySelector<HTMLUListElement>(
      '[data-directory-browser-list="true"]',
    )!;
    expect(list.dataset.totalRows).toBe("20000");
    for (const scrollTop of [0, 10_000 * 44, 20_000 * 44]) {
      list.scrollTop = scrollTop;
      list.dispatchEvent(new Event("scroll"));
      expect(list.children.length).toBeLessThanOrEqual(102);
      expect(directoryArraySliceCount).toBe(1);
      expect(catalogStoreSliceCount).toBe(1);
    }
    expect(list.textContent).toContain("目录-19999");
  } finally {
    browserSurface.dispose();
    await view.onClose();
    view.contentEl.remove();
    fixture.controller.dispose();
  }
}, 60_000);
