import { describe, expect, it, vi } from "vitest";
import { PLUGIN_DATA_SCHEMA_VERSION } from "../../../src/constants";
import type { PluginDataPort } from "../../../src/core/ports";
import { extractDocumentRecord } from "../../../src/indexing/markdown-record-extractor";
import { MAX_INDEX_HEADINGS, MAX_INDEX_TOKENS } from "../../../src/indexing/index-record-limits";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../../src/runtime/safety-policy";
import { EMPTY_RECENT_CLOUD_DIRECTORIES } from "../../../src/storage/recent-cloud-directories";
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

const HASH_A = "a".repeat(64);
const HASH_B = "2597dd278b71c490ebebf6dafad25c1662fae588bcfb0a067b0a37b9916413e8";
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const GROUP_KEY_A = `group:${"7".repeat(64)}`;

const boundCloudLibraryFixture = () => ({
  schemaVersion: 1 as const,
  path: "/Synthetic/Library",
  sourceImportSha256: HASH_A,
  verificationGeneration: 1,
});

const adoptedLegacyVerificationFixture = () => ({
  schemaVersion: 1 as const,
  state: "adopted" as const,
  verificationGeneration: 1,
  sourceImportSha256: HASH_A,
  cloudRootSha256: HASH_B,
  candidate: {
    importId: "candidate-import-1",
    manifestSha256: HASH_C,
    descriptorSha256: HASH_D,
  },
  overlays: [{
    overlayId: "overlay-1",
    groupKey: GROUP_KEY_A,
    descriptorSha256: HASH_E,
  }],
  unified: {
    snapshotId: "unified-1",
    descriptorSha256: HASH_F,
  },
  resumableBatch: {
    batchId: "batch-1",
    checkpointSha256: "1".repeat(64),
    sourceImportSha256: HASH_A,
    cloudRootSha256: HASH_B,
  },
});

const cloudVerificationSettings = (settings: PluginSettings) => ({
  boundCloudLibrary: settings.boundCloudLibrary,
  cloudVerificationGeneration: settings.cloudVerificationGeneration,
  verificationBatchTombstones: settings.verificationBatchTombstones,
  legacyVerificationAdoption: settings.legacyVerificationAdoption,
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
    expect(store.settings().recentCloudDirectories).toEqual(EMPTY_RECENT_CLOUD_DIRECTORIES);
  });

  it.each([
    ["wrong schema", { schemaVersion: 2, items: [] }],
    [
      "more than ten entries",
      {
        schemaVersion: 1,
        items: Array.from({ length: 11 }, (_, index) => ({
          path: `/Synthetic/${index}`,
          filename: String(index),
          lastUsedAt: "2026-08-23T00:00:00.000Z",
        })),
      },
    ],
    [
      "a root path",
      {
        schemaVersion: 1,
        items: [{ path: "/", filename: "", lastUsedAt: "2026-08-23T00:00:00.000Z" }],
      },
    ],
    [
      "a mismatched filename",
      {
        schemaVersion: 1,
        items: [{ path: "/Synthetic/Alpha", filename: "Beta", lastUsedAt: "2026-08-23T00:00:00.000Z" }],
      },
    ],
    [
      "a non-canonical timestamp",
      {
        schemaVersion: 1,
        items: [{ path: "/Synthetic/Alpha", filename: "Alpha", lastUsedAt: "2026-08-23T00:00:00Z" }],
      },
    ],
  ])("drops the entire recent field containing %s without clearing unrelated settings", async (_, recentCloudDirectories) => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "en",
        openAtStartup: true,
        recentCloudDirectories,
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));

    await store.load();

    expect(store.settings()).toMatchObject({ locale: "en", openAtStartup: true });
    expect(store.settings().recentCloudDirectories).toEqual(EMPTY_RECENT_CLOUD_DIRECTORIES);
  });

  it("round-trips valid recent directories without serializing identities or credentials", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "en",
        openAtStartup: true,
        appKey: "synthetic-app-key",
        secretKey: "synthetic-secret-key",
        accessToken: "synthetic-access-token",
        refreshToken: "synthetic-refresh-token",
        authorizationCode: "synthetic-authorization-code",
        recentCloudDirectories: {
          schemaVersion: 1,
          items: [{
            path: "/Synthetic/Alpha",
            filename: "Alpha",
            lastUsedAt: "2026-08-23T00:00:00.000Z",
            fsId: "synthetic-fs-id",
          }],
        },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    });
    const store = new PluginDataStore(port);

    await store.load();
    await store.saveSettings(store.settings());
    await store.reload();

    expect(store.settings().recentCloudDirectories).toEqual({
      schemaVersion: 1,
      items: [{
        path: "/Synthetic/Alpha",
        filename: "Alpha",
        lastUsedAt: "2026-08-23T00:00:00.000Z",
      }],
    });
    expect(JSON.stringify(await port.load())).not.toMatch(
      /appKey|secretKey|accessToken|refreshToken|authorizationCode|fsId|synthetic-(?:app|secret|access|refresh|authorization|fs)/u,
    );
  });

  it("preserves an independently valid recent field while resetting an unknown outer schema", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 999,
      settings: {
        writeEnabled: true,
        writePreviewAcknowledged: true,
        locale: "en",
        openAtStartup: true,
        recentCloudDirectories: {
          schemaVersion: 1,
          items: [{
            path: "/Synthetic/Alpha",
            filename: "Alpha",
            lastUsedAt: "2026-08-23T00:00:00.000Z",
          }],
        },
      },
      activeIndex: { unsafe: true },
    }));

    await store.load();

    expect(store.settings()).toMatchObject({
      locale: "en",
      openAtStartup: true,
      writeEnabled: false,
      recentCloudDirectories: {
        schemaVersion: 1,
        items: [{
          path: "/Synthetic/Alpha",
          filename: "Alpha",
          lastUsedAt: "2026-08-23T00:00:00.000Z",
        }],
      },
    });
    expect(store.activeIndex()).toBeNull();
  });

  it("distinguishes new-install defaults from a known legacy settings object", async () => {
    const newInstall = new PluginDataStore(new MemoryPluginDataPort());
    await newInstall.load();

    expect(newInstall.settings()).toMatchObject({
      boundCloudLibrary: null,
      cloudVerificationGeneration: 0,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
    });

    const upgradedInstall = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: { locale: "en", openAtStartup: true },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await upgradedInstall.load();

    expect(upgradedInstall.settings()).toMatchObject({
      locale: "en",
      openAtStartup: true,
      boundCloudLibrary: null,
      cloudVerificationGeneration: 0,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });
  });

  it("round-trips a source-bound library, generation, tombstones, and adopted lineage", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "en",
        openAtStartup: true,
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: ["batch-old"],
        },
        legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    });
    const store = new PluginDataStore(port);

    await store.load();
    await store.saveSettings(store.settings());
    await store.reload();

    expect(store.settings()).toMatchObject({
      locale: "en",
      openAtStartup: true,
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: ["batch-old"],
      },
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    });
  });

  it.each([
    ["a path-only string", "/Synthetic/Library", 1],
    ["a binding missing its source", { schemaVersion: 1, path: "/Synthetic/Library", verificationGeneration: 1 }, 1],
    ["a root binding", { ...boundCloudLibraryFixture(), path: "/" }, 1],
    ["a generation-mismatched binding", boundCloudLibraryFixture(), 2],
    ["a generation-zero binding", boundCloudLibraryFixture(), 0],
    ["an unsafe settings generation", boundCloudLibraryFixture(), Number.MAX_SAFE_INTEGER + 1],
  ])("fails closed for %s without resetting unrelated settings", async (_, boundCloudLibrary, generation) => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "en",
        openAtStartup: true,
        cloudVerificationGeneration: generation,
        boundCloudLibrary,
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));

    await store.load();

    expect(store.settings()).toMatchObject({ locale: "en", openAtStartup: true });
    expect(store.settings().boundCloudLibrary).toBeNull();
    expect(store.settings().cloudVerificationGeneration).toBe(
      Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    );
  });

  it("never promotes a recent directory into a trusted cloud library", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        recentCloudDirectories: {
          schemaVersion: 1,
          items: [{
            path: "/Synthetic/Library",
            filename: "Library",
            lastUsedAt: "2026-08-23T00:00:00.000Z",
          }],
        },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));

    await store.load();

    expect(store.settings().recentCloudDirectories.items[0]?.path).toBe("/Synthetic/Library");
    expect(store.settings().boundCloudLibrary).toBeNull();
    expect(store.settings().cloudVerificationGeneration).toBe(0);
  });

  it("keeps malformed tombstones and adoption sticky across unrelated settings writes", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: Array.from({ length: 17 }, (_, index) => `batch-${index}`),
        },
        legacyVerificationAdoption: {
          schemaVersion: 1,
          state: "pending",
          extra: true,
        },
      },
      activeIndex: { builtAt: 7, records: [] },
      staging: { scanId: "scan-1", completedPaths: [], records: [] },
      operational: {
        pins: { kept: 1 },
        dismissals: {},
        lastOpened: {},
        journals: [{ id: "journal-1", status: "planned" }],
      },
    });
    const store = new PluginDataStore(port);
    await store.load();

    expect(store.settings()).toMatchObject({
      verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      legacyVerificationAdoption: { schemaVersion: 1, state: "invalid" },
    });

    await store.saveSettings({
      ...store.settings(),
      locale: "en",
      openAtStartup: true,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
    });
    await store.reload();

    expect(store.settings()).toMatchObject({
      locale: "en",
      openAtStartup: true,
      verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      legacyVerificationAdoption: { schemaVersion: 1, state: "invalid" },
    });
    expect(store.activeIndex()).toEqual({ builtAt: 7, records: [] });
    expect(store.staging()).toEqual({ scanId: "scan-1", completedPaths: [], records: [] });
    expect(store.operational()).toMatchObject({
      pins: { kept: 1 },
      journals: [{ id: "journal-1", status: "planned" }],
    });
  });

  it("does not let a general settings write seal a pending legacy adoption", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: { locale: "zh-CN" },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();
    expect(store.settings().legacyVerificationAdoption).toEqual({ schemaVersion: 1, state: "pending" });

    await store.updateSettings((settings) => ({
      ...settings,
      locale: "en",
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    }));

    expect(store.settings().locale).toBe("en");
    expect(store.settings().legacyVerificationAdoption).toEqual({ schemaVersion: 1, state: "pending" });
  });

  it("allows one explicit first-binding transaction to adopt pending legacy lineage without losing a concurrent locale write", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();

    await Promise.all([
      store.updateSettings((settings) => ({ ...settings, locale: "en" })),
      store.updateCloudVerificationSettings({
        ...cloudVerificationSettings(store.settings()),
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: [],
        },
        legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
      }, {
        kind: "library-binding",
        currentWorkflowBatchId: null,
      }),
    ]);

    expect(store.settings()).toMatchObject({
      locale: "en",
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: [],
      },
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    });
  });

  it("rejects an authority mutation without an explicit transition intent", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    });
    const store = new PluginDataStore(port);
    await store.load();

    await expect(
      // @ts-expect-error Cloud authority mutations require an explicit transition intent.
      store.updateCloudVerificationSettings({
        ...cloudVerificationSettings(store.settings()),
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
        legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
      }),
    ).rejects.toThrow(/transition|intent|authority/iu);

    expect(port.saveCalls).toHaveLength(0);
    expect(store.settings()).toMatchObject({
      cloudVerificationGeneration: 0,
      boundCloudLibrary: null,
      verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });
  });

  it("rejects a first-binding transaction that omits its declared workflow batch tombstone", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    });
    const store = new PluginDataStore(port);
    await store.load();

    await expect(store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    }, {
      kind: "library-binding",
      currentWorkflowBatchId: "batch-current",
    })).rejects.toThrow(/tombstone|batch/iu);

    expect(port.saveCalls).toHaveLength(0);
    expect(store.settings().verificationBatchTombstones).toEqual({
      schemaVersion: 1,
      state: "invalid",
    });
  });

  it("rejects a first-binding transaction that erases existing tombstones when no current batch is declared", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: ["batch-old"],
        },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    });
    const store = new PluginDataStore(port);
    await store.load();

    await expect(store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    }, {
      kind: "library-binding",
      currentWorkflowBatchId: null,
    })).rejects.toThrow(/tombstone|batch/iu);

    expect(port.saveCalls).toHaveLength(0);
    expect(store.settings().verificationBatchTombstones).toEqual({
      schemaVersion: 1,
      state: "valid",
      batchIds: ["batch-old"],
    });
  });

  it.each([
    {
      name: "create adoption from none",
      current: { schemaVersion: 1 as const, state: "none" as const },
      next: adoptedLegacyVerificationFixture(),
    },
    {
      name: "replace an adopted lineage",
      current: adoptedLegacyVerificationFixture(),
      next: {
        ...adoptedLegacyVerificationFixture(),
        unified: {
          ...adoptedLegacyVerificationFixture().unified,
          descriptorSha256: "9".repeat(64),
        },
      },
    },
  ])("rejects $name after generation zero has already been left", async ({ current, next }) => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: ["batch-old"],
        },
        legacyVerificationAdoption: current,
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    });
    const store = new PluginDataStore(port);
    await store.load();

    await expect(store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      legacyVerificationAdoption: next,
    }, {
      kind: "library-binding",
      currentWorkflowBatchId: null,
    })).rejects.toThrow(/adoption|generation/iu);

    expect(port.saveCalls).toHaveLength(0);
    expect(store.settings().legacyVerificationAdoption).toEqual(current);
  });

  it("rejects an adopted lineage whose cloud root hash does not match the bound path", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    });
    const store = new PluginDataStore(port);
    await store.load();

    await expect(store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      legacyVerificationAdoption: {
        ...adoptedLegacyVerificationFixture(),
        cloudRootSha256: "b".repeat(64),
        resumableBatch: {
          ...adoptedLegacyVerificationFixture().resumableBatch,
          cloudRootSha256: "b".repeat(64),
        },
      },
    }, {
      kind: "library-binding",
      currentWorkflowBatchId: null,
    })).rejects.toThrow(/root|scope|bound/iu);

    expect(port.saveCalls).toHaveLength(0);
  });

  it("freezes the detached binding request before it enters the settings queue", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();
    const requested = {
      ...cloudVerificationSettings(store.settings()),
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: { schemaVersion: 1 as const, state: "valid" as const, batchIds: [] },
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    };

    const pending = store.updateCloudVerificationSettings(requested, {
      kind: "library-binding",
      currentWorkflowBatchId: null,
    });
    requested.boundCloudLibrary = { ...requested.boundCloudLibrary, path: "/Synthetic/Changed" };
    requested.legacyVerificationAdoption = {
      ...requested.legacyVerificationAdoption,
      sourceImportSha256: "9".repeat(64),
    };
    await pending;

    expect(store.settings()).toMatchObject({
      boundCloudLibrary: boundCloudLibraryFixture(),
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    });
  });

  it("rejects a queued authority request when an earlier authority transaction changed its basis", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();
    const requested = {
      ...cloudVerificationSettings(store.settings()),
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: { schemaVersion: 1 as const, state: "valid" as const, batchIds: [] },
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    };
    const intent = { kind: "library-binding" as const, currentWorkflowBatchId: null };

    const first = store.updateCloudVerificationSettings(requested, intent);
    const stale = store.updateCloudVerificationSettings(requested, intent);

    await expect(first).resolves.toBeUndefined();
    await expect(stale).rejects.toThrow(/stale|changed|basis|generation/iu);
  });

  it("clears only the binding when a different TXT source is activated", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: ["batch-old"] },
        legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();

    await store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      boundCloudLibrary: null,
    }, {
      kind: "txt-source-replacement",
      currentWorkflowBatchId: null,
    });

    expect(store.settings()).toMatchObject({
      cloudVerificationGeneration: 1,
      boundCloudLibrary: null,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: ["batch-old"] },
      legacyVerificationAdoption: adoptedLegacyVerificationFixture(),
    });
  });

  it("lets explicit identity replacement leave an invalid adoption in a reachable fresh state", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
        legacyVerificationAdoption: { schemaVersion: 1, state: "invalid" },
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();

    await store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      cloudVerificationGeneration: 2,
      boundCloudLibrary: null,
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: ["batch-current"],
      },
      legacyVerificationAdoption: { schemaVersion: 1, state: "ineligible" },
    }, {
      kind: "identity-replacement",
      currentWorkflowBatchId: "batch-current",
    });

    expect(store.settings()).toMatchObject({
      cloudVerificationGeneration: 2,
      boundCloudLibrary: null,
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: ["batch-current"],
      },
      legacyVerificationAdoption: { schemaVersion: 1, state: "ineligible" },
    });
  });

  it("keeps an older adopted lineage as history when a later generation binds again", async () => {
    const historicalAdoption = adoptedLegacyVerificationFixture();
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        cloudVerificationGeneration: 2,
        boundCloudLibrary: null,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: ["batch-old"] },
        legacyVerificationAdoption: historicalAdoption,
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();
    const nextBinding = {
      ...boundCloudLibraryFixture(),
      sourceImportSha256: "9".repeat(64),
      verificationGeneration: 2,
    };

    await store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      boundCloudLibrary: nextBinding,
    }, {
      kind: "library-binding",
      currentWorkflowBatchId: null,
    });

    expect(store.settings()).toMatchObject({
      cloudVerificationGeneration: 2,
      boundCloudLibrary: nextBinding,
      legacyVerificationAdoption: historicalAdoption,
    });
  });

  it("keeps an adopted lineage as history when a root change rotates generation", async () => {
    const historicalAdoption = adoptedLegacyVerificationFixture();
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {
        locale: "zh-CN",
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: ["batch-old"] },
        legacyVerificationAdoption: historicalAdoption,
      },
      activeIndex: null,
      staging: null,
      operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
    }));
    await store.load();
    const nextBinding = {
      ...boundCloudLibraryFixture(),
      path: "/Synthetic/Other",
      verificationGeneration: 2,
    };

    await store.updateCloudVerificationSettings({
      ...cloudVerificationSettings(store.settings()),
      cloudVerificationGeneration: 2,
      boundCloudLibrary: nextBinding,
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: ["batch-old", "batch-current"],
      },
    }, {
      kind: "library-binding",
      currentWorkflowBatchId: "batch-current",
    });

    expect(store.settings()).toMatchObject({
      cloudVerificationGeneration: 2,
      boundCloudLibrary: nextBinding,
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: ["batch-old", "batch-current"],
      },
      legacyVerificationAdoption: historicalAdoption,
    });
  });

  it.each([
    { schemaVersion: 1, state: "none" },
    { schemaVersion: 1, state: "pending" },
    { schemaVersion: 1, state: "ineligible" },
    { schemaVersion: 1, state: "invalid" },
    adoptedLegacyVerificationFixture(),
  ])("preserves independently safe cloud authority fields across an unknown outer schema", async (adoption) => {
    const tombstones = adoption.state === "invalid"
      ? { schemaVersion: 1, state: "invalid" }
      : { schemaVersion: 1, state: "valid", batchIds: ["batch-old"] };
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 999,
      settings: {
        locale: "en",
        openAtStartup: true,
        writeEnabled: true,
        writePreviewAcknowledged: true,
        aiEnabled: true,
        aiEndpoint: "https://example.test/v1",
        aiModel: "model",
        secretId: "secret-id",
        cloudVerificationGeneration: 1,
        boundCloudLibrary: boundCloudLibraryFixture(),
        verificationBatchTombstones: tombstones,
        legacyVerificationAdoption: adoption,
      },
      activeIndex: { unsafe: true },
    }));

    await store.load();

    expect(store.settings()).toMatchObject({
      locale: "en",
      openAtStartup: true,
      writeEnabled: false,
      writePreviewAcknowledged: false,
      aiEnabled: false,
      cloudVerificationGeneration: 1,
      boundCloudLibrary: boundCloudLibraryFixture(),
      verificationBatchTombstones: tombstones,
      legacyVerificationAdoption: adoption,
    });
    expect(store.activeIndex()).toBeNull();
  });

  it("does not infer pending legacy adoption when an unknown outer schema omits the field", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 999,
      settings: {
        locale: "en",
        cloudVerificationGeneration: 0,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      },
      activeIndex: { unsafe: true },
    }));

    await store.load();

    expect(store.settings().legacyVerificationAdoption).toEqual({
      schemaVersion: 1,
      state: "invalid",
    });
    expect(store.activeIndex()).toBeNull();
  });

  it("applies concurrent settings changes against queue-current state", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();

    await Promise.all([
      store.updateSettings((settings) => ({ ...settings, openAtStartup: true })),
      store.updateSettings((settings) => ({
        ...settings,
        recentCloudDirectories: {
          schemaVersion: 1,
          items: [{
            path: "/Synthetic/Alpha",
            filename: "Alpha",
            lastUsedAt: "2026-08-23T00:00:00.000Z",
          }],
        },
      })),
    ]);

    expect(store.settings()).toMatchObject({
      openAtStartup: true,
      recentCloudDirectories: {
        schemaVersion: 1,
        items: [{ path: "/Synthetic/Alpha" }],
      },
    });
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

  it("compacts oversized legacy search fields once and persists the bounded index", async () => {
    const base = await extractDocumentRecord({
      path: "notes/legacy-large.md",
      basename: "legacy-large",
      mtime: 12,
      size: 24,
      content: "Legacy searchable body",
      frontmatter: {},
      headings: ["Legacy"],
      outgoingLinks: [],
    });
    const record = {
      ...base,
      headings: Array.from({ length: MAX_INDEX_HEADINGS + 5 }, (_, index) => `Heading ${index}`),
      tokens: Array.from({ length: MAX_INDEX_TOKENS + 7 }, (_, index) => `token-${index}`),
    };
    const port = new MemoryPluginDataPort({
      schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
      settings: {},
      activeIndex: { builtAt: 12, records: [record] },
      staging: { scanId: "legacy-scan", completedPaths: [record.path], records: [record] },
    });
    const store = new PluginDataStore(port);

    await store.load();

    expect(store.hasActiveIndex()).toBe(true);
    expect(store.activeIndex()?.records[0]?.headings).toEqual(record.headings.slice(0, MAX_INDEX_HEADINGS));
    expect(store.activeIndex()?.records[0]?.tokens).toEqual(record.tokens.slice(0, MAX_INDEX_TOKENS));
    expect(store.staging()?.records[0]?.headings).toHaveLength(MAX_INDEX_HEADINGS);
    expect(store.staging()?.records[0]?.tokens).toHaveLength(MAX_INDEX_TOKENS);
    expect(port.saveCalls).toHaveLength(1);
    const saved = port.saveCalls[0] as {
      readonly activeIndex: { readonly records: readonly { readonly headings: readonly string[]; readonly tokens: readonly string[] }[] };
      readonly staging: { readonly records: readonly { readonly headings: readonly string[]; readonly tokens: readonly string[] }[] };
    };
    expect(saved.activeIndex.records[0]?.headings).toHaveLength(MAX_INDEX_HEADINGS);
    expect(saved.activeIndex.records[0]?.tokens).toHaveLength(MAX_INDEX_TOKENS);
    expect(saved.staging.records[0]?.headings).toHaveLength(MAX_INDEX_HEADINGS);
    expect(saved.staging.records[0]?.tokens).toHaveLength(MAX_INDEX_TOKENS);
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
