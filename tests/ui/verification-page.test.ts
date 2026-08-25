// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CloudCatalogConnectionViewModel } from "../../src/catalog/cloud-catalog-runtime";
import type { HybridCatalogViewModel } from "../../src/catalog/hybrid-catalog-runtime";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import {
  renderVerificationPage,
  type VerificationPageActions,
  type VerificationPageModel,
} from "../../src/ui/verification-page";
import { LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS } from "../../src/catalog/hybrid-catalog-types";

const INACTIVE_AUTO_RESUME = {
  autoResumeState: "inactive" as const,
  autoSegmentIndex: 0,
  autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
};

const GROUP_KEY = `group:${"b".repeat(64)}`;
const testRoot = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;
const active = {
  importedAt: 1,
  pdfCount: 252,
  unverifiedCount: 252,
  verifiedCount: 0,
  differenceCount: 0,
  cloudMissingCount: 0,
  groupCount: 1,
  verifiedGroupCount: 0,
  coveredCandidatePdfCount: 0,
  groups: [{
    groupKey: GROUP_KEY,
    label: "9-Literature-253",
    pdfCount: 252,
    mode: "recursive" as const,
    verificationStatus: "unverified" as const,
  }],
};

const actions = (overrides: Partial<VerificationPageActions> = {}): VerificationPageActions => ({
  onRootChange: () => undefined,
  onToggleGroup: () => undefined,
  onStart: async () => undefined,
  onResume: async () => undefined,
  onCancel: () => undefined,
  onBrowseRoot: async () => null,
  ...overrides,
});

const model = (
  hybrid: HybridCatalogViewModel = { status: "ready", active },
  connection: CloudCatalogConnectionViewModel = { status: "authorized" },
): VerificationPageModel => ({
  i18n: createWorkbenchI18n("zh-CN"),
  rootPath: "/Synthetic-library",
  rootLocked: false,
  selectedGroupKeys: [GROUP_KEY],
  connection,
  hybrid,
  actions: actions(),
});

describe("verification page", () => {
  it("summarizes scope and safety before verification", () => {
    const root = testRoot();
    renderVerificationPage(root, model());

    expect(root.textContent).toContain("本次操作摘要");
    expect(root.textContent).toContain("不会下载 PDF");
    expect(root.textContent).toContain("252");
    expect(root.querySelector('[data-action="start-verification"]')).not.toBeNull();
  });

  it("fills the controller-owned verification root after an explicit directory choice", async () => {
    const root = testRoot();
    const onRootChange = vi.fn();
    const onBrowseRoot = vi.fn(async () => "/Synthetic/9-文学253册");
    renderVerificationPage(root, {
      ...model(),
      rootPath: "",
      actions: actions({ onRootChange, onBrowseRoot }),
    });

    const browse = root.querySelector<HTMLButtonElement>(
      '[data-action="browse-verification-root"]',
    )!;
    expect(browse.textContent).toBe("选择目录");
    expect(root.querySelector('[data-cloud-directory-current="true"]')?.textContent)
      .toContain("尚未选择目录");
    expect(root.querySelector<HTMLDetailsElement>("details[data-cloud-directory-advanced]")?.open)
      .toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-action="start-verification"]')?.disabled)
      .toBe(true);
    browse.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onBrowseRoot).toHaveBeenCalledOnce();
    expect(onRootChange).toHaveBeenCalledWith("/Synthetic/9-文学253册");
    expect(root.querySelector<HTMLInputElement>('[data-verification-root="true"]')?.value)
      .toBe("/Synthetic/9-文学253册");
    expect(root.querySelector<HTMLButtonElement>('[data-action="start-verification"]')?.disabled)
      .toBe(false);
  });

  it("does not expose a directory picker when the host has no picker factory", () => {
    const root = testRoot();
    const withoutBrowse = actions();
    const { onBrowseRoot: _onBrowseRoot, ...remainingActions } = withoutBrowse;
    renderVerificationPage(root, {
      ...model(),
      actions: remainingActions,
    });

    const choose = root.querySelector<HTMLButtonElement>(
      '[data-action="browse-verification-root"]',
    );
    expect(choose?.hidden).toBe(true);
    expect(choose?.disabled).toBe(true);
  });

  it("uses local non-root validation to gate start and resume without invoking either action", () => {
    const root = testRoot();
    const onStart = vi.fn(async () => undefined);
    const onResume = vi.fn(async () => undefined);
    renderVerificationPage(root, {
      ...model({
        status: "paused",
        active,
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-local-root-gate",
          status: "paused",
          stopReason: "time-limit",
          resumeAvailable: true,
          runOrdinal: 1,
          remainingGroupCount: 1,
          pdfCount: 1,
          directoryCount: 1,
          ignoredFileCount: 0,
          listRequestCount: 1,
          cumulativeListRequestCount: 1,
          selectedGroupCount: 1,
          completedGroupCount: 0,
          currentGroupIndex: 0,
          currentGroupKey: null,
          committedPdfCount: 0,
          committedPageCount: 0,
          completedDirectoryCount: 0,
          pendingDirectoryCount: 0,
        },
      }),
      rootPath: "",
      actions: actions({ onStart, onResume }),
    });
    const input = root.querySelector<HTMLInputElement>('[data-verification-root="true"]')!;
    const start = root.querySelector<HTMLButtonElement>('[data-action="start-verification"]')!;
    const resume = root.querySelector<HTMLButtonElement>('[data-action="resume-verification"]')!;

    expect(start.disabled).toBe(true);
    expect(resume.disabled).toBe(true);
    for (const invalid of ["/", "relative", "/Synthetic//Science"]) {
      input.value = invalid;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(start.disabled).toBe(true);
      expect(resume.disabled).toBe(true);
    }
    input.value = "/Synthetic";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(false);
    expect(resume.disabled).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("admits only one pending start or resume action at a time", async () => {
    const root = testRoot();
    let resolveStart!: () => void;
    let resolveResume!: () => void;
    const onStart = vi.fn(async () => new Promise<void>((resolve) => { resolveStart = resolve; }));
    const onResume = vi.fn(async () => new Promise<void>((resolve) => { resolveResume = resolve; }));
    renderVerificationPage(root, {
      ...model({
        status: "paused",
        active,
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-pending-action-gate",
          status: "paused",
          stopReason: "time-limit",
          resumeAvailable: true,
          runOrdinal: 1,
          remainingGroupCount: 1,
          pdfCount: 1,
          directoryCount: 1,
          ignoredFileCount: 0,
          listRequestCount: 1,
          cumulativeListRequestCount: 1,
          selectedGroupCount: 1,
          completedGroupCount: 0,
          currentGroupIndex: 0,
          currentGroupKey: null,
          committedPdfCount: 0,
          committedPageCount: 0,
          completedDirectoryCount: 0,
          pendingDirectoryCount: 0,
        },
      }),
      rootPath: "/Synthetic",
      actions: actions({ onStart, onResume }),
    });
    const start = root.querySelector<HTMLButtonElement>('[data-action="start-verification"]')!;
    const resume = root.querySelector<HTMLButtonElement>('[data-action="resume-verification"]')!;

    start.click();
    start.click();
    expect(onStart).toHaveBeenCalledOnce();
    expect(start.disabled).toBe(true);
    expect(resume.disabled).toBe(true);
    resolveStart();
    await vi.waitFor(() => expect(resume.disabled).toBe(false));

    resume.click();
    resume.click();
    expect(onResume).toHaveBeenCalledOnce();
    expect(start.disabled).toBe(true);
    expect(resume.disabled).toBe(true);
    resolveResume();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("renders scanning and cancellation controls", () => {
    const root = testRoot();
    const cancel = vi.fn();
    renderVerificationPage(root, {
      ...model({
        status: "scanning",
        active,
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-scanning",
          status: "paused",
          stopReason: "user-canceled",
          resumeAvailable: true,
          runOrdinal: 1,
          remainingGroupCount: 1,
          pdfCount: 10,
          directoryCount: 2,
          ignoredFileCount: 0,
          listRequestCount: 3,
          cumulativeListRequestCount: 3,
          selectedGroupCount: 1,
          completedGroupCount: 0,
          currentGroupIndex: 0,
          currentGroupKey: null,
          committedPdfCount: 0,
          committedPageCount: 0,
          completedDirectoryCount: 0,
          pendingDirectoryCount: 0,
        },
      }),
      actions: actions({ onCancel: cancel }),
    });

    expect(root.textContent).toContain("正在核验");
    expect(root.textContent).not.toContain("检查点与已完成");
    expect(root.textContent).not.toContain("用户已取消");
    root.querySelector<HTMLButtonElement>('[data-action="cancel-verification"]')?.click();
    expect(cancel).toHaveBeenCalledOnce();
    expect(root.textContent).toContain("正在取消");
    expect(root.textContent).not.toContain("检查点与已完成");
    expect(root.querySelector('[data-action="start-verification"]')).toBeNull();
  });

  it.each(["authorized", "scanning", "paused", "partial"] as const)(
    "treats %s as an authorization-capable connection lifecycle state",
    (status) => {
      const readyRoot = testRoot();
      renderVerificationPage(readyRoot, model({ status: "ready", active }, { status }));
      expect(readyRoot.querySelector<HTMLButtonElement>('[data-action="start-verification"]')?.disabled)
        .toBe(false);

      const resumeRoot = testRoot();
      renderVerificationPage(resumeRoot, model({
        status: "paused",
        active,
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: `batch-lifecycle-${status}`,
          status: "paused",
          stopReason: "time-limit",
          resumeAvailable: true,
          runOrdinal: 1,
          remainingGroupCount: 1,
          pdfCount: 1,
          directoryCount: 1,
          ignoredFileCount: 0,
          listRequestCount: 1,
          cumulativeListRequestCount: 1,
          selectedGroupCount: 1,
          completedGroupCount: 0,
          currentGroupIndex: 0,
          currentGroupKey: null,
          committedPdfCount: 0,
          committedPageCount: 0,
          completedDirectoryCount: 0,
          pendingDirectoryCount: 0,
        },
      }, { status }));
      expect(resumeRoot.querySelector<HTMLButtonElement>('[data-action="resume-verification"]')?.disabled)
        .toBe(false);
      expect(resumeRoot.textContent).not.toContain("当前无法完成授权");
    },
  );

  it("prioritizes current authorization failure over a stale hybrid error", () => {
    const root = testRoot();
    renderVerificationPage(root, {
      ...model({
        status: "paused",
        active,
        messageCode: "baidu-not-found",
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-auth-priority",
          status: "paused",
          stopReason: "baidu-not-found",
          resumeAvailable: true,
          runOrdinal: 1,
          remainingGroupCount: 1,
          pdfCount: 0,
          directoryCount: 0,
          ignoredFileCount: 0,
          listRequestCount: 1,
          cumulativeListRequestCount: 1,
          selectedGroupCount: 1,
          completedGroupCount: 0,
          currentGroupIndex: 0,
          currentGroupKey: null,
          committedPdfCount: 0,
          committedPageCount: 0,
          completedDirectoryCount: 0,
          pendingDirectoryCount: 0,
        },
      }, {
        status: "configured",
        messageCode: "authorization-attempt-expired",
      }),
      actionMessageCode: "hybrid-cloud-root-mismatch",
    });

    expect(root.textContent).toContain("无法完成授权");
    expect(root.textContent).toContain("前往设置");
    expect(root.textContent).not.toContain("路径不存在");
    expect(root.textContent).not.toContain("选择其 API 父目录");
    expect(root.querySelector('[data-action="resume-verification"]')).toBeNull();
  });

  it.each([
    [{ status: "unconfigured" } as const, "云端凭据不可用", "AppKey"],
    [{ status: "partial", messageCode: "baidu-token-expired" } as const, "授权已过期", "重新连接"],
    [undefined, "核验能力不可用", "正常版本"],
  ])("uses current revoked, expired, or missing capability state before stale hybrid recovery", (
    connection,
    expectedTitle,
    expectedAction,
  ) => {
    const root = testRoot();
    const staleHybrid: HybridCatalogViewModel = {
      status: "paused",
      active,
      messageCode: "baidu-not-found",
      batch: {
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-stale-fault",
        status: "paused",
        stopReason: "baidu-not-found",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 1,
        cumulativeListRequestCount: 1,
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    };
    renderVerificationPage(root, {
      ...model(staleHybrid),
      connection,
    });

    expect(root.textContent).toContain(expectedTitle);
    expect(root.textContent).toContain(expectedAction);
    expect(root.textContent).not.toContain("路径不存在");
    expect(root.querySelector<HTMLButtonElement>('[data-action="start-verification"]')?.disabled)
      .toBe(true);
    const resume = root.querySelector<HTMLButtonElement>('[data-action="resume-verification"]');
    if (connection?.status === "partial") expect(resume?.disabled).toBe(true);
    else expect(resume).toBeNull();
  });

  it("presents a fresh resume root mismatch as a correctable candidate", async () => {
    const root = testRoot();
    renderVerificationPage(root, {
      ...model({
        status: "paused",
        active,
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-root-mismatch",
          status: "paused",
          stopReason: "time-limit",
          resumeAvailable: true,
          runOrdinal: 1,
          remainingGroupCount: 1,
          pdfCount: 0,
          directoryCount: 0,
          ignoredFileCount: 0,
          listRequestCount: 1,
          cumulativeListRequestCount: 1,
          selectedGroupCount: 1,
          completedGroupCount: 0,
          currentGroupIndex: 0,
          currentGroupKey: null,
          committedPdfCount: 0,
          committedPageCount: 0,
          completedDirectoryCount: 0,
          pendingDirectoryCount: 0,
        },
      }),
      actionMessageCode: "hybrid-cloud-root-mismatch",
      selectedGroupKeys: [],
    });

    expect(root.textContent).toContain("开始新的核验：已选择 0 个分类");
    const resume = root.querySelector<HTMLButtonElement>('[data-action="resume-verification"]');
    expect(resume?.disabled).toBe(false);
    expect(root.textContent).toContain("恢复根目录不匹配");
    expect(root.textContent).toContain("修改候选父目录后再次恢复");
    const message = root.querySelector<HTMLElement>('[data-catalog-message="hybrid-cloud-root-mismatch"]');
    expect(message?.textContent).not.toContain("开始新的核验");
    expect(message?.textContent).not.toContain("hybrid-cloud-root-mismatch");
  });

  it("distinguishes unavailable capability, missing import, and active catalog while retaining safety scope", () => {
    const unavailable = testRoot();
    renderVerificationPage(unavailable, {
      ...model(),
      hybrid: undefined,
    });
    expect(unavailable.textContent).toContain("核验能力不可用");
    expect(unavailable.textContent).toContain("不会下载 PDF");
    expect(unavailable.textContent).toContain("API 父目录");
    expect(unavailable.textContent).toContain("最多 5 个");

    const notImported = testRoot();
    renderVerificationPage(notImported, model({ status: "empty" }));
    expect(notImported.textContent).toContain("请先导入本地 TXT 目录");
    expect(notImported.textContent).not.toContain("核验能力不可用");
    expect(notImported.textContent).toContain("不会下载 PDF");

    const ready = testRoot();
    renderVerificationPage(ready, model());
    expect(ready.textContent).toContain("可以开始核验");
  });

  it("freezes the root input when the current session owns a resumable root", () => {
    const root = testRoot();
    const rootChange = vi.fn();
    renderVerificationPage(root, {
      ...model({
        status: "paused",
        active,
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-root-locked",
          status: "paused",
          stopReason: "time-limit",
          resumeAvailable: true,
          runOrdinal: 1,
          remainingGroupCount: 1,
          pdfCount: 1,
          directoryCount: 1,
          ignoredFileCount: 0,
          listRequestCount: 1,
          cumulativeListRequestCount: 1,
          selectedGroupCount: 1,
          completedGroupCount: 0,
          currentGroupIndex: 0,
          currentGroupKey: null,
          committedPdfCount: 0,
          committedPageCount: 0,
          completedDirectoryCount: 0,
          pendingDirectoryCount: 0,
        },
      }),
      rootLocked: true,
      actions: actions({ onRootChange: rootChange }),
    });

    const input = root.querySelector<HTMLInputElement>('[data-verification-root="true"]')!;
    expect(input.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-action="browse-verification-root"]')?.disabled)
      .toBe(true);
    input.value = "/Changed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rootChange).not.toHaveBeenCalled();
  });

  it("shows exact paused progress and offers resume", () => {
    const root = testRoot();
    renderVerificationPage(root, model({
      status: "paused",
      active,
      batch: {
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-progress",
        status: "paused",
        stopReason: "list-request-limit",
        resumeAvailable: true,
        runOrdinal: 2,
        remainingGroupCount: 1,
        pdfCount: 200,
        directoryCount: 41,
        ignoredFileCount: 3,
        listRequestCount: 300,
        cumulativeListRequestCount: 427,
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    }));

    expect(root.textContent).toContain("已暂停");
    expect(root.textContent).toContain("300");
    expect(root.textContent).toContain("427");
    expect(root.textContent).toContain("达到列表请求上限");
    expect(root.querySelector('[data-action="resume-verification"]')).not.toBeNull();
  });

  it("shows a fixed not-found message without exposing runtime details", () => {
    const root = testRoot();
    renderVerificationPage(root, model({
      status: "partial",
      active,
      messageCode: "baidu-not-found",
      batch: {
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-not-found",
        status: "partial",
        stopReason: "baidu-not-found",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 1,
        cumulativeListRequestCount: 1,
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    }));

    expect(root.textContent).toContain("路径不存在");
    expect(root.textContent).toContain("本地目录");
    expect(root.textContent).toContain("父目录");
  });

  it("blocks verification while authorization is unavailable", () => {
    const root = testRoot();
    renderVerificationPage(root, model({ status: "ready", active }, {
      status: "configured",
      messageCode: "credentials-unavailable",
    }));

    expect(root.textContent).toContain("凭据");
    expect(root.querySelector<HTMLButtonElement>('[data-action="start-verification"]')?.disabled)
      .toBe(true);
  });

  it("shows translated local validation before an empty selection can start", () => {
    const root = testRoot();
    renderVerificationPage(root, {
      ...model(),
      selectedGroupKeys: [],
    });

    expect(root.textContent).toContain("开始新的核验前请选择分类");
    expect(root.querySelector<HTMLButtonElement>('[data-action="start-verification"]')?.disabled)
      .toBe(true);
  });

  it("renders controller-owned action errors without echoing their fixed code", () => {
    const root = testRoot();
    renderVerificationPage(root, {
      ...model(),
      actionMessageCode: "hybrid-cloud-root-mismatch",
    });

    expect(root.textContent).toContain("恢复根目录不匹配");
    expect(root.textContent).not.toContain("hybrid-cloud-root-mismatch");
  });

  it("presents a canceled checkpoint as preserved and resumable", () => {
    const root = testRoot();
    renderVerificationPage(root, model({
      status: "paused",
      active,
      batch: {
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-canceled",
        status: "paused",
        stopReason: "user-canceled",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 18,
        directoryCount: 4,
        ignoredFileCount: 0,
        listRequestCount: 5,
        cumulativeListRequestCount: 5,
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    }));

    expect(root.textContent).toContain("用户已取消");
    expect(root.textContent).toContain("检查点");
    expect(root.querySelector('[data-action="resume-verification"]')).not.toBeNull();
  });
});
