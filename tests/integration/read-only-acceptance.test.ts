import { describe, expect, it } from "vitest";
import { READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";
import { controllerFixture } from "../helpers/ui-fixtures";

const organizationSuggestion = (fixture: ReturnType<typeof controllerFixture>) => {
  fixture.store.setSettingsForTest({
    ...fixture.store.settings(),
    folderRules: [{ prefix: "Notes", kind: "note" }],
  });
  const suggestion = fixture.controller.refreshSuggestions()[0];
  if (suggestion === undefined) throw new Error("Expected an organization suggestion");
  return suggestion;
};

const throwingAiSettings = (): Parameters<
  ReturnType<typeof controllerFixture>["controller"]["saveAiSettings"]
>[0] => Object.defineProperties({}, {
  enabled: { get: () => { throw new Error("must not inspect enabled"); } },
  endpoint: { get: () => { throw new Error("must not inspect endpoint"); } },
  model: { get: () => { throw new Error("must not inspect model"); } },
  secretId: { get: () => { throw new Error("must not inspect secretId"); } },
}) as Parameters<ReturnType<typeof controllerFixture>["controller"]["saveAiSettings"]>[0];

const throwingSelection = (): readonly string[] => new Proxy(["Notes/Alpha.md"], {
  get: () => { throw new Error("must not inspect selection"); },
  ownKeys: () => { throw new Error("must not enumerate selection"); },
});

describe("read-only acceptance controller", () => {
  it("blocks every write, history-detail, and AI boundary before downstream work", async () => {
    const fixture = controllerFixture({
      policy: READ_ONLY_ACCEPTANCE_POLICY,
      historicalWriteEnabled: true,
      historicalAiEnabled: true,
    });
    const suggestion = organizationSuggestion(fixture);

    await fixture.controller.previewSuggestion(suggestion.operation.id);
    await fixture.controller.startQuickCapture();
    await fixture.controller.previewUndo("journal:completed");
    await fixture.controller.requestClearHistory();
    await expect(fixture.controller.historyExportJson("2026-07-14T00:00:00.000Z"))
      .rejects.toThrow("Read-only acceptance mode blocks history details");
    await fixture.controller.viewRecovery("journal:recovery");
    await fixture.controller.previewSampleChange();
    await fixture.controller.setWriteEnabled(true);
    await expect(fixture.controller.saveAiSettings(throwingAiSettings())).resolves.toBeUndefined();
    fixture.controller.setSessionAiSecret("must-not-be-retained");
    await expect(fixture.controller.summarize(throwingSelection()))
      .resolves.toEqual({ kind: "local-fallback", reason: "disabled" });

    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.changePreview.lastPreview).not.toBeNull();
    expect(fixture.transactions.calls).toHaveLength(0);
    expect(fixture.transactions.organizationWritesBlockedCalls).toBe(0);
    expect(fixture.quickCapture.calls).toBe(0);
    expect(fixture.undo.calls).toHaveLength(0);
    expect(fixture.historyConfirmation.calls).toBe(0);
    expect(fixture.journal.clearCalls).toBe(0);
    expect(fixture.journal.listCalls).toBe(0);
    expect(fixture.changePreview.sampleCalls).toBe(0);
    expect(fixture.store.saveSettingsCalls).toHaveLength(0);
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.store.settings()).toMatchObject({
      writeEnabled: true,
      writePreviewAcknowledged: true,
      aiEnabled: true,
    });
    expect(fixture.controller.settings()).toMatchObject({
      writeEnabled: false,
      aiEnabled: false,
    });
  });

  it("keeps suggestion preview available without consulting a recovery lock", async () => {
    const fixture = controllerFixture({
      policy: READ_ONLY_ACCEPTANCE_POLICY,
      historicalWriteEnabled: true,
      organizationWritesBlocked: true,
    });
    const suggestion = organizationSuggestion(fixture);

    await fixture.controller.previewSuggestion(suggestion.operation.id);

    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.changePreview.lastPreview?.plan.operations).toHaveLength(1);
    expect(fixture.transactions.organizationWritesBlockedCalls).toBe(0);
    expect(fixture.transactions.calls).toHaveLength(0);
  });

  it("rejects a real non-empty confirmed plan before consulting transaction state", async () => {
    const fixture = controllerFixture({
      policy: READ_ONLY_ACCEPTANCE_POLICY,
      historicalWriteEnabled: true,
      organizationWritesBlocked: true,
    });
    const suggestion = organizationSuggestion(fixture);
    const rationales = { [suggestion.operation.id]: suggestion.localRationale };
    const preview = await fixture.changePlans.preview(
      [suggestion.operation],
      [],
      rationales,
      rationales,
    );
    const confirmed = await fixture.changePlans.confirm(preview, [suggestion.operation.id]);

    expect(confirmed.operations).toHaveLength(1);
    await expect(fixture.controller.executeConfirmedPlan(confirmed, { origin: "suggestion" }))
      .resolves.toBeNull();

    expect(fixture.transactions.organizationWritesBlockedCalls).toBe(0);
    expect(fixture.transactions.calls).toHaveLength(0);
  });

  it("still allows aggregate history refresh", async () => {
    const fixture = controllerFixture({
      policy: READ_ONLY_ACCEPTANCE_POLICY,
      historyEntries: [],
    });

    await fixture.controller.refreshHistory();

    expect(fixture.journal.listCalls).toBe(1);
  });
});
