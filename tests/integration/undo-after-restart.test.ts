import { describe, expect, it } from "vitest";
import { addRelated, createPersistentTransactionFixture, rename, setKind } from "./helpers/transaction-fixture";

describe("UndoService after restart", () => {
  it("loads a completed journal and previews a safe structural inverse", async () => {
    const first = await createPersistentTransactionFixture(undefined, undefined, [rename()]);
    const result = await first.service.execute(first.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);

    const restarted = await createPersistentTransactionFixture(first.persistedPort, first.vault, [rename()]);
    const preview = await restarted.undo.preview(result.journalId);

    expect(preview.conflicts).toEqual([]);
    expect(preview.plan.operations).toMatchObject([{ sourcePath: "x.md", targetPath: "a.md" }]);
  });

  it("surfaces structural post-state drift and makes an all-drift undo non-confirmable", async () => {
    const fixture = await createPersistentTransactionFixture();
    const result = await fixture.service.execute(fixture.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    fixture.vault.modifyExternally("x.md");

    const preview = await fixture.undo.preview(result.journalId);

    expect(preview.conflicts.some((value) => value.code === "post-state-drift")).toBe(true);
    expect(preview.undoableOperationIds).toEqual([]);
    await expect(fixture.plans.confirm(preview, [])).rejects.toThrow();
  });

  it("preserves authoritative reverse completion order", async () => {
    const fixture = await createPersistentTransactionFixture(undefined, undefined, [setKind("b.md"), rename()]);
    const result = await fixture.service.execute(fixture.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);

    const preview = await fixture.undo.preview(result.journalId);

    expect(preview.plan.operations.map((value) => value.id)).toEqual([...fixture.confirmedPlan.operations].reverse().map((value) => value.id));
    const confirmed = await fixture.plans.confirm(preview, preview.undoableOperationIds);
    expect(confirmed.operations.map((value) => value.id)).toEqual(preview.plan.operations.map((value) => value.id));
  });

  it("keeps excluded drift visible when another inverse remains safe", async () => {
    const fixture = await createPersistentTransactionFixture(undefined, undefined, [setKind("b.md"), rename()]);
    const result = await fixture.service.execute(fixture.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    fixture.vault.modifyExternally("x.md");

    const preview = await fixture.undo.preview(result.journalId);

    expect(preview.plan.operations).toHaveLength(1);
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ operationId: "plan", code: "post-state-drift" }));
    const confirmed = await fixture.plans.confirm(preview, preview.undoableOperationIds);
    expect(confirmed.operations).toHaveLength(1);
  });

  it("ignores unrelated body and mtime edits for a semantic field inverse", async () => {
    const fixture = await createPersistentTransactionFixture(undefined, undefined, [setKind("b.md")]);
    const result = await fixture.service.execute(fixture.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    fixture.vault.modifyExternally("b.md");

    const preview = await fixture.undo.preview(result.journalId);

    expect(preview.conflicts).toEqual([]);
    expect(preview.undoableOperationIds).toEqual([setKind("b.md").id]);
  });

  it("can remove a related field when its former target is missing", async () => {
    const fixture = await createPersistentTransactionFixture(undefined, undefined, [addRelated()]);
    const result = await fixture.service.execute(fixture.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    fixture.vault.deleteExternally("target.md");

    const preview = await fixture.undo.preview(result.journalId);

    expect(preview.conflicts.some((value) => value.code === "related-target-missing")).toBe(false);
    expect(preview.plan.operations[0]).toMatchObject({ kind: "set-owned-field", field: "knowledge-workbench-related" });
  });

  it.each(["recovery-required", "rolled-back"] as const)("rejects a valid %s journal", async (status) => {
    const fixture = await createPersistentTransactionFixture();
    const result = await fixture.service.execute(fixture.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const completed = await fixture.journal.get(result.journalId);
    if (completed === null) throw new Error("Missing completed journal");
    const terminal = status === "rolled-back"
      ? { ...completed, status, error: "rolled back", rolledBackOperationIds: completed.completed.map((step) => step.operation.id).reverse() }
      : {
          ...completed,
          status,
          error: "manual recovery",
          recovery: {
            unresolved: [{
              operationId: completed.completed[0]!.operation.id,
              originalPaths: ["a.md", "x.md"],
              currentPaths: ["x.md"],
              comparison: "differs" as const,
              reason: "manual recovery",
            }],
          },
        };
    await fixture.store.mutateJournals(() => ({ journals: [terminal], result: undefined }));

    await expect(fixture.undo.preview(result.journalId)).rejects.toThrow("Only completed operations can be undone");
  });

  it("rejects a missing journal", async () => {
    const fixture = await createPersistentTransactionFixture();
    await expect(fixture.undo.preview("missing")).rejects.toThrow("Only completed operations can be undone");
  });
});
