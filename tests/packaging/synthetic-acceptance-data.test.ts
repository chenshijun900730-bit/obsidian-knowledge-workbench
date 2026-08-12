import { describe, expect, it } from "vitest";

import {
  createSyntheticPluginDataSeed,
  decodeSyntheticPluginDataSeed,
  encodeSyntheticPluginDataSeed,
  inspectPostHostPluginData,
} from "../../scripts/synthetic-acceptance-data.mjs";
import { verifyPlanFingerprint } from "../../src/plans/change-plan-service";
import { READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import { OperationJournal } from "../../src/transactions/operation-journal";
import { MemoryPluginDataPort } from "../fakes/memory-plugin-data-port";

type JsonRecord = Record<string, unknown>;

const SOURCE_PATH = "Generated/00000/note-00000-3db92208.md";
const TARGET_PATH = "Generated/00001/note-00001-752cddc7.md";
const OPERATION_ID = "synthetic-acceptance-rename";
const CONTENT_HASH = "9ebdaff407368399fd20c3f82fa4452accb78680440e4d4d258844ca42080aea";
const PLAN_FINGERPRINT = "d7d8fb5af0c70b57feee26368f1279aa1c4125fdd19884d8d781db8cd22776ba";
const PLAN_ID = PLAN_FINGERPRINT.slice(0, 16);

const operation = {
  id: OPERATION_ID,
  kind: "rename",
  sourcePath: SOURCE_PATH,
  targetPath: TARGET_PATH,
} as const;

const inverse = {
  id: OPERATION_ID,
  kind: "rename",
  sourcePath: TARGET_PATH,
  targetPath: SOURCE_PATH,
} as const;

const preconditions = [
  { path: SOURCE_PATH, exists: true, mtime: 1, contentHash: CONTENT_HASH },
  { path: TARGET_PATH, exists: false },
] as const;

const rationale = {
  source: "local",
  summary: "Review rename",
  signals: ["direct-user-selection"],
  confidence: "low",
  impact: 0,
} as const;

const expectedJournal = {
  id: `1:${PLAN_ID}`,
  status: "completed",
  createdAt: 1,
  plan: {
    id: PLAN_ID,
    fingerprint: PLAN_FINGERPRINT,
    operations: [operation],
    preconditions,
    rationales: { [OPERATION_ID]: rationale },
    localRationales: { [OPERATION_ID]: rationale },
  },
  prepared: null,
  completed: [
    {
      operation,
      inverse,
      preconditions,
      postconditions: [
        { path: SOURCE_PATH, exists: false },
        { path: TARGET_PATH, exists: true, mtime: 1, contentHash: CONTENT_HASH },
      ],
    },
  ],
  rolledBackOperationIds: [],
} as const;

const expectedSeed = {
  schemaVersion: 1,
  settings: {
    writeEnabled: true,
    writePreviewAcknowledged: true,
    openAtStartup: false,
    folderRules: [],
    excludedPrefixes: [],
    aiEnabled: false,
    aiEndpoint: "",
    aiModel: "",
    secretId: "",
  },
  activeIndex: null,
  staging: null,
  operational: {
    pins: {},
    dismissals: {},
    lastOpened: {},
    journals: [expectedJournal],
  },
} as const;

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function parseBytes(bytes: Uint8Array): JsonRecord {
  return requireRecord(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown, "plugin data");
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function settingsOf(data: JsonRecord): JsonRecord {
  return requireRecord(data.settings, "settings");
}

function operationalOf(data: JsonRecord): JsonRecord {
  return requireRecord(data.operational, "operational");
}

function journalsOf(data: JsonRecord): unknown[] {
  const journals = operationalOf(data).journals;
  if (!Array.isArray(journals)) throw new Error("journals must be an array");
  return journals;
}

function normalizedSeedData(): JsonRecord {
  const data = structuredClone(expectedSeed) as unknown as JsonRecord;
  const settings = settingsOf(data);
  settings.writeEnabled = false;
  settings.aiEnabled = false;
  return data;
}

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

function collectMarkdownPaths(value: unknown, output = new Set<string>()): ReadonlySet<string> {
  if (typeof value === "string" && value.endsWith(".md")) output.add(value);
  else if (Array.isArray(value)) for (const item of value) collectMarkdownPaths(item, output);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectMarkdownPaths(item, output);
  }
  return output;
}

describe("synthetic acceptance plugin-data seed", () => {
  it("creates one exact deterministic canonical seed with frozen copy-out values", () => {
    const first = createSyntheticPluginDataSeed();
    const second = createSyntheticPluginDataSeed();
    const firstBytes = encodeSyntheticPluginDataSeed();
    const secondBytes = encodeSyntheticPluginDataSeed();

    expect(first).toEqual(expectedSeed);
    expect(second).toEqual(expectedSeed);
    expect(first).not.toBe(second);
    expect(isDeeplyFrozen(first)).toBe(true);
    expect(isDeeplyFrozen(second)).toBe(true);
    expect(firstBytes).toEqual(secondBytes);
    expect(firstBytes.toString("utf8")).toBe(`${JSON.stringify(expectedSeed, null, 2)}\n`);
    expect(firstBytes.at(-1)).toBe(0x0a);

    const decoded = decodeSyntheticPluginDataSeed(firstBytes);
    expect(decoded).toEqual(expectedSeed);
    expect(decoded).not.toBe(first);
    expect(isDeeplyFrozen(decoded)).toBe(true);

    const seed = parseBytes(firstBytes);
    expect(Object.keys(seed)).toEqual(["schemaVersion", "settings", "activeIndex", "staging", "operational"]);
    expect(Object.keys(settingsOf(seed))).toEqual([
      "writeEnabled",
      "writePreviewAcknowledged",
      "openAtStartup",
      "folderRules",
      "excludedPrefixes",
      "aiEnabled",
      "aiEndpoint",
      "aiModel",
      "secretId",
    ]);
    expect(Object.keys(operationalOf(seed))).toEqual(["pins", "dismissals", "lastOpened", "journals"]);
    const journal = requireRecord(journalsOf(seed)[0], "journal");
    expect(Object.keys(journal)).toEqual([
      "id",
      "status",
      "createdAt",
      "plan",
      "prepared",
      "completed",
      "rolledBackOperationIds",
    ]);
    expect(Object.keys(requireRecord(journal.plan, "plan"))).toEqual([
      "id",
      "fingerprint",
      "operations",
      "preconditions",
      "rationales",
      "localRationales",
    ]);
  });

  it("contains only the bounded synthetic paths and no host, user, network, or AI configuration data", () => {
    const seed = createSyntheticPluginDataSeed();
    const settings = settingsOf(seed);
    const serialized = JSON.stringify(seed);
    const journalSerialized = JSON.stringify(operationalOf(seed).journals);

    expect([...collectMarkdownPaths(seed)].sort()).toEqual([SOURCE_PATH, TARGET_PATH]);
    expect([...collectMarkdownPaths(seed)].every((path) => path.startsWith("Generated/"))).toBe(true);
    expect(serialized).not.toMatch(/https?:|file:|\/Users\/|\/Volumes\/|\\Users\\|localhost/iu);
    expect(journalSerialized).not.toMatch(/endpoint|model|secret|credential|token|https?:/iu);
    expect(settings.aiEndpoint).toBe("");
    expect(settings.aiModel).toBe("");
    expect(settings.secretId).toBe("");
    expect(requireRecord(requireRecord(journalsOf(seed as JsonRecord)[0], "journal").plan, "plan").fingerprint)
      .toBe(PLAN_FINGERPRINT);
  });

  it("strictly rejects noncanonical, changed, malformed, and unreadable seed bytes", () => {
    const changedOrder = Object.fromEntries(Object.entries(expectedSeed).reverse());
    const changedNested = structuredClone(expectedSeed) as unknown as JsonRecord;
    settingsOf(changedNested).apiKey = "";
    const normalized = normalizedSeedData();

    expect(() => decodeSyntheticPluginDataSeed(Buffer.from(JSON.stringify(expectedSeed), "utf8")))
      .toThrow(/canonical|seed|encoding|newline/iu);
    expect(() => decodeSyntheticPluginDataSeed(encodeJson(changedOrder)))
      .toThrow(/canonical|seed|keys|encoding/iu);
    expect(() => decodeSyntheticPluginDataSeed(encodeJson(changedNested)))
      .toThrow(/canonical|seed|keys|schema/iu);
    expect(() => decodeSyntheticPluginDataSeed(encodeJson(normalized)))
      .toThrow(/canonical|seed|settings|schema/iu);
    expect(() => decodeSyntheticPluginDataSeed(Buffer.from("{broken\n", "utf8"))).toThrow(/JSON|seed/iu);
    expect(() => decodeSyntheticPluginDataSeed(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8|seed|bytes/iu);
    expect(() => decodeSyntheticPluginDataSeed("not bytes" as unknown as Uint8Array)).toThrow(/bytes|Uint8Array/iu);
  });
});

describe("synthetic acceptance plugin-data runtime compatibility", () => {
  it("loads the exact completed rename through the real store and journal", async () => {
    const port = new MemoryPluginDataPort(parseBytes(encodeSyntheticPluginDataSeed()));
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const entries = await journal.list();

    expect(store.settings()).toEqual(expectedSeed.settings);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expectedJournal);
    expect(entries[0]?.status).toBe("completed");
    expect(await verifyPlanFingerprint(entries[0]!.plan)).toBe(true);
    expect(await journal.get(entries[0]!.id)).toEqual(entries[0]);
    expect(journal.organizationWritesBlocked()).toBe(false);
    expect(JSON.stringify(entries[0])).not.toMatch(/recovery|endpoint|model|secret|https?:/iu);
    expect([...collectMarkdownPaths(entries[0])].sort()).toEqual([SOURCE_PATH, TARGET_PATH]);
  });

  it("proves the real read-only policy normalizes settings without losing the seeded journal", async () => {
    const seedBytes = encodeSyntheticPluginDataSeed();
    expect(inspectPostHostPluginData(seedBytes)).toEqual({
      startupNormalizationEvidence: "seed-unchanged",
      seededJournalPresent: true,
      recoveryAbsent: true,
    });

    const port = new MemoryPluginDataPort(parseBytes(seedBytes));
    const store = new PluginDataStore(port);
    await store.load();
    const before = await new OperationJournal(store).list();
    await store.enforceRuntimePolicy(READ_ONLY_ACCEPTANCE_POLICY);
    await store.reload();

    expect(store.settings()).toEqual({ ...expectedSeed.settings, writeEnabled: false, aiEnabled: false });
    const raw = requireRecord(await port.load(), "post-policy plugin data");
    const rawSettings = settingsOf(raw);
    expect(rawSettings.writeEnabled).toBe(false);
    expect(rawSettings.aiEnabled).toBe(false);
    expect(rawSettings.aiEndpoint).toBe("");
    expect(rawSettings.aiModel).toBe("");
    expect(rawSettings.secretId).toBe("");
    expect(await new OperationJournal(store).list()).toEqual(before);
    expect(new OperationJournal(store).organizationWritesBlocked()).toBe(false);

    const inspection = inspectPostHostPluginData(encodeJson(raw));
    expect(inspection).toEqual({
      startupNormalizationEvidence: "normalized-safe",
      seededJournalPresent: true,
      recoveryAbsent: true,
    });
    expect(Object.keys(inspection)).toEqual([
      "startupNormalizationEvidence",
      "seededJournalPresent",
      "recoveryAbsent",
    ]);
    expect(Object.isFrozen(inspection)).toBe(true);
  });
});

describe("post-host plugin-data inspection", () => {
  it("classifies every retained write, AI, secret, and unknown-sensitive setting as unsafe", () => {
    const unsafeMutations: ReadonlyArray<readonly [string, (settings: JsonRecord) => void]> = [
      ["write capability", (settings) => { settings.writeEnabled = true; }],
      ["AI capability", (settings) => { settings.aiEnabled = true; }],
      ["AI endpoint", (settings) => { settings.aiEndpoint = "https://example.invalid"; }],
      ["AI model", (settings) => { settings.aiModel = "fixture-model"; }],
      ["secret ID", (settings) => { settings.secretId = "fixture-secret"; }],
      ["unknown API key", (settings) => { settings.apiKey = ""; }],
      ["unknown authorization", (settings) => { settings.authorization = ""; }],
      ["unknown raw secret", (settings) => { settings.rawSecret = ""; }],
      ["unknown callback URL", (settings) => { settings.callbackUrl = ""; }],
      ["unknown service URI", (settings) => { settings.serviceUri = ""; }],
      ["unknown proxy host", (settings) => { settings.proxyHost = ""; }],
      ["unknown private key", (settings) => { settings.privateKey = ""; }],
      ["nested service URL", (settings) => { settings.future = { serviceUrl: "" }; }],
      ["nested token", (settings) => { settings.future = { transport: { token: "" } }; }],
      ["nested URL value", (settings) => { settings.future = { transport: ["https://example.invalid"] }; }],
    ];

    for (const [label, mutate] of unsafeMutations) {
      const data = normalizedSeedData();
      data.activeIndex = { builtAt: 2, records: [] };
      mutate(settingsOf(data));
      expect(inspectPostHostPluginData(encodeJson(data)), label).toEqual({
        startupNormalizationEvidence: "unsafe",
        seededJournalPresent: true,
        recoveryAbsent: true,
      });
    }

    const malformedSettings = normalizedSeedData();
    malformedSettings.settings = null;
    expect(inspectPostHostPluginData(encodeJson(malformedSettings)).startupNormalizationEvidence).toBe("unsafe");
  });

  it("keeps normalization independent from legal derived host state", () => {
    const data = normalizedSeedData();
    data.activeIndex = { builtAt: 2, records: [] };
    data.staging = { scanId: "synthetic", completedPaths: [], records: [] };
    settingsOf(data).futureDisplayPreference = true;
    settingsOf(data).futureAppearance = { density: "compact" };
    const operational = operationalOf(data);
    operational.pins = { synthetic: 2 };
    operational.dismissals = { synthetic: { dismissedAt: 2, mtime: 1 } };
    operational.lastOpened = { synthetic: 2 };

    expect(inspectPostHostPluginData(encodeJson(data))).toEqual({
      startupNormalizationEvidence: "normalized-safe",
      seededJournalPresent: true,
      recoveryAbsent: true,
    });
  });

  it("rejects invalid persisted root and derived-container shapes", () => {
    const cases: Array<readonly [string, JsonRecord]> = [];

    const wrongSchema = normalizedSeedData();
    wrongSchema.schemaVersion = 2;
    cases.push(["schema version", wrongSchema]);

    const extraRoot = normalizedSeedData();
    extraRoot.unexpected = true;
    cases.push(["extra root key", extraRoot]);

    const missingRoot = normalizedSeedData();
    delete missingRoot.staging;
    cases.push(["missing root key", missingRoot]);

    const malformedIndex = normalizedSeedData();
    malformedIndex.activeIndex = { builtAt: "later", records: [] };
    cases.push(["active index", malformedIndex]);

    const malformedStaging = normalizedSeedData();
    malformedStaging.staging = { scanId: 1, completedPaths: [], records: [] };
    cases.push(["staging", malformedStaging]);

    const malformedOperational = normalizedSeedData();
    operationalOf(malformedOperational).pins = [];
    cases.push(["operational maps", malformedOperational]);

    const extraOperational = normalizedSeedData();
    operationalOf(extraOperational).unexpected = true;
    cases.push(["extra operational key", extraOperational]);

    for (const [label, data] of cases) {
      expect(() => inspectPostHostPluginData(encodeJson(data)), label)
        .toThrow(/plugin data|schema|shape|keys|index|staging|operational/iu);
    }
  });

  it("reports missing, malformed, changed, and duplicated seeded journals independently", () => {
    const cases: JsonRecord[] = [];

    const missing = normalizedSeedData();
    operationalOf(missing).journals = [];
    cases.push(missing);

    const absentContainer = normalizedSeedData();
    delete operationalOf(absentContainer).journals;
    cases.push(absentContainer);

    const malformed = normalizedSeedData();
    operationalOf(malformed).journals = [{ malformed: true }];
    cases.push(malformed);

    const changed = normalizedSeedData();
    requireRecord(requireRecord(journalsOf(changed)[0], "journal").plan, "plan").fingerprint = "0".repeat(64);
    cases.push(changed);

    const duplicated = normalizedSeedData();
    journalsOf(duplicated).push(structuredClone(journalsOf(duplicated)[0]));
    cases.push(duplicated);

    for (const data of cases) {
      expect(inspectPostHostPluginData(encodeJson(data))).toEqual({
        startupNormalizationEvidence: "normalized-safe",
        seededJournalPresent: false,
        recoveryAbsent: true,
      });
    }
  });

  it("reports recovery independently while preserving normalized settings and the seeded journal", () => {
    const withRecovery = normalizedSeedData();
    journalsOf(withRecovery).push({
      id: "synthetic-recovery",
      status: "recovery-required",
      recovery: { unresolved: [] },
    });

    expect(inspectPostHostPluginData(encodeJson(withRecovery))).toEqual({
      startupNormalizationEvidence: "normalized-safe",
      seededJournalPresent: true,
      recoveryAbsent: false,
    });

    const withRecoveryProperty = normalizedSeedData();
    journalsOf(withRecoveryProperty).push({ status: "completed", recovery: null });
    expect(inspectPostHostPluginData(encodeJson(withRecoveryProperty))).toEqual({
      startupNormalizationEvidence: "normalized-safe",
      seededJournalPresent: true,
      recoveryAbsent: false,
    });
  });

  it("throws for unreadable bytes, invalid JSON, and non-object roots without exposing raw data", () => {
    expect(() => inspectPostHostPluginData(Buffer.from("not JSON\n", "utf8"))).toThrow(/JSON|plugin data/iu);
    expect(() => inspectPostHostPluginData(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8|bytes|plugin data/iu);
    expect(() => inspectPostHostPluginData(encodeJson([]))).toThrow(/object|plugin data/iu);
    expect(() => inspectPostHostPluginData("not bytes" as unknown as Uint8Array)).toThrow(/bytes|Uint8Array/iu);

    const result = inspectPostHostPluginData(encodeJson(normalizedSeedData()));
    expect(result).not.toHaveProperty("settings");
    expect(result).not.toHaveProperty("operational");
    expect(result).not.toHaveProperty("raw");
  });
});
