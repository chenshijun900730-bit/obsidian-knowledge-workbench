import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "../../src/transactions/transaction-service";
import { controllerFixture } from "../helpers/ui-fixtures";
import { transactionFixture } from "./helpers/transaction-fixture";

const enableOrganizationSuggestion = (fixture: ReturnType<typeof controllerFixture>) => {
  fixture.store.setSettingsForTest({
    ...fixture.store.settings(),
    folderRules: [{ prefix: "Notes", kind: "note" }],
    writePreviewAcknowledged: true,
    writeEnabled: true,
  });
  const suggestion = fixture.controller.refreshSuggestions()[0];
  if (suggestion === undefined) throw new Error("Expected an organization suggestion");
  return suggestion;
};

describe("confirmed plan controller flow", () => {
  it.each(["cancel", "escape"] as const)("performs zero writes when confirmation ends by %s", async (previewResult) => {
    const fixture = controllerFixture({ activeIndex: true, previewResult });
    const suggestion = enableOrganizationSuggestion(fixture);

    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);

    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.transactions.calls).toEqual([]);
    expect(fixture.vault.writeCalls).toEqual([]);
    expect(fixture.controller.snapshot().suggestions?.map((value) => value.operation.id)).toContain(suggestion.operation.id);
  });

  it("executes one confirmed safe operation once and removes only the completed suggestion", async () => {
    const fixture = controllerFixture({ activeIndex: true, writeOnExecute: true });
    const suggestion = enableOrganizationSuggestion(fixture);

    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);

    expect(fixture.transactions.calls).toHaveLength(1);
    expect(fixture.vault.writeCalls).toHaveLength(1);
    expect(fixture.controller.snapshot()).toMatchObject({ status: "ready", statusMessage: "Changes completed" });
    expect(fixture.controller.snapshot().suggestions).toEqual([]);
  });

  it("returns a stale result after user relock with zero writes and keeps the suggestion", async () => {
    const stale: ExecutionResult = {
      status: "stale",
      conflicts: [
        { operationId: "plan", code: "write-locked", paths: [] },
        { operationId: "duplicate", code: "write-locked", paths: [] },
      ],
    };
    const fixture = controllerFixture({ activeIndex: true, relockUserAfterConfirmation: true, transactionResult: stale });
    const suggestion = enableOrganizationSuggestion(fixture);

    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);

    expect(fixture.transactions.calls).toHaveLength(1);
    expect(fixture.vault.writeCalls).toEqual([]);
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "ready",
      statusMessage: "Plan not executed: write-locked",
    });
    expect(fixture.journal.listCalls).toBe(1);
    expect(fixture.controller.snapshot().suggestions?.map((value) => value.operation.id)).toContain(suggestion.operation.id);
  });

  it.each([
    [{ status: "completed", journalId: "completed" }, "Changes completed"],
    [{ status: "rolled-back", journalId: "rolled" }, "Changes rolled back"],
    [{ status: "recovery-required", journalId: "recovery" }, "Recovery required; organization writes are locked"],
  ] as const)("preserves the exact UI outcome for %s", async (transactionResult, statusMessage) => {
    const fixture = controllerFixture({ activeIndex: true, transactionResult });
    const suggestion = enableOrganizationSuggestion(fixture);

    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);

    expect(fixture.controller.snapshot()).toMatchObject({ status: "ready", statusMessage });
    expect(fixture.journal.listCalls).toBe(1);
    const remaining = fixture.controller.snapshot().suggestions?.map((value) => value.operation.id) ?? [];
    if (transactionResult.status === "completed") expect(remaining).not.toContain(suggestion.operation.id);
    else expect(remaining).toContain(suggestion.operation.id);
  });

  it("keeps a single execution in flight and does not invoke the service twice", async () => {
    const fixture = controllerFixture({ activeIndex: true, pauseTransaction: true });
    const suggestion = enableOrganizationSuggestion(fixture);
    const preview = await fixture.changePlans.preview([suggestion.operation]);
    const confirmed = await fixture.changePlans.confirm(preview, [suggestion.operation.id]);

    const first = fixture.controller.executeConfirmedPlan(confirmed, { origin: "suggestion" });
    expect(fixture.controller.snapshot()).toMatchObject({ status: "ready", statusMessage: "Executing changes" });
    await fixture.controller.executeConfirmedPlan(confirmed, { origin: "suggestion" });
    expect(fixture.transactions.calls).toHaveLength(1);

    fixture.transactions.resume();
    await first;
    expect(fixture.controller.snapshot().statusMessage).toBe("Changes completed");
  });

  it("blocks startup organization confirmation fail-closed while quick capture remains independent", async () => {
    const fixture = controllerFixture({ activeIndex: true, organizationWritesBlocked: true });
    const suggestion = enableOrganizationSuggestion(fixture);

    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);
    await fixture.controller.startQuickCapture();

    expect(fixture.changePreview.planCalls).toBe(0);
    expect(fixture.transactions.calls).toEqual([]);
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "ready",
      statusMessage: "Recovery required; organization writes are locked",
    });
    expect(fixture.quickCapture.calls).toBe(1);
  });

  it("rechecks the durable journal gate after confirmation and makes zero service calls when it flips", async () => {
    const fixture = controllerFixture({ activeIndex: true, blockAfterConfirmation: true });
    const suggestion = enableOrganizationSuggestion(fixture);

    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);

    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.transactions.calls).toEqual([]);
    expect(fixture.vault.writeCalls).toEqual([]);
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "ready",
      statusMessage: "Recovery required; organization writes are locked",
    });
    expect(fixture.controller.snapshot().suggestions?.map((value) => value.operation.id)).toContain(suggestion.operation.id);
  });

  it("shows the recovery lock when execution rejects after durable state becomes blocked", async () => {
    const fixture = controllerFixture({
      activeIndex: true,
      transactionError: new Error("ambiguous persistence"),
      blockOnTransactionError: true,
    });
    const suggestion = enableOrganizationSuggestion(fixture);

    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);

    expect(fixture.transactions.calls).toHaveLength(1);
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "ready",
      statusMessage: "Recovery required; organization writes are locked",
    });
    expect(fixture.controller.snapshot().suggestions?.map((value) => value.operation.id)).toContain(suggestion.operation.id);
  });

  it("treats active and malformed durable journals as a synchronous organization-write interlock", async () => {
    const active = await transactionFixture();
    expect(active.journal.organizationWritesBlocked()).toBe(false);
    await active.journal.begin(active.confirmedPlan, 100);
    expect(active.journal.organizationWritesBlocked()).toBe(true);

    const malformed = await transactionFixture();
    await malformed.store.mutateJournals(() => ({ journals: [{ status: "completed" }], result: undefined }));
    expect(malformed.journal.organizationWritesBlocked()).toBe(true);
  });
});
