import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHybridCatalogAdapter } from "../../../src/adapters/local-hybrid-catalog-adapter";
import type { BaiduCatalogSourcePort } from "../../../src/catalog/catalog-ports";
import { CatalogReconciliationService } from "../../../src/catalog/catalog-reconciliation-service";
import { CatalogError, type BaiduListEntry } from "../../../src/catalog/catalog-types";
import {
  LargeCatalogVerificationService,
  type LargeCatalogVerificationSelection,
  type LargeVerificationProgressEvent,
} from "../../../src/catalog/large-catalog-verification-service";
import { UnifiedCatalogProjectionService } from "../../../src/catalog/unified-catalog-projection-service";
import type { CandidateImportWriter } from "../../../src/catalog/hybrid-catalog-ports";
import { HybridCatalogError } from "../../../src/catalog/hybrid-catalog-types";

const roots: string[] = [];
const HASH_A = "a".repeat(64);
const GROUP = `group:${"c".repeat(64)}`;

const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-large-run-")));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const file = (path: string, fsId: string): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 7,
  serverModifiedAt: 11,
  isDirectory: false,
});

const directory = (path: string, fsId: string): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 0,
  serverModifiedAt: 11,
  isDirectory: true,
});

type ScriptStep = Readonly<{
  path: string;
  start: number;
  entries?: readonly BaiduListEntry[];
  error?: CatalogError;
}>;

class ScriptedSource implements BaiduCatalogSourcePort {
  readonly requests: Array<Readonly<{ path: string; start: number }>> = [];
  afterPermit?: () => Promise<void>;

  constructor(readonly steps: ScriptStep[]) {}

  async listDirectory(input: Readonly<{
    path: string;
    start: number;
    limit: 1000;
    beforeRequest: () => Promise<void>;
  }>): Promise<Readonly<{ entries: readonly BaiduListEntry[] }>> {
    await input.beforeRequest();
    await this.afterPermit?.();
    this.requests.push({ path: input.path, start: input.start });
    const step = this.steps.shift();
    if (step === undefined || step.path !== input.path || step.start !== input.start) {
      throw new CatalogError("invalid-baidu-response");
    }
    if (step.error !== undefined) throw step.error;
    return { entries: step.entries ?? [] };
  }
}

const seedCandidates = async (adapter: LocalHybridCatalogAdapter): Promise<void> => {
  const writer: CandidateImportWriter = await adapter.createCandidateImport("import-1");
  for (const record of [
    {
      schemaVersion: 1,
      source: "txt-candidate",
      candidateId: `txt:${"1".repeat(64)}`,
      relativePath: "Synthetic/A.pdf",
      parentRelativePath: "Synthetic",
      filename: "A.pdf",
      title: "A",
      isbnCandidates: [],
      topLevelGroupId: GROUP,
      hierarchyTags: ["folder/Synthetic"],
    },
    {
      schemaVersion: 1,
      source: "txt-candidate",
      candidateId: `txt:${"2".repeat(64)}`,
      relativePath: "Synthetic/Sub/B.pdf",
      parentRelativePath: "Synthetic/Sub",
      filename: "B.pdf",
      title: "B",
      isbnCandidates: [],
      topLevelGroupId: GROUP,
      hierarchyTags: ["folder/Synthetic", "folder/Sub"],
    },
    {
      schemaVersion: 1,
      source: "txt-candidate",
      candidateId: `txt:${"3".repeat(64)}`,
      relativePath: "Root.pdf",
      parentRelativePath: "",
      filename: "Root.pdf",
      title: "Root",
      isbnCandidates: [],
      topLevelGroupId: "txt-root-items",
      hierarchyTags: [],
    },
  ] as const) await writer.append(record);
  await writer.commit({
    importedAt: 1,
    summary: {
      sourceSha256: HASH_A,
      byteSize: 100,
      nonEmptyLineCount: 5,
      pdfCount: 3,
      directoryCount: 2,
      ignoredLeafCount: 0,
      normalizedWhitespaceCount: 0,
      maxDepth: 3,
    },
  });
};

const selection = (
  overrides: Partial<LargeCatalogVerificationSelection> = {},
): LargeCatalogVerificationSelection => ({
  groupKey: GROUP,
  rootRelativePath: "Synthetic",
  mode: "recursive",
  ...overrides,
});

const harness = async (source: ScriptedSource, now: () => number = () => 100) => {
  const root = await temporaryRoot();
  const adapter = new LocalHybridCatalogAdapter(root);
  await seedCandidates(adapter);
  const service = new LargeCatalogVerificationService({
    source,
    store: adapter,
    reconcile: new CatalogReconciliationService(),
    project: new UnifiedCatalogProjectionService(adapter, { now }),
    now,
  });
  return { adapter, root, service };
};

describe("LargeCatalogVerificationService", () => {
  it("rejects the cloud root before preparing or running a verification batch", async () => {
    const source = new ScriptedSource([]);
    const { adapter, service } = await harness(source);

    await expect(service.prepare({
      batchId: "batch-root-rejected",
      sourceImportSha256: HASH_A,
      cloudRoot: "/",
      groups: [selection()],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    await expect(service.start({
      batchId: "batch-root-rejected",
      sourceImportSha256: HASH_A,
      cloudRoot: "/",
      groups: [selection()],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));

    expect(source.requests).toEqual([]);
    expect(await adapter.loadBatch("batch-root-rejected")).toBeNull();
  });

  it("prepares and loads state without networking, then scans only on an explicit segment", async () => {
    const source = new ScriptedSource([
      {
        path: "/Library/Synthetic",
        start: 0,
        entries: [file("/Library/Synthetic/A.pdf", "1")],
      },
    ]);
    const { adapter, service } = await harness(source);
    await service.prepare({
      batchId: "batch-1",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    expect(source.requests).toEqual([]);
    expect(await service.loadPaused("batch-1")).toMatchObject({
      status: "scanning",
      remainingGroupCount: 1,
    });
    expect(source.requests).toEqual([]);

    source.afterPermit = async () => {
      expect((await adapter.loadBatch("batch-1"))?.checkpoint.listRequestCount).toBe(1);
    };
    const result = await service.runSegment({ batchId: "batch-1", cloudRoot: "/Library" });
    expect(result).toMatchObject({ status: "complete", stopReason: "complete" });
    expect(source.requests).toEqual([{ path: "/Library/Synthetic", start: 0 }]);
  });

  it("emits aggregate progress only after persisted boundaries", async () => {
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: [file("/Library/Synthetic/A.pdf", "1")] },
    ]);
    const { adapter, service } = await harness(source);
    const events: LargeVerificationProgressEvent[] = [];
    const result = await service.start({
      batchId: "batch-events",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
      onProgress: (event) => { events.push(event); },
    });

    expect(events.map((event) => event.phase)).toEqual([
      "segment-started",
      "request-permitted",
      "page-committed",
      "group-completed",
      "segment-finalized",
    ]);
    expect(events.find((event) => event.phase === "request-permitted")?.summary)
      .toMatchObject({ listRequestCount: 1, committedPdfCount: 0 });
    expect(events.find((event) => event.phase === "page-committed")?.summary)
      .toMatchObject({ pdfCount: 1, committedPdfCount: 1, committedPageCount: 1 });
    expect(events.at(-1)?.summary).toEqual(result);
    expect(JSON.stringify(events)).not.toContain("/Library");
    expect(JSON.stringify(events)).not.toContain("A.pdf");
    expect((await adapter.loadBatch("batch-events"))?.records).toHaveLength(1);
  });

  it("keeps persisted results when a progress listener throws", async () => {
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: [file("/Library/Synthetic/A.pdf", "1")] },
    ]);
    const { adapter, service } = await harness(source);
    const result = await service.start({
      batchId: "batch-listener-failure",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
      onProgress: () => { throw new Error("synthetic-progress-listener-failure"); },
    });

    expect(result.status).toBe("complete");
    expect((await adapter.loadBatch("batch-listener-failure"))?.records).toHaveLength(1);
  });

  it("distinguishes a resume root hash mismatch from other invalid batch input", async () => {
    const source = new ScriptedSource([]);
    const { service } = await harness(source);
    await service.prepare({
      batchId: "batch-root-guard",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    await expect(service.runSegment({
      batchId: "batch-root-guard",
      cloudRoot: "/Different-library",
    })).rejects.toEqual(new HybridCatalogError("hybrid-cloud-root-mismatch"));
    expect(source.requests).toEqual([]);

    const invariantSource = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [],
    }]);
    const times = [100, 99];
    const invariant = await harness(invariantSource, () => times.shift() ?? 99);
    await invariant.service.prepare({
      batchId: "batch-clock-invariant",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    await expect(invariant.service.runSegment({
      batchId: "batch-clock-invariant",
      cloudRoot: "/Library",
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    expect(invariantSource.requests).toEqual([]);
  });

  it("scans directories serially and promotes an overlay only after the group is complete", async () => {
    const source = new ScriptedSource([
      {
        path: "/Library/Synthetic",
        start: 0,
        entries: [
          directory("/Library/Synthetic/Sub", "10"),
          file("/Library/Synthetic/A.pdf", "1"),
        ],
      },
      {
        path: "/Library/Synthetic/Sub",
        start: 0,
        entries: [file("/Library/Synthetic/Sub/B.pdf", "2")],
      },
    ]);
    const { adapter, service } = await harness(source);
    const result = await service.start({
      batchId: "batch-serial",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(result.status).toBe("complete");
    expect(source.requests).toEqual([
      { path: "/Library/Synthetic", start: 0 },
      { path: "/Library/Synthetic/Sub", start: 0 },
    ]);
    expect((await adapter.loadActiveOverlays())[0]?.records.map((record) => record.fsId))
      .toEqual(["1", "2"]);
    expect((await adapter.loadActiveUnified())?.records.filter((record) => (
      record.topLevelGroupId === GROUP
    )).every((record) => record.verificationStatus === "verified")).toBe(true);
  });

  it("lists root items directly and never enqueues returned directories", async () => {
    const source = new ScriptedSource([{
      path: "/Library",
      start: 0,
      entries: [
        directory("/Library/Synthetic", "10"),
        file("/Library/Root.pdf", "3"),
      ],
    }]);
    const { adapter, service } = await harness(source);
    await service.start({
      batchId: "batch-root",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection({
        groupKey: "txt-root-items",
        rootRelativePath: "",
        mode: "direct-files-only",
      })],
    });

    expect(source.requests).toEqual([{ path: "/Library", start: 0 }]);
    expect((await adapter.loadActiveOverlays())[0]?.records).toEqual([
      expect.objectContaining({ fsId: "3", relativePath: "Root.pdf" }),
    ]);
  });

  it("pauses before a canceled request and leaves the category unpromoted", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [file("/Library/Synthetic/A.pdf", "1")],
    }]);
    const { adapter, service } = await harness(source);
    const controller = new AbortController();
    controller.abort();
    const result = await service.start({
      batchId: "batch-cancel",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: "paused", stopReason: "user-canceled" });
    expect(source.requests).toEqual([]);
    expect(await adapter.loadActiveOverlays()).toEqual([]);
  });

  it("persists a rate-limit failure, loads it offline, and resumes explicitly", async () => {
    const source = new ScriptedSource([
      {
        path: "/Library/Synthetic",
        start: 0,
        entries: [
          directory("/Library/Synthetic/Sub", "10"),
          file("/Library/Synthetic/A.pdf", "1"),
        ],
      },
      {
        path: "/Library/Synthetic/Sub",
        start: 0,
        error: new CatalogError("baidu-rate-limited", true),
      },
      {
        path: "/Library/Synthetic/Sub",
        start: 0,
        entries: [file("/Library/Synthetic/Sub/B.pdf", "2")],
      },
    ]);
    let now = 100;
    const { adapter, service } = await harness(source, () => now++);
    const first = await service.start({
      batchId: "batch-resume",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    expect(first).toMatchObject({ status: "partial", stopReason: "baidu-rate-limited" });
    expect(await service.loadPaused("batch-resume")).toMatchObject({ status: "partial" });
    expect(source.requests).toHaveLength(2);
    expect(await adapter.loadActiveOverlays()).toEqual([]);

    const resumed = await service.runSegment({ batchId: "batch-resume", cloudRoot: "/Library" });
    expect(resumed.status).toBe("complete");
    expect(source.requests).toHaveLength(3);
    expect((await adapter.loadBatch("batch-resume"))?.checkpoint)
      .toMatchObject({ runOrdinal: 2, cumulativeListRequestCount: 3 });
    expect((await adapter.loadActiveOverlays())[0]?.records.map((record) => record.fsId))
      .toEqual(["1", "2"]);
  });

  it("discards a whole page that would exceed the directory budget", async () => {
    const entries = Array.from({ length: 501 }, (_, index) => directory(
      `/Library/Synthetic/D${String(index).padStart(3, "0")}`,
      String(index + 1),
    ));
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries,
    }]);
    const { adapter, service } = await harness(source);
    const events: LargeVerificationProgressEvent[] = [];
    const result = await service.start({
      batchId: "batch-budget",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
      onProgress: (event) => { events.push(event); },
    });

    expect(result).toMatchObject({ status: "paused", stopReason: "directory-limit" });
    expect(events.at(-1)?.phase).toBe("segment-finalized");
    expect(events.at(-1)?.summary).toMatchObject({
      status: "paused",
      stopReason: "directory-limit",
      committedPdfCount: 0,
      committedPageCount: 0,
    });
    expect(events.some((event) => event.phase === "page-committed")).toBe(false);
    expect((await adapter.loadBatch("batch-budget"))?.records).toEqual([]);
    expect(await adapter.loadActiveOverlays()).toEqual([]);
  });

  it("restores the prior active overlay when unified projection fails", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [file("/Library/Synthetic/A.pdf", "1")],
    }]);
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const service = new LargeCatalogVerificationService({
      source,
      store: adapter,
      reconcile: new CatalogReconciliationService(),
      project: {
        rebuild: async () => { throw new HybridCatalogError("hybrid-snapshot-corrupt"); },
      },
      now: () => 100,
    });

    const result = await service.start({
      batchId: "batch-project-failure",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    expect(result).toMatchObject({ status: "partial", stopReason: "hybrid-snapshot-corrupt" });
    expect(await adapter.loadActiveOverlays()).toEqual([]);
  });

  it("continues a full 1,000-entry page with the next start offset", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => file(
      `/Library/Synthetic/Ignored-${String(index).padStart(4, "0")}.txt`,
      String(index + 1),
    ));
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: firstPage },
      { path: "/Library/Synthetic", start: 1000, entries: [] },
    ]);
    const { adapter, service } = await harness(source);
    const result = await service.start({
      batchId: "batch-pagination",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(result).toMatchObject({
      status: "complete",
      listRequestCount: 2,
      ignoredFileCount: 1000,
    });
    expect(source.requests).toEqual([
      { path: "/Library/Synthetic", start: 0 },
      { path: "/Library/Synthetic", start: 1000 },
    ]);
    expect((await adapter.loadBatch("batch-pagination"))?.checkpoint.groups[0])
      .toMatchObject({ completedDirectoryCount: 1, pending: [] });
  });

  it("rejects a file identity repeated on a later page and preserves a terminal receipt", async () => {
    const firstPage = [
      file("/Library/Synthetic/A.pdf", "1"),
      ...Array.from({ length: 999 }, (_, index) => file(
        `/Library/Synthetic/Ignored-${String(index).padStart(4, "0")}.txt`,
        String(index + 2),
      )),
    ];
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: firstPage },
      {
        path: "/Library/Synthetic",
        start: 1000,
        entries: [file("/Library/Synthetic/B.pdf", "1")],
      },
    ]);
    const { adapter, service } = await harness(source);

    const result = await service.start({
      batchId: "batch-cross-page-duplicate",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      listRequestCount: 2,
      pdfCount: 1,
      ignoredFileCount: 999,
    });
    expect(await adapter.loadBatchReceipt("batch-cross-page-duplicate")).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      listRequestCount: 2,
    });
    expect((await adapter.loadBatch("batch-cross-page-duplicate"))?.records)
      .toEqual([expect.objectContaining({ fsId: "1", path: "/Library/Synthetic/A.pdf" })]);
    expect(await adapter.loadActiveOverlays()).toEqual([]);
  });

  it.each([
    ["fsId", file("/Library/Synthetic/Replayed.txt", "1")],
    ["path", file("/Library/Synthetic/Ignored-0000.txt", "9001")],
  ] as const)("rejects an ignored identity with a repeated %s after resume", async (kind, replay) => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => file(
      `/Library/Synthetic/Ignored-${String(index).padStart(4, "0")}.txt`,
      String(index + 1),
    ));
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: firstPage },
      {
        path: "/Library/Synthetic",
        start: 1000,
        error: new CatalogError("baidu-rate-limited", true),
      },
      {
        path: "/Library/Synthetic",
        start: 1000,
        entries: [replay],
      },
    ]);
    let now = 100;
    const { adapter, service } = await harness(source, () => now++);

    const first = await service.start({
      batchId: `batch-resume-ignored-${kind}`,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    expect(first).toMatchObject({
      status: "partial",
      stopReason: "baidu-rate-limited",
      ignoredFileCount: 1000,
    });
    expect((await adapter.loadBatch(`batch-resume-ignored-${kind}`))?.records).toEqual([]);

    const resumed = await service.runSegment({
      batchId: `batch-resume-ignored-${kind}`,
      cloudRoot: "/Library",
    });
    expect(resumed).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      listRequestCount: 1,
      ignoredFileCount: 0,
    });
    expect(await adapter.loadActiveOverlays()).toEqual([]);
  });

  it("rejects a directory identity repeated after a paused batch is resumed", async () => {
    const firstPage = [
      directory("/Library/Synthetic/Sub", "1"),
      ...Array.from({ length: 999 }, (_, index) => file(
        `/Library/Synthetic/Ignored-${String(index).padStart(4, "0")}.txt`,
        String(index + 2),
      )),
    ];
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: firstPage },
      {
        path: "/Library/Synthetic",
        start: 1000,
        error: new CatalogError("baidu-rate-limited", true),
      },
      {
        path: "/Library/Synthetic",
        start: 1000,
        entries: [directory("/Library/Synthetic/Replayed", "1")],
      },
    ]);
    let now = 100;
    const { adapter, service } = await harness(source, () => now++);
    await service.start({
      batchId: "batch-resume-directory",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    const resumed = await service.runSegment({
      batchId: "batch-resume-directory",
      cloudRoot: "/Library",
    });
    expect(resumed).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      directoryCount: 0,
      ignoredFileCount: 0,
    });
    expect(await adapter.loadActiveOverlays()).toEqual([]);
  });

  it("loads a legacy PDF-only page but refuses to resume it without complete identities", async () => {
    const firstPage = [
      file("/Library/Synthetic/A.pdf", "1"),
      ...Array.from({ length: 999 }, (_, index) => file(
        `/Library/Synthetic/Ignored-${String(index).padStart(4, "0")}.txt`,
        String(index + 2),
      )),
    ];
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: firstPage },
      {
        path: "/Library/Synthetic",
        start: 1000,
        error: new CatalogError("baidu-rate-limited", true),
      },
    ]);
    let now = 100;
    const { adapter, root, service } = await harness(source, () => now++);
    await service.start({
      batchId: "batch-legacy-identities",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    const loaded = await adapter.loadBatch("batch-legacy-identities");
    const pageKey = loaded?.checkpoint.groups[0]?.committedPageKeys[0];
    expect(pageKey).toBeDefined();
    const pagePath = join(
      root,
      "hybrid",
      "batches",
      "batch-legacy-identities",
      "pages",
      `${pageKey!}.json`,
    );
    const current = JSON.parse(await readFile(pagePath, "utf8")) as Readonly<{
      pageKey: string;
      records: readonly unknown[];
      nextCheckpoint: unknown;
    }>;
    await writeFile(pagePath, `${JSON.stringify({
      schemaVersion: 1,
      pageKey: current.pageKey,
      records: current.records,
      nextCheckpoint: current.nextCheckpoint,
    })}\n`, "utf8");

    expect((await adapter.loadBatch("batch-legacy-identities"))?.identitiesComplete).toBe(false);
    await expect(service.runSegment({
      batchId: "batch-legacy-identities",
      cloudRoot: "/Library",
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    expect(source.requests).toHaveLength(2);
  });

  it("counts both transport permits when a source replays after token refresh", async () => {
    let transportCount = 0;
    const source: BaiduCatalogSourcePort = {
      listDirectory: async (input) => {
        await input.beforeRequest();
        transportCount += 1;
        await input.beforeRequest();
        transportCount += 1;
        return { entries: [file("/Library/Synthetic/A.pdf", "1")] };
      },
    };
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const service = new LargeCatalogVerificationService({
      source,
      store: adapter,
      reconcile: new CatalogReconciliationService(),
      project: new UnifiedCatalogProjectionService(adapter, { now: () => 100 }),
      now: () => 100,
    });
    await service.start({
      batchId: "batch-refresh",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(transportCount).toBe(2);
    expect((await adapter.loadBatch("batch-refresh"))?.checkpoint)
      .toMatchObject({ listRequestCount: 2, cumulativeListRequestCount: 2 });
  });

  it("finishes selected groups in their declared order without parallel requests", async () => {
    const source = new ScriptedSource([
      {
        path: "/Library/Synthetic",
        start: 0,
        entries: [file("/Library/Synthetic/A.pdf", "1")],
      },
      {
        path: "/Library",
        start: 0,
        entries: [file("/Library/Root.pdf", "3")],
      },
    ]);
    const { adapter, service } = await harness(source);
    const result = await service.start({
      batchId: "batch-two-groups",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [
        selection(),
        selection({
          groupKey: "txt-root-items",
          rootRelativePath: "",
          mode: "direct-files-only",
        }),
      ],
    });

    expect(result).toMatchObject({ status: "complete", remainingGroupCount: 0 });
    expect(source.requests).toEqual([
      { path: "/Library/Synthetic", start: 0 },
      { path: "/Library", start: 0 },
    ]);
    expect(await adapter.loadActiveOverlays()).toHaveLength(2);
  });

  it("discards a fetched page when the 30-minute limit is reached before commit", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [file("/Library/Synthetic/A.pdf", "1")],
    }]);
    const times = [100, 100, 1_800_100, 1_800_100];
    const { adapter, service } = await harness(source, () => times.shift() ?? 1_800_100);
    const result = await service.start({
      batchId: "batch-time",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(result).toMatchObject({ status: "paused", stopReason: "time-limit" });
    expect((await adapter.loadBatch("batch-time"))?.records).toEqual([]);
    expect(await adapter.loadActiveOverlays()).toEqual([]);
  });

  it("stops before transport 301 when repeated source permits reach the request limit", async () => {
    let transportCount = 0;
    const source: BaiduCatalogSourcePort = {
      listDirectory: async (input) => {
        for (let index = 0; index < 301; index += 1) {
          await input.beforeRequest();
          transportCount += 1;
        }
        return { entries: [] };
      },
    };
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const service = new LargeCatalogVerificationService({
      source,
      store: adapter,
      reconcile: new CatalogReconciliationService(),
      project: new UnifiedCatalogProjectionService(adapter, { now: () => 100 }),
      now: () => 100,
    });
    const result = await service.start({
      batchId: "batch-request-limit",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(result).toMatchObject({
      status: "paused",
      stopReason: "list-request-limit",
      listRequestCount: 300,
      cumulativeListRequestCount: 300,
    });
    expect(transportCount).toBe(300);
  });
});
