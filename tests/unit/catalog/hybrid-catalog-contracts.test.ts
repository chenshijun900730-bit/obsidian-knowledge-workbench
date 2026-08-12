import { describe, expect, it } from "vitest";
import {
  decodeCandidateCatalogDescriptor,
  decodeCatalogDifferenceRecord,
  decodeCatalogOverlayDescriptor,
  decodeTxtCandidateRecord,
  decodeUnifiedCatalogDescriptor,
  decodeUnifiedCatalogRecord,
  encodeTxtCandidateRecordLine,
  encodeCatalogOverlayDescriptor,
  encodeUnifiedCatalogRecordLine,
} from "../../../src/catalog/hybrid-catalog-codec";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  LARGE_CATALOG_RUN_BUDGET,
  MAX_UNIFIED_CATALOG_PDF_COUNT,
  HybridCatalogError,
} from "../../../src/catalog/hybrid-catalog-types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const candidateJson = (overrides: Readonly<Record<string, unknown>> = {}): string => JSON.stringify({
  schemaVersion: 1,
  source: "txt-candidate",
  candidateId: `txt:${HASH_A}`,
  relativePath: "Synthetic/A.pdf",
  parentRelativePath: "Synthetic",
  filename: "A.pdf",
  title: "A",
  isbnCandidates: ["9780000000002"],
  topLevelGroupId: `group:${HASH_B}`,
  hierarchyTags: ["folder/Synthetic"],
  ...overrides,
});

const unifiedJson = (overrides: Readonly<Record<string, unknown>> = {}): string => JSON.stringify({
  schemaVersion: 1,
  catalogId: "baidu:7",
  candidateId: `txt:${HASH_A}`,
  fsId: "7",
  relativePath: "Synthetic/A.pdf",
  cloudPath: "/Library/Synthetic/A.pdf",
  filename: "A.pdf",
  title: "A",
  isbnCandidates: ["9780000000002"],
  sizeBytes: 7,
  serverModifiedAt: 11,
  topLevelGroupId: `group:${HASH_B}`,
  hierarchyTags: ["folder/Synthetic"],
  verificationStatus: "difference",
  differenceKinds: ["renamed"],
  visibleByDefault: true,
  ...overrides,
});

describe("hybrid catalog contracts", () => {
  it("freezes the approved product limits", () => {
    expect(CATALOG_TXT_IMPORT_BUDGET).toEqual({
      maxBytes: 16_777_216,
      maxNonEmptyLineCount: 71_000,
      maxPdfCount: 70_000,
      maxDepth: 32,
      maxLineBytes: 16_384,
    });
    expect(LARGE_CATALOG_RUN_BUDGET).toEqual({
      maxSelectedTopLevelGroups: 5,
      maxPdfCount: 10_000,
      maxDirectoryCount: 500,
      maxListRequestCount: 300,
      maxDurationMs: 1_800_000,
    });
    expect(MAX_UNIFIED_CATALOG_PDF_COUNT).toBe(70_000);
    expect(Object.isFrozen(CATALOG_TXT_IMPORT_BUDGET)).toBe(true);
    expect(Object.isFrozen(LARGE_CATALOG_RUN_BUDGET)).toBe(true);
  });

  it("strictly decodes a candidate and returns detached arrays", () => {
    const raw = candidateJson();
    const first = decodeTxtCandidateRecord(raw);
    (first.isbnCandidates as string[]).push("0000000000");
    (first.hierarchyTags as string[]).push("folder/Changed");

    expect(decodeTxtCandidateRecord(raw)).toEqual({
      schemaVersion: 1,
      source: "txt-candidate",
      candidateId: `txt:${HASH_A}`,
      relativePath: "Synthetic/A.pdf",
      parentRelativePath: "Synthetic",
      filename: "A.pdf",
      title: "A",
      isbnCandidates: ["9780000000002"],
      topLevelGroupId: `group:${HASH_B}`,
      hierarchyTags: ["folder/Synthetic"],
    });
  });

  it("rejects unknown, inconsistent, or unsafe candidate fields with one fixed code", () => {
    for (const raw of [
      candidateJson({ sourcePath: "/private/source.txt" }),
      candidateJson({ relativePath: "/Synthetic/A.pdf" }),
      candidateJson({ relativePath: "Synthetic\\A.pdf" }),
      candidateJson({ filename: "B.pdf" }),
      candidateJson({ candidateId: "txt:not-a-hash" }),
      candidateJson({ isbnCandidates: ["9780000000002", "9780000000002"] }),
      "{\"schemaVersion\":1,\"schemaVersion\":1}",
    ]) {
      expect(() => decodeTxtCandidateRecord(raw)).toThrow(
        new HybridCatalogError("hybrid-record-invalid"),
      );
    }
  });

  it("enforces status and cloud-fact consistency for unified records", () => {
    const raw = unifiedJson();
    const first = decodeUnifiedCatalogRecord(raw);
    (first.differenceKinds as string[]).push("moved");
    (first.hierarchyTags as string[]).push("folder/Changed");
    expect(decodeUnifiedCatalogRecord(raw).differenceKinds).toEqual(["renamed"]);

    expect(decodeUnifiedCatalogRecord(unifiedJson({
      catalogId: `txt:${HASH_A}`,
      fsId: null,
      cloudPath: null,
      sizeBytes: null,
      serverModifiedAt: null,
      verificationStatus: "unverified",
      differenceKinds: [],
    }))).toMatchObject({ verificationStatus: "unverified", fsId: null });

    expect(decodeUnifiedCatalogRecord(unifiedJson({
      cloudPath: null,
      fsId: null,
      catalogId: `txt:${HASH_A}`,
      sizeBytes: null,
      serverModifiedAt: null,
      verificationStatus: "difference",
      differenceKinds: ["cloud-missing"],
      visibleByDefault: false,
    }))).toMatchObject({ differenceKinds: ["cloud-missing"], visibleByDefault: false });

    for (const invalid of [
      unifiedJson({ fsId: "07", catalogId: "baidu:07" }),
      unifiedJson({ verificationStatus: "verified", differenceKinds: ["renamed"] }),
      unifiedJson({ verificationStatus: "difference", differenceKinds: [] }),
      unifiedJson({ differenceKinds: ["cloud-missing"], visibleByDefault: true }),
      unifiedJson({ differenceKinds: ["moved", "renamed"] }),
      unifiedJson({ cloudPath: "Library/Synthetic/A.pdf" }),
      unifiedJson({ hierarchyTags: ["folder/Unrelated"] }),
      unifiedJson({ topLevelGroupId: "txt-root-items" }),
    ]) {
      expect(() => decodeUnifiedCatalogRecord(invalid)).toThrow(
        new HybridCatalogError("hybrid-record-invalid"),
      );
    }
  });

  it("decodes strict aggregate descriptors and difference records", () => {
    expect(decodeCandidateCatalogDescriptor(JSON.stringify({
      schemaVersion: 1,
      importId: "import-1",
      importedAt: 100,
      sourceSha256: HASH_A,
      byteSize: 1000,
      nonEmptyLineCount: 3,
      pdfCount: 1,
      directoryCount: 1,
      ignoredLeafCount: 1,
      normalizedWhitespaceCount: 0,
      maxDepth: 2,
      candidateSha256: HASH_B,
    }))).toMatchObject({ importId: "import-1", pdfCount: 1 });

    expect(decodeUnifiedCatalogDescriptor(JSON.stringify({
      schemaVersion: 1,
      snapshotId: "unified-1",
      sourceImportSha256: HASH_A,
      completedAt: 101,
      recordCount: 1,
      differenceCount: 1,
      catalogSha256: HASH_A,
      differencesSha256: HASH_B,
    }))).toMatchObject({ snapshotId: "unified-1", differenceCount: 1 });

    expect(decodeCatalogDifferenceRecord(JSON.stringify({
      schemaVersion: 1,
      catalogId: "baidu:7",
      topLevelGroupId: `group:${HASH_B}`,
      kind: "moved",
      acknowledgedAt: null,
    }))).toMatchObject({ kind: "moved", acknowledgedAt: null });

    const overlay = {
      schemaVersion: 1,
      overlayId: "overlay-1",
      sourceImportSha256: HASH_A,
      topLevelGroupId: `group:${HASH_B}`,
      completedAt: 102,
      recordCount: 1,
      differenceCount: 1,
      supersededCount: 1,
      recordsSha256: HASH_A,
      differencesSha256: HASH_B,
      supersededSha256: HASH_A,
    } as const;
    expect(decodeCatalogOverlayDescriptor(JSON.stringify(overlay))).toEqual(overlay);
    expect(encodeCatalogOverlayDescriptor(overlay)).toBe(JSON.stringify(overlay));
    expect(() => decodeCatalogOverlayDescriptor(JSON.stringify({
      ...overlay,
      cloudRoot: "/Library/Synthetic",
    }))).toThrow(new HybridCatalogError("hybrid-record-invalid"));

    expect(() => decodeCandidateCatalogDescriptor(JSON.stringify({
      schemaVersion: 1,
      importId: "import-1",
      importedAt: 100,
      sourceSha256: HASH_A,
      byteSize: 1000,
      nonEmptyLineCount: 3,
      pdfCount: 1,
      directoryCount: 1,
      ignoredLeafCount: 1,
      normalizedWhitespaceCount: 0,
      maxDepth: 2,
      candidateSha256: HASH_B,
      sourcePath: "/private/source.txt",
    }))).toThrow(new HybridCatalogError("hybrid-record-invalid"));
  });

  it("emits canonical single-line NDJSON with one trailing LF", () => {
    const candidate = decodeTxtCandidateRecord(candidateJson());
    const unified = decodeUnifiedCatalogRecord(unifiedJson());

    expect(encodeTxtCandidateRecordLine(candidate)).toBe(`${candidateJson()}\n`);
    expect(encodeUnifiedCatalogRecordLine(unified)).toBe(`${unifiedJson()}\n`);
    expect(encodeTxtCandidateRecordLine(candidate)).not.toContain("sourcePath");
  });
});
