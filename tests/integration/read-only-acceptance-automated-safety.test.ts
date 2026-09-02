// @ts-expect-error jsdom is a Vitest runtime dependency without bundled declarations.
import * as jsdomRuntime from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DISABLED_CLOUD_CATALOG_RUNTIME } from "../../src/catalog/disabled-cloud-catalog-runtime";
import { ClassificationService } from "../../src/classification/classification-service";
import { PLUGIN_DATA_SCHEMA_VERSION } from "../../src/constants";
import type { PluginDataPort } from "../../src/core/ports";
import type { DocumentRecord } from "../../src/core/types";
import type { IncrementalIndexQueue } from "../../src/indexing/incremental-index-queue";
import type { IndexService } from "../../src/indexing/index-service";
import { MapService } from "../../src/map/map-service";
import {
  ChangePlanService,
  type ConfirmedPlan,
  type PlanPreview,
} from "../../src/plans/change-plan-service";
import {
  READ_ONLY_QUICK_CAPTURE_PORT,
  READ_ONLY_VAULT_WRITE_PORT,
} from "../../src/runtime/read-only-ports";
import type { RuntimeComposition } from "../../src/runtime/runtime-composition";
import { READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";
import { runStartupGate } from "../../src/runtime/startup-gate";
import type { PluginData } from "../../src/storage/plugin-data";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import { EMPTY_RECENT_CLOUD_DIRECTORIES } from "../../src/storage/recent-cloud-directories";
import { SuggestionService } from "../../src/suggestions/suggestion-service";
import { TodayService } from "../../src/today/today-service";
import { OperationJournal, type JournalEntry } from "../../src/transactions/operation-journal";
import { RecoveryReadinessGate } from "../../src/transactions/recovery-readiness-gate";
import { TransactionService } from "../../src/transactions/transaction-service";
import {
  WorkbenchController,
  type WorkbenchDependencies,
} from "../../src/ui/workbench-controller";
import { FakeVault } from "../fakes/fake-vault";
import { MemoryPluginDataPort } from "../fakes/memory-plugin-data-port";

const capturedComposition = vi.hoisted<{ value: unknown }>(() => ({ value: null }));
const JSDOMRuntime = (jsdomRuntime as unknown as {
  readonly JSDOM: new (html: string) => Readonly<{ window: Window }>;
}).JSDOM;
const acceptanceDom = new JSDOMRuntime("<!doctype html><html><body></body></html>");

vi.mock("obsidian", () => ({
  Modal: class ModalSurface {
    readonly contentEl = acceptanceDom.window.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    readonly titleEl = acceptanceDom.window.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "h2",
    ) as HTMLHeadingElement;
    setTitle(value: string): this { this.titleEl.textContent = value; return this; }
    open(): void {
      acceptanceDom.window.document.body.append(this.titleEl, this.contentEl);
      this.onOpen();
    }
    close(): void { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
    onOpen(): void {}
    onClose(): void {}
  },
  PluginSettingTab: class SettingsSurface {
    readonly containerEl = acceptanceDom.window.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
  },
}));

vi.mock("../../src/plugin/knowledge-workbench-plugin", () => ({
  createKnowledgeWorkbenchPluginClass: (runtime: unknown) => {
    capturedComposition.value = runtime;
    return class AcceptancePlugin {};
  },
}));

afterAll(() => {
  acceptanceDom.window.close();
});

const ACCEPTANCE_ENDPOINT = "https://acceptance.invalid/v1";
const ACCEPTANCE_MODEL = "acceptance-fixture-model";

const ACCEPTANCE_RECORD: DocumentRecord = Object.freeze({
  id: "acceptance-alpha",
  path: "Notes/Alpha.md",
  basename: "Alpha",
  kind: "unclassified",
  title: "Alpha",
  aliases: [],
  headings: [],
  tags: [],
  ownedFields: {},
  relationFields: {},
  outgoingLinks: [],
  tokens: ["alpha"],
  mtime: 1,
  size: 1,
  contentHash: "acceptance-alpha-hash",
});

const historicalUnsafeData = (): PluginData => ({
  schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
  settings: {
    writeEnabled: true,
    writePreviewAcknowledged: true,
    locale: "zh-CN",
    openAtStartup: true,
    folderRules: [],
    excludedPrefixes: [],
    aiEnabled: true,
    aiEndpoint: ACCEPTANCE_ENDPOINT,
    aiModel: ACCEPTANCE_MODEL,
    secretId: "",
    recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
    boundCloudLibrary: null,
    cloudVerificationGeneration: 0,
    verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
    legacyVerificationAdoption: { schemaVersion: 1, state: "pending" } as const,
  },
  activeIndex: null,
  staging: null,
  operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
});

type PolicyFault = "save" | "reload" | "silently-preserve";

class PolicyFaultPort implements PluginDataPort {
  private data: unknown = structuredClone(historicalUnsafeData());
  private loadCount = 0;

  constructor(private readonly fault: PolicyFault) {}

  async load(): Promise<unknown> {
    this.loadCount += 1;
    if (this.fault === "reload" && this.loadCount > 1) {
      throw new Error("injected reload detail must remain private");
    }
    return structuredClone(this.data);
  }

  async save(data: unknown): Promise<void> {
    if (this.fault === "save") throw new Error("injected save detail must remain private");
    if (this.fault !== "silently-preserve") this.data = structuredClone(data);
  }
}

const throwingAiSettings = (): Parameters<
  WorkbenchController["saveAiSettings"]
>[0] => Object.defineProperties({}, {
  enabled: { get: () => { throw new Error("must not inspect enabled"); } },
  endpoint: { get: () => { throw new Error("must not inspect endpoint"); } },
  model: { get: () => { throw new Error("must not inspect model"); } },
  secretId: { get: () => { throw new Error("must not inspect secretId"); } },
}) as Parameters<WorkbenchController["saveAiSettings"]>[0];

const throwingSelection = (): readonly string[] => new Proxy([], {
  get: () => { throw new Error("must not inspect selection"); },
  ownKeys: () => { throw new Error("must not enumerate selection"); },
});

const acceptancePreview = (): PlanPreview => ({
  plan: {
    id: "acceptance-preview",
    fingerprint: "acceptance-preview-fingerprint",
    operations: [{
      id: "acceptance-preview-rename",
      kind: "rename",
      sourcePath: "Notes/Alpha.md",
      targetPath: "Notes/Beta.md",
    }],
    preconditions: [{
      path: "Notes/Alpha.md",
      exists: true,
      mtime: 1,
      contentHash: "acceptance-alpha-hash",
    }, {
      path: "Notes/Beta.md",
      exists: false,
    }],
    rationales: {
      "acceptance-preview-rename": {
        source: "local",
        summary: "Synthetic rename preview",
        signals: ["acceptance-fixture"],
        confidence: "high",
        impact: 80,
      },
    },
    localRationales: {
      "acceptance-preview-rename": {
        source: "local",
        summary: "Synthetic rename preview",
        signals: ["acceptance-fixture"],
        confidence: "high",
        impact: 80,
      },
    },
  },
  conflicts: [],
  affectedFiles: ["Notes/Alpha.md", "Notes/Beta.md"],
  undoableOperationIds: ["acceptance-preview-rename"],
});

const createAcceptanceControllerFixture = async () => {
  const base = historicalUnsafeData();
  const port = new MemoryPluginDataPort({
    ...base,
    settings: {
      ...base.settings,
      folderRules: [{ prefix: "Notes", kind: "note" }],
    },
    activeIndex: { builtAt: 1, records: [ACCEPTANCE_RECORD] },
  });
  const store = new PluginDataStore(port);
  await store.load();
  const vault = FakeVault.withNotes([ACCEPTANCE_RECORD.path]);
  const changePlans = new ChangePlanService(vault, () => true);
  const recoveryPreview = await changePlans.preview([{
    id: "acceptance-recovery-rename",
    kind: "rename",
    sourcePath: "Notes/Alpha.md",
    targetPath: "Notes/Recovery.md",
  }]);
  const recoveryPlan = await changePlans.confirm(
    recoveryPreview,
    ["acceptance-recovery-rename"],
  );
  const recovery: JournalEntry = {
    id: "acceptance-recovery",
    status: "recovery-required",
    createdAt: 1,
    plan: recoveryPlan,
    prepared: null,
    completed: [],
    rolledBackOperationIds: [],
    error: "synthetic recovery detail",
    recovery: {
      unresolved: [{
        operationId: "acceptance-recovery-rename",
        originalPaths: ["Notes/Alpha.md"],
        currentPaths: ["Notes/Recovery.md"],
        comparison: "differs",
        reason: "synthetic recovery detail",
      }],
    },
  };
  const index = {
    activeRecords: () => structuredClone([ACCEPTANCE_RECORD]),
    subscribe: () => () => undefined,
    buildInitial: async () => undefined,
    reconcilePathPolicy: async () => undefined,
  } as unknown as IndexService;
  const indexQueue = {
    pauseAutoFlush: vi.fn(async () => undefined),
    resumeAndFlush: vi.fn(async () => undefined),
  } as unknown as IncrementalIndexQueue;
  const quickCapture = {
    calls: 0,
    async capture(): Promise<string | null> { this.calls += 1; return "Notes/Blocked.md"; },
  };
  const changePreview = {
    planCalls: 0,
    sampleCalls: 0,
    lastPreview: null as PlanPreview | null,
    async request(preview: PlanPreview): Promise<ConfirmedPlan | null> {
      this.planCalls += 1;
      this.lastPreview = structuredClone(preview);
      return null;
    },
    async requestSample(): Promise<boolean> { this.sampleCalls += 1; return true; },
  };
  const transactions = {
    calls: [] as ConfirmedPlan[],
    organizationWritesBlockedCalls: 0,
    organizationWritesBlocked(): boolean {
      this.organizationWritesBlockedCalls += 1;
      return false;
    },
    async execute(plan: ConfirmedPlan) {
      this.calls.push(plan);
      return { status: "completed" as const, journalId: "must-not-run" };
    },
  };
  const journal = {
    listCalls: 0,
    clearCalls: 0,
    async list(): Promise<readonly JournalEntry[]> {
      this.listCalls += 1;
      return structuredClone([recovery]);
    },
    async clearHistory(): Promise<void> { this.clearCalls += 1; },
  };
  const undo = {
    calls: [] as string[],
    async preview(id: string): Promise<PlanPreview> {
      this.calls.push(id);
      throw new Error("Undo preview must remain unreachable");
    },
  };
  const historyConfirmation = {
    calls: 0,
    async request(): Promise<boolean> { this.calls += 1; return true; },
  };
  const aiPreview = { request: vi.fn(async () => true) };
  const request = vi.fn(async () => ({ text: "must-not-run" }));
  const getSecret = vi.fn((_id: string) => null);
  const createClient = vi.fn((_endpoint: string, _model: string, _secret: string) => ({
    complete: request,
  }));
  const dependencies: WorkbenchDependencies = {
    policy: READ_ONLY_ACCEPTANCE_POLICY,
    reads: vault,
    index,
    indexQueue,
    classification: new ClassificationService(),
    today: new TodayService({ now: () => 100 }),
    map: new MapService(),
    suggestions: new SuggestionService(),
    changePlans,
    changePreview,
    store,
    workspace: { openNote: vi.fn(async () => undefined) },
    quickCapture,
    transactions,
    journal,
    undo,
    historyConfirmation,
    clock: { now: () => 100 },
    ai: {
      preview: aiPreview,
      getSecret,
      createClient,
      delay: vi.fn(async () => undefined),
    },
    catalog: DISABLED_CLOUD_CATALOG_RUNTIME,
    cloudVerificationRootHasher: () => null,
    catalogConfirmation: { request: async () => false },
  };
  const controller = new WorkbenchController(dependencies);
  const suggestions = controller.refreshSuggestions();
  if (suggestions.length === 0) throw new Error("Expected a synthetic organization suggestion");
  return {
    controller,
    store,
    port,
    vault,
    changePlans,
    changePreview,
    transactions,
    journal,
    undo,
    historyConfirmation,
    quickCapture,
    aiPreview,
    request,
    getSecret,
    createClient,
    recovery,
  };
};

afterEach(() => {
  acceptanceDom.window.document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("read-only acceptance automated safety", () => {
  it("loads the exact frozen production acceptance composition without a normal-only factory", async () => {
    vi.stubGlobal("__KNOWLEDGE_WORKBENCH_BUILD_MODE__", "read-only-acceptance");
    vi.stubGlobal("__KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__", "0.1.0");
    vi.stubGlobal(
      "__KNOWLEDGE_WORKBENCH_MANIFEST_NAME__",
      "Knowledge Workbench (Read-only acceptance)",
    );
    vi.stubGlobal(
      "__KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__",
      "knowledge-workbench@0.1.0:read-only-acceptance",
    );
    try {
      await import("../../src/main-acceptance");
    } finally {
      vi.unstubAllGlobals();
    }

    const runtime = capturedComposition.value as RuntimeComposition;
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.keys(runtime)).toEqual([
      "policy",
      "artifact",
      "selectVaultWrites",
      "createQuickCapture",
      "createChangePreview",
      "createHistoryConfirmation",
      "createSettingsTab",
      "cloudVerificationRootHasher",
      "createCatalog",
      "createFolderSelection",
      "createCatalogConfirmation",
    ]);
    expect(runtime.policy).toEqual(READ_ONLY_ACCEPTANCE_POLICY);
    expect(Object.isFrozen(runtime.policy)).toBe(true);
    expect(runtime.artifact).toEqual({
      mode: "read-only-acceptance",
      pluginVersion: "0.1.0",
      manifestName: "Knowledge Workbench (Read-only acceptance)",
      artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    });
    expect(Object.isFrozen(runtime.artifact)).toBe(true);
    expect("createAi" in runtime).toBe(false);
    expect("createWorkbenchSettingsSurface" in runtime).toBe(false);
    expect("createCatalogDirectoryPicker" in runtime).toBe(false);
    expect(runtime.cloudVerificationRootHasher("/样本")).toBeNull();
    const folderSelection = runtime.createFolderSelection({
      store: {} as never,
      catalog: DISABLED_CLOUD_CATALOG_RUNTIME,
      clock: { now: () => 0 },
    });
    expect(folderSelection.sessionFactory.available).toBe(false);
    expect(folderSelection.hostCapability.available).toBe(false);
    expect(() => folderSelection.sessionFactory.create({
      purpose: { kind: "scan" },
      initialPath: null,
    })).toThrow("catalog-unavailable");

    const candidateWrites = {
      renameFile: vi.fn(async () => undefined),
      setOwnedField: vi.fn(async () => undefined),
    };
    expect(runtime.selectVaultWrites(candidateWrites)).toBe(READ_ONLY_VAULT_WRITE_PORT);
    expect(candidateWrites.renameFile).not.toHaveBeenCalled();
    expect(candidateWrites.setOwnedField).not.toHaveBeenCalled();
    await expect(runtime.createQuickCapture({} as never, () => "zh-CN").capture()).resolves.toBeNull();
    await expect(runtime.createHistoryConfirmation({} as never, () => "zh-CN").request()).resolves.toBe(false);
    const catalog = runtime.createCatalog({} as never);
    expect(catalog.connection).toBeUndefined();
    expect(catalog.directoryDiscovery).toBeUndefined();
    expect(catalog.directoryBrowser).toBeUndefined();
    expect(catalog.directoryLocator).toBeUndefined();
    expect(catalog.snapshot()).toMatchObject({
      status: "unavailable",
      messageCode: "catalog-unavailable",
    });
    await expect(
      runtime.createCatalogConfirmation({} as never, () => "zh-CN").request("/样本"),
    ).resolves.toBe(false);

    const confirm = vi.fn(async () => { throw new Error("must not confirm"); });
    const previewPresenter = runtime.createChangePreview(
      {} as never,
      { confirm } as unknown as ChangePlanService,
      () => "en",
    );
    const previewResult = previewPresenter.request(acceptancePreview());
    const acceptanceDocument = acceptanceDom.window.document;
    expect(acceptanceDocument.body.textContent).toContain("Change plan preview (read-only)");
    expect(acceptanceDocument.body.textContent).toContain(
      "Preview only. This build cannot confirm or execute changes.",
    );
    const unavailable = acceptanceDocument.body.querySelector<HTMLButtonElement>(
      '[data-action="confirm"]',
    );
    expect(unavailable).not.toBeNull();
    if (unavailable === null) throw new Error("Expected acceptance confirmation control");
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.type).toBe("button");
    const cancel = Array.from(
      acceptanceDocument.body.querySelectorAll<HTMLButtonElement>("button"),
    )
      .find((button) => button.textContent === "Cancel");
    expect(cancel).toBeDefined();
    if (cancel === undefined) throw new Error("Expected acceptance preview cancel control");
    cancel.click();
    await expect(previewResult).resolves.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    await expect(previewPresenter.requestSample()).resolves.toBe(false);

    const blockedSettings = {
      sample: vi.fn(),
      write: vi.fn(async () => undefined),
      saveAi: vi.fn(async () => undefined),
      session: vi.fn(),
    };
    const settingsController = {
      settings: () => historicalUnsafeData().settings,
      folderRuleProposals: () => [],
      previewSampleChange: blockedSettings.sample,
      setOpenAtStartup: vi.fn(async () => undefined),
      setWriteEnabled: blockedSettings.write,
      applyFolderRules: vi.fn(async () => undefined),
      setExcludedPrefixes: vi.fn(async () => undefined),
      saveAiSettings: blockedSettings.saveAi,
      setSessionAiSecret: blockedSettings.session,
    };
    const settingsTab = runtime.createSettingsTab(
      {} as never,
      {} as never,
      settingsController as never,
      () => "zh-CN",
    ) as unknown as { readonly containerEl: HTMLElement; display(): void };
    settingsTab.display();
    expect(settingsTab.containerEl.textContent).toContain(
      "只读验收版本不提供整理写入、AI 配置或请求，也不提供云端连接、本地导入和核验。",
    );
    expect(settingsTab.containerEl.querySelector('[data-write-enabled="true"]')).toBeNull();
    expect(settingsTab.containerEl.querySelector('[data-ai-enabled="true"]')).toBeNull();
    expect(settingsTab.containerEl.querySelector('[data-ai-endpoint="true"]')).toBeNull();
    expect(settingsTab.containerEl.querySelector('[data-ai-model="true"]')).toBeNull();
    expect(settingsTab.containerEl.querySelector('[data-session-ai-secret="true"]')).toBeNull();
    expect(blockedSettings.sample).not.toHaveBeenCalled();
    expect(blockedSettings.write).not.toHaveBeenCalled();
    expect(blockedSettings.saveAi).not.toHaveBeenCalled();
    expect(blockedSettings.session).not.toHaveBeenCalled();
  });

  it("durably normalizes historical write and AI settings through the startup gate", async () => {
    const port = new MemoryPluginDataPort(historicalUnsafeData());
    const order: string[] = [];

    const store = await runStartupGate({
      verifyArtifact: async () => { order.push("verify"); },
      loadStore: async () => {
        order.push("load");
        const value = new PluginDataStore(port);
        await value.load();
        return value;
      },
      enforcePolicy: async (value) => {
        order.push("normalize");
        await value.enforceRuntimePolicy(READ_ONLY_ACCEPTANCE_POLICY);
      },
    });
    order.push("compose");

    expect(order).toEqual(["verify", "load", "normalize", "compose"]);
    expect(store.settings()).toEqual({
      ...historicalUnsafeData().settings,
      writeEnabled: false,
      aiEnabled: false,
    });
    expect(port.saveCalls).toHaveLength(1);
    const persisted = await port.load() as PluginData;
    expect(persisted.settings).toMatchObject({
      writeEnabled: false,
      aiEnabled: false,
      aiEndpoint: ACCEPTANCE_ENDPOINT,
      aiModel: ACCEPTANCE_MODEL,
      secretId: "",
    });
  });

  it.each(["save", "reload", "silently-preserve"] as const)(
    "stops before composition when durable normalization cannot survive %s",
    async (fault) => {
      const compose = vi.fn();
      const verifyArtifact = vi.fn(async () => undefined);

      await expect(runStartupGate({
        verifyArtifact,
        loadStore: async () => {
          const store = new PluginDataStore(new PolicyFaultPort(fault));
          await store.load();
          return store;
        },
        enforcePolicy: (store) => store.enforceRuntimePolicy(READ_ONLY_ACCEPTANCE_POLICY),
      }).then(compose)).rejects.toThrow("Acceptance safety settings could not be verified");

      expect(verifyArtifact).toHaveBeenCalledOnce();
      expect(compose).not.toHaveBeenCalled();
    },
  );

  it("blocks controller and recovery-detail bypasses before every downstream callback", async () => {
    const fixture = await createAcceptanceControllerFixture();
    const suggestion = fixture.controller.refreshSuggestions()[0];
    if (suggestion === undefined) throw new Error("Expected an acceptance suggestion");

    await fixture.controller.refreshHistory();
    expect(fixture.controller.snapshot().history).toMatchObject({
      entries: [{ id: "acceptance-recovery", status: "recovery-required" }],
    });
    expect(fixture.controller.snapshot().history?.recoveryReport).toBeUndefined();
    const historyBeforeRecoveryBypass = fixture.controller.snapshot().history;

    await fixture.controller.previewSuggestion(suggestion.operation.id);
    const rationales = { [suggestion.operation.id]: suggestion.localRationale };
    const preview = await fixture.changePlans.preview(
      [suggestion.operation],
      [],
      rationales,
      rationales,
    );
    const confirmed = await fixture.changePlans.confirm(preview, [suggestion.operation.id]);
    await expect(fixture.controller.executeConfirmedPlan(confirmed, { origin: "suggestion" }))
      .resolves.toBeNull();
    await expect(fixture.controller.startQuickCapture()).resolves.toBeNull();
    await fixture.controller.previewUndo("acceptance-completed");
    await fixture.controller.requestClearHistory();
    await expect(fixture.controller.historyExportJson("2026-07-15T00:00:00.000Z"))
      .rejects.toThrow("Read-only acceptance mode blocks history details");
    await fixture.controller.viewRecovery(fixture.recovery.id);
    const historyAfterRecoveryBypass = fixture.controller.snapshot().history;
    expect(historyAfterRecoveryBypass).toEqual(historyBeforeRecoveryBypass);
    expect(historyAfterRecoveryBypass?.recoveryReport).toBeUndefined();
    const forbiddenRecoveryDetail = JSON.stringify(
      historyAfterRecoveryBypass?.recoveryReport ?? null,
    );
    expect(forbiddenRecoveryDetail).not.toContain("Notes/Alpha.md");
    expect(forbiddenRecoveryDetail).not.toContain("Notes/Recovery.md");
    expect(forbiddenRecoveryDetail).not.toContain("synthetic recovery detail");
    await fixture.controller.previewSampleChange();
    await fixture.controller.setWriteEnabled(true);
    await expect(fixture.controller.saveAiSettings(throwingAiSettings())).resolves.toBeUndefined();
    fixture.controller.setSessionAiSecret("must-not-be-retained");

    const selection = throwingSelection();
    const aiResults = await Promise.all([
      fixture.controller.summarize(selection),
      fixture.controller.nameCluster(selection),
      fixture.controller.explainRelation(selection, "acceptance-suggestion"),
      fixture.controller.suggestLabels(selection),
    ]);
    expect(aiResults).toEqual(Array.from({ length: 4 }, () => ({
      kind: "local-fallback",
      reason: "disabled",
    })));

    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.transactions.calls).toHaveLength(0);
    expect(fixture.transactions.organizationWritesBlockedCalls).toBe(0);
    expect(fixture.quickCapture.calls).toBe(0);
    expect(fixture.undo.calls).toHaveLength(0);
    expect(fixture.historyConfirmation.calls).toBe(0);
    expect(fixture.journal.listCalls).toBe(1);
    expect(fixture.journal.clearCalls).toBe(0);
    expect(fixture.changePreview.sampleCalls).toBe(0);
    expect(fixture.port.saveCalls).toHaveLength(0);
    expect(fixture.aiPreview.request).not.toHaveBeenCalled();
    expect(fixture.getSecret).not.toHaveBeenCalled();
    expect(fixture.createClient).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.vault.writeCalls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.store.settings()).toMatchObject({
      writeEnabled: true,
      aiEnabled: true,
      aiEndpoint: ACCEPTANCE_ENDPOINT,
      secretId: "",
    });
    expect(fixture.controller.settings()).toMatchObject({
      writeEnabled: false,
      aiEnabled: false,
      aiEndpoint: ACCEPTANCE_ENDPOINT,
      secretId: "",
    });
  });

  it("keeps direct rejecting ports immutable and inert", async () => {
    expect(Object.isFrozen(READ_ONLY_VAULT_WRITE_PORT)).toBe(true);
    expect(Object.isFrozen(READ_ONLY_QUICK_CAPTURE_PORT)).toBe(true);
    await expect(READ_ONLY_VAULT_WRITE_PORT.renameFile(
      "Generated/A.md",
      "Generated/B.md",
      { path: "Generated/A.md", exists: true, mtime: 1, contentHash: "synthetic" },
      { path: "Generated/B.md", exists: false },
    )).rejects.toThrow("Read-only acceptance mode blocks vault content writes");
    await expect(READ_ONLY_VAULT_WRITE_PORT.setOwnedField(
      "Generated/A.md",
      "knowledge-workbench-kind",
      { present: false },
      { present: true, value: "note" },
    )).rejects.toThrow("Read-only acceptance mode blocks vault content writes");
    await expect(READ_ONLY_QUICK_CAPTURE_PORT.capture()).resolves.toBeNull();
  });

  it("cannot reach a vault write adapter through a direct TransactionService call", async () => {
    const vault = FakeVault.withNotes(["Generated/A.md"]);
    const plans = new ChangePlanService(vault, () => true);
    const preview = await plans.preview([{
      id: "acceptance-rename",
      kind: "rename",
      sourcePath: "Generated/A.md",
      targetPath: "Generated/B.md",
    }]);
    const confirmed = await plans.confirm(preview, ["acceptance-rename"]);
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const service = new TransactionService(
      plans,
      vault,
      READ_ONLY_VAULT_WRITE_PORT,
      new OperationJournal(store),
      { now: () => 1 },
      RecoveryReadinessGate.readyForTests(),
    );

    await expect(service.execute(confirmed)).resolves.toMatchObject({ status: "rolled-back" });
    expect(vault.renameCalls).toHaveLength(0);
    expect(vault.setOwnedFieldCalls).toHaveLength(0);
    expect(vault.writeCalls).toHaveLength(0);
    await expect(vault.pathExists("Generated/A.md")).resolves.toBe(true);
    await expect(vault.pathExists("Generated/B.md")).resolves.toBe(false);
  });
});
