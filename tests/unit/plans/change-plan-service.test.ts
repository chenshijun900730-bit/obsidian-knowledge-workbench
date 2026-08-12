import { describe, expect, it } from "vitest";
import type { PlannedOperation } from "../../../src/core/types";
import {
  ChangePlanService,
  evaluatePlanSelection,
  isChangePlanSchema,
  verifyPlanFingerprint,
  type PlanConflict,
} from "../../../src/plans/change-plan-service";
import { FakeVault } from "../../fakes/fake-vault";
import { SuggestionService } from "../../../src/suggestions/suggestion-service";
import { suggestionFixture } from "../../helpers/suggestion-fixtures";
import { refingerprintPlan } from "../../helpers/plan-fixtures";

const move = (id: string, sourcePath: string, targetPath: string): PlannedOperation => ({
  id, kind: "move", sourcePath, targetPath,
});

describe("ChangePlanService", () => {
  it("blocks inbound links, metadata gaps, missing sources, and write lock", async () => {
    let enabled = true;
    const vault = FakeVault.withNotes(["source.md", "linked.md"]);
    vault.setInboundLinks("source.md", ["linked.md"]);
    const service = new ChangePlanService(vault, () => enabled);
    const preview = await service.preview([move("1", "source.md", "资料库/source.md")]);
    expect(preview.conflicts).toContainEqual({ operationId: "1", code: "inbound-links", paths: ["linked.md"] });
    await expect(service.confirm(preview, ["1"])).rejects.toThrow("Plan has blocking conflicts");
    vault.setInboundLinks("source.md", []);
    vault.setMetadataReady(false);
    expect((await service.preview([move("meta", "source.md", "archive/source.md")])).conflicts)
      .toContainEqual({ operationId: "meta", code: "metadata-not-ready", paths: ["source.md"] });
    vault.setMetadataReady(true);
    expect((await service.preview([move("missing", "missing.md", "archive/missing.md")])).conflicts)
      .toContainEqual({ operationId: "missing", code: "source-missing", paths: ["missing.md"] });
    enabled = false;
    await expect(service.confirm(await service.preview([move("safe", "source.md", "archive/source.md")]), ["safe"]))
      .rejects.toThrow("Write operations are locked");
  });

  it("makes duplicate targets and mutation overlaps selection-aware", async () => {
    const vault = FakeVault.withNotes(["a.md", "b.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([
      move("a", "a.md", "archive/item.md"),
      move("b", "b.md", "Archive/ITEM.md"),
    ]);
    expect(preview.conflicts.filter((value) => value.code === "duplicate-target")).toHaveLength(2);
    await expect(service.confirm(preview, ["a", "b"])).rejects.toThrow("Plan has blocking conflicts");
    await expect(service.confirm(preview, ["a"])).resolves.toMatchObject({ operations: [{ id: "a" }] });

    const fields = await service.preview([
      { id: "kind", kind: "set-owned-field", path: "a.md", field: "knowledge-workbench-kind", before: { present: false }, after: { present: true, value: "note" } },
      { id: "topic", kind: "set-owned-field", path: "a.md", field: "knowledge-workbench-topics", before: { present: false }, after: { present: true, value: ["AI"] } },
    ]);
    expect(evaluatePlanSelection(fields, ["kind", "topic"]).blockingConflicts.some((value) => value.code === "overlapping-operation")).toBe(true);
    expect(evaluatePlanSelection(fields, ["kind"]).blockingConflicts).toEqual([]);
  });

  it("treats add-related targets as dependencies, not mutations", async () => {
    const vault = FakeVault.withNotes(["a.md", "b.md", "target.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([
      { id: "a", kind: "add-related-link", path: "a.md", targetPath: "target.md", before: { present: false }, after: { present: true, value: ["[[target]]"] } },
      { id: "b", kind: "add-related-link", path: "b.md", targetPath: "target.md", before: { present: false }, after: { present: true, value: ["[[target]]"] } },
    ]);
    expect(preview.conflicts.some((value) => value.code === "overlapping-operation")).toBe(false);
    await expect(service.confirm(preview, ["a", "b"])).resolves.toMatchObject({ operations: [{ id: "a" }, { id: "b" }] });
  });

  it("validates owned state and exact add-related semantics", async () => {
    const vault = FakeVault.withNotes(["a.md", "target.md"]);
    vault.setOwnedFieldExternally("a.md", "knowledge-workbench-kind", { present: true, value: "reference" });
    const service = new ChangePlanService(vault, () => true);
    const stale = await service.preview([{ id: "kind", kind: "set-owned-field", path: "a.md", field: "knowledge-workbench-kind", before: { present: false }, after: { present: true, value: "note" } }]);
    expect(stale.conflicts).toContainEqual({ operationId: "kind", code: "owned-field-drift", paths: ["a.md"] });
    const dangling = await service.preview([{ id: "link", kind: "add-related-link", path: "a.md", targetPath: "missing.md", before: { present: false }, after: { present: true, value: ["[[missing]]"] } }]);
    expect(dangling.conflicts).toContainEqual({ operationId: "link", code: "related-target-missing", paths: ["missing.md"] });
    const invalid = await service.preview([{ id: "bad", kind: "add-related-link", path: "a.md", targetPath: "target.md", before: { present: false }, after: { present: true, value: ["[[other]]"] } }]);
    expect(invalid.conflicts).toContainEqual({ operationId: "bad", code: "owned-field-drift", paths: ["a.md"] });
  });

  it("canonicalizes paths, deduplicates dependencies, freezes output, and detects preview-time drift", async () => {
    const vault = FakeVault.withNotes(["source.md"]);
    let snapshotCalls = 0;
    const drifting = new Proxy(vault, {
      get(target, property, receiver) {
        if (property !== "snapshot") return Reflect.get(target, property, receiver) as unknown;
        return async (path: string) => {
          snapshotCalls += 1;
          if (snapshotCalls === 3) target.modifyExternally("source.md");
          return await target.snapshot(path);
        };
      },
    });
    const service = new ChangePlanService(drifting, () => true);
    const preview = await service.preview([move("move", ".\\source.md", "./Archive\\source.md")]);
    expect(preview.plan.operations[0]).toMatchObject({ sourcePath: "source.md", targetPath: "Archive/source.md" });
    expect(preview.plan.preconditions.map((value) => value.path)).toEqual(["Archive/source.md", "source.md"]);
    expect(preview.conflicts.some((value) => value.code === "precondition-drift")).toBe(true);
    expect(Object.isFrozen(preview) && Object.isFrozen(preview.plan.operations)).toBe(true);
  });

  it("rejects forged, duplicate, unknown, and tampered previews and fingerprints", async () => {
    const vault = FakeVault.withNotes(["a.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([move("a", "a.md", "archive/a.md")]);
    await expect(service.confirm(structuredClone(preview), ["a"])).rejects.toThrow("authentic");
    await expect(service.confirm(preview, ["a", "a"])).rejects.toThrow("Duplicate selected operation IDs");
    await expect(service.confirm(preview, ["missing"])).rejects.toThrow("Unknown selected operation ID");
    expect(await verifyPlanFingerprint({ ...preview.plan, fingerprint: "tampered" })).toBe(false);

    const duplicatePreview = await service.preview([move("same", "a.md", "x/a.md"), move("same", "a.md", "y/a.md")]);
    await expect(service.confirm(duplicatePreview, ["same"])).rejects.toThrow("Duplicate operation IDs");
  });

  it("whitelists only post-state-drift warnings and keeps plan conflicts global", async () => {
    const vault = FakeVault.withNotes(["a.md"]);
    const service = new ChangePlanService(vault, () => true);
    const supplied: readonly PlanConflict[] = [
      { operationId: "a", code: "source-missing", paths: ["a.md"], severity: "warning" },
      { operationId: "plan", code: "post-state-drift", paths: [], severity: "warning" },
    ];
    const preview = await service.preview([move("a", "a.md", "archive/a.md")], supplied);
    expect(preview.conflicts).toContainEqual({ operationId: "a", code: "source-missing", paths: ["a.md"] });
    expect(preview.conflicts).toContainEqual({ operationId: "plan", code: "post-state-drift", paths: [], severity: "warning" });
    await expect(service.confirm(preview, ["a"])).rejects.toThrow("Plan has blocking conflicts");
  });

  it("freshly previews on confirm and fully revalidates lock, inbound links, case collisions, targets, and fields", async () => {
    let enabled = true;
    const vault = FakeVault.withNotes(["source.md", "linked.md"]);
    const service = new ChangePlanService(vault, () => enabled);
    const preview = await service.preview([move("move", "source.md", "archive/source.md")]);
    vault.withNotes(["Archive/SOURCE.md"]);
    await expect(service.confirm(preview, ["move"])).rejects.toThrow("Plan has blocking conflicts");
    vault.applyEvent("delete", "Archive/SOURCE.md");
    const cleanPreview = await service.preview([move("move", "source.md", "archive/source.md")]);
    const plan = await service.confirm(cleanPreview, ["move"]);
    vault.setInboundLinks("source.md", ["linked.md"]);
    expect(await service.revalidate(plan)).toMatchObject({ ok: false, conflicts: [{ code: "inbound-links" }] });
    vault.setInboundLinks("source.md", []);
    enabled = false;
    expect(await service.revalidate(plan)).toMatchObject({ ok: false, conflicts: [{ code: "write-locked" }] });
  });

  it("filters preconditions, affected files, undo IDs, and conflicts for partial selection", async () => {
    const vault = FakeVault.withNotes(["blocked.md", "safe.md", "linked.md"]);
    vault.setInboundLinks("blocked.md", ["linked.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([
      move("blocked", "blocked.md", "archive/blocked.md"),
      move("safe", "safe.md", "archive/safe.md"),
    ]);
    const selected = evaluatePlanSelection(preview, ["safe"]);
    expect(selected.blockingConflicts).toEqual([]);
    expect(selected.affectedFiles).toEqual(["safe.md"]);
    expect(selected.undoableOperationIds).toEqual(["safe"]);
    const plan = await service.confirm(preview, ["safe"]);
    expect(plan.preconditions.map((value) => value.path)).toEqual(["archive/safe.md", "safe.md"]);
  });

  it("rejects non-finite rationale impact", async () => {
    const vault = FakeVault.withNotes(["a.md"]);
    const service = new ChangePlanService(vault, () => true);
    await expect(service.preview([move("a", "a.md", "archive/a.md")], [], {
      a: { source: "local", summary: "bad", signals: ["bad"], confidence: "high", impact: Number.POSITIVE_INFINITY },
    })).rejects.toThrow("finite");
  });

  it("rejects malformed operation schemas without throwing during revalidation", async () => {
    const vault = FakeVault.withNotes(["a.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([move("a", "a.md", "archive/a.md")]);
    const malformed = [
      { ...preview.plan, operations: [{ id: "x", kind: "delete", path: "a.md" }] },
      { ...preview.plan, operations: [{ id: "x", kind: "set-owned-field", path: "a.md", field: "title", before: { present: false }, after: { present: true, value: "x" } }] },
      { ...preview.plan, operations: [{ id: "x", kind: "set-owned-field", path: "a.md", field: "knowledge-workbench-kind", before: { present: false }, after: { present: true, value: 42 } }] },
    ];
    for (const plan of malformed) {
      expect(await verifyPlanFingerprint(plan as never)).toBe(false);
      await expect(service.revalidate(plan as never)).resolves.toMatchObject({ ok: false });
    }
  });

  it("rejects empty, oversized, and non-exact dependency precondition coverage", async () => {
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    const base = (await service.preview([move("a", "a.md", "archive/a.md")])).plan;
    const empty = (await service.preview([])).plan;
    const oversized = (await service.preview(Array.from({ length: 51 }, (_, index) =>
      move(`move-${index}`, "a.md", `archive/${index}.md`)))).plan;
    const missing = await refingerprintPlan({ ...base, preconditions: base.preconditions.slice(1) });
    const extra = await refingerprintPlan({
      ...base,
      preconditions: [...base.preconditions, { path: "extra.md", exists: false }],
    });

    await expect(service.revalidate(empty)).resolves.toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ code: "precondition-drift" })],
    });
    const oversizedResult = await service.revalidate(oversized);
    expect(oversizedResult.ok).toBe(false);
    if (oversizedResult.ok) throw new Error("Expected oversized plan rejection");
    expect(oversizedResult.conflicts.map((conflict) => conflict.code)).toContain("too-many-operations");
    for (const plan of [missing, extra]) {
      const result = await service.revalidate(plan);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected dependency coverage rejection");
      expect(result.conflicts.map((conflict) => conflict.code)).toContain("precondition-drift");
    }
  });

  it("rejects non-exact preconditions, field states, and operation variants", async () => {
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    const movePlan = (await service.preview([move("move", "a.md", "archive/a.md")])).plan;
    const fieldPlan = (await service.preview([{
      id: "field",
      kind: "set-owned-field",
      path: "a.md",
      field: "knowledge-workbench-kind",
      before: { present: false },
      after: { present: true, value: "note" },
    }])).plan;
    const absentIndex = movePlan.preconditions.findIndex((value) => !value.exists);
    const nonExactPrecondition = await refingerprintPlan({
      ...movePlan,
      preconditions: movePlan.preconditions.map((value, index) => index === absentIndex
        ? { ...value, mtime: 1, contentHash: "forbidden" }
        : value),
    });
    const nonExactFieldState = await refingerprintPlan({
      ...fieldPlan,
      operations: fieldPlan.operations.map((operation) => ({
        ...operation,
        before: { present: false, extra: true },
      })),
    });
    const confusedField = await refingerprintPlan({
      ...fieldPlan,
      operations: fieldPlan.operations.map((operation) => ({
        ...operation,
        sourcePath: "a.md",
        targetPath: "x.md",
      })),
      preconditions: [...fieldPlan.preconditions, { path: "x.md", exists: false }],
    });

    for (const plan of [nonExactPrecondition, nonExactFieldState, confusedField]) {
      expect(isChangePlanSchema(plan)).toBe(false);
      await expect(service.revalidate(plan)).resolves.toMatchObject({ ok: false });
    }
  });

  it("does not accept caller-supplied AI safety metrics without a local baseline", async () => {
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    const local = { source: "local" as const, summary: "Claimed local", signals: ["claim"], confidence: "high" as const, impact: 100 };
    const display = { ...local, source: "ai-assisted" as const, summary: "Boosted" };
    await expect(service.preview([move("a", "a.md", "archive/a.md")], [], {
      a: display,
    })).rejects.toThrow("local rationale");
    await expect(service.preview([move("a", "a.md", "archive/a.md")], [], { a: display }, { a: local }))
      .rejects.toThrow("local rationale");
  });

  it("validates existing source and related-target path syntax", async () => {
    const vault = FakeVault.withNotes(["CON.md", "safe.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([
      { id: "field", kind: "set-owned-field", path: "CON.md", field: "knowledge-workbench-kind", before: { present: false }, after: { present: true, value: "note" } },
      { id: "link", kind: "add-related-link", path: "safe.md", targetPath: "CON.md", before: { present: false }, after: { present: true, value: ["[[CON]]"] } },
    ]);
    expect(preview.conflicts).toContainEqual({ operationId: "field", code: "invalid-path", paths: ["CON.md"] });
    expect(preview.conflicts).toContainEqual({ operationId: "link", code: "invalid-path", paths: ["CON.md"] });
  });

  it("rechecks the write lock after asynchronous confirmation and revalidation work", async () => {
    const vault = FakeVault.withNotes(["a.md"]);
    let confirmLockCalls = 0;
    const confirmer = new ChangePlanService(vault, () => {
      confirmLockCalls += 1;
      return confirmLockCalls === 1;
    });
    const preview = await confirmer.preview([move("a", "a.md", "archive/a.md")]);
    await expect(confirmer.confirm(preview, ["a"])).rejects.toThrow("Write operations are locked");

    const unlocked = new ChangePlanService(vault, () => true);
    const confirmed = await unlocked.confirm(await unlocked.preview([move("a", "a.md", "archive/a.md")]), ["a"]);
    let planLockCalls = 0;
    const planRevalidator = new ChangePlanService(vault, () => {
      planLockCalls += 1;
      return planLockCalls === 1;
    });
    expect(await planRevalidator.revalidate(confirmed)).toMatchObject({ ok: false, conflicts: [{ code: "write-locked" }] });

    let operationLockCalls = 0;
    const operationRevalidator = new ChangePlanService(vault, () => {
      operationLockCalls += 1;
      return operationLockCalls === 1;
    });
    expect(await operationRevalidator.revalidateOperation(move("a", "a.md", "archive/a.md")))
      .toMatchObject({ ok: false, conflicts: [{ code: "write-locked" }] });
  });

  it("counts a structural change as one affected source file identity", async () => {
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    const preview = await service.preview([move("a", "a.md", "archive/a.md")]);
    expect(preview.affectedFiles).toEqual(["a.md"]);
    expect(evaluatePlanSelection(preview, ["a"]).affectedFiles).toEqual(["a.md"]);
  });

  it("blocks a read dependency that another selected operation mutates and clears it on partial deselection", async () => {
    const vault = FakeVault.withNotes(["source.md", "target.md"]);
    const service = new ChangePlanService(vault, () => true);
    const preview = await service.preview([
      { id: "link", kind: "add-related-link", path: "source.md", targetPath: "target.md", before: { present: false }, after: { present: true, value: ["[[target]]"] } },
      { id: "mutate", kind: "set-owned-field", path: "target.md", field: "knowledge-workbench-kind", before: { present: false }, after: { present: true, value: "note" } },
    ]);
    expect(evaluatePlanSelection(preview, ["link", "mutate"]).blockingConflicts)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operationId: "link", code: "overlapping-operation" }),
        expect.objectContaining({ operationId: "mutate", code: "overlapping-operation" }),
      ]));
    expect(evaluatePlanSelection(preview, ["link"]).blockingConflicts).toEqual([]);
    await expect(service.confirm(preview, ["link"])).resolves.toMatchObject({ operations: [{ id: "link" }] });
  });

  it("prevents generic related-field appends but permits exact single-tail inverse removal", async () => {
    const vault = FakeVault.withNotes(["a.md"]);
    const service = new ChangePlanService(vault, () => true);
    const bypass = await service.preview([{
      id: "bypass",
      kind: "set-owned-field",
      path: "a.md",
      field: "knowledge-workbench-related",
      before: { present: false },
      after: { present: true, value: ["[[missing]]"] },
    }]);
    expect(evaluatePlanSelection(bypass, ["bypass"]).blockingConflicts.length).toBeGreaterThan(0);
    await expect(service.confirm(bypass, ["bypass"])).rejects.toThrow("Plan has blocking conflicts");

    vault.setOwnedFieldExternally("a.md", "knowledge-workbench-related", { present: true, value: ["[[target]]"] });
    const inverse = await service.preview([{
      id: "undo",
      kind: "set-owned-field",
      path: "a.md",
      field: "knowledge-workbench-related",
      before: { present: true, value: ["[[target]]"] },
      after: { present: false },
    }]);
    expect(evaluatePlanSelection(inverse, ["undo"]).blockingConflicts).toEqual([]);
    await expect(service.confirm(inverse, ["undo"])).resolves.toMatchObject({ operations: [{ id: "undo" }] });

    vault.setOwnedFieldExternally("a.md", "knowledge-workbench-related", { present: true, value: ["a", "b", "c"] });
    const multiDelete = await service.preview([{
      id: "multi",
      kind: "set-owned-field",
      path: "a.md",
      field: "knowledge-workbench-related",
      before: { present: true, value: ["a", "b", "c"] },
      after: { present: true, value: ["a"] },
    }]);
    expect(evaluatePlanSelection(multiDelete, ["multi"]).blockingConflicts.length).toBeGreaterThan(0);
  });

  it("accepts AI display text only when paired with an equal local safety baseline", async () => {
    const fixture = suggestionFixture();
    const generated = new SuggestionService(() => ({ source: "ai-assisted", summary: "AI wording" }))
      .generate(fixture.input);
    const suggestion = generated.suggestions.find((value) => value.operation.kind === "set-owned-field")!;
    const source = "sourcePath" in suggestion.operation ? suggestion.operation.sourcePath : suggestion.operation.path;
    const service = new ChangePlanService(FakeVault.withNotes([source]), () => true);
    const id = suggestion.operation.id;
    const preview = await service.preview(
      [suggestion.operation],
      [],
      { [id]: suggestion.rationale },
      { [id]: suggestion.localRationale },
    );
    expect(preview.plan.rationales[id]).toEqual(suggestion.rationale);
    expect(preview.plan.localRationales[id]).toEqual(suggestion.localRationale);
    await expect(service.confirm(preview, [id])).resolves.toMatchObject({
      rationales: { [id]: suggestion.rationale },
      localRationales: { [id]: suggestion.localRationale },
    });
  });

  it("binds an authenticated local rationale to the complete canonical operation payload", async () => {
    const fixture = suggestionFixture();
    const generated = new SuggestionService(() => ({ source: "ai-assisted", summary: "AI wording" }))
      .generate(fixture.input);
    const suggestion = generated.suggestions.find((value) => value.operation.kind === "set-owned-field")!;
    const hijacked = move(suggestion.operation.id, "Other.md", "Hijacked.md");
    const display = { ...suggestion.rationale, summary: "Reused baseline" };
    const service = new ChangePlanService(FakeVault.withNotes(["Other.md"]), () => true);
    await expect(service.preview(
      [hijacked],
      [],
      { [hijacked.id]: display },
      { [hijacked.id]: suggestion.localRationale },
    )).rejects.toThrow("local rationale safety baseline");
  });

  it("returns a blocking result instead of throwing for a malformed direct operation", async () => {
    const service = new ChangePlanService(FakeVault.withNotes(["a.md"]), () => true);
    await expect(service.revalidateOperation({ id: "bad", kind: "delete", path: "a.md" } as never))
      .resolves.toMatchObject({ ok: false, conflicts: [{ operationId: "bad" }] });
    await expect(service.revalidateOperation({
      id: "bad-field",
      kind: "set-owned-field",
      path: "a.md",
      field: "title",
      before: { present: false },
      after: { present: true, value: 42 },
    } as never)).resolves.toMatchObject({ ok: false, conflicts: [{ operationId: "bad-field" }] });
  });
});
