import { describe, expect, it } from "vitest";
import { UnifiedCatalogProjectionService } from "../../../src/catalog/unified-catalog-projection-service";
import type {
  CandidateImportWriter,
  UnifiedCatalogStorePort,
} from "../../../src/catalog/hybrid-catalog-ports";
import {
  HybridCatalogError,
  type ActiveCatalogOverlay,
  type CandidateCatalogDescriptor,
  type CatalogDifferenceRecordV1,
  type TxtCandidateRecordV1,
  type UnifiedCatalogDescriptor,
  type UnifiedCatalogRecordV1,
} from "../../../src/catalog/hybrid-catalog-types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const GROUP_A = `group:${"c".repeat(64)}`;
const GROUP_B = `group:${"d".repeat(64)}`;

const candidate = (
  relativePath: string,
  idValue: string,
  topLevelGroupId = GROUP_A,
): TxtCandidateRecordV1 => {
  const filename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const parentRelativePath = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";
  return {
    schemaVersion: 1,
    source: "txt-candidate",
    candidateId: `txt:${idValue.length === 64 ? idValue : idValue.repeat(64)}`,
    relativePath,
    parentRelativePath,
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: [],
    topLevelGroupId: parentRelativePath === "" ? "txt-root-items" : topLevelGroupId,
    hierarchyTags: parentRelativePath === "" ? [] : parentRelativePath.split("/").map((value) => `folder/${value}`),
  };
};

const candidateDescriptor = (pdfCount: number): CandidateCatalogDescriptor => ({
  schemaVersion: 1,
  importId: "import-1",
  importedAt: 10,
  sourceSha256: HASH_A,
  byteSize: 100,
  nonEmptyLineCount: pdfCount + 1,
  pdfCount,
  directoryCount: 1,
  ignoredLeafCount: 0,
  normalizedWhitespaceCount: 0,
  maxDepth: 2,
  candidateSha256: HASH_B,
});

const cloudRecord = (input: Readonly<{
  relativePath: string;
  fsId: string;
  candidateId?: string | null;
  groupId?: string;
  status?: "verified" | "difference";
  differences?: readonly ("cloud-added" | "cloud-missing" | "renamed" | "moved")[];
}>): UnifiedCatalogRecordV1 => {
  const filename = input.relativePath.slice(input.relativePath.lastIndexOf("/") + 1);
  const parent = input.relativePath.slice(0, input.relativePath.lastIndexOf("/"));
  return {
    schemaVersion: 1,
    catalogId: `baidu:${input.fsId}`,
    candidateId: input.candidateId ?? null,
    fsId: input.fsId,
    relativePath: input.relativePath,
    cloudPath: `/Library/${input.relativePath}`,
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: [],
    sizeBytes: 7,
    serverModifiedAt: 11,
    topLevelGroupId: input.groupId ?? GROUP_A,
    hierarchyTags: parent.split("/").map((value) => `folder/${value}`),
    verificationStatus: input.status ?? "verified",
    differenceKinds: input.differences ?? [],
    visibleByDefault: true,
  };
};

class ProjectionStore implements UnifiedCatalogStorePort {
  candidates: readonly TxtCandidateRecordV1[];
  overlays: readonly ActiveCatalogOverlay[] = [];
  activeUnified: Readonly<{
    descriptor: UnifiedCatalogDescriptor;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
  }> | null = null;

  constructor(candidates: readonly TxtCandidateRecordV1[]) {
    this.candidates = candidates;
  }

  async createCandidateImport(): Promise<CandidateImportWriter> { throw new Error("not-used"); }
  async loadActiveCandidates() {
    return { descriptor: candidateDescriptor(this.candidates.length), records: this.candidates };
  }
  async loadActiveOverlays(): Promise<readonly ActiveCatalogOverlay[]> { return this.overlays; }
  async writeUnifiedSnapshot(input: Readonly<{
    sourceImportSha256: string;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
    completedAt: number;
  }>): Promise<UnifiedCatalogDescriptor> {
    const descriptor: UnifiedCatalogDescriptor = {
      schemaVersion: 1,
      snapshotId: "unified-1",
      sourceImportSha256: input.sourceImportSha256,
      completedAt: input.completedAt,
      recordCount: input.records.length,
      differenceCount: input.differences.length,
      catalogSha256: HASH_A,
      differencesSha256: HASH_B,
    };
    this.activeUnified = { descriptor, records: input.records, differences: input.differences };
    return descriptor;
  }
  async loadActiveUnified() { return this.activeUnified; }
}

const overlay = (input: Readonly<{
  id: string;
  sourceHash?: string;
  completedAt: number;
  records: readonly UnifiedCatalogRecordV1[];
  differences?: readonly CatalogDifferenceRecordV1[];
  superseded?: readonly string[];
  groupId?: string;
}>): ActiveCatalogOverlay => ({
  descriptor: {
    schemaVersion: 1,
    overlayId: input.id,
    sourceImportSha256: input.sourceHash ?? HASH_A,
    topLevelGroupId: input.groupId ?? GROUP_A,
    completedAt: input.completedAt,
    recordCount: input.records.length,
    differenceCount: input.differences?.length ?? 0,
    supersededCount: input.superseded?.length ?? 0,
    recordsSha256: HASH_A,
    differencesSha256: HASH_B,
    supersededSha256: HASH_A,
  },
  records: input.records,
  differences: input.differences ?? [],
  supersededCatalogIds: input.superseded ?? [],
});

describe("UnifiedCatalogProjectionService", () => {
  it("projects candidates as stable searchable unverified records", async () => {
    const store = new ProjectionStore([
      candidate("Synthetic/Z.pdf", "b"),
      candidate("Synthetic/A.pdf", "a"),
    ]);
    const result = await new UnifiedCatalogProjectionService(store, { now: () => 100 }).rebuild();

    expect(result.descriptor).toMatchObject({ completedAt: 100, recordCount: 2 });
    expect(result.records.map((record) => record.relativePath)).toEqual([
      "Synthetic/A.pdf",
      "Synthetic/Z.pdf",
    ]);
    expect(result.records[0]).toMatchObject({
      catalogId: `txt:${"a".repeat(64)}`,
      candidateId: `txt:${"a".repeat(64)}`,
      fsId: null,
      cloudPath: null,
      sizeBytes: null,
      serverModifiedAt: null,
      verificationStatus: "unverified",
      differenceKinds: [],
      visibleByDefault: true,
    });
  });

  it("ignores overlays from another candidate source", async () => {
    const base = candidate("Synthetic/A.pdf", "a");
    const store = new ProjectionStore([base]);
    store.overlays = [overlay({
      id: "overlay-old-source",
      sourceHash: "e".repeat(64),
      completedAt: 20,
      records: [cloudRecord({ relativePath: base.relativePath, fsId: "7", candidateId: base.candidateId })],
    })];

    const result = await new UnifiedCatalogProjectionService(store, { now: () => 100 }).rebuild();
    expect(result.records).toEqual([expect.objectContaining({
      catalogId: base.candidateId,
      verificationStatus: "unverified",
    })]);
  });

  it("uses newer global fsId identity and suppresses the old cross-group location", async () => {
    const oldCandidate = candidate("Old/A.pdf", "a", GROUP_A);
    const newCandidate = candidate("New/A.pdf", "b", GROUP_B);
    const oldRecord = cloudRecord({
      relativePath: oldCandidate.relativePath,
      fsId: "7",
      candidateId: oldCandidate.candidateId,
      groupId: GROUP_A,
    });
    const movedRecord = cloudRecord({
      relativePath: newCandidate.relativePath,
      fsId: "7",
      candidateId: newCandidate.candidateId,
      groupId: GROUP_B,
      status: "difference",
      differences: ["moved"],
    });
    const movedDifference: CatalogDifferenceRecordV1 = {
      schemaVersion: 1,
      catalogId: "baidu:7",
      topLevelGroupId: GROUP_B,
      kind: "moved",
      acknowledgedAt: null,
    };
    const store = new ProjectionStore([oldCandidate, newCandidate]);
    store.overlays = [
      overlay({ id: "old", completedAt: 20, records: [oldRecord], groupId: GROUP_A }),
      overlay({
        id: "new",
        completedAt: 30,
        records: [movedRecord],
        differences: [movedDifference],
        superseded: [oldRecord.catalogId],
        groupId: GROUP_B,
      }),
    ];

    const result = await new UnifiedCatalogProjectionService(store, { now: () => 100 }).rebuild();
    expect(result.records).toEqual([movedRecord]);
    expect(result.differences).toEqual([movedDifference]);
  });

  it("rejects ambiguous equally recent fsId identities", async () => {
    const base = candidate("Synthetic/A.pdf", "a");
    const store = new ProjectionStore([base]);
    store.overlays = [
      overlay({ id: "one", completedAt: 20, records: [cloudRecord({ relativePath: "One/A.pdf", fsId: "7" })] }),
      overlay({ id: "two", completedAt: 20, records: [cloudRecord({ relativePath: "Two/A.pdf", fsId: "7" })] }),
    ];
    await expect(new UnifiedCatalogProjectionService(store, { now: () => 100 }).rebuild())
      .rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));
    expect(store.activeUnified).toBeNull();
  });

  it("suppresses an acknowledged missing candidate and ignores its archived difference", async () => {
    const base = candidate("Synthetic/A.pdf", "a");
    const archived: CatalogDifferenceRecordV1 = {
      schemaVersion: 1,
      catalogId: base.candidateId,
      topLevelGroupId: GROUP_A,
      kind: "cloud-missing",
      acknowledgedAt: 50,
    };
    const store = new ProjectionStore([base]);
    store.overlays = [overlay({
      id: "acknowledged-missing",
      completedAt: 50,
      records: [],
      differences: [archived],
      superseded: [base.candidateId],
    })];

    const result = await new UnifiedCatalogProjectionService(store, { now: () => 100 }).rebuild();
    expect(result.records).toEqual([]);
    expect(result.differences).toEqual([]);
  });

  it("allows 70,000 records and rejects 70,001 before writing", async () => {
    const allowed = Array.from({ length: 70_000 }, (_, index) => candidate(
      `Synthetic/P${String(index).padStart(5, "0")}.pdf`,
      index.toString(16).padStart(64, "0"),
    ));
    const store = new ProjectionStore(allowed);
    await expect(new UnifiedCatalogProjectionService(store, { now: () => 100 }).rebuild())
      .resolves.toMatchObject({ descriptor: { recordCount: 70_000 } });

    const blocked = new ProjectionStore([...allowed, candidate("Synthetic/Overflow.pdf", "f")]);
    await expect(new UnifiedCatalogProjectionService(blocked, { now: () => 100 }).rebuild())
      .rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));
    expect(blocked.activeUnified).toBeNull();
  }, 30_000);
});
