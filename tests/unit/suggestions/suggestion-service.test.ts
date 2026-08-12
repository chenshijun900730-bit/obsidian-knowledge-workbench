import { describe, expect, it } from "vitest";
import { buildConfirmedRelationCandidates, SuggestionService } from "../../../src/suggestions/suggestion-service";
import { suggestionFixture, suggestionRecord } from "../../helpers/suggestion-fixtures";

describe("SuggestionService", () => {
  it("never turns duplicates or empty files into delete or merge operations", () => {
    const records = [
      suggestionRecord("a", "a.md", { contentHash: "same", size: 0 }),
      suggestionRecord("b", "b.md", { contentHash: "same", size: 0 }),
    ];
    const result = new SuggestionService().generate({ records, classifications: {}, folderRules: [], relations: [] });
    expect(result.findings.map((value) => value.kind)).toEqual(expect.arrayContaining(["duplicate-content", "empty-file"]));
    const allowed = new Set(["move", "rename", "set-owned-field", "add-related-link"]);
    expect(result.operations.every((value) => allowed.has(value.kind))).toBe(true);
  });

  it("generates all four explainable operations from independent records", () => {
    const fixture = suggestionFixture();
    const result = fixture.service.generate(fixture.input);
    expect(result.operations.map((value) => value.kind)).toEqual(expect.arrayContaining([
      "move", "rename", "set-owned-field", "add-related-link",
    ]));
    expect(result.suggestions.every((value) => (
      value.rationale.summary.length > 0
      && value.rationale.signals.length > 0
      && Number.isFinite(value.rationale.impact)
      && value.rationale.impact >= 0
    ))).toBe(true);
  });

  it("uses precedence, one operation per document, stable tuple IDs, and no input mutation", () => {
    const fixture = suggestionFixture();
    const record = suggestionRecord("both", "Inbox/Untitled.md", {
      kind: "reference",
      title: "Better",
      ownedFields: { "knowledge-workbench-kind": "reference" },
    });
    const input = {
      ...fixture.input,
      records: [...fixture.input.records, record],
      classifications: { ...fixture.input.classifications, both: { kind: "reference" as const, reason: "explicit-property" } },
    };
    const before = structuredClone(input);
    const first = fixture.service.generate(input);
    const reversed = fixture.service.generate({ ...input, records: [...input.records].reverse(), relations: [...input.relations].reverse() });
    expect(first.suggestions.filter((value) => value.operation.id.includes("both"))).toHaveLength(0);
    expect(first.operations.filter((value) => value.kind === "move" && value.sourcePath === "Inbox/Untitled.md")).toHaveLength(1);
    expect(first).toEqual(reversed);
    expect(input).toEqual(before);
    expect(new Set(first.operations.map((value) => value.id)).size).toBe(first.operations.length);
  });

  it("sanitizes rename targets and skips reserved, occupied, source, and case-colliding targets", () => {
    const service = new SuggestionService();
    const records = [
      suggestionRecord("good", "Inbox/Untitled.md", { title: "  Good: Title... " }),
      suggestionRecord("reserved", "Inbox/README.md", { title: "CON" }),
      suggestionRecord("occupied", "Other/Note.md", { title: "Taken" }),
      suggestionRecord("taken", "Other/taken.md", { title: "taken" }),
    ];
    const result = service.generate({ records, classifications: {}, folderRules: [], relations: [] });
    expect(result.operations).toContainEqual(expect.objectContaining({ kind: "rename", targetPath: "Inbox/Good- Title.md" }));
    expect(result.operations.some((value) => value.id.includes("reserved"))).toBe(false);
    expect(result.operations.some((value) => value.id.includes("occupied"))).toBe(false);
  });

  it("reserves structural targets globally and falls through to a later safe candidate", () => {
    const records = [
      suggestionRecord("first", "Inbox/Note.md", { title: "Shared" }),
      suggestionRecord("second", "Inbox/README.md", {
        title: "Shared",
        ownedFields: { "knowledge-workbench-related": [] },
      }),
      suggestionRecord("target", "Target.md", { kind: "note" }),
    ];
    const relations = [{
      sourceId: "second", targetId: "target", score: 80,
      reasons: [{ code: "explicit-link" as const, weight: 80 }], confirmed: true,
    }];
    const result = new SuggestionService().generate({ records, classifications: {}, folderRules: [], relations });
    expect(result.operations.filter((value) => value.kind === "rename")).toHaveLength(1);
    expect(result.operations).toContainEqual(expect.objectContaining({ kind: "add-related-link", path: "Inbox/README.md" }));
  });

  it("lets AI replace display text only and never raise safety metrics", () => {
    const fixture = suggestionFixture();
    const local = fixture.service.generate(fixture.input);
    const assisted = new SuggestionService(() => ({
      source: "ai-assisted",
      summary: "Clearer wording",
      signals: ["invented"],
      confidence: "high",
      impact: Number.POSITIVE_INFINITY,
    })).generate(fixture.input);
    expect(assisted.operations).toEqual(local.operations);
    expect(assisted.suggestions.map((value) => value.localRationale)).toEqual(
      local.suggestions.map((value) => value.rationale),
    );
    expect(assisted.suggestions.map((value) => ({
      source: value.rationale.source,
      summary: value.rationale.summary,
      signals: value.rationale.signals,
      confidence: value.rationale.confidence,
      impact: value.rationale.impact,
    }))).toEqual(local.suggestions.map((value) => ({
      source: "ai-assisted",
      summary: "Clearer wording",
      signals: value.rationale.signals,
      confidence: value.rationale.confidence,
      impact: value.rationale.impact,
    })));
  });

  it("freezes operation payloads before enhancer callbacks and falls back locally on mutation errors", () => {
    const fixture = suggestionFixture();
    const expected = new SuggestionService().generate(fixture.input);
    const attacked = new SuggestionService((_local, operation) => {
      const mutable = operation as unknown as Record<string, unknown>;
      let mutationFailed = false;
      const attempt = (mutation: () => void): void => {
        try { mutation(); } catch { mutationFailed = true; }
      };
      attempt(() => { mutable.kind = "rename"; });
      attempt(() => {
        if ("sourcePath" in operation) mutable.sourcePath = "Hijacked.md";
        else mutable.path = "Hijacked.md";
      });
      if ("targetPath" in operation) attempt(() => { mutable.targetPath = "Hijacked-target.md"; });
      if ("before" in operation) {
        attempt(() => { mutable.before = { present: false }; });
        attempt(() => { mutable.after = { present: true, value: ["[[Hijacked]]"] }; });
      }
      if (mutationFailed) throw new Error("Frozen operation rejected enhancer mutation");
      return { source: "ai-assisted", summary: "Hijacked" };
    }).generate(fixture.input);
    expect(attacked.operations).toEqual(expected.operations);
    expect(attacked.operations.some((operation) => JSON.stringify(operation).includes("Hijacked"))).toBe(false);
    expect(attacked.suggestions.every((suggestion) => (
      Object.isFrozen(suggestion.operation)
      && Object.isFrozen(suggestion.localRationale)
      && Object.isFrozen(suggestion.localRationale.signals)
      && (!("before" in suggestion.operation) || (
        Object.isFrozen(suggestion.operation.before)
        && Object.isFrozen(suggestion.operation.after)
        && (!suggestion.operation.after.present
          || typeof suggestion.operation.after.value === "string"
          || Object.isFrozen(suggestion.operation.after.value))
      ))
      && suggestion.rationale.source === "local"
    ))).toBe(true);
  });

  it.each(["source", "summary"] as const)(
    "fails closed when an enhancer returns a hostile %s getter",
    (throwingProperty) => {
      const fixture = suggestionFixture();
      const expected = new SuggestionService().generate(fixture.input);
      const hostile = new SuggestionService(() => {
        const value: Record<string, unknown> = throwingProperty === "summary"
          ? { source: "ai-assisted" }
          : {};
        Object.defineProperty(value, throwingProperty, {
          enumerable: true,
          get: () => { throw new Error(`hostile ${throwingProperty}`); },
        });
        return value;
      });
      let result: ReturnType<SuggestionService["generate"]> | undefined;
      expect(() => { result = hostile.generate(fixture.input); }).not.toThrow();
      expect(result?.operations).toEqual(expected.operations);
      expect(result?.suggestions.every((suggestion) => suggestion.rationale === suggestion.localRationale)).toBe(true);
    },
  );

  it("ignores high-scoring relations that are not confirmed", () => {
    const records = [suggestionRecord("a", "A.md"), suggestionRecord("b", "B.md")];
    const result = new SuggestionService().generate({
      records,
      classifications: {},
      folderRules: [],
      relations: [{
        sourceId: "a",
        targetId: "b",
        score: 100,
        reasons: [{ code: "token-overlap", weight: 100 }],
        confirmed: false,
      }],
    });
    expect(result.operations.filter((value) => value.kind === "add-related-link")).toEqual([]);
  });

  it("indexes strongest confirmed relations in one edge pass instead of rescanning per record", () => {
    const records = Array.from({ length: 200 }, (_, index) => suggestionRecord(`id-${index}`, `Notes/${index}.md`));
    let scoreReads = 0;
    const relations = records.slice(1).map((record, index) => {
      const edge = {
        sourceId: records[0]!.id,
        targetId: record.id,
        reasons: [{ code: "explicit-link" as const, weight: 80 }],
        confirmed: true,
      };
      Object.defineProperty(edge, "score", {
        enumerable: true,
        get: () => {
          scoreReads += 1;
          return 80 + (index % 10);
        },
      });
      return edge as typeof edge & { readonly score: number };
    });
    new SuggestionService().generate({ records, classifications: {}, folderRules: [], relations });
    expect(scoreReads).toBeLessThanOrEqual(relations.length * 3);
  });

  it("builds center-independent candidates only from explicit links and confirmed topics", () => {
    const records = [
      suggestionRecord("a", "A.md", { outgoingLinks: ["B.md"] }),
      suggestionRecord("b", "B.md"),
      suggestionRecord("c", "C.md", { ownedFields: { "knowledge-workbench-topics": ["Systems"] } }),
      suggestionRecord("d", "D.md", { ownedFields: { "knowledge-workbench-topics": ["systems"] } }),
    ];
    const candidates = buildConfirmedRelationCandidates(records);
    expect(candidates.map((value) => [value.sourceId, value.targetId])).toEqual([["a", "b"], ["c", "d"]]);
    expect(candidates.every((value) => value.confirmed && value.score >= 80)).toBe(true);
  });

  it("keeps a large confirmed-topic bucket linear with a deterministic star", () => {
    const records = Array.from({ length: 100 }, (_, index) => suggestionRecord(
      `id-${String(index).padStart(3, "0")}`,
      `Topic/${String(index).padStart(3, "0")}.md`,
      { ownedFields: { "knowledge-workbench-topics": ["Shared"] } },
    ));
    const candidates = buildConfirmedRelationCandidates([...records].reverse());
    expect(candidates).toHaveLength(99);
    expect(candidates.every((value) => value.sourceId === "id-000" || value.targetId === "id-000")).toBe(true);
    expect(new Set(candidates.flatMap((value) => [value.sourceId, value.targetId])).size).toBe(100);
  });

  it("builds an explicit-link star without rescanning the hub links for every pair", () => {
    const size = 200;
    const targets = Array.from({ length: size - 1 }, (_, index) => `Leaf-${index}.md`);
    let linkProbes = 0;
    const outgoingLinks = new Proxy(targets, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) linkProbes += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const records = [
      suggestionRecord("hub", "Hub.md", { outgoingLinks }),
      ...targets.map((path, index) => suggestionRecord(`leaf-${index}`, path)),
    ];
    const candidates = buildConfirmedRelationCandidates(records);
    expect(candidates).toHaveLength(size - 1);
    expect(candidates.every((candidate) => candidate.reasons.some((reason) => reason.code === "explicit-link"))).toBe(true);
    expect(linkProbes).toBeLessThanOrEqual((size - 1) * 3);
  });
});
