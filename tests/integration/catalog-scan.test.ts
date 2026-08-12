import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCatalogSnapshotAdapter } from "../../src/adapters/local-catalog-snapshot-adapter";
import type { BaiduCatalogSourcePort } from "../../src/catalog/catalog-ports";
import { CatalogScanService } from "../../src/catalog/catalog-scan-service";
import {
  CatalogError,
  type BaiduListEntry,
  type CatalogScanBudget,
  type CatalogScanCheckpointV1,
  type CatalogScanProgress,
} from "../../src/catalog/catalog-types";

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-scan-")));
  roots.push(root);
  return root;
};

const fileEntry = (path: string, fsId: string): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 7,
  serverModifiedAt: 11,
  isDirectory: false,
});

const directoryEntry = (path: string, fsId: string): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 0,
  serverModifiedAt: 11,
  isDirectory: true,
});

const budget = (overrides: Partial<CatalogScanBudget> = {}): CatalogScanBudget => ({
  maxPdfCount: 1_000,
  maxDirectoryCount: 20,
  maxListRequestCount: 25,
  maxDurationMs: 120_000,
  ...overrides,
});

type ListInput = Readonly<{
  path: string;
  start: number;
  limit: 1000;
  beforeRequest: () => Promise<void>;
}>;

class ScriptedSource implements BaiduCatalogSourcePort {
  readonly calls: Array<Readonly<{ path: string; start: number; limit: 1000 }>> = [];
  maximumConcurrentCalls = 0;
  private activeCalls = 0;

  constructor(
    private readonly respond: (
      input: Readonly<{ path: string; start: number; limit: 1000 }>,
    ) => Promise<readonly BaiduListEntry[]> | readonly BaiduListEntry[],
    private readonly afterPermit?: () => void,
  ) {}

  async listDirectory(input: ListInput): Promise<Readonly<{ entries: readonly BaiduListEntry[] }>> {
    await input.beforeRequest();
    this.afterPermit?.();
    this.calls.push({ path: input.path, start: input.start, limit: input.limit });
    this.activeCalls += 1;
    this.maximumConcurrentCalls = Math.max(this.maximumConcurrentCalls, this.activeCalls);
    try {
      return { entries: await this.respond(input) };
    } finally {
      this.activeCalls -= 1;
    }
  }
}

class ManualClock {
  value = 0;
  readonly now = (): number => this.value;
}

const sequenceClock = (...values: number[]): (() => number) => {
  let last = values.at(-1) ?? 0;
  return () => {
    const next = values.shift();
    if (next !== undefined) last = next;
    return last;
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const service = (
  source: BaiduCatalogSourcePort,
  snapshots: LocalCatalogSnapshotAdapter,
  options: Readonly<{ scanBudget?: CatalogScanBudget; now?: () => number }> = {},
): CatalogScanService => new CatalogScanService(source, snapshots, {
  budget: options.scanBudget ?? budget(),
  now: options.now ?? (() => 0),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CatalogScanService", () => {
  it("scans one directory at a time in breadth-first order and finalizes once complete", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(({ path }) => path === "/样本"
      ? [fileEntry("/样本/A.pdf", "1"), directoryEntry("/样本/子目录", "2")]
      : [fileEntry("/样本/子目录/B.PDF", "3")]);
    const progress: number[] = [];

    const result = await service(source, snapshots).scan({
      scanId: "scan-1",
      rootPath: "/样本",
      onProgress: (value) => progress.push(value.pdfCount),
    });

    expect(source.calls).toEqual([
      { path: "/样本", start: 0, limit: 1000 },
      { path: "/样本/子目录", start: 0, limit: 1000 },
    ]);
    expect(source.maximumConcurrentCalls).toBe(1);
    expect(result).toMatchObject({
      status: "complete",
      stopReason: "complete",
      descriptor: { pdfCount: 2, recordCount: 3 },
      progress: { status: "complete", pdfCount: 2, listRequestCount: 2 },
    });
    expect((await snapshots.loadActive())?.descriptor.pdfCount).toBe(2);
    expect((await snapshots.loadReceipt("scan-1"))?.schemaVersion).toBe(2);
    expect(progress).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("pauses before a second transport when the list request budget is exhausted", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [directoryEntry("/样本/子目录", "1")]);

    const result = await service(source, snapshots, {
      scanBudget: budget({ maxListRequestCount: 1 }),
    }).scan({ scanId: "scan-request-limit", rootPath: "/样本" });

    expect(source.calls).toEqual([{ path: "/样本", start: 0, limit: 1000 }]);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "list-request-limit",
      progress: { listRequestCount: 1, directoryCount: 1 },
    });
    expect(await snapshots.loadReceipt("scan-request-limit")).toMatchObject({
      status: "paused",
      stopReason: "list-request-limit",
      listRequestCount: 1,
      directoryCount: 1,
      downloadedPdfBytes: 0,
    });
  });

  it("allows the maximum permitted request to prove an empty queue complete", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => []);

    const result = await service(source, snapshots, {
      scanBudget: budget({ maxListRequestCount: 1 }),
    }).scan({ scanId: "scan-last-request", rootPath: "/样本" });

    expect(source.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "complete",
      stopReason: "complete",
      progress: { listRequestCount: 1 },
    });
  });

  it("discards a whole page that would exceed the PDF budget", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [
      fileEntry("/synthetic-small-folder/A.pdf", "1"),
      fileEntry("/synthetic-small-folder/B.pdf", "2"),
    ]);

    const result = await service(source, snapshots, {
      scanBudget: budget({ maxPdfCount: 1 }),
    }).scan({
      scanId: "scan-pdf-overflow",
      rootPath: "/synthetic-small-folder",
    });

    expect(source.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "pdf-limit",
      progress: { pdfCount: 0, listRequestCount: 1 },
    });
    expect((await snapshots.loadScan("scan-pdf-overflow"))?.records).toEqual([]);
    expect(await snapshots.loadReceipt("scan-pdf-overflow")).toMatchObject({
      status: "paused",
      stopReason: "pdf-limit",
      pdfCount: 0,
      listRequestCount: 1,
      downloadedPdfBytes: 0,
    });
    expect(await snapshots.loadActive()).toBeNull();
  });

  it("discards a whole page that would exceed the directory budget", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [
      directoryEntry("/样本/A", "1"),
      directoryEntry("/样本/B", "2"),
    ]);

    const result = await service(source, snapshots, {
      scanBudget: budget({ maxDirectoryCount: 1 }),
    }).scan({ scanId: "scan-directory-overflow", rootPath: "/样本" });

    expect(result).toMatchObject({
      status: "paused",
      stopReason: "directory-limit",
      progress: { directoryCount: 0, listRequestCount: 1 },
    });
    expect((await snapshots.loadScan("scan-directory-overflow"))?.records).toEqual([]);
  });

  it("completes when the exact PDF cap leaves no pending work", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [fileEntry("/样本/A.pdf", "1")]);

    const result = await service(source, snapshots, {
      scanBudget: budget({ maxPdfCount: 1 }),
    }).scan({ scanId: "scan-exact-pdf-complete", rootPath: "/样本" });

    expect(result).toMatchObject({
      status: "complete",
      stopReason: "complete",
      progress: { pdfCount: 1, listRequestCount: 1 },
    });
  });

  it("pauses at the exact PDF cap when child work remains", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [
      fileEntry("/样本/A.pdf", "1"),
      directoryEntry("/样本/子目录", "2"),
    ]);

    const result = await service(source, snapshots, {
      scanBudget: budget({ maxPdfCount: 1 }),
    }).scan({ scanId: "scan-exact-pdf-paused", rootPath: "/样本" });

    expect(source.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "pdf-limit",
      progress: { pdfCount: 1, directoryCount: 1, listRequestCount: 1 },
    });
  });

  it("pauses before transport when the time budget is reached", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => []);

    const result = await service(source, snapshots, {
      now: sequenceClock(0, 0, 120),
      scanBudget: budget({ maxDurationMs: 120 }),
    }).scan({ scanId: "scan-time-before", rootPath: "/样本" });

    expect(source.calls).toEqual([]);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "time-limit",
      progress: { listRequestCount: 0, elapsedMs: 120 },
    });
  });

  it("discards a response page when time expires during transport", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const clock = new ManualClock();
    const source = new ScriptedSource(() => {
      clock.value = 120;
      return [fileEntry("/样本/A.pdf", "1")];
    });

    const result = await service(source, snapshots, {
      now: clock.now,
      scanBudget: budget({ maxDurationMs: 120 }),
    }).scan({ scanId: "scan-time-after", rootPath: "/样本" });

    expect(source.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "time-limit",
      progress: { pdfCount: 0, listRequestCount: 1, elapsedMs: 120 },
    });
    expect((await snapshots.loadScan("scan-time-after"))?.records).toEqual([]);
  });

  it("cancels before a request with a paused aggregate receipt", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => []);
    const controller = new AbortController();
    controller.abort();

    const result = await service(source, snapshots).scan({
      scanId: "scan-cancel-before",
      rootPath: "/样本",
      signal: controller.signal,
    });

    expect(source.calls).toEqual([]);
    expect(result).toMatchObject({ status: "paused", stopReason: "user-canceled" });
    expect(await snapshots.loadReceipt("scan-cancel-before")).toMatchObject({
      status: "paused",
      stopReason: "user-canceled",
      listRequestCount: 0,
    });
  });

  it("waits for an in-flight response, then discards it after cancellation", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const response = deferred<readonly BaiduListEntry[]>();
    const started = deferred<void>();
    const source = new ScriptedSource(() => {
      started.resolve();
      return response.promise;
    });
    const controller = new AbortController();

    const running = service(source, snapshots).scan({
      scanId: "scan-cancel-during",
      rootPath: "/样本",
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    response.resolve([fileEntry("/样本/A.pdf", "1")]);
    const result = await running;

    expect(source.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "user-canceled",
      progress: { pdfCount: 0, listRequestCount: 1 },
    });
    expect((await snapshots.loadScan("scan-cancel-during"))?.records).toEqual([]);
  });

  it("pauses on one counted rate-limit error without retrying or sleeping", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => {
      throw new CatalogError("baidu-rate-limited", true);
    });

    const result = await service(source, snapshots).scan({
      scanId: "scan-rate-limit",
      rootPath: "/样本",
    });

    expect(source.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "baidu-rate-limited",
      errorCode: "baidu-rate-limited",
      progress: { listRequestCount: 1 },
    });
    expect(await snapshots.loadReceipt("scan-rate-limit")).toMatchObject({
      retryCount: 1,
      errorCodeCounts: { "baidu-rate-limited": 1 },
      listRequestCount: 1,
    });
  });

  it("keeps a counted fixed source failure partial and never promotes it", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => {
      throw new CatalogError("baidu-permission-denied");
    });

    const result = await service(source, snapshots).scan({
      scanId: "scan-partial",
      rootPath: "/样本",
    });

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "baidu-permission-denied",
      errorCode: "baidu-permission-denied",
      progress: { listRequestCount: 1 },
    });
    expect(await snapshots.loadReceipt("scan-partial")).toMatchObject({
      status: "partial",
      stopReason: "baidu-permission-denied",
      errorCodeCounts: { "baidu-permission-denied": 1 },
    });
    expect(await snapshots.loadActive()).toBeNull();
  });

  it("leaves only a nonterminal checkpoint when execution exits after permit persistence", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const exit = new Error("synthetic-process-exit");
    const source = new ScriptedSource(() => [], () => { throw exit; });

    await expect(service(source, snapshots).scan({
      scanId: "scan-crash-window",
      rootPath: "/样本",
    })).rejects.toBe(exit);

    expect(source.calls).toEqual([]);
    expect((await snapshots.loadScan("scan-crash-window"))?.checkpoint).toMatchObject({
      schemaVersion: 2,
      status: "scanning",
      listRequestCount: 1,
    });
    expect(await snapshots.loadReceipt("scan-crash-window")).toBeNull();
  });

  it("publishes aggregate-only progress without a root or filename", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [fileEntry("/synthetic-private/A.pdf", "1")]);
    const progress: CatalogScanProgress[] = [];

    await service(source, snapshots).scan({
      scanId: "scan-progress",
      rootPath: "/synthetic-private",
      onProgress: (value) => progress.push(structuredClone(value)),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(JSON.stringify(progress)).not.toContain("synthetic-private");
    expect(JSON.stringify(progress)).not.toContain("A.pdf");
    expect(Object.keys(progress.at(-1)!).sort()).toEqual([
      "budget",
      "completedDirectoryCount",
      "directoryCount",
      "elapsedMs",
      "ignoredFileCount",
      "listRequestCount",
      "pdfCount",
      "pendingDirectoryCount",
      "status",
      "stopReason",
    ]);
  });

  it("counts ignored non-PDF files without storing them", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [
      fileEntry("/样本/A.pdf", "1"),
      fileEntry("/样本/notes.txt", "2"),
    ]);

    await service(source, snapshots).scan({ scanId: "scan-ignored", rootPath: "/样本" });

    expect((await snapshots.loadScan("scan-ignored"))?.checkpoint).toMatchObject({
      pdfCount: 1,
      ignoredFileCount: 1,
    });
    expect((await snapshots.loadActive())?.records.map((record) => record.path)).toEqual(["/样本/A.pdf"]);
  });

  it("records duplicate identifiers as an invalid partial response before committing the page", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [
      fileEntry("/样本/A.pdf", "1"),
      fileEntry("/样本/B.pdf", "1"),
    ]);

    const result = await service(source, snapshots).scan({
      scanId: "scan-duplicate",
      rootPath: "/样本",
    });

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      errorCode: "invalid-baidu-response",
    });
    expect((await snapshots.loadScan("scan-duplicate"))?.records).toEqual([]);
    expect(await snapshots.loadReceipt("scan-duplicate")).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
    });
    expect(await snapshots.loadActive()).toBeNull();
  });

  it("rejects an identifier repeated on a later page and writes a terminal receipt", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const firstPage = [
      fileEntry("/样本/A.pdf", "1"),
      ...Array.from({ length: 999 }, (_, index) => fileEntry(
        `/样本/Ignored-${String(index).padStart(3, "0")}.txt`,
        String(index + 2),
      )),
    ];
    const source = new ScriptedSource(({ start }) => start === 0
      ? firstPage
      : [fileEntry("/样本/B.pdf", "1")]);

    const result = await service(source, snapshots).scan({
      scanId: "scan-cross-page-duplicate",
      rootPath: "/样本",
    });

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      errorCode: "invalid-baidu-response",
      progress: { pdfCount: 1, ignoredFileCount: 999, listRequestCount: 2 },
    });
    expect((await snapshots.loadScan("scan-cross-page-duplicate"))?.records)
      .toEqual([expect.objectContaining({ fsId: "1", path: "/样本/A.pdf" })]);
    expect(await snapshots.loadReceipt("scan-cross-page-duplicate")).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      listRequestCount: 2,
    });
    expect(await snapshots.loadActive()).toBeNull();
  });

  it("marks an out-of-directory source entry as an invalid partial response", async () => {
    const snapshots = new LocalCatalogSnapshotAdapter(await temporaryRoot());
    const source = new ScriptedSource(() => [fileEntry("/别处/A.pdf", "1")]);

    const result = await service(source, snapshots).scan({
      scanId: "scan-invalid-response",
      rootPath: "/样本",
    });

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "invalid-baidu-response",
      errorCode: "invalid-baidu-response",
    });
    expect(await snapshots.loadActive()).toBeNull();
  });

  it("rejects every pre-existing scan ID without rewriting its v1 checkpoint", async () => {
    const root = await temporaryRoot();
    const snapshots = new LocalCatalogSnapshotAdapter(root);
    const existing: CatalogScanCheckpointV1 = {
      schemaVersion: 1,
      scanId: "scan-existing",
      rootPath: "/legacy",
      startedAt: 1,
      pending: [{ path: "/legacy", start: 0 }],
      committedPageKeys: [],
      completedDirectoryCount: 0,
      directoryCount: 0,
      pdfCount: 0,
      ignoredFileCount: 0,
      errorCodeCounts: {},
      retryCount: 0,
      status: "paused",
    };
    await snapshots.createScan(existing);
    const checkpointPath = join(root, "scans", existing.scanId, "checkpoint.json");
    const before = await readFile(checkpointPath);
    const source = new ScriptedSource(() => []);

    await expect(service(source, snapshots).scan({
      scanId: existing.scanId,
      rootPath: existing.rootPath,
    })).rejects.toMatchObject({ code: "snapshot-corrupt" });

    expect(source.calls).toEqual([]);
    expect(await readFile(checkpointPath)).toEqual(before);
    expect(await snapshots.loadReceipt(existing.scanId)).toBeNull();
  });
});
