import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CatalogTxtParser,
  type CatalogTxtByteSource,
} from "../../../src/catalog/catalog-txt-parser";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  HybridCatalogError,
  type TxtCandidateRecordV1,
} from "../../../src/catalog/hybrid-catalog-types";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const source = (
  value: string,
  cuts: readonly number[] = [],
  declaredSize = bytes(value).byteLength,
): CatalogTxtByteSource => ({
  byteSize: declaredSize,
  chunks: async function* () {
    const encoded = bytes(value);
    let offset = 0;
    for (const cut of [...cuts, encoded.length]) {
      if (cut > offset) yield encoded.slice(offset, cut);
      offset = cut;
    }
  },
});

const parse = async (input: CatalogTxtByteSource): Promise<Readonly<{
  records: readonly TxtCandidateRecordV1[];
  summary: Awaited<ReturnType<CatalogTxtParser["parse"]>>;
}>> => {
  const records: TxtCandidateRecordV1[] = [];
  const summary = await new CatalogTxtParser().parse({
    source: input,
    onCandidate: async (record) => { records.push(record); },
  });
  return { records, summary };
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("CatalogTxtParser", () => {
  it("infers directories and emits deterministic candidates across UTF-8 chunk boundaries", async () => {
    const text = [
      "├── Synthétique",
      "│   ├── A.pdf",
      "│   ├── Nested",
      "│   │   └── 中文.PDF",
      "│   └── ignored.txt",
      "└── Root.pdf",
    ].join("\n");
    const encoded = bytes(text);
    const insideChinese = encoded.indexOf(0xe4) + 1;
    const { records, summary } = await parse(source(text, [5, 17, insideChinese]));

    expect(summary).toEqual({
      sourceSha256: sha256(text),
      byteSize: encoded.byteLength,
      nonEmptyLineCount: 6,
      pdfCount: 3,
      directoryCount: 2,
      ignoredLeafCount: 1,
      normalizedWhitespaceCount: 0,
      maxDepth: 3,
    });
    expect(records.map((record) => record.relativePath)).toEqual([
      "Synthétique/A.pdf",
      "Synthétique/Nested/中文.PDF",
      "Root.pdf",
    ]);
    expect(records[0]).toMatchObject({
      candidateId: `txt:${sha256("Synthétique/A.pdf")}`,
      topLevelGroupId: `group:${sha256("Synthétique")}`,
      hierarchyTags: ["folder/Synthétique"],
    });
    expect(records[1]?.hierarchyTags).toEqual([
      "folder/Synthétique",
      "folder/Nested",
    ]);
    expect(records[2]).toMatchObject({
      parentRelativePath: "",
      topLevelGroupId: "txt-root-items",
      hierarchyTags: [],
    });
  });

  it("accepts CRLF, ignores blank lines, normalizes NFC, and counts trimmed names", async () => {
    const text = [
      "├── Cafe\u0301  ",
      "│   ├──  Book.pdf ",
      "",
    ].join("\r\n");
    const { records, summary } = await parse(source(text));

    expect(records.map((record) => record.relativePath)).toEqual(["Café/Book.pdf"]);
    expect(summary).toMatchObject({
      nonEmptyLineCount: 2,
      pdfCount: 1,
      directoryCount: 1,
      normalizedWhitespaceCount: 2,
      maxDepth: 2,
    });
  });

  it("extracts filename ISBN candidates without claiming verification", async () => {
    const { records } = await parse(source("├── Book 978-7-03-012345-6.pdf\n"));
    expect(records[0]?.isbnCandidates).toEqual(["9787030123456"]);
  });

  it.each([
    ["depth jump", "├── A\n│   │   └── B.pdf\n", "txt-tree-invalid"],
    ["PDF parent", "├── A.pdf\n│   └── B.pdf\n", "txt-tree-invalid"],
    ["missing parent", "│   └── B.pdf\n", "txt-tree-invalid"],
    ["bad marker", "A.pdf\n", "txt-tree-invalid"],
    ["empty name", "├──    \n", "txt-tree-invalid"],
    ["forward slash", "├── A/B.pdf\n", "txt-tree-invalid"],
    ["backslash", "├── A\\B.pdf\n", "txt-tree-invalid"],
    ["control", "├── A\u0000.pdf\n", "txt-tree-invalid"],
    ["no PDFs", "├── ignored.txt\n", "txt-tree-invalid"],
  ] as const)("fails closed for %s", async (_label, text, code) => {
    await expect(parse(source(text))).rejects.toEqual(new HybridCatalogError(code));
  });

  it("rejects duplicate normalized PDF paths before emitting the second record", async () => {
    const emitted: TxtCandidateRecordV1[] = [];
    const parser = new CatalogTxtParser();
    await expect(parser.parse({
      source: source("├── Café.pdf\n├── Cafe\u0301.pdf\n"),
      onCandidate: async (record) => { emitted.push(record); },
    })).rejects.toEqual(new HybridCatalogError("txt-duplicate-path"));
    expect(emitted).toHaveLength(1);
  });

  it("rejects invalid UTF-8 and a declared-size mismatch without leaking bytes", async () => {
    const invalidUtf8: CatalogTxtByteSource = {
      byteSize: 2,
      chunks: async function* () { yield Uint8Array.from([0xc3, 0x28]); },
    };
    await expect(parse(invalidUtf8)).rejects.toEqual(
      new HybridCatalogError("txt-source-invalid"),
    );
    await expect(parse(source("├── A.pdf\n", [], 999))).rejects.toEqual(
      new HybridCatalogError("txt-source-invalid"),
    );
  });

  it("rejects an oversized declared source before consuming it", async () => {
    const chunks = vi.fn(async function* () { yield bytes("├── A.pdf\n"); });
    await expect(parse({
      byteSize: CATALOG_TXT_IMPORT_BUDGET.maxBytes + 1,
      chunks,
    })).rejects.toEqual(new HybridCatalogError("txt-import-budget-exceeded"));
    expect(chunks).not.toHaveBeenCalled();
  });

  it("enforces line, depth, line-count, and PDF-count budgets", async () => {
    const overlong = `├── ${"A".repeat(CATALOG_TXT_IMPORT_BUDGET.maxLineBytes)}.pdf\n`;
    const tooDeep = `${"│   ".repeat(CATALOG_TXT_IMPORT_BUDGET.maxDepth)}└── A.pdf\n`;
    const tooManyPdfs = Array.from(
      { length: CATALOG_TXT_IMPORT_BUDGET.maxPdfCount + 1 },
      (_, index) => `├── P${index}.pdf`,
    ).join("\n");
    const tooManyLines = Array.from(
      { length: CATALOG_TXT_IMPORT_BUDGET.maxNonEmptyLineCount + 1 },
      (_, index) => `├── ignored-${index}.txt`,
    ).join("\n");

    for (const text of [overlong, tooDeep, tooManyPdfs, tooManyLines]) {
      await expect(parse(source(text))).rejects.toEqual(
        new HybridCatalogError("txt-import-budget-exceeded"),
      );
    }
  });

  it("awaits candidate sinks in source order", async () => {
    const calls: string[] = [];
    await new CatalogTxtParser().parse({
      source: source("├── A.pdf\n├── B.pdf\n"),
      onCandidate: async (record) => {
        await Promise.resolve();
        calls.push(record.filename);
      },
    });
    expect(calls).toEqual(["A.pdf", "B.pdf"]);
  });
});
