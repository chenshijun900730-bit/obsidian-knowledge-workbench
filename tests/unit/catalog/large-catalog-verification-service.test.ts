import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalHybridCatalogAdapter } from "../../../src/adapters/local-hybrid-catalog-adapter";
import type { BaiduCatalogSourcePort } from "../../../src/catalog/catalog-ports";
import { CatalogReconciliationService } from "../../../src/catalog/catalog-reconciliation-service";
import { CatalogError, type BaiduListEntry } from "../../../src/catalog/catalog-types";
import {
  LargeCatalogVerificationService,
  type LargeCatalogVerificationSelection,
  type LargeVerificationProgressEvent,
} from "../../../src/catalog/large-catalog-verification-service";
import type {
  CandidateImportWriter,
  HybridCatalogStorePort,
} from "../../../src/catalog/hybrid-catalog-ports";
import {
  LARGE_CATALOG_RUN_BUDGET,
  HybridCatalogError,
  type LargeCatalogBatchCheckpointV3,
  type LargeCatalogBatchCheckpointV4,
} from "../../../src/catalog/hybrid-catalog-types";
import { UnifiedCatalogProjectionService } from "../../../src/catalog/unified-catalog-projection-service";

const roots: string[] = [];
const HASH_A = "a".repeat(64);
const ROOT_HASH = createHash("sha256").update("/Library").digest("hex");
const GROUP = `group:${"c".repeat(64)}`;
const SCOPE = Object.freeze({
  generation: 2,
  sourceImportSha256: HASH_A,
  cloudRootSha256: ROOT_HASH,
});
const AUTHORITY = Object.freeze({
  kind: "scoped" as const,
  scope: SCOPE,
  legacyAllowlist: null,
});

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

const seedCandidates = async (
  adapter: LocalHybridCatalogAdapter,
  importId = "import-1",
): Promise<void> => {
  const writer: CandidateImportWriter = await adapter.createCandidateImport(importId);
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
  await new UnifiedCatalogProjectionService(adapter, { now: () => 1 }).rebuild();
};

const fingerprintedAuthority = async (root: string) => {
  const manifestRaw = await readFile(join(root, "hybrid", "candidate-active.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as Readonly<{ importId: string }>;
  const descriptorRaw = await readFile(
    join(root, "hybrid", "imports", manifest.importId, "receipt.json"),
    "utf8",
  );
  return {
    kind: "scoped" as const,
    scope: SCOPE,
    legacyAllowlist: {
      candidate: {
        importId: manifest.importId,
        manifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
        descriptorSha256: createHash("sha256").update(descriptorRaw).digest("hex"),
      },
      overlays: [],
      unified: null,
      resumableBatch: null,
    },
  };
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
    now,
  });
  return { adapter, root, service };
};

describe("LargeCatalogVerificationService", () => {
  it("rejects a tampered candidate fingerprint before creating a batch or using the network", async () => {
    const source = new ScriptedSource([]);
    const { adapter, root, service } = await harness(source);
    const authority = await fingerprintedAuthority(root);
    await seedCandidates(adapter, "import-2");

    await expect(service.prepare({
      batchId: "batch-tampered-prepare",
      sourceImportSha256: HASH_A,
      authority,
      cloudRoot: "/Library",
      groups: [selection()],
    })).rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));

    expect(source.requests).toEqual([]);
    await expect(adapter.loadBatch("batch-tampered-prepare")).resolves.toBeNull();
    await expect(adapter.loadActiveOverlays()).resolves.toEqual([]);
  });

  it("revalidates the candidate fingerprint before a resumed segment can write or use the network", async () => {
    const source = new ScriptedSource([]);
    const { adapter, root, service } = await harness(source);
    const authority = await fingerprintedAuthority(root);
    await service.prepare({
      batchId: "batch-tampered-run",
      sourceImportSha256: HASH_A,
      authority,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    const before = await adapter.loadBatch("batch-tampered-run");
    await seedCandidates(adapter, "import-2");

    await expect(service.runSegment({
      batchId: "batch-tampered-run",
      authority,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    })).rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));

    expect(source.requests).toEqual([]);
    await expect(adapter.loadBatch("batch-tampered-run")).resolves.toEqual(before);
    await expect(adapter.loadActiveOverlays()).resolves.toEqual([]);
  });

  it("durably creates a scoped V4 checkpoint before the first network request", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [],
    }]);
    const { adapter, service } = await harness(source);
    const createBatch = vi.spyOn(adapter, "createBatch");
    let observedDurableV4 = false;
    source.afterPermit = async () => {
      const loaded = await adapter.loadBatch("batch-v4-before-network");
      observedDurableV4 = loaded?.checkpoint.schemaVersion === 4;
    };

    await service.start({
      batchId: "batch-v4-before-network",
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(createBatch).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 4,
      verificationScope: SCOPE,
      legacyCheckpointSha256: null,
      latestReceipt: null,
    }));
    expect(observedDurableV4).toBe(true);
    expect(source.requests).toEqual([{ path: "/Library/Synthetic", start: 0 }]);
  });

  it("rejects a run scope mismatch before network or overlay mutation", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [],
    }]);
    const { adapter, service } = await harness(source);
    await service.prepare({
      batchId: "batch-v4-scope-mismatch",
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    await expect(service.runSegment({
      batchId: "batch-v4-scope-mismatch",
      authority: {
        ...AUTHORITY,
        scope: { ...SCOPE, generation: SCOPE.generation + 1 },
      },
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    expect(source.requests).toEqual([]);
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
  });

  it("publishes only schema-2 overlays and a scope-tagged unified projection", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [file("/Library/Synthetic/A.pdf", "1")],
    }]);
    const { adapter, service } = await harness(source);

    await service.start({
      batchId: "batch-v4-schema-2-projection",
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect((await adapter.loadActiveOverlays(AUTHORITY))[0]?.descriptor).toMatchObject({
      schemaVersion: 2,
      verificationGeneration: SCOPE.generation,
      cloudRootSha256: SCOPE.cloudRootSha256,
    });
    expect((await adapter.loadActiveUnified(AUTHORITY))?.descriptor).toMatchObject({
      schemaVersion: 2,
      verificationScope: SCOPE,
    });
  });

  it("rejects the cloud root before preparing or running a verification batch", async () => {
    const source = new ScriptedSource([]);
    const { adapter, service } = await harness(source);

    await expect(service.prepare({
      batchId: "batch-root-rejected",
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/",
      groups: [selection()],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    await expect(service.start({
      batchId: "batch-root-rejected",
      authority: AUTHORITY,
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
      authority: AUTHORITY,
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
    const result = await service.runSegment({
      batchId: "batch-1",
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    });
    expect(result).toMatchObject({ status: "complete", stopReason: "complete" });
    expect(source.requests).toEqual([{ path: "/Library/Synthetic", start: 0 }]);
  });

  it("prepares a selected group without loading the full candidate catalog", async () => {
    const source = new ScriptedSource([]);
    const { adapter, service } = await harness(source);
    const fullLoad = vi.spyOn(adapter, "loadActiveCandidates")
      .mockRejectedValue(new Error("full-candidate-load-forbidden"));

    await expect(service.prepare({
      batchId: "batch-selected-read",
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    })).resolves.toBeUndefined();

    expect(fullLoad).not.toHaveBeenCalled();
    expect(source.requests).toEqual([]);
    expect((await adapter.loadBatch("batch-selected-read"))?.checkpoint)
      .toMatchObject({ selectedGroupCount: 1, status: "scanning" });
  });

  it("emits aggregate progress only after persisted boundaries", async () => {
    const source = new ScriptedSource([
      { path: "/Library/Synthetic", start: 0, entries: [file("/Library/Synthetic/A.pdf", "1")] },
    ]);
    const { adapter, service } = await harness(source);
    const events: LargeVerificationProgressEvent[] = [];
    const result = await service.start({
      batchId: "batch-events",
      authority: AUTHORITY,
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
      authority: AUTHORITY,
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    await expect(service.runSegment({
      batchId: "batch-root-guard",
      authority: AUTHORITY,
      cloudRoot: "/Different-library",
      allowedGroupKeys: [GROUP],
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    await expect(invariant.service.runSegment({
      batchId: "batch-clock-invariant",
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(result.status).toBe("complete");
    expect(source.requests).toEqual([
      { path: "/Library/Synthetic", start: 0 },
      { path: "/Library/Synthetic/Sub", start: 0 },
    ]);
    expect((await adapter.loadActiveOverlays(AUTHORITY))[0]?.records.map((record) => record.fsId))
      .toEqual(["1", "2"]);
    expect((await adapter.loadActiveUnified(AUTHORITY))?.records.filter((record) => (
      record.topLevelGroupId === GROUP
    )).every((record) => record.verificationStatus === "verified")).toBe(true);
  });

  it("stops before the next saved category when resume allows only the current selection", async () => {
    const source = new ScriptedSource([
      {
        path: "/Library/Synthetic",
        start: 0,
        error: new CatalogError("baidu-rate-limited", true),
      },
      {
        path: "/Library/Synthetic",
        start: 0,
        entries: [],
      },
    ]);
    let now = 100;
    const { adapter, service } = await harness(source, () => now++);
    const first = await service.start({
      batchId: "batch-selected-only",
      authority: AUTHORITY,
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
    expect(first).toMatchObject({ status: "partial", stopReason: "baidu-rate-limited" });

    const resumed = await service.runSegment({
      batchId: "batch-selected-only",
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    });

    expect(resumed).toMatchObject({
      status: "paused",
      stopReason: "selection-limit",
      completedGroupCount: 1,
      currentGroupKey: "txt-root-items",
    });
    expect(source.requests).toEqual([
      { path: "/Library/Synthetic", start: 0 },
      { path: "/Library/Synthetic", start: 0 },
    ]);
    expect((await adapter.loadActiveOverlays(AUTHORITY)).map((overlay) => (
      overlay.descriptor.topLevelGroupId
    ))).toEqual([GROUP]);
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection({
        groupKey: "txt-root-items",
        rootRelativePath: "",
        mode: "direct-files-only",
      })],
    });

    expect(source.requests).toEqual([{ path: "/Library", start: 0 }]);
    expect((await adapter.loadActiveOverlays(AUTHORITY))[0]?.records).toEqual([
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: "paused", stopReason: "user-canceled" });
    expect(source.requests).toEqual([]);
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    expect(first).toMatchObject({ status: "partial", stopReason: "baidu-rate-limited" });
    expect(await service.loadPaused("batch-resume")).toMatchObject({ status: "partial" });
    expect(source.requests).toHaveLength(2);
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);

    const resumed = await service.runSegment({
      batchId: "batch-resume",
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    });
    expect(resumed.status).toBe("complete");
    expect(source.requests).toHaveLength(3);
    expect((await adapter.loadBatch("batch-resume"))?.checkpoint)
      .toMatchObject({ runOrdinal: 2, cumulativeListRequestCount: 3 });
    expect((await adapter.loadActiveOverlays(AUTHORITY))[0]?.records.map((record) => record.fsId))
      .toEqual(["1", "2"]);
  });

  it("canonicalizes reverse multi-error history when persisting the next partial failure", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      error: new CatalogError("baidu-rate-limited", true),
    }]);
    const { adapter, root, service } = await harness(source);
    const checkpoint: LargeCatalogBatchCheckpointV4 = {
      schemaVersion: 4,
      batchId: "batch-error-order",
      verificationScope: SCOPE,
      legacyCheckpointSha256: null,
      latestReceipt: null,
      startedAt: 100,
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
      errorCodeCounts: {
        "hybrid-batch-unavailable": 2,
        "baidu-not-found": 1,
      },
    };
    await adapter.createBatch(checkpoint);

    await expect(service.runSegment({
      batchId: checkpoint.batchId,
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    })).resolves.toMatchObject({ status: "partial", stopReason: "baidu-rate-limited" });

    const reloaded = await new LocalHybridCatalogAdapter(root).loadBatch(checkpoint.batchId);
    expect(reloaded?.checkpoint.errorCodeCounts).toEqual({
      "baidu-not-found": 1,
      "baidu-rate-limited": 1,
      "hybrid-batch-unavailable": 2,
    });
    expect(Object.keys(reloaded?.checkpoint.errorCodeCounts ?? {})).toEqual([
      "baidu-not-found",
      "baidu-rate-limited",
      "hybrid-batch-unavailable",
    ]);
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
      authority: AUTHORITY,
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
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
  });

  it("restores the prior active overlay when unified projection fails", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [file("/Library/Synthetic/A.pdf", "1")],
    }]);
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    vi.spyOn(adapter, "writeUnifiedGroupSnapshot").mockRejectedValue(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
    const service = new LargeCatalogVerificationService({
      source,
      store: adapter,
      reconcile: new CatalogReconciliationService(),
      now: () => 100,
    });

    const result = await service.start({
      batchId: "batch-project-failure",
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });
    expect(result).toMatchObject({ status: "partial", stopReason: "hybrid-snapshot-corrupt" });
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
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
      authority: AUTHORITY,
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
      authority: AUTHORITY,
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
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
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
      authority: AUTHORITY,
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
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    });
    expect(resumed).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      listRequestCount: 1,
      ignoredFileCount: 0,
    });
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    const resumed = await service.runSegment({
      batchId: "batch-resume-directory",
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    });
    expect(resumed).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      directoryCount: 0,
      ignoredFileCount: 0,
    });
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
  });

  it("refuses a legacy V3 batch before network or overlay mutation", async () => {
    const source = new ScriptedSource([{
      path: "/Library/Synthetic",
      start: 0,
      entries: [],
    }]);
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    await seedCandidates(adapter);
    const legacyCheckpoint: LargeCatalogBatchCheckpointV3 = {
      schemaVersion: 3,
      batchId: "batch-legacy-v3",
      sourceImportSha256: HASH_A,
      cloudRootSha256: ROOT_HASH,
      startedAt: 100,
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
    };
    const store = {
      loadActiveCandidateDescriptor: async () => adapter.loadActiveCandidateDescriptor(AUTHORITY),
      loadBatch: async () => ({
        kind: "legacy-v3" as const,
        checkpoint: legacyCheckpoint,
        checkpointSha256: "f".repeat(64),
        records: [],
        identities: [],
        identitiesComplete: true,
      }),
    } as unknown as HybridCatalogStorePort;
    const service = new LargeCatalogVerificationService({
      source,
      store,
      reconcile: new CatalogReconciliationService(),
      now: () => 100,
    });

    await expect(service.runSegment({
      batchId: legacyCheckpoint.batchId,
      authority: AUTHORITY,
      cloudRoot: "/Library",
      allowedGroupKeys: [GROUP],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    expect(source.requests).toEqual([]);
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
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
      now: () => 100,
    });
    await service.start({
      batchId: "batch-refresh",
      authority: AUTHORITY,
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
      authority: AUTHORITY,
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
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toHaveLength(2);
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
      authority: AUTHORITY,
      sourceImportSha256: HASH_A,
      cloudRoot: "/Library",
      groups: [selection()],
    });

    expect(result).toMatchObject({ status: "paused", stopReason: "time-limit" });
    expect((await adapter.loadBatch("batch-time"))?.records).toEqual([]);
    expect(await adapter.loadActiveOverlays(AUTHORITY)).toEqual([]);
  });

  // Each permit intentionally persists an A/B checkpoint and pointer before transport.
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
      now: () => 100,
    });
    const result = await service.start({
      batchId: "batch-request-limit",
      authority: AUTHORITY,
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
  }, 20_000);
});
