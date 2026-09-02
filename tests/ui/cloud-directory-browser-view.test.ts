// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaiduCatalogSourcePort } from "../../src/catalog/catalog-ports";
import type { BaiduListEntry } from "../../src/catalog/catalog-types";
import type {
  CloudDirectoryBrowserStopReason,
  CloudDirectoryLayerSnapshot,
} from "../../src/catalog/cloud-directory-browser";
import { CloudDirectoryBrowserService } from "../../src/catalog/cloud-directory-browser";
import type {
  CloudDirectoryPickerPurpose,
} from "../../src/catalog/cloud-directory-selection";
import { createDirectoryPickerI18n } from "../../src/i18n/workbench-directory-picker-i18n";
import {
  createCloudDirectoryBrowserView,
  type CloudDirectoryBrowserViewState,
} from "../../src/ui/cloud-directory-browser-view";

const GROUP_KEY = `group:${"a".repeat(64)}`;
const purpose: CloudDirectoryPickerPurpose = {
  kind: "verification",
  groups: [{
    groupKey: GROUP_KEY,
    rootRelativePath: "6-经济类",
    label: "经济类",
  }],
};

const directory = (path: string, index = 1) => ({
  fsId: String(index),
  path,
  filename: path.split("/").at(-1)!,
});

const layer = (
  path: string,
  directories = [directory(`${path}/Child`.replace("//", "/"))],
  input: Partial<CloudDirectoryLayerSnapshot> = {},
): CloudDirectoryLayerSnapshot => ({
  path,
  directories,
  nextStart: null,
  complete: true,
  cumulativeCheckedEntryCount: directories.length,
  cumulativeListRequestCount: 1,
  lastStopReason: "complete",
  ...input,
});

const state = (
  input: Partial<CloudDirectoryBrowserViewState> = {},
): CloudDirectoryBrowserViewState => ({
  currentPath: "/科学文库",
  ancestors: [
    { path: "/", label: "根目录" },
    { path: "/科学文库", label: "科学文库" },
  ],
  purpose,
  layer: layer("/科学文库", [
    directory("/科学文库/6-经济类"),
    directory("/科学文库/9-文学", 2),
  ]),
  highlightedPath: null,
  activity: "complete",
  round: {
    checkedEntryCount: 2,
    listRequestCount: 1,
    elapsedMs: 25,
    stopReason: "complete",
  },
  fixedError: null,
  ...input,
});

const fixture = (initial = state()) => {
  const host = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  document.body.append(host);
  const events = {
    enter: vi.fn<(path: string) => void>(),
    highlight: vi.fn<(path: string) => void>(),
    selectCurrent: vi.fn<() => void>(),
    selectHighlighted: vi.fn<() => void>(),
    selectCategory: vi.fn<(path: string) => void>(),
    breadcrumb: vi.fn<(path: string) => void>(),
    continueLayer: vi.fn<() => void>(),
    retry: vi.fn<() => void>(),
    cancel: vi.fn<() => void>(),
  };
  const surface = createCloudDirectoryBrowserView(
    host,
    createDirectoryPickerI18n("zh-CN"),
    initial,
    {
      onEnter: events.enter,
      onHighlight: events.highlight,
      onSelectCurrent: events.selectCurrent,
      onSelectHighlighted: events.selectHighlighted,
      onSelectCategory: events.selectCategory,
      onBreadcrumb: events.breadcrumb,
      onContinue: events.continueLayer,
      onRetry: events.retry,
      onCancel: events.cancel,
    },
  );
  return { host, surface, events };
};

afterEach(() => document.body.replaceChildren());

describe("cloud directory browser view", () => {
  it("forwards navigation and path-only selection actions without constructing selections", () => {
    const { host, surface, events } = fixture();

    host.querySelector<HTMLButtonElement>(
      '[data-action="enter-directory"][data-directory-path="/科学文库/9-文学"]',
    )!.click();
    host.querySelector<HTMLButtonElement>(
      '[data-action="highlight-directory"][data-directory-path="/科学文库/9-文学"]',
    )!.click();
    expect(events.enter).toHaveBeenCalledWith("/科学文库/9-文学");
    expect(events.highlight).toHaveBeenCalledWith("/科学文库/9-文学");
    expect(events.selectCurrent).not.toHaveBeenCalled();
    expect(events.selectHighlighted).not.toHaveBeenCalled();
    expect(events.selectCategory).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>(
      '[data-action="select-current-directory"]',
    )!.click();
    expect(events.selectCurrent).toHaveBeenCalledOnce();

    surface.update(state({ highlightedPath: "/科学文库/9-文学" }));
    host.querySelector<HTMLButtonElement>(
      '[data-action="select-highlighted-directory"]',
    )!.click();
    expect(events.selectHighlighted).toHaveBeenCalledOnce();

    host.querySelector<HTMLButtonElement>(
      '[data-action="select-category"][data-directory-path="/科学文库/6-经济类"]',
    )!.click();
    expect(events.selectCategory).toHaveBeenCalledWith("/科学文库/6-经济类");
    expect(events.enter).toHaveBeenCalledTimes(1);
  });

  it("never exposes an enabled root selection and emits only supplied breadcrumb paths", () => {
    const { host, events } = fixture(state({
      currentPath: "/",
      ancestors: [{ path: "/", label: "根目录" }],
      purpose: { kind: "scan" },
      layer: layer("/", [directory("/科学文库")]),
    }));

    expect(host.querySelector<HTMLButtonElement>('[data-action="select-current-directory"]')
      ?.disabled).toBe(true);
    expect(host.querySelector('[data-action="select-category"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-action="browse-breadcrumb"]')!.click();
    expect(events.breadcrumb).toHaveBeenCalledWith("/");
  });

  it("shows exact bounded progress and partial continuation without a fake percentage", () => {
    const stopReason: CloudDirectoryBrowserStopReason = "entry-limit";
    const { host, events } = fixture(state({
      activity: "incomplete",
      layer: layer("/科学文库", [directory("/科学文库/A")], {
        nextStart: 20_000,
        complete: false,
        cumulativeCheckedEntryCount: 31_000,
        cumulativeListRequestCount: 31,
        lastStopReason: stopReason,
      }),
      round: {
        checkedEntryCount: 20_000,
        listRequestCount: 20,
        elapsedMs: 1234,
        stopReason,
      },
    }));
    const progress = host.querySelector<HTMLProgressElement>("progress")!;
    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    const breadcrumbs = host.querySelector<HTMLElement>("nav")!;
    const list = host.querySelector<HTMLUListElement>('[data-directory-browser-list="true"]')!;
    const selectedRow = host.querySelector<HTMLElement>(
      '[data-directory-path="/科学文库/A"]',
    )!;

    expect(progress.max).toBe(20_000);
    expect(progress.value).toBe(20_000);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(breadcrumbs.getAttribute("aria-label")).toContain("/科学文库");
    expect(list.getAttribute("role")).toBe("listbox");
    expect(selectedRow.getAttribute("role")).toBe("option");
    expect(selectedRow.getAttribute("aria-selected")).toBe("false");
    const runDetails = host.querySelector<HTMLDetailsElement>(
      "details.knowledge-workbench__directory-browser-details",
    )!;
    expect(runDetails.open).toBe(false);
    expect(runDetails.querySelector("summary")?.textContent).toBe("运行详情");
    expect(runDetails.textContent).toContain("本轮 20/20");
    expect(runDetails.textContent).toContain("1,234/120,000 毫秒");
    expect(host.textContent).toContain("20,000");
    expect(host.textContent).toContain("31,000");
    expect(host.textContent).toContain("本轮已检查 20,000 / 20,000 个条目");
    expect(host.textContent).toContain("当前层累计已检查 31,000 个条目");
    expect(host.textContent).not.toContain("本轮已检查 31,000 / 20,000 个条目");
    expect(host.textContent).toContain("20");
    expect(host.textContent).toContain("31");
    expect(host.textContent).toContain("20,000");
    expect(host.textContent).toContain("条目上限");
    expect(host.textContent).not.toContain("100%");
    host.querySelector<HTMLButtonElement>('[data-action="continue-directory-layer"]')!.click();
    expect(events.continueLayer).toHaveBeenCalledOnce();
  });

  it("keeps a 20,000-folder layer bounded and can reach the final window", () => {
    const directories = Array.from({ length: 20_000 }, (_, index) => (
      directory(`/科学文库/D${index}`, index + 1)
    ));
    const pressureLayer = layer("/科学文库", directories, {
      cumulativeCheckedEntryCount: 20_000,
    });
    const { host, surface, events } = fixture(state({
      layer: pressureLayer,
    }));
    const list = host.querySelector<HTMLUListElement>('[data-directory-browser-list="true"]')!;
    expect(list.dataset.totalRows).toBe("20000");
    expect(list.children.length).toBeLessThanOrEqual(102);

    list.scrollTop = 20_000 * 44;
    list.dispatchEvent(new Event("scroll"));
    expect(list.textContent).toContain("D19999");
    expect(list.children.length).toBeLessThanOrEqual(102);

    const reusedEnter = list.querySelector<HTMLButtonElement>('[data-action="enter-directory"]')!;
    surface.update(state({
      layer: pressureLayer,
      highlightedPath: "/科学文库/D19999",
    }));
    const rerenderedList = host.querySelector<HTMLUListElement>(
      '[data-directory-browser-list="true"]',
    )!;
    expect(rerenderedList).toBe(list);
    expect(rerenderedList.children.length).toBeLessThanOrEqual(102);
    expect(rerenderedList.querySelector(
      '.knowledge-workbench__directory-browser-row[data-directory-path="/科学文库/D19999"]',
    )?.getAttribute("aria-selected")).toBe("true");
    reusedEnter.click();
    expect(events.enter).toHaveBeenCalledWith("/科学文库/D19900");
    events.enter.mockClear();

    const liveEnter = rerenderedList.querySelector<HTMLButtonElement>(
      '[data-action="enter-directory"]',
    )!;
    surface.dispose();
    liveEnter.click();
    expect(events.enter).not.toHaveBeenCalled();
  });

  it("keeps a long Chinese path and folder name available at a synthetic narrow width", () => {
    const longName = "这是一个用于验证窄窗口完整可读性的超长中文文件夹名称";
    const longPath = `/科学文库/经济学与复杂系统/${longName}`;
    const { host, surface } = fixture(state({
      currentPath: "/科学文库/经济学与复杂系统",
      ancestors: [
        { path: "/科学文库", label: "科学文库" },
        { path: "/科学文库/经济学与复杂系统", label: "经济学与复杂系统" },
      ],
      layer: layer("/科学文库/经济学与复杂系统", [directory(longPath, 1)]),
    }));
    host.dataset.syntheticWidth = "320";

    expect(host.dataset.syntheticWidth).toBe("320");
    expect(host.querySelector(".knowledge-workbench__directory-browser-path")?.textContent)
      .toContain("/科学文库/经济学与复杂系统");
    const enter = host.querySelector<HTMLButtonElement>('[data-action="enter-directory"]')!;
    expect(enter.textContent).toContain(longName);
    expect(enter.getAttribute("aria-label")).toContain(longName);
    surface.dispose();
  });

  it("does not recopy one 20,000-folder array for highlight or status rerenders", () => {
    const rawDirectories = Array.from({ length: 20_000 }, (_, index) => (
      directory(`/科学文库/P${index}`, index + 1)
    ));
    let sliceCalls = 0;
    const directories = new Proxy(rawDirectories, {
      get(target, property, receiver) {
        if (property === "slice") {
          return (start?: number, end?: number) => {
            sliceCalls += 1;
            return target.slice(start, end);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const pressureLayer = layer("/科学文库", directories, {
      cumulativeCheckedEntryCount: 20_000,
    });
    const { surface } = fixture(state({ layer: pressureLayer }));
    expect(sliceCalls).toBe(1);

    surface.update(state({
      layer: pressureLayer,
      highlightedPath: "/科学文库/P1",
    }));
    surface.update(state({
      layer: pressureLayer,
      highlightedPath: "/科学文库/P1",
      activity: "incomplete",
      round: {
        checkedEntryCount: 20_000,
        listRequestCount: 20,
        elapsedMs: 500,
        stopReason: "entry-limit",
      },
    }));
    expect(sliceCalls).toBe(1);
    surface.dispose();
  });

  it("discards every file name from a 20,000-entry mixed source before snapshot and DOM", async () => {
    const source: BaiduCatalogSourcePort = {
      async listDirectory(input) {
        await input.beforeRequest();
        const entries: BaiduListEntry[] = Array.from({ length: 1000 }, (_, offset) => {
          const index = input.start + offset;
          const isDirectory = index % 2 === 0;
          const filename = isDirectory ? `目录-${index}` : `private-file-${index}.pdf`;
          return {
            fsId: String(index + 1),
            path: `/压力层/${filename}`,
            filename,
            sizeBytes: isDirectory ? 0 : 128,
            serverModifiedAt: 1,
            isDirectory,
          };
        });
        return { entries };
      },
    };
    const browser = new CloudDirectoryBrowserService(source, { now: () => 0 });
    const round = await browser.loadLayer({ path: "/压力层", start: 0 });
    const snapshot = browser.snapshot("/压力层")!;

    expect(round).toMatchObject({
      status: "paused",
      stopReason: "entry-limit",
      checkedEntryCount: 20_000,
      listRequestCount: 20,
    });
    expect(snapshot.directories).toHaveLength(10_000);
    expect(JSON.stringify(snapshot)).not.toContain("private-file-");
    const { host, surface } = fixture(state({
      currentPath: "/压力层",
      ancestors: [{ path: "/压力层", label: "压力层" }],
      purpose: { kind: "scan" },
      layer: snapshot,
      activity: "incomplete",
      round: {
        checkedEntryCount: round.checkedEntryCount,
        listRequestCount: round.listRequestCount,
        elapsedMs: round.elapsedMs,
        stopReason: round.stopReason,
      },
    }));
    const list = host.querySelector<HTMLUListElement>('[data-directory-browser-list="true"]')!;
    expect(list.dataset.totalRows).toBe("10000");
    expect(list.children.length).toBeLessThanOrEqual(102);
    expect(host.textContent).not.toContain("private-file-");
    surface.dispose();
    browser.dispose();
  });

  it("renders loading, empty, canceled, conflict, and fixed-error states", () => {
    const { host, surface } = fixture(state({ activity: "running", layer: null, round: null }));
    expect(host.textContent).toContain("正在加载");

    surface.update(state({
      activity: "complete",
      layer: layer("/科学文库", []),
      round: { checkedEntryCount: 3, listRequestCount: 1, elapsedMs: 2, stopReason: "complete" },
    }));
    expect(host.textContent).toContain("没有子文件夹");

    surface.update(state({ activity: "canceled" }));
    expect(host.textContent).toContain("已取消");
    surface.update(state({ activity: "error", fixedError: "conflict" }));
    expect(host.textContent).toContain("目录身份冲突");
    surface.update(state({ activity: "error", fixedError: "browser-unavailable" }));
    expect(host.textContent).toContain("暂时不可用");
  });

  it("dispose removes every rendered interaction", () => {
    const { host, surface, events } = fixture();
    const enter = host.querySelector<HTMLButtonElement>('[data-action="enter-directory"]')!;
    const highlight = host.querySelector<HTMLButtonElement>('[data-action="highlight-directory"]')!;
    const breadcrumb = host.querySelector<HTMLButtonElement>('[data-action="browse-breadcrumb"]')!;
    surface.dispose();

    enter.click();
    highlight.click();
    breadcrumb.click();
    expect(events.enter).not.toHaveBeenCalled();
    expect(events.highlight).not.toHaveBeenCalled();
    expect(events.breadcrumb).not.toHaveBeenCalled();
  });
});
