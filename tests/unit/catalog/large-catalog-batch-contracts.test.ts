import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalHybridCatalogAdapter,
  type HybridAtomicRenamePort,
} from "../../../src/adapters/local-hybrid-catalog-adapter";
import type { CloudCatalogRecord } from "../../../src/catalog/catalog-types";
import {
  decodeLargeCatalogBatchCheckpoint,
  decodeLargeCatalogBatchCheckpointAny,
  decodeLargeCatalogBatchCheckpointV4,
  decodeLargeCatalogBatchClaim,
  decodeLargeCatalogBatchOperationJournal,
  decodeLargeCatalogBatchPageEnvelopeV3,
  decodeLargeCatalogBatchStagingManifest,
  decodeLargeCatalogActiveCheckpointPointer,
  decodeLargeCatalogRunReceipt,
  decodeLargeCatalogRunReceiptAny,
  decodeLargeCatalogRunReceiptV4,
  encodeLargeCatalogActiveCheckpointPointer,
  encodeLargeCatalogBatchCheckpoint,
  encodeLargeCatalogBatchCheckpointV4,
  encodeLargeCatalogBatchClaim,
  encodeLargeCatalogBatchOperationJournal,
  encodeLargeCatalogBatchPageEnvelopeV3,
  encodeLargeCatalogBatchStagingManifest,
  encodeLargeCatalogRunReceipt,
  encodeLargeCatalogRunReceiptV4,
} from "../../../src/catalog/hybrid-catalog-codec";
import {
  LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  LARGE_CATALOG_RUN_BUDGET,
  HybridCatalogError,
  type LargeCatalogBatchCheckpointV3,
  type LargeCatalogBatchCheckpointV4,
  type LargeCatalogRunReceiptV3,
  type LargeCatalogRunReceiptV4,
} from "../../../src/catalog/hybrid-catalog-types";
import type { CandidateImportWriter } from "../../../src/catalog/hybrid-catalog-ports";

const roots: string[] = [];
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const GROUP = `group:${"d".repeat(64)}`;
const PAGE_KEY = "e".repeat(64);
const SCOPE = {
  generation: 2,
  sourceImportSha256: HASH_A,
  cloudRootSha256: HASH_C,
} as const;

const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-batch-v3-")));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const checkpoint = (
  overrides: Partial<LargeCatalogBatchCheckpointV3> = {},
): LargeCatalogBatchCheckpointV3 => ({
  schemaVersion: 3,
  batchId: "batch-1",
  sourceImportSha256: HASH_A,
  cloudRootSha256: HASH_C,
  startedAt: 10,
  runOrdinal: 1,
  budget: LARGE_CATALOG_RUN_BUDGET,
  selectedGroupCount: 1,
  currentGroupIndex: 0,
  groups: [{
    groupKey: GROUP,
    rootRelativePath: "Synthetic",
    mode: "recursive",
    status: "scanning",
    pending: [{ relativePath: "", start: 0 }],
    committedPageKeys: [],
    completedDirectoryCount: 0,
  }],
  pdfCount: 0,
  directoryCount: 0,
  ignoredFileCount: 0,
  listRequestCount: 0,
  cumulativeListRequestCount: 0,
  status: "scanning",
  stopReason: null,
  errorCodeCounts: {},
  ...overrides,
});

const checkpointV4 = (
  overrides: Partial<LargeCatalogBatchCheckpointV4> = {},
): LargeCatalogBatchCheckpointV4 => ({
  schemaVersion: 4,
  batchId: "batch-v4",
  verificationScope: SCOPE,
  legacyCheckpointSha256: null,
  latestReceipt: null,
  startedAt: 10,
  runOrdinal: 1,
  budget: LARGE_CATALOG_RUN_BUDGET,
  selectedGroupCount: 1,
  currentGroupIndex: 0,
  groups: [{
    groupKey: GROUP,
    rootRelativePath: "Synthetic",
    mode: "recursive",
    status: "scanning",
    pending: [{ relativePath: "", start: 0 }],
    committedPageKeys: [],
    completedDirectoryCount: 0,
  }],
  pdfCount: 0,
  directoryCount: 0,
  ignoredFileCount: 0,
  listRequestCount: 0,
  cumulativeListRequestCount: 0,
  status: "scanning",
  stopReason: null,
  errorCodeCounts: {},
  ...overrides,
});

const receiptV4 = (
  overrides: Partial<LargeCatalogRunReceiptV4> = {},
): LargeCatalogRunReceiptV4 => ({
  schemaVersion: 4,
  batchId: "batch-v4",
  runOrdinal: 1,
  verificationScope: SCOPE,
  legacyCheckpointSha256: null,
  status: "paused",
  stopReason: "user-canceled",
  startedAt: 10,
  endedAt: 20,
  durationMs: 10,
  budget: LARGE_CATALOG_RUN_BUDGET,
  selectedGroupCount: 1,
  completedGroupCount: 0,
  listRequestCount: 0,
  cumulativeListRequestCount: 0,
  directoryCount: 0,
  pdfCount: 0,
  ignoredFileCount: 0,
  downloadedPdfBytes: 0,
  errorCodeCounts: {},
  ...overrides,
});

const receiptV3 = (
  overrides: Partial<LargeCatalogRunReceiptV3> = {},
): LargeCatalogRunReceiptV3 => ({
  schemaVersion: 3,
  status: "paused",
  stopReason: "user-canceled",
  startedAt: 10,
  endedAt: 20,
  durationMs: 10,
  budget: LARGE_CATALOG_RUN_BUDGET,
  selectedGroupCount: 1,
  completedGroupCount: 0,
  listRequestCount: 0,
  cumulativeListRequestCount: 0,
  directoryCount: 0,
  pdfCount: 0,
  ignoredFileCount: 0,
  downloadedPdfBytes: 0,
  errorCodeCounts: {},
  ...overrides,
});

const cloudRecord = (fsId = "1"): CloudCatalogRecord => ({
  schemaVersion: 1,
  source: "baidu-netdisk",
  fsId,
  kind: "file",
  path: "/Library/Synthetic/A.pdf",
  parentPath: "/Library/Synthetic",
  filename: "A.pdf",
  extension: "pdf",
  title: "A",
  isbnCandidates: [],
  sizeBytes: 7,
  serverModifiedAt: 11,
});

const seedCandidates = async (adapter: LocalHybridCatalogAdapter): Promise<void> => {
  const writer: CandidateImportWriter = await adapter.createCandidateImport("import-1");
  await writer.append({
    schemaVersion: 1,
    source: "txt-candidate",
    candidateId: `txt:${HASH_A}`,
    relativePath: "Synthetic/A.pdf",
    parentRelativePath: "Synthetic",
    filename: "A.pdf",
    title: "A",
    isbnCandidates: [],
    topLevelGroupId: GROUP,
    hierarchyTags: ["folder/Synthetic"],
  });
  await writer.commit({
    importedAt: 1,
    summary: {
      sourceSha256: HASH_A,
      byteSize: 100,
      nonEmptyLineCount: 2,
      pdfCount: 1,
      directoryCount: 1,
      ignoredLeafCount: 0,
      normalizedWhitespaceCount: 0,
      maxDepth: 2,
    },
  });
};

const canonicalV4Hash = (value: LargeCatalogBatchCheckpointV4): string => createHash("sha256")
  .update(`${encodeLargeCatalogBatchCheckpointV4(value)}\n`, "utf8")
  .digest("hex");

const seedLegacyBatch = async (
  root: string,
  legacy: LargeCatalogBatchCheckpointV3,
  receiptOrdinals: readonly number[],
): Promise<Readonly<{
  directory: string;
  checkpointRaw: string;
  fingerprint: Readonly<{
    batchId: string;
    checkpointSha256: string;
    sourceImportSha256: string;
    cloudRootSha256: string;
  }>;
}>> => {
  const directory = join(root, "hybrid", "batches", legacy.batchId);
  await mkdir(join(directory, "pages"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "receipts"), { mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(join(directory, "pages"), 0o700);
  await chmod(join(directory, "receipts"), 0o700);
  const checkpointRaw = `${encodeLargeCatalogBatchCheckpoint(legacy)}\n`;
  await writeFile(join(directory, "checkpoint.json"), checkpointRaw, { mode: 0o600 });
  for (const ordinal of receiptOrdinals) {
    const isTerminalReceipt = legacy.status !== "scanning" && ordinal === legacy.runOrdinal;
    const startedAt = isTerminalReceipt ? legacy.startedAt : ordinal * 100;
    const receipt = receiptV3({
      status: isTerminalReceipt ? legacy.status : "paused",
      stopReason: isTerminalReceipt ? legacy.stopReason! : "user-canceled",
      startedAt,
      endedAt: startedAt + 10,
      durationMs: 10,
      selectedGroupCount: legacy.selectedGroupCount,
      listRequestCount: isTerminalReceipt ? legacy.listRequestCount : 0,
      cumulativeListRequestCount: isTerminalReceipt
        ? legacy.cumulativeListRequestCount
        : ordinal,
      directoryCount: isTerminalReceipt ? legacy.directoryCount : 0,
      pdfCount: isTerminalReceipt ? legacy.pdfCount : 0,
      ignoredFileCount: isTerminalReceipt ? legacy.ignoredFileCount : 0,
      errorCodeCounts: isTerminalReceipt ? legacy.errorCodeCounts : {},
    });
    await writeFile(
      join(directory, "receipts", `run-${ordinal}.json`),
      `${encodeLargeCatalogRunReceipt(receipt)}\n`,
      { mode: 0o600 },
    );
  }
  return {
    directory,
    checkpointRaw,
    fingerprint: {
      batchId: legacy.batchId,
      checkpointSha256: createHash("sha256").update(checkpointRaw, "utf8").digest("hex"),
      sourceImportSha256: legacy.sourceImportSha256,
      cloudRootSha256: legacy.cloudRootSha256,
    },
  };
};

class ScriptedRenamePort implements HybridAtomicRenamePort {
  #destinationSuffix: string | null = null;

  failNextDestination(suffix: string): void {
    this.#destinationSuffix = suffix;
  }

  async rename(source: string, destination: string): Promise<void> {
    if (this.#destinationSuffix !== null && destination.endsWith(this.#destinationSuffix)) {
      this.#destinationSuffix = null;
      throw new Error("injected-rename-failure");
    }
    await rename(source, destination);
  }
}

describe("large catalog schema-v3 batch contracts", () => {
  it("keeps the automatic-chain ceiling runtime-only", () => {
    const paused = checkpoint({ status: "paused", stopReason: "pdf-limit" });

    expect(Object.keys(paused)).not.toContain("autoSegmentLimit");
    expect(LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS).toBe(12);
  });

  it("strictly decodes only canonical v3 checkpoints with the fixed budget", () => {
    const value = checkpoint();
    expect(decodeLargeCatalogBatchCheckpoint(JSON.stringify(value))).toEqual(value);
    expect(encodeLargeCatalogBatchCheckpoint(value)).toBe(JSON.stringify(value));

    for (const invalid of [
      { ...value, schemaVersion: 1 },
      { ...value, schemaVersion: 2 },
      { ...value, sourcePath: "/private/catalog.txt" },
      { ...value, budget: { ...value.budget, maxPdfCount: 10_001 } },
      { ...value, selectedGroupCount: 2 },
      { ...value, listRequestCount: 301 },
      {
        ...value,
        groups: [{ ...value.groups[0]!, mode: "direct-files-only" }],
      },
      {
        ...value,
        groups: [{ ...value.groups[0]!, status: "pending" }],
      },
      {
        ...value,
        selectedGroupCount: 6,
        groups: Array.from({ length: 6 }, (_, index) => ({
          ...value.groups[0]!,
          groupKey: `group:${index.toString(16).padStart(64, "0")}`,
        })),
      },
    ]) {
      expect(() => decodeLargeCatalogBatchCheckpoint(JSON.stringify(invalid)))
        .toThrow(new HybridCatalogError("hybrid-batch-invalid"));
    }
  });

  it("canonicalizes multi-error counts independently of input key order", () => {
    const reversedErrors = {
      "hybrid-batch-invalid": 2,
      "baidu-permission-denied": 1,
    } as const;
    const canonicalErrors = {
      "baidu-permission-denied": 1,
      "hybrid-batch-invalid": 2,
    } as const;
    const legacyCheckpoint = checkpoint({ errorCodeCounts: reversedErrors });
    const currentCheckpoint = checkpointV4({ errorCodeCounts: reversedErrors });
    const legacyReceipt = receiptV3({ errorCodeCounts: reversedErrors });
    const currentReceipt = receiptV4({ errorCodeCounts: reversedErrors });
    const decodedCounts = [
      decodeLargeCatalogBatchCheckpoint(JSON.stringify(legacyCheckpoint)).errorCodeCounts,
      decodeLargeCatalogBatchCheckpointV4(JSON.stringify(currentCheckpoint)).errorCodeCounts,
      decodeLargeCatalogRunReceipt(JSON.stringify(legacyReceipt)).errorCodeCounts,
      decodeLargeCatalogRunReceiptV4(JSON.stringify(currentReceipt)).errorCodeCounts,
    ];
    for (const counts of decodedCounts) expect(counts).toEqual(canonicalErrors);

    const encodedValues = [
      encodeLargeCatalogBatchCheckpoint(legacyCheckpoint),
      encodeLargeCatalogBatchCheckpointV4(currentCheckpoint),
      encodeLargeCatalogRunReceipt(legacyReceipt),
      encodeLargeCatalogRunReceiptV4(currentReceipt),
    ];
    for (const encoded of encodedValues) {
      const parsed = JSON.parse(encoded) as Readonly<{ errorCodeCounts: unknown }>;
      expect(JSON.stringify(parsed.errorCodeCounts)).toBe(JSON.stringify(canonicalErrors));
    }
  });

  it("keeps V3 readable while normal scoped checkpoints and receipts use exact V4", () => {
    const legacy = checkpoint();
    const current = checkpointV4();
    expect(decodeLargeCatalogBatchCheckpoint(JSON.stringify(legacy))).toEqual(legacy);
    expect(decodeLargeCatalogBatchCheckpointAny(JSON.stringify(legacy))).toEqual(legacy);
    expect(decodeLargeCatalogBatchCheckpointV4(JSON.stringify(current))).toEqual(current);
    expect(decodeLargeCatalogBatchCheckpointAny(JSON.stringify(current))).toEqual(current);
    expect(encodeLargeCatalogBatchCheckpointV4(current)).toBe(JSON.stringify(current));

    const receipt = receiptV4();
    expect(decodeLargeCatalogRunReceiptV4(JSON.stringify(receipt))).toEqual(receipt);
    expect(decodeLargeCatalogRunReceiptAny(JSON.stringify(receipt))).toEqual(receipt);
    expect(encodeLargeCatalogRunReceiptV4(receipt)).toBe(JSON.stringify(receipt));

    for (const invalid of [
      { ...current, sourceImportSha256: HASH_A },
      { ...current, verificationScope: { ...SCOPE, generation: 0 } },
      { ...current, legacyCheckpointSha256: "bad" },
      { ...current, latestReceipt: { runOrdinal: 2, receiptSha256: HASH_A } },
    ]) {
      expect(() => decodeLargeCatalogBatchCheckpointV4(JSON.stringify(invalid)))
        .toThrow(new HybridCatalogError("hybrid-batch-invalid"));
    }
    for (const invalid of [
      { ...receipt, batchId: ".hidden" },
      { ...receipt, legacyCheckpointSha256: "bad" },
      { ...receipt, durationMs: 11 },
      { ...receipt, token: "secret" },
    ]) {
      expect(() => decodeLargeCatalogRunReceiptV4(JSON.stringify(invalid)))
        .toThrow(new HybridCatalogError("hybrid-batch-invalid"));
    }
  });

  it("accepts only the current or immediately prior V4 receipt ordinal", () => {
    const currentReceipt = checkpointV4({
      runOrdinal: 3,
      latestReceipt: { runOrdinal: 3, receiptSha256: HASH_A },
    });
    const priorReceipt = checkpointV4({
      runOrdinal: 3,
      latestReceipt: { runOrdinal: 2, receiptSha256: HASH_A },
    });
    expect(decodeLargeCatalogBatchCheckpointV4(JSON.stringify(currentReceipt)))
      .toEqual(currentReceipt);
    expect(decodeLargeCatalogBatchCheckpointV4(JSON.stringify(priorReceipt)))
      .toEqual(priorReceipt);
    expect(() => decodeLargeCatalogBatchCheckpointV4(JSON.stringify(checkpointV4({
      runOrdinal: 3,
      latestReceipt: { runOrdinal: 1, receiptSha256: HASH_A },
    })))).toThrow(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("strictly freezes pointer, staging, claim, and recoverable journal keys", () => {
    const pointer = {
      schemaVersion: 1,
      batchId: "batch-v4",
      activeSlot: "a",
      activeCheckpointSha256: HASH_A,
      legacyCheckpointSha256: null,
      verificationScope: SCOPE,
    } as const;
    const manifest = {
      schemaVersion: 1,
      batchId: "batch-v4",
      nonce: "nonce-1",
      activeCheckpointSha256: HASH_A,
      activePointerSha256: HASH_B,
      verificationScope: SCOPE,
    } as const;
    const claim = {
      schemaVersion: 1,
      batchId: "batch-v4",
      nonce: "nonce-1",
      stagingManifestSha256: HASH_C,
    } as const;
    const pageJournal = {
      schemaVersion: 1,
      state: "prepared",
      operationId: "operation-1",
      operationKind: "page",
      batchId: "batch-v4",
      verificationScope: SCOPE,
      legacyCheckpointSha256: null,
      runOrdinal: 1,
      priorActivePointerSha256: HASH_A,
      targetSlot: "b",
      targetCheckpointSha256: HASH_B,
      pageKey: PAGE_KEY,
      pageEnvelopeSha256: HASH_C,
      receiptSha256: null,
    } as const;
    const finalizeJournal = {
      ...pageJournal,
      operationKind: "finalize",
      pageKey: null,
      pageEnvelopeSha256: null,
      receiptSha256: HASH_D,
    } as const;

    expect(decodeLargeCatalogActiveCheckpointPointer(JSON.stringify(pointer))).toEqual(pointer);
    expect(encodeLargeCatalogActiveCheckpointPointer(pointer)).toBe(JSON.stringify(pointer));
    expect(decodeLargeCatalogBatchStagingManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(encodeLargeCatalogBatchStagingManifest(manifest)).toBe(JSON.stringify(manifest));
    expect(decodeLargeCatalogBatchClaim(JSON.stringify(claim))).toEqual(claim);
    expect(encodeLargeCatalogBatchClaim(claim)).toBe(JSON.stringify(claim));
    expect(decodeLargeCatalogBatchOperationJournal(JSON.stringify(pageJournal)))
      .toEqual(pageJournal);
    expect(decodeLargeCatalogBatchOperationJournal(JSON.stringify(finalizeJournal)))
      .toEqual(finalizeJournal);
    expect(decodeLargeCatalogBatchOperationJournal(JSON.stringify({
      ...finalizeJournal,
      state: "settled",
    }))).toEqual({ ...finalizeJournal, state: "settled" });
    expect(encodeLargeCatalogBatchOperationJournal(pageJournal)).toBe(JSON.stringify(pageJournal));

    for (const invalid of [
      { decode: decodeLargeCatalogActiveCheckpointPointer, value: { ...pointer, activeSlot: "c" } },
      { decode: decodeLargeCatalogActiveCheckpointPointer, value: { ...pointer, extra: true } },
      { decode: decodeLargeCatalogBatchStagingManifest, value: { ...manifest, nonce: ".hidden" } },
      { decode: decodeLargeCatalogBatchClaim, value: { ...claim, batchId: ".hidden" } },
      {
        decode: decodeLargeCatalogBatchOperationJournal,
        value: { ...pageJournal, receiptSha256: HASH_D },
      },
      {
        decode: decodeLargeCatalogBatchOperationJournal,
        value: { ...finalizeJournal, pageKey: PAGE_KEY },
      },
    ]) {
      expect(() => invalid.decode(JSON.stringify(invalid.value)))
        .toThrow(new HybridCatalogError("hybrid-batch-invalid"));
    }
  });

  it("binds every V4 page envelope to exact prior and next checkpoint hashes", () => {
    const nextCheckpoint = checkpointV4({
      listRequestCount: 1,
      cumulativeListRequestCount: 1,
      pdfCount: 1,
      groups: [{
        ...checkpointV4().groups[0]!,
        committedPageKeys: [PAGE_KEY],
        pending: [{ relativePath: "", start: 1000 }],
        completedDirectoryCount: 1,
      }],
    });
    const nextCheckpointSha256 = createHash("sha256")
      .update(`${encodeLargeCatalogBatchCheckpointV4(nextCheckpoint)}\n`, "utf8")
      .digest("hex");
    const envelope = {
      schemaVersion: 3,
      pageKey: PAGE_KEY,
      verificationScope: SCOPE,
      legacyCheckpointSha256: null,
      priorCheckpointSha256: HASH_A,
      nextCheckpointSha256,
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      nextCheckpoint,
    } as const;
    expect(decodeLargeCatalogBatchPageEnvelopeV3(JSON.stringify(envelope))).toEqual(envelope);
    expect(encodeLargeCatalogBatchPageEnvelopeV3(envelope)).toBe(JSON.stringify(envelope));

    for (const invalid of [
      { ...envelope, nextCheckpointSha256: HASH_D },
      { ...envelope, verificationScope: { ...SCOPE, generation: 3 } },
      { ...envelope, legacyCheckpointSha256: HASH_B },
      { ...envelope, identities: [{ fsId: "2", path: "/Library/Synthetic/A.pdf" }] },
      { ...envelope, credential: "secret" },
    ]) {
      expect(() => decodeLargeCatalogBatchPageEnvelopeV3(JSON.stringify(invalid)))
        .toThrow(new HybridCatalogError("hybrid-batch-invalid"));
    }
  });

  it("rejects duplicate and oversized record sets in V3 page envelopes", () => {
    const nextCheckpoint = checkpointV4({
      listRequestCount: 1,
      cumulativeListRequestCount: 1,
      pdfCount: 1,
      groups: [{
        ...checkpointV4().groups[0]!,
        committedPageKeys: [PAGE_KEY],
      }],
    });
    const envelope = {
      schemaVersion: 3,
      pageKey: PAGE_KEY,
      verificationScope: SCOPE,
      legacyCheckpointSha256: null,
      priorCheckpointSha256: HASH_A,
      nextCheckpointSha256: canonicalV4Hash(nextCheckpoint),
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      nextCheckpoint,
    } as const;

    expect(() => decodeLargeCatalogBatchPageEnvelopeV3(JSON.stringify({
      ...envelope,
      records: [cloudRecord(), cloudRecord()],
    }))).toThrow(new HybridCatalogError("hybrid-batch-invalid"));
    expect(() => decodeLargeCatalogBatchPageEnvelopeV3(JSON.stringify({
      ...envelope,
      records: Array.from({ length: 1001 }, () => cloudRecord()),
    }))).toThrow(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("publishes a native V4 batch through an exact claim and active slot", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await seedCandidates(adapter);
    const initial = checkpointV4();

    await adapter.createBatch(initial);

    await expect(adapter.loadBatch(initial.batchId)).resolves.toEqual({
      kind: "scoped-v4",
      checkpoint: initial,
      checkpointSha256: canonicalV4Hash(initial),
      records: [],
      identities: [],
      identitiesComplete: true,
    });
    const finalDirectory = join(root, "hybrid", "batches", initial.batchId);
    expect((await readdir(finalDirectory)).sort()).toEqual(["claim.json", "published"]);
    const published = join(finalDirectory, "published");
    const pointer = decodeLargeCatalogActiveCheckpointPointer(await readFile(
      join(published, "active-checkpoint.json"),
      "utf8",
    ).then((raw) => raw.slice(0, -1)));
    expect(pointer).toMatchObject({
      batchId: initial.batchId,
      activeSlot: "a",
      activeCheckpointSha256: canonicalV4Hash(initial),
      verificationScope: SCOPE,
    });
  });

  it("fails closed on an unexpected entry inside a native published directory", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await seedCandidates(adapter);
    await adapter.createBatch(checkpointV4());
    await writeFile(
      join(root, "hybrid", "batches", "batch-v4", "published", "rogue.json"),
      "{}\n",
      { mode: 0o600 },
    );

    await expect(adapter.loadBatch("batch-v4"))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("recovers an exact claimed staging directory after publication is interrupted", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    const adapter = new LocalHybridCatalogAdapter(root, renames);
    await seedCandidates(adapter);
    renames.failNextDestination("/published");

    await expect(adapter.createBatch(checkpointV4()))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    await expect(new LocalHybridCatalogAdapter(root).loadBatch("batch-v4"))
      .resolves.toMatchObject({
        kind: "scoped-v4",
        checkpoint: checkpointV4(),
      });
  });

  it("persists permits and page commits through the inactive V4 slot", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await seedCandidates(adapter);
    const initial = checkpointV4();
    await adapter.createBatch(initial);
    const permitted = checkpointV4({ listRequestCount: 1, cumulativeListRequestCount: 1 });
    await adapter.saveBatchPermit(permitted);
    const next = checkpointV4({
      listRequestCount: 1,
      cumulativeListRequestCount: 1,
      pdfCount: 1,
      groups: [{
        ...permitted.groups[0]!,
        pending: [{ relativePath: "", start: 1000 }],
        committedPageKeys: [PAGE_KEY],
        completedDirectoryCount: 1,
      }],
    });
    const input = {
      batchId: initial.batchId,
      pageKey: PAGE_KEY,
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      nextCheckpoint: next,
    } as const;

    await adapter.commitBatchPage(input);
    await expect(adapter.commitBatchPage(input)).resolves.toBeUndefined();
    await expect(adapter.loadBatch(initial.batchId)).resolves.toEqual({
      kind: "scoped-v4",
      checkpoint: next,
      checkpointSha256: canonicalV4Hash(next),
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      identitiesComplete: true,
    });
    expect(JSON.parse(await readFile(
      join(root, "hybrid", "batches", initial.batchId, "published", "pages", `${PAGE_KEY}.json`),
      "utf8",
    ))).toMatchObject({
      schemaVersion: 3,
      priorCheckpointSha256: canonicalV4Hash(permitted),
      nextCheckpointSha256: canonicalV4Hash(next),
      verificationScope: SCOPE,
    });
  });

  it("finishes a prepared page journal after a pointer-swap crash", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    const adapter = new LocalHybridCatalogAdapter(root, renames);
    await seedCandidates(adapter);
    await adapter.createBatch(checkpointV4());
    const permitted = checkpointV4({ listRequestCount: 1, cumulativeListRequestCount: 1 });
    await adapter.saveBatchPermit(permitted);
    const next = checkpointV4({
      listRequestCount: 1,
      cumulativeListRequestCount: 1,
      pdfCount: 1,
      groups: [{
        ...permitted.groups[0]!,
        pending: [],
        committedPageKeys: [PAGE_KEY],
        completedDirectoryCount: 1,
      }],
    });
    renames.failNextDestination("active-checkpoint.json");

    await expect(adapter.commitBatchPage({
      batchId: "batch-v4",
      pageKey: PAGE_KEY,
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      nextCheckpoint: next,
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));

    await expect(new LocalHybridCatalogAdapter(root).loadBatch("batch-v4"))
      .resolves.toMatchObject({ checkpoint: next, records: [cloudRecord()] });
  });

  it("publishes a hash-linked V4 receipt and resumes monotonically", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await seedCandidates(adapter);
    await adapter.createBatch(checkpointV4());
    const terminal = checkpointV4({ status: "paused", stopReason: "user-canceled" });
    const receipt = await adapter.finalizeBatchRun({ checkpoint: terminal, endedAt: 20 });
    expect(receipt).toEqual(receiptV4());
    await expect(adapter.finalizeBatchRun({ checkpoint: terminal, endedAt: 20 }))
      .resolves.toEqual(receipt);
    expect(await adapter.loadBatchReceipt("batch-v4")).toEqual(receipt);
    const loadedTerminal = await adapter.loadBatch("batch-v4");
    expect(loadedTerminal?.kind).toBe("scoped-v4");
    if (loadedTerminal?.kind !== "scoped-v4") throw new Error("expected-scoped-v4");
    expect(loadedTerminal.checkpoint.latestReceipt).toEqual({
      runOrdinal: 1,
      receiptSha256: createHash("sha256")
        .update(`${encodeLargeCatalogRunReceiptV4(receipt)}\n`, "utf8")
        .digest("hex"),
    });
    const resumed = {
      ...loadedTerminal.checkpoint,
      startedAt: 30,
      runOrdinal: 2,
      status: "scanning" as const,
      stopReason: null,
      pdfCount: 0,
      directoryCount: 0,
      ignoredFileCount: 0,
      listRequestCount: 0,
      errorCodeCounts: {},
    };
    await adapter.resumeBatch(resumed);
    expect((await adapter.loadBatch("batch-v4"))?.checkpoint).toEqual(resumed);
    expect(await adapter.loadBatchReceipt("batch-v4")).toBeNull();
  });

  it("promotes only the exact adopted V3 checkpoint and preserves its immutable prefix", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await seedCandidates(adapter);
    const legacy = checkpoint({ status: "paused", stopReason: "user-canceled" });
    const directory = join(root, "hybrid", "batches", legacy.batchId);
    await mkdir(join(directory, "pages"), { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "receipts"), { mode: 0o700 });
    await chmod(directory, 0o700);
    await chmod(join(directory, "pages"), 0o700);
    await chmod(join(directory, "receipts"), 0o700);
    const checkpointRaw = `${encodeLargeCatalogBatchCheckpoint(legacy)}\n`;
    await writeFile(join(directory, "checkpoint.json"), checkpointRaw, { mode: 0o600 });
    const legacyReceipt = {
      schemaVersion: 3,
      status: "paused",
      stopReason: "user-canceled",
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      budget: LARGE_CATALOG_RUN_BUDGET,
      selectedGroupCount: 1,
      completedGroupCount: 0,
      listRequestCount: 0,
      cumulativeListRequestCount: 0,
      directoryCount: 0,
      pdfCount: 0,
      ignoredFileCount: 0,
      downloadedPdfBytes: 0,
      errorCodeCounts: {},
    } as const;
    await writeFile(
      join(directory, "receipts", "run-1.json"),
      `${JSON.stringify(legacyReceipt)}\n`,
      { mode: 0o600 },
    );
    const fingerprint = {
      batchId: legacy.batchId,
      checkpointSha256: createHash("sha256").update(checkpointRaw, "utf8").digest("hex"),
      sourceImportSha256: HASH_A,
      cloudRootSha256: HASH_C,
    } as const;

    const promoted = await adapter.promoteAdoptedLegacyBatch({
      verificationScope: SCOPE,
      legacyBatch: fingerprint,
    });
    expect(promoted).toMatchObject({
      kind: "scoped-v4",
      checkpoint: {
        schemaVersion: 4,
        legacyCheckpointSha256: fingerprint.checkpointSha256,
        verificationScope: SCOPE,
      },
    });
    expect(await readFile(join(directory, "checkpoint.json"), "utf8")).toBe(checkpointRaw);
    await expect(adapter.promoteAdoptedLegacyBatch({
      verificationScope: SCOPE,
      legacyBatch: fingerprint,
    })).resolves.toEqual(promoted);
    await expect(adapter.promoteAdoptedLegacyBatch({
      verificationScope: { ...SCOPE, generation: 3 },
      legacyBatch: fingerprint,
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("promotes only exact V3 receipt prefixes for scanning and terminal runs", async () => {
    const cases = [
      { label: "scanning-run-1", status: "scanning", runOrdinal: 1, expectedLast: 0 },
      { label: "scanning-run-3", status: "scanning", runOrdinal: 3, expectedLast: 2 },
      { label: "paused-run-3", status: "paused", runOrdinal: 3, expectedLast: 3 },
      { label: "partial-run-3", status: "partial", runOrdinal: 3, expectedLast: 3 },
      { label: "complete-run-3", status: "complete", runOrdinal: 3, expectedLast: 3 },
    ] as const;

    for (const [index, entry] of cases.entries()) {
      const root = await temporaryRoot();
      const adapter = new LocalHybridCatalogAdapter(root);
      await seedCandidates(adapter);
      const isComplete = entry.status === "complete";
      const legacy = checkpoint({
        batchId: `batch-prefix-${index}`,
        runOrdinal: entry.runOrdinal,
        status: entry.status,
        stopReason: entry.status === "scanning"
          ? null
          : entry.status === "complete"
            ? "complete"
            : entry.status === "partial"
              ? "hybrid-batch-invalid"
              : "user-canceled",
        currentGroupIndex: isComplete ? 1 : 0,
        groups: [{
          ...checkpoint().groups[0]!,
          status: isComplete ? "complete" : "scanning",
          pending: isComplete ? [] : checkpoint().groups[0]!.pending,
        }],
      });
      const seeded = await seedLegacyBatch(
        root,
        legacy,
        Array.from({ length: entry.expectedLast }, (_, receiptIndex) => receiptIndex + 1),
      );

      await expect(adapter.promoteAdoptedLegacyBatch({
        verificationScope: SCOPE,
        legacyBatch: seeded.fingerprint,
      })).resolves.toMatchObject({ kind: "scoped-v4" });
    }
  });

  it("rejects missing, malformed, and surplus V3 receipt prefix entries", async () => {
    for (const mode of ["missing", "malformed", "surplus"] as const) {
      const root = await temporaryRoot();
      const adapter = new LocalHybridCatalogAdapter(root);
      await seedCandidates(adapter);
      const legacy = checkpoint({
        batchId: `batch-${mode}`,
        runOrdinal: 2,
        status: "paused",
        stopReason: "user-canceled",
      });
      const ordinals = mode === "missing" ? [1] : mode === "surplus" ? [1, 2, 3] : [1, 2];
      const seeded = await seedLegacyBatch(root, legacy, ordinals);
      if (mode === "malformed") {
        await writeFile(join(seeded.directory, "receipts", "run-2.json"), "{}\n", {
          mode: 0o600,
        });
      }

      await expect(adapter.promoteAdoptedLegacyBatch({
        verificationScope: SCOPE,
        legacyBatch: seeded.fingerprint,
      })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    }
  });

  it("never hides corruption in a published newest batch by selecting an older batch", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await seedCandidates(adapter);
    await adapter.createBatch(checkpointV4({ batchId: "batch-older", startedAt: 10 }));
    await adapter.createBatch(checkpointV4({ batchId: "batch-newer", startedAt: 20 }));
    await writeFile(
      join(root, "hybrid", "batches", "batch-newer", "published", "active-checkpoint.json"),
      "{}\n",
      "utf8",
    );

    await expect(adapter.loadLatestBatch())
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });
});
