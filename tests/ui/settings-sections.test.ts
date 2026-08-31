// @vitest-environment jsdom
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../src/runtime/safety-policy";
import {
  createSettingsSectionsSurface,
  type SettingsController,
} from "../../src/ui/settings-sections";
import type { FolderRule } from "../../src/storage/plugin-data";
import { SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET } from "../../src/catalog/catalog-types";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { presentCatalogProgress } from "../../src/ui/catalog-progress-presenter";
import { EMPTY_RECENT_CLOUD_DIRECTORIES } from "../../src/storage/recent-cloud-directories";
import { LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS } from "../../src/catalog/hybrid-catalog-types";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
} from "../../src/catalog/cloud-directory-selection";

const INACTIVE_AUTO_RESUME = {
  autoResumeState: "inactive" as const,
  autoSegmentIndex: 0,
  autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
};

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

const settingsControllerFixture = (): SettingsController => ({
  settings: () => ({
    locale: "zh-CN",
    writeEnabled: false,
    writePreviewAcknowledged: false,
    openAtStartup: false,
    folderRules: [],
    excludedPrefixes: [],
    aiEnabled: false,
    aiEndpoint: "",
    aiModel: "",
    secretId: "",
    recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
  }),
  folderRuleProposals: () => [],
  previewSampleChange: () => undefined,
  setLocale: async () => undefined,
  setOpenAtStartup: async () => undefined,
  setWriteEnabled: async () => undefined,
  applyFolderRules: async () => undefined,
  setExcludedPrefixes: async () => undefined,
});

const sectionNames = (root: HTMLElement): Array<string | null> =>
  Array.from(root.querySelectorAll("[data-settings-section]"))
    .map((node) => node.getAttribute("data-settings-section"));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const connectedControllerFixture = (
  overrides: Partial<SettingsController> = {},
): SettingsController => ({
  ...settingsControllerFixture(),
  settings: () => ({
    ...settingsControllerFixture().settings(),
    aiEnabled: true,
  }),
  saveAiSettings: async () => undefined,
  setSessionAiSecret: () => undefined,
  catalogConnection: () => ({ status: "authorized" }),
  connectCatalog: async () => undefined,
  submitCatalogAuthorizationCode: async () => undefined,
  cancelCatalogAuthorization: () => undefined,
  revokeCatalog: async () => undefined,
  validateCatalogScanRoot: (root) => root,
  requestCatalogScan: async () => undefined,
  ...overrides,
});

describe("shared grouped settings surface", () => {
  it("renders the same five grouped settings in both hosts", () => {
    const controller = settingsControllerFixture();
    const nativeRoot = createTestDiv();
    const workbenchRoot = createTestDiv();
    const native = createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
      createSecretComponent: undefined,
    });
    const workbench = createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
      createSecretComponent: undefined,
    });

    native.render(nativeRoot, "zh-CN");
    workbench.render(workbenchRoot, "zh-CN");

    expect(sectionNames(nativeRoot)).toEqual([
      "language", "baidu", "large-catalog", "verification", "privacy-ai",
    ]);
    expect(sectionNames(workbenchRoot)).toEqual(sectionNames(nativeRoot));
  });

  it("keeps cards collapsed while language remains directly usable", () => {
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller: settingsControllerFixture(),
      policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");

    expect(Array.from(root.querySelectorAll("details[data-settings-section]")))
      .toHaveLength(4);
    expect(Array.from(root.querySelectorAll("details[data-settings-section]")))
      .toSatisfy((cards: HTMLDetailsElement[]) => cards.every((card) => !card.open));
    expect(root.querySelector('[data-settings-section="language"] select[data-locale]'))
      .not.toBeNull();
  });

  it("never exposes credential values through text content", () => {
    const root = createTestDiv();
    const surface = createSettingsSectionsSurface({
      app: {} as App,
      controller: settingsControllerFixture(),
      policy: NORMAL_RUNTIME_POLICY,
    });
    surface.render(root, "zh-CN");
    const baidu = root.querySelector<HTMLDetailsElement>('[data-settings-section="baidu"]');
    expect(baidu).not.toBeNull();
    if (baidu === null) return;
    baidu.open = true;
    const privateValue = "private-app-key-value";
    const input = baidu.querySelector<HTMLInputElement>('[data-catalog-app-key="true"]');
    if (input !== null) input.value = privateValue;
    expect(root.textContent).not.toContain(privateValue);
  });

  it("does not construct secret or network controls in acceptance", () => {
    const createSecretComponent = vi.fn(() => {
      throw new Error("must not construct SecretComponent");
    });
    const controller: SettingsController = {
      ...settingsControllerFixture(),
      connectCatalog: vi.fn(async () => undefined),
      requestCatalogScan: vi.fn(async () => undefined),
      saveAiSettings: vi.fn(async () => undefined),
    };
    const root = createTestDiv();

    expect(() => createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: READ_ONLY_ACCEPTANCE_POLICY,
      createSecretComponent,
    }).render(root, "zh-CN")).not.toThrow();

    expect(createSecretComponent).not.toHaveBeenCalled();
    expect(root.querySelector('[data-action="catalog-connect"]')).toBeNull();
    expect(root.querySelector('[data-action="catalog-start-scan"]')).toBeNull();
    expect(root.querySelector('[data-ai-enabled="true"]')).toBeNull();
  });

  it("routes both hosts through the same controller contract", async () => {
    const startup = vi.fn(async () => undefined);
    let activeLocale: "zh-CN" | "en" = "zh-CN";
    const locale = vi.fn(async (value: "zh-CN" | "en") => { activeLocale = value; });
    const controller: SettingsController = {
      ...settingsControllerFixture(),
      settings: () => ({ ...settingsControllerFixture().settings(), locale: activeLocale }),
      setOpenAtStartup: startup,
      setLocale: locale,
    };
    const nativeRoot = createTestDiv();
    const workbenchRoot = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(nativeRoot, "zh-CN");
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(workbenchRoot, "zh-CN");

    const startupInput = nativeRoot.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    startupInput.checked = true;
    startupInput.dispatchEvent(new Event("change", { bubbles: true }));
    const localeSelect = workbenchRoot.querySelector<HTMLSelectElement>("select[data-locale]")!;
    localeSelect.value = "en";
    localeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(startup).toHaveBeenCalledWith(true);
    expect(locale).toHaveBeenCalledWith("en");
    expect(workbenchRoot.querySelector("h2")?.textContent).toBe("Knowledge Workbench settings");

    const nativeLocale = nativeRoot.querySelector<HTMLSelectElement>("select[data-locale]")!;
    activeLocale = "zh-CN";
    nativeLocale.value = "en";
    nativeLocale.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeRoot.querySelector("h2")?.textContent).toBe("Knowledge Workbench settings");
  });

  it("fills the session-only cloud root from the directory picker without saving settings", async () => {
    const selection: CloudDirectorySelection = {
      kind: "directory",
      selectedPath: "/Synthetic/9-文学253册",
      effectiveRoot: "/Synthetic/9-文学253册",
    };
    const chooseCatalogRoot = vi.fn(async () => selection);
    const setOpenAtStartup = vi.fn(async () => undefined);
    const setLocale = vi.fn(async () => undefined);
    const requestCatalogScan = vi.fn(async () => undefined);
    const controller = connectedControllerFixture({
      chooseCatalogRoot,
      setOpenAtStartup,
      setLocale,
      requestCatalogScan,
    });
    const root = createTestDiv();
    const surface = createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    });
    surface.render(root, "zh-CN");
    const input = root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    const details = input.closest("details");
    const choose = root.querySelector<HTMLButtonElement>(
      '[data-action="browse-catalog-scan-root"]',
    )!;

    expect(root.querySelector('[data-cloud-directory-current="true"]')?.textContent)
      .toContain("尚未选择目录");
    expect(details?.open).toBe(false);
    expect(choose.textContent).toBe("选择目录");
    expect(root.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')?.disabled)
      .toBe(true);

    choose.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chooseCatalogRoot).toHaveBeenCalledWith({
      initialRoot: "",
      purpose: { kind: "scan" },
    });
    expect(input.value).toBe("/Synthetic/9-文学253册");
    expect(root.querySelector('[data-cloud-directory-current="true"]')?.textContent)
      .toContain("/Synthetic/9-文学253册");
    await vi.waitFor(() => expect(
      root.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')?.disabled,
    ).toBe(false));
    expect(setOpenAtStartup).not.toHaveBeenCalled();
    expect(setLocale).not.toHaveBeenCalled();
    expect(requestCatalogScan).not.toHaveBeenCalled();
    surface.render(root, "zh-CN");
    expect(root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')?.value)
      .toBe("/Synthetic/9-文学253册");
  });

  it("applies verification categories and directories locally without starting cloud work", async () => {
    const groupA = `group:${"a".repeat(64)}`;
    const groupB = `group:${"b".repeat(64)}`;
    const purpose: CloudDirectoryPickerPurpose = {
      kind: "verification",
      groups: [{ groupKey: groupA, rootRelativePath: "A", label: "甲" }, {
        groupKey: groupB,
        rootRelativePath: "B",
        label: "乙",
      }],
    };
    const category: CloudDirectorySelection = {
      kind: "category",
      selectedPath: "/科学文库/B",
      effectiveRoot: "/科学文库",
      groupKey: groupB,
    };
    const directory: CloudDirectorySelection = {
      kind: "directory",
      selectedPath: "/另一个父目录",
      effectiveRoot: "/另一个父目录",
    };
    const results: Array<CloudDirectorySelection | null> = [category, directory, null];
    const chooseCatalogRoot = vi.fn(async () => results.shift() ?? null);
    const requestCatalogScan = vi.fn(async () => undefined);
    const requestLargeCatalogVerification = vi.fn(async () => undefined);
    const active = {
      importedAt: 1,
      pdfCount: 3,
      unverifiedCount: 3,
      verifiedCount: 0,
      differenceCount: 0,
      cloudMissingCount: 0,
      groupCount: 2,
      verifiedGroupCount: 0,
      coveredCandidatePdfCount: 0,
      groups: [{
        groupKey: groupA,
        rootRelativePath: "A",
        label: "甲",
        pdfCount: 1,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }, {
        groupKey: groupB,
        rootRelativePath: "B",
        label: "乙",
        pdfCount: 2,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }],
    };
    const controller = connectedControllerFixture({
      chooseCatalogRoot,
      requestCatalogScan,
      hybridCatalog: () => ({ status: "ready", active }),
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification,
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");
    const groupAInput = root.querySelector<HTMLInputElement>(
      `[data-catalog-group-key="${groupA}"]`,
    )!;
    groupAInput.checked = true;
    groupAInput.dispatchEvent(new Event("change", { bubbles: true }));
    const choose = root.querySelector<HTMLButtonElement>(
      '[data-action="browse-catalog-large-scan-root"]',
    )!;

    choose.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(chooseCatalogRoot).toHaveBeenNthCalledWith(1, {
      initialRoot: "",
      purpose,
    });
    expect(root.querySelector<HTMLInputElement>('[data-catalog-large-scan-root="true"]')?.value)
      .toBe("/科学文库");
    expect(root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupA}"]`)?.checked)
      .toBe(false);
    expect(root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupB}"]`)?.checked)
      .toBe(true);
    expect(root.textContent).toContain("/科学文库/B");
    expect(root.textContent).toContain("实际核验父目录：/科学文库");

    await vi.waitFor(() => expect(choose.disabled).toBe(false));
    groupAInput.checked = true;
    groupAInput.dispatchEvent(new Event("change", { bubbles: true }));
    choose.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector<HTMLInputElement>('[data-catalog-large-scan-root="true"]')?.value)
      .toBe("/另一个父目录");
    expect(root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupA}"]`)?.checked)
      .toBe(true);
    expect(root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupB}"]`)?.checked)
      .toBe(true);

    choose.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector<HTMLInputElement>('[data-catalog-large-scan-root="true"]')?.value)
      .toBe("/另一个父目录");
    const input = root.querySelector<HTMLInputElement>('[data-catalog-large-scan-root="true"]')!;
    input.value = "/手工父目录";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.textContent).not.toContain("/另一个父目录");
    expect(requestCatalogScan).not.toHaveBeenCalled();
    expect(requestLargeCatalogVerification).not.toHaveBeenCalled();
  });

  it("rejects a category result from the scan-purpose chooser", async () => {
    const requestCatalogScan = vi.fn(async () => undefined);
    const chooseCatalogRoot = vi.fn(async (): Promise<CloudDirectorySelection> => ({
      kind: "category",
      selectedPath: "/科学文库/分类",
      effectiveRoot: "/科学文库",
      groupKey: `group:${"c".repeat(64)}`,
    }));
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller: connectedControllerFixture({ chooseCatalogRoot, requestCatalogScan }),
      policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");

    root.querySelector<HTMLButtonElement>('[data-action="browse-catalog-scan-root"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')?.value).toBe("");
    expect(requestCatalogScan).not.toHaveBeenCalled();
  });

  it("drops category context when the user manually changes verification groups", async () => {
    const groupA = `group:${"d".repeat(64)}`;
    const groupB = `group:${"e".repeat(64)}`;
    const active = {
      importedAt: 1,
      pdfCount: 3,
      unverifiedCount: 3,
      verifiedCount: 0,
      differenceCount: 0,
      cloudMissingCount: 0,
      groupCount: 2,
      verifiedGroupCount: 0,
      coveredCandidatePdfCount: 0,
      groups: [{
        groupKey: groupA,
        rootRelativePath: "A",
        label: "甲",
        pdfCount: 1,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }, {
        groupKey: groupB,
        rootRelativePath: "B",
        label: "乙",
        pdfCount: 2,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }],
    };
    const requestLargeCatalogVerification = vi.fn(async () => undefined);
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller: connectedControllerFixture({
        chooseCatalogRoot: async () => ({
          kind: "category",
          selectedPath: "/科学文库/B",
          effectiveRoot: "/科学文库",
          groupKey: groupB,
        }),
        hybridCatalog: () => ({ status: "ready", active }),
        subscribeHybridCatalog: () => () => undefined,
        previewCatalogTxt: async () => undefined,
        requestCatalogTxtImport: async () => undefined,
        requestLargeCatalogVerification,
        requestResumeLargeCatalogVerification: async () => undefined,
        cancelLargeCatalogVerification: () => undefined,
      }),
      policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");
    root.querySelector<HTMLButtonElement>(
      '[data-action="browse-catalog-large-scan-root"]',
    )?.click();
    await vi.waitFor(() => expect(root.textContent).toContain("/科学文库/B"));

    const groupAInput = root.querySelector<HTMLInputElement>(
      `[data-catalog-group-key="${groupA}"]`,
    )!;
    groupAInput.checked = true;
    groupAInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(root.querySelector<HTMLInputElement>('[data-catalog-large-scan-root="true"]')?.value)
      .toBe("/科学文库");
    expect(root.textContent).not.toContain("/科学文库/B");
    expect(root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupB}"]`)?.checked)
      .toBe(true);
    const start = root.querySelector<HTMLButtonElement>(
      '[data-action="catalog-start-large-verification"]',
    )!;
    expect(start.disabled).toBe(false);
    start.click();
    expect(requestLargeCatalogVerification).toHaveBeenCalledWith(
      "/科学文库",
      [groupB, groupA],
      expect.any(Function),
      undefined,
    );
  });

  it("keeps scan and category verification gated by a valid non-root draft and busy state", () => {
    const groupKey = `group:${"c".repeat(64)}`;
    let connectionListener = (): void => undefined;
    let hybridListener = (): void => undefined;
    let connectionStatus: "authorized" | "scanning" = "authorized";
    let hybridStatus: "ready" | "scanning" = "ready";
    const controller = connectedControllerFixture({
      catalogConnection: () => ({ status: connectionStatus }),
      subscribeCatalogConnection: (listener) => {
        connectionListener = listener;
        return () => { connectionListener = (): void => undefined; };
      },
      hybridCatalog: () => ({
        status: hybridStatus,
        active: {
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
            mode: "recursive",
            verificationStatus: "unverified",
          }],
        },
      }),
      subscribeHybridCatalog: (listener) => {
        hybridListener = listener;
        return () => { hybridListener = (): void => undefined; };
      },
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async () => undefined,
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
      validateCatalogScanRoot: (value) => {
        if (!value.startsWith("/") || value === "/" || value.includes("//")) {
          throw new Error("invalid-root");
        }
        return value;
      },
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");
    const scanInput = root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    const scanStart = root.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')!;
    const verificationInput = root.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )!;
    const verificationStart = root.querySelector<HTMLButtonElement>(
      '[data-action="catalog-start-large-verification"]',
    )!;
    const group = root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupKey}"]`)!;

    expect(root.querySelector<HTMLButtonElement>('[data-action="browse-catalog-scan-root"]')?.hidden)
      .toBe(true);
    expect(root.querySelector<HTMLButtonElement>(
      '[data-action="browse-catalog-large-scan-root"]',
    )?.hidden).toBe(true);

    expect(scanStart.disabled).toBe(true);
    for (const invalid of ["/", "relative", "/Synthetic//Science"]) {
      scanInput.value = invalid;
      scanInput.dispatchEvent(new Event("input", { bubbles: true }));
      expect(scanStart.disabled).toBe(true);
    }
    scanInput.value = "/Synthetic";
    scanInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(scanStart.disabled).toBe(false);

    group.checked = true;
    group.dispatchEvent(new Event("change", { bubbles: true }));
    expect(verificationStart.disabled).toBe(true);
    verificationInput.value = "/Synthetic";
    verificationInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(verificationStart.disabled).toBe(false);

    connectionStatus = "scanning";
    hybridStatus = "scanning";
    connectionListener();
    hybridListener();
    expect(scanStart.disabled).toBe(true);
    expect(verificationStart.disabled).toBe(true);
    expect(scanInput.disabled).toBe(true);
    expect(verificationInput.disabled).toBe(true);
  });

  it("keeps status visible and folds verification counters", () => {
    const groupKey = `group:${"7".repeat(64)}`;
    const controller = connectedControllerFixture({
      hybridCatalog: () => ({
        status: "paused",
        active: {
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
            mode: "recursive",
            verificationStatus: "unverified",
          }],
        },
        batch: {
          batchId: "batch-settings-details",
          status: "paused",
          stopReason: "pdf-limit",
          resumeAvailable: true,
          runOrdinal: 2,
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
          autoResumeState: "inactive",
          autoSegmentIndex: 0,
          autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
        },
      }),
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async () => undefined,
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");

    expect(root.querySelector('[data-catalog-hybrid-batch-summary="true"]')?.textContent)
      .toContain("已暂停");
    const details = root.querySelector<HTMLDetailsElement>(
      'details[data-settings-verification-details="true"]',
    )!;
    expect(details.open).toBe(false);
    expect(details.querySelector('[data-catalog-hybrid-batch-requests="true"]')?.textContent)
      .toContain("427");
    expect(details.querySelector('[data-catalog-hybrid-batch-queue="true"]')?.textContent)
      .toContain("8");
    expect(details.querySelector('[data-catalog-hybrid-batch-stop="true"]')?.textContent)
      .toContain("达到 PDF 上限");
  });

  it("admits only one pending scan or category verification action", async () => {
    const groupKey = `group:${"e".repeat(64)}`;
    const scanGate = deferred();
    const verificationGate = deferred();
    const resumeGate = deferred();
    const requestCatalogScan = vi.fn(async () => scanGate.promise);
    const requestLargeCatalogVerification = vi.fn(async () => verificationGate.promise);
    const requestResumeLargeCatalogVerification = vi.fn(async () => resumeGate.promise);
    const controller = connectedControllerFixture({
      requestCatalogScan,
      hybridCatalog: () => ({
        status: "paused",
        active: {
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
            mode: "recursive",
            verificationStatus: "unverified",
          }],
        },
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-settings-pending-gate",
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
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification,
      requestResumeLargeCatalogVerification,
      cancelLargeCatalogVerification: () => undefined,
      validateCatalogScanRoot: (value) => {
        if (!value.startsWith("/") || value === "/" || value.includes("//")) {
          throw new Error("invalid-root");
        }
        return value;
      },
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");

    const scanInput = root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    const scanStart = root.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')!;
    scanInput.value = "/Synthetic/Scan";
    scanInput.dispatchEvent(new Event("input", { bubbles: true }));
    scanStart.click();
    scanStart.click();
    expect(requestCatalogScan).toHaveBeenCalledOnce();
    expect(scanStart.disabled).toBe(true);
    scanGate.resolve();
    await vi.waitFor(() => expect(scanStart.disabled).toBe(false));

    const group = root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupKey}"]`)!;
    const verificationInput = root.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )!;
    const verificationStart = root.querySelector<HTMLButtonElement>(
      '[data-action="catalog-start-large-verification"]',
    )!;
    const verificationResume = root.querySelector<HTMLButtonElement>(
      '[data-action="catalog-resume-large-verification"]',
    )!;
    group.checked = true;
    group.dispatchEvent(new Event("change", { bubbles: true }));
    verificationInput.value = "/Synthetic/Parent";
    verificationInput.dispatchEvent(new Event("input", { bubbles: true }));

    verificationStart.click();
    verificationStart.click();
    expect(requestLargeCatalogVerification).toHaveBeenCalledOnce();
    expect(verificationStart.disabled).toBe(true);
    expect(verificationResume.disabled).toBe(true);
    verificationGate.resolve();
    await vi.waitFor(() => expect(verificationResume.disabled).toBe(false));

    verificationResume.click();
    verificationResume.click();
    expect(requestResumeLargeCatalogVerification).toHaveBeenCalledOnce();
    expect(verificationStart.disabled).toBe(true);
    expect(verificationResume.disabled).toBe(true);
    resumeGate.resolve();
  });

  it("preserves independent scan and verification drafts plus groups across a language rerender", () => {
    const groupKey = `group:${"b".repeat(64)}`;
    const controller = connectedControllerFixture({
      hybridCatalog: () => ({
        status: "ready",
        active: {
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
            mode: "recursive",
            verificationStatus: "unverified",
          }],
        },
      }),
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async () => undefined,
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
    });
    const root = createTestDiv();
    const surface = createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    });
    surface.render(root, "zh-CN");
    const scan = root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    const verification = root.querySelector<HTMLInputElement>(
      '[data-catalog-large-scan-root="true"]',
    )!;
    const group = root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupKey}"]`)!;
    scan.value = "/Synthetic/Scan";
    scan.dispatchEvent(new Event("input", { bubbles: true }));
    verification.value = "/Synthetic/Verification";
    verification.dispatchEvent(new Event("input", { bubbles: true }));
    group.checked = true;
    group.dispatchEvent(new Event("change", { bubbles: true }));

    surface.render(root, "en");

    expect(root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')?.value)
      .toBe("/Synthetic/Scan");
    expect(root.querySelector<HTMLInputElement>('[data-catalog-large-scan-root="true"]')?.value)
      .toBe("/Synthetic/Verification");
    expect(root.querySelector<HTMLInputElement>(`[data-catalog-group-key="${groupKey}"]`)?.checked)
      .toBe(true);
    expect(root.textContent).toContain("Current directory");
  });

  it("rolls persistent controls back when saving fails", async () => {
    const privateFailure = new Error("private-credential-detail");
    const controller: SettingsController = {
      ...settingsControllerFixture(),
      setOpenAtStartup: async () => { throw privateFailure; },
      setLocale: async () => { throw privateFailure; },
    };
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");
    const startup = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    startup.checked = true;
    startup.dispatchEvent(new Event("change", { bubbles: true }));
    const locale = root.querySelector<HTMLSelectElement>("select[data-locale]")!;
    locale.value = "en";
    locale.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(startup.checked).toBe(false);
    expect(locale.value).toBe("zh-CN");
    expect(root.textContent).not.toContain("private-credential-detail");
  });

  it("clears every credential value from the old DOM immediately on dispose", () => {
    const root = createTestDiv();
    const surface = createSettingsSectionsSurface({
      app: {} as App,
      controller: connectedControllerFixture(),
      policy: NORMAL_RUNTIME_POLICY,
    });
    surface.render(root, "zh-CN");
    const inputs = [
      root.querySelector<HTMLInputElement>('[data-catalog-app-key="true"]')!,
      root.querySelector<HTMLInputElement>('[data-catalog-secret-key="true"]')!,
      root.querySelector<HTMLInputElement>('[data-catalog-authorization-code="true"]')!,
      root.querySelector<HTMLInputElement>('[data-session-ai-secret="true"]')!,
    ];
    inputs.forEach((input, index) => {
      input.value = `private-${index}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    surface.dispose();

    expect(inputs.map((input) => input.value)).toEqual(["", "", "", ""]);
    inputs[0]!.value = "detached-value";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    surface.render(root, "zh-CN");
    expect(root.querySelector<HTMLInputElement>('[data-catalog-app-key="true"]')?.value)
      .toBe("");
  });

  it.each(["dispose", "rerender"] as const)(
    "does not revive an authorization timer after pending connect and %s",
    async (transition) => {
      vi.useFakeTimers();
      try {
        const gate = deferred();
        const cancel = vi.fn();
        let connection = { status: "configured" as const } as
          ReturnType<NonNullable<SettingsController["catalogConnection"]>>;
        const controller = connectedControllerFixture({
          catalogConnection: () => connection,
          connectCatalog: async () => {
            await gate.promise;
            connection = {
              status: "authorizing",
              authorizationExpiresAt: Date.now() + 10 * 60 * 1_000,
            };
          },
          cancelCatalogAuthorization: cancel,
        });
        const root = createTestDiv();
        const surface = createSettingsSectionsSurface({
          app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
        });
        surface.render(root, "zh-CN");
        const oldStatus = root.querySelector<HTMLElement>('[role="status"]')!;
        root.querySelector<HTMLButtonElement>('[data-action="catalog-connect"]')!.click();
        if (transition === "dispose") surface.dispose();
        else surface.render(root, "en");

        gate.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

        expect(cancel).not.toHaveBeenCalled();
        expect(oldStatus.textContent).not.toContain("已保存");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("merges each folder-rule save with the controller's current settings", async () => {
    let folderRules: FolderRule[] = [];
    const applied: FolderRule[][] = [];
    const controller: SettingsController = {
      ...settingsControllerFixture(),
      settings: () => ({
        ...settingsControllerFixture().settings(),
        folderRules: structuredClone(folderRules),
      }),
      folderRuleProposals: () => [
        { prefix: "A", kind: "reference", noteCount: 1, unclassifiedCount: 1, samplePaths: ["A/1.md"] },
        { prefix: "B", kind: "reference", noteCount: 1, unclassifiedCount: 1, samplePaths: ["B/1.md"] },
      ],
      applyFolderRules: async (rules) => {
        folderRules = [...structuredClone(rules)];
        applied.push([...structuredClone(rules)]);
      },
    };
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");
    const choices = Array.from(root.querySelectorAll<HTMLInputElement>("[data-folder-rule]"));
    const save = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "确认所选规则")!;
    choices[0]!.checked = true;
    choices[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    save.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(choices[0]!.checked).toBe(false);
    choices[1]!.checked = true;
    choices[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    save.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(applied).toEqual([
      [{ prefix: "A", kind: "reference" }],
      [{ prefix: "A", kind: "reference" }, { prefix: "B", kind: "reference" }],
    ]);
  });

  it("localizes save, connection, scan, batch, and verification states", async () => {
    const controller = connectedControllerFixture({
      catalogConnection: () => ({ status: "paused" }),
      hybridCatalog: () => ({
        status: "paused",
        active: {
          importedAt: 1,
          pdfCount: 1,
          unverifiedCount: 1,
          verifiedCount: 0,
          differenceCount: 1,
          cloudMissingCount: 0,
          groupCount: 1,
          verifiedGroupCount: 0,
          coveredCandidatePdfCount: 0,
          groups: [{
            groupKey: `group:${"a".repeat(64)}`,
            rootRelativePath: "A",
            label: "A",
            pdfCount: 1,
            mode: "recursive",
            verificationStatus: "difference",
          }],
        },
        batch: {
          ...INACTIVE_AUTO_RESUME,
          batchId: "batch-settings-sections",
          status: "paused",
          stopReason: "pdf-limit",
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
      subscribeHybridCatalog: () => () => undefined,
      previewCatalogTxt: async () => undefined,
      requestCatalogTxtImport: async () => undefined,
      requestLargeCatalogVerification: async () => undefined,
      requestResumeLargeCatalogVerification: async () => undefined,
      cancelLargeCatalogVerification: () => undefined,
    });
    const zhRoot = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(zhRoot, "zh-CN");
    const startup = zhRoot.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    startup.checked = true;
    startup.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(zhRoot.textContent).not.toMatch(
      /Startup preference|Folder rules|paused|scanning|unverified|difference|pdf limit/u,
    );
    expect(zhRoot.textContent).toContain("已暂停");
    expect(zhRoot.textContent).toContain("存在差异");

    const enRoot = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(enRoot, "en");
    expect(enRoot.textContent).toContain("paused");
    expect(enRoot.textContent).toContain("difference");
  });

  it.each([
    ["zh-CN", "授权码无效"],
    ["en", "The authorization code is invalid"],
  ] as const)("shows a safe localized OAuth failure in %s", (locale, expected) => {
    const controller = connectedControllerFixture({
      settings: () => ({ ...settingsControllerFixture().settings(), locale }),
      catalogConnection: () => ({
        status: "configured",
        messageCode: "authorization-code-invalid",
      }),
    });
    const root = createTestDiv();

    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(root, locale);

    expect(root.querySelector('[data-catalog-connection-message="true"]')?.textContent)
      .toBe(expected);
    expect(root.textContent).not.toContain("SECRET-RUNTIME-DETAIL");
  });

  it("localizes progress without losing exact requests, elapsed time, or stop reason", () => {
    const progress = presentCatalogProgress({
      status: "paused",
      scanProgress: {
        status: "paused",
        directoryCount: 2,
        completedDirectoryCount: 2,
        pdfCount: 12,
        ignoredFileCount: 0,
        pendingDirectoryCount: 1,
        listRequestCount: 7,
        elapsedMs: 4_321,
        budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
        stopReason: "baidu-not-found",
      },
    }, createWorkbenchI18n("zh-CN"));

    expect(progress.requestProgress).toBe("列表请求：7 / 25");
    expect(progress.timeProgress).toBe("已用时间：4,321 毫秒 / 120,000 毫秒");
    expect(progress.stopReason).toBe("停止原因：百度网盘路径不存在");
  });

  it.each([
    ["zh-CN", "扫描状态：已暂停", "PDF：123 / 1,000", "已用时间：4,321 毫秒 / 120,000 毫秒"],
    ["en", "Scan status: paused", "PDFs: 123 / 1,000", "Elapsed: 4,321 ms / 120,000 ms"],
  ] as const)("renders shared-workbench progress through the locale-aware presenter in %s", (
    locale,
    expectedStatus,
    expectedPdf,
    expectedTime,
  ) => {
    const controller = connectedControllerFixture({
      settings: () => ({ ...settingsControllerFixture().settings(), locale }),
      catalogConnection: () => ({
        status: "paused",
        scanProgress: {
          status: "paused",
          directoryCount: 20,
          completedDirectoryCount: 20,
          pdfCount: 123,
          ignoredFileCount: 0,
          pendingDirectoryCount: 0,
          listRequestCount: 25,
          elapsedMs: 4_321,
          budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
          stopReason: "pdf-limit",
        },
      }),
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    }, presentCatalogProgress).render(root, locale);

    expect(root.querySelector('[data-catalog-scan-status="true"]')?.textContent).toBe(expectedStatus);
    expect(root.querySelector('[data-catalog-pdf-progress="true"]')?.textContent).toBe(expectedPdf);
    expect(root.querySelector('[data-catalog-time-progress="true"]')?.textContent).toBe(expectedTime);
  });
});
