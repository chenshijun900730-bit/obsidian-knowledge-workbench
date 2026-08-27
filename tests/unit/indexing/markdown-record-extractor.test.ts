import { describe, expect, it } from "vitest";
import { extractDocumentRecord } from "../../../src/indexing/markdown-record-extractor";
import { MAX_INDEX_HEADINGS, MAX_INDEX_TOKENS } from "../../../src/indexing/index-record-limits";

describe("extractDocumentRecord", () => {
  it("derives a stable record without persisting the raw body", async () => {
    const record = await extractDocumentRecord({
      path: "导入/Graphify/README.md",
      basename: "README",
      mtime: 10,
      size: 64,
      content: "---\ntitle: Graphify 指南\ntags: [AI]\nsource: https://example.com/guide\npassword: never-index\n---\n# 安装\nGraphify maps code.",
      frontmatter: { title: "Graphify 指南", tags: ["AI"], source: "https://example.com/guide", password: "never-index" },
      headings: ["安装"],
      outgoingLinks: ["notes/agent-reach.md"],
    });
    expect(record.title).toBe("Graphify 指南");
    expect(record.tokens).toContain("graphify");
    expect(record.tokens).toContain("指南");
    expect(record.tokens.length).toBeLessThanOrEqual(MAX_INDEX_TOKENS);
    expect(record.outgoingLinks).toEqual(["notes/agent-reach.md"]);
    expect(record.relationFields).toEqual({ source: "https://example.com/guide" });
    expect(record.tokens).not.toContain("password");
    expect(JSON.stringify(record)).not.toContain("never-index");
    expect(JSON.stringify(record)).not.toContain("maps code");
  });

  it("excludes initial YAML frontmatter from tokens", async () => {
    const record = await extractDocumentRecord({
      path: "frontmatter.md",
      basename: "frontmatter",
      mtime: 11,
      size: 64,
      content: "---\nprivate: yaml-only-secret\n---\nsafe body",
      frontmatter: { private: "yaml-only-secret" },
      headings: [],
      outgoingLinks: [],
    });

    expect(record.tokens).toContain("safe");
    expect(record.tokens).not.toContain("private");
    expect(record.tokens).not.toContain("yaml-only-secret");
  });

  it("drops tokens over 128 Unicode code points instead of retaining or chunking them", async () => {
    const atLimit = "a".repeat(128);
    const overLimit = "b".repeat(129);
    const record = await extractDocumentRecord({
      path: "limits.md",
      basename: "limits",
      mtime: 12,
      size: 512,
      content: `${atLimit} ${overLimit} safe`,
      frontmatter: {},
      headings: [],
      outgoingLinks: [],
    });

    expect(record.tokens).toContain(atLimit);
    expect(record.tokens).toContain("safe");
    expect(record.tokens).not.toContain(overLimit);
    expect(JSON.stringify(record)).not.toContain(overLimit);
  });

  it("bounds persisted search fields while preserving their highest-priority prefix", async () => {
    const headings = Array.from({ length: MAX_INDEX_HEADINGS + 8 }, (_, index) => `Heading ${index}`);
    const body = Array.from({ length: MAX_INDEX_TOKENS + 20 }, (_, index) => `token-${index} token-${index}`).join(" ");
    const record = await extractDocumentRecord({
      path: "bounded.md",
      basename: "bounded",
      mtime: 13,
      size: body.length,
      content: body,
      frontmatter: {},
      headings,
      outgoingLinks: [],
    });

    expect(record.headings).toEqual(headings.slice(0, MAX_INDEX_HEADINGS));
    expect(record.tokens).toHaveLength(MAX_INDEX_TOKENS);
  });
});
