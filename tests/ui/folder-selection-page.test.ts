// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudDirectoryCandidateSource } from "../../src/catalog/cloud-directory-candidates";
import type { CloudDirectoryLayerSnapshot } from "../../src/catalog/cloud-directory-browser";
import { createDirectoryPickerI18n } from "../../src/i18n/workbench-directory-picker-i18n";
import {
  createFolderSelectionHostCapability,
  renderFolderSelectionPage,
} from "../../src/ui/folder-selection-page";
import type {
  CloudDirectoryPickerSessionState,
  FolderSelectionHostActions,
  FolderSelectionRenderState,
  FolderSelectionHostSnapshot,
} from "../../src/ui/folder-selection-host";

const GROUP_KEY = `group:${"a".repeat(64)}`;

const baseState = (
  input: Partial<CloudDirectoryPickerSessionState> = {},
): CloudDirectoryPickerSessionState => ({
  phase: "local",
  purpose: {
    kind: "verification",
    groups: [{
      groupKey: GROUP_KEY,
      rootRelativePath: "6-经济类",
      label: "经济类",
    }],
  },
  query: "科学",
  enabledSources: ["recent", "session-cache", "txt-group", "cloud-locator"],
  rankedCandidates: [{
    candidate: {
      kind: "exact",
      path: "/我的网盘/全部文件/科学文库",
      filename: "科学文库",
      source: "recent",
      pathState: "previously-used",
    },
    sources: ["recent"],
    score: 0,
    selected: true,
  }, {
    candidate: {
      kind: "exact",
      path: "/本次会话/科学文库",
      filename: "科学文库",
      source: "session-cache",
      pathState: "session-verified",
      cloudFsId: "session-1",
    },
    sources: ["session-cache"],
    score: 0,
    selected: false,
  }, {
    candidate: {
      kind: "name-hint",
      filename: "TXT 提示目录",
      source: "txt-group",
      catalogGroupKey: GROUP_KEY,
    },
    sources: ["txt-group"],
    score: 1,
    selected: false,
  }],
  selectedPath: "/我的网盘/全部文件/科学文库",
  draftSelection: {
    kind: "directory",
    selectedPath: "/我的网盘/全部文件/科学文库",
    effectiveRoot: "/我的网盘/全部文件/科学文库",
  },
  lookupDetail: null,
  browserPath: null,
  browserHighlightedPath: null,
  browserLayer: null,
  visibleBrowserDirectories: [],
  browserActivity: "idle",
  browserDetail: { round: null, fixedError: null },
  statusCode: null,
  ...input,
});

const actionFixture = (): FolderSelectionHostActions => ({
  onBack: vi.fn<() => void>(),
  onQuery: vi.fn<(value: string) => void>(),
  onToggleSource: vi.fn<(source: CloudDirectoryCandidateSource) => void>(),
  onSelectCandidate: vi.fn<(path: string) => void>(),
  onUse: vi.fn<() => void>(),
  onBrowseOther: vi.fn<() => void>(),
  onConfirmLookup: vi.fn<() => void>(),
  onRevealRoot: vi.fn<() => void>(),
  onConfirmRoot: vi.fn<() => void>(),
  onBrowserAction: {
    onNavigate: vi.fn<(path: string) => void>(),
    onHighlight: vi.fn<(path: string | null) => void>(),
    onSelectCurrent: vi.fn<() => void>(),
    onSelectHighlighted: vi.fn<() => void>(),
    onSelectCategory: vi.fn<(path: string) => void>(),
    onContinue: vi.fn<() => void>(),
    onRetry: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
  },
});

const snapshot = (
  state = baseState(),
  input: Partial<FolderSelectionHostSnapshot> = {},
): FolderSelectionHostSnapshot => ({
  revision: 1,
  i18n: createDirectoryPickerI18n("zh-CN"),
  state,
  returnLabel: "返回云端核验",
  legacyProgressMode: "none",
  ...input,
});

const fixture = (
  model = snapshot(),
  actions = actionFixture(),
) => {
  const host = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  document.body.append(host);
  const surface = renderFolderSelectionPage(host, model, actions);
  return { host, surface, actions };
};

const directory = (path: string, fsId: string) => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
});

const browserLayer = (
  activity: CloudDirectoryPickerSessionState["browserActivity"],
): CloudDirectoryLayerSnapshot => ({
  path: "/科学文库",
  directories: [
    directory("/科学文库/6-经济类", "1"),
    directory("/科学文库/9-文学", "2"),
  ],
  nextStart: activity === "incomplete" ? 20_000 : null,
  complete: activity === "complete",
  cumulativeCheckedEntryCount: 20_000,
  cumulativeListRequestCount: 20,
  lastStopReason: activity === "incomplete" ? "entry-limit" : "complete",
});

afterEach(() => document.body.replaceChildren());

describe("folder selection page", () => {
  it("keeps the initial page local, simple, and explicit", () => {
    const { host, actions } = fixture();

    expect(host.querySelector('[data-action="folder-selection-back"]')?.textContent)
      .toBe("返回云端核验");
    expect(host.querySelector<HTMLButtonElement>(
      '[data-focus-key="folder-selection-back"]',
    )).not.toBeNull();
    expect(host.querySelector('[data-folder-selection-query="true"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-folder-selection-query="true"]')
      ?.dataset.focusKey).toBe("folder-selection-query");
    expect(host.textContent).toContain("/我的网盘/全部文件");
    expect(host.textContent).toContain("/本次会话");
    expect(host.textContent).not.toContain("TXT 提示目录");
    expect(host.textContent).toContain("已选文件夹：/我的网盘/全部文件/科学文库");
    expect(host.querySelectorAll('[data-action="use-folder-selection"]')).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>(
      '[data-focus-key="folder-selection-use"]',
    )).not.toBeNull();
    expect(host.querySelector('[data-folder-selection-advanced="true"]')).toBeNull();
    expect(host.querySelector('[data-directory-source]')).toBeNull();
    expect(host.querySelector('[data-action="reveal-root-browser"]')).toBeNull();
    expect(host.querySelector('[data-directory-browser-progress]')).toBeNull();
    expect(host.querySelector<HTMLElement>(
      '[data-folder-selection-feedback="true"]',
    )?.hidden).toBe(true);

    const query = host.querySelector<HTMLInputElement>(
      '[data-folder-selection-query="true"]',
    )!;
    query.value = "经济";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    expect(actions.onQuery).toHaveBeenCalledWith("经济");
    host.querySelector<HTMLButtonElement>(
      '[data-candidate-kind="exact"][data-directory-path="/本次会话/科学文库"]',
    )!.click();
    expect(actions.onSelectCandidate).toHaveBeenCalledWith("/本次会话/科学文库");
    host.querySelector<HTMLButtonElement>('[data-action="use-folder-selection"]')!.click();
    expect(actions.onUse).toHaveBeenCalledOnce();
    host.querySelector<HTMLButtonElement>('[data-action="browse-other-folders"]')!.click();
    expect(actions.onBrowseOther).toHaveBeenCalledOnce();
  });

  it("keeps simple candidate results keyboard-focusable without exposing advanced controls", () => {
    const { host } = fixture();
    const results = host.querySelector<HTMLElement>("[data-folder-selection-results]")!;
    const candidate = results.querySelector<HTMLButtonElement>("button:not(:disabled)")!;
    expect(candidate.tabIndex).toBe(0);
    candidate.focus();
    expect(document.activeElement).toBe(candidate);
    expect(host.querySelector("[data-folder-selection-advanced] button, [data-folder-selection-advanced] input"))
      .toBeNull();
  });

  it("keeps a same-path conflict visible but not selectable on the simple page", () => {
    const conflictState = baseState({
      rankedCandidates: [{
        candidate: {
          kind: "conflict",
          filename: "科学文库",
          path: "/重复位置/科学文库",
          source: "cloud-locator",
          reason: "same-path-different-identity",
        },
        sources: ["cloud-locator"],
        score: 0,
        selected: false,
      }, ...baseState().rankedCandidates],
      statusCode: "conflict",
    });
    const { host, actions } = fixture(snapshot(conflictState));

    expect(host.querySelector('[data-folder-selection-advanced="true"]')).toBeNull();
    const conflict = host.querySelector<HTMLElement>('[data-candidate-kind="conflict"]')!;
    expect(conflict.textContent).toContain("/重复位置/科学文库");
    expect(conflict.querySelector("button")).toBeNull();
    expect(actions.onSelectCandidate).not.toHaveBeenCalled();
  });

  it("opens the advanced controls after an empty-query browse request", () => {
    const { host } = fixture(snapshot(baseState({
      query: "",
      statusCode: "query-required",
    })));

    expect(host.querySelector('[data-folder-selection-advanced="true"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-directory-source]')).toHaveLength(4);
    expect(host.querySelector('[data-action="reveal-root-browser"]')).not.toBeNull();
  });

  it.each([
    ["zh-CN" as const, "最近目录保存失败，因此未应用本次选择；请重试或取消。"],
    ["en" as const, "Saving to Recent failed, so this selection was not applied. Retry or cancel."],
  ])("shows a retryable accessible save failure in %s", (locale, expected) => {
    const { host } = fixture(snapshot(baseState({ statusCode: "save-failed" }), {
      i18n: createDirectoryPickerI18n(locale),
    }));

    const feedback = host.querySelector<HTMLElement>(
      '[data-folder-selection-feedback="true"]',
    )!;
    expect(feedback.getAttribute("role")).toBe("status");
    expect(feedback.getAttribute("aria-live")).toBe("polite");
    expect(feedback.getAttribute("aria-atomic")).toBe("true");
    expect(feedback.textContent).toBe(expected);
    expect(host.querySelector<HTMLButtonElement>(
      '[data-action="use-folder-selection"]',
    )?.disabled).toBe(false);
  });

  it("drops a late rejected action after disposal instead of leaking it to another page", async () => {
    let rejectBinding!: (reason: Error) => void;
    const actions: FolderSelectionHostActions = {
      ...actionFixture(),
      onUse: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectBinding = reject;
      })),
    };
    const first = fixture(snapshot(), actions);
    first.host.querySelector<HTMLButtonElement>('[data-action="use-folder-selection"]')!.click();
    first.surface.dispose();
    const unrelated = fixture(snapshot());

    rejectBinding(new Error("private-binding-error"));
    await Promise.resolve();
    await Promise.resolve();

    expect(first.host.querySelector<HTMLElement>(
      '[data-folder-selection-feedback="true"]',
    )?.hidden).toBe(true);
    expect(unrelated.host.querySelector<HTMLElement>(
      '[data-folder-selection-feedback="true"]',
    )?.hidden).toBe(true);
    expect(document.body.textContent).not.toContain("private-binding-error");
  });

  it("maps a rejected binding to safe local feedback without exposing the error", async () => {
    const privateDetail = "private-path-and-binding-hash";
    const actions: FolderSelectionHostActions = {
      ...actionFixture(),
      onUse: vi.fn(async () => { throw new Error(privateDetail); }),
    };
    const { host } = fixture(snapshot(), actions);

    host.querySelector<HTMLButtonElement>('[data-action="use-folder-selection"]')!.click();

    await vi.waitFor(() => expect(host.querySelector(
      '[data-folder-selection-feedback="true"]',
    )?.textContent).toBe("未能使用这个文件夹，请重试。"));
    expect(host.textContent).not.toContain(privateDetail);
    expect(host.querySelector<HTMLButtonElement>(
      '[data-action="use-folder-selection"]',
    )?.disabled).toBe(false);
  });

  it.each([
    ["zh-CN" as const, "未能使用这个文件夹，请重试。"],
    ["en" as const, "Could not use this folder. Please try again."],
  ])("renders only the current safe binding feedback code in %s", (locale, expected) => {
    const { host } = fixture(snapshot(baseState(), {
      i18n: createDirectoryPickerI18n(locale),
      feedbackCode: "binding-failed",
    }));

    expect(host.querySelector(
      '[data-folder-selection-feedback="true"]',
    )?.textContent).toBe(expected);
    expect(host.textContent).not.toContain("binding-failed");
    expect(host.querySelector<HTMLButtonElement>(
      '[data-action="use-folder-selection"]',
    )?.disabled).toBe(false);
  });

  it.each([
    ["directory-limit" as const, "达到目录数量上限"],
    ["list-request-limit" as const, "达到列表请求上限"],
    ["time-limit" as const, "达到时间上限"],
  ])("shows fixed accessible lookup detail after %s", (stopReason, reasonText) => {
    const { host } = fixture(snapshot(baseState({
      statusCode: "lookup-incomplete",
      lookupDetail: {
        status: "paused",
        stopReason,
        query: "科学",
        directoryCount: 17,
        matchCount: 3,
        listRequestCount: 4,
        elapsedMs: 625,
      },
    })));

    const lookupStatus = host.querySelector<HTMLElement>(
      '[data-folder-selection-lookup-status="true"]',
    )!;
    expect(host.querySelector('[data-folder-selection-advanced="true"]')).not.toBeNull();
    expect(lookupStatus.getAttribute("role")).toBe("status");
    expect(lookupStatus.getAttribute("aria-live")).toBe("polite");
    expect(lookupStatus.getAttribute("aria-atomic")).toBe("true");
    expect(lookupStatus.textContent).toContain(reasonText);
    expect(lookupStatus.textContent).toContain("17 个目录");
    expect(lookupStatus.textContent).toContain("3 个匹配项");
    expect(lookupStatus.textContent).toContain("4 次列表请求");
    expect(lookupStatus.textContent).toContain("625 毫秒");
  });

  it("shows complete, canceled, and sanitized failed lookup outcomes", () => {
    const complete = fixture(snapshot(baseState({
      statusCode: "lookup-complete",
      lookupDetail: {
        status: "complete",
        stopReason: "complete",
        query: "科学",
        directoryCount: 12,
        matchCount: 2,
        listRequestCount: 3,
        elapsedMs: 450,
      },
    })));
    expect(complete.host.querySelector(
      '[data-folder-selection-lookup-status="true"]',
    )?.textContent).toBe(
      "定位完成：检查了 12 个目录，找到 2 个匹配项，使用 3 次列表请求，用时 450 毫秒。",
    );

    const canceled = fixture(snapshot(baseState({
      statusCode: "lookup-incomplete",
      lookupDetail: {
        status: "canceled",
        stopReason: "user-canceled",
        query: "科学",
        directoryCount: 8,
        matchCount: 1,
        listRequestCount: 2,
        elapsedMs: 300,
      },
    })));
    expect(canceled.host.querySelector(
      '[data-folder-selection-lookup-status="true"]',
    )?.textContent).toBe(
      "定位已取消：检查了 8 个目录，保留 1 个匹配项，使用 2 次列表请求，用时 300 毫秒。",
    );

    const privateDetail = "private-token-and-response-body";
    const failed = fixture(snapshot(baseState({
      statusCode: "lookup-incomplete",
      lookupDetail: null,
      browserDetail: { round: null, fixedError: "load-failed" },
    })));
    const failedStatus = failed.host.querySelector(
      '[data-folder-selection-lookup-status="true"]',
    )?.textContent ?? "";
    expect(failed.host.querySelector('[data-folder-selection-advanced="true"]')).not.toBeNull();
    expect(failedStatus).toBe("定位暂时失败；本地候选和已提交结果仍可使用。");
    expect(failedStatus).not.toContain(privateDetail);
  });

  it("reveals all four source filters, bounded lookup, root controls, and conflicts only in advanced mode", () => {
    const conflictState = baseState({
      phase: "lookup-consent",
      rankedCandidates: [{
        candidate: {
          kind: "conflict",
          filename: "科学文库",
          path: "/重复位置/科学文库",
          source: "cloud-locator",
          reason: "same-path-different-identity",
        },
        sources: ["cloud-locator"],
        score: 0,
        selected: false,
      }, ...baseState().rankedCandidates],
      statusCode: "lookup-consent-required",
    });
    const { host, actions } = fixture(snapshot(conflictState));

    const filters = Array.from(host.querySelectorAll<HTMLButtonElement>(
      '[data-directory-source]',
    ));
    expect(filters.map((button) => button.dataset.directorySource)).toEqual([
      "recent",
      "session-cache",
      "txt-group",
      "cloud-locator",
    ]);
    expect(host.textContent).toContain("TXT 提示目录");
    expect(host.textContent).toContain("500");
    expect(host.textContent).toContain("50");
    expect(host.textContent).toContain("120");
    const conflict = host.querySelector<HTMLElement>('[data-candidate-kind="conflict"]')!;
    expect(conflict.textContent).toContain("/重复位置/科学文库");
    expect(conflict.querySelector("button")).toBeNull();

    filters.find((button) => button.dataset.directorySource === "txt-group")!.click();
    expect(actions.onToggleSource).toHaveBeenCalledWith("txt-group");
    host.querySelector<HTMLButtonElement>('[data-action="confirm-directory-lookup"]')!.click();
    expect(actions.onConfirmLookup).toHaveBeenCalledOnce();
    host.querySelector<HTMLButtonElement>('[data-action="reveal-root-browser"]')!.click();
    expect(actions.onRevealRoot).toHaveBeenCalledOnce();

    const rootActions = actionFixture();
    const rootFixture = fixture(snapshot(baseState({ phase: "root-consent" })), rootActions);
    rootFixture.host.querySelector<HTMLButtonElement>(
      '[data-action="confirm-root-browser"]',
    )!.click();
    expect(rootActions.onConfirmRoot).toHaveBeenCalledOnce();
  });

  it("embeds the windowed browser and forwards only path actions", () => {
    const actions = actionFixture();
    const state = baseState({
      phase: "browsing",
      browserPath: "/科学文库",
      browserHighlightedPath: "/科学文库/9-文学",
      browserLayer: browserLayer("incomplete"),
      visibleBrowserDirectories: browserLayer("incomplete").directories,
      browserActivity: "incomplete",
      browserDetail: {
        round: {
          checkedEntryCount: 20_000,
          listRequestCount: 20,
          elapsedMs: 1000,
          stopReason: "entry-limit",
        },
        fixedError: null,
      },
      statusCode: "browser-incomplete",
    });
    const { host, surface } = fixture(snapshot(state), actions);

    expect(host.querySelector('[data-directory-browser="true"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>(
      '[data-action="enter-directory"][data-directory-path="/科学文库/9-文学"]',
    )!.click();
    host.querySelector<HTMLButtonElement>(
      '[data-action="highlight-directory"][data-directory-path="/科学文库/6-经济类"]',
    )!.click();
    host.querySelector<HTMLButtonElement>('[data-action="select-current-directory"]')!.click();
    host.querySelector<HTMLButtonElement>(
      '[data-action="select-highlighted-directory"]',
    )!.click();
    host.querySelector<HTMLButtonElement>(
      '[data-action="select-category"][data-directory-path="/科学文库/6-经济类"]',
    )!.click();
    host.querySelector<HTMLButtonElement>(
      '[data-action="browse-breadcrumb"][data-directory-path="/"]',
    )!.click();
    host.querySelector<HTMLButtonElement>('[data-action="continue-directory-layer"]')!.click();

    expect(actions.onBrowserAction.onNavigate).toHaveBeenCalledWith("/科学文库/9-文学");
    expect(actions.onBrowserAction.onNavigate).toHaveBeenCalledWith("/");
    expect(actions.onBrowserAction.onHighlight).toHaveBeenCalledWith("/科学文库/6-经济类");
    expect(actions.onBrowserAction.onSelectCurrent).toHaveBeenCalledOnce();
    expect(actions.onBrowserAction.onSelectHighlighted).toHaveBeenCalledOnce();
    expect(actions.onBrowserAction.onSelectCategory)
      .toHaveBeenCalledWith("/科学文库/6-经济类");
    expect(actions.onBrowserAction.onContinue).toHaveBeenCalledOnce();

    const liveButton = host.querySelector<HTMLButtonElement>('[data-action="enter-directory"]')!;
    surface.dispose();
    liveButton.click();
    expect(actions.onBrowserAction.onNavigate).toHaveBeenCalledTimes(2);
  });

  it("forwards retry and cancel without exposing BrowserView selection objects", () => {
    const retryActions = actionFixture();
    const retryPage = fixture(snapshot(baseState({
      phase: "browsing",
      browserPath: "/科学文库",
      browserLayer: browserLayer("complete"),
      visibleBrowserDirectories: browserLayer("complete").directories,
      browserActivity: "error",
      browserDetail: { round: null, fixedError: "load-failed" },
      statusCode: "browser-error",
    })), retryActions);
    retryPage.host.querySelector<HTMLButtonElement>('[data-action="retry-directory-layer"]')!
      .click();
    expect(retryActions.onBrowserAction.onRetry).toHaveBeenCalledOnce();
    retryPage.surface.dispose();

    const cancelActions = actionFixture();
    const cancelPage = fixture(snapshot(baseState({
      phase: "browsing",
      browserPath: "/科学文库",
      browserLayer: browserLayer("complete"),
      visibleBrowserDirectories: browserLayer("complete").directories,
      browserActivity: "running",
      browserDetail: { round: null, fixedError: null },
      statusCode: "browser-loading",
    })), cancelActions);
    cancelPage.host.querySelector<HTMLButtonElement>('[data-action="cancel-directory-layer"]')!
      .click();
    expect(cancelActions.onBrowserAction.onCancel).toHaveBeenCalledOnce();
  });

  it("restores search focus on the local page and delegates the single return action", () => {
    const previous = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    document.body.append(previous);
    previous.focus();
    const { host, actions } = fixture();
    const query = host.querySelector<HTMLInputElement>(
      '[data-folder-selection-query="true"]',
    )!;

    expect(document.activeElement).toBe(query);
    host.querySelector<HTMLButtonElement>('[data-action="folder-selection-back"]')!.click();
    expect(actions.onBack).toHaveBeenCalledOnce();
  });

  it("keeps the published render state clonable and creates i18n only inside the normal capability", () => {
    const renderState: FolderSelectionRenderState = {
      revision: 7,
      locale: "en",
      state: baseState(),
      returnLabel: "Back to verification",
      legacyProgressMode: "requires-fresh",
    };
    const cloned = structuredClone(renderState);
    expect(cloned).toEqual(renderState);
    expect("i18n" in renderState).toBe(false);

    const host = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    document.body.append(host);
    const capability = createFolderSelectionHostCapability();
    const surface = capability.render(host, renderState, actionFixture());
    expect(host.textContent).toContain("Choose a library folder");
    expect(host.textContent).toContain("Browse other folders");
    expect(host.textContent).toContain("This folder requires a fresh verification.");
    expect(host.querySelector('[data-action="use-folder-selection"]')?.textContent)
      .toBe("Use this folder and verify again");
    surface.dispose();
  });

  it("keeps the acceptance host contract type-only", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/folder-selection-host.ts"), "utf8");
    expect(source).not.toMatch(/^import (?!type\b)/mu);
    expect(source).not.toContain("cloud-directory-picker-session");
    expect(source).not.toContain("cloud-directory-browser-view");
    expect(source).not.toContain("baidu-catalog-source");
  });
});
