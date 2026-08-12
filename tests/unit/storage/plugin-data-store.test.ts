import { describe, expect, it, vi } from "vitest";
import { PLUGIN_DATA_SCHEMA_VERSION } from "../../../src/constants";
import type { PluginDataPort } from "../../../src/core/ports";
import { extractDocumentRecord } from "../../../src/indexing/markdown-record-extractor";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../../src/runtime/safety-policy";
import type { PluginSettings } from "../../../src/storage/plugin-data";
import { PluginDataStore } from "../../../src/storage/plugin-data-store";
import { OperationJournal } from "../../../src/transactions/operation-journal";
import { MemoryPluginDataPort } from "../../fakes/memory-plugin-data-port";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const clone = <T>(value: T): T => structuredClone(value);

class ControlledPluginDataPort implements PluginDataPort {
  private data: unknown;
  private loadCount = 0;

  constructor(
    initial: unknown,
    private readonly behavior: Readonly<{
      failSave?: boolean;
      failReload?: boolean;
      preserveHistoricalData?: boolean;
    }>,
  ) {
    this.data = clone(initial);
  }

  async load(): Promise<unknown> {
    this.loadCount += 1;
    if (this.behavior.failReload === true && this.loadCount > 1) {
      throw new Error("Injected reload failure");
    }
    return clone(this.data);
  }

  async save(data: unknown): Promise<void> {
    if (this.behavior.failSave === true) throw new Error("Injected policy save failure");
    if (this.behavior.preserveHistoricalData !== true) this.data = clone(data);
  }
}

const unsafeHistoricalData = (): unknown => ({
  schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
  settings: {
    writeEnabled: true,
    writePreviewAcknowledged: true,
    locale: "zh-CN",
    openAtStartup: true,
    folderRules: [],
    excludedPrefixes: [],
    aiEnabled: true,
    aiEndpoint: "https://example.test/v1",
    aiModel: "fixture",
    secretId: "fixture-secret",
  },
  activeIndex: null,
  staging: null,
  operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
});

describe("PluginDataStore", () => {
  it.each([
    ["missing locale", { openAtStartup: true }],
    ["invalid locale", { openAtStartup: true, locale: "fr" }],
  ])("defaults $0 to Simplified Chinese without clearing unrelated settings", async (_, settings) => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings,
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();
    expect(store.settings().locale).toBe("zh-CN");
    expect(store.settings().openAtStartup).toBe(true);
  });

  it("durably disables historical write and AI settings in acceptance mode", async () => {
    const port = new MemoryPluginDataPort(unsafeHistoricalData());
    const store = new PluginDataStore(port);
    await store.load();

    await store.enforceRuntimePolicy(READ_ONLY_ACCEPTANCE_POLICY);

    expect(store.settings()).toMatchObject({
      writeEnabled: false,
      aiEnabled: false,
      locale: "zh-CN",
      openAtStartup: true,
      secretId: "fixture-secret",
    });
    const persisted = await port.load() as { settings: PluginSettings };
    expect(persisted.settings.writeEnabled).toBe(false);
    expect(persisted.settings.aiEnabled).toBe(false);
  });

  it("performs no policy save or reload for the normal build", async () => {
    const port = new MemoryPluginDataPort();
    const load = vi.spyOn(port, "load");
    const store = new PluginDataStore(port);
    await store.load();
    const loadCount = load.mock.calls.length;

    await store.enforceRuntimePolicy(NORMAL_RUNTIME_POLICY);

    expect(load).toHaveBeenCalledTimes(loadCount);
    expect(port.saveCalls).toHaveLength(0);
  });

  it.each([
    { name: "the policy save fails", behavior: { failSave: true } },
    { name: "the verification reload fails", behavior: { failReload: true } },
    { name: "the port silently preserves historical true values", behavior: { preserveHistoricalData: true } },
  ])("fails closed when $name", async ({ behavior }) => {
    const store = new PluginDataStore(new ControlledPluginDataPort(unsafeHistoricalData(), behavior));
    await store.load();

    await expect(store.enforceRuntimePolicy(READ_ONLY_ACCEPTANCE_POLICY))
      .rejects.toThrow("Acceptance safety settings could not be verified");
  });

  it.each([
    { aiEndpoint: "http://example.test/v1", aiModel: "model", secretId: "valid-id" },
    { aiEndpoint: "https://example.test/v1", aiModel: "bad\u0000model", secretId: "valid-id" },
    { aiEndpoint: "https://example.test/v1", aiModel: "model", secretId: "INVALID_SECRET" },
  ])("fails closed and clears each invalid loaded AI field", async (invalid) => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: { aiEnabled: true, ...invalid },
    }));
    await store.load();
    expect(store.settings().aiEnabled).toBe(false);
    if (invalid.aiEndpoint.startsWith("http://example")) expect(store.settings().aiEndpoint).toBe("");
    if (invalid.aiModel.includes("\u0000")) expect(store.settings().aiModel).toBe("");
    if (invalid.secretId.startsWith("INVALID")) expect(store.settings().secretId).toBe("");
  });

  it("normalizes safe AI settings and drops unknown credential-shaped keys on the next save", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        aiEnabled: true,
        aiEndpoint: "https://example.test/v1/",
        aiModel: " model ",
        secretId: "my-secret-id",
        apiKey: "sk-private",
        authorization: "Bearer private",
        rawSecret: "private",
      },
    });
    const store = new PluginDataStore(port);
    await store.load();
    expect(store.settings()).toMatchObject({
      aiEnabled: true,
      aiEndpoint: "https://example.test/v1",
      aiModel: "model",
      secretId: "my-secret-id",
    });
    expect(JSON.stringify(store.settings())).not.toContain("private");
    await store.saveSettings(store.settings());
    expect(JSON.stringify(await port.load())).not.toMatch(/apiKey|authorization|rawSecret|sk-private|Bearer private/u);
  });
  it("serializes durable reload behind an in-flight mutation without losing the saved state", async () => {
    const port = new MemoryPluginDataPort();
    const store = new PluginDataStore(port);
    await store.load();
    port.pauseNextSave();
    const mutation = store.setPin("kept", 1);
    await port.waitUntilSavePaused();
    let reloadFinished = false;
    const reload = store.reload().then(() => { reloadFinished = true; });

    await Promise.resolve();
    expect(reloadFinished).toBe(false);
    port.resumeSaves();
    await Promise.all([mutation, reload]);

    expect(store.operational().pins).toEqual({ kept: 1 });
  });

  it("never exposes an incomplete staging scan as active", async () => {
    const port = new MemoryPluginDataPort();
    const store = new PluginDataStore(port);
    await store.load();

    await store.saveCheckpoint({ scanId: "scan-1", completedPaths: ["a.md"], records: [] });

    expect(store.activeIndex()).toBeNull();
    await store.promoteStaging("scan-1", 123);
    expect(store.activeIndex()?.builtAt).toBe(123);
    expect(store.staging()).toBeNull();
  });

  it("resets unknown derived schema while preserving safe settings", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 999,
      settings: {
        writeEnabled: true,
        writePreviewAcknowledged: true,
        locale: "zh-CN",
        openAtStartup: true,
        aiEnabled: true,
      },
      activeIndex: { unsafe: true },
    });
    const store = new PluginDataStore(port);

    await store.load();

    expect(store.settings().writeEnabled).toBe(false);
    expect(store.settings().writePreviewAcknowledged).toBe(false);
    expect(store.settings().openAtStartup).toBe(true);
    expect(store.settings().aiEnabled).toBe(false);
    expect(store.activeIndex()).toBeNull();
    expect(store.staging()).toBeNull();
    expect(store.operational()).toEqual({ pins: {}, dismissals: {}, lastOpened: {}, journals: [] });
  });

  it("preserves an active journal while resetting an unknown schema", async () => {
    const journal = { id: "legacy-active", status: "executing", prepared: { operation: { id: "op" } } };
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 999,
      settings: { writeEnabled: true, writePreviewAcknowledged: true },
      operational: { journals: [journal] },
    }));

    await store.load();

    expect(store.settings()).toMatchObject({ writeEnabled: false, writePreviewAcknowledged: false });
    expect(store.operational().journals).toEqual([journal]);
  });

  it("retains a blocking sentinel for a malformed current-schema journal container", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: { unexpected: "container" } },
    }));

    await store.load();

    expect(store.operational().journals).toEqual([
      expect.objectContaining({ status: "malformed-journal-container" }),
    ]);
  });

  it("does not expose a failed save and keeps the mutation queue usable", async () => {
    const port = new MemoryPluginDataPort();
    const store = new PluginDataStore(port);
    await store.load();
    port.failNextSave();

    await expect(store.saveSettings({ ...store.settings(), openAtStartup: true }))
      .rejects.toThrow("Injected save failure");

    expect(store.settings().openAtStartup).toBe(false);
    await store.saveSettings({ ...store.settings(), openAtStartup: true });
    expect(store.settings().openAtStartup).toBe(true);
  });

  it("cannot enable writes without the persisted preview acknowledgement", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: { writeEnabled: true, writePreviewAcknowledged: false },
    }));

    await store.load();

    expect(store.settings().writeEnabled).toBe(false);
  });

  it("merges concurrent operational mutations inside the serialized update", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();

    await Promise.all([
      store.setPin("a", 10),
      store.setLastOpened("b", 20),
      store.appendJournal({ id: "journal-1", status: "planned" }),
    ]);

    expect(store.operational()).toMatchObject({
      pins: { a: 10 },
      lastOpened: { b: 20 },
      journals: [{ id: "journal-1", status: "planned" }],
    });
  });

  it.each([
    {
      name: "setPin with NaN",
      invalid: (store: PluginDataStore) => store.setPin("invalid", Number.NaN),
      valid: (store: PluginDataStore) => store.setPin("valid", 1),
      expected: { pins: { valid: 1 } },
    },
    {
      name: "setPin with Infinity",
      invalid: (store: PluginDataStore) => store.setPin("invalid", Number.POSITIVE_INFINITY),
      valid: (store: PluginDataStore) => store.setPin("valid", 2),
      expected: { pins: { valid: 2 } },
    },
    {
      name: "setLastOpened with NaN",
      invalid: (store: PluginDataStore) => store.setLastOpened("invalid", Number.NaN),
      valid: (store: PluginDataStore) => store.setLastOpened("valid", 3),
      expected: { lastOpened: { valid: 3 } },
    },
    {
      name: "setLastOpened with Infinity",
      invalid: (store: PluginDataStore) => store.setLastOpened("invalid", Number.NEGATIVE_INFINITY),
      valid: (store: PluginDataStore) => store.setLastOpened("valid", 4),
      expected: { lastOpened: { valid: 4 } },
    },
    {
      name: "setDismissal with a non-finite dismissedAt",
      invalid: (store: PluginDataStore) => store.setDismissal("invalid", { dismissedAt: Number.NaN, mtime: 5 }),
      valid: (store: PluginDataStore) => store.setDismissal("valid", { dismissedAt: 5, mtime: 6 }),
      expected: { dismissals: { valid: { dismissedAt: 5, mtime: 6 } } },
    },
    {
      name: "setDismissal with a non-finite mtime",
      invalid: (store: PluginDataStore) => store.setDismissal("invalid", { dismissedAt: 6, mtime: Number.POSITIVE_INFINITY }),
      valid: (store: PluginDataStore) => store.setDismissal("valid", { dismissedAt: 6, mtime: 7 }),
      expected: { dismissals: { valid: { dismissedAt: 6, mtime: 7 } } },
    },
  ])("rejects $name without saving and keeps the queue usable", async ({ invalid, valid, expected }) => {
    const port = new MemoryPluginDataPort();
    const store = new PluginDataStore(port);
    await store.load();

    await expect(invalid(store)).rejects.toThrow(/must be finite/u);

    expect(port.saveCalls).toHaveLength(0);
    expect(store.operational()).toEqual({ pins: {}, dismissals: {}, lastOpened: {}, journals: [] });
    await valid(store);
    expect(store.operational()).toMatchObject(expected);
    expect(port.saveCalls).toHaveLength(1);
  });

  it("evicts the oldest settled journal before any active recovery journal", async () => {
    const settled = Array.from({ length: 97 }, (_, index) => ({ id: `settled-${index}`, status: "settled" }));
    const journals = [
      { id: "active-planned", status: "planned" },
      ...settled.slice(0, 30),
      { id: "active-executing", status: "executing" },
      ...settled.slice(30, 60),
      { id: "active-rollback", status: "rolling-back" },
      ...settled.slice(60),
    ];
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals },
    }));
    await store.load();

    const appended = { id: "settled-new", status: "settled" };
    await store.appendJournal(appended);

    expect(store.operational().journals).toEqual([
      ...journals.filter((entry) => entry.id !== "settled-0"),
      appended,
    ]);
    expect(store.operational().journals).toHaveLength(100);
  });

  it("rejects append when active recovery entries fill capacity and keeps journal updates usable", async () => {
    const active = Array.from({ length: 100 }, (_, index) => ({
      id: `active-${index}`,
      status: index % 3 === 0 ? "planned" : index % 3 === 1 ? "executing" : "rolling-back",
    }));
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: active },
    });
    const store = new PluginDataStore(port);
    await store.load();

    await expect(store.appendJournal({ id: "cannot-fit", status: "planned" }))
      .rejects.toThrow("Cannot append journal without discarding active recovery state");

    expect(port.saveCalls).toHaveLength(0);
    expect(store.operational().journals).toEqual(active);
    await store.updateJournal("active-0", () => ({ id: "active-0", status: "settled" }));
    expect(store.operational().journals).toContainEqual({ id: "active-0", status: "settled" });
    expect(port.saveCalls).toHaveLength(1);
  });

  it("isolates caller-owned settings, checkpoints, indexes, dismissals, journals, and port values", async () => {
    const port = new MemoryPluginDataPort();
    const store = new PluginDataStore(port);
    await store.load();

    const folderRules = [{ prefix: "notes/", kind: "note" as const }];
    const settings = { ...store.settings(), openAtStartup: true, folderRules };
    const settingsSave = store.saveSettings(settings);
    settings.openAtStartup = false;
    folderRules[0]!.prefix = "mutated/";
    await settingsSave;

    const completedPaths = ["a.md"];
    const checkpoint = { scanId: "alias-scan", completedPaths, records: [] };
    const checkpointSave = store.saveCheckpoint(checkpoint);
    completedPaths.push("mutated.md");
    await checkpointSave;

    const activeIndex = { builtAt: 200, records: [] };
    const activeIndexSave = store.saveActiveIndex(activeIndex);
    activeIndex.builtAt = 999;
    await activeIndexSave;

    const dismissal = { dismissedAt: 30, mtime: 40 };
    const dismissalSave = store.setDismissal("note", dismissal);
    dismissal.dismissedAt = 999;
    await dismissalSave;

    const journal = { id: "journal-alias", status: "settled", detail: { attempt: 1 } };
    const journalSave = store.appendJournal(journal);
    journal.status = "mutated";
    journal.detail.attempt = 999;
    await journalSave;

    expect(store.settings()).toMatchObject({ openAtStartup: true, folderRules: [{ prefix: "notes/", kind: "note" }] });
    expect(store.staging()?.completedPaths).toEqual(["a.md"]);
    expect(store.activeIndex()?.builtAt).toBe(200);
    expect(store.operational()).toMatchObject({
      dismissals: { note: { dismissedAt: 30, mtime: 40 } },
      journals: [{ id: "journal-alias", status: "settled", detail: { attempt: 1 } }],
    });

    const input = { nested: { value: 1 } };
    await port.save(input);
    input.nested.value = 2;
    const loaded = await port.load();
    if (!isObject(loaded) || !isObject(loaded.nested)) throw new Error("expected cloned nested value");
    loaded.nested.value = 3;
    expect(await port.load()).toEqual({ nested: { value: 1 } });
  });

  it("discards malformed current-schema derived state and sanitizes operational state", async () => {
    const journals = Array.from({ length: 101 }, (_, index) => ({ id: `journal-${index}`, status: "settled" }));
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      activeIndex: { builtAt: 10, records: [{}] },
      staging: { scanId: "scan", completedPaths: ["a.md", 42], records: [] },
      operational: {
        pins: { valid: 1, nan: Number.NaN, infinite: Number.POSITIVE_INFINITY, text: "2" },
        dismissals: {
          valid: { dismissedAt: 2, mtime: 3 },
          invalidTimestamp: { dismissedAt: Number.NaN, mtime: 3 },
          incomplete: { dismissedAt: 2 },
        },
        lastOpened: { valid: 4, nan: Number.NaN, text: "5" },
        journals,
      },
    }));

    await store.load();

    expect(store.activeIndex()).toBeNull();
    expect(store.staging()).toBeNull();
    expect(store.operational()).toEqual({
      pins: { valid: 1 },
      dismissals: { valid: { dismissedAt: 2, mtime: 3 } },
      lastOpened: { valid: 4 },
      journals: journals.slice(1),
    });
  });

  it("decodes oversized journal history by preserving active entries and the newest settled entries in order", async () => {
    const settled = Array.from({ length: 101 }, (_, index) => ({ id: `settled-${index}`, status: "settled" }));
    const journals = [
      ...settled.slice(0, 1),
      { id: "active-planned", status: "planned" },
      ...settled.slice(1, 2),
      { id: "active-executing", status: "executing" },
      ...settled.slice(2, 51),
      { id: "active-rollback", status: "rolling-back" },
      ...settled.slice(51),
    ];
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals },
    }));

    await store.load();

    expect(store.operational().journals).toEqual(journals.filter((entry) => {
      if (!entry.id.startsWith("settled-")) return true;
      return Number(entry.id.slice("settled-".length)) >= 4;
    }));
    expect(store.operational().journals).toHaveLength(100);
  });

  it("does not evict an active-looking legacy settled record while capping ordinary settled history", async () => {
    const protectedSettled = {
      id: "protected-settled",
      status: "settled",
      prepared: { operation: { id: "possibly-active" } },
    };
    const ordinary = Array.from({ length: 100 }, (_, index) => ({ id: `settled-${index}`, status: "settled" }));
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: [protectedSettled, ...ordinary] },
    }));

    await store.load();

    expect(store.operational().journals).toEqual([protectedSettled, ...ordinary.slice(1)]);
    expect(store.operational().journals).toHaveLength(100);
    expect(new OperationJournal(store).organizationWritesBlocked()).toBe(true);
  });

  it("keeps every active recovery entry when malformed persisted state already exceeds the history cap", async () => {
    const active = Array.from({ length: 101 }, (_, index) => ({
      id: `active-${index}`,
      status: index % 3 === 0 ? "planned" : index % 3 === 1 ? "executing" : "rolling-back",
    }));
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: active },
    }));

    await store.load();

    expect(store.operational().journals).toEqual(active);
    expect(store.operational().journals).toHaveLength(101);
  });

  it("accepts extractor-shaped non-empty records in active and staging state", async () => {
    const record = await extractDocumentRecord({
      path: "notes/valid.md",
      basename: "valid",
      mtime: 10,
      size: 20,
      content: "---\nknowledge-workbench-kind: note\nsource: local\n---\n# Valid\nBody",
      frontmatter: {
        "knowledge-workbench-kind": "note",
        "knowledge-workbench-topics": ["storage"],
        source: "local",
        aliases: ["Valid alias"],
        tags: ["test"],
      },
      headings: ["Valid"],
      outgoingLinks: ["notes/linked.md"],
    });
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      activeIndex: { builtAt: 11, records: [record] },
      staging: { scanId: "valid-scan", completedPaths: [record.path], records: [record] },
    }));

    await store.load();

    expect(store.activeIndex()).toEqual({ builtAt: 11, records: [record] });
    expect(store.staging()).toEqual({ scanId: "valid-scan", completedPaths: [record.path], records: [record] });
  });

  it.each(["planned", "executing", "rolling-back"])(
    "refuses to clear journals while a %s transaction is active",
    async (status) => {
      const store = new PluginDataStore(new MemoryPluginDataPort());
      await store.load();
      await store.appendJournal({ id: "journal-active", status });

      await expect(store.clearSettledJournals())
        .rejects.toThrow("Cannot clear history while a transaction is active");
      expect(store.operational().journals).toEqual([{ id: "journal-active", status }]);

      await store.updateJournal("journal-active", () => ({ id: "journal-active", status: "settled" }));
      await store.clearSettledJournals();
      expect(store.operational().journals).toEqual([]);
    },
  );

  it("clears only legacy settled history while preserving a blocking sentinel", async () => {
    const sentinel = { id: "sentinel", status: "malformed-journal-container", reason: "bad container" };
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: [sentinel, { id: "legacy", status: "settled" }] },
    }));
    await store.load();

    await store.clearSettledJournals();

    expect(store.operational().journals).toEqual([sentinel]);
    expect(new OperationJournal(store).organizationWritesBlocked()).toBe(true);
  });

  it("clears ordinary legacy settled history but preserves an active-looking settled record", async () => {
    const protectedSettled = {
      id: "protected-settled",
      status: "settled",
      prepared: { operation: { id: "possibly-active" } },
    };
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: {
        journals: [{ id: "ordinary-settled", status: "settled" }, protectedSettled],
      },
    }));
    await store.load();

    await store.clearSettledJournals();

    expect(store.operational().journals).toEqual([protectedSettled]);
    expect(new OperationJournal(store).organizationWritesBlocked()).toBe(true);
  });

  it("preserves unknown and new terminal records when clearing legacy settled history", async () => {
    const retained = [
      { id: "future", status: "future-terminal" },
      { id: "completed", status: "completed" },
      { id: "rolled", status: "rolled-back" },
    ];
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: [{ id: "legacy", status: "settled" }, ...retained] },
    }));
    await store.load();

    await store.clearSettledJournals();

    expect(store.operational().journals).toEqual(retained);
  });

  it("fails when updating a missing journal without poisoning the queue", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    await store.appendJournal({ id: "journal-1", status: "settled" });

    await expect(store.updateJournal("missing", () => ({ id: "missing", status: "settled" })))
      .rejects.toThrow("Journal not found: missing");

    expect(store.operational().journals).toEqual([{ id: "journal-1", status: "settled" }]);
    await store.setPin("after-error", 50);
    expect(store.operational().pins).toEqual({ "after-error": 50 });
  });
});
