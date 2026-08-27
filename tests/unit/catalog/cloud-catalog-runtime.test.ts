import { describe, expect, it, vi } from "vitest";
import {
  CloudCatalogRuntimeService,
  type CatalogDisplayItem,
  type CloudCatalogActionPort,
  type CloudCatalogConnectionRuntime,
  type CloudCatalogConnectionViewModel,
} from "../../../src/catalog/cloud-catalog-runtime";
import { DISABLED_CLOUD_CATALOG_RUNTIME } from "../../../src/catalog/disabled-cloud-catalog-runtime";
import type { CatalogSnapshotPort } from "../../../src/catalog/catalog-ports";
import {
  CatalogError,
  type CatalogSnapshotDescriptor,
  type CatalogSnapshotRecord,
  type CloudCatalogRecord,
} from "../../../src/catalog/catalog-types";
import { FakeHybridCatalogRuntime } from "../../fakes/fake-cloud-catalog-runtime";
import type { UnifiedCatalogStorePort } from "../../../src/catalog/hybrid-catalog-ports";
import type { UnifiedCatalogRecordV1 } from "../../../src/catalog/hybrid-catalog-types";
import { UnifiedCatalogSearchService } from "../../../src/catalog/unified-catalog-search-service";

const fileRecord = (path: string, fsId: string): CloudCatalogRecord => {
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

const descriptor = (pdfCount: number): CatalogSnapshotDescriptor => ({
  snapshotId: "scan-1",
  schemaVersion: 1,
  completedAt: 1_723_000_000_000,
  recordCount: pdfCount,
  pdfCount,
  sha256: "a".repeat(64),
});

const snapshotPort = (
  active: Awaited<ReturnType<CatalogSnapshotPort["loadActive"]>> = null,
): CatalogSnapshotPort => ({
  createScan: async () => undefined,
  commitPage: async () => undefined,
  loadScan: async () => null,
  saveScanState: async () => undefined,
  finalizeScan: async () => { throw new Error("not-used"); },
  loadReceipt: async () => null,
  promoteScan: async () => descriptor(0),
  loadActive: async () => active,
});

const actions = (): CloudCatalogActionPort & {
  readonly copied: string[];
  readonly opened: string[];
} => {
  const copied: string[] = [];
  const opened: string[] = [];
  return {
    copied,
    opened,
    copyText: async (value) => { copied.push(value); },
    openBaidu: async () => { opened.push("baidu"); },
  };
};

class SubscribableConnection implements CloudCatalogConnectionRuntime {
  disposeCalls = 0;
  unsubscribeCalls = 0;
  private readonly listeners = new Set<() => void>();

  async initialize(): Promise<void> {}
  snapshot(): CloudCatalogConnectionViewModel { return { status: "authorized" }; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) this.unsubscribeCalls += 1;
    };
  }
  async saveApplicationCredentials(): Promise<void> {}
  async beginAuthorization(): Promise<Readonly<{ expiresAt: number }>> {
    return { expiresAt: 1 };
  }
  async submitAuthorizationCode(): Promise<void> {}
  cancelAuthorization(): void {}
  async revoke(): Promise<void> {}
  async startScan(): Promise<void> {}
  cancelScan(): void {}
  dispose(): void { this.disposeCalls += 1; }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const readyFixture = (): Readonly<{
  records: readonly CatalogSnapshotRecord[];
  runtime: CloudCatalogRuntimeService;
  actions: ReturnType<typeof actions>;
}> => {
  const records = [
    fileRecord("/物理/量子.pdf", "3"),
    fileRecord("/统计/因果推断.pdf", "1"),
    fileRecord("/统计/现代统计.pdf", "2"),
  ];
  const actionPort = actions();
  return {
    records,
    actions: actionPort,
    runtime: new CloudCatalogRuntimeService(
      snapshotPort({ descriptor: descriptor(records.length), records }),
      actionPort,
    ),
  };
};

const unifiedRecord = (input: Readonly<{
  catalogId: string;
  relativePath: string;
  cloudPath: string | null;
  verificationStatus: UnifiedCatalogRecordV1["verificationStatus"];
  differenceKinds?: UnifiedCatalogRecordV1["differenceKinds"];
  visibleByDefault?: boolean;
}>): UnifiedCatalogRecordV1 => {
  const filename = input.relativePath.slice(input.relativePath.lastIndexOf("/") + 1);
  const group = input.relativePath.includes("/") ? input.relativePath.split("/")[0]! : "";
  return {
    schemaVersion: 1,
    catalogId: input.catalogId,
    candidateId: input.catalogId.startsWith("txt:") ? input.catalogId : null,
    fsId: input.cloudPath === null ? null : input.catalogId.replace("baidu:", "") || "1",
    relativePath: input.relativePath,
    cloudPath: input.cloudPath,
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: [],
    sizeBytes: input.cloudPath === null ? null : 10,
    serverModifiedAt: input.cloudPath === null ? null : 20,
    topLevelGroupId: group.length === 0 ? "txt-root-items" : `group:${"1".repeat(64)}`,
    hierarchyTags: group.length === 0 ? [] : [`folder/${group}`],
    verificationStatus: input.verificationStatus,
    differenceKinds: input.differenceKinds ?? [],
    visibleByDefault: input.visibleByDefault ?? true,
  };
};

const unifiedPort = (
  records: readonly UnifiedCatalogRecordV1[],
): Pick<UnifiedCatalogStorePort, "queryActiveUnified"> => ({
  queryActiveUnified: async (query) => {
    const descriptor = {
      schemaVersion: 1,
      snapshotId: "unified-1",
      sourceImportSha256: "a".repeat(64),
      completedAt: 1_724_000_000_000,
      recordCount: records.length,
      differenceCount: records.reduce((count, record) => count + record.differenceKinds.length, 0),
      catalogSha256: "b".repeat(64),
      differencesSha256: "c".repeat(64),
    } as const;
    const groupCounts = new Map<string, { label: string; count: number }>();
    const tagCounts = new Map<string, number>();
    const verificationCounts = { unverified: 0, verified: 0, difference: 0, cloudMissing: 0 };
    const differenceGroupKeys = new Set<string>();
    const differenceKindCounts = { "cloud-added": 0, "cloud-missing": 0, renamed: 0, moved: 0 };
    for (const record of records) {
      verificationCounts[record.verificationStatus] += 1;
      if (record.verificationStatus === "difference") differenceGroupKeys.add(record.topLevelGroupId);
      const group = groupCounts.get(record.topLevelGroupId);
      groupCounts.set(record.topLevelGroupId, {
        label: group?.label ?? (record.hierarchyTags[0]?.slice("folder/".length) ?? "Root items"),
        count: (group?.count ?? 0) + 1,
      });
      for (const tag of record.hierarchyTags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      for (const kind of record.differenceKinds) {
        differenceKindCounts[kind] += 1;
        if (kind === "cloud-missing") verificationCounts.cloudMissing += 1;
      }
    }
    return {
      descriptor,
      aggregate: {
        verificationCounts,
        differenceGroupKeys: [...differenceGroupKeys],
        groups: [...groupCounts].map(([groupKey, value]) => ({ groupKey, ...value })),
        hierarchyTags: [...tagCounts].map(([tag, count]) => ({
          tag,
          label: tag.slice("folder/".length),
          count,
        })),
        differenceKindCounts,
      },
      page: new UnifiedCatalogSearchService(records).query(query),
    };
  },
});

describe("CloudCatalogRuntimeService", () => {
  it("initializes no-snapshot and ready states without exposing mutable records", async () => {
    const empty = new CloudCatalogRuntimeService(snapshotPort(), actions());
    expect(empty.snapshot()).toMatchObject({
      status: "no-snapshot",
      query: "",
      folderPrefix: "",
      page: 0,
      pageSize: 50,
      pdfCount: 0,
      total: 0,
    });
    await empty.initialize();
    expect(empty.snapshot()).toMatchObject({ status: "no-snapshot", total: 0 });

    const fixture = readyFixture();
    await fixture.runtime.initialize();
    const first = fixture.runtime.snapshot();
    expect(first).toMatchObject({
      status: "ready",
      snapshotCompletedAt: 1_723_000_000_000,
      pdfCount: 3,
      total: 3,
    });
    (first.items as CatalogDisplayItem[]).splice(0);
    expect(fixture.runtime.snapshot().items).toHaveLength(3);
  });

  it("maps corrupt snapshots and unavailable storage to fixed safe states", async () => {
    const corrupt = snapshotPort();
    corrupt.loadActive = async () => { throw new CatalogError("snapshot-corrupt"); };
    const corruptRuntime = new CloudCatalogRuntimeService(corrupt, actions());
    await corruptRuntime.initialize();
    expect(corruptRuntime.snapshot()).toMatchObject({
      status: "error",
      messageCode: "snapshot-corrupt",
      items: [],
    });

    const unavailable = snapshotPort();
    unavailable.loadActive = async () => { throw new Error("private filesystem detail"); };
    const unavailableRuntime = new CloudCatalogRuntimeService(unavailable, actions());
    await unavailableRuntime.initialize();
    expect(unavailableRuntime.snapshot()).toMatchObject({
      status: "unavailable",
      messageCode: "catalog-unavailable",
      items: [],
    });
    expect(JSON.stringify(unavailableRuntime.snapshot())).not.toContain("filesystem");
  });

  it("searches, filters, resets pages, and clamps page boundaries", async () => {
    const fixture = readyFixture();
    await fixture.runtime.initialize();

    fixture.runtime.setQuery("统计");
    expect(fixture.runtime.snapshot()).toMatchObject({ status: "ready", total: 2, page: 0 });
    fixture.runtime.setPage(7);
    expect(fixture.runtime.snapshot().page).toBe(0);
    fixture.runtime.setFolderPrefix("/物理");
    expect(fixture.runtime.snapshot()).toMatchObject({ total: 0, page: 0 });
    fixture.runtime.setQuery("");
    expect(fixture.runtime.snapshot()).toMatchObject({ total: 1, page: 0 });
    expect(() => fixture.runtime.setPage(-1)).toThrow("invalid-catalog-page");
    expect(() => fixture.runtime.setPage(0.5)).toThrow("invalid-catalog-page");
  });

  it("delegates explicit copy and open actions by catalog identity", async () => {
    const fixture = readyFixture();
    await fixture.runtime.initialize();

    await fixture.runtime.copyFilename("1");
    await fixture.runtime.copyCloudPath("1");
    await fixture.runtime.openBaidu();

    expect(fixture.actions.copied).toEqual(["因果推断.pdf", "/统计/因果推断.pdf"]);
    expect(fixture.actions.opened).toEqual(["baidu"]);
    await expect(fixture.runtime.copyCloudPath("missing")).rejects.toThrow(
      "catalog-record-unavailable",
    );
  });

  it("notifies active subscribers and becomes inert after disposal", async () => {
    const fixture = readyFixture();
    const listener = vi.fn();
    const unsubscribe = fixture.runtime.subscribe(listener);
    await fixture.runtime.initialize();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const afterUnsubscribe = listener.mock.calls.length;
    fixture.runtime.setQuery("统计");
    expect(listener).toHaveBeenCalledTimes(afterUnsubscribe);

    const disposedListener = vi.fn();
    fixture.runtime.subscribe(disposedListener);
    fixture.runtime.dispose();
    fixture.runtime.setQuery("");
    expect(disposedListener).not.toHaveBeenCalled();
    await expect(fixture.runtime.copyFilename("1")).rejects.toThrow("catalog-unavailable");
  });

  it("forwards connection events and unsubscribes before disposal", () => {
    const connection = new SubscribableConnection();
    const runtime = new CloudCatalogRuntimeService(snapshotPort(), actions(), connection);
    const listener = vi.fn();
    runtime.subscribe(listener);

    connection.emit();
    expect(listener).toHaveBeenCalledTimes(1);

    runtime.dispose();
    expect(connection.unsubscribeCalls).toBe(1);
    expect(connection.disposeCalls).toBe(1);
    connection.emit();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("initializes and disposes an optional local hybrid capability without invoking actions", async () => {
    const hybrid = new FakeHybridCatalogRuntime();
    const actionPort = actions();
    const runtime = new CloudCatalogRuntimeService(
      snapshotPort(),
      actionPort,
      undefined,
      hybrid,
    );

    await runtime.initialize();
    expect(runtime.hybrid).toBe(hybrid);
    expect(hybrid.initializeCalls).toBe(1);
    expect(actionPort.copied).toEqual([]);
    expect(actionPort.opened).toEqual([]);

    runtime.dispose();
    expect(hybrid.disposeCalls).toBe(1);
  });

  it("prefers a unified projection, hides cloud-missing by default, and exposes display-safe items", async () => {
    const records = [
      unifiedRecord({
        catalogId: `txt:${"1".repeat(64)}`,
        relativePath: "Science/Unverified.pdf",
        cloudPath: null,
        verificationStatus: "unverified",
      }),
      unifiedRecord({
        catalogId: "baidu:2",
        relativePath: "Science/Verified.pdf",
        cloudPath: "/Library/Science/Verified.pdf",
        verificationStatus: "verified",
      }),
      unifiedRecord({
        catalogId: "baidu:3",
        relativePath: "Science/Moved.pdf",
        cloudPath: "/Library/Archive/Moved.pdf",
        verificationStatus: "difference",
        differenceKinds: ["moved"],
      }),
      unifiedRecord({
        catalogId: `txt:${"4".repeat(64)}`,
        relativePath: "Science/Missing.pdf",
        cloudPath: null,
        verificationStatus: "difference",
        differenceKinds: ["cloud-missing"],
        visibleByDefault: false,
      }),
    ];
    const legacy = [fileRecord("/Legacy/Should-not-win.pdf", "99")];
    const runtime = new CloudCatalogRuntimeService(
      snapshotPort({ descriptor: descriptor(1), records: legacy }),
      actions(),
      undefined,
      undefined,
      unifiedPort(records),
    );

    await runtime.initialize();

    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      source: "unified",
      pdfCount: 4,
      total: 3,
      verificationCounts: {
        unverified: 1,
        verified: 1,
        difference: 2,
        cloudMissing: 1,
      },
    });
    expect(runtime.snapshot().items.map((item) => item.catalogId)).toEqual([
      "baidu:3",
      `txt:${"1".repeat(64)}`,
      "baidu:2",
    ]);
    expect(runtime.snapshot().items[1]).toEqual({
      catalogId: `txt:${"1".repeat(64)}`,
      filename: "Unverified.pdf",
      pathLabel: "Science/Unverified.pdf",
      cloudPathAvailable: false,
      verificationStatus: "unverified",
      differenceKinds: [],
      hierarchyTags: ["folder/Science"],
    });
    expect(JSON.stringify(runtime.snapshot())).not.toContain("/Library");
  });

  it("filters unified state locally and rejects cloud-path copy for candidates", async () => {
    const actionPort = actions();
    const candidateId = `txt:${"1".repeat(64)}`;
    const records = [
      unifiedRecord({
        catalogId: candidateId,
        relativePath: "Science/Unverified.pdf",
        cloudPath: null,
        verificationStatus: "unverified",
      }),
      unifiedRecord({
        catalogId: "baidu:2",
        relativePath: "Science/Verified.pdf",
        cloudPath: "/Library/Science/Verified.pdf",
        verificationStatus: "verified",
      }),
      unifiedRecord({
        catalogId: `txt:${"3".repeat(64)}`,
        relativePath: "Science/Missing.pdf",
        cloudPath: null,
        verificationStatus: "difference",
        differenceKinds: ["cloud-missing"],
        visibleByDefault: false,
      }),
    ];
    const runtime = new CloudCatalogRuntimeService(
      snapshotPort(),
      actionPort,
      undefined,
      undefined,
      unifiedPort(records),
    );
    await runtime.initialize();

    await runtime.copyFilename(candidateId);
    await expect(runtime.copyCloudPath(candidateId)).rejects.toThrow("catalog-record-unavailable");
    await runtime.copyCloudPath("baidu:2");

    runtime.setVerificationStatuses(["unverified"]);
    await vi.waitFor(() => {
      expect(runtime.snapshot()).toMatchObject({ total: 1, verificationStatuses: ["unverified"] });
    });
    runtime.setVerificationStatuses(["difference"]);
    await vi.waitFor(() => { expect(runtime.snapshot().total).toBe(0); });
    runtime.setIncludeCloudMissing(true);
    runtime.setDifferenceKinds(["cloud-missing"]);
    runtime.setHierarchyTag("folder/Science");
    await vi.waitFor(() => {
      expect(runtime.snapshot()).toMatchObject({
        total: 1,
        includeCloudMissing: true,
        differenceKinds: ["cloud-missing"],
        hierarchyTag: "folder/Science",
      });
    });
    expect(actionPort.copied).toEqual(["Unverified.pdf", "/Library/Science/Verified.pdf"]);
  });
});

describe("DISABLED_CLOUD_CATALOG_RUNTIME", () => {
  it("omits connection capability and rejects every external action safely", async () => {
    expect(DISABLED_CLOUD_CATALOG_RUNTIME.connection).toBeUndefined();
    expect(DISABLED_CLOUD_CATALOG_RUNTIME.hybrid).toBeUndefined();
    expect(DISABLED_CLOUD_CATALOG_RUNTIME.snapshot()).toMatchObject({
      status: "unavailable",
      messageCode: "catalog-unavailable",
      pageSize: 50,
      items: [],
    });
    await DISABLED_CLOUD_CATALOG_RUNTIME.initialize();
    await expect(DISABLED_CLOUD_CATALOG_RUNTIME.copyFilename("1")).rejects.toThrow(
      "catalog-unavailable",
    );
    await expect(DISABLED_CLOUD_CATALOG_RUNTIME.copyCloudPath("1")).rejects.toThrow(
      "catalog-unavailable",
    );
    await expect(DISABLED_CLOUD_CATALOG_RUNTIME.openBaidu()).rejects.toThrow(
      "catalog-unavailable",
    );
  });
});
