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
    const chooseCatalogRoot = vi.fn(async () => "/Synthetic/9-文学253册");
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
    input.value = "/Synthetic";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    root.querySelector<HTMLButtonElement>(
      '[data-action="browse-catalog-scan-root"]',
    )!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chooseCatalogRoot).toHaveBeenCalledWith("/Synthetic");
    expect(input.value).toBe("/Synthetic/9-文学253册");
    expect(setOpenAtStartup).not.toHaveBeenCalled();
    expect(setLocale).not.toHaveBeenCalled();
    expect(requestCatalogScan).not.toHaveBeenCalled();
    surface.render(root, "zh-CN");
    expect(root.querySelector<HTMLInputElement>('[data-catalog-scan-root="true"]')?.value)
      .toBe("/Synthetic/9-文学253册");
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
          groups: [{
            groupKey: `group:${"a".repeat(64)}`,
            label: "A",
            pdfCount: 1,
            mode: "recursive",
            verificationStatus: "difference",
          }],
        },
        batch: {
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
