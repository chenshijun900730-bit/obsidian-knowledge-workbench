import { describe, expect, it } from "vitest";
import {
  CLOUD_DIRECTORY_DISCOVERY_BUDGET,
  CloudDirectoryDiscoveryService,
  type CloudDirectoryDiscoveryRuntime,
} from "../../../src/catalog/cloud-directory-discovery-service";
import { CloudCatalogRuntimeService } from "../../../src/catalog/cloud-catalog-runtime";
import type {
  BaiduCatalogSourcePort,
  CatalogSnapshotPort,
} from "../../../src/catalog/catalog-ports";
import { CatalogError, type BaiduListEntry } from "../../../src/catalog/catalog-types";

const directory = (
  fsId: string,
  path: string,
): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 0,
  serverModifiedAt: 1,
  isDirectory: true,
});

const file = (
  fsId: string,
  path: string,
): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 10,
  serverModifiedAt: 1,
  isDirectory: false,
});

const sourceFrom = (
  listDirectory: BaiduCatalogSourcePort["listDirectory"],
): BaiduCatalogSourcePort => ({ listDirectory });

const emptySnapshots = (): CatalogSnapshotPort => ({
  createScan: async () => undefined,
  commitPage: async () => undefined,
  loadScan: async () => null,
  saveScanState: async () => undefined,
  finalizeScan: async () => ({ receipt: {
    schemaVersion: 2,
    status: "complete",
    stopReason: "complete",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    budget: {
      maxPdfCount: 1,
      maxDirectoryCount: 1,
      maxListRequestCount: 1,
      maxDurationMs: 1,
    },
    listRequestCount: 0,
    directoryCount: 0,
    pdfCount: 0,
    ignoredFileCount: 0,
    downloadedPdfBytes: 0,
    errorCodeCounts: {},
    retryCount: 0,
    snapshotSha256: null,
  } }),
  loadReceipt: async () => null,
  promoteScan: async () => ({
    snapshotId: "synthetic",
    schemaVersion: 1,
    completedAt: 0,
    recordCount: 0,
    pdfCount: 0,
    sha256: "0".repeat(64),
  }),
  loadActive: async () => null,
});

describe("cloud directory discovery service", () => {
  it("freezes the fixed discovery budget", () => {
    expect(CLOUD_DIRECTORY_DISCOVERY_BUDGET).toEqual({
      maxDirectoryCount: 500,
      maxListRequestCount: 300,
      maxDurationMs: 1_800_000,
    });
    expect(Object.isFrozen(CLOUD_DIRECTORY_DISCOVERY_BUDGET)).toBe(true);
  });

  it("searches only the session cache and issues zero source calls", () => {
    let sourceCalls = 0;
    const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async () => {
      sourceCalls += 1;
      return { entries: [] };
    }));

    expect(discovery.searchCached("literature")).toEqual([]);
    expect(discovery.snapshotCached()).toEqual([]);
    expect(sourceCalls).toBe(0);
  });

  it("rejects root and malformed paths before calling the source", async () => {
    let sourceCalls = 0;
    const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async () => {
      sourceCalls += 1;
      return { entries: [] };
    }));

    for (const rootPath of ["/", "Synthetic", "/Synthetic//Child", "/Synthetic/../Child", "/Synthetic\\Child"]) {
      await expect(discovery.discoverMore(rootPath)).rejects.toEqual(
        new CatalogError("invalid-scan-root"),
      );
    }
    expect(sourceCalls).toBe(0);
  });

  it("counts every beforeRequest permit including a refresh replay", async () => {
    let sourceCalls = 0;
    const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      sourceCalls += 1;
      await input.beforeRequest();
      await input.beforeRequest();
      return { entries: [] };
    }));

    const summary = await discovery.discoverMore("/Synthetic");
    expect(summary).toMatchObject({
      status: "complete",
      stopReason: "complete",
      rootPath: "/Synthetic",
      directoryCount: 0,
      listRequestCount: 2,
    });
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(sourceCalls).toBe(1);
  });

  it("traverses complete pages breadth-first and caches only directories", async () => {
    const calls: Array<Readonly<{ path: string; start: number }>> = [];
    const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      await input.beforeRequest();
      calls.push({ path: input.path, start: input.start });
      if (input.path === "/Synthetic") {
        return {
          entries: [
            directory("2", "/Synthetic/B"),
            file("3", "/Synthetic/ignored.pdf"),
            directory("1", "/Synthetic/A"),
          ],
        };
      }
      if (input.path === "/Synthetic/A") {
        return { entries: [directory("4", "/Synthetic/A/Grandchild")] };
      }
      return { entries: [] };
    }));

    const summary = await discovery.discoverMore("/Synthetic");

    expect(calls).toEqual([
      { path: "/Synthetic", start: 0 },
      { path: "/Synthetic/A", start: 0 },
      { path: "/Synthetic/B", start: 0 },
      { path: "/Synthetic/A/Grandchild", start: 0 },
    ]);
    expect(summary).toMatchObject({
      status: "complete",
      stopReason: "complete",
      directoryCount: 3,
      listRequestCount: 4,
    });
    expect(discovery.searchCached("").map((value) => value.path)).toEqual([
      "/Synthetic/A",
      "/Synthetic/A/Grandchild",
      "/Synthetic/B",
    ]);
    expect(discovery.searchCached("ignored")).toEqual([]);

    const first = discovery.snapshotCached();
    expect(first).toEqual([
      { fsId: "1", path: "/Synthetic/A", filename: "A" },
      { fsId: "4", path: "/Synthetic/A/Grandchild", filename: "Grandchild" },
      { fsId: "2", path: "/Synthetic/B", filename: "B" },
    ]);
    (first[0] as { path: string }).path = "/Tampered";
    expect(discovery.snapshotCached()).toEqual([
      { fsId: "1", path: "/Synthetic/A", filename: "A" },
      { fsId: "4", path: "/Synthetic/A/Grandchild", filename: "Grandchild" },
      { fsId: "2", path: "/Synthetic/B", filename: "B" },
    ]);
  });

  it("rejects non-normalized, non-direct, duplicate fsId, and duplicate path entries atomically", async () => {
    const invalidPages: readonly (readonly BaiduListEntry[])[] = [
      [directory("1", "/Outside/Child")],
      [directory("1", "/Synthetic/Parent/Grandchild")],
      [{ ...directory("1", "/Synthetic/é"), path: "/Synthetic/e\u0301" }],
      [directory("1", "/Synthetic/A"), directory("1", "/Synthetic/B")],
      [directory("1", "/Synthetic/A"), directory("2", "/Synthetic/A")],
    ];

    for (const entries of invalidPages) {
      const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
        await input.beforeRequest();
        return { entries };
      }));
      await expect(discovery.discoverMore("/Synthetic")).rejects.toEqual(
        new CatalogError("invalid-baidu-response"),
      );
      expect(discovery.searchCached("")).toEqual([]);
    }
  });

  it("contains structural getter failures from the shared page validator", async () => {
    const malformed = Object.defineProperty({}, "path", {
      get: () => { throw new Error("raw-getter-message"); },
    }) as BaiduListEntry;
    const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [malformed] };
    }));

    await expect(discovery.discoverMore("/Synthetic")).rejects.toEqual(
      new CatalogError("invalid-baidu-response"),
    );
    expect(discovery.snapshotCached()).toEqual([]);
  });

  it("rejects conflicting identities already held in the session cache", async () => {
    let rootEntry = directory("1", "/Synthetic/A");
    const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: input.path === "/Synthetic" ? [rootEntry] : [] };
    }));

    await discovery.discoverMore("/Synthetic");
    rootEntry = directory("2", "/Synthetic/A");
    await expect(discovery.discoverMore("/Synthetic")).rejects.toEqual(
      new CatalogError("invalid-baidu-response"),
    );

    discovery.clear();
    await discovery.discoverMore("/Synthetic");
    rootEntry = directory("2", "/Synthetic/B");
    await expect(discovery.discoverMore("/Synthetic")).rejects.toEqual(
      new CatalogError("invalid-baidu-response"),
    );
  });

  it("discards the whole over-500 page while preserving prior committed pages", async () => {
    const discovery = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      await input.beforeRequest();
      if (input.start === 0) {
        return {
          entries: [
            directory("1", "/Synthetic/Committed"),
            ...Array.from({ length: 999 }, (_, index) =>
              file(String(index + 2), `/Synthetic/file-${index}.txt`)),
          ],
        };
      }
      return {
        entries: Array.from({ length: 500 }, (_, index) =>
          directory(String(index + 1001), `/Synthetic/Overflow-${index}`)),
      };
    }));

    await expect(discovery.discoverMore("/Synthetic")).resolves.toMatchObject({
      status: "paused",
      stopReason: "directory-limit",
      directoryCount: 1,
      listRequestCount: 2,
    });
    expect(discovery.searchCached("").map((value) => value.path))
      .toEqual(["/Synthetic/Committed"]);
  });

  it("returns fixed cancellation, request-limit, and time-limit summaries", async () => {
    const controller = new AbortController();
    const canceled = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      await input.beforeRequest();
      controller.abort();
      return { entries: [directory("1", "/Synthetic/Discarded")] };
    }));
    await expect(canceled.discoverMore("/Synthetic", controller.signal)).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      directoryCount: 0,
      listRequestCount: 1,
    });
    expect(canceled.searchCached("")).toEqual([]);

    let nextId = 1;
    const requestLimited = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      await input.beforeRequest();
      const id = String(nextId++);
      return { entries: [directory(id, `${input.path}/D${id}`)] };
    }));
    await expect(requestLimited.discoverMore("/Synthetic")).resolves.toMatchObject({
      status: "paused",
      stopReason: "list-request-limit",
      directoryCount: 300,
      listRequestCount: 300,
    });

    let now = 100;
    const timed = new CloudDirectoryDiscoveryService(sourceFrom(async (input) => {
      await input.beforeRequest();
      now += CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDurationMs;
      return { entries: [directory("1", "/Synthetic/Discarded")] };
    }), { now: () => now });
    await expect(timed.discoverMore("/Synthetic")).resolves.toEqual({
      status: "paused",
      stopReason: "time-limit",
      rootPath: "/Synthetic",
      directoryCount: 0,
      listRequestCount: 1,
      elapsedMs: CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDurationMs,
    });
    expect(timed.searchCached("")).toEqual([]);
  });

  it("keeps cache session-only and disposes the composed capability exactly once", () => {
    let discoveryDisposeCalls = 0;
    const directoryDiscovery: CloudDirectoryDiscoveryRuntime = {
      searchCached: () => [],
      snapshotCached: () => [],
      discoverMore: async (rootPath) => ({
        status: "complete",
        stopReason: "complete",
        rootPath,
        directoryCount: 0,
        listRequestCount: 0,
        elapsedMs: 0,
      }),
      clear: () => undefined,
      dispose: () => { discoveryDisposeCalls += 1; },
    };
    const runtime = new CloudCatalogRuntimeService(
      emptySnapshots(),
      { copyText: async () => undefined, openBaidu: async () => undefined },
      undefined,
      undefined,
      undefined,
      directoryDiscovery,
    );

    expect(runtime.directoryDiscovery).toBe(directoryDiscovery);
    runtime.dispose();
    runtime.dispose();
    expect(discoveryDisposeCalls).toBe(1);
  });
});
