import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalCatalogSnapshotAdapter,
  type AtomicRenamePort,
} from "../../../src/adapters/local-catalog-snapshot-adapter";
import type {
  CatalogScanCheckpoint,
  CatalogScanCheckpointV2,
  CloudCatalogRecord,
} from "../../../src/catalog/catalog-types";
import {
  CatalogError,
  SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
} from "../../../src/catalog/catalog-types";

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-catalog-")));
  roots.push(root);
  return root;
};

const checkpoint = (rootPath: string, scanId = "scan-1"): CatalogScanCheckpoint => ({
  schemaVersion: 1,
  scanId,
  rootPath,
  startedAt: 1,
  pending: [{ path: rootPath, start: 0 }],
  committedPageKeys: [],
  completedDirectoryCount: 0,
  directoryCount: 0,
  pdfCount: 0,
  ignoredFileCount: 0,
  errorCodeCounts: {},
  retryCount: 0,
  status: "scanning",
});

const checkpointV2 = (
  rootPath: string,
  scanId = "scan-v2",
): CatalogScanCheckpointV2 => ({
  schemaVersion: 2,
  scanId,
  rootPath,
  startedAt: 10,
  budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
  listRequestCount: 0,
  pending: [{ path: rootPath, start: 0 }],
  committedPageKeys: [],
  completedDirectoryCount: 0,
  directoryCount: 0,
  pdfCount: 0,
  ignoredFileCount: 0,
  errorCodeCounts: {},
  retryCount: 0,
  status: "scanning",
  pauseReason: null,
});

const pdfRecord = (
  path: string,
  fsId = "1",
): CloudCatalogRecord => {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return {
    schemaVersion: 1,
    source: "baidu-netdisk",
    fsId,
    kind: "file",
    path,
    parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
    filename,
    extension: "pdf",
    title: filename.slice(0, -4),
    isbnCandidates: [],
    sizeBytes: 7,
    serverModifiedAt: 11,
  };
};

const committed = (
  initial: CatalogScanCheckpoint,
  pageKey: string,
  pdfCount = 1,
): CatalogScanCheckpoint => ({
  ...initial,
  pending: [],
  committedPageKeys: [pageKey],
  completedDirectoryCount: 1,
  pdfCount,
});

const committedV2 = (
  initial: CatalogScanCheckpointV2,
  pageKey: string,
  pdfCount = 1,
): CatalogScanCheckpointV2 => ({
  ...initial,
  pending: [],
  committedPageKeys: [pageKey],
  completedDirectoryCount: 1,
  pdfCount,
});

class ScriptedRenamePort implements AtomicRenamePort {
  private suffix: string | null = null;

  failNextDestination(suffix: string): void {
    this.suffix = suffix;
  }

  async rename(source: string, destination: string): Promise<void> {
    if (this.suffix !== null && destination.endsWith(this.suffix)) {
      this.suffix = null;
      throw new Error("injected-rename-failure");
    }
    await rename(source, destination);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalCatalogSnapshotAdapter", () => {
  it("persists one monotonic list permit before terminal receipt creation", async () => {
    const adapter = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const initial = checkpointV2("/synthetic-small-folder");
    await adapter.createScan(initial);
    await adapter.saveScanState({ ...initial, listRequestCount: 1 });
    await expect(adapter.saveScanState(initial)).rejects.toMatchObject({ code: "snapshot-corrupt" });
    await expect(adapter.saveScanState({
      ...initial,
      listRequestCount: 2,
      budget: { ...initial.budget, maxPdfCount: 70_000 },
    })).rejects.toMatchObject({ code: "snapshot-corrupt" });
  });

  it("writes one strict aggregate paused receipt without replacing active", async () => {
    const adapter = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const initial = checkpointV2("/synthetic-small-folder");
    await adapter.createScan(initial);
    let permitted = initial;
    for (let listRequestCount = 1; listRequestCount <= 25; listRequestCount += 1) {
      permitted = { ...permitted, listRequestCount };
      await adapter.saveScanState(permitted);
    }
    const result = await adapter.finalizeScan({
      checkpoint: {
        ...permitted,
        status: "paused",
        pauseReason: "list-request-limit",
      },
      status: "paused",
      stopReason: "list-request-limit",
      endedAt: 110,
    });

    expect(result).toEqual({
      receipt: {
        schemaVersion: 2,
        status: "paused",
        stopReason: "list-request-limit",
        startedAt: 10,
        endedAt: 110,
        durationMs: 100,
        budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
        listRequestCount: 25,
        directoryCount: 0,
        pdfCount: 0,
        ignoredFileCount: 0,
        downloadedPdfBytes: 0,
        errorCodeCounts: {},
        retryCount: 0,
        snapshotSha256: null,
      },
    });
    await expect(adapter.finalizeScan({
      checkpoint: {
        ...permitted,
        status: "paused",
        pauseReason: "list-request-limit",
      },
      status: "paused",
      stopReason: "list-request-limit",
      endedAt: 110,
    })).resolves.toEqual(result);
    expect(await adapter.loadReceipt(initial.scanId)).toEqual(result.receipt);
    expect(await adapter.loadActive()).toBeNull();
  });

  it("finalizes a complete v2 scan with one strict receipt and active descriptor", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const initial = checkpointV2("/synthetic-small-folder", "scan-v2-complete");
    const pageKey = "8".repeat(64);
    const record = pdfRecord("/synthetic-small-folder/A.pdf");
    const next = committedV2(initial, pageKey);
    await adapter.createScan(initial);
    await adapter.commitPage({
      scanId: initial.scanId,
      pageKey,
      records: [record],
      nextCheckpoint: next,
    });

    const finalized = await adapter.finalizeScan({
      checkpoint: next,
      status: "complete",
      stopReason: "complete",
      endedAt: 110,
    });

    expect(finalized.descriptor).toMatchObject({
      snapshotId: initial.scanId,
      completedAt: 110,
      recordCount: 1,
      pdfCount: 1,
    });
    expect(finalized.receipt).toMatchObject({
      schemaVersion: 2,
      status: "complete",
      stopReason: "complete",
      durationMs: 100,
      listRequestCount: 0,
      pdfCount: 1,
      downloadedPdfBytes: 0,
    });
    expect(finalized.receipt.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(finalized.receipt.snapshotSha256).toBe(finalized.descriptor?.sha256);
    expect((await adapter.loadActive())?.records).toEqual([record]);
    expect((await stat(join(root, "scans", initial.scanId, "receipt.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the prior active descriptor unchanged for paused and partial v2 scans", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const active = checkpoint("/legacy", "scan-active");
    const activeKey = "9".repeat(64);
    await adapter.createScan(active);
    await adapter.commitPage({
      scanId: active.scanId,
      pageKey: activeKey,
      records: [pdfRecord("/legacy/A.pdf")],
      nextCheckpoint: committed(active, activeKey),
    });
    await adapter.promoteScan(active.scanId, 100);
    const activeBefore = await readFile(join(root, "active.json"));

    const paused = checkpointV2("/synthetic-paused", "scan-v2-paused");
    await adapter.createScan(paused);
    await adapter.finalizeScan({
      checkpoint: { ...paused, status: "paused", pauseReason: "time-limit" },
      status: "paused",
      stopReason: "time-limit",
      endedAt: 20,
    });
    expect(await readFile(join(root, "active.json"))).toEqual(activeBefore);

    const partial = checkpointV2("/synthetic-partial", "scan-v2-partial");
    await adapter.createScan(partial);
    await adapter.finalizeScan({
      checkpoint: {
        ...partial,
        status: "partial",
        errorCodeCounts: { "baidu-permission-denied": 1 },
      },
      status: "partial",
      stopReason: "baidu-permission-denied",
      endedAt: 30,
    });
    expect(await readFile(join(root, "active.json"))).toEqual(activeBefore);
    expect((await adapter.loadActive())?.descriptor.snapshotId).toBe(active.scanId);
  });

  it("rejects a receipt containing a cloud path or any unknown key", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const initial = checkpointV2("/synthetic-small-folder", "scan-v2-private");
    await adapter.createScan(initial);
    await adapter.finalizeScan({
      checkpoint: { ...initial, status: "paused", pauseReason: "user-canceled" },
      status: "paused",
      stopReason: "user-canceled",
      endedAt: 20,
    });
    const receiptPath = join(root, "scans", initial.scanId, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await writeFile(receiptPath, `${JSON.stringify({
      ...receipt,
      rootPath: "/must-not-survive",
    })}\n`);

    await expect(new LocalCatalogSnapshotAdapter(root).loadReceipt(initial.scanId))
      .rejects.toMatchObject({ code: "snapshot-corrupt" });
  });

  it("preserves a legacy v1 checkpoint byte-for-byte while finalizing a different v2 scan", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const legacy = checkpoint("/legacy", "scan-legacy");
    await adapter.createScan(legacy);
    const legacyPath = join(root, "scans", legacy.scanId, "checkpoint.json");
    const before = await readFile(legacyPath);

    const current = checkpointV2("/synthetic-small-folder", "scan-v2-separate");
    await adapter.createScan(current);
    await adapter.finalizeScan({
      checkpoint: { ...current, status: "paused", pauseReason: "user-canceled" },
      status: "paused",
      stopReason: "user-canceled",
      endedAt: 20,
    });

    expect((await adapter.loadScan(legacy.scanId))?.checkpoint).toEqual(legacy);
    expect(await readFile(legacyPath)).toEqual(before);
  });

  it("promotes a validated snapshot outside the Vault with private permissions", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const initial = checkpoint("/样本");
    const pageKey = "0".repeat(64);
    const record = pdfRecord("/样本/A.pdf");

    await adapter.createScan(initial);
    await adapter.commitPage({
      scanId: initial.scanId,
      pageKey,
      records: [record],
      nextCheckpoint: committed(initial, pageKey),
    });
    const promoted = await adapter.promoteScan(initial.scanId, 100);

    expect(promoted).toMatchObject({
      snapshotId: "scan-1",
      schemaVersion: 1,
      completedAt: 100,
      recordCount: 1,
      pdfCount: 1,
    });
    expect(promoted.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await adapter.loadActive())?.records).toEqual([record]);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "active.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "snapshots", "scan-1", "catalog.ndjson"))).mode & 0o777).toBe(0o600);
  });

  it("ignores an orphan page when the page-state rename fails, then retries safely", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    const adapter = new LocalCatalogSnapshotAdapter(root, renames);
    const initial = checkpoint("/样本");
    const pageKey = "1".repeat(64);
    const input = {
      scanId: initial.scanId,
      pageKey,
      records: [pdfRecord("/样本/A.pdf")],
      nextCheckpoint: committed(initial, pageKey),
    } as const;
    await adapter.createScan(initial);

    renames.failNextDestination(`${pageKey}.state.json`);
    await expect(adapter.commitPage(input)).rejects.toThrow("injected-rename-failure");
    expect(await adapter.loadScan(initial.scanId)).toEqual({ checkpoint: initial, records: [] });

    await adapter.commitPage(input);
    expect((await adapter.loadScan(initial.scanId))?.checkpoint).toEqual(input.nextCheckpoint);
  });

  it("recovers a committed page when the checkpoint rename fails", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    const adapter = new LocalCatalogSnapshotAdapter(root, renames);
    const initial = checkpoint("/样本");
    const pageKey = "2".repeat(64);
    const record = pdfRecord("/样本/A.pdf");
    const nextCheckpoint = committed(initial, pageKey);
    await adapter.createScan(initial);

    renames.failNextDestination("checkpoint.json");
    await expect(adapter.commitPage({
      scanId: initial.scanId,
      pageKey,
      records: [record],
      nextCheckpoint,
    })).rejects.toThrow("injected-rename-failure");

    expect(await new LocalCatalogSnapshotAdapter(root).loadScan(initial.scanId)).toEqual({
      checkpoint: nextCheckpoint,
      records: [record],
    });
  });

  it("keeps the previous active snapshot byte-for-byte when active promotion fails", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    const adapter = new LocalCatalogSnapshotAdapter(root, renames);
    const first = checkpoint("/样本", "scan-1");
    const firstKey = "3".repeat(64);
    await adapter.createScan(first);
    await adapter.commitPage({
      scanId: first.scanId,
      pageKey: firstKey,
      records: [pdfRecord("/样本/A.pdf", "1")],
      nextCheckpoint: committed(first, firstKey),
    });
    await adapter.promoteScan(first.scanId, 100);
    const activeBefore = await readFile(join(root, "active.json"));

    const second = checkpoint("/样本", "scan-2");
    const secondKey = "4".repeat(64);
    await adapter.createScan(second);
    await adapter.commitPage({
      scanId: second.scanId,
      pageKey: secondKey,
      records: [pdfRecord("/样本/B.pdf", "2")],
      nextCheckpoint: committed(second, secondKey),
    });
    renames.failNextDestination("active.json");
    await expect(adapter.promoteScan(second.scanId, 200)).rejects.toThrow("injected-rename-failure");

    expect(await readFile(join(root, "active.json"))).toEqual(activeBefore);
    expect((await adapter.loadActive())?.descriptor.snapshotId).toBe("scan-1");
  });

  it("makes identical page commits idempotent and rejects conflicting reuse", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const initial = checkpoint("/样本");
    const pageKey = "5".repeat(64);
    const nextCheckpoint = committed(initial, pageKey);
    const input = {
      scanId: initial.scanId,
      pageKey,
      records: [pdfRecord("/样本/A.pdf")],
      nextCheckpoint,
    } as const;
    await adapter.createScan(initial);
    await adapter.commitPage(input);
    await adapter.commitPage(input);

    await expect(adapter.commitPage({
      ...input,
      records: [pdfRecord("/样本/B.pdf")],
    })).rejects.toMatchObject({ code: "snapshot-corrupt" });
  });

  it("allows only status, retry, and error counters in saveScanState", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const initial = checkpoint("/样本");
    await adapter.createScan(initial);
    const paused: CatalogScanCheckpoint = {
      ...initial,
      status: "paused",
      retryCount: 1,
      errorCodeCounts: { "baidu-rate-limited": 1 },
    };

    await adapter.saveScanState(paused);
    expect((await adapter.loadScan(initial.scanId))?.checkpoint).toEqual(paused);
    await expect(adapter.saveScanState({
      ...paused,
      pending: [],
    })).rejects.toMatchObject({ code: "snapshot-corrupt" });
  });

  it.each([
    {
      name: "duplicate fs_id",
      records: [pdfRecord("/样本/A.pdf", "1"), pdfRecord("/样本/B.pdf", "1")],
    },
    {
      name: "duplicate path",
      records: [pdfRecord("/样本/A.pdf", "1"), pdfRecord("/样本/A.pdf", "2")],
    },
    {
      name: "mismatched parent",
      records: [{ ...pdfRecord("/样本/A.pdf", "1"), parentPath: "/错误" }],
    },
  ])("rejects $name during promotion", async ({ records }) => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const initial = checkpoint("/样本");
    const pageKey = "6".repeat(64);
    await adapter.createScan(initial);
    await adapter.commitPage({
      scanId: initial.scanId,
      pageKey,
      records,
      nextCheckpoint: committed(initial, pageKey, records.length),
    });

    await expect(adapter.promoteScan(initial.scanId, 100)).rejects.toMatchObject({ code: "snapshot-corrupt" });
    expect(await adapter.loadActive()).toBeNull();
  });

  it("detects active NDJSON corruption without retaining its contents", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalCatalogSnapshotAdapter(root);
    const initial = checkpoint("/样本");
    const pageKey = "7".repeat(64);
    await adapter.createScan(initial);
    await adapter.commitPage({
      scanId: initial.scanId,
      pageKey,
      records: [pdfRecord("/样本/A.pdf")],
      nextCheckpoint: committed(initial, pageKey),
    });
    const descriptor = await adapter.promoteScan(initial.scanId, 100);
    await writeFile(
      join(root, "snapshots", descriptor.snapshotId, "catalog.ndjson"),
      "secret-corrupt-line\n",
      { mode: 0o600 },
    );

    try {
      await adapter.loadActive();
      throw new Error("expected loadActive to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect(error).toMatchObject({ code: "snapshot-corrupt", message: "snapshot-corrupt" });
      expect((error as Error).message).not.toContain("secret-corrupt-line");
    }
  });

  it("rejects a symlinked root instead of following it", async () => {
    const parent = await temporaryRoot();
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    await symlink(parent, linked);

    await expect(new LocalCatalogSnapshotAdapter(linked).createScan(checkpoint("/样本")))
      .rejects.toMatchObject({ code: "snapshot-corrupt" });
    await expect(new LocalCatalogSnapshotAdapter(target).createScan(checkpoint("/样本")))
      .resolves.toBeUndefined();
    await chmod(target, 0o700);
  });

  it("rejects a symlinked storage directory instead of writing through it", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, "scans"));

    await expect(new LocalCatalogSnapshotAdapter(root).createScan(checkpoint("/样本")))
      .rejects.toMatchObject({ code: "snapshot-corrupt" });
    await expect(stat(join(outside, "scan-1", "checkpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
