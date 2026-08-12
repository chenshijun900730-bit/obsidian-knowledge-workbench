import { describe, expect, it } from "vitest";
import type { DocumentRecord } from "../../../src/core/types";
import { TodayService, type TodayInput } from "../../../src/today/today-service";

const DAY = 86_400_000;

const makeRecord = (
  { id, path, ...values }: Pick<DocumentRecord, "id" | "path"> & Partial<DocumentRecord>,
): DocumentRecord => ({
  id,
  path,
  basename: path.replace(/\.md$/u, ""),
  kind: "note",
  title: path.replace(/\.md$/u, ""),
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
  ...values,
});

const serviceAt = (now: number): TodayService => new TodayService({ now: () => now });

const makeRecords = (count: number): readonly DocumentRecord[] => Array.from(
  { length: count },
  (_, index) => makeRecord({
    id: String(index),
    path: `${index}.md`,
    title: `N${index}`,
    kind: index % 2 === 0 ? "unclassified" : "note",
    mtime: index,
  }),
);

const todayInput = (
  records: readonly DocumentRecord[],
  dismissals: TodayInput["dismissals"] = {},
): TodayInput => ({ records, suggestions: [], pins: {}, dismissals, lastOpened: {} });

describe("TodayService", () => {
  it("caps groups, exposes reasons, and expires dismissals after a note changes", () => {
    const now = 40 * DAY;
    const service = new TodayService({ now: () => now });
    const records = Array.from({ length: 10 }, (_, index) => makeRecord({
      id: String(index),
      path: `${index}.md`,
      title: `N${index}`,
      kind: "unclassified",
      mtime: now - index,
    }));

    const result = service.build({
      records,
      suggestions: [],
      pins: {},
      dismissals: {
        "0": { dismissedAt: now - DAY, mtime: now - 1 },
        "1": { dismissedAt: now - DAY, mtime: now - 1 },
      },
      lastOpened: {},
    });

    expect(result.newItems).toHaveLength(7);
    expect(result.newItems[0]?.reason).toBe("unclassified");
    expect(result.newItems.some((item) => item.id === "0")).toBe(true);
    expect(result.newItems.some((item) => item.id === "1")).toBe(false);
  });

  it("uses a linear 30-day recency score and clamps future activity", () => {
    const now = 40 * DAY;
    const records = [
      makeRecord({ id: "now", path: "now.md", kind: "unclassified", mtime: now }),
      makeRecord({ id: "middle", path: "middle.md", kind: "unclassified", mtime: now - 15 * DAY }),
      makeRecord({ id: "edge", path: "edge.md", kind: "unclassified", mtime: now - 30 * DAY }),
      makeRecord({ id: "future", path: "future.md", kind: "unclassified", mtime: now + DAY }),
    ];

    const result = serviceAt(now).build(todayInput(records));
    const scores = Object.fromEntries(result.newItems.map((item) => [item.id, item.score]));

    expect(scores).toMatchObject({ now: 600, middle: 550, edge: 500, future: 600 });
    expect(result.newItems.slice(0, 2).map((item) => item.id)).toEqual(["future", "now"]);
  });

  it("excludes old records unless a pin keeps them in their owned group", () => {
    const now = 40 * DAY;
    const records = [
      makeRecord({ id: "old-new", path: "old-new.md", kind: "unclassified", mtime: 0 }),
      makeRecord({ id: "old-new-pinned", path: "old-new-pinned.md", kind: "unclassified", mtime: 0 }),
      makeRecord({ id: "old-continue", path: "old-continue.md", kind: "note", mtime: 0 }),
      makeRecord({ id: "old-continue-pinned", path: "old-continue-pinned.md", kind: "note", mtime: 0 }),
    ];

    const result = serviceAt(now).build({
      ...todayInput(records),
      pins: { "old-new-pinned": 1, "old-continue-pinned": 1 },
    });

    expect(result.newItems).toMatchObject([
      { id: "old-new-pinned", reason: "pinned", score: 1_500 },
    ]);
    expect(result.continueItems).toMatchObject([
      { id: "old-continue-pinned", reason: "pinned", score: 1_000 },
    ]);
  });

  it("uses recent opens and edits for Continue with visible reasons", () => {
    const now = 40 * DAY;
    const records = [
      makeRecord({ id: "opened", path: "opened.md", kind: "note", mtime: 0 }),
      makeRecord({ id: "edited", path: "edited.md", kind: "reference", mtime: now - DAY }),
    ];

    const result = serviceAt(now).build({
      ...todayInput(records),
      lastOpened: { opened: now - DAY },
    });

    expect(result.continueItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "opened", reason: "recently-opened", explanation: "Opened recently" }),
      expect.objectContaining({ id: "edited", reason: "recently-edited", explanation: "Edited recently" }),
    ]));
  });

  it("orders by score, then activity time, then deterministic path order", () => {
    const now = 1_000;
    const records = [
      makeRecord({ id: "b", path: "b.md", mtime: 10 }),
      makeRecord({ id: "a", path: "a.md", mtime: 10 }),
      makeRecord({ id: "future-a", path: "future-a.md", mtime: now + 10 }),
      makeRecord({ id: "future-z", path: "future-z.md", mtime: now + 20 }),
    ];

    const forward = serviceAt(now).build(todayInput(records));
    const reversed = serviceAt(now).build(todayInput([...records].reverse()));

    expect(forward.continueItems.map((item) => item.id)).toEqual(["future-z", "future-a", "a", "b"]);
    expect(reversed.continueItems.map((item) => item.id)).toEqual(forward.continueItems.map((item) => item.id));
  });

  it("orders equal path ties by Unicode code point", () => {
    const records = [
      makeRecord({ id: "astral", path: "\u{10000}.md", mtime: 10 }),
      makeRecord({ id: "bmp", path: "\uE000.md", mtime: 10 }),
    ];

    const result = serviceAt(1_000).build(todayInput(records));

    expect(result.continueItems.map((item) => item.id)).toEqual(["bmp", "astral"]);
  });

  it.each([
    [{ dismissedAt: 0, mtime: 30 * DAY }, 30 * DAY, 31 * DAY, true],
    [{ dismissedAt: 0, mtime: 10 }, 11, DAY, true],
    [{ dismissedAt: 0, mtime: 10 }, 10, DAY, false],
  ] as const)("applies dismissal expiry", (dismissal, currentMtime, now, visible) => {
    const record = makeRecord({ id: "a", path: "a.md", title: "A", kind: "note", mtime: currentMtime });
    const result = serviceAt(now).build(todayInput([record], { a: dismissal }));
    expect(result.continueItems.some((item) => item.id === "a")).toBe(visible);
  });

  it("applies a live dismissal to New, Continue, and Next", () => {
    const now = 10 * DAY;
    const records = [
      makeRecord({ id: "new", path: "new.md", kind: "unclassified", mtime: now }),
      makeRecord({ id: "continue", path: "continue.md", kind: "note", mtime: now }),
      makeRecord({ id: "next", path: "next.md", kind: "reference", mtime: now }),
    ];
    const dismissals = Object.fromEntries(records.map((record) => [
      record.id,
      { dismissedAt: now - DAY, mtime: record.mtime },
    ]));

    const suggestions = [{
      suggestionId: "next-action",
      documentId: "next",
      confidence: "high" as const,
      impact: 100,
      explanation: "Hidden while dismissed",
      actionLabel: "Review",
    }];
    const baseline = serviceAt(now).build({ ...todayInput(records), suggestions });
    const result = serviceAt(now).build({ ...todayInput(records, dismissals), suggestions });

    expect(baseline.newItems.map((item) => item.id)).toContain("new");
    expect(baseline.continueItems.map((item) => item.id)).toContain("continue");
    expect(baseline.nextItems.map((item) => item.id)).toContain("next");
    expect(result).toEqual({ newItems: [], continueItems: [], nextItems: [] });
  });

  it("selects the highest raw finite impact before clamping its score", () => {
    const now = 10 * DAY;
    const records = [
      makeRecord({ id: "a", path: "a.md", title: "A", kind: "note", mtime: now }),
      makeRecord({ id: "hidden", path: "hidden.md", kind: "note", mtime: now }),
    ];
    const result = serviceAt(now).build({
      ...todayInput(records, { hidden: { dismissedAt: now - DAY, mtime: now } }),
      suggestions: [
        { suggestionId: "medium", documentId: "a", confidence: "medium", impact: 1_000, explanation: "Medium", actionLabel: "Review" },
        { suggestionId: "dismissed", documentId: "hidden", confidence: "high", impact: 1_000, explanation: "Hidden", actionLabel: "Review" },
        { suggestionId: "z-high", documentId: "a", confidence: "high", impact: 1_000, explanation: "Highest raw impact", actionLabel: "Preview move" },
        { suggestionId: "a-clamped", documentId: "a", confidence: "high", impact: 100, explanation: "Lower raw impact", actionLabel: "Review" },
        { suggestionId: "low-impact", documentId: "a", confidence: "high", impact: 20, explanation: "First", actionLabel: "Review" },
      ],
    });

    expect(result.nextItems).toHaveLength(1);
    expect(result.nextItems[0]).toMatchObject({
      suggestionId: "z-high",
      explanation: "Highest raw impact",
      actionLabel: "Preview move",
      reason: "high-confidence-suggestion",
      score: 500,
    });
  });

  it("orders equal raw suggestion impacts by Unicode code-point ID", () => {
    const now = 10 * DAY;
    const record = makeRecord({ id: "a", path: "a.md", kind: "note", mtime: now });
    const result = serviceAt(now).build({
      ...todayInput([record]),
      suggestions: [
        { suggestionId: "\u{10000}", documentId: "a", confidence: "high", impact: 50, explanation: "Astral", actionLabel: "Review" },
        { suggestionId: "\uE000", documentId: "a", confidence: "high", impact: 50, explanation: "BMP", actionLabel: "Review" },
      ],
    });

    expect(result.nextItems[0]?.suggestionId).toBe("\uE000");
  });

  it("ignores non-finite suggestion impacts without producing a non-finite score", () => {
    const now = 10 * DAY;
    const record = makeRecord({ id: "a", path: "a.md", kind: "note", mtime: now });
    const result = serviceAt(now).build({
      ...todayInput([record]),
      suggestions: [
        { suggestionId: "nan", documentId: "a", confidence: "high", impact: Number.NaN, explanation: "NaN", actionLabel: "Review" },
        { suggestionId: "infinity", documentId: "a", confidence: "high", impact: Number.POSITIVE_INFINITY, explanation: "Infinity", actionLabel: "Review" },
        { suggestionId: "negative-infinity", documentId: "a", confidence: "high", impact: Number.NEGATIVE_INFINITY, explanation: "Negative infinity", actionLabel: "Review" },
        { suggestionId: "valid", documentId: "a", confidence: "high", impact: 20, explanation: "Valid", actionLabel: "Review" },
      ],
    });

    expect(result.nextItems[0]?.suggestionId).toBe("valid");
    expect(Number.isFinite(result.nextItems[0]?.score)).toBe(true);
  });

  it("caps every group, accepts no AI input, and leaves caller data unchanged", () => {
    const records = Object.freeze(makeRecords(30).map((record) => Object.freeze(record)));
    const suggestions = Object.freeze(records.map((record, index) => Object.freeze({
      suggestionId: `suggestion-${String(index).padStart(2, "0")}`,
      documentId: record.id,
      confidence: "high" as const,
      impact: index,
      explanation: "Local suggestion",
      actionLabel: "Review",
    })));
    const input: TodayInput = Object.freeze({
      records,
      suggestions,
      pins: Object.freeze({ "0": 1 }),
      dismissals: Object.freeze({}),
      lastOpened: Object.freeze({ "1": 999 }),
    });
    const snapshot = structuredClone(input);

    const result = serviceAt(1_000).build(input);

    expect(result.newItems).toHaveLength(7);
    expect(result.continueItems).toHaveLength(7);
    expect(result.nextItems).toHaveLength(1);
    expect("ai" in result).toBe(false);
    expect(input).toEqual(snapshot);
  });
});
