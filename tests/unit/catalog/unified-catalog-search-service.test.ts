import { describe, expect, it } from "vitest";
import {
  UnifiedCatalogSearchService,
  type UnifiedCatalogSearchQuery,
} from "../../../src/catalog/unified-catalog-search-service";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
  UnifiedCatalogRecordV1,
} from "../../../src/catalog/hybrid-catalog-types";

const GROUP_A = `group:${"a".repeat(64)}`;
const GROUP_B = `group:${"b".repeat(64)}`;

const record = (input: Readonly<{
  id: string;
  relativePath: string;
  status: CatalogVerificationStatus;
  groupId?: string;
  differences?: readonly CatalogDifferenceKind[];
  visible?: boolean;
  isbn?: readonly string[];
}>): UnifiedCatalogRecordV1 => {
  const filename = input.relativePath.slice(input.relativePath.lastIndexOf("/") + 1);
  const parent = input.relativePath.includes("/")
    ? input.relativePath.slice(0, input.relativePath.lastIndexOf("/"))
    : "";
  const unverified = input.status === "unverified";
  const missing = input.differences?.includes("cloud-missing") ?? false;
  const fsId = unverified ? null : input.id;
  return {
    schemaVersion: 1,
    catalogId: unverified ? `txt:${input.id.padStart(64, "0")}` : `baidu:${input.id}`,
    candidateId: input.differences?.includes("cloud-added") ? null : `txt:${input.id.padStart(64, "0")}`,
    fsId,
    relativePath: input.relativePath,
    cloudPath: unverified || missing ? null : `/Library/${input.relativePath}`,
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: input.isbn ?? [],
    sizeBytes: unverified || missing ? null : 7,
    serverModifiedAt: unverified || missing ? null : 11,
    topLevelGroupId: parent === "" ? "txt-root-items" : input.groupId ?? GROUP_A,
    hierarchyTags: parent === "" ? [] : parent.split("/").map((value) => `folder/${value}`),
    verificationStatus: input.status,
    differenceKinds: input.differences ?? [],
    visibleByDefault: input.visible ?? !missing,
  };
};

const fixture = (): UnifiedCatalogRecordV1[] => [
  record({ id: "1", relativePath: "统计/因果推断.pdf", status: "unverified", isbn: ["9780000000002"] }),
  record({ id: "2", relativePath: "物理/量子力学.pdf", status: "verified", groupId: GROUP_B }),
  record({ id: "3", relativePath: "统计/新增资料.pdf", status: "difference", differences: ["cloud-added"] }),
  record({ id: "4", relativePath: "统计/旧资料.pdf", status: "difference", differences: ["cloud-missing"], visible: false }),
  record({ id: "5", relativePath: "统计/子层/移动资料.pdf", status: "difference", differences: ["moved"] }),
  record({ id: "6", relativePath: "Root.pdf", status: "unverified" }),
];

const query = (overrides: Partial<UnifiedCatalogSearchQuery> = {}): UnifiedCatalogSearchQuery => ({
  text: "",
  offset: 0,
  limit: 50,
  ...overrides,
});

describe("UnifiedCatalogSearchService", () => {
  it("searches filename, title, paths, hierarchy tags, and ISBN", () => {
    const search = new UnifiedCatalogSearchService(fixture());
    expect(search.query(query({ text: "因果" })).items.map((item) => item.catalogId))
      .toEqual([`txt:${"1".padStart(64, "0")}`]);
    expect(search.query(query({ text: "library/物理" })).items.map((item) => item.fsId))
      .toEqual(["2"]);
    expect(search.query(query({ text: "folder/子层" })).items.map((item) => item.fsId))
      .toEqual(["5"]);
    expect(search.query(query({ text: "9780000000002" })).items).toHaveLength(1);
  });

  it("hides cloud-missing by default and includes it only through the explicit flag", () => {
    const search = new UnifiedCatalogSearchService(fixture());
    expect(search.query(query()).total).toBe(5);
    expect(search.query(query({ statuses: ["difference"] })).items.map((item) => item.fsId))
      .toEqual(["5", "3"]);
    expect(search.query(query({ statuses: ["difference"], includeCloudMissing: true })).items
      .map((item) => item.fsId)).toEqual(["5", "3", "4"]);
  });

  it("combines status, group, hierarchy-tag, and difference filters", () => {
    const search = new UnifiedCatalogSearchService(fixture());
    expect(search.query(query({
      statuses: ["difference"],
      topLevelGroupId: GROUP_A,
      hierarchyTag: "folder/统计",
      differenceKinds: ["moved"],
    })).items.map((item) => item.fsId)).toEqual(["5"]);
    expect(search.query(query({ topLevelGroupId: "txt-root-items" })).items.map((item) => item.filename))
      .toEqual(["Root.pdf"]);
  });

  it("sorts and paginates deterministically and returns detached records", () => {
    const values = fixture().reverse();
    const search = new UnifiedCatalogSearchService(values);
    const first = search.query(query({ limit: 2 }));
    expect(first).toMatchObject({ total: 5, offset: 0, limit: 2 });
    expect(first.items.map((item) => item.relativePath)).toEqual(["Root.pdf", "物理/量子力学.pdf"]);
    (first.items as UnifiedCatalogRecordV1[]).splice(0);
    (values[0]?.hierarchyTags as string[]).push("folder/Changed");
    expect(search.query(query({ limit: 2 })).items).toHaveLength(2);
  });

  it.each([
    query({ offset: -1 }),
    query({ limit: 0 }),
    query({ limit: 51 }),
    query({ statuses: [] }),
    query({ statuses: ["verified", "verified"] }),
    query({ differenceKinds: [] }),
    query({ topLevelGroupId: "group:not-a-hash" }),
    query({ hierarchyTag: "content/topic" }),
    { ...query(), includeCloudMissing: "yes" as unknown as boolean },
  ])("rejects an invalid query %#", (value) => {
    expect(() => new UnifiedCatalogSearchService(fixture()).query(value))
      .toThrow("invalid-unified-catalog-query");
  });
});
