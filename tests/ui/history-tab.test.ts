// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  createHistoryConfirmationModalClass,
  exportJournalJson,
  renderHistory,
  triggerHistoryDownload,
  type HistoryModalConstructor,
  type HistoryViewModel,
} from "../../src/ui/history-tab";
import { completedEntry, journalFixture, noOpHistoryActions, recoveryEntry } from "../helpers/journal-fixtures";
import { controllerFixture } from "../helpers/ui-fixtures";
import { READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

describe("operation history", () => {
  it("shows only aggregate acceptance history and inert disabled actions", async () => {
    const completed = await completedEntry("completed-private-id", 1);
    const recovery = await recoveryEntry("recovery-private-id", 2);
    const actions = {
      onUndo: vi.fn(),
      onViewRecovery: vi.fn(),
      onClear: vi.fn(),
      onExport: vi.fn(),
    };
    const root = createTestDiv();
    renderHistory(root, {
      entries: [recovery, completed],
      recoveryReport: {
        journalId: "recovery-private-id",
        issues: [{
          operationId: "rename:Private/A.md->Private/B.md",
          comparison: "differs",
          originalPaths: ["Private/A.md"],
          currentPaths: ["Private/B.md"],
        }],
      },
    }, actions, READ_ONLY_ACCEPTANCE_POLICY);

    expect(root.textContent).toContain("Recovery required");
    expect(root.textContent).toContain("Completed");
    expect(root.textContent).not.toContain("completed-private-id");
    expect(root.textContent).not.toContain("recovery-private-id");
    expect(root.textContent).not.toContain("Private/A.md");
    expect(root.textContent).not.toContain("rename:");
    expect(root.querySelector('[aria-label="Recovery report"]')).toBeNull();
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "View recovery",
      "Undo",
      "Clear history",
      "Export history",
    ]);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-label")).toContain("unavailable in read-only acceptance mode");
      button.disabled = false;
      button.click();
    }
    expect(actions.onUndo).not.toHaveBeenCalled();
    expect(actions.onViewRecovery).not.toHaveBeenCalled();
    expect(actions.onClear).not.toHaveBeenCalled();
    expect(actions.onExport).not.toHaveBeenCalled();
  });

  it("settles clear confirmation on Escape and restores the invoking element's focus", async () => {
    class ModalSurface {
      readonly contentEl = createTestDiv();
      readonly titleEl = document.createElementNS("http://www.w3.org/1999/xhtml", "h2") as HTMLHeadingElement;
      constructor(readonly app: App) {}
      setTitle(value: string): this { this.titleEl.textContent = value; return this; }
      open(): void { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
      close(): void { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
      onOpen(): void {}
      onClose(): void {}
    }
    const trigger = document.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
    trigger.textContent = "Clear history";
    document.body.append(trigger);
    trigger.focus();
    const Concrete = createHistoryConfirmationModalClass(ModalSurface as unknown as HistoryModalConstructor);
    const modal = new Concrete({} as App);
    const result = modal.request();

    modal.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    const closedByEscape = !modal.contentEl.isConnected;
    if (!closedByEscape) Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>("button"))[0]?.click();
    await expect(result).resolves.toBe(false);
    expect(closedByEscape).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("renders newest-first exact statuses with native actions", async () => {
    const old = await completedEntry("old", 1);
    const recovery = await recoveryEntry("new", 2);
    const root = createTestDiv();

    renderHistory(root, { entries: [recovery, old] }, noOpHistoryActions());

    expect(root.textContent).toContain("Recovery required");
    expect(root.textContent).toContain("Completed");
    expect(Array.from(root.querySelectorAll("button")).map((button) => button.textContent)).toContain("View recovery");
    expect(root.querySelector("button")?.tabIndex).toBe(0);
  });

  it("shows rollback count and terminal rollback result on every history row", async () => {
    const completed = await completedEntry("done", 1);
    const rolled = {
      ...completed,
      id: "rolled",
      status: "rolled-back" as const,
      error: "test rollback",
      rolledBackOperationIds: completed.completed.map((step) => step.operation.id).reverse(),
    };
    const root = createTestDiv();

    renderHistory(root, { entries: [rolled, completed] }, noOpHistoryActions());

    expect(root.textContent).toContain("1 rolled back");
    expect(root.textContent).toContain("Rollback complete");
    expect(root.textContent).toContain("Rollback not needed");
  });

  it("clears only after a separate confirmation and rechecks active state atomically", async () => {
    const fixture = await journalFixture([await completedEntry("done", 1)]);
    expect(await fixture.journal.list()).toHaveLength(1);
    await fixture.journal.clearHistory();
    expect(await fixture.journal.list()).toEqual([]);

    const active = await journalFixture([await completedEntry("done", 1), await recoveryEntry("blocked", 2)]);
    await active.journal.clearHistory();
    expect((await active.journal.list()).map((entry) => entry.id)).toEqual(["blocked"]);
  });

  it("exports only an allowlisted primitive DTO", async () => {
    const entry = await completedEntry("1", 1);
    const hostile = {
      ...entry,
      markdownBody: "PRIVATE BODY",
      apiKey: "SECRET",
      future: { toJSON: () => { throw new Error("must not invoke"); } },
    };

    const text = exportJournalJson([hostile], "2026-07-13T00:00:00.000Z");
    const parsed: unknown = JSON.parse(text);
    const parsedObject = parsed as { readonly entries: readonly unknown[] };

    expect(parsed).toMatchObject({ schemaVersion: 1, exportedAt: "2026-07-13T00:00:00.000Z" });
    expect(parsedObject.entries[0]).toMatchObject({ id: "1", status: "completed" });
    for (const forbidden of ["markdownBody", "apiKey", "fingerprint", "contentHash", "mtime", "rationales", "localRationales", "secret", "error", "reason"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("rejects hostile export input atomically", async () => {
    const entry = await completedEntry("1", 1);
    const hostile = new Proxy(entry, { get(target, key) {
      if (key === "status") throw new Error("hostile getter");
      return target[key as keyof typeof target];
    } });

    expect(() => exportJournalJson([hostile], "2026-07-13T00:00:00.000Z")).toThrow("hostile getter");
  });

  it("rejects unknown operation kinds instead of exporting future keys", async () => {
    const entry = await completedEntry("1", 1);
    const malformed = structuredClone(entry) as unknown as { completed: Array<{ operation: Record<string, unknown> }> };
    malformed.completed[0]!.operation.kind = "future-operation";
    malformed.completed[0]!.operation.secret = "DO-NOT-EXPORT";

    expect(() => exportJournalJson([malformed as never], "2026-07-13T00:00:00.000Z")).toThrow("Invalid history operation");
  });

  it("rejects unknown statuses and non-string rollback IDs", async () => {
    const entry = await completedEntry("1", 1);
    expect(() => exportJournalJson([{ ...entry, status: "__proto__" } as never], "2026-07-13T00:00:00.000Z")).toThrow("Invalid history entry");
    expect(() => exportJournalJson([{ ...entry, rolledBackOperationIds: [1] } as never], "2026-07-13T00:00:00.000Z")).toThrow("Invalid history entry");
  });

  it("rejects non-canonical or policy-invalid export paths", async () => {
    const entry = await completedEntry("1", 1);
    const malformed = structuredClone(entry) as unknown as { completed: Array<{ operation: { sourcePath: string } }> };
    malformed.completed[0]!.operation.sourcePath = "../outside.md";
    expect(() => exportJournalJson([malformed], "2026-07-13T00:00:00.000Z")).toThrow("Invalid export path");
  });

  it("exports recovery comparisons but never recovery reasons or errors", async () => {
    const entry = await recoveryEntry("recovery", 1);
    const text = exportJournalJson([entry], "2026-07-13T00:00:00.000Z");
    expect(text).toContain("comparison");
    expect(text).not.toContain("manual recovery");
    expect(text).not.toContain("reason");
    expect(text).not.toContain("error");
  });

  it("uses the owning window and always revokes a created Blob URL", () => {
    const root = createTestDiv();
    const view = document.defaultView!;
    const createObjectURL = vi.fn(() => "blob:history");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(view.URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(view.URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("click failed"); });

    expect(() => triggerHistoryDownload(root, "{}", "history.json")).toThrow("click failed");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:history");
    click.mockRestore();
  });

  it("accepts an explicit empty history model", () => {
    const model: HistoryViewModel = { entries: [] };
    const root = createTestDiv();
    renderHistory(root, model, noOpHistoryActions());
    expect(root.textContent).toContain("No operation history");
  });

  it("refreshes terminal history while Undo origin never suppresses a suggestion", async () => {
    const fixture = controllerFixture({ activeIndex: true });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const suggestion = fixture.controller.refreshSuggestions()[0]!;
    const preview = await fixture.changePlans.preview([suggestion.operation]);
    const confirmed = await fixture.changePlans.confirm(preview, [suggestion.operation.id]);

    await fixture.controller.executeConfirmedPlan(confirmed, { origin: "undo" });

    expect(fixture.controller.snapshot().suggestions?.map((value) => value.operation.id)).toContain(suggestion.operation.id);
    expect(fixture.journal.listCalls).toBe(1);
  });

  it("rechecks the gate after an Undo modal resolves", async () => {
    const fixture = controllerFixture({ activeIndex: true, blockAfterConfirmation: true });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    fixture.controller.refreshSuggestions();

    await fixture.controller.previewUndo("completed");

    expect(fixture.undo.calls).toEqual(["completed"]);
    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.transactions.calls).toEqual([]);
    expect(fixture.controller.snapshot().statusMessage).toBe("Recovery required; organization writes are locked");
  });

  it("does not open an empty Undo modal when every inverse drifted", async () => {
    const fixture = controllerFixture({ activeIndex: true, undoAllDrift: true });
    await fixture.controller.previewUndo("completed");
    expect(fixture.changePreview.planCalls).toBe(0);
    expect(fixture.transactions.calls).toEqual([]);
    expect(fixture.controller.snapshot().statusMessage).toBe("Plan not executed: post-state-drift");
  });

  it("requires separate clear confirmation and does not announce success after a concurrent active claim", async () => {
    const canceled = controllerFixture({ historyConfirmation: false });
    await canceled.controller.requestClearHistory();
    expect(canceled.journal.clearCalls).toBe(0);

    const raced = controllerFixture({ historyClearError: new Error("Cannot clear history while a transaction is active") });
    await expect(raced.controller.requestClearHistory()).rejects.toThrow("Cannot clear history while a transaction is active");
    expect(raced.controller.snapshot().statusMessage).not.toBe("History cleared");
  });

  it("does not publish a clear result after disposal while confirmation is pending", async () => {
    const fixture = controllerFixture({ pauseHistoryConfirmation: true });
    const clearing = fixture.controller.requestClearHistory();
    fixture.controller.dispose();
    fixture.historyConfirmation.resume(true);
    await clearing;
    expect(fixture.journal.clearCalls).toBe(0);
  });

  it("publishes an independent complete recovery report model instead of using the status bar", async () => {
    const entry = await recoveryEntry("recovery", 1);
    const fixture = controllerFixture({ historyEntries: [entry] });
    const beforeStatus = fixture.controller.snapshot().statusMessage;

    await fixture.controller.viewRecovery(entry.id);

    expect(fixture.controller.snapshot().statusMessage).toBe(beforeStatus);
    expect(fixture.controller.snapshot().history?.recoveryReport).toEqual({
      journalId: entry.id,
      issues: [{
        operationId: "rename:a.md->x.md",
        comparison: "differs",
        originalPaths: ["a.md", "x.md"],
        currentPaths: ["a.md"],
      }],
    });

    const root = createTestDiv();
    renderHistory(root, fixture.controller.snapshot().history!, noOpHistoryActions());
    const report = root.querySelector('[aria-label="Recovery report"]');
    expect(report?.textContent).toContain("rename:a.md->x.md");
    expect(report?.textContent).toContain("differs");
    expect(report?.textContent).toContain("Original paths: a.md, x.md");
    expect(report?.textContent).toContain("Current paths: a.md");
  });
});
