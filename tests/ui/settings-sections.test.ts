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
    boundCloudLibrary: null,
    cloudVerificationGeneration: 0,
    verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
    legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
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
  overrides: Partial<SettingsController> & Record<string, unknown> = {},
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
      "language", "baidu", "catalog-data", "cloud-scan-advanced", "privacy-ai",
    ]);
    expect(sectionNames(workbenchRoot)).toEqual(sectionNames(nativeRoot));
  });

  it("renders one requested subsection and delegates category checking to Task", () => {
    const openTaskOverview = vi.fn();
    const root = createTestDiv();
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
        groupKey: `group:${"a".repeat(64)}`,
        rootRelativePath: "文学",
        label: "文学",
        pdfCount: 1,
        mode: "recursive" as const,
        verificationStatus: "unverified" as const,
      }],
    };
    createSettingsSectionsSurface({
      app: {} as App,
      controller: connectedControllerFixture({
        hybridCatalog: () => ({ ...TEST_INACTIVE_HYBRID_EXECUTION, status: "ready", active }),
        subscribeHybridCatalog: () => () => undefined,
        previewCatalogTxt: async () => undefined,
        requestCatalogTxtImport: async () => undefined,
      }),
      policy: NORMAL_RUNTIME_POLICY,
      onOpenTaskOverview: openTaskOverview,
    }).render(root, "zh-CN");

    expect(sectionNames(root)).toEqual([
      "language", "baidu", "catalog-data", "cloud-scan-advanced", "privacy-ai",
    ]);
    expect(root.querySelector('[data-catalog-group-key]')).toBeNull();
    expect(root.querySelector('[data-action="catalog-start-large-verification"]')).toBeNull();
    expect(root.querySelector('[data-action="catalog-resume-large-verification"]')).toBeNull();
    const action = root.querySelector<HTMLButtonElement>('[data-action="open-task-overview"]')!;
    expect(action.disabled).toBe(false);
    action.click();
    expect(openTaskOverview).toHaveBeenCalledOnce();
  });

  it("constructs only a requested scan section and returns to More", () => {
    const root = createTestDiv();
    const back = vi.fn();
    const secret = vi.fn();
    createSettingsSectionsSurface({
      app: {} as App,
      controller: connectedControllerFixture(),
      policy: NORMAL_RUNTIME_POLICY,
      createSecretComponent: secret,
    }).render(root, "zh-CN", { section: "cloud-scan-advanced", onBackToMore: back });

    expect(sectionNames(root)).toEqual(["cloud-scan-advanced"]);
    expect(root.querySelector('[data-catalog-app-key]')).toBeNull();
    expect(root.querySelector('[data-catalog-authorization-code]')).toBeNull();
    expect(secret).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('[data-action="more-back"]')?.click();
    expect(back).toHaveBeenCalledOnce();
  });

  it("validates and de-duplicates a pending scan while retaining the draft across language rerender", async () => {
    const root = createTestDiv();
    const pending = deferred();
    const requestCatalogScan = vi.fn(async () => pending.promise);
    const surface = createSettingsSectionsSurface({
      app: {} as App,
      controller: connectedControllerFixture({ requestCatalogScan }),
      policy: NORMAL_RUNTIME_POLICY,
    });

    surface.render(root, "zh-CN", { section: "cloud-scan-advanced" });
    let input = root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    let start = root.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')!;
    input.value = "/";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(true);

    input.value = "/session/library";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(false);
    surface.render(root, "en", { section: "cloud-scan-advanced" });
    input = root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    start = root.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')!;
    expect(input.value).toBe("/session/library");

    start.click();
    start.click();
    expect(requestCatalogScan).toHaveBeenCalledOnce();
    expect(requestCatalogScan).toHaveBeenCalledWith("/session/library", expect.any(Function));
    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();
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

  it("dispatches repair and identity replacement as distinct authorization intents", async () => {
    const connectCatalog = vi.fn(async () => undefined);
    const submitCatalogAuthorizationCode = vi.fn(async () => undefined);
    const revokeCatalog = vi.fn(async () => undefined);
    const controller = connectedControllerFixture({
      catalogConnection: () => ({ status: "configured" }),
      connectCatalog,
      submitCatalogAuthorizationCode,
      revokeCatalog,
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");

    expect(connectCatalog).not.toHaveBeenCalled();
    expect(submitCatalogAuthorizationCode).not.toHaveBeenCalled();
    expect(revokeCatalog).not.toHaveBeenCalled();
    const replacement = root.querySelector<HTMLDetailsElement>("[data-settings-replace-identity=\"true\"]");
    expect(replacement?.textContent).toContain("更换账号或凭据");
    expect(replacement?.textContent).toContain("需要重新选择书库；旧核验结果仅保留为历史");

    const appKey = root.querySelector<HTMLInputElement>('[data-catalog-app-key="true"]')!;
    const secretKey = root.querySelector<HTMLInputElement>('[data-catalog-secret-key="true"]')!;
    appKey.value = "repair-app";
    secretKey.value = "repair-secret";
    root.querySelector<HTMLButtonElement>('[data-action="catalog-connect"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(connectCatalog).toHaveBeenNthCalledWith(
      1,
      { appKey: "repair-app", secretKey: "repair-secret" },
      "repair-same-account",
    );
    const code = root.querySelector<HTMLInputElement>(
      '[data-catalog-authorization-code="true"]',
    )!;
    code.value = "repair-code";
    root.querySelector<HTMLButtonElement>(
      '[data-action="catalog-submit-authorization-code"]',
    )!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(submitCatalogAuthorizationCode).toHaveBeenNthCalledWith(
      1,
      "repair-code",
      "repair-same-account",
    );

    appKey.value = "replacement-app";
    secretKey.value = "replacement-secret";
    root.querySelector<HTMLButtonElement>(
      '[data-action="catalog-replace-identity"]',
    )!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(connectCatalog).toHaveBeenNthCalledWith(
      2,
      { appKey: "replacement-app", secretKey: "replacement-secret" },
      "replace-identity",
    );
    code.value = "replacement-code";
    root.querySelector<HTMLButtonElement>(
      '[data-action="catalog-submit-authorization-code"]',
    )!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(submitCatalogAuthorizationCode).toHaveBeenNthCalledWith(
      2,
      "replacement-code",
      "replace-identity",
    );

    root.querySelector<HTMLButtonElement>('[data-action="catalog-revoke"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(revokeCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    ["verification-must-pause", "请先暂停当前核验，再修改百度网盘授权。"],
    ["scan-must-cancel", "请先取消当前云端扫描，再修改百度网盘授权。"],
    ["cloud-authority-operation-busy", "另一项百度网盘权限操作正在进行，请稍后再试。"],
  ] as const)("maps native Settings authorization error %s to safe guidance", async (
    errorCode,
    expected,
  ) => {
    const controller = connectedControllerFixture({
      catalogConnection: () => ({ status: "configured" }),
      connectCatalog: async () => { throw new Error(errorCode); },
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App, controller, policy: NORMAL_RUNTIME_POLICY,
    }).render(root, "zh-CN");

    root.querySelector<HTMLButtonElement>('[data-action="catalog-connect"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector<HTMLElement>('[role="status"]')?.textContent).toBe(expected);
    expect(root.textContent).not.toContain(errorCode);
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
    }, presentCatalogProgress).render(root, locale, { section: "cloud-scan-advanced" });

    expect(root.querySelector('[data-catalog-scan-status="true"]')?.textContent).toBe(expectedStatus);
    expect(root.querySelector('[data-catalog-pdf-progress="true"]')?.textContent).toBe(expectedPdf);
    expect(root.querySelector('[data-catalog-time-progress="true"]')?.textContent).toBe(expectedTime);
  });

  it("keeps the shared scan lifecycle visible in More while scanning and exposes cancel", () => {
    let connection: ReturnType<NonNullable<SettingsController["catalogConnection"]>> = {
      status: "authorized",
    };
    let notifyConnection: (() => void) | undefined;
    const cancelCatalogScan = vi.fn();
    const controller = connectedControllerFixture({
      catalogConnection: () => connection,
      subscribeCatalogConnection: (listener) => {
        notifyConnection = listener;
        return () => undefined;
      },
      cancelCatalogScan,
    });
    const root = createTestDiv();
    createSettingsSectionsSurface({
      app: {} as App,
      controller,
      policy: NORMAL_RUNTIME_POLICY,
    }, presentCatalogProgress).render(root, "zh-CN", { section: "cloud-scan-advanced" });

    const input = root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')!;
    const start = root.querySelector<HTMLButtonElement>('[data-action="catalog-start-scan"]')!;
    const cancel = root.querySelector<HTMLButtonElement>('[data-action="catalog-cancel-scan"]')!;
    input.value = "/session/library";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(false);
    expect(cancel.hidden).toBe(true);

    connection = {
      status: "scanning",
      scanProgress: {
        status: "scanning", directoryCount: 2, completedDirectoryCount: 1,
        pdfCount: 3, ignoredFileCount: 0, pendingDirectoryCount: 1,
        listRequestCount: 2, elapsedMs: 10, budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
        stopReason: undefined,
      },
    };
    notifyConnection?.();
    expect(root.querySelector('[data-catalog-scan-status="true"]')?.textContent).toContain("扫描");
    expect(input.disabled).toBe(true);
    expect(start.disabled).toBe(true);
    expect(cancel.hidden).toBe(false);
    cancel.click();
    expect(cancelCatalogScan).toHaveBeenCalledOnce();
  });
});
