import { describe, expect, it } from "vitest";

import { RelationScorer } from "../../../src/map/relation-scorer";

const record = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  path: `${id}.md`,
  basename: id,
  title: id,
  kind: "note",
  aliases: [],
  headings: [],
  tags: [],
  ownedFields: {},
  relationFields: {},
  outgoingLinks: [],
  tokens: [],
  mtime: 0,
  size: 1,
  contentHash: id,
  ...overrides,
}) as never;

describe("RelationScorer", () => {
  it("orders explicit links above shared tags", () => {
    const scorer = new RelationScorer();
    const explicit = scorer.score(record("A", { outgoingLinks: ["B.md"] }), record("B"));
    const sharedTag = scorer.score(record("A", { tags: ["AI"] }), record("B", { tags: ["AI"] }));

    expect(explicit.total).toBeGreaterThan(sharedTag.total);
    expect(explicit.reasons[0]?.code).toBe("explicit-link");
  });

  it.each([
    ["explicit-link", { outgoingLinks: ["B.md"] }, {}, 100],
    [
      "confirmed-topic",
      { ownedFields: { "knowledge-workbench-topics": [" AI "] } },
      { ownedFields: { "knowledge-workbench-topics": ["ai"] } },
      80,
    ],
    ["shared-tag", { tags: [" AI "] }, { tags: ["ai"] }, 60],
    [
      "compatible-frontmatter",
      { relationFields: { author: "Ada" } },
      { relationFields: { author: "ada" } },
      55,
    ],
    [
      "source-proximity",
      { relationFields: { source: "https://EXAMPLE.com/a" } },
      { relationFields: { source: "http://example.com/b" } },
      45,
    ],
    ["same-folder", { path: "x/a.md" }, { path: "x/b.md" }, 40],
    ["token-overlap", { tokens: ["same"] }, { tokens: ["same"] }, 20],
  ] as const)("scores exactly one %s signal", (code, left, right, weight) => {
    const score = new RelationScorer().score(record("A", left), record("B", right));

    expect(score).toEqual({ total: weight, reasons: [{ code, weight }] });
  });

  it("returns all contributing reasons once in fixed descending order", () => {
    const left = record("A", {
      path: "folder/A.md",
      outgoingLinks: ["folder/B.md", "folder/B.md"],
      ownedFields: { "knowledge-workbench-topics": ["AI", "tools"] },
      tags: ["map", "map"],
      relationFields: {
        author: ["Ada", "ADA"],
        domain: "example.org",
        type: "guide",
        source: "https://example.com/left",
      },
      tokens: ["same", "same"],
    });
    const right = record("B", {
      path: "folder/B.md",
      ownedFields: { "knowledge-workbench-topics": ["ai", "AI"] },
      tags: ["MAP"],
      relationFields: {
        author: "ada",
        domain: "EXAMPLE.ORG",
        type: "GUIDE",
        source: "https://EXAMPLE.com/right",
      },
      tokens: ["same", "same", "same"],
    });

    expect(new RelationScorer().score(left, right)).toEqual({
      total: 400,
      reasons: [
        { code: "explicit-link", weight: 100 },
        { code: "confirmed-topic", weight: 80 },
        { code: "shared-tag", weight: 60 },
        { code: "compatible-frontmatter", weight: 55 },
        { code: "source-proximity", weight: 45 },
        { code: "same-folder", weight: 40 },
        { code: "token-overlap", weight: 20 },
      ],
    });
  });

  it("deduplicates token sets so repeated tokens never exceed 20", () => {
    const score = new RelationScorer().score(
      record("A", { tokens: ["same", "same", "same"] }),
      record("B", { tokens: ["same", "same"] }),
    );

    expect(score).toEqual({ total: 20, reasons: [{ code: "token-overlap", weight: 20 }] });
  });

  it("normalizes text with trim, NFC, and en-US case folding", () => {
    const decomposed = "Cafe\u0301";
    const composed = "CAFÉ";
    const score = new RelationScorer().score(
      record("A", {
        ownedFields: { "knowledge-workbench-topics": [` ${decomposed} `] },
        tags: [` ${decomposed} `],
        relationFields: { author: ` ${decomposed} ` },
      }),
      record("B", {
        ownedFields: { "knowledge-workbench-topics": [composed] },
        tags: [composed],
        relationFields: { author: composed },
      }),
    );

    expect(score.reasons).toEqual([
      { code: "confirmed-topic", weight: 80 },
      { code: "shared-tag", weight: 60 },
      { code: "compatible-frontmatter", weight: 55 },
    ]);
  });

  it("normalizes resolved link slashes and NFC while preserving path case", () => {
    const normalized = new RelationScorer().score(
      record("A", { outgoingLinks: ["folder\\Cafe\u0301.md"] }),
      record("B", { path: "folder/Café.md" }),
    );
    const caseMismatch = new RelationScorer().score(
      record("A", { outgoingLinks: ["folder/b.md"] }),
      record("B", { path: "folder/B.md" }),
    );

    expect(normalized.reasons).toContainEqual({ code: "explicit-link", weight: 100 });
    expect(caseMismatch.reasons).not.toContainEqual({ code: "explicit-link", weight: 100 });
  });

  it("matches a resolved outgoing path independently of the destination title", () => {
    const score = new RelationScorer().score(
      record("A", { outgoingLinks: ["folder/B.md"] }),
      record("B", { path: "folder/B.md", title: "A completely different heading" }),
    );

    expect(score.reasons).toContainEqual({ code: "explicit-link", weight: 100 });
  });

  it("does not infer source proximity from empty-hostname or non-HTTP values", () => {
    const emptyHostname = new RelationScorer().score(
      record("A", { relationFields: { source: "file:///left.md" } }),
      record("B", { relationFields: { source: "file:///right.md" } }),
    );
    const arbitraryText = new RelationScorer().score(
      record("A", { relationFields: { source: "same source" } }),
      record("B", { relationFields: { source: "same source" } }),
    );

    expect(emptyHostname.reasons).not.toContainEqual({ code: "source-proximity", weight: 45 });
    expect(arbitraryText.reasons).not.toContainEqual({ code: "source-proximity", weight: 45 });
  });

  it("ignores frontmatter keys outside the author-domain-type allowlist", () => {
    const score = new RelationScorer().score(
      record("A", { relationFields: { status: "same" } }),
      record("B", { relationFields: { status: "same" } }),
    );

    expect(score.reasons).not.toContainEqual({ code: "compatible-frontmatter", weight: 55 });
  });

  it("is symmetric and omits self relations", () => {
    const left = record("A", { tags: ["shared"], tokens: ["x", "y"] });
    const right = record("B", { tags: ["shared"], tokens: ["y"] });
    const scorer = new RelationScorer();

    expect(scorer.score(left, right)).toEqual(scorer.score(right, left));
    expect(scorer.score(left, left)).toEqual({ total: 0, reasons: [] });
  });
});
