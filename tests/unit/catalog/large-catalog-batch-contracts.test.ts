import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHybridCatalogAdapter } from "../../../src/adapters/local-hybrid-catalog-adapter";
import type { CloudCatalogRecord } from "../../../src/catalog/catalog-types";
import {
  decodeLargeCatalogBatchCheckpoint,
  decodeLargeCatalogRunReceipt,
  encodeLargeCatalogBatchCheckpoint,
} from "../../../src/catalog/hybrid-catalog-codec";
import {
  LARGE_CATALOG_RUN_BUDGET,
  HybridCatalogError,
  type LargeCatalogBatchCheckpointV3,
} from "../../../src/catalog/hybrid-catalog-types";
import type { CandidateImportWriter } from "../../../src/catalog/hybrid-catalog-ports";

const roots: string[] = [];
const HASH_A = "a".repeat(64);
const HASH_C = "c".repeat(64);
const GROUP = `group:${"d".repeat(64)}`;
const PAGE_KEY = "e".repeat(64);

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

describe("large catalog schema-v3 batch contracts", () => {
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

  it("persists a permit before any page and reloads it without inventing a receipt", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const initial = checkpoint();
    await adapter.createBatch(initial);
    expect(await adapter.loadBatch("batch-1")).toEqual({
      checkpoint: initial,
      records: [],
      identities: [],
      identitiesComplete: true,
    });
    const permitted = checkpoint({ listRequestCount: 1, cumulativeListRequestCount: 1 });
    await adapter.saveBatchPermit(permitted);
    expect((await adapter.loadBatch("batch-1"))?.checkpoint).toEqual(permitted);
    expect(await adapter.loadBatchReceipt("batch-1")).toBeNull();

    await expect(adapter.saveBatchPermit({ ...permitted, listRequestCount: 3 }))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    await expect(adapter.saveBatchPermit({ ...permitted, sourceImportSha256: "b".repeat(64) }))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("rejects duplicate creation without deleting the existing batch", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const initial = checkpoint();
    await adapter.createBatch(initial);

    await expect(adapter.createBatch(initial))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    expect((await adapter.loadBatch("batch-1"))?.checkpoint).toEqual(initial);
  });

  it("commits a page exactly once and rejects a conflicting replay", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await seedCandidates(adapter);
    const permitted = checkpoint({ listRequestCount: 1, cumulativeListRequestCount: 1 });
    await adapter.createBatch(checkpoint());
    await adapter.saveBatchPermit(permitted);
    const next = checkpoint({
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
      batchId: "batch-1",
      pageKey: PAGE_KEY,
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      nextCheckpoint: next,
    } as const;
    await adapter.commitBatchPage(input);
    await expect(adapter.commitBatchPage(input)).resolves.toBeUndefined();
    expect(await adapter.loadBatch("batch-1")).toEqual({
      checkpoint: next,
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      identitiesComplete: true,
    });
    expect(JSON.parse(await readFile(
      join(root, "hybrid", "batches", "batch-1", "pages", `${PAGE_KEY}.json`),
      "utf8",
    ))).toMatchObject({
      schemaVersion: 2,
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
    });

    const afterAnotherPermit = {
      ...next,
      listRequestCount: 2,
      cumulativeListRequestCount: 2,
    };
    await adapter.saveBatchPermit(afterAnotherPermit);
    await expect(adapter.commitBatchPage(input)).resolves.toBeUndefined();
    expect((await adapter.loadBatch("batch-1"))?.checkpoint).toEqual(afterAnotherPermit);

    const secondPageKey = "f".repeat(64);
    await expect(adapter.commitBatchPage({
      batchId: "batch-1",
      pageKey: secondPageKey,
      records: [],
      identities: [{ fsId: "1", path: "/Library/Synthetic/Replayed.txt" }],
      nextCheckpoint: {
        ...afterAnotherPermit,
        ignoredFileCount: 1,
        groups: [{
          ...afterAnotherPermit.groups[0]!,
          pending: [],
          committedPageKeys: [PAGE_KEY, secondPageKey],
        }],
      },
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    expect((await adapter.loadBatch("batch-1"))?.checkpoint).toEqual(afterAnotherPermit);

    await expect(adapter.commitBatchPage({
      ...input,
      records: [cloudRecord("2")],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));

    await writeFile(
      join(root, "hybrid", "batches", "batch-1", "pages", `${PAGE_KEY}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        pageKey: PAGE_KEY,
        records: [cloudRecord()],
        nextCheckpoint: next,
      })}\n`,
      "utf8",
    );
    expect(await adapter.loadBatch("batch-1")).toMatchObject({
      records: [cloudRecord()],
      identities: [{ fsId: "1", path: "/Library/Synthetic/A.pdf" }],
      identitiesComplete: false,
    });

    await writeFile(
      join(root, "hybrid", "batches", "batch-1", "pages", `${PAGE_KEY}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        pageKey: PAGE_KEY,
        records: [null],
        nextCheckpoint: next,
      })}\n`,
      "utf8",
    );
    await expect(adapter.loadBatch("batch-1"))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("saves terminal state before a strict aggregate receipt and finalizes idempotently", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    await adapter.createBatch(checkpoint());
    const terminal = checkpoint({
      status: "paused",
      stopReason: "user-canceled",
    });
    const first = await adapter.finalizeBatchRun({ checkpoint: terminal, endedAt: 20 });
    expect(first).toEqual({
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
    });
    await expect(adapter.finalizeBatchRun({ checkpoint: terminal, endedAt: 20 }))
      .resolves.toEqual(first);
    expect(await adapter.loadBatchReceipt("batch-1")).toEqual(first);
    expect(decodeLargeCatalogRunReceipt(JSON.stringify(first))).toEqual(first);
    const receiptJson = JSON.stringify(first);
    for (const secret of [
      "batch-1",
      HASH_A,
      HASH_C,
      GROUP,
      "Synthetic",
      "relativePath",
      "pageKey",
      "filename",
      "token",
      "url",
    ]) expect(receiptJson).not.toContain(secret);

    await expect(adapter.finalizeBatchRun({ checkpoint: terminal, endedAt: 21 }))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("resumes a paused batch only through a monotonic new run", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const paused = checkpoint({ status: "paused", stopReason: "user-canceled" });
    await adapter.createBatch(checkpoint());
    await adapter.finalizeBatchRun({ checkpoint: paused, endedAt: 20 });
    const resumed = checkpoint({
      startedAt: 30,
      runOrdinal: 2,
      status: "scanning",
      stopReason: null,
    });
    await adapter.resumeBatch(resumed);
    expect((await adapter.loadBatch("batch-1"))?.checkpoint).toEqual(resumed);
    expect(await adapter.loadBatchReceipt("batch-1")).toBeNull();

    await expect(adapter.resumeBatch({ ...resumed, runOrdinal: 4 }))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("advances exactly one completed group without changing run counters", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const secondGroup = `group:${"f".repeat(64)}`;
    const initial = checkpoint({
      selectedGroupCount: 2,
      groups: [
        { ...checkpoint().groups[0]!, pending: [] },
        {
          groupKey: secondGroup,
          rootRelativePath: "Second",
          mode: "recursive",
          status: "pending",
          pending: [{ relativePath: "", start: 0 }],
          committedPageKeys: [],
          completedDirectoryCount: 0,
        },
      ],
    });
    await adapter.createBatch(initial);
    const advanced = checkpoint({
      selectedGroupCount: 2,
      currentGroupIndex: 1,
      groups: [
        { ...initial.groups[0]!, status: "complete" },
        { ...initial.groups[1]!, status: "scanning" },
      ],
    });
    await adapter.advanceBatchGroup(advanced);
    expect((await adapter.loadBatch("batch-1"))?.checkpoint).toEqual(advanced);

    await expect(adapter.advanceBatchGroup({ ...advanced, currentGroupIndex: 0 }))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
  });

  it("loads only the most recently started private batch for restart recovery", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const older = checkpoint({ batchId: "batch-older", startedAt: 10 });
    const newer = checkpoint({ batchId: "batch-newer", startedAt: 20 });
    await adapter.createBatch(older);
    await adapter.createBatch(newer);

    expect(await adapter.loadLatestBatch()).toEqual({
      checkpoint: newer,
      records: [],
      identities: [],
      identitiesComplete: true,
    });
  });
});
