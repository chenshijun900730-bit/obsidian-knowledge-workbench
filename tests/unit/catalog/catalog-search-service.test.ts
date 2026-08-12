import { describe, expect, it } from "vitest";
import { CatalogSearchService } from "../../../src/catalog/catalog-search-service";
import type {
  CatalogSnapshotRecord,
  CloudCatalogDirectory,
  CloudCatalogRecord,
} from "../../../src/catalog/catalog-types";

const fileRecord = (
  path: string,
  fsId: string,
  options: Readonly<{
    isbnCandidates?: readonly string[];
    serverModifiedAt?: number;
  }> = {},
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
    isbnCandidates: options.isbnCandidates ?? [],
    sizeBytes: 7,
    serverModifiedAt: options.serverModifiedAt ?? 11,
  };
};

const directoryRecord = (path: string): CloudCatalogDirectory => ({
  schemaVersion: 1,
  source: "baidu-netdisk",
  fsId: "99",
  kind: "directory",
  path,
  parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 0,
  serverModifiedAt: 11,
});

const fixture = (): CatalogSnapshotRecord[] => [
  fileRecord("/统计/现代因果分析.pdf", "2", { serverModifiedAt: 20 }),
  directoryRecord("/统计/子目录"),
  fileRecord("/物理/Causal Inference.pdf", "3", { serverModifiedAt: 30 }),
  fileRecord("/统计/因果推断.pdf", "1", {
    isbnCandidates: ["703012345X", "9787030123456"],
    serverModifiedAt: 10,
  }),
  fileRecord("/统计学/不应命中目录前缀.pdf", "4", { serverModifiedAt: 40 }),
];

describe("CatalogSearchService", () => {
  it("searches normalized title, filename, path, and ISBN fields", () => {
    const search = new CatalogSearchService(fixture());

    expect(search.query({ text: "因果", offset: 0, limit: 50 }).items.map((item) => item.path))
      .toEqual(["/统计/因果推断.pdf", "/统计/现代因果分析.pdf"]);
    expect(search.query({ text: "causal inference", offset: 0, limit: 50 }).items.map((item) => item.path))
      .toEqual(["/物理/Causal Inference.pdf"]);
    expect(search.query({ text: "9787030123456", offset: 0, limit: 50 }).items.map((item) => item.fsId))
      .toEqual(["1"]);
    expect(search.query({ text: "703012345x", offset: 0, limit: 50 }).items.map((item) => item.fsId))
      .toEqual(["1"]);
    expect(search.query({ text: "物理/causal", offset: 0, limit: 50 }).items.map((item) => item.fsId))
      .toEqual(["3"]);
  });

  it("applies a boundary-safe folder prefix, modification filter, and requested page", () => {
    const search = new CatalogSearchService(fixture());

    expect(search.query({ text: "", folderPrefix: "/统计", offset: 0, limit: 1 })).toMatchObject({
      total: 2,
      offset: 0,
      limit: 1,
      items: [{ path: "/统计/因果推断.pdf" }],
    });
    expect(search.query({ text: "", folderPrefix: "/统计", offset: 1, limit: 1 })).toMatchObject({
      total: 2,
      offset: 1,
      limit: 1,
      items: [{ path: "/统计/现代因果分析.pdf" }],
    });
    expect(search.query({ text: "", modifiedAfter: 20, offset: 0, limit: 50 }).items.map((item) => item.fsId))
      .toEqual(["3", "4"]);
  });

  it("sorts stably and ignores directory records", () => {
    const search = new CatalogSearchService([...fixture()].reverse());

    expect(search.query({ text: "", offset: 0, limit: 50 }).items.map((item) => item.path)).toEqual([
      "/物理/Causal Inference.pdf",
      "/统计/因果推断.pdf",
      "/统计/现代因果分析.pdf",
      "/统计学/不应命中目录前缀.pdf",
    ]);
  });

  it("returns detached records and remains unchanged when inputs or results are mutated", () => {
    const records = fixture();
    const search = new CatalogSearchService(records);
    const first = search.query({ text: "9787030123456", offset: 0, limit: 50 });

    (first.items as CloudCatalogRecord[]).splice(0);
    (records[3] as { path: string }).path = "/已篡改.pdf";
    const second = search.query({ text: "9787030123456", offset: 0, limit: 50 });
    (second.items[0]?.isbnCandidates as string[]).push("0000000000");

    const third = search.query({ text: "9787030123456", offset: 0, limit: 50 });
    expect(third.items).toHaveLength(1);
    expect(third.items[0]).toMatchObject({
      path: "/统计/因果推断.pdf",
      isbnCandidates: ["703012345X", "9787030123456"],
    });
  });

  it("supports single-character and punctuation searches within the page cap", () => {
    const search = new CatalogSearchService(fixture());

    expect(search.query({ text: "因", offset: 0, limit: 1 })).toMatchObject({ total: 2, limit: 1 });
    expect(search.query({ text: "/", offset: 0, limit: 2 }).items).toHaveLength(2);
  });

  it.each([
    { text: "", offset: -1, limit: 1 },
    { text: "", offset: 0.5, limit: 1 },
    { text: "", offset: 0, limit: 0 },
    { text: "", offset: 0, limit: 51 },
    { text: "", offset: 0, limit: 1.5 },
    { text: "", offset: 0, limit: 1, modifiedAfter: -1 },
  ])("rejects an invalid page or time query: $offset/$limit", (query) => {
    expect(() => new CatalogSearchService(fixture()).query(query)).toThrow("invalid-catalog-query");
  });

  it("rejects a relative folder prefix", () => {
    expect(() => new CatalogSearchService(fixture()).query({
      text: "",
      folderPrefix: "统计",
      offset: 0,
      limit: 1,
    })).toThrow("invalid-scan-root");
  });
});
