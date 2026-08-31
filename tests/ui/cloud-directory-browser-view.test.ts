// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CloudDirectoryBrowserStopReason,
  CloudDirectoryLayerSnapshot,
} from "../../src/catalog/cloud-directory-browser";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
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
    select: vi.fn<(selection: CloudDirectorySelection) => void>(),
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
      onSelect: events.select,
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
  it("separates entering, highlighting, directory selection, and category selection", () => {
    const { host, events } = fixture();

    host.querySelector<HTMLButtonElement>(
      '[data-action="enter-directory"][data-directory-path="/科学文库/9-文学"]',
    )!.click();
    host.querySelector<HTMLButtonElement>(
      '[data-action="highlight-directory"][data-directory-path="/科学文库/9-文学"]',
    )!.click();
    expect(events.enter).toHaveBeenCalledWith("/科学文库/9-文学");
    expect(events.highlight).toHaveBeenCalledWith("/科学文库/9-文学");
    expect(events.select).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>(
      '[data-action="select-category"][data-directory-path="/科学文库/6-经济类"]',
    )!.click();
    expect(events.select).toHaveBeenCalledWith({
      kind: "category",
      selectedPath: "/科学文库/6-经济类",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_KEY,
    });
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

    expect(progress.max).toBe(20_000);
    expect(progress.value).toBe(20_000);
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
    const { host } = fixture(state({
      layer: layer("/科学文库", directories, {
        cumulativeCheckedEntryCount: 20_000,
      }),
    }));
    const list = host.querySelector<HTMLUListElement>('[data-directory-browser-list="true"]')!;
    expect(list.dataset.totalRows).toBe("20000");
    expect(list.children.length).toBeLessThanOrEqual(102);

    list.scrollTop = 20_000 * 44;
    list.dispatchEvent(new Event("scroll"));
    expect(list.textContent).toContain("D19999");
    expect(list.children.length).toBeLessThanOrEqual(102);
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
