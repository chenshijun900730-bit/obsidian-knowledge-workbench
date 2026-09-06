// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createWorkbenchViewClass, renderWorkbench, type ItemViewConstructor } from "../../src/ui/workbench-view";
import { createQuickCaptureModalClass, type ModalConstructor } from "../../src/ui/quick-capture-modal";
import { createSettingsTabClass, type PluginSettingTabConstructor } from "../../src/ui/settings-tab";
import { createSettingsSectionsSurface } from "../../src/ui/settings-sections";
import {
  activateWorkbench,
  activateWorkbenchWithRetry,
  initializeIndexForLayout,
  initializeRecoveredLayout,
  LifecycleEpoch,
  requireActivatedWorkbench,
  RetryableAsyncGate,
  runVisibleHostAction,
  SurfacedHostError,
  surfaceVisibleHostError,
  WorkbenchViewActivationError,
} from "../../src/adapters/obsidian-workspace-adapter";
import type { App, WorkspaceLeaf } from "obsidian";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../src/runtime/safety-policy";
import { EMPTY_RECENT_CLOUD_DIRECTORIES } from "../../src/storage/recent-cloud-directories";
import { LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS } from "../../src/catalog/hybrid-catalog-types";

const INACTIVE_AUTO_RESUME = {
  autoResumeState: "inactive" as const,
  autoSegmentIndex: 0,
  autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
};
import {
  controllerFixture,
  manualProjectionScheduler,
  metadataAdapterFixture,
  noOpWorkbenchActions,
  populatedWorkbenchModel,
  quickCaptureFixture,
  TEST_CLOUD_VERIFICATION_ROOT_HASHER,
  TEST_HYBRID_ACTIVE_AUTHORITY,
  TEST_INACTIVE_HYBRID_EXECUTION,
  TEST_LARGE_BATCH_AUTHORITY,
  TEST_NEEDS_TXT_WORKFLOW,
  type ProjectionSchedulerDependency,
} from "../helpers/ui-fixtures";
import {
  FakeCloudCatalogConnectionRuntime,
  FakeCloudCatalogRuntime,
  FakeHybridCatalogRuntime,
} from "../fakes/fake-cloud-catalog-runtime";
import {
  HybridCatalogError,
} from "../../src/catalog/hybrid-catalog-types";
import type { LargeCatalogBatchSummary } from "../../src/catalog/hybrid-catalog-runtime";
import type { CatalogDisplayItem, CloudCatalogViewModel } from "../../src/catalog/cloud-catalog-runtime";
import type { CloudDirectorySelection } from "../../src/catalog/cloud-directory-selection";
import type { CloudDirectoryPickerPresenter } from "../../src/ui/cloud-directory-picker";
import { deriveCloudVerificationScope } from "../../src/catalog/cloud-verification-scope";
import type {
  FolderSelectionHostActions,
  FolderSelectionHostCapability,
  FolderSelectionRenderState,
} from "../../src/ui/folder-selection-host";

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

const libraryRecord = (index: number): CatalogDisplayItem => ({
  catalogId: `txt:${String(index).padStart(64, "0")}`,
  filename: `会话最近查看-${index}.pdf`,
  pathLabel: `/合成目录-${index}/会话最近查看-${index}.pdf`,
  cloudPathAvailable: false,
  verificationStatus: "unverified",
  differenceKinds: [],
  hierarchyTags: [`folder/合成目录-${index}`],
});

const libraryCatalog = (
  items: readonly CatalogDisplayItem[],
  query = "",
): CloudCatalogViewModel => ({
  ...populatedWorkbenchModel().catalog,
  status: "ready",
  source: "unified",
  pdfCount: 6,
  query,
  total: items.length,
  items,
});

const inlineFolderSelectionState = (): FolderSelectionRenderState => ({
  revision: 7,
  locale: "zh-CN",
  returnLabel: "返回云端核验",
  legacyProgressMode: "none",
  state: {
    phase: "local",
    purpose: { kind: "scan" },
    query: "科学",
    enabledSources: ["recent", "session-cache", "txt-group", "cloud-locator"],
    rankedCandidates: [],
    selectedPath: null,
    draftSelection: null,
    lookupDetail: null,
    browserPath: null,
    browserHighlightedPath: null,
    browserLayer: null,
    visibleBrowserDirectories: [],
    browserActivity: "idle",
    browserDetail: { round: null, fixedError: null },
    statusCode: null,
  },
});

const noOpFolderSelectionActions = (): FolderSelectionHostActions => ({
  onBack: () => undefined,
  onQuery: () => undefined,
  onToggleSource: () => undefined,
  onSelectCandidate: () => undefined,
  onUse: () => undefined,
  onBrowseOther: () => undefined,
  onConfirmLookup: () => undefined,
  onRevealRoot: () => undefined,
  onConfirmRoot: () => undefined,
  onBrowserAction: {
    onNavigate: () => undefined,
    onHighlight: () => undefined,
    onSelectCurrent: () => undefined,
    onSelectHighlighted: () => undefined,
    onSelectCategory: () => undefined,
    onContinue: () => undefined,
    onRetry: () => undefined,
    onCancel: () => undefined,
  },
});

describe("workbench", () => {
  it.each([
    [
      "zh-CN",
      ["今日", "快速记录", "查看笔记", "知识地图", "搜索知识地图", "选择详情", "AI 建议"],
      ["整理建议", "预览所选", "用 AI 解释所选关系"],
      ["筛选今日项目", "筛选知识地图节点", "聚焦知识图谱"],
    ],
    [
      "en",
      ["Today", "Quick capture", "Review note", "Knowledge map", "Search map", "Selection details", "AI suggestion"],
      ["Organization suggestions", "Preview selected", "Explain selected relation with AI"],
      ["Filter today items", "Filter map nodes", "Focused knowledge graph"],
    ],
  ] as const)("renders Today, map, suggestions, AI, and ARIA text in %s", (
    locale,
    overviewLabels,
    suggestionLabels,
    ariaLabels,
  ) => {
    const root = createTestDiv();
    const suggestion = {
      operation: {
        id: "suggestion",
        kind: "move" as const,
        sourcePath: "原文/Keep.md",
        targetPath: "Archive/Keep.md",
      },
      localRationale: {
        source: "local" as const,
        summary: "runtime rationale",
        signals: ["folder-rule"],
        confidence: "high" as const,
        impact: 80,
      },
      rationale: {
        source: "local" as const,
        summary: "runtime rationale",
        signals: ["folder-rule"],
        confidence: "high" as const,
        impact: 80,
      },
    };
    const base = {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" } as const,
      locale,
      aiSuggestion: { action: "summarize" as const, text: "MODEL-OUTPUT" },
      suggestions: [suggestion],
    };
    renderWorkbench(root, base, noOpWorkbenchActions());
    for (const label of overviewLabels) expect(root.textContent).toContain(label);
    for (const label of ariaLabels) expect(root.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    expect(root.textContent).toContain("MODEL-OUTPUT");

    renderWorkbench(root, { ...base, startSection: "suggestions" }, noOpWorkbenchActions());
    for (const label of suggestionLabels) expect(root.textContent).toContain(label);
    expect(root.textContent).toContain("原文/Keep.md");
    expect(root.querySelector<HTMLButtonElement>("button:disabled")).not.toBeNull();
  });

  it.each([
    ["task.txtContentUnchanged", "目录 TXT 内容没有变化，已保留当前书库绑定。"],
    ["task.txtImportFailed", "目录 TXT 未导入；现有目录保持不变。"],
    ["verification-must-pause", "请先暂停当前核验，再执行此操作。"],
    ["scan-must-cancel", "请先取消当前云端扫描，再执行此操作。"],
    ["cloud-authority-operation-busy", "另一项云端安全操作正在进行；请等待完成后重试。"],
    ["authorization-attempt-unavailable", "本次授权已失效，请从对应的重新连接或更换账号操作重新开始。"],
    ["folder-selection-preserved", "已保留已有核验进度。"],
    ["folder-selection-binding-failed", "操作未能完成；本地数据保持不变。"],
  ] as const)("localizes fixed task status %s on the shared workbench surface", (
    statusMessage,
    expected,
  ) => {
    const root = createTestDiv();
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      locale: "zh-CN",
      statusMessage,
    }, noOpWorkbenchActions());

    expect(root.querySelector('[role="status"]')?.textContent).toContain(expected);
  });

  it.each([
    ["zh-CN", "快速记录", "笔记标题", "创建", "取消"],
    ["en", "Quick capture", "Note title", "Create", "Cancel"],
  ] as const)("renders the quick-capture modal in %s with focus and Escape behavior", async (
    locale,
    title,
    field,
    create,
    cancel,
  ) => {
    class LocalizedModalSurface {
      readonly contentEl = createTestDiv();
      readonly titleEl = document.createElementNS("http://www.w3.org/1999/xhtml", "h2") as HTMLHeadingElement;
      constructor(readonly app: App) {}
      onOpen(): void {}
      onClose(): void {}
      open(): void { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
      close(): void { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
      setTitle(value: string): this { this.titleEl.textContent = value; return this; }
    }
    const QuickCaptureModal = createQuickCaptureModalClass(
      LocalizedModalSurface as unknown as ModalConstructor,
      () => locale,
    );
    const modal = new QuickCaptureModal({} as App);
    const result = modal.request();
    expect(modal.titleEl.textContent).toBe(title);
    expect(modal.contentEl.textContent).toContain(field);
    expect(modal.contentEl.textContent).toContain(create);
    expect(modal.contentEl.textContent).toContain(cancel);
    expect(document.activeElement).toBe(modal.contentEl.querySelector("input"));
    modal.contentEl.querySelector("form")?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await expect(result).resolves.toBeNull();
  });

  it("renders the More summary instead of a second settings surface", async () => {
    const root = createTestDiv();
    const startup = vi.fn(async () => undefined);
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        locale: "zh-CN" as const,
        openAtStartup: false,
        folderRules: [],
        excludedPrefixes: [],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        boundCloudLibrary: null,
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
      }),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: startup,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
    };
    const surface = createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    });

    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "overview" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, surface);

    expect(root.querySelectorAll("[data-settings-section]")).toHaveLength(0);
    expect(root.textContent).toContain("笔记改动");
    expect(root.textContent).toContain("高级功能");
    expect(startup).not.toHaveBeenCalled();
  });

  it("dispatches each legal temporary route without reviving the retired five-page shell", () => {
    const root = createTestDiv();
    const base = populatedWorkbenchModel();
    const settingsSurface = {
      render: (host: HTMLElement) => {
        const marker = host.ownerDocument.createElement("p");
        marker.dataset.settingsMarker = "true";
        host.append(marker);
      },
      dispose: () => undefined,
    };

    renderWorkbench(
      root,
      { ...base, route: { tab: "library" } },
      noOpWorkbenchActions(),
      NORMAL_RUNTIME_POLICY,
      settingsSurface,
    );
    expect(root.querySelector(".knowledge-workbench__cloud-catalog")).not.toBeNull();

    renderWorkbench(root, {
      ...base,
      route: { tab: "task", page: "overview" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, settingsSurface);
    expect(root.querySelector(".knowledge-workbench__task-page")).not.toBeNull();

    renderWorkbench(root, {
      ...base,
      route: { tab: "task", page: "category-selection" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, settingsSurface);
    expect(root.querySelector(".knowledge-workbench__category-page")).not.toBeNull();

    renderWorkbench(root, {
      ...base,
      route: { tab: "task", page: "folder-selection" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, settingsSurface);
    expect(root.querySelector(".knowledge-workbench__verification-page")).not.toBeNull();

    renderWorkbench(root, {
      ...base,
      route: { tab: "more", page: "history" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, settingsSurface);
    expect(root.textContent).toContain("暂无操作记录");

    renderWorkbench(root, {
      ...base,
      route: { tab: "more", page: "knowledge-tools" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, settingsSurface);
    expect(root.querySelector(".knowledge-workbench__start")).not.toBeNull();

    for (const page of [
      "connection",
      "catalog-data",
      "language",
      "advanced",
    ] as const) {
      renderWorkbench(root, {
        ...base,
        route: { tab: "more", page },
      }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, settingsSurface);
      expect(root.querySelector('[data-settings-marker="true"]')).not.toBeNull();
    }
  });

  it("disposes a rendered settings surface when switching subsection or leaving its route", () => {
    const root = createTestDiv();
    const render = vi.fn((host: HTMLElement) => {
      const marker = host.ownerDocument.createElement("p");
      marker.dataset.settingsMarker = "true";
      host.append(marker);
    });
    const dispose = vi.fn();
    const surface = { render, dispose };
    const base = populatedWorkbenchModel();

    renderWorkbench(root, {
      ...base,
      route: { tab: "more", page: "overview" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, surface);
    renderWorkbench(root, {
      ...base,
      route: { tab: "more", page: "connection" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, surface);

    renderWorkbench(root, {
      ...base,
      route: { tab: "more", page: "language" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, surface);

    expect(render).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();

    renderWorkbench(root, {
      ...base,
      route: { tab: "library" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, surface);
    renderWorkbench(root, {
      ...base,
      route: { tab: "library" },
    }, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY, surface);

    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("disposes the active settings surface once when the concrete view closes", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    fixture.controller.selectRoute({ tab: "more", page: "advanced" });
    const render = vi.fn();
    const dispose = vi.fn();
    const WorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new WorkbenchView(
      {} as WorkspaceLeaf,
      fixture.controller,
      { render, dispose },
    );

    await view.onOpen();
    expect(render).toHaveBeenCalledOnce();
    await view.onClose();
    await view.onClose();

    expect(dispose).toHaveBeenCalledOnce();
    fixture.controller.dispose();
  });

  it("maps the three shell destinations to their legal default routes", () => {
    const root = createTestDiv();
    const onSelectRoute = vi.fn();
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions({
      onSelectRoute,
    }));

    root.querySelector<HTMLButtonElement>('[data-workbench-page="task"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-workbench-page="more"]')?.click();

    expect(onSelectRoute.mock.calls).toEqual([
      [{ tab: "task", page: "overview" }],
      [{ tab: "more", page: "overview" }],
    ]);
  });

  it("keeps only five explicitly opened catalog details in a detached session MRU", () => {
    const root = createTestDiv();
    const base = populatedWorkbenchModel();
    const records = Array.from({ length: 7 }, (_, index) => libraryRecord(index + 1));
    const onSelectCatalogRecord = vi.fn();
    const actions = noOpWorkbenchActions({ onSelectCatalogRecord });
    const renderPage = (items: readonly CatalogDisplayItem[], query = "") => {
      renderWorkbench(root, {
        ...base,
        catalog: libraryCatalog(items, query),
        selectedCatalogId: null,
      }, actions);
    };

    for (const record of records.slice(0, 6)) {
      renderPage([record]);
      root.querySelector<HTMLElement>('[data-action="open-catalog-detail"]')?.click();
    }
    renderPage([records[2]!]);
    root.querySelector<HTMLElement>('[data-action="open-catalog-detail"]')?.click();
    renderPage([records[6]!]);
    renderPage([]);

    const recentText = root.textContent ?? "";
    expect(recentText).not.toContain(records[0]!.filename);
    expect(recentText).not.toContain(records[6]!.filename);
    for (const record of [records[1]!, records[2]!, records[3]!, records[4]!, records[5]!]) {
      expect(recentText).toContain(record.filename);
    }
    expect(recentText.indexOf(records[2]!.filename)).toBeLessThan(
      recentText.indexOf(records[5]!.filename),
    );
    expect(recentText.split(records[2]!.filename).length - 1).toBe(1);
    expect(onSelectCatalogRecord).toHaveBeenCalledTimes(7);

    renderPage([], "会话");
    expect(root.textContent).not.toContain(records[2]!.filename);
  });

  it("routes the library reminder only to the task overview", () => {
    const root = createTestDiv();
    const onSelectRoute = vi.fn();
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions({
      onSelectRoute,
    }));

    root.querySelector<HTMLButtonElement>('[data-action="open-library-task"]')?.click();

    expect(onSelectRoute).toHaveBeenCalledOnce();
    expect(onSelectRoute).toHaveBeenCalledWith({ tab: "task", page: "overview" });
  });

  it("clears the catalog-detail MRU when the concrete Workbench view closes", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const record = libraryRecord(8);
    const catalog = new FakeCloudCatalogRuntime(libraryCatalog([record]));
    const fixture = controllerFixture({ catalog });
    const WorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);

    await view.onOpen();
    view.contentEl.querySelector<HTMLElement>('[data-action="open-catalog-detail"]')?.click();
    await vi.waitFor(() => expect(fixture.controller.snapshot().selectedCatalogId)
      .toBe(record.catalogId));
    catalog.setSnapshot(libraryCatalog([]));
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain(record.filename));

    await view.onClose();
    await view.onOpen();
    expect(view.contentEl.textContent).not.toContain(record.filename);

    await view.onClose();
    fixture.controller.dispose();
  });

  it("renders the single-action task page on the task destination", () => {
    const root = createTestDiv();
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "overview" },
      suggestions: [{
        operation: { id: "legacy-suggestion", kind: "rename", sourcePath: "A.md", targetPath: "B.md" },
        localRationale: { source: "local", summary: "legacy", signals: [], confidence: "high", impact: 1 },
        rationale: { source: "local", summary: "legacy", signals: [], confidence: "high", impact: 1 },
      }],
    }, noOpWorkbenchActions());

    expect(root.querySelector(".knowledge-workbench__task-page")).not.toBeNull();
    expect(root.querySelectorAll("[data-task-primary]")).toHaveLength(1);
    expect(root.textContent).toContain("选择目录数据");
    expect(root.querySelector('[aria-label="Organization suggestions"]')).toBeNull();
  });

  it("keeps the real DOM TXT picker alive across an unrelated rerender and rejects a double click", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const hybrid = new FakeHybridCatalogRuntime({ status: "empty" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });
    fixture.controller.selectRoute({ tab: "task", page: "overview" });
    const WorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    expect(document.querySelector('[data-local-catalog-txt-host] input[type="file"]')).toBeNull();
    view.contentEl.querySelector<HTMLButtonElement>("[data-task-primary]")!.click();
    const picker = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-local-catalog-txt-host] input[type="file"]',
      );
      expect(input).not.toBeNull();
      return input!;
    });
    expect(picker.accept).toBe(".txt,text/plain");
    expect(fixture.controller.snapshot().taskActionPending).toBe(true);
    expect(view.contentEl.contains(picker)).toBe(false);
    view.contentEl.querySelector<HTMLButtonElement>("[data-task-primary]")!.click();
    expect(document.querySelectorAll('[data-local-catalog-txt-host] input[type="file"]')).toHaveLength(1);

    fixture.controller.searchCatalog("unrelated");
    await vi.waitFor(() => expect(picker.isConnected).toBe(true));
    expect(fixture.controller.snapshot().taskActionPending).toBe(true);
    picker.dispatchEvent(new Event("cancel"));
    await vi.waitFor(() => expect(fixture.controller.snapshot().taskActionPending).toBe(false));
    expect(hybrid.previewPaths).toEqual([]);

    await view.onClose();
    view.contentEl.remove();
    fixture.controller.dispose();
  });

  it("renders the injected folder page inline and disposes it before returning to verification", () => {
    const root = createTestDiv();
    const dispose = vi.fn();
    const render = vi.fn<FolderSelectionHostCapability["render"]>((host, state) => {
      const marker = host.ownerDocument.createElement("p");
      marker.dataset.inlineFolderSelection = "true";
      marker.textContent = `${state.returnLabel}:${state.revision}`;
      host.append(marker);
      return { dispose };
    });
    const capability: FolderSelectionHostCapability = { available: true, render };
    const folderSelectionActions = vi.fn(() => noOpFolderSelectionActions());
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "folder-selection" } as const,
      folderSelection: inlineFolderSelectionState(),
    };

    renderWorkbench(
      root,
      model,
      noOpWorkbenchActions({ folderSelectionActions }),
      NORMAL_RUNTIME_POLICY,
      undefined,
      capability,
    );

    expect(render).toHaveBeenCalledOnce();
    expect(folderSelectionActions).toHaveBeenCalledWith(7);
    expect(root.querySelector('[data-inline-folder-selection="true"]')?.textContent)
      .toBe("返回云端核验:7");
    expect(root.querySelector(".knowledge-workbench__verification-page")).toBeNull();

    renderWorkbench(
      root,
      { ...model, folderSelection: undefined },
      noOpWorkbenchActions(),
      NORMAL_RUNTIME_POLICY,
      undefined,
      capability,
    );

    expect(dispose).toHaveBeenCalledOnce();
    expect(root.querySelector(".knowledge-workbench__verification-page")).not.toBeNull();
  });

  it("never renders an injected normal folder page in read-only acceptance mode", () => {
    const root = createTestDiv();
    const render = vi.fn<FolderSelectionHostCapability["render"]>(() => ({
      dispose: () => undefined,
    }));

    renderWorkbench(
      root,
      {
        ...populatedWorkbenchModel(),
        route: { tab: "task", page: "folder-selection" },
        folderSelection: inlineFolderSelectionState(),
      },
      noOpWorkbenchActions({ folderSelectionActions: () => noOpFolderSelectionActions() }),
      READ_ONLY_ACCEPTANCE_POLICY,
      undefined,
      { available: true, render },
    );

    expect(render).not.toHaveBeenCalled();
    expect(root.querySelector(".knowledge-workbench__verification-page")).not.toBeNull();
  });

  it("falls back to the legacy verification page when inline actions are incomplete", () => {
    const root = createTestDiv();
    const render = vi.fn<FolderSelectionHostCapability["render"]>(() => ({
      dispose: () => undefined,
    }));

    renderWorkbench(
      root,
      {
        ...populatedWorkbenchModel(),
        route: { tab: "task", page: "folder-selection" },
        folderSelection: inlineFolderSelectionState(),
      },
      noOpWorkbenchActions(),
      NORMAL_RUNTIME_POLICY,
      undefined,
      { available: true, render },
    );

    expect(render).not.toHaveBeenCalled();
    expect(root.querySelector(".knowledge-workbench__verification-page")).not.toBeNull();
  });

  it("fills an empty verification draft without starting, resuming, or locating again", async () => {
    const root = createTestDiv();
    const groupKey = `group:${"d".repeat(64)}`;
    const onSetVerificationRoot = vi.fn();
    const onApplyVerificationDirectorySelection = vi.fn();
    const onStartSelectedVerification = vi.fn(async () => undefined);
    const onResumeSelectedVerification = vi.fn(async () => undefined);
    const selection: CloudDirectorySelection = {
      kind: "directory",
      selectedPath: "/Synthetic/Science",
      effectiveRoot: "/Synthetic/Science",
    };
    const onBrowseVerificationRoot = vi.fn(async () => selection);
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "folder-selection" } as const,
      verificationRoot: "",
      selectedVerificationGroupKeys: [groupKey],
      catalogConnection: { status: "authorized" as const },
      hybridCatalog: {
        ...TEST_INACTIVE_HYBRID_EXECUTION,
        status: "ready" as const,
        active: {
          ...TEST_HYBRID_ACTIVE_AUTHORITY,
          importedAt: 1,
          pdfCount: 1,
          unverifiedCount: 1,
          verifiedCount: 0,
          differenceCount: 0,
          cloudMissingCount: 0,
          groupCount: 1,
          verifiedGroupCount: 0,
          coveredCandidatePdfCount: 0,
          groups: [{
            groupKey,
            rootRelativePath: "Literature",
            label: "Literature",
            pdfCount: 1,
            mode: "recursive" as const,
            verificationStatus: "unverified" as const,
          }],
        },
      },
    };
    renderWorkbench(root, model, noOpWorkbenchActions({
      onSetVerificationRoot,
      onStartSelectedVerification,
      onResumeSelectedVerification,
      onBrowseVerificationRoot,
      onApplyVerificationDirectorySelection,
    }));

    const choose = root.querySelector<HTMLButtonElement>(
      '[data-action="browse-verification-root"]',
    )!;
    expect(choose.textContent).toBe("选择目录");
    choose.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onBrowseVerificationRoot).toHaveBeenCalledOnce();
    expect(onApplyVerificationDirectorySelection).toHaveBeenCalledWith(selection);
    expect(onSetVerificationRoot).not.toHaveBeenCalled();
    expect(onStartSelectedVerification).not.toHaveBeenCalled();
    expect(onResumeSelectedVerification).not.toHaveBeenCalled();
    expect(root.querySelector('[data-cloud-directory-current="true"]')?.textContent)
      .toContain("/Synthetic/Science");

    renderWorkbench(root, {
      ...model,
      locale: "en",
      verificationRoot: "/Synthetic/Science",
      verificationDirectorySelection: selection,
    },
      noOpWorkbenchActions());
    expect(root.querySelector('[data-cloud-directory-current="true"]')?.textContent)
      .toContain("/Synthetic/Science");
    expect(root.querySelector<HTMLInputElement>(`[data-group-key="${groupKey}"]`)?.checked)
      .toBe(true);
  });

  it("disposes the prior verification field on rerender so a late choice cannot change the draft", async () => {
    const root = createTestDiv();
    let resolveChoice!: (value: CloudDirectorySelection | null) => void;
    const onSetVerificationRoot = vi.fn();
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "folder-selection" } as const,
      verificationRoot: "/Synthetic/Existing",
      catalogConnection: { status: "authorized" as const },
      hybridCatalog: { ...TEST_INACTIVE_HYBRID_EXECUTION, status: "ready" as const },
    };
    const actions = noOpWorkbenchActions({
      onSetVerificationRoot,
      onBrowseVerificationRoot: async () => new Promise((resolve) => { resolveChoice = resolve; }),
    });
    renderWorkbench(root, model, actions);
    root.querySelector<HTMLButtonElement>('[data-action="browse-verification-root"]')?.click();

    renderWorkbench(root, { ...model, locale: "en" }, actions);
    resolveChoice({
      kind: "directory",
      selectedPath: "/Synthetic/Late",
      effectiveRoot: "/Synthetic/Late",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onSetVerificationRoot).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLInputElement>('[data-verification-root="true"]')?.value)
      .toBe("/Synthetic/Existing");
    expect(root.textContent).not.toContain("/Synthetic/Late");
  });

  it("preserves manual-root focus and caret across a verification rerender", () => {
    const root = createTestDiv();
    document.body.append(root);
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "folder-selection" } as const,
      verificationRoot: "/Synthetic/Existing",
      catalogConnection: { status: "authorized" as const },
      hybridCatalog: { ...TEST_INACTIVE_HYBRID_EXECUTION, status: "ready" as const },
    };
    const actions = noOpWorkbenchActions();
    renderWorkbench(root, model, actions);
    const input = root.querySelector<HTMLInputElement>('[data-verification-root="true"]')!;
    input.focus();
    input.setSelectionRange(4, 12, "forward");

    renderWorkbench(root, { ...model, locale: "en" }, actions);

    const replacement = root.querySelector<HTMLInputElement>('[data-verification-root="true"]')!;
    expect(document.activeElement).toBe(replacement);
    expect(replacement.selectionStart).toBe(4);
    expect(replacement.selectionEnd).toBe(12);
    expect(replacement.selectionDirection).toBe("forward");
    root.remove();
  });

  it("keeps the advanced verification-root editor open across controller input rerenders", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    fixture.controller.selectRoute({ tab: "task", page: "folder-selection" });
    const ConcreteWorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    const firstDetails = view.contentEl.querySelector<HTMLDetailsElement>(
      'details[data-cloud-directory-advanced="true"]',
    )!;
    firstDetails.open = true;
    const first = view.contentEl.querySelector<HTMLInputElement>(
      '[data-verification-root="true"]',
    )!;
    first.focus();
    first.value = "/S";
    first.setSelectionRange(2, 2, "none");
    first.dispatchEvent(new Event("input", { bubbles: true }));

    const secondDetails = view.contentEl.querySelector<HTMLDetailsElement>(
      'details[data-cloud-directory-advanced="true"]',
    )!;
    const second = view.contentEl.querySelector<HTMLInputElement>(
      '[data-verification-root="true"]',
    )!;
    expect(secondDetails.open).toBe(true);
    expect(document.activeElement).toBe(second);
    expect([second.selectionStart, second.selectionEnd]).toEqual([2, 2]);

    second.value = "/Science";
    second.setSelectionRange(8, 8, "none");
    second.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.contentEl.querySelector<HTMLDetailsElement>(
      'details[data-cloud-directory-advanced="true"]',
    )?.open).toBe(true);
    expect(fixture.controller.snapshot().verificationRoot).toBe("/Science");

    await view.onClose();
    view.contentEl.remove();
    fixture.controller.dispose();
  });

  it("preserves Task run details and focus while a new segment resets its quota", () => {
    const root = createTestDiv();
    document.body.append(root);
    const groupKey = `group:${"7".repeat(64)}`;
    const active = {
      ...TEST_HYBRID_ACTIVE_AUTHORITY,
      importedAt: 1,
      pdfCount: 68_959,
      coveredCandidatePdfCount: 11_870,
      unverifiedCount: 57_089,
      verifiedCount: 10_000,
      differenceCount: 1_870,
      cloudMissingCount: 0,
      groupCount: 24,
      verifiedGroupCount: 7,
      groups: [{
        groupKey,
        rootRelativePath: "Literature",
        label: "Literature",
        pdfCount: 252,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }],
    };
    const batch = (
      overrides: Partial<LargeCatalogBatchSummary> = {},
    ): LargeCatalogBatchSummary => ({
      ...TEST_LARGE_BATCH_AUTHORITY,
      batchId: "batch-rerender",
      status: "scanning",
      stopReason: null,
      resumeAvailable: false,
      runOrdinal: 1,
      selectedGroupCount: 1,
      completedGroupCount: 0,
      remainingGroupCount: 1,
      currentGroupIndex: 0,
      currentGroupKey: groupKey,
      pdfCount: 9_500,
      directoryCount: 120,
      ignoredFileCount: 3,
      listRequestCount: 27,
      cumulativeListRequestCount: 427,
      committedPdfCount: 11_870,
      committedPageCount: 14,
      completedDirectoryCount: 112,
      pendingDirectoryCount: 8,
      autoResumeState: "running",
      autoSegmentIndex: 1,
      autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
      ...overrides,
    });
    const firstModel = {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "overview" } as const,
      workflow: {
        kind: "running" as const,
        primaryAction: "pause" as const,
        titleKey: "workflow.running.title" as const,
        descriptionKey: "workflow.running.description" as const,
        recommendedGroup: null,
        canShowTechnicalDetails: true,
      },
      verificationRoot: "/Synthetic",
      selectedVerificationGroupKeys: [groupKey],
      catalogConnection: { status: "authorized" as const },
      hybridCatalog: { ...TEST_INACTIVE_HYBRID_EXECUTION, status: "scanning" as const, active, batch: batch() },
    };
    renderWorkbench(root, firstModel, noOpWorkbenchActions());
    const details = root.querySelector<HTMLDetailsElement>('[data-verification-run-details]')!;
    details.open = true;
    const summary = details.querySelector<HTMLElement>("summary")!;
    summary.focus();

    const nextSegmentModel = {
      ...firstModel,
      hybridCatalog: {
        ...TEST_INACTIVE_HYBRID_EXECUTION,
        status: "scanning" as const,
        active,
        batch: batch({
          runOrdinal: 2,
          pdfCount: 200,
          directoryCount: 2,
          ignoredFileCount: 0,
          listRequestCount: 1,
          cumulativeListRequestCount: 428,
          committedPdfCount: 12_070,
          committedPageCount: 15,
          completedDirectoryCount: 113,
          pendingDirectoryCount: 7,
          autoSegmentIndex: 2,
        }),
      },
    };
    renderWorkbench(root, nextSegmentModel, noOpWorkbenchActions());

    const rerendered = root.querySelector<HTMLDetailsElement>('[data-verification-run-details]')!;
    expect(rerendered.open).toBe(true);
    expect(document.activeElement).toBe(rerendered.querySelector("summary"));
    expect(rerendered.querySelector('[data-verification-run-requests]')?.textContent)
      .toContain("428");
    expect(root.querySelector<HTMLProgressElement>('[data-verification-segment-budget]')?.value)
      .toBe(200);
    expect(root.querySelector<HTMLProgressElement>('[data-verification-overall-progress]')?.value)
      .toBe(11_870);
    root.remove();
  });

  it("restores focus to the replacement choose button after selection rerenders the host", async () => {
    const root = createTestDiv();
    document.body.append(root);
    let currentModel = {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "folder-selection" } as const,
      verificationRoot: "",
      catalogConnection: { status: "authorized" as const },
      hybridCatalog: { ...TEST_INACTIVE_HYBRID_EXECUTION, status: "ready" as const },
    };
    let actions = noOpWorkbenchActions();
    const selection: CloudDirectorySelection = {
      kind: "directory",
      selectedPath: "/Synthetic/Chosen",
      effectiveRoot: "/Synthetic/Chosen",
    };
    actions = noOpWorkbenchActions({
      onBrowseVerificationRoot: async () => selection,
      onApplyVerificationDirectorySelection: (value) => {
        currentModel = {
          ...currentModel,
          verificationRoot: value.effectiveRoot,
          verificationDirectorySelection: value,
        };
        renderWorkbench(root, currentModel, actions);
      },
    });
    renderWorkbench(root, currentModel, actions);
    const choose = root.querySelector<HTMLButtonElement>(
      '[data-action="browse-verification-root"]',
    )!;
    choose.focus();
    choose.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement).toBe(root.querySelector(
      '[data-action="browse-verification-root"]',
    ));
    expect(root.textContent).toContain("/Synthetic/Chosen");
    root.remove();
  });

  it("keeps a controller-owned resume mismatch across runtime-driven full rerenders", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const groupKey = `group:${"e".repeat(64)}`;
    const active = {
      ...TEST_HYBRID_ACTIVE_AUTHORITY,
      importedAt: 1,
      pdfCount: 1,
      unverifiedCount: 1,
      verifiedCount: 0,
      differenceCount: 0,
      cloudMissingCount: 0,
      groupCount: 1,
      verifiedGroupCount: 0,
      coveredCandidatePdfCount: 0,
      groups: [{
        groupKey,
        rootRelativePath: "Science",
        label: "Science",
        pdfCount: 1,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }],
    };
    const binding = {
      schemaVersion: 1 as const,
      path: "/Wrong-candidate",
      sourceImportSha256: active.sourceImportSha256,
      verificationGeneration: 1,
    };
    const pausedBatch = {
      ...TEST_LARGE_BATCH_AUTHORITY,
      ...INACTIVE_AUTO_RESUME,
      verificationScope: deriveCloudVerificationScope(
        binding,
        TEST_CLOUD_VERIFICATION_ROOT_HASHER,
      ),
      selectedGroupKeys: [groupKey],
      batchId: "batch-paused",
      status: "paused" as const,
      stopReason: "time-limit" as const,
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
    };
    const hybrid = new FakeHybridCatalogRuntime({ status: "paused", active, batch: pausedBatch });
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: binding.verificationGeneration,
    });
    fixture.controller.setVerificationRoot("/Wrong-candidate");
    fixture.controller.selectRoute({ tab: "task", page: "folder-selection" });
    fixture.controller.toggleVerificationGroup(groupKey);
    hybrid.beforeResume = () => {
      hybrid.setSnapshot({ status: "scanning", active, batch: pausedBatch });
      hybrid.setSnapshot({
        status: "error",
        active,
        batch: pausedBatch,
        messageCode: "hybrid-cloud-root-mismatch",
      });
      throw new HybridCatalogError("hybrid-cloud-root-mismatch");
    };

    const ConcreteWorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();
    expect(view.contentEl.textContent).not.toContain("batch-paused");
    view.contentEl.querySelector<HTMLButtonElement>('[data-action="resume-verification"]')?.click();

    await vi.waitFor(() => {
      expect(view.contentEl.textContent).toContain("恢复根目录不匹配");
    });
    expect(view.contentEl.textContent).toContain("修改候选父目录后再次恢复");
    expect(view.contentEl.textContent).not.toContain("已保存的核验检查点不可用");

    hybrid.beforeResume = undefined;
    const input = view.contentEl.querySelector<HTMLInputElement>('[data-verification-root="true"]')!;
    input.value = "/Correct-candidate";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.contentEl.textContent).not.toContain("恢复根目录不匹配");
    expect(view.contentEl.textContent).not.toContain("已保存的核验检查点不可用");
    expect(fixture.controller.snapshot().verificationActionMessageCode).toBeUndefined();

    const correctedBinding = { ...binding, path: "/Correct-candidate" };
    const correctedBatch = {
      ...pausedBatch,
      verificationScope: deriveCloudVerificationScope(
        correctedBinding,
        TEST_CLOUD_VERIFICATION_ROOT_HASHER,
      ),
    };
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: correctedBinding,
    });

    hybrid.setSnapshot({
      status: "error",
      active,
      batch: correctedBatch,
      messageCode: "hybrid-cloud-root-mismatch",
    });
    expect(view.contentEl.textContent).not.toContain("恢复根目录不匹配");

    const scanProgress = {
      status: "scanning" as const,
      directoryCount: 8,
      completedDirectoryCount: 7,
      pdfCount: 25,
      ignoredFileCount: 2,
      pendingDirectoryCount: 1,
      listRequestCount: 13,
      elapsedMs: 900,
      budget: {
        maxPdfCount: 1_000,
        maxDirectoryCount: 20,
        maxListRequestCount: 25,
        maxDurationMs: 120_000,
      },
    };
    connection.setSnapshot({ status: "authorized", scanProgress });
    expect(view.contentEl.textContent).not.toContain("恢复根目录不匹配");

    connection.setSnapshot({ status: "partial", messageCode: "baidu-token-expired", scanProgress });
    expect(view.contentEl.textContent).toContain("授权已过期");
    expect(view.contentEl.textContent).not.toContain("恢复根目录不匹配");
    connection.setSnapshot({ status: "authorized", scanProgress: { ...scanProgress, listRequestCount: 14 } });
    expect(view.contentEl.textContent).toContain("恢复根目录不匹配");

    hybrid.setSnapshot({
      status: "error",
      active,
      batch: correctedBatch,
      messageCode: "hybrid-batch-invalid",
    });
    expect(view.contentEl.textContent).toContain("已保存的核验检查点不可用");
    hybrid.setSnapshot({ status: "paused", active, batch: correctedBatch });
    view.contentEl.querySelector<HTMLButtonElement>('[data-action="resume-verification"]')?.click();
    await vi.waitFor(() => expect(hybrid.resumeRoots).toEqual(["/Correct-candidate"]));

    await view.onClose();
    view.contentEl.remove();
    fixture.controller.dispose();
  });

  it("surfaces malformed non-empty roots for both Start and Resume without runtime calls", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const groupKey = `group:${"f".repeat(64)}`;
    const active = {
      ...TEST_HYBRID_ACTIVE_AUTHORITY,
      importedAt: 1,
      pdfCount: 1,
      unverifiedCount: 1,
      verifiedCount: 0,
      differenceCount: 0,
      cloudMissingCount: 0,
      groupCount: 1,
      verifiedGroupCount: 0,
      coveredCandidatePdfCount: 0,
      groups: [{
        groupKey,
        rootRelativePath: "Science",
        label: "Science",
        pdfCount: 1,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }],
    };
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active,
      batch: {
        ...TEST_LARGE_BATCH_AUTHORITY,
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-malformed-root",
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
    });
    let confirmationCalls = 0;
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime(
        {},
        new FakeCloudCatalogConnectionRuntime({ status: "authorized" }),
        hybrid,
      ),
      catalogLargeScanConfirmation: {
        request: async () => { confirmationCalls += 1; return true; },
      },
    });
    fixture.controller.setVerificationRoot("malformed-relative-root");
    fixture.controller.toggleVerificationGroup(groupKey);
    fixture.controller.selectRoute({ tab: "task", page: "folder-selection" });
    const ConcreteWorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    const start = view.contentEl.querySelector<HTMLButtonElement>('[data-action="start-verification"]');
    const resume = view.contentEl.querySelector<HTMLButtonElement>('[data-action="resume-verification"]');
    expect(start?.disabled).toBe(true);
    expect(resume?.disabled).toBe(true);
    expect(view.contentEl.textContent).toContain("请选择或输入合法的非根云端路径");
    start?.click();
    resume?.click();
    await Promise.resolve();

    expect(view.contentEl.textContent).not.toContain("malformed-relative-root");
    expect(confirmationCalls).toBe(0);
    expect(hybrid.startInputs).toEqual([]);
    expect(hybrid.resumeRoots).toEqual([]);
    await view.onClose();
    view.contentEl.remove();
    fixture.controller.dispose();
  });

  it("renders the exact acceptance banner before status and removes every AI and Quick Capture path", () => {
    const root = createTestDiv();
    const quickCapture = vi.fn();
    const ai = vi.fn();
    const model = {
      ...populatedWorkbenchModel(),
      aiSuggestion: { action: "summarize" as const, text: "stale private AI result" },
    };

    renderWorkbench(root, model, noOpWorkbenchActions({
      onQuickCapture: quickCapture,
      onSummarize: ai,
      onNameCluster: ai,
      onExplainRelation: ai,
      onSuggestLabels: ai,
    }), READ_ONLY_ACCEPTANCE_POLICY);

    expect(root.classList.contains("knowledge-workbench--read-only-acceptance")).toBe(true);
    expect(root.querySelector(".knowledge-workbench__shell")).not.toBeNull();
    const banner = root.querySelector<HTMLElement>('[data-acceptance-banner="true"]');
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toBe(
      "只读验收版本。快速记录、整理写入、撤销和 AI 均不可用。派生索引数据保存在插件数据文件中。",
    );
    const capture = root.querySelector<HTMLButtonElement>('[data-action="quick-capture"]');
    expect(capture).toBeNull();
    expect(quickCapture).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain("stale private AI result");
    expect(root.querySelector(".knowledge-workbench__ai-actions")).toBeNull();

    renderWorkbench(root, model, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY);
    expect(root.classList.contains("knowledge-workbench--read-only-acceptance")).toBe(false);
    expect(root.querySelector('[data-acceptance-banner="true"]')).toBeNull();
    expect(root.textContent).toContain("stale private AI result");
  });

  it("omits the suggestions AI explanation control in acceptance mode", () => {
    const root = createTestDiv();
    const suggestion = {
      operation: { id: "set-kind", kind: "set-owned-field" as const, path: "Notes/Alpha.md", field: "knowledge-workbench-kind" as const, before: { present: false } as const, after: { present: true, value: "note" } as const },
      localRationale: { source: "local" as const, summary: "Folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
      rationale: { source: "local" as const, summary: "Folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
    };
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" } as const,
      startSection: "suggestions" as const,
      suggestions: [suggestion],
    };
    renderWorkbench(root, model, noOpWorkbenchActions({
      onExplainRelation: vi.fn(),
    }), READ_ONLY_ACCEPTANCE_POLICY);
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent === "用 AI 解释所选关系")).toBe(false);
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent === "预览所选")).toBe(true);
  });

  it("renders every AI result as text-only under the exact AI suggestion label", () => {
    const root = createTestDiv();
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      aiSuggestion: { action: "summarize", text: '<img src=x onerror="globalThis.pwned=true">' },
    }, noOpWorkbenchActions());
    expect(root.textContent).toContain("AI 建议");
    expect(root.textContent).toContain("<img");
    expect(root.querySelector("img")).toBeNull();
  });

  it.each([
    ["zh-CN", false, "disabled", "当前版本不提供 AI。", "使用 AI 总结"],
    ["en", false, "disabled", "AI is unavailable in this build.", "Summarize with AI"],
    ["zh-CN", true, "service-unavailable", "AI 建议暂不可用；本地结果保持不变。", "使用 AI 总结"],
    ["en", true, "service-unavailable", "The AI suggestion is unavailable. Local results remain unchanged.", "Summarize with AI"],
  ] as const)("surfaces a safe fulfilled AI fallback in %s when enabled=%s", async (
    locale,
    aiEnabled,
    reason,
    expectedStatus,
    actionLabel,
  ) => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture({
      aiEnabled,
      aiClient: {
        complete: async () => { throw new Error("SECRET-RUNTIME-DETAIL"); },
      },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
    });
    await fixture.controller.setLocale(locale);
    fixture.controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    const localSuggestions = fixture.controller.refreshSuggestions();
    expect(localSuggestions.length).toBeGreaterThan(0);
    await fixture.controller.selectCenter({ kind: "document", id: "a" });
    const summarize = vi.spyOn(fixture.controller, "summarize");
    const ConcreteWorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === actionLabel)?.click();
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledOnce());
    await expect(summarize.mock.results[0]!.value).resolves.toEqual({
      kind: "local-fallback",
      reason,
    });
    await vi.waitFor(() => expect(view.contentEl.querySelector('[role="status"]')?.textContent)
      .toContain(expectedStatus));
    expect(view.contentEl.textContent).not.toContain("SECRET-RUNTIME-DETAIL");
    expect(fixture.controller.snapshot().suggestions).toEqual(localSuggestions);

    await view.onClose();
    view.contentEl.remove();
    fixture.controller.dispose();
  });

  it("routes explicit map AI actions using selected paths rather than note bodies", () => {
    const root = createTestDiv();
    const calls: unknown[] = [];
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" },
    }, noOpWorkbenchActions({
      onSummarize: (paths) => { calls.push(["summarize", [...paths]]); },
      onNameCluster: (paths) => { calls.push(["name-cluster", [...paths]]); },
      onExplainRelation: (paths, id) => { calls.push(["explain-relation", [...paths], id]); },
      onSuggestLabels: (paths) => { calls.push(["suggest-labels", [...paths]]); },
    }));
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "使用 AI 总结")?.click();
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "使用 AI 解释关系")?.click();
    expect(calls).toEqual([
      ["summarize", ["Notes/Alpha.md"]],
      ["explain-relation", ["Notes/Alpha.md"], undefined],
    ]);
  });
  it("renders equal Today and map regions with accessible labels", () => {
    const root = createTestDiv();
    renderWorkbench(root, {
      locale: "zh-CN" as const,
      status: "ready",
      route: { tab: "more", page: "knowledge-tools" },
      startSection: "overview",
      catalog: {
        status: "no-snapshot",
        source: "none",
        pdfCount: 0,
        verificationCounts: { unverified: 0, verified: 0, difference: 0, cloudMissing: 0 },
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
        total: 0,
        items: [],
      },
      pendingCatalogTxt: null,
      taskActionPending: false,
      taskActionRevision: 1,
      taskPauseRequested: false,
      boundLibraryPath: null,
      workflow: TEST_NEEDS_TXT_WORKFLOW,
      verificationRoot: "",
      verificationRootLocked: false,
      selectedVerificationGroupKeys: [],
      selectedCatalogId: null,
      catalogFiltersExpanded: false,
      todayFilter: "all",
      today: { newItems: [], continueItems: [], nextItems: [] },
      map: { nodes: [], edges: [], selected: null, truncated: false },
      mapFilter: "all",
      searchQuery: "",
      searchResults: [],
      scanProgress: { status: "idle", completed: 0, label: "Index" },
      mapProgress: { status: "idle", completed: 0, label: "Map" },
    }, {
      onSelectRoute: () => undefined,
      onSelectStartSection: () => undefined,
      onSelectTodayFilter: () => undefined,
      onSelectMapFilter: () => undefined,
      onOpenNote: () => undefined,
      onQuickCapture: () => undefined,
      onCancelScan: () => undefined,
      onCancelMap: () => undefined,
      onPin: () => undefined,
      onDismiss: () => undefined,
      onSearchMap: () => undefined,
      onSelectCenter: () => undefined,
      onPreviewSuggestion: () => undefined,
      onRetryScan: () => undefined,
      onSearchCatalog: () => undefined,
      onFilterCatalogFolder: () => undefined,
      onToggleCatalogStatus: () => undefined,
      onToggleCatalogDifference: () => undefined,
      onFilterCatalogGroup: () => undefined,
      onFilterCatalogTag: () => undefined,
      onToggleCatalogCloudMissing: () => undefined,
      onCatalogPage: () => undefined,
      onCopyCatalogFilename: () => undefined,
      onCopyCatalogPath: () => undefined,
      onOpenBaidu: () => undefined,
      onSelectCatalogRecord: () => undefined,
      onSetCatalogFiltersExpanded: () => undefined,
      onSetVerificationRoot: () => undefined,
      onToggleVerificationGroup: () => undefined,
      onStartSelectedVerification: async () => undefined,
      onResumeSelectedVerification: async () => undefined,
      onCancelSelectedVerification: () => undefined,
      onTaskPrimary: () => undefined,
      onTaskChooseDifferentCategory: () => undefined,
      onTaskSaveCategorySelection: () => undefined,
      onTaskCancelCategorySelection: () => undefined,
      onTaskOpenDetails: () => undefined,
    });
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(root.textContent).not.toContain("WorkbenchOrganization suggestionsOperation historyCloud CatalogSettings");
    expect(root.querySelector('[aria-label="今日"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="知识地图"]')).not.toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain("就绪");
  });

  it("labels the main page region with its selected navigation button", () => {
    const root = createTestDiv();
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions());
    const selected = root.querySelector<HTMLElement>('[data-workbench-page="library"]')!;
    const panel = root.querySelector<HTMLElement>("main")!;
    expect(panel.getAttribute("aria-labelledby")).toBe(selected.id);
  });

  it("keeps actions as native buttons with visible labels", () => {
    const root = createTestDiv();
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" },
    }, noOpWorkbenchActions());
    expect(root.querySelector(".knowledge-workbench__split")).not.toBeNull();
    for (const button of Array.from(root.querySelectorAll("button"))) {
      expect(button.textContent?.trim() || button.getAttribute("aria-label")).toBeTruthy();
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
    expect(root.querySelector(".knowledge-workbench__node--circle")?.textContent).toBe("Alpha");
    expect(root.querySelector(".knowledge-workbench__node--square")?.textContent).toBe("Beta");
    expect(root.querySelector(".knowledge-workbench__node--diamond")?.textContent).toBe("Systems");
    expect(root.querySelector(".knowledge-workbench__relation--confirmed")?.textContent).toContain("已确认");
    expect(root.querySelector(".knowledge-workbench__relation--inferred")?.textContent).toContain("推断");
    expect(root.querySelector(".knowledge-workbench__details")?.textContent).toContain("主题");
    expect(root.querySelector(".knowledge-workbench__details")?.textContent).toContain("关联节点");
  });

  it("moves navigation focus without selecting and preserves it across rendering", () => {
    const selected: string[] = [];
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    const actions = noOpWorkbenchActions({
      onSelectRoute: (route) => selected.push(route.tab),
    });
    document.body.append(root);
    renderWorkbench(root, model, actions);
    const first = root.querySelector<HTMLButtonElement>('[data-workbench-page="library"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(selected).toEqual([]);
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("more");
    renderWorkbench(root, { ...model, route: { tab: "more", page: "overview" } }, actions);
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("more");
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(selected).toEqual([]);
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("library");
    root.remove();
  });

  it("preserves map-search focus and selection across synchronous controller rerenders", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    fixture.controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    const ConcreteWorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    const first = view.contentEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    first.focus();
    first.value = "a";
    first.setSelectionRange(1, 1, "none");
    first.dispatchEvent(new Event("input", { bubbles: true }));
    const second = view.contentEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(second);
    expect([second.selectionStart, second.selectionEnd]).toEqual([1, 1]);

    second.value = "al";
    second.setSelectionRange(2, 2, "none");
    second.dispatchEvent(new Event("input", { bubbles: true }));
    const third = view.contentEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(third);
    expect([third.selectionStart, third.selectionEnd]).toEqual([2, 2]);
    expect(fixture.controller.snapshot().searchQuery).toBe("al");
    await view.onClose();
    view.contentEl.remove();
  });

  it("preserves the rebuilt Start section button focus after a controller-driven section change", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    fixture.controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    const ConcreteWorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    const before = view.contentEl.querySelector<HTMLButtonElement>('[data-start-section="suggestions"]')!;
    before.focus();
    before.click();
    const after = view.contentEl.querySelector<HTMLButtonElement>('[data-start-section="suggestions"]')!;

    expect(fixture.controller.snapshot().startSection).toBe("suggestions");
    expect(after).not.toBe(before);
    expect(after.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(after);

    await view.onClose();
    view.contentEl.remove();
  });

  it("preserves locale-control focus across the controller rerender after language change", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    const ConcreteWorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    const first = view.contentEl.querySelector<HTMLSelectElement>("[data-workbench-locale]")!;
    first.focus();
    first.value = "en";
    first.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(fixture.controller.snapshot().locale).toBe("en"));

    const second = view.contentEl.querySelector<HTMLSelectElement>("[data-workbench-locale]")!;
    expect(document.activeElement).toBe(second);
    await view.onClose();
    view.contentEl.remove();
  });

  it.each([
    ["zh-CN", "知识地图筛选失败"],
    ["en", "Map filter failed"],
  ] as const)("renders only a localized safe action failure in %s", async (locale, message) => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    await fixture.controller.setLocale(locale);
    fixture.controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    vi.spyOn(fixture.controller, "setMapFilter").mockRejectedValue(
      new Error("SECRET-RUNTIME-DETAIL"),
    );
    const ConcreteWorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();
    const map = view.contentEl.querySelector<HTMLElement>(".knowledge-workbench__map")!;
    const filter = Array.from(map.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === (locale === "zh-CN" ? "笔记" : "Notes"));
    expect(filter).toBeDefined();
    filter?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.contentEl.textContent).toContain(message);
    expect(view.contentEl.textContent).not.toContain("SECRET-RUNTIME-DETAIL");
    await view.onClose();
  });

  it("shows named cancel controls only while running and announces terminal state", () => {
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "running", completed: 3, total: 10, label: "Index" },
      mapProgress: { status: "running", completed: 500, label: "Map" },
    }, noOpWorkbenchActions());
    expect(Array.from(root.querySelectorAll("button")).map((button) => button.textContent)).toContain("取消索引");
    expect(Array.from(root.querySelectorAll("button")).map((button) => button.textContent)).toContain("取消知识地图");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("索引 正在运行");
    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "canceled", completed: 3, total: 10, label: "Index" },
    }, noOpWorkbenchActions());
    expect(root.querySelector('[role="status"]')?.textContent).toContain("索引 已取消");
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent?.startsWith("取消"))).toBe(false);
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent === "重试索引")).toBe(true);
  });

  it("announces simultaneous running and terminal scan/map states without hiding either", () => {
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "running", completed: 2, total: 4, label: "Index" },
      mapProgress: { status: "canceled", completed: 500, label: "Map" },
    }, noOpWorkbenchActions());
    expect(root.querySelector('[role="status"]')?.textContent).toContain("索引 正在运行");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("知识地图 已取消");
    expect(root.querySelector(".knowledge-workbench__progress-row")?.textContent).toContain("知识地图 已取消");

    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "error", completed: 2, total: 4, label: "Index" },
      mapProgress: { status: "running", completed: 1_000, label: "Map" },
    }, noOpWorkbenchActions());
    expect(root.querySelector('[role="status"]')?.textContent).toContain("索引 错误");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("知识地图 正在运行");
    expect(root.querySelector(".knowledge-workbench__progress-row")?.textContent).toContain("索引 错误");

    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "complete", completed: 4, total: 4, label: "Index" },
      mapProgress: { status: "idle", completed: 0, label: "Map" },
    }, noOpWorkbenchActions());
    expect(root.querySelector(".knowledge-workbench__progress-row")?.textContent).toContain("索引 已完成");
  });

  it("routes map search input and result selection through actions", () => {
    const root = createTestDiv();
    const searches: string[] = [];
    const selected: string[] = [];
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" },
    }, noOpWorkbenchActions({
      onSearchMap: (query) => searches.push(query),
      onSelectCenter: (center) => selected.push(center.id),
    }));
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(".knowledge-workbench__search li button")!.click();
    expect(searches).toEqual(["beta"]);
    expect(selected).toEqual(["a"]);
  });

  it("windows future result lists beyond 100 rows without losing later entries", () => {
    const root = createTestDiv();
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" } as const,
    };
    const searchResults = Array.from({ length: 150 }, (_, index) => ({
      documentId: `id-${index}`,
      path: `Notes/${index}.md`,
      title: `Result ${index}`,
      matchedBy: ["title"] as const,
    }));
    renderWorkbench(root, { ...model, searchResults }, noOpWorkbenchActions());
    const list = root.querySelector<HTMLElement>('.knowledge-workbench__search [data-total-rows="150"]')!;
    expect(list.textContent).toContain("Result 0");
    expect(list.textContent).not.toContain("Result 149");
    list.scrollTop = 10_000;
    list.dispatchEvent(new Event("scroll"));
    expect(list.textContent).toContain("Result 149");
    expect(list.querySelectorAll("li").length).toBeLessThanOrEqual(101);
  });

  it("routes a suggestion's primary action to preview without opening its note", () => {
    const root = createTestDiv();
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" } as const,
    };
    const previews: string[] = [];
    const opens: string[] = [];
    renderWorkbench(root, {
      ...model,
      today: {
        ...model.today,
        nextItems: [{
          ...model.today.newItems[0]!,
          reason: "high-confidence-suggestion",
          suggestionId: "suggestion-1",
          actionLabel: "Review suggestion",
        }],
      },
    }, noOpWorkbenchActions({
      onPreviewSuggestion: (id) => previews.push(id),
      onOpenNote: (path) => opens.push(path),
    }));
    Array.from(root.querySelectorAll<HTMLButtonElement>(".knowledge-workbench__today-item button"))
      .find((button) => button.textContent === "预览建议")?.click();
    expect(previews).toEqual(["suggestion-1"]);
    expect(opens).toEqual([]);
  });

  it("renders accessible organization suggestions and previews the selected subset", () => {
    const root = createTestDiv();
    const previews: string[][] = [];
    let selectionChanges = 0;
    const suggestion = {
      operation: { id: "set-kind", kind: "set-owned-field" as const, path: "Notes/Alpha.md", field: "knowledge-workbench-kind" as const, before: { present: false } as const, after: { present: true, value: "note" } as const },
      localRationale: { source: "local" as const, summary: "Confirm the folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
      rationale: { source: "local" as const, summary: "Confirm the folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
    };
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      route: { tab: "more", page: "knowledge-tools" },
      startSection: "suggestions",
      suggestions: [suggestion],
    }, noOpWorkbenchActions({
      onPreviewSuggestionIds: (ids) => previews.push([...ids]),
      onSuggestionSelectionChange: () => { selectionChanges += 1; },
    }));
    expect(root.querySelector('[aria-label="整理建议"]')).not.toBeNull();
    const preview = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "预览所选")!;
    expect(preview.disabled).toBe(true);
    const checkbox = root.querySelector<HTMLInputElement>('input[value="set-kind"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(selectionChanges).toBe(1);
    expect(preview.disabled).toBe(false);
    preview.click();
    expect(previews).toEqual([["set-kind"]]);
  });

  it("keeps passive snapshots coherent and coalesces index publications on one macrotask", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const before = fixture.controller.snapshot();
    const suggestionCalls = fixture.projection.suggestionCalls;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    fixture.index.publishRecords([{ ...first, path: "Notes/Latest.md", title: "Latest" }]);
    fixture.index.publishRecords([{ ...first, path: "Notes/Newest.md", title: "Newest" }]);

    expect(fixture.controller.snapshot()).toEqual(before);
    expect(notifications).toBe(0);
    expect(scheduler.pendingCount).toBe(2);
    scheduler.drain();
    expect(notifications).toBe(1);
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls + 1);
    expect(fixture.controller.snapshot().today.newItems).toContainEqual(expect.objectContaining({
      id: first.id,
      path: "Notes/Newest.md",
    }));
  });

  it("leaves an unobserved projection dirty until a freshness-barrier command", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const suggestionCalls = fixture.projection.suggestionCalls;
    const first = fixture.index.activeRecords()[0]!;

    fixture.index.publishRecords([{ ...first, path: "Notes/Newest.md", title: "Newest" }]);

    expect(scheduler.pendingCount).toBe(0);
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls);
    fixture.controller.searchMap("Newest");
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls + 1);
    expect(fixture.controller.snapshot().searchResults).toEqual([expect.objectContaining({
      documentId: first.id,
      path: "Notes/Newest.md",
    })]);
  });

  it("uses a quiet debounce with a 500 ms maximum wait", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    for (let index = 0; index < 10; index += 1) {
      fixture.index.publishRecords([{ ...first, path: `Notes/Burst-${index}.md`, title: `Burst ${index}` }]);
      scheduler.advanceBy(49);
    }
    fixture.index.publishRecords([{ ...first, path: "Notes/Burst-final.md", title: "Burst final" }]);
    scheduler.advanceBy(9);
    expect(notifications).toBe(0);
    scheduler.advanceBy(1);

    expect(notifications).toBe(1);
    expect(scheduler.pendingCount).toBe(0);
    expect(fixture.controller.snapshot().today.newItems).toContainEqual(expect.objectContaining({
      path: "Notes/Burst-final.md",
    }));
  });

  it("repeats an atomic projection when an index publication is synchronously re-entrant", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const first = fixture.index.activeRecords()[0]!;
    const suggestionCalls = fixture.projection.suggestionCalls;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    fixture.projection.beforeNextSuggestion = () => {
      fixture.index.publishRecords([{ ...first, path: "Notes/Reentrant-latest.md", title: "Reentrant latest" }]);
    };

    fixture.index.publishRecords([{ ...first, path: "Notes/Reentrant-intermediate.md", title: "Reentrant intermediate" }]);
    scheduler.drain();

    expect(notifications).toBe(1);
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls + 2);
    expect(fixture.controller.snapshot().today.newItems).toContainEqual(expect.objectContaining({
      path: "Notes/Reentrant-latest.md",
    }));
  });

  it("preserves the last coherent snapshot when projection fails and retries at a later barrier", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const before = fixture.controller.snapshot();
    const first = fixture.index.activeRecords()[0]!;
    fixture.controller.subscribe(() => undefined);
    fixture.projection.failNext = new Error("private projection detail");

    expect(() => fixture.index.publishRecords([
      { ...first, path: "Notes/Retry-current.md", title: "Retry current" },
    ])).not.toThrow();
    expect(() => scheduler.drain()).not.toThrow();

    const failed = fixture.controller.snapshot();
    expect(failed.today).toEqual(before.today);
    expect(failed.suggestions).toEqual(before.suggestions);
    expect(failed.statusMessage).toBe("Workbench projection refresh failed");
    fixture.controller.searchMap("Retry current");
    expect(fixture.controller.snapshot().searchResults).toEqual([expect.objectContaining({
      path: "Notes/Retry-current.md",
    })]);
  });

  it("isolates a throwing projection scheduler from index publication", () => {
    const scheduler: ProjectionSchedulerDependency = {
      now: () => 0,
      schedule: () => { throw new Error("scheduler unavailable"); },
      cancel: () => undefined,
    };
    const fixture = controllerFixture({ projectionScheduler: scheduler });
    const before = fixture.controller.snapshot();
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    expect(() => fixture.index.publishRecords([
      { ...first, path: "Notes/Scheduler-current.md", title: "Scheduler current" },
    ])).not.toThrow();
    expect(fixture.controller.snapshot()).toEqual(before);
    expect(notifications).toBe(0);
    fixture.controller.searchMap("Scheduler current");
    expect(fixture.controller.snapshot().searchResults).toHaveLength(1);
  });

  it("cancels owned projection timers and ignores callbacks that arrive after disposal", () => {
    const callbacks: (() => void)[] = [];
    let cancelCalls = 0;
    const scheduler: ProjectionSchedulerDependency = {
      now: () => 0,
      schedule(callback) {
        callbacks.push(callback);
        return callback;
      },
      cancel: () => { cancelCalls += 1; },
    };
    const fixture = controllerFixture({ projectionScheduler: scheduler });
    const suggestionCalls = fixture.projection.suggestionCalls;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    fixture.index.publishRecords([{ ...first, path: "Notes/Disposed.md", title: "Disposed" }]);
    expect(callbacks).toHaveLength(2);
    fixture.controller.dispose();
    expect(cancelCalls).toBe(2);
    for (const callback of callbacks) callback();
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls);
    expect(notifications).toBe(0);
  });

  it("refreshes a stale visible suggestion before allowing its preview action", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ activeIndex: true, projectionScheduler: scheduler.dependency });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const stale = fixture.controller.refreshSuggestions().find((suggestion) => (
      "path" in suggestion.operation && suggestion.operation.path === "Notes/Alpha.md"
    ))!;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const records = fixture.index.activeRecords().map((record) => record.id === "a"
      ? { ...record, kind: "note" as const, ownedFields: { "knowledge-workbench-kind": "note" as const } }
      : record);

    fixture.index.publishRecords(records);
    expect(notifications).toBe(0);
    expect((fixture.controller.snapshot().suggestions ?? []).map((value) => value.operation.id)).toContain(stale.operation.id);
    await fixture.controller.previewSuggestionIds([stale.operation.id]);

    expect(notifications).toBe(1);
    expect(fixture.changePreview.planCalls).toBe(0);
    expect((fixture.controller.snapshot().suggestions ?? []).map((value) => value.operation.id)).not.toContain(stale.operation.id);
  });

  it("invalidates a pending map immediately and refocuses only after deferred projection", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const firstRecord = fixture.index.activeRecords()[0]!;
    const firstMap = fixture.controller.selectCenter({ kind: "document", id: firstRecord.id });
    const updated = [{ ...firstRecord, path: "Notes/Map-current.md", title: "Map current" }];

    fixture.index.publishRecords(updated);
    expect(fixture.map.inputs).toHaveLength(1);
    await firstMap;
    expect(fixture.controller.snapshot().map.selected).toBeNull();
    scheduler.drain();
    expect(fixture.map.inputs).toHaveLength(2);
    expect(fixture.map.inputs[1]?.records.map((record) => record.path)).toEqual(["Notes/Map-current.md"]);
    fixture.map.resolve(1, firstRecord.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.controller.snapshot().map.selected?.path).toBe("Notes/Map-current.md");
  });

  it("terminates invalidated map progress when deferred projection fails and remains usable", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const [firstRecord, secondRecord] = fixture.index.activeRecords();
    const firstMap = fixture.controller.selectCenter({ kind: "document", id: firstRecord!.id });
    fixture.map.progress(0, 500);
    fixture.projection.failNext = new Error("private projection detail");

    fixture.index.publishRecords(fixture.index.activeRecords().map((record) => record.id === firstRecord!.id
      ? { ...record, path: "Notes/Projection-fails.md", title: "Projection fails" }
      : record));
    await firstMap;
    expect(() => scheduler.drain()).not.toThrow();

    const failed = fixture.controller.snapshot();
    expect(failed.statusMessage).toBe("Workbench projection refresh failed");
    expect(failed.statusMessage).not.toContain("private");
    const nextMap = fixture.controller.selectCenter({ kind: "document", id: secondRecord!.id });
    expect(fixture.map.inputs.at(-1)?.center).toEqual({ kind: "document", id: secondRecord!.id });
    fixture.controller.cancelMap();
    await nextMap;
    expect(fixture.controller.snapshot().mapProgress.status).toBe("canceled");
    expect(failed.mapProgress).toMatchObject({ status: "canceled", completed: 500 });
  });

  it("consumes pending projection timers at a freshness barrier and refocuses the current center once", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const firstRecord = fixture.index.activeRecords()[0]!;
    const firstMap = fixture.controller.selectCenter({ kind: "document", id: firstRecord.id });
    const updated = [{ ...firstRecord, path: "Notes/Barrier-current.md", title: "Barrier current" }];

    fixture.index.publishRecords(updated);
    expect(fixture.map.inputs).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(2);
    fixture.controller.searchMap("current");

    expect(scheduler.pendingCount).toBe(0);
    expect(fixture.map.inputs).toHaveLength(2);
    expect(fixture.map.inputs[1]?.records.map((record) => record.path)).toEqual(["Notes/Barrier-current.md"]);
    scheduler.drain();
    expect(fixture.map.inputs).toHaveLength(2);
    await firstMap;
    fixture.map.resolve(1, firstRecord.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.controller.snapshot().map.selected?.path).toBe("Notes/Barrier-current.md");
  });

  it("projects unresolved suggestions into Today and removes them after confirmation", async () => {
    const fixture = controllerFixture({ activeIndex: true });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const suggestions = fixture.controller.refreshSuggestions();
    expect(suggestions.map((value) => value.operation.kind)).toContain("set-owned-field");
    expect(fixture.controller.snapshot().today.nextItems[0]).toMatchObject({
      suggestionId: suggestions[0]?.operation.id,
      actionLabel: "Review property",
    });
    await fixture.controller.previewSuggestionIds([suggestions[0]!.operation.id]);
    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.controller.snapshot().suggestions).toEqual([]);
    expect(fixture.controller.snapshot().today.nextItems).toEqual([]);
    expect(fixture.controller.snapshot().statusMessage).toBe("Changes completed");
    expect(fixture.transactions.calls).toHaveLength(1);
    expect(fixture.vault.writeCalls).toEqual([]);
  });

  it("persists sample acknowledgement without enabling writes", async () => {
    const fixture = controllerFixture();
    await fixture.controller.previewSampleChange();
    expect(fixture.changePreview.sampleCalls).toBe(1);
    expect(fixture.store.settings()).toMatchObject({ writePreviewAcknowledged: true, writeEnabled: false });
  });

  it("carries AI display wording with an immutable local plan-safety baseline", async () => {
    const fixture = controllerFixture({
      activeIndex: true,
      rationaleEnhancer: () => ({
        source: "ai-assisted",
        summary: "AI display wording",
        signals: ["invented"],
        confidence: "high",
        impact: Number.POSITIVE_INFINITY,
      }),
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const suggestion = fixture.controller.refreshSuggestions()[0]!;
    expect(suggestion.rationale).toMatchObject({ source: "ai-assisted", summary: "AI display wording", impact: 80 });
    expect(suggestion.localRationale).toMatchObject({ source: "local", impact: 80 });
    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);
    expect(fixture.changePreview.lastPreview?.plan.rationales[suggestion.operation.id]).toEqual(suggestion.localRationale);
    expect(fixture.changePreview.lastPreview?.plan.localRationales[suggestion.operation.id]).toMatchObject({
      source: "local",
      impact: 80,
    });
    expect(fixture.controller.snapshot().today.nextItems).toEqual([]);
  });

  it("delegates quick capture without changing plugin data", async () => {
    const fixture = controllerFixture();
    const before = fixture.store.operational();
    await fixture.controller.startQuickCapture();
    expect(fixture.quickCapture.calls).toBe(1);
    expect(fixture.store.operational()).toEqual(before);
  });

  it("refreshes once after pin or dismissal persistence succeeds", async () => {
    const fixture = controllerFixture();
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    await fixture.controller.pin("a");
    await fixture.controller.dismiss("b", 10);
    expect(emissions).toBe(2);
  });

  it("keeps snapshot and emissions unchanged when pin or dismissal persistence fails", async () => {
    const fixture = controllerFixture();
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    const before = fixture.controller.snapshot();
    fixture.store.failNext = new Error("save failed");
    await expect(fixture.controller.pin("a")).rejects.toThrow("save failed");
    fixture.store.failNext = new Error("save failed");
    await expect(fixture.controller.dismiss("b", 10)).rejects.toThrow("save failed");
    expect(emissions).toBe(0);
    expect(fixture.controller.snapshot()).toEqual(before);
  });

  it("uses one initial scan promise and resumes only after successful promotion", async () => {
    const fixture = controllerFixture({ pauseScan: true });
    const first = fixture.controller.startInitialScan();
    const duplicate = fixture.controller.startInitialScan();
    expect(first).toBe(duplicate);
    await Promise.resolve();
    expect(fixture.index.buildCalls).toBe(1);
    expect(fixture.queue.pauseCalls).toBe(1);
    fixture.index.resolveScan();
    await first;
    expect(fixture.queue.resumeCalls).toBe(1);
    expect(fixture.controller.snapshot().scanProgress.status).toBe("complete");
  });

  it("keeps initial scan single-flight even when a subscriber retries reentrantly", async () => {
    const fixture = controllerFixture({ pauseScan: true });
    let nested: Promise<void> | null = null;
    fixture.controller.subscribe(() => {
      if (nested === null && fixture.controller.snapshot().scanProgress.status === "running") {
        nested = fixture.controller.startInitialScan();
      }
    });
    const first = fixture.controller.startInitialScan();
    expect(nested).toBe(first);
    await Promise.resolve();
    expect(fixture.index.buildCalls).toBe(1);
    fixture.index.resolveScan();
    await first;
  });

  it("announces and cancels long scan and map calculations", async () => {
    const fixture = controllerFixture({ pauseScan: true, pauseMap: true });
    const scan = fixture.controller.startInitialScan();
    expect(fixture.controller.snapshot().scanProgress.status).toBe("running");
    fixture.controller.cancelScan();
    await scan;
    expect(fixture.controller.snapshot().scanProgress.status).toBe("canceled");
    expect(fixture.queue.resumeCalls).toBe(0);
    const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
    fixture.controller.cancelMap();
    await map;
    expect(fixture.controller.snapshot().mapProgress.status).toBe("canceled");
  });

  it("resumes buffered events after canceled or failed scans only with a prior active index", async () => {
    const canceled = controllerFixture({ pauseScan: true, activeIndex: true });
    const scan = canceled.controller.startInitialScan();
    canceled.controller.cancelScan();
    await scan;
    expect(canceled.queue.resumeCalls).toBe(1);

    const failed = controllerFixture({ scanError: new Error("scan failed"), activeIndex: true });
    await failed.controller.startInitialScan();
    expect(failed.controller.snapshot().scanProgress.status).toBe("error");
    expect(failed.queue.resumeCalls).toBe(1);

    const empty = controllerFixture({ scanError: new Error("scan failed") });
    await empty.controller.startInitialScan();
    expect(empty.queue.resumeCalls).toBe(0);
  });

  it("keeps promoted data active and reports an error when queue flushing fails", async () => {
    const fixture = controllerFixture({ flushError: new Error("flush failed") });
    await fixture.controller.startInitialScan();
    expect(fixture.store.activeIndex()).not.toBeNull();
    expect(fixture.controller.snapshot().scanProgress.status).toBe("error");
  });

  it("lets only the latest map request publish progress, result, and completion", async () => {
    const fixture = controllerFixture({ pauseMap: true });
    const first = fixture.controller.selectCenter({ kind: "document", id: "a" });
    const second = fixture.controller.selectCenter({ kind: "document", id: "b" });
    fixture.map.progress(0, 500);
    fixture.map.progress(1, 1_000);
    fixture.map.resolve(1, "b");
    await second;
    fixture.map.reject(0, new Error("stale failure"));
    await first;
    const snapshot = fixture.controller.snapshot();
    expect(snapshot.map.selected?.nodeId).toBe("b");
    expect(snapshot.mapProgress).toMatchObject({ status: "complete", completed: 1_000 });
  });

  it("publishes only the first and 50,000-delta map checkpoints while isolating listeners", async () => {
    const fixture = controllerFixture({ pauseMap: true });
    const publications: { status: string; completed: number }[] = [];
    fixture.controller.subscribe(() => { throw new Error("listener failed"); });
    fixture.controller.subscribe(() => {
      const progress = fixture.controller.snapshot().mapProgress;
      publications.push({ status: progress.status, completed: progress.completed });
    });
    const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
    publications.length = 0;

    fixture.map.progress(0, 500);
    fixture.map.progress(0, 1_000);
    fixture.map.progress(0, 50_000);
    fixture.map.progress(0, 50_500);
    fixture.map.resolve(0, "a");
    await map;

    expect(publications).toEqual([
      { status: "running", completed: 500 },
      { status: "running", completed: 50_500 },
      { status: "complete", completed: 50_500 },
    ]);
    expect(fixture.controller.snapshot().mapProgress).toMatchObject({
      status: "complete",
      completed: 50_500,
    });
  });

  it.each(["canceled", "error"] as const)(
    "publishes the latest completed count for a %s map and ignores stale callbacks",
    async (terminal) => {
      const fixture = controllerFixture({ pauseMap: true });
      const publications: { status: string; completed: number }[] = [];
      fixture.controller.subscribe(() => { throw new Error("listener failed"); });
      fixture.controller.subscribe(() => {
        const progress = fixture.controller.snapshot().mapProgress;
        publications.push({ status: progress.status, completed: progress.completed });
      });
      const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
      publications.length = 0;

      for (const completed of [500, 1_000, 50_000, 50_500]) {
        fixture.map.progress(0, completed);
      }
      if (terminal === "canceled") fixture.controller.cancelMap();
      else fixture.map.reject(0, new Error("private map detail"));
      await map;

      expect(publications).toEqual([
        { status: "running", completed: 500 },
        { status: "running", completed: 50_500 },
        { status: terminal, completed: 50_500 },
      ]);
      const publicationCount = publications.length;
      fixture.map.progress(0, 100_500);
      expect(publications).toHaveLength(publicationCount);
      const snapshot = fixture.controller.snapshot();
      expect(snapshot.mapProgress).toMatchObject({ status: terminal, completed: 50_500 });
      if (terminal === "error") {
        expect(snapshot.statusMessage).toBe("Map calculation failed");
        expect(snapshot.statusMessage).not.toContain("private");
      }

      const nextMap = fixture.controller.selectCenter({ kind: "document", id: "b" });
      fixture.map.progress(1, 500);
      expect(publications.at(-1)).toEqual({ status: "running", completed: 500 });
      fixture.controller.cancelMap();
      await nextMap;
    },
  );

  it("searches indexed records, refocuses a selected result, and recomputes filters", async () => {
    const fixture = controllerFixture();
    fixture.controller.searchMap("alpha");
    expect(fixture.controller.snapshot().searchResults.map((result) => result.documentId)).toEqual(["a"]);
    await fixture.controller.selectCenter({ kind: "document", id: "a" });
    await fixture.controller.setMapFilter("reference");
    expect(fixture.map.inputs.map((input) => input.filter)).toEqual(["all", "reference"]);
  });

  it("returns detached snapshots and emits nothing after disposal", async () => {
    const fixture = controllerFixture({ pauseMap: true });
    const snapshot = fixture.controller.snapshot() as unknown as { searchResults: unknown[] };
    snapshot.searchResults.push("corruption");
    expect(fixture.controller.snapshot().searchResults).toEqual([]);
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
    fixture.controller.dispose();
    expect(fixture.quickCapture.disposeCalls).toBe(1);
    fixture.map.resolve(0, "a");
    await map;
    expect(emissions).toBe(1);
  });

  it("aborts scans on disposal without resuming buffered work or emitting afterward", async () => {
    const fixture = controllerFixture({ pauseScan: true, activeIndex: true });
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    const scan = fixture.controller.startInitialScan();
    await Promise.resolve();
    const beforeDispose = emissions;
    fixture.controller.dispose();
    await scan;
    expect(fixture.queue.resumeCalls).toBe(0);
    expect(emissions).toBe(beforeDispose);
  });

  it("fences exclusion continuation when disposal happens while it awaits a scan", async () => {
    const fixture = controllerFixture({ pauseScan: true, activeIndex: true });
    const scan = fixture.controller.startInitialScan();
    await Promise.resolve();
    const pauseCalls = fixture.queue.pauseCalls;
    const update = fixture.controller.setExcludedPrefixes(["Archive"]);
    fixture.controller.dispose();
    await update;
    await scan;
    expect(fixture.queue.pauseCalls).toBe(pauseCalls);
    expect(fixture.index.reconcileCalls).toBe(0);
    expect(fixture.store.settings().excludedPrefixes).toEqual([]);
  });

  it("recovers a prior active queue and exposes retryable errors when exclusion persistence fails", async () => {
    const prior = controllerFixture({ activeIndex: true });
    prior.store.failNext = new Error("settings unavailable");
    await expect(prior.controller.setExcludedPrefixes(["Archive"])).rejects.toThrow("settings unavailable");
    expect(prior.queue.resumeCalls).toBe(1);
    expect(prior.controller.snapshot()).toMatchObject({ status: "error" });

    const empty = controllerFixture();
    empty.store.failNext = new Error("settings unavailable");
    await expect(empty.controller.setExcludedPrefixes(["Archive"])).rejects.toThrow("settings unavailable");
    expect(empty.queue.resumeCalls).toBe(0);
    expect(empty.controller.snapshot()).toMatchObject({ status: "error" });
  });

  it("recovers a prior active queue when exclusion reconciliation fails", async () => {
    const fixture = controllerFixture({ activeIndex: true, reconcileError: new Error("reconcile failed") });
    await expect(fixture.controller.setExcludedPrefixes(["Archive"])).rejects.toThrow("reconcile failed");
    expect(fixture.queue.resumeCalls).toBe(1);
    expect(fixture.controller.snapshot()).toMatchObject({ status: "error" });
  });

  it("aborts an old-record map and recomputes the current center after index records change", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const first = fixture.controller.selectCenter({ kind: "document", id: "a" });
    const updated = [{
      ...fixture.index.activeRecords()[0]!,
      path: "Notes/Alpha moved.md",
      title: "Alpha moved",
    }];
    fixture.index.publishRecords(updated);
    expect(fixture.map.inputs).toHaveLength(1);
    await first;
    scheduler.drain();
    expect(fixture.map.inputs).toHaveLength(2);
    expect(fixture.map.inputs[1]?.records.map((record) => record.path)).toEqual(["Notes/Alpha moved.md"]);
    fixture.map.resolve(1, "a");
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.controller.snapshot().map.selected?.path).toBe("Notes/Alpha moved.md");
  });

  it("persists folder rules, file-open time, and exclusions only through controller safety paths", async () => {
    const fixture = controllerFixture();
    await fixture.controller.applyFolderRules([{ prefix: "References", kind: "reference" }]);
    expect(fixture.store.settings().folderRules).toEqual([{ prefix: "References", kind: "reference" }]);
    expect(fixture.store.settings()).toMatchObject({ writeEnabled: false, writePreviewAcknowledged: false });
    expect(fixture.index.reconcileCalls).toBe(0);
    await fixture.controller.recordFileOpen("Notes/Alpha.md");
    expect(fixture.store.operational().lastOpened).toEqual({ a: 100 });
    await fixture.controller.setExcludedPrefixes(["Archive"]);
    expect(fixture.store.settings().excludedPrefixes).toEqual(["Archive"]);
    expect(fixture.index.reconcileCalls).toBe(1);
    expect(fixture.queue.pauseCalls).toBe(2);
    expect(fixture.queue.resumeCalls).toBe(1);
  });

  it("records a Markdown file-open before initial promotion and projects it when the record arrives", async () => {
    const fixture = controllerFixture();
    await fixture.controller.recordFileOpen(".\\Notes\\New.md");
    expect(fixture.store.operational().lastOpened).toEqual({ "Notes/New.md": 100 });
    const before = fixture.controller.snapshot();
    fixture.index.publishRecords([{
      ...fixture.index.activeRecords()[0]!,
      id: "Notes/New.md",
      path: "Notes/New.md",
      basename: "New",
      title: "New",
      mtime: 10,
      ownedFields: { "knowledge-workbench-kind": "note" },
    }]);
    expect(fixture.controller.snapshot()).toEqual(before);
    fixture.controller.refreshSuggestions();
    expect(fixture.controller.snapshot().today.continueItems).toContainEqual(expect.objectContaining({
      id: "Notes/New.md",
      reason: "recently-opened",
    }));
  });

  it("bootstraps metadata readiness both before and after the global resolved event", async () => {
    const after = metadataAdapterFixture({ resolved: true });
    after.adapter.startMetadataTracking();
    expect(await after.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);

    const before = metadataAdapterFixture({ resolved: false });
    before.adapter.startMetadataTracking();
    expect(await before.adapter.inboundLinks("Target.md")).toBeNull();
    before.resolveAll();
    expect(await before.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);
    expect(before.events).toContainEqual({ kind: "modify", path: "Source.md" });
  });

  it("resolves headings, aliases, and frontmatter links to destination paths", async () => {
    const fixture = metadataAdapterFixture({
      resolved: true,
      sourceLinks: ["Target#A heading|an alias"],
      frontmatterLinks: ["Different|label", "Missing"],
      destinations: {
        "Target": "Library/Target.md",
        "Different": "Different.md",
      },
    });
    fixture.adapter.startMetadataTracking();
    const note = await fixture.adapter.readNote("Source.md");
    expect(note?.outgoingLinks).toEqual(["Different.md", "Library/Target.md"]);
    expect(note?.basename).toBe("Source");
  });

  it("reindexes changed and resolved metadata without treating unresolved text as a path", async () => {
    const fixture = metadataAdapterFixture({ resolved: true, sourceLinks: ["Missing"] });
    fixture.adapter.startMetadataTracking();
    fixture.change("Source.md", ["Target"]);
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    expect((await fixture.adapter.readNote("Source.md"))?.outgoingLinks).toEqual(["Target.md"]);
    fixture.resolve("Source.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);
    expect(fixture.events.filter((event) => event.kind === "modify" && event.path === "Source.md")).toHaveLength(2);
  });

  it("does not clear a pre-layout changed marker when vault tracking starts", async () => {
    const fixture = metadataAdapterFixture({ resolved: true });
    fixture.adapter.startMetadataTracking();
    fixture.change("Source.md", ["Missing"]);
    fixture.adapter.startVaultTracking();
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    fixture.resolve("Source.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual([]);
  });

  it("cleans old rename pending state and waits for the new path's metadata", async () => {
    const fixture = metadataAdapterFixture({ resolved: true });
    fixture.adapter.startMetadataTracking();
    fixture.adapter.startVaultTracking();
    fixture.rename("Source.md", "Renamed.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    fixture.resolve("Renamed.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual(["Renamed.md"]);
    expect(fixture.events).toContainEqual({ kind: "rename", path: "Renamed.md", oldPath: "Source.md" });
  });

  it("classifies md-to-txt, txt-to-md, and md-to-md renames without leaving stale index paths", async () => {
    const removed = metadataAdapterFixture({ resolved: true });
    removed.adapter.startMetadataTracking();
    removed.adapter.startVaultTracking();
    removed.rename("Source.md", "Source.txt");
    expect(removed.events.at(-1)).toEqual({ kind: "delete", path: "Source.md" });
    expect(await removed.adapter.inboundLinks("Target.md")).toEqual([]);

    removed.events.length = 0;
    removed.rename("Source.txt", "Restored.md");
    expect(removed.events).toEqual([{ kind: "create", path: "Restored.md" }]);
    expect(await removed.adapter.inboundLinks("Target.md")).toBeNull();
    removed.resolve("Restored.md");

    const renamed = metadataAdapterFixture({ resolved: true });
    renamed.adapter.startMetadataTracking();
    renamed.adapter.startVaultTracking();
    renamed.rename("Source.md", "Renamed.md");
    expect(renamed.events.at(-1)).toEqual({ kind: "rename", path: "Renamed.md", oldPath: "Source.md" });
    expect(await renamed.adapter.inboundLinks("Target.md")).toBeNull();
  });

  it("blocks inbound-link safety while even an unrelated Markdown source is pending", async () => {
    const fixture = metadataAdapterFixture({ resolved: true, includeUnrelated: true });
    fixture.adapter.startMetadataTracking();
    fixture.change("Unrelated.md", ["Missing"]);
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    fixture.resolve("Unrelated.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);
  });

  it("registers metadata and vault tracking idempotently and disposes every event ref", () => {
    const fixture = metadataAdapterFixture({ resolved: true });
    fixture.adapter.startMetadataTracking();
    fixture.adapter.startMetadataTracking();
    fixture.adapter.startVaultTracking();
    fixture.adapter.startVaultTracking();
    expect(fixture.listenerCounts()).toEqual({ metadata: 3, vault: 4 });
    fixture.adapter.dispose();
    expect(fixture.listenerCounts()).toEqual({ metadata: 0, vault: 0 });
  });

  it("creates no note when quick capture is canceled, escaped, closed, empty, reserved, or collides", async () => {
    const fixture = quickCaptureFixture();
    for (const action of ["cancel", "escape", "close"] as const) {
      fixture.modal[action]();
      await fixture.adapter.capture();
    }
    for (const title of ["", "CON", "existing", "Existing.md", "existing.MD."]) {
      fixture.modal.submit(title);
      await fixture.adapter.capture();
    }
    expect(fixture.vault.createCalls).toEqual([]);
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("normalizes root and nested capture paths and appends .md exactly once", async () => {
    const root = quickCaptureFixture({ parentPath: "" });
    root.modal.submit("Root note.md");
    await expect(root.adapter.capture()).resolves.toBe("Root note.md");
    expect(root.fileManager.parentArgs).toEqual([["Active.md", "Root note.md"]]);

    const nested = quickCaptureFixture({ parentPath: "Inbox/Daily" });
    nested.modal.submit("Nested?.MD");
    await expect(nested.adapter.capture()).resolves.toBe("Inbox/Daily/Nested.md");
    expect(nested.vault.createCalls).toEqual([["Inbox/Daily/Nested.md", ""]]);
    expect(nested.workspace.openCalls).toEqual(["Inbox/Daily/Nested.md"]);
  });

  it("settles double submit once and creates at most one blank Markdown file", async () => {
    const fixture = quickCaptureFixture();
    fixture.modal.doubleSubmit("Only once");
    await fixture.adapter.capture();
    expect(fixture.vault.createCalls).toEqual([["Only once.md", ""]]);
    expect(fixture.workspace.openCalls).toEqual(["Only once.md"]);
  });

  it("rechecks collision immediately before create and never opens a raced file", async () => {
    const fixture = quickCaptureFixture({ createRace: true });
    fixture.modal.submit("Race");
    await expect(fixture.adapter.capture()).rejects.toThrow("File already exists");
    expect(fixture.vault.createCalls).toEqual([["Race.md", ""]]);
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("keeps quick capture single-flight across fast double activation", async () => {
    const fixture = quickCaptureFixture();
    const first = fixture.adapter.capture();
    const second = fixture.adapter.capture();
    expect(second).toBe(first);
    fixture.modal.submit("Single modal");
    await expect(first).resolves.toBe("Single modal.md");
    expect(fixture.modal.instances).toBe(1);
    expect(fixture.vault.createCalls).toEqual([["Single modal.md", ""]]);
  });

  it("fences a pending quick capture after adapter disposal", async () => {
    const fixture = quickCaptureFixture();
    const pending = fixture.adapter.capture();
    fixture.adapter.dispose();
    fixture.modal.submit("Too late");
    await expect(pending).resolves.toBeNull();
    expect(fixture.vault.createCalls).toEqual([]);
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("allows an in-flight create to finish after disposal but never opens the created note", async () => {
    const fixture = quickCaptureFixture({ pauseCreate: true });
    const pending = fixture.adapter.capture();
    fixture.modal.submit("Creating");
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.vault.createCalls).toEqual([["Creating.md", ""]]);
    fixture.adapter.dispose();
    fixture.vault.resolveCreate();
    await expect(pending).resolves.toBeNull();
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("settles the real quick-capture modal exactly once for create, Escape, and ordinary close", async () => {
    class ModalSurface {
      readonly contentEl = createTestDiv();
      closeCalls = 0;
      onOpen(): void {}
      onClose(): void {}
      open(): void { this.onOpen(); }
      close(): void { this.closeCalls += 1; this.onClose(); }
      setTitle(): this { return this; }
    }
    const QuickCaptureModal = createQuickCaptureModalClass(ModalSurface as unknown as ModalConstructor);
    const created = new QuickCaptureModal({} as App);
    const createdResult = created.request();
    const input = created.contentEl.querySelector<HTMLInputElement>("input")!;
    input.value = "One";
    const form = created.contentEl.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await expect(createdResult).resolves.toBe("One");
    expect((created as unknown as ModalSurface).closeCalls).toBe(1);

    const escaped = new QuickCaptureModal({} as App);
    const escapedResult = escaped.request();
    escaped.contentEl.querySelector("form")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(escapedResult).resolves.toBeNull();

    const canceled = new QuickCaptureModal({} as App);
    const canceledResult = canceled.request();
    canceled.cancel();
    await expect(canceledResult).resolves.toBeNull();

    const closed = new QuickCaptureModal({} as App);
    const closedResult = closed.request();
    closed.close();
    await expect(closedResult).resolves.toBeNull();
  });

  it("restores the quick-capture invoking element's focus after Escape", async () => {
    class ModalSurface {
      readonly contentEl = createTestDiv();
      constructor(readonly app: App) {}
      onOpen(): void {}
      onClose(): void {}
      open(): void { document.body.append(this.contentEl); this.onOpen(); }
      close(): void { this.onClose(); this.contentEl.remove(); }
      setTitle(): this { return this; }
    }
    const trigger = document.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
    trigger.textContent = "Quick capture";
    document.body.append(trigger);
    trigger.focus();
    const QuickCaptureModal = createQuickCaptureModalClass(ModalSurface as unknown as ModalConstructor);
    const modal = new QuickCaptureModal({} as App);
    const result = modal.request();
    modal.contentEl.querySelector("form")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("binds one concrete WorkbenchView class to the injected ItemView base", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const ConcreteWorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const controller = controllerFixture().controller;
    controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    const instance = new ConcreteWorkbenchView({} as WorkspaceLeaf, controller);
    expect(instance).toBeInstanceOf(ItemViewSurface);
    expect(instance).toBeInstanceOf(ConcreteWorkbenchView);
    await instance.onOpen();
    expect(instance.contentEl.querySelector('[aria-label="今日"]')).not.toBeNull();
    await instance.onClose();
  });

  it("saves a detached category draft without starting cloud work", () => {
    const groupKey = `group:${"7".repeat(64)}`;
    const secondGroupKey = `group:${"8".repeat(64)}`;
    const model = {
      ...populatedWorkbenchModel(),
      route: { tab: "task", page: "category-selection" } as const,
      boundLibraryPath: "/科学文库",
      verificationRoot: "/科学文库",
      workflow: {
        kind: "ready" as const,
        primaryAction: "start" as const,
        titleKey: "workflow.ready.title" as const,
        descriptionKey: "workflow.ready.description" as const,
        recommendedGroup: null,
        canShowTechnicalDetails: false,
      },
      hybridCatalog: {
        ...TEST_INACTIVE_HYBRID_EXECUTION,
        status: "ready" as const,
        active: {
          ...TEST_HYBRID_ACTIVE_AUTHORITY,
          importedAt: 1,
          pdfCount: 6,
          unverifiedCount: 6,
          verifiedCount: 0,
          differenceCount: 0,
          cloudMissingCount: 0,
          groupCount: 2,
          verifiedGroupCount: 0,
          coveredCandidatePdfCount: 0,
          groups: [{
            groupKey,
            rootRelativePath: "7-医学",
            label: "医学",
            pdfCount: 4,
            mode: "recursive" as const,
            verificationStatus: "unverified" as const,
          }, {
            groupKey: secondGroupKey,
            rootRelativePath: "8-语言",
            label: "语言",
            pdfCount: 2,
            mode: "recursive" as const,
            verificationStatus: "unverified" as const,
          }],
        },
      },
    };
    const onTaskSaveCategorySelection = vi.fn();
    const onStartSelectedVerification = vi.fn();
    const onResumeSelectedVerification = vi.fn();
    const root = createTestDiv();
    renderWorkbench(root, model, noOpWorkbenchActions({
      onTaskSaveCategorySelection,
      onStartSelectedVerification,
      onResumeSelectedVerification,
    }));

    const advanced = root.querySelector<HTMLDetailsElement>(
      "[data-task-category-advanced]",
    )!;
    advanced.open = true;
    const first = root.querySelector<HTMLInputElement>(
      `[data-task-category-check="${groupKey}"]`,
    )!;
    const second = root.querySelector<HTMLInputElement>(
      `[data-task-category-check="${secondGroupKey}"]`,
    )!;
    first.checked = true;
    first.dispatchEvent(new Event("change", { bubbles: true }));
    second.checked = true;
    second.dispatchEvent(new Event("change", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("[data-task-category-save]")!.click();

    expect(onTaskSaveCategorySelection).toHaveBeenCalledWith(model.taskActionRevision, {
      rootPath: "/科学文库",
      groupKeys: [groupKey, secondGroupKey],
    });
    expect(onStartSelectedVerification).not.toHaveBeenCalled();
    expect(onResumeSelectedVerification).not.toHaveBeenCalled();
  });

  it("builds a detached verification purpose for the legacy picker bridge", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const groupKey = `group:${"7".repeat(64)}`;
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 1,
        pdfCount: 4,
        unverifiedCount: 4,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [{
          groupKey,
          rootRelativePath: "7-医学",
          label: "医学",
          pdfCount: 4,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });
    const pickerRequest = vi.fn<CloudDirectoryPickerPresenter["request"]>(async (input) => ({
      kind: "category",
      selectedPath: "/科学文库/7-医学",
      effectiveRoot: "/科学文库",
      groupKey: input.purpose.kind === "verification"
        ? input.purpose.groups[0]!.groupKey
        : groupKey,
    }));
    const internals = fixture.controller as unknown as {
      readonly dependencies: { catalogDirectoryPicker?: CloudDirectoryPickerPresenter };
    };
    internals.dependencies.catalogDirectoryPicker = { request: pickerRequest };
    fixture.controller.selectRoute({ tab: "task", page: "folder-selection" });
    fixture.controller.setVerificationRoot("/科学文库");
    const WorkbenchView = createWorkbenchViewClass(
      ItemViewSurface as unknown as ItemViewConstructor,
      NORMAL_RUNTIME_POLICY,
    );
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();

    view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="browse-verification-root"]',
    )?.click();
    await vi.waitFor(() => expect(pickerRequest).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.controller.snapshot().verificationDirectorySelection)
      .toMatchObject({ kind: "category", groupKey }));

    const request = pickerRequest.mock.calls[0]![0];
    expect(request.purpose).toEqual({
      kind: "verification",
      groups: [{ groupKey, rootRelativePath: "7-医学", label: "医学" }],
    });
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/科学文库",
      selectedVerificationGroupKeys: [groupKey],
    });
    expect(hybrid.startInputs).toEqual([]);
    expect(hybrid.resumeInputs).toEqual([]);

    expect(view.contentEl.textContent).toContain("/科学文库/7-医学");
    const categoryChoice = view.contentEl.querySelector<HTMLInputElement>(
      `[data-group-key="${groupKey}"]`,
    )!;
    expect(categoryChoice.disabled).toBe(false);
    categoryChoice.checked = false;
    categoryChoice.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(
      fixture.controller.snapshot().verificationDirectorySelection,
    ).toBeUndefined());
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/科学文库",
      selectedVerificationGroupKeys: [],
    });
    expect(view.contentEl.textContent).not.toContain("/科学文库/7-医学");
    expect(view.contentEl.querySelector<HTMLInputElement>(
      '[data-verification-root="true"]',
    )?.value).toBe("/科学文库");
    await view.onClose();
    fixture.controller.dispose();
  });

  it("surfaces pin persistence rejection in the concrete workbench status", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    fixture.controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    fixture.store.failNext = new Error("pin store failed");
    const WorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();
    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>(".knowledge-workbench__today-item button"))
      .find((button) => button.textContent === "置顶")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.contentEl.querySelector('[role="status"]')?.textContent).toContain("置顶失败");
    expect(view.contentEl.textContent).not.toContain("pin store failed");
    await view.onClose();
  });

  it("surfaces workspace-open rejection in the concrete workbench status", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture({ workspaceError: new Error("leaf unavailable") });
    fixture.controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    const WorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();
    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>(".knowledge-workbench__today-item button"))
      .find((button) => button.textContent === "查看笔记")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.contentEl.querySelector('[role="status"]')?.textContent).toContain("打开笔记失败");
    expect(view.contentEl.textContent).not.toContain("leaf unavailable");
    await view.onClose();
  });

  it("surfaces quick-capture rejection in the concrete workbench status", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture({ quickCaptureError: new Error("create failed") });
    fixture.controller.selectRoute({ tab: "more", page: "knowledge-tools" });
    const WorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();
    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "快速记录")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.contentEl.querySelector('[role="status"]')?.textContent).toContain("快速记录失败");
    expect(view.contentEl.textContent).not.toContain("create failed");
    await view.onClose();
  });

  it("activates one workbench leaf and reveals the same concrete view instance", async () => {
    const view = {};
    const leaf = {
      view,
      setViewStateCalls: 0,
      async setViewState(): Promise<void> { this.setViewStateCalls += 1; },
    };
    const workspace = {
      leaves: [] as typeof leaf[],
      revealCalls: [] as typeof leaf[],
      getLeavesOfType(): typeof leaf[] { return this.leaves; },
      getLeaf(): typeof leaf { this.leaves.push(leaf); return leaf; },
      async revealLeaf(value: typeof leaf): Promise<void> { this.revealCalls.push(value); },
    };
    await activateWorkbench({ workspace } as unknown as App);
    expect(leaf.setViewStateCalls).toBe(1);
    expect(workspace.revealCalls).toEqual([leaf]);
    expect(workspace.getLeavesOfType()[0]?.view).toBe(view);
  });

  it("reports a first-open activation rejection before a workbench view is mounted", async () => {
    const errors: unknown[] = [];
    const leaf = {
      async setViewState(): Promise<void> { throw new Error("view state unavailable"); },
    };
    runVisibleHostAction(
      () => activateWorkbench({
        workspace: {
          getLeavesOfType: () => [],
          getLeaf: () => leaf,
          revealLeaf: async () => undefined,
        },
      } as unknown as App),
      (error) => errors.push(error),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([expect.objectContaining({ message: "view state unavailable" })]);
  });

  it("surfaces a deferred non-concrete view once through the command host action", async () => {
    const activationStatuses: string[] = [];
    const hostStatuses: string[] = [];
    const notices: string[] = [];
    const errors: unknown[] = [];
    let resolveSurfaced: (() => void) | null = null;
    const surfaced = new Promise<void>((resolve) => { resolveSurfaced = resolve; });
    const leaf = { view: {} };
    let reveals = 0;
    runVisibleHostAction(
      () => requireActivatedWorkbench(
        {
          workspace: {
            getLeavesOfType: () => [leaf],
            getLeaf: () => leaf,
            revealLeaf: async () => { reveals += 1; },
          },
        } as unknown as App,
        () => false,
        (message) => activationStatuses.push(message),
      ),
      (error) => {
        errors.push(error);
        surfaceVisibleHostError(
          "Open workbench failed",
          error,
          () => true,
          (message) => hostStatuses.push(message),
          (message) => notices.push(message),
        );
        resolveSurfaced?.();
      },
    );
    await surfaced;
    expect(reveals).toBe(2);
    expect(errors[0]).toBeInstanceOf(WorkbenchViewActivationError);
    expect(activationStatuses).toHaveLength(1);
    expect(hostStatuses).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it("surfaces one startup layout rejection through the visible host seam", async () => {
    const statuses: string[] = [];
    const notices: string[] = [];
    runVisibleHostAction(
      async () => { throw new Error("inventory unavailable"); },
      (error) => surfaceVisibleHostError(
        "Layout initialization failed",
        error,
        () => true,
        (message) => statuses.push(message),
        (message) => notices.push(message),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toEqual(["Layout initialization failed: inventory unavailable"]);
    expect(notices).toEqual(["Layout initialization failed: inventory unavailable"]);
  });

  it("suppresses host status and Notice after unload invalidates the captured epoch", async () => {
    const lifecycle = new LifecycleEpoch();
    const epoch = lifecycle.begin();
    const statuses: string[] = [];
    const notices: string[] = [];
    const deferred: { reject?: (error: Error) => void } = {};
    runVisibleHostAction(
      () => new Promise<void>((_resolve, reject) => { deferred.reject = reject; }),
      (error) => surfaceVisibleHostError(
        "Layout initialization failed",
        error,
        () => lifecycle.owns(epoch),
        (message) => statuses.push(message),
        (message) => notices.push(message),
      ),
    );
    lifecycle.invalidate();
    deferred.reject?.(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("notifies once when startup and command share one failing layout gate", async () => {
    const gate = new RetryableAsyncGate();
    const notices: string[] = [];
    const runLayout = (): Promise<void> => gate.run(async () => {
      const error = new Error("shared layout failure");
      surfaceVisibleHostError(
        "Layout initialization failed",
        error,
        () => true,
        () => undefined,
        (message) => notices.push(message),
      );
      throw new SurfacedHostError(error);
    });
    void runLayout().catch(() => undefined);
    runVisibleHostAction(runLayout, (error) => {
      if (error instanceof SurfacedHostError) return;
      surfaceVisibleHostError(
        "Open workbench failed",
        error,
        () => true,
        () => undefined,
        (message) => notices.push(message),
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(notices).toEqual(["Layout initialization failed: shared layout failure"]);
  });

  it("invalidates stale async lifecycle continuations before they can assign host state", async () => {
    const lifecycle = new LifecycleEpoch();
    const epoch = lifecycle.begin();
    let assigned = false;
    const continuation = Promise.resolve().then(() => {
      if (lifecycle.owns(epoch)) assigned = true;
    });
    lifecycle.invalidate();
    await continuation;
    expect(assigned).toBe(false);
  });

  it("retries a failed async layout gate and marks complete only after success", async () => {
    const gate = new RetryableAsyncGate();
    let attempts = 0;
    await expect(gate.run(async () => {
      attempts += 1;
      throw new Error("reconcile failed");
    })).rejects.toThrow("reconcile failed");
    expect(gate.isComplete()).toBe(false);
    await gate.run(async () => { attempts += 1; });
    expect(gate.isComplete()).toBe(true);
    expect(attempts).toBe(2);
  });

  it("clears a surfaced layout audit failure after an explicit retry succeeds", async () => {
    const gate = new RetryableAsyncGate();
    const fixture = controllerFixture();
    let auditCalls = 0;
    const operations = {
      auditRecovery: async () => {
        auditCalls += 1;
        if (auditCalls === 1) throw new Error("audit reload unavailable");
      },
      refreshHistory: async () => undefined,
      initializeIndex: async () => undefined,
      reportReady: () => fixture.controller.reportReady(),
    };
    const run = (): Promise<void> => gate.run(() => initializeRecoveredLayout(operations, () => true));

    await expect(run()).rejects.toThrow("audit reload unavailable");
    fixture.controller.reportError("Layout initialization failed: audit reload unavailable");
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "error",
      statusMessage: "Layout initialization failed: audit reload unavailable",
    });
    await run();

    expect(auditCalls).toBe(2);
    expect(fixture.controller.snapshot().status).toBe("ready");
    expect(fixture.controller.snapshot().statusMessage).toBeUndefined();
    expect(gate.isComplete()).toBe(true);
  });

  it("recovers the active queue after reconcile failure and succeeds on the second layout attempt", async () => {
    const gate = new RetryableAsyncGate();
    let reconcileCalls = 0;
    let resumeCalls = 0;
    const operations = {
      hasActiveIndex: () => true,
      startInitialScan: async () => undefined,
      reconcileInventory: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) throw new Error("inventory unavailable");
      },
      resumeAndFlush: async () => { resumeCalls += 1; },
    };
    await expect(gate.run(() => initializeIndexForLayout(operations, () => true)))
      .rejects.toThrow("inventory unavailable");
    expect({ reconcileCalls, resumeCalls, complete: gate.isComplete() }).toEqual({
      reconcileCalls: 1,
      resumeCalls: 1,
      complete: false,
    });
    await gate.run(() => initializeIndexForLayout(operations, () => true));
    expect({ reconcileCalls, resumeCalls, complete: gate.isComplete() }).toEqual({
      reconcileCalls: 2,
      resumeCalls: 2,
      complete: true,
    });
  });

  it("re-reveals once when a deferred workbench view is not yet the expected concrete class", async () => {
    const expected = {};
    const leaf = {
      view: {},
      async setViewState(): Promise<void> {},
    };
    let reveals = 0;
    const workspace = {
      getLeavesOfType: () => [leaf],
      getLeaf: () => leaf,
      revealLeaf: async (): Promise<void> => {
        reveals += 1;
        if (reveals === 2) leaf.view = expected;
      },
    };
    await expect(activateWorkbenchWithRetry(
      { workspace } as unknown as App,
      (view) => view === expected,
    )).resolves.toBe(true);
    expect(reveals).toBe(2);

    leaf.view = {};
    reveals = 0;
    await expect(activateWorkbenchWithRetry(
      { workspace: { ...workspace, revealLeaf: async () => { reveals += 1; } } } as unknown as App,
      (view) => view === expected,
    )).resolves.toBe(false);
    expect(reveals).toBe(2);
  });

  it("keeps writes locked and routes settings actions through the controller", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    const calls: string[] = [];
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        locale: "zh-CN" as const,
        openAtStartup: false,
        folderRules: [],
        excludedPrefixes: ["Archive"],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        boundCloudLibrary: null,
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
      }),
      folderRuleProposals: () => [{
        prefix: "References",
        kind: "reference" as const,
        noteCount: 12,
        unclassifiedCount: 11,
        samplePaths: ["References/A.md"],
      }],
      previewSampleChange: () => { calls.push("review"); },
      setOpenAtStartup: async () => { calls.push("startup"); },
      setLocale: async () => undefined,
      setWriteEnabled: async () => { calls.push("write"); },
      applyFolderRules: async () => { calls.push("rules"); },
      setExcludedPrefixes: async () => { calls.push("exclusions"); },
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    expect(tab.containerEl.textContent).toContain("写入操作已锁定");
    const proposal = tab.containerEl.querySelector<HTMLInputElement>('input[data-folder-rule="References"]')!;
    expect(proposal.checked).toBe(false);
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "查看示例变更")?.click();
    proposal.checked = true;
    proposal.dispatchEvent(new Event("change", { bubbles: true }));
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "确认所选规则")?.click();
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "应用排除项")?.click();
    await Promise.resolve();
    expect(calls).toEqual(["review", "rules", "exclusions"]);
  });

  it("shows write enablement only after preview acknowledgement and routes it through the controller guard", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    const baseSettings = {
      writeEnabled: false,
      writePreviewAcknowledged: true,
      locale: "zh-CN" as const,
      openAtStartup: false,
      folderRules: [],
      excludedPrefixes: [],
      aiEnabled: false,
      aiEndpoint: "",
      aiModel: "",
      secretId: "",
      recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
      boundCloudLibrary: null,
      cloudVerificationGeneration: 0,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
    };
    const values: boolean[] = [];
    const controller = {
      settings: () => baseSettings,
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async (value: boolean) => { values.push(value); },
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    expect(tab.containerEl.textContent).not.toContain("写入操作已锁定");
    const write = tab.containerEl.querySelector<HTMLInputElement>('input[data-write-enabled="true"]')!;
    expect(write.checked).toBe(false);
    write.checked = true;
    write.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(values).toEqual([true]);

    const fixture = controllerFixture();
    await fixture.controller.setWriteEnabled(true);
    expect(fixture.store.settings().writeEnabled).toBe(false);
    fixture.store.setSettingsForTest({ ...fixture.store.settings(), writePreviewAcknowledged: true });
    await fixture.controller.setWriteEnabled(true);
    expect(fixture.store.settings().writeEnabled).toBe(true);
  });

  it("renders exclusion preview rows from proposals while retaining existing unmatched prefixes", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    const applied: string[][] = [];
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        locale: "zh-CN" as const,
        openAtStartup: false,
        folderRules: [],
        excludedPrefixes: ["Archive"],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        boundCloudLibrary: null,
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
      }),
      folderRuleProposals: () => [{
        prefix: "References",
        kind: "reference" as const,
        noteCount: 12,
        unclassifiedCount: 11,
        samplePaths: ["References/A.md", "References/B.md"],
      }],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async (prefixes: readonly string[]) => { applied.push([...prefixes]); },
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    const rows = Array.from(tab.containerEl.querySelectorAll<HTMLInputElement>("input[data-excluded-prefix]"));
    expect(rows.map((row) => [row.dataset.excludedPrefix, row.checked])).toEqual([
      ["References", false],
      ["Archive", true],
    ]);
    expect(tab.containerEl.textContent).toContain("12 篇笔记");
    expect(tab.containerEl.textContent).toContain("References/A.md");
    expect(tab.containerEl.textContent).toContain("已有排除项");
    rows[0]!.checked = true;
    rows[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "应用排除项")?.click();
    await Promise.resolve();
    expect(applied).toEqual([["References", "Archive"]]);
  });

  it("shows settings action failures in a live status and leaves the action retryable", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    let attempts = 0;
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        locale: "zh-CN" as const,
        openAtStartup: false,
        folderRules: [],
        excludedPrefixes: ["Archive"],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        boundCloudLibrary: null,
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
      }),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
      },
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    const apply = Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "应用排除项")!;
    apply.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("保存失败，请重试");
    apply.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("已保存");
    expect(attempts).toBe(2);
  });

  it("restores startup and write checkbox intent after failure so the same intent can be retried", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    let persistedStartup = false;
    let persistedWrite = false;
    let startupAttempts = 0;
    let writeAttempts = 0;
    const controller = {
      settings: () => ({
        writeEnabled: persistedWrite,
        writePreviewAcknowledged: true,
        locale: "zh-CN" as const,
        openAtStartup: persistedStartup,
        folderRules: [],
        excludedPrefixes: [],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        boundCloudLibrary: null,
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
      }),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async (value: boolean) => {
        startupAttempts += 1;
        if (startupAttempts === 1) throw new Error("startup failed");
        persistedStartup = value;
      },
      setLocale: async () => undefined,
      setWriteEnabled: async (value: boolean) => {
        writeAttempts += 1;
        if (writeAttempts === 1) throw new Error("write failed");
        persistedWrite = value;
      },
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    const startup = Array.from(tab.containerEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))[0]!;
    const write = tab.containerEl.querySelector<HTMLInputElement>('input[data-write-enabled="true"]')!;

    startup.checked = true;
    startup.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(startup.checked).toBe(false);
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("保存失败，请重试");
    startup.checked = true;
    startup.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(persistedStartup).toBe(true);

    write.checked = true;
    write.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(write.checked).toBe(false);
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("保存失败，请重试");
    write.checked = true;
    write.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(persistedWrite).toBe(true);
    expect({ startupAttempts, writeAttempts }).toEqual({ startupAttempts: 2, writeAttempts: 2 });
  });
});
