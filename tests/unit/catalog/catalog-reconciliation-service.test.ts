import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CatalogReconciliationService } from "../../../src/catalog/catalog-reconciliation-service";
import { encodeCatalogOverlayDescriptor } from "../../../src/catalog/hybrid-catalog-codec";
import type { CloudCatalogRecord } from "../../../src/catalog/catalog-types";
import {
  HybridCatalogError,
  type ActiveCatalogOverlay,
  type CatalogDifferenceRecordV1,
  type TxtCandidateRecordV1,
  type UnifiedCatalogRecordV1,
} from "../../../src/catalog/hybrid-catalog-types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const ROOT_HASH = createHash("sha256").update("/Library").digest("hex");
const GROUP_A = `group:${"c".repeat(64)}`;
const GROUP_B = `group:${"d".repeat(64)}`;

const scopedAuthority = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  kind: "scoped" as const,
  scope: {
    generation: 2,
    sourceImportSha256: HASH_A,
    cloudRootSha256: ROOT_HASH,
  },
  legacyAllowlist: {
    candidate: {
      importId: "import-1",
      manifestSha256: "1".repeat(64),
      descriptorSha256: "2".repeat(64),
    },
    overlays: [],
    unified: null,
    resumableBatch: null,
  },
  ...overrides,
});

const candidate = (
  relativePath: string,
  id: string,
  groupId = GROUP_A,
): TxtCandidateRecordV1 => {
  const filename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const parent = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";
  return {
    schemaVersion: 1,
    source: "txt-candidate",
    candidateId: `txt:${id.repeat(64)}`,
    relativePath,
    parentRelativePath: parent,
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: [],
    topLevelGroupId: parent === "" ? "txt-root-items" : groupId,
    hierarchyTags: parent === "" ? [] : parent.split("/").map((segment) => `folder/${segment}`),
  };
};

const cloud = (path: string, fsId: string): CloudCatalogRecord => {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
  return {
    schemaVersion: 1,
    source: "baidu-netdisk",
    fsId,
    kind: "file",
    path,
    parentPath,
    filename,
    extension: "pdf",
    title: filename.slice(0, -4),
    isbnCandidates: [],
    sizeBytes: 10,
    serverModifiedAt: 20,
  };
};

const priorRecord = (input: Readonly<{
  relativePath: string;
  fsId: string;
  candidateId: string | null;
  groupId?: string;
}>): UnifiedCatalogRecordV1 => {
  const filename = input.relativePath.slice(input.relativePath.lastIndexOf("/") + 1);
  const parent = input.relativePath.slice(0, input.relativePath.lastIndexOf("/"));
  return {
    schemaVersion: 1,
    catalogId: `baidu:${input.fsId}`,
    candidateId: input.candidateId,
    fsId: input.fsId,
    relativePath: input.relativePath,
    cloudPath: `/Library/${input.relativePath}`,
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: [],
    sizeBytes: 8,
    serverModifiedAt: 10,
    topLevelGroupId: input.groupId ?? GROUP_A,
    hierarchyTags: parent.split("/").map((segment) => `folder/${segment}`),
    verificationStatus: "verified",
    differenceKinds: [],
    visibleByDefault: true,
  };
};

const overlay = (
  id: string,
  groupId: string,
  completedAt: number,
  records: readonly UnifiedCatalogRecordV1[],
  differences: readonly CatalogDifferenceRecordV1[] = [],
): ActiveCatalogOverlay => ({
  descriptor: {
    schemaVersion: 1,
    overlayId: id,
    sourceImportSha256: HASH_A,
    topLevelGroupId: groupId,
    completedAt,
    recordCount: records.length,
    differenceCount: differences.length,
    supersededCount: 0,
    recordsSha256: HASH_A,
    differencesSha256: HASH_B,
    supersededSha256: HASH_A,
  },
  records,
  differences,
  supersededCatalogIds: [],
});

const scopedOverlay = (
  id: string,
  groupId: string,
  completedAt: number,
  records: readonly UnifiedCatalogRecordV1[],
  scope = scopedAuthority().scope,
): ActiveCatalogOverlay => ({
  descriptor: {
    schemaVersion: 2,
    overlayId: id,
    sourceImportSha256: scope.sourceImportSha256,
    verificationGeneration: scope.generation,
    cloudRootSha256: scope.cloudRootSha256,
    topLevelGroupId: groupId,
    completedAt,
    recordCount: records.length,
    differenceCount: 0,
    supersededCount: 0,
    recordsSha256: HASH_A,
    differencesSha256: HASH_B,
    supersededSha256: HASH_A,
  },
  records,
  differences: [],
  supersededCatalogIds: [],
});

const overlayDescriptorSha256 = (value: ActiveCatalogOverlay): string => createHash("sha256")
  .update(`${encodeCatalogOverlayDescriptor(value.descriptor)}\n`)
  .digest("hex");

const authorityFor = (overlays: readonly ActiveCatalogOverlay[] = []) => scopedAuthority({
  legacyAllowlist: {
    ...scopedAuthority().legacyAllowlist,
    overlays: overlays.map((value) => ({
      overlayId: value.descriptor.overlayId,
      groupKey: value.descriptor.topLevelGroupId,
      descriptorSha256: overlayDescriptorSha256(value),
    })),
  },
});

describe("CatalogReconciliationService", () => {
  it("ignores unlisted schema-1 and stale-scope schema-2 overlays", () => {
    const first = candidate("Synthetic/First.pdf", "a");
    const unlisted = overlay("legacy-unlisted", GROUP_A, 500, [
      priorRecord({
        relativePath: first.relativePath,
        fsId: "7",
        candidateId: first.candidateId,
      }),
    ]);
    const stale = scopedOverlay("stale-scoped", GROUP_A, 600, unlisted.records, {
      ...scopedAuthority().scope,
      generation: scopedAuthority().scope.generation + 1,
    });

    const result = new CatalogReconciliationService().reconcile({
      authority: scopedAuthority(),
      sourceImportSha256: HASH_A,
      topLevelGroupId: GROUP_A,
      cloudRoot: "/Library/Synthetic",
      candidates: [first],
      activeOverlays: [unlisted, stale],
      cloudRecords: [cloud("/Library/Synthetic/New.pdf", "7")],
      completedAt: 600,
      complete: true,
    });

    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        catalogId: "baidu:7",
        candidateId: null,
        differenceKinds: ["cloud-added"],
      }),
      expect.objectContaining({
        catalogId: first.candidateId,
        differenceKinds: ["cloud-missing"],
      }),
    ]));
    expect(result).toMatchObject({ verificationScope: scopedAuthority().scope });
  });

  it("lets an exact-scope schema-2 overlay outrank a newer allowlisted schema-1 overlay", () => {
    const exactCandidate = candidate("Synthetic/Exact-prior.pdf", "a");
    const legacyCandidate = candidate("Synthetic/Legacy-prior.pdf", "b");
    const exact = scopedOverlay("scoped-overlay", GROUP_A, 20, [
      priorRecord({
        relativePath: exactCandidate.relativePath,
        fsId: "7",
        candidateId: exactCandidate.candidateId,
      }),
    ]);
    const legacy = overlay("legacy-allowlisted", GROUP_A, 999, [
      priorRecord({
        relativePath: legacyCandidate.relativePath,
        fsId: "7",
        candidateId: legacyCandidate.candidateId,
      }),
    ]);
    const authority = scopedAuthority({
      legacyAllowlist: {
        ...scopedAuthority().legacyAllowlist,
        overlays: [{
          overlayId: "legacy-allowlisted",
          groupKey: GROUP_A,
          descriptorSha256: overlayDescriptorSha256(legacy),
        }],
      },
    });

    const result = new CatalogReconciliationService().reconcile({
      authority,
      sourceImportSha256: HASH_A,
      topLevelGroupId: GROUP_A,
      cloudRoot: "/Library/Synthetic",
      candidates: [exactCandidate, legacyCandidate],
      activeOverlays: [exact, legacy],
      cloudRecords: [cloud("/Library/Synthetic/Renamed.pdf", "7")],
      completedAt: 1_000,
      complete: true,
    });

    expect(result.records.find((record) => record.cloudPath !== null)).toMatchObject({
      candidateId: exactCandidate.candidateId,
      differenceKinds: ["renamed"],
    });
  });

  it("matches global fsId before exact path and preserves explicit differences", () => {
    const exact = candidate("Synthetic/Exact.pdf", "a");
    const renamed = candidate("Synthetic/Old name.pdf", "b");
    const moved = candidate("Synthetic/Old folder/Moved.pdf", "c");
    const crossGroupTarget = candidate("Synthetic/Cross group.pdf", "d");
    const missing = candidate("Synthetic/Missing.pdf", "e");
    const prior = overlay("overlay-a", GROUP_A, 40, [
      priorRecord({ relativePath: renamed.relativePath, fsId: "1", candidateId: renamed.candidateId }),
      priorRecord({ relativePath: moved.relativePath, fsId: "2", candidateId: moved.candidateId }),
    ]);
    const otherCandidate = candidate("Other/Before.pdf", "f", GROUP_B);
    const other = overlay("overlay-b", GROUP_B, 30, [
      priorRecord({
        relativePath: otherCandidate.relativePath,
        fsId: "3",
        candidateId: otherCandidate.candidateId,
        groupId: GROUP_B,
      }),
    ]);
    const service = new CatalogReconciliationService();
    const result = service.reconcile({
      authority: authorityFor([prior, other]),
      sourceImportSha256: HASH_A,
      topLevelGroupId: GROUP_A,
      cloudRoot: "/Library/Synthetic",
      candidates: [exact, renamed, moved, crossGroupTarget, missing],
      activeOverlays: [prior, other],
      cloudRecords: [
        cloud("/Library/Synthetic/Exact.pdf", "10"),
        cloud("/Library/Synthetic/New name.pdf", "1"),
        cloud("/Library/Synthetic/New folder/Moved.pdf", "2"),
        cloud("/Library/Synthetic/Cross group.pdf", "3"),
        cloud("/Library/Synthetic/Added.pdf", "4"),
      ],
      completedAt: 100,
      complete: true,
    });

    expect(result.records.map((record) => [
      record.fsId,
      record.candidateId,
      record.differenceKinds,
    ])).toEqual([
      ["4", null, ["cloud-added"]],
      ["3", crossGroupTarget.candidateId, ["moved"]],
      ["10", exact.candidateId, []],
      [null, missing.candidateId, ["cloud-missing"]],
      ["2", moved.candidateId, ["moved"]],
      ["1", renamed.candidateId, ["renamed"]],
    ]);
    expect(result.supersededCatalogIds).toEqual(["baidu:3"]);
    expect(result.differences.map((difference) => [difference.catalogId, difference.kind]))
      .toEqual([
        ["baidu:1", "renamed"],
        ["baidu:2", "moved"],
        ["baidu:3", "moved"],
        ["baidu:4", "cloud-added"],
        [missing.candidateId, "cloud-missing"],
      ]);
  });

  it("never merges the same title at a different relative path", () => {
    const old = candidate("Synthetic/Old/Same.pdf", "a");
    const result = new CatalogReconciliationService().reconcile({
      authority: authorityFor(),
      sourceImportSha256: HASH_A,
      topLevelGroupId: GROUP_A,
      cloudRoot: "/Library/Synthetic",
      candidates: [old],
      activeOverlays: [],
      cloudRecords: [cloud("/Library/Synthetic/New/Same.pdf", "7")],
      completedAt: 100,
      complete: true,
    });

    expect(result.records.map((record) => [record.catalogId, record.differenceKinds]))
      .toEqual([
        ["baidu:7", ["cloud-added"]],
        [old.candidateId, ["cloud-missing"]],
      ]);
  });

  it("rejects an incomplete category, duplicate fsId, and cross-group cloud escape", () => {
    const base = {
      authority: authorityFor(),
      sourceImportSha256: HASH_A,
      topLevelGroupId: GROUP_A,
      cloudRoot: "/Library/Synthetic",
      candidates: [candidate("Synthetic/A.pdf", "a")],
      activeOverlays: [],
      completedAt: 100,
    } as const;
    const service = new CatalogReconciliationService();
    expect(() => service.reconcile({
      ...base,
      cloudRecords: [],
      complete: false,
    })).toThrow(new HybridCatalogError("hybrid-batch-invalid"));
    expect(() => service.reconcile({
      ...base,
      cloudRecords: [
        cloud("/Library/Synthetic/A.pdf", "1"),
        cloud("/Library/Synthetic/B.pdf", "1"),
      ],
      complete: true,
    })).toThrow(new HybridCatalogError("hybrid-record-invalid"));
    expect(() => service.reconcile({
      ...base,
      cloudRecords: [cloud("/Library/Other/A.pdf", "1")],
      complete: true,
    })).toThrow(new HybridCatalogError("hybrid-record-invalid"));
  });

  it("acknowledges locally by verifying present records and archiving missing facts", () => {
    const base = candidate("Synthetic/Missing.pdf", "a");
    const service = new CatalogReconciliationService();
    const result = service.reconcile({
      authority: authorityFor(),
      sourceImportSha256: HASH_A,
      topLevelGroupId: GROUP_A,
      cloudRoot: "/Library/Synthetic",
      candidates: [base],
      activeOverlays: [],
      cloudRecords: [cloud("/Library/Synthetic/Added.pdf", "9")],
      completedAt: 100,
      complete: true,
    });
    const acknowledged = service.acknowledge({
      overlay: result,
      catalogIds: ["baidu:9", base.candidateId],
      acknowledgedAt: 200,
    });

    expect(acknowledged.records).toEqual([
      expect.objectContaining({
        catalogId: "baidu:9",
        verificationStatus: "verified",
        differenceKinds: [],
      }),
    ]);
    expect(acknowledged.differences).toEqual([
      expect.objectContaining({ catalogId: "baidu:9", acknowledgedAt: 200 }),
      expect.objectContaining({ catalogId: base.candidateId, acknowledgedAt: 200 }),
    ]);
    expect(acknowledged.supersededCatalogIds).toEqual([base.candidateId]);
    expect(acknowledged.completedAt).toBe(200);
  });

  it("handles root-level TXT items without inventing a top-level folder", () => {
    const root = candidate("Root.pdf", "a", "txt-root-items");
    const result = new CatalogReconciliationService().reconcile({
      authority: authorityFor(),
      sourceImportSha256: HASH_A,
      topLevelGroupId: "txt-root-items",
      cloudRoot: "/Library",
      candidates: [root],
      activeOverlays: [],
      cloudRecords: [cloud("/Library/Root.pdf", "1")],
      completedAt: 100,
      complete: true,
    });
    expect(result.records).toEqual([
      expect.objectContaining({ relativePath: "Root.pdf", hierarchyTags: [] }),
    ]);
  });
});
