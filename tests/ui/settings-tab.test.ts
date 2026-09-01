// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { CloudCatalogConnectionViewModel } from "../../src/catalog/cloud-catalog-runtime";
import type { HybridCatalogViewModel } from "../../src/catalog/hybrid-catalog-runtime";
import { SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET } from "../../src/catalog/catalog-types";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../src/runtime/safety-policy";
import {
  createSettingsTabClass,
  type PluginSettingTabConstructor,
} from "../../src/ui/settings-tab";
import { presentCatalogProgress } from "../../src/ui/catalog-progress-presenter";
import { EMPTY_RECENT_CLOUD_DIRECTORIES } from "../../src/storage/recent-cloud-directories";
import { LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS } from "../../src/catalog/hybrid-catalog-types";
import {
  TEST_HYBRID_ACTIVE_AUTHORITY,
  TEST_INACTIVE_HYBRID_EXECUTION,
  TEST_LARGE_BATCH_AUTHORITY,
} from "../helpers/ui-fixtures";

const INACTIVE_AUTO_RESUME = {
  autoResumeState: "inactive" as const,
  autoSegmentIndex: 0,
  autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
};

class SettingsSurface {
  readonly containerEl = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
}
class SecretSurface {
  private change: ((value: string) => void) | null = null;
  readonly select: HTMLSelectElement;
  value = "";
  constructor(readonly app: App, container: HTMLElement) {
    this.select = container.ownerDocument.createElement("select");
    this.select.dataset.secretComponent = "true";
    container.append(this.select);
  }
  setValue(value: string): this { this.value = value; this.select.dataset.value = value; return this; }
  onChange(callback: (value: string) => void): this { this.change = callback; return this; }
  emit(value: string): void { this.change?.(value); }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const makeTab = (options: Readonly<{ fail?: Error }> = {}) => {
  const saves: unknown[] = [];
  const sessions: boolean[] = [];
  const controller = {
    settings: () => ({
      writeEnabled: false, writePreviewAcknowledged: false, locale: "zh-CN" as const, openAtStartup: false,
      folderRules: [], excludedPrefixes: [], aiEnabled: true,
      aiEndpoint: "https://example.test/v1", aiModel: "model", secretId: "",
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
    setExcludedPrefixes: async () => undefined,
    saveAiSettings: async (value: unknown) => {
      if (options.fail !== undefined) throw options.fail;
      saves.push(structuredClone(value));
    },
    setSessionAiSecret: (value: string) => { sessions.push(value === "sk-session-private"); },
  };
  const SettingsTab = createSettingsTabClass(
    SettingsSurface as unknown as PluginSettingTabConstructor,
    SecretSurface,
    NORMAL_RUNTIME_POLICY,
  );
  const tab = new SettingsTab({} as App, {} as never, controller);
  (tab as unknown as { display(): void }).display();
  return { tab, saves, sessions };
};

describe("AI settings", () => {
  it.each([
    ["zh-CN", "扫描状态：已暂停", "PDF：123 / 1,000", "已用时间：4,321 毫秒 / 120,000 毫秒"],
    ["en", "Scan status: paused", "PDFs: 123 / 1,000", "Elapsed: 4,321 ms / 120,000 ms"],
  ] as const)("renders native-settings progress through the locale-aware presenter in %s", (
    locale,
    expectedStatus,
    expectedPdf,
    expectedTime,
  ) => {
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        locale,
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
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => ({
        status: "paused" as const,
        scanProgress: {
          status: "paused" as const,
          directoryCount: 20,
          completedDirectoryCount: 20,
          pdfCount: 123,
          ignoredFileCount: 0,
          pendingDirectoryCount: 0,
          listRequestCount: 25,
          elapsedMs: 4_321,
          budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
          stopReason: "pdf-limit" as const,
        },
      }),
      connectCatalog: async () => undefined,
      submitCatalogAuthorizationCode: async () => undefined,
      cancelCatalogAuthorization: () => undefined,
      revokeCatalog: async () => undefined,
      validateCatalogScanRoot: (root: string) => root,
      requestCatalogScan: async () => undefined,
      cancelCatalogScan: () => undefined,
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.querySelector('[data-catalog-scan-status="true"]')?.textContent).toBe(expectedStatus);
    expect(tab.containerEl.querySelector('[data-catalog-pdf-progress="true"]')?.textContent).toBe(expectedPdf);
    expect(tab.containerEl.querySelector('[data-catalog-time-progress="true"]')?.textContent).toBe(expectedTime);
  });

  it("renders fixed acceptance notices without constructing secrets or write and AI controls", () => {
    let secretConstructions = 0;
    class CountedSecretSurface extends SecretSurface {
      constructor(app: App, container: HTMLElement) {
        super(app, container);
        secretConstructions += 1;
      }
    }
    const calls = {
      sample: vi.fn(),
      write: vi.fn(async () => undefined),
      saveAi: vi.fn(async () => undefined),
      session: vi.fn(),
    };
    const controller = {
      settings: () => ({
        writeEnabled: true, writePreviewAcknowledged: true, locale: "zh-CN" as const, openAtStartup: false,
        folderRules: [], excludedPrefixes: [], aiEnabled: true,
        aiEndpoint: "https://example.test/v1", aiModel: "model", secretId: "secret-id",
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        boundCloudLibrary: null,
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
      }),
      folderRuleProposals: () => [],
      previewSampleChange: calls.sample,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: calls.write,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      saveAiSettings: calls.saveAi,
      setSessionAiSecret: calls.session,
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      CountedSecretSurface,
      READ_ONLY_ACCEPTANCE_POLICY,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.classList.contains("knowledge-workbench__settings--read-only")).toBe(true);
    expect(tab.containerEl.textContent).toContain(
      "只读验收版本不提供整理写入。",
    );
    expect(tab.containerEl.textContent).toContain(
      "只读验收版本不提供 AI 配置和请求。",
    );
    expect(tab.containerEl.textContent).toContain("启动时打开知识工作台");
    expect(tab.containerEl.textContent).toContain("文件夹规则建议");
    expect(tab.containerEl.textContent).toContain("排除的文件夹");
    expect(tab.containerEl.querySelector('[data-write-enabled="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-enabled="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-endpoint="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-model="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-session-ai-secret="true"]')).toBeNull();
    expect(secretConstructions).toBe(0);
    expect(calls.sample).not.toHaveBeenCalled();
    expect(calls.write).not.toHaveBeenCalled();
    expect(calls.saveAi).not.toHaveBeenCalled();
    expect(calls.session).not.toHaveBeenCalled();
    expect(tab.containerEl.textContent).toContain(
      "只读验收版本不提供云端连接、本地 TXT 导入和目录核验。",
    );
    expect(tab.containerEl.querySelector('[data-catalog-app-key="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-catalog-secret-key="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-catalog-scan-root="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-catalog-txt-path="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-catalog-large-scan-root="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-action="catalog-preview-txt"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-action="catalog-start-large-verification"]')).toBeNull();
  });

  it("associates the host SecretComponent control with its persistent label", () => {
    const fixture = makeTab();
    const select = fixture.tab.containerEl.querySelector<HTMLSelectElement>('[data-secret-component="true"]')!;
    const label = select.closest("label");
    expect(label).not.toBeNull();
    expect(label?.textContent ?? "").toContain("SecretStorage 凭据 ID");
  });

  it("stores only the SecretStorage ID selected by SecretComponent", async () => {
    const fixture = makeTab();
    (fixture.tab as unknown as { secretComponent: SecretSurface }).secretComponent.emit("my-secret-id");
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.saves.at(-1)).toEqual({
      enabled: true,
      endpoint: "https://example.test/v1",
      model: "model",
      secretId: "my-secret-id",
    });
    expect(JSON.stringify(fixture.saves)).not.toContain("sk-private");
  });

  it("hands a raw session secret to memory only and immediately clears the password DOM", () => {
    const fixture = makeTab();
    const password = fixture.tab.containerEl.querySelector<HTMLInputElement>('input[type="password"]')!;
    password.value = "sk-session-private";
    fixture.tab.containerEl.querySelector<HTMLButtonElement>('[data-action="use-session-secret"]')!.click();
    expect(fixture.sessions).toEqual([true]);
    expect(password.value).toBe("");
    expect(fixture.tab.containerEl.textContent).not.toContain("sk-session-private");
    expect(JSON.stringify(fixture.saves)).not.toContain("sk-session-private");
  });

  it("uses fixed safe status text for AI setting failures", async () => {
    const fixture = makeTab({ fail: new Error("sk-private storage failure") });
    const enabled = fixture.tab.containerEl.querySelector<HTMLInputElement>('[data-ai-enabled="true"]')!;
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    const status = fixture.tab.containerEl.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain("AI 设置不可用");
    expect(status).not.toContain("sk-private");
  });

  it("rolls SecretComponent selection back after a save failure without exposing the cause", async () => {
    const fixture = makeTab({ fail: new Error("sk-private persistence detail") });
    const secret = (fixture.tab as unknown as { secretComponent: SecretSurface }).secretComponent;
    secret.emit("new-secret-id");
    await Promise.resolve();
    await Promise.resolve();
    expect(secret.value).toBe("");
    expect(fixture.tab.containerEl.querySelector('[role="status"]')?.textContent).toBe("AI 设置不可用");
    expect(fixture.tab.containerEl.textContent).not.toContain("sk-private");
  });
});

describe("hybrid catalog settings", () => {
  const baseSettings = {
    writeEnabled: false, writePreviewAcknowledged: false, locale: "zh-CN" as const, openAtStartup: false,
    folderRules: [], excludedPrefixes: [], aiEnabled: false,
    aiEndpoint: "", aiModel: "", secretId: "",
    recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
    boundCloudLibrary: null,
    cloudVerificationGeneration: 0,
    verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
    legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
  };
  const group = (index: number) => ({
    groupKey: `group:${String(index).repeat(64)}`,
    rootRelativePath: `Category ${index}`,
    label: `Category ${index}`,
    pdfCount: index + 1,
    mode: "recursive" as const,
    verificationStatus: "unverified" as const,
  });

  it("previews and imports a session-only TXT path, then starts at most five categories", async () => {
    const importGate = deferred();
    const scanGate = deferred();
    let hybrid: HybridCatalogViewModel = {
      ...TEST_INACTIVE_HYBRID_EXECUTION,
      status: "ready" as const,
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 100,
        pdfCount: 21,
        unverifiedCount: 21,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 6,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: Array.from({ length: 6 }, (_, index) => group(index + 1)),
      },
    };
    let notify = (): void => undefined;
    const calls = {
      preview: [] as string[],
      imported: [] as string[],
      scans: [] as Array<Readonly<{ rootPath: string; groupKeys: readonly string[] }>>,
      cancel: 0,
    };
    const controller = {
      settings: () => structuredClone(baseSettings),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => ({ status: "authorized" as const }),
      connectCatalog: async () => undefined,
      submitCatalogAuthorizationCode: async () => undefined,
      cancelCatalogAuthorization: () => undefined,
      revokeCatalog: async () => undefined,
      validateCatalogScanRoot: (root: string) => root,
      requestCatalogScan: async () => undefined,
      hybridCatalog: () => structuredClone(hybrid),
      subscribeHybridCatalog: (listener: () => void) => {
        notify = listener;
        return () => undefined;
      },
      previewCatalogTxt: async (path: string) => {
        calls.preview.push(path);
        hybrid = {
          ...hybrid,
          status: "previewed",
          candidate: {
            sourceSha256: "a".repeat(64), byteSize: 10, nonEmptyLineCount: 3,
            pdfCount: 2, directoryCount: 1, ignoredLeafCount: 0,
            normalizedWhitespaceCount: 0, maxDepth: 2,
          },
        };
        notify();
      },
      requestCatalogTxtImport: async (path: string, onConfirmed?: () => void) => {
        calls.imported.push(path);
        onConfirmed?.();
        await importGate.promise;
      },
      requestLargeCatalogVerification: async (
        rootPath: string,
        groupKeys: readonly string[],
        onConfirmed?: () => void,
      ) => {
        calls.scans.push({ rootPath, groupKeys: [...groupKeys] });
        onConfirmed?.();
        await scanGate.promise;
      },
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => { calls.cancel += 1; },
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    const txtPath = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-txt-path="true"]',
    )!;
    txtPath.value = "/synthetic/private-inventory.txt";
    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-preview-txt"]',
    )!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.preview).toEqual(["/synthetic/private-inventory.txt"]);
    expect(txtPath.value).toBe("/synthetic/private-inventory.txt");
    expect(tab.containerEl.textContent).toContain("预览 PDF：2 / 70,000");

    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-import-txt"]',
    )!.click();
    await Promise.resolve();
    expect(calls.imported).toEqual(["/synthetic/private-inventory.txt"]);
    expect(txtPath.value).toBe("");
    importGate.resolve();

    const choices = Array.from(tab.containerEl.querySelectorAll<HTMLInputElement>(
      '[data-catalog-group-key]',
    ));
    expect(choices).toHaveLength(6);
    for (const choice of choices.slice(0, 5)) {
      choice.checked = true;
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    }
    choices[5]!.checked = true;
    choices[5]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(choices[5]!.checked).toBe(false);
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent)
      .toContain("最多选择 5 个分类");

    const cloudRoot = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )!;
    cloudRoot.value = "/Synthetic";
    cloudRoot.dispatchEvent(new Event("input", { bubbles: true }));
    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-start-large-verification"]',
    )!.click();
    await Promise.resolve();
    expect(cloudRoot.value).toBe("");
    expect(calls.scans).toEqual([{
      rootPath: "/Synthetic",
      groupKeys: choices.slice(0, 5).map((choice) => choice.dataset.catalogGroupKey!),
    }]);
    scanGate.resolve();
  });

  it("keeps a selected category and cloud parent root for the current settings session", () => {
    const hybrid: HybridCatalogViewModel = {
      ...TEST_INACTIVE_HYBRID_EXECUTION,
      status: "ready",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 100,
        pdfCount: 2,
        unverifiedCount: 2,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [group(1)],
      },
    };
    const controller = {
      settings: () => structuredClone(baseSettings),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => ({ status: "authorized" as const }),
      connectCatalog: async () => undefined,
      submitCatalogAuthorizationCode: async () => undefined,
      cancelCatalogAuthorization: () => undefined,
      revokeCatalog: async () => undefined,
      validateCatalogScanRoot: (root: string) => root,
      requestCatalogScan: async () => undefined,
      hybridCatalog: () => structuredClone(hybrid),
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async () => undefined,
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    const root = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )!;
    root.value = "/Synthetic";
    root.dispatchEvent(new Event("input", { bubbles: true }));
    const choice = tab.containerEl.querySelector<HTMLInputElement>('[data-catalog-group-key]')!;
    choice.checked = true;
    choice.dispatchEvent(new Event("change", { bubbles: true }));

    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )?.value).toBe("/Synthetic");
    expect(tab.containerEl.querySelector<HTMLInputElement>('[data-catalog-group-key]')?.checked).toBe(true);
  });

  it("blocks a selected category used as its own verification root before a request", async () => {
    const scans: Array<Readonly<{ rootPath: string; groupKeys: readonly string[] }>> = [];
    const hybrid: HybridCatalogViewModel = {
      ...TEST_INACTIVE_HYBRID_EXECUTION,
      status: "ready",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 100,
        pdfCount: 2,
        unverifiedCount: 2,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [group(1)],
      },
    };
    const controller = {
      settings: () => structuredClone(baseSettings),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => ({ status: "authorized" as const }),
      connectCatalog: async () => undefined,
      submitCatalogAuthorizationCode: async () => undefined,
      cancelCatalogAuthorization: () => undefined,
      revokeCatalog: async () => undefined,
      validateCatalogScanRoot: (root: string) => root,
      requestCatalogScan: async () => undefined,
      hybridCatalog: () => structuredClone(hybrid),
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async (
        rootPath: string,
        groupKeys: readonly string[],
      ) => { scans.push({ rootPath, groupKeys: [...groupKeys] }); },
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    const choice = tab.containerEl.querySelector<HTMLInputElement>('[data-catalog-group-key]')!;
    choice.checked = true;
    choice.dispatchEvent(new Event("change", { bubbles: true }));
    const root = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )!;
    root.value = "/Category 1";
    root.dispatchEvent(new Event("input", { bubbles: true }));
    expect(tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-start-large-verification"]',
    )?.disabled).toBe(true);
    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-start-large-verification"]',
    )!.click();
    await Promise.resolve();

    expect(scans).toEqual([]);
    expect(tab.containerEl.querySelector('[data-catalog-parent-root-error="true"]')?.textContent)
      .toBe("核验根目录必须是所选分类的 API 父目录");
    expect(root.value).toBe("/Category 1");
  });

  it("renders a paused aggregate with explicit resume and cancellation controls", async () => {
    const calls = { resume: [] as string[], cancel: 0 };
    let notify = (): void => undefined;
    let hybrid: HybridCatalogViewModel = {
      ...TEST_INACTIVE_HYBRID_EXECUTION,
      status: "paused",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 100, pdfCount: 1, unverifiedCount: 1, verifiedCount: 0,
        differenceCount: 0, cloudMissingCount: 0, groupCount: 1,
        verifiedGroupCount: 0, coveredCandidatePdfCount: 0, groups: [group(1)],
      },
      batch: {
        ...TEST_LARGE_BATCH_AUTHORITY,
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-settings-paused",
        status: "paused" as const,
        stopReason: "time-limit" as const,
        resumeAvailable: true,
        runOrdinal: 2,
        remainingGroupCount: 1,
        pdfCount: 10,
        directoryCount: 2,
        ignoredFileCount: 0,
        listRequestCount: 12,
        cumulativeListRequestCount: 312,
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
    const controller = {
      settings: () => structuredClone(baseSettings),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => ({ status: "authorized" as const }),
      connectCatalog: async () => undefined,
      submitCatalogAuthorizationCode: async () => undefined,
      cancelCatalogAuthorization: () => undefined,
      revokeCatalog: async () => undefined,
      validateCatalogScanRoot: (root: string) => root,
      requestCatalogScan: async () => undefined,
      hybridCatalog: () => structuredClone(hybrid),
      subscribeHybridCatalog: (listener: () => void) => {
        notify = listener;
        return () => undefined;
      },
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async () => undefined,
      requestResumeLargeCatalogVerification: async (
        root: string,
        _groupKeys: readonly string[],
        onConfirmed?: () => void,
      ) => {
        calls.resume.push(root);
        onConfirmed?.();
        hybrid = { ...hybrid, status: "scanning" };
        notify();
      },
      cancelLargeCatalogVerification: () => { calls.cancel += 1; },
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.textContent).toContain("核验状态：已暂停");
    expect(tab.containerEl.textContent).toContain("本次运行片段的列表请求：12");
    expect(tab.containerEl.textContent).toContain("当前批次累计列表请求：312");
    const root = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )!;
    root.value = "/Synthetic";
    root.dispatchEvent(new Event("input", { bubbles: true }));
    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-resume-large-verification"]',
    )!.click();
    await Promise.resolve();
    expect(calls.resume).toEqual(["/Synthetic"]);
    expect(root.value).toBe("");

    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-cancel-large-verification"]',
    )!.click();
    expect(calls.cancel).toBe(1);
  });

  it("does not offer resume after a path-not-found verification failure", () => {
    const hybrid: HybridCatalogViewModel = {
      ...TEST_INACTIVE_HYBRID_EXECUTION,
      status: "partial",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 100, pdfCount: 1, unverifiedCount: 1, verifiedCount: 0,
        differenceCount: 0, cloudMissingCount: 0, groupCount: 1,
        verifiedGroupCount: 0, coveredCandidatePdfCount: 0, groups: [group(1)],
      },
      batch: {
        ...TEST_LARGE_BATCH_AUTHORITY,
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-settings-partial",
        status: "partial",
        stopReason: "baidu-not-found",
        resumeAvailable: false,
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
    const controller = {
      settings: () => structuredClone(baseSettings),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => ({ status: "authorized" as const }),
      connectCatalog: async () => undefined,
      submitCatalogAuthorizationCode: async () => undefined,
      cancelCatalogAuthorization: () => undefined,
      revokeCatalog: async () => undefined,
      validateCatalogScanRoot: (root: string) => root,
      requestCatalogScan: async () => undefined,
      hybridCatalog: () => structuredClone(hybrid),
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async () => undefined,
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-resume-large-verification"]',
    )?.hidden).toBe(true);
    expect(tab.containerEl.textContent).toContain(
      "云端 API 无法识别上次核验路径",
    );
    expect(tab.containerEl.textContent).not.toContain("/Synthetic");
  });
});

describe("cloud catalog settings", () => {
  it("keeps credentials and scan root session-only and delegates explicit controls", async () => {
    const settings = {
      writeEnabled: false, writePreviewAcknowledged: false, locale: "zh-CN" as const, openAtStartup: false,
      folderRules: [], excludedPrefixes: [], aiEnabled: false,
      aiEndpoint: "", aiModel: "", secretId: "",
      recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
      boundCloudLibrary: null,
      cloudVerificationGeneration: 0,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
    };
    const calls = {
      connect: [] as Array<Readonly<{ appKey: string; secretKey: string }>>,
      submitCode: [] as string[],
      cancelAuthorization: 0,
      revoke: 0,
      validate: [] as string[],
      scan: [] as string[],
    };
    const scan = deferred();
    const controller = {
      settings: () => structuredClone(settings),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => ({ status: "authorized" as const }),
      connectCatalog: async (credentials: Readonly<{ appKey: string; secretKey: string }>) => {
        calls.connect.push(structuredClone(credentials));
      },
      submitCatalogAuthorizationCode: async (code: string) => { calls.submitCode.push(code); },
      cancelCatalogAuthorization: () => { calls.cancelAuthorization += 1; },
      revokeCatalog: async () => { calls.revoke += 1; },
      validateCatalogScanRoot: (root: string) => { calls.validate.push(root); return root; },
      requestCatalogScan: async (root: string, onConfirmed?: () => void) => {
        calls.scan.push(root);
        onConfirmed?.();
        await scan.promise;
      },
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.textContent).toContain(
      "AppKey、SecretKey 和 OAuth 令牌保存在 Obsidian SecretStorage",
    );
    expect(tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-revoke"]',
    )?.textContent).toBe("移除本地凭据");
    expect(tab.containerEl.textContent).not.toContain("Secret key (session only)");

    const appKey = tab.containerEl.querySelector<HTMLInputElement>('[data-catalog-app-key="true"]')!;
    const secretKey = tab.containerEl.querySelector<HTMLInputElement>('[data-catalog-secret-key="true"]')!;
    const authorizationCode = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-authorization-code="true"]',
    )!;
    const root = tab.containerEl.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    expect(appKey.type).toBe("password");
    appKey.value = "session-app-key";
    secretKey.value = "session-secret-key";
    root.value = "/样本";
    tab.containerEl.querySelector<HTMLButtonElement>('[data-action="catalog-connect"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.connect).toEqual([{ appKey: "session-app-key", secretKey: "session-secret-key" }]);
    expect(appKey.value).toBe("");
    expect(secretKey.value).toBe("");
    expect(JSON.stringify(settings)).not.toContain("session-app-key");
    expect(JSON.stringify(settings)).not.toContain("session-secret-key");
    expect(JSON.stringify(settings)).not.toContain("/样本");

    authorizationCode.value = "one-time-code-sentinel";
    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-submit-authorization-code"]',
    )!.click();
    expect(authorizationCode.value).toBe("");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.submitCode).toEqual(["one-time-code-sentinel"]);

    authorizationCode.value = "must-clear-on-cancel";
    tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-cancel-authorization"]',
    )!.click();
    expect(authorizationCode.value).toBe("");
    expect(calls.cancelAuthorization).toBe(1);

    tab.containerEl.querySelector<HTMLButtonElement>('[data-action="catalog-validate-root"]')!.click();
    tab.containerEl.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')!.click();
    expect(root.value).toBe("");
    expect(calls.scan).toEqual(["/样本"]);
    scan.resolve();
    tab.containerEl.querySelector<HTMLButtonElement>('[data-action="catalog-revoke"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.validate).toEqual(["/样本"]);
    expect(calls.scan).toEqual(["/样本"]);
    expect(calls.revoke).toBe(1);
  });

  it("updates aggregate scan progress in place and exposes cancel only while scanning", () => {
    const settings = {
      writeEnabled: false, writePreviewAcknowledged: false, locale: "zh-CN" as const, openAtStartup: false,
      folderRules: [], excludedPrefixes: [], aiEnabled: false,
      aiEndpoint: "", aiModel: "", secretId: "",
      recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
      boundCloudLibrary: null,
      cloudVerificationGeneration: 0,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
    };
    let connection: CloudCatalogConnectionViewModel = { status: "authorized" };
    let notify = (): void => undefined;
    let unsubscribeCalls = 0;
    const controller = {
      settings: () => structuredClone(settings),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setLocale: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      catalogConnection: () => structuredClone(connection),
      subscribeCatalogConnection: (listener: () => void) => {
        notify = listener;
        return () => { unsubscribeCalls += 1; };
      },
      connectCatalog: async () => undefined,
      submitCatalogAuthorizationCode: async () => undefined,
      cancelCatalogAuthorization: () => undefined,
      revokeCatalog: async () => undefined,
      validateCatalogScanRoot: (root: string) => root,
      requestCatalogScan: async () => undefined,
      cancelCatalogScan: () => undefined,
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      SecretSurface,
      NORMAL_RUNTIME_POLICY,
      presentCatalogProgress,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    const connectionStatus = tab.containerEl.querySelector<HTMLElement>(
      '[data-catalog-connection-status="true"]',
    )!;
    const cancel = tab.containerEl.querySelector<HTMLButtonElement>(
      '[data-action="catalog-cancel-scan"]',
    )!;
    const appKey = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-catalog-app-key="true"]',
    )!;
    appKey.value = "session-app-key-sentinel";
    expect(cancel.hidden).toBe(true);
    expect(cancel.disabled).toBe(true);

    connection = {
      status: "scanning",
      scanProgress: {
        status: "scanning",
        directoryCount: 2,
        completedDirectoryCount: 1,
        pdfCount: 12,
        ignoredFileCount: 4,
        pendingDirectoryCount: 1,
        listRequestCount: 3,
        elapsedMs: 4_000,
        budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
      },
    };
    notify();

    expect(tab.containerEl.querySelector('[data-catalog-connection-status="true"]'))
      .toBe(connectionStatus);
    expect(connectionStatus.textContent).toBe("连接状态：扫描中");
    expect(tab.containerEl.querySelector('[data-catalog-scan-status="true"]')?.textContent)
      .toBe("扫描状态：扫描中");
    expect(tab.containerEl.querySelector('[data-catalog-pdf-progress="true"]')?.textContent)
      .toBe("PDF：12 / 1,000");
    expect(tab.containerEl.querySelector('[data-catalog-directory-progress="true"]')?.textContent)
      .toBe("目录：2 / 20");
    expect(tab.containerEl.querySelector('[data-catalog-request-progress="true"]')?.textContent)
      .toBe("列表请求：3 / 25");
    expect(tab.containerEl.querySelector('[data-catalog-time-progress="true"]')?.textContent)
      .toBe("已用时间：4,000 毫秒 / 120,000 毫秒");
    expect(tab.containerEl.querySelector('[data-catalog-stop-reason="true"]')?.textContent)
      .toBe("停止原因：—");
    expect(cancel.hidden).toBe(false);
    expect(cancel.disabled).toBe(false);
    expect(appKey.value).toBe("session-app-key-sentinel");
    expect(tab.containerEl.querySelector('[data-action="catalog-resume-scan"]')).toBeNull();
    expect(tab.containerEl.textContent).not.toContain("synthetic-private-folder");

    connection = {
      ...connection,
      status: "paused",
      scanProgress: {
        ...connection.scanProgress!,
        status: "paused",
        stopReason: "pdf-limit",
      },
    };
    notify();
    expect(cancel.hidden).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(tab.containerEl.querySelector('[data-catalog-stop-reason="true"]')?.textContent)
      .toBe("停止原因：达到 PDF 上限");

    (tab as unknown as { hide(): void }).hide();
    expect(appKey.value).toBe("");
    expect(unsubscribeCalls).toBe(1);
  });

  it("clears a one-time code and cancels the local attempt after ten minutes", async () => {
    vi.useFakeTimers();
    try {
      const settings = {
        writeEnabled: false, writePreviewAcknowledged: false, locale: "zh-CN" as const, openAtStartup: false,
        folderRules: [], excludedPrefixes: [], aiEnabled: false,
        aiEndpoint: "", aiModel: "", secretId: "",
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
        boundCloudLibrary: null,
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
      };
      const cancelAuthorization = vi.fn();
      let connection: Readonly<{
        status: "configured" | "authorizing";
        authorizationExpiresAt?: number;
      }> = { status: "configured" };
      const controller = {
        settings: () => structuredClone(settings),
        folderRuleProposals: () => [],
        previewSampleChange: () => undefined,
        setOpenAtStartup: async () => undefined,
        setLocale: async () => undefined,
        setWriteEnabled: async () => undefined,
        applyFolderRules: async () => undefined,
        setExcludedPrefixes: async () => undefined,
        catalogConnection: () => connection,
        connectCatalog: async () => {
          connection = {
            status: "authorizing",
            authorizationExpiresAt: Date.now() + 10 * 60 * 1_000,
          };
        },
        submitCatalogAuthorizationCode: async () => undefined,
        cancelCatalogAuthorization: cancelAuthorization,
        revokeCatalog: async () => undefined,
        validateCatalogScanRoot: (root: string) => root,
        requestCatalogScan: async () => undefined,
      };
      const SettingsTab = createSettingsTabClass(
        SettingsSurface as unknown as PluginSettingTabConstructor,
        SecretSurface,
        NORMAL_RUNTIME_POLICY,
      );
      const tab = new SettingsTab({} as App, {} as never, controller);
      (tab as unknown as { display(): void }).display();
      tab.containerEl.querySelector<HTMLButtonElement>('[data-action="catalog-connect"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
      (tab as unknown as { display(): void }).display();
      const refreshedCode = tab.containerEl.querySelector<HTMLInputElement>(
        '[data-catalog-authorization-code="true"]',
      )!;
      refreshedCode.value = "one-time-code-must-expire";
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

      expect(refreshedCode.value).toBe("");
      expect(cancelAuthorization).toHaveBeenCalledTimes(1);
      expect(tab.containerEl.textContent).toContain("云端目录授权已过期");
    } finally {
      vi.useRealTimers();
    }
  });
});
