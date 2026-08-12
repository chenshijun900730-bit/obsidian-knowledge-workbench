import { describe, expect, it } from "vitest";
import { RecoveryReadinessGate } from "../../src/transactions/recovery-readiness-gate";
import { interruptedEntry, recoveryAuditFixture } from "../helpers/journal-fixtures";
import { createPersistentTransactionFixture } from "./helpers/transaction-fixture";
import { rename, setKind, FaultingPluginDataPort } from "./helpers/transaction-fixture";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import { OperationJournal } from "../../src/transactions/operation-journal";
import { RecoveryAuditService } from "../../src/transactions/recovery-audit-service";
import { ScriptedFailureVault } from "../fakes/scripted-failure-vault";
import type { JournalBoundary } from "./helpers/transaction-fixture";
import type { PluginDataPort } from "../../src/core/ports";

class UnreadableVault extends ScriptedFailureVault {
  unreadable = false;
  override async snapshot(path: string) {
    if (this.unreadable && path === "a.md") throw new Error("unreadable:a.md");
    return await super.snapshot(path);
  }
}

class TamperingTransitionPort implements PluginDataPort {
  private data: unknown;
  private tampered = false;
  constructor(initial: unknown) { this.data = structuredClone(initial); }
  async load(): Promise<unknown> { return structuredClone(this.data); }
  async save(value: unknown): Promise<void> {
    const snapshot = structuredClone(value) as { operational?: { journals?: Array<Record<string, unknown>> } };
    if (!this.tampered && snapshot.operational?.journals?.[0]?.status === "rolling-back") {
      this.tampered = true;
      const first = snapshot.operational.journals[0];
      if (first === undefined) throw new Error("Expected a journal to tamper");
      first.createdAt = 999;
      this.data = snapshot;
      throw new Error("persisted-tampered-transition");
    }
    this.data = snapshot;
  }
}

const pluginData = (journals: readonly unknown[]) => ({ schemaVersion: 1, settings: {}, operational: { journals } });

const boundaryScenario = async (boundary: JournalBoundary) => {
  if (boundary === "rolling-back") {
    return { entry: await interruptedEntry("planned"), vault: new ScriptedFailureVault() };
  }
  if (boundary === "clear-prepared") {
    const base = await createPersistentTransactionFixture();
    const entry = await base.journal.begin(base.confirmedPlan, 5);
    await base.journal.markExecuting(entry.id);
    const operation = base.confirmedPlan.operations[0]!;
    if (operation.kind !== "move" && operation.kind !== "rename") throw new Error("Expected structural operation");
    await base.journal.prepare(entry.id, operation, { ...operation, sourcePath: "x.md", targetPath: "a.md" }, base.confirmedPlan.preconditions);
    return { entry: (await base.journal.get(entry.id))!, vault: base.vault };
  }
  const base = await createPersistentTransactionFixture();
  const result = await base.service.execute(base.confirmedPlan);
  if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
  const completed = (await base.journal.get(result.journalId))!;
  if (boundary === "terminal-recovery-required") {
    return { entry: { ...completed, status: "executing" as const }, vault: base.vault };
  }
  base.vault.rename("x.md", "a.md");
  const operationId = completed.completed[0]!.operation.id;
  return boundary === "record-rolled-back"
    ? { entry: { ...completed, status: "rolling-back" as const, error: "restart" }, vault: base.vault }
    : {
        entry: {
          ...completed,
          status: "rolling-back" as const,
          error: "restart",
          rolledBackOperationIds: [operationId],
        },
        vault: base.vault,
      };
};

describe("startup recovery audit", () => {
  it("proves every recorded structural rollback restored without rewriting its journal", async () => {
    const base = await createPersistentTransactionFixture();
    const result = await base.service.execute(base.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const completed = (await base.journal.get(result.journalId))!;
    base.vault.rename("x.md", "a.md");
    const rolledBack = {
      ...completed,
      status: "rolled-back" as const,
      error: "restored before restart",
      rolledBackOperationIds: completed.completed.map((step) => step.operation.id).reverse(),
    };
    const fixture = await recoveryAuditFixture([rolledBack], base.vault);
    const journalBefore = JSON.stringify(await fixture.journal.get(rolledBack.id));
    const savesBefore = fixture.port.saveCalls.length;
    const writesBefore = [...base.vault.calls];

    await fixture.audit.auditInFlight();

    expect(fixture.gate.isReady()).toBe(true);
    expect(JSON.stringify(await fixture.journal.get(rolledBack.id))).toBe(journalBefore);
    expect(fixture.port.saveCalls).toHaveLength(savesBefore);
    expect(base.vault.calls).toEqual(writesBefore);
  });

  it.each(["applied", "drift", "unreadable"] as const)("fails closed when a recorded structural rollback is %s", async (state) => {
    const vault = state === "unreadable" ? new UnreadableVault() : new ScriptedFailureVault();
    const base = await createPersistentTransactionFixture(undefined, vault);
    const result = await base.service.execute(base.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const completed = (await base.journal.get(result.journalId))!;
    if (state === "drift") vault.modifyExternally("x.md");
    if (state === "unreadable") (vault as UnreadableVault).unreadable = true;
    const rolledBack = {
      ...completed,
      status: "rolled-back" as const,
      error: "claimed restored",
      rolledBackOperationIds: completed.completed.map((step) => step.operation.id).reverse(),
    };
    const fixture = await recoveryAuditFixture([rolledBack], vault);
    const savesBefore = fixture.port.saveCalls.length;
    const writesBefore = [...vault.calls];

    await expect(fixture.audit.auditInFlight()).rejects.toThrow("Rolled-back journal is not restored");

    expect(fixture.gate.isReady()).toBe(false);
    expect(fixture.port.saveCalls).toHaveLength(savesBefore);
    expect(vault.calls).toEqual(writesBefore);
    expect(await fixture.journal.get(rolledBack.id)).toEqual(rolledBack);
  });

  it("starts closed and direct transaction execution fails with zero WAL and vault writes", async () => {
    const gate = new RecoveryReadinessGate();
    const fixture = await createPersistentTransactionFixture(undefined, undefined, undefined, gate);

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result).toMatchObject({ status: "stale", conflicts: [{ code: "write-locked" }] });
    expect(await fixture.journal.list()).toEqual([]);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("coalesces concurrent calls onto the exact same promise and opens only after success", async () => {
    const fixture = await recoveryAuditFixture([]);
    const first = fixture.audit.auditInFlight();
    const second = fixture.audit.auditInFlight();

    expect(first).toBe(second);
    await first;
    expect(fixture.gate.isReady()).toBe(true);
    const saves = fixture.port.saveCalls.length;
    await fixture.audit.auditInFlight();
    expect(fixture.port.saveCalls).toHaveLength(saves);
  });

  it("legally settles a planned no-write journal without writing the vault", async () => {
    const fixture = await recoveryAuditFixture([await interruptedEntry("planned")]);
    const before = [...fixture.vault.calls];

    await fixture.audit.auditInFlight();

    expect((await fixture.journal.list())[0]?.status).toBe("rolled-back");
    expect(fixture.vault.calls).toEqual(before);
    expect(fixture.gate.isReady()).toBe(true);
  });

  it("marks an applied completed step recovery-required using actual vault evidence", async () => {
    const completed = await createPersistentTransactionFixture();
    const result = await completed.service.execute(completed.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const entry = await completed.journal.get(result.journalId);
    if (entry === null) throw new Error("Missing completed journal");
    const fixture = await recoveryAuditFixture([{ ...entry, status: "executing" }], completed.vault);

    await fixture.audit.auditInFlight();

    const audited = (await fixture.journal.list())[0];
    expect(audited?.status).toBe("recovery-required");
    expect(audited?.recovery?.unresolved.map((value) => value.operationId)).toEqual([entry.completed[0]!.operation.id]);
    expect(fixture.vault.calls).toHaveLength(1);
  });

  it("records a missing rollback marker only when restored state is independently proven", async () => {
    const completed = await createPersistentTransactionFixture();
    const result = await completed.service.execute(completed.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const entry = await completed.journal.get(result.journalId);
    if (entry === null) throw new Error("Missing completed journal");
    completed.vault.rename("x.md", "a.md");
    const fixture = await recoveryAuditFixture([{ ...entry, status: "rolling-back", error: "restart" }], completed.vault);

    await fixture.audit.auditInFlight();

    expect((await fixture.journal.list())[0]).toMatchObject({
      status: "rolled-back",
      rolledBackOperationIds: [entry.completed[0]!.operation.id],
    });
    expect(fixture.vault.calls).toHaveLength(1);
  });

  it("never rewrites existing terminal history or recovery entries", async () => {
    const completed = await createPersistentTransactionFixture();
    const result = await completed.service.execute(completed.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const entry = await completed.journal.get(result.journalId);
    if (entry === null) throw new Error("Missing completed journal");
    const fixture = await recoveryAuditFixture([entry], completed.vault);
    const saves = fixture.port.saveCalls.length;

    await fixture.audit.auditInFlight();

    expect(fixture.port.saveCalls).toHaveLength(saves);
    expect((await fixture.journal.list())[0]).toEqual(entry);
  });

  it("fails closed on malformed or fingerprint-invalid history", async () => {
    const invalid = await interruptedEntry("planned");
    const fixture = await recoveryAuditFixture([{ ...invalid, plan: { ...invalid.plan, fingerprint: "bad" } }]);

    await expect(fixture.audit.auditInFlight()).rejects.toThrow("Malformed journal");

    expect(fixture.gate.isReady()).toBe(false);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("fails closed on duplicate IDs before reading or writing the vault", async () => {
    const entry = await interruptedEntry("planned");
    const fixture = await recoveryAuditFixture([entry, structuredClone(entry)]);

    await expect(fixture.audit.auditInFlight()).rejects.toThrow("Duplicate journal ID");
    expect(fixture.gate.isReady()).toBe(false);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("fails closed on multiple independently valid active journals", async () => {
    const first = await interruptedEntry("planned", "first");
    const second = await interruptedEntry("planned", "second");
    const fixture = await recoveryAuditFixture([first, second]);

    await expect(fixture.audit.auditInFlight()).rejects.toThrow("Multiple active journals");
    expect(fixture.gate.isReady()).toBe(false);
    expect(fixture.port.saveCalls).toHaveLength(2);
  });

  it("rejects an impossible prepared-plus-recorded-rollback active combination", async () => {
    const base = await createPersistentTransactionFixture(undefined, undefined, [rename(), setKind("b.md")]);
    const entry = await base.journal.begin(base.confirmedPlan, 7);
    await base.journal.markExecuting(entry.id);
    const first = base.confirmedPlan.operations[0]!;
    if (first.kind !== "move" && first.kind !== "rename") throw new Error("Expected structural operation first");
    const firstPreconditions = base.confirmedPlan.preconditions.filter((value) => value.path === first.sourcePath || value.path === first.targetPath);
    await base.journal.prepare(entry.id, first, { ...first, sourcePath: first.targetPath, targetPath: first.sourcePath }, firstPreconditions);
    const source = firstPreconditions.find((value) => value.path === first.sourcePath);
    if (source?.exists !== true) throw new Error("Expected existing structural source");
    await base.journal.recordCompleted(entry.id, [
      { path: first.sourcePath, exists: false },
      { path: first.targetPath, exists: true, mtime: source.mtime + 1, contentHash: source.contentHash },
    ]);
    const second = base.confirmedPlan.operations[1]!;
    if (second.kind !== "set-owned-field") throw new Error("Expected field operation second");
    const secondPreconditions = base.confirmedPlan.preconditions.filter((value) => value.path === second.path);
    await base.journal.prepare(entry.id, second, { ...second, before: second.after, after: second.before }, secondPreconditions);
    const impossible = {
      ...(await base.journal.get(entry.id))!,
      status: "rolling-back",
      error: "impossible",
      rolledBackOperationIds: [first.id],
    };
    const fixture = await recoveryAuditFixture([impossible], base.vault);

    await expect(fixture.audit.auditInFlight()).rejects.toThrow("Malformed journal");
    expect(fixture.gate.isReady()).toBe(false);
  });

  it("preserves unreadable prepared state with an unreadable recovery comparison", async () => {
    const vault = new UnreadableVault();
    const base = await createPersistentTransactionFixture(undefined, vault);
    const entry = await base.journal.begin(base.confirmedPlan, 5);
    await base.journal.markExecuting(entry.id);
    const operation = base.confirmedPlan.operations[0]!;
    if (operation.kind !== "move" && operation.kind !== "rename") throw new Error("Expected structural operation");
    await base.journal.prepare(entry.id, operation, { ...operation, sourcePath: "x.md", targetPath: "a.md" }, base.confirmedPlan.preconditions);
    vault.unreadable = true;
    const fixture = await recoveryAuditFixture([(await base.journal.get(entry.id))!], vault);

    await fixture.audit.auditInFlight();

    expect((await fixture.journal.get(entry.id))?.recovery?.unresolved[0]?.comparison).toBe("unreadable");
    expect(vault.calls).toEqual([]);
  });

  it("rejects a persist-then-throw transition whose unrelated durable field was altered", async () => {
    const entry = await interruptedEntry("planned");
    const port = new TamperingTransitionPort(pluginData([entry]));
    const store = new PluginDataStore(port);
    await store.load();
    const gate = new RecoveryReadinessGate();
    const audit = new RecoveryAuditService(new OperationJournal(store), new ScriptedFailureVault(), gate, store);

    await expect(audit.auditInFlight()).rejects.toThrow("persisted-tampered-transition");
    expect(gate.isReady()).toBe(false);
  });

  it("cannot reopen readiness through a stale audit lease after reset", async () => {
    const completed = await createPersistentTransactionFixture();
    const result = await completed.service.execute(completed.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const entry = (await completed.journal.get(result.journalId))!;
    const fixture = await recoveryAuditFixture([{ ...entry, status: "executing" }], completed.vault);
    fixture.port.pauseNextSave();

    const auditing = fixture.audit.auditInFlight();
    await fixture.port.waitUntilSavePaused();
    fixture.gate.reset();
    fixture.port.resumeSaves();

    await expect(auditing).rejects.toThrow("lease expired");
    expect(fixture.gate.isReady()).toBe(false);
  });

  it("rechecks readiness after claim-local full revalidation before appending WAL", async () => {
    const readiness = RecoveryReadinessGate.readyForTests();
    const fixture = await createPersistentTransactionFixture(undefined, undefined, undefined, readiness);
    const original = fixture.plans.revalidate.bind(fixture.plans);
    let calls = 0;
    fixture.plans.revalidate = async (plan) => {
      const result = await original(plan);
      calls += 1;
      if (calls === 2) readiness.reset();
      return result;
    };

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result).toMatchObject({ status: "stale", conflicts: [{ code: "write-locked" }] });
    expect(await fixture.journal.list()).toEqual([]);
    expect(fixture.vault.calls).toEqual([]);
  });

  it.each([
    "rolling-back",
    "clear-prepared",
    "record-rolled-back",
    "terminal-rolled-back",
    "terminal-recovery-required",
  ] as const)("reconciles exact persist-then-throw at audit boundary %s", async (boundary) => {
    const { entry, vault } = await boundaryScenario(boundary);
    const port = new FaultingPluginDataPort({ boundary, mode: "after" }, pluginData([entry]));
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const gate = new RecoveryReadinessGate();
    const audit = new RecoveryAuditService(journal, vault, gate, store);

    await audit.auditInFlight();

    const expected = boundary === "terminal-recovery-required" ? "recovery-required" : "rolled-back";
    expect((await journal.get(entry.id))?.status).toBe(expected);
    expect(gate.isReady()).toBe(true);
  });

  it.each([
    "rolling-back",
    "clear-prepared",
    "record-rolled-back",
    "terminal-rolled-back",
    "terminal-recovery-required",
  ] as const)("stops on save-before at %s and retries only on the next explicit audit", async (boundary) => {
    const { entry, vault } = await boundaryScenario(boundary);
    const port = new FaultingPluginDataPort({ boundary, mode: "before" }, pluginData([entry]));
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const gate = new RecoveryReadinessGate();
    const audit = new RecoveryAuditService(journal, vault, gate, store);

    await expect(audit.auditInFlight()).rejects.toThrow(`save-${boundary}-before`);
    expect(gate.isReady()).toBe(false);

    await audit.auditInFlight();
    expect(gate.isReady()).toBe(true);
    const expected = boundary === "terminal-recovery-required" ? "recovery-required" : "rolled-back";
    expect((await journal.get(entry.id))?.status).toBe(expected);
  });

  it("keeps readiness closed when durable reload cannot prove an ambiguous transition", async () => {
    const entry = await interruptedEntry("planned");
    const port = new FaultingPluginDataPort({ boundary: "rolling-back", mode: "after", failReload: true }, {
      schemaVersion: 1,
      settings: {},
      operational: { journals: [entry] },
    });
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const gate = new RecoveryReadinessGate();
    const audit = new RecoveryAuditService(journal, new ScriptedFailureVault(), gate, store);

    await expect(audit.auditInFlight()).rejects.toThrow(/save-rolling-back-after|fault-port-reload-failed/);
    expect(gate.isReady()).toBe(false);
  });

  it("clears a prepared step only when every persisted precondition still matches", async () => {
    const base = await createPersistentTransactionFixture();
    const entry = await base.journal.begin(base.confirmedPlan, 5);
    await base.journal.markExecuting(entry.id);
    const operation = base.confirmedPlan.operations[0]!;
    if (operation.kind !== "move" && operation.kind !== "rename") throw new Error("Expected structural operation");
    await base.journal.prepare(entry.id, operation, { ...operation, sourcePath: "x.md", targetPath: "a.md" }, base.confirmedPlan.preconditions);
    const fixture = await recoveryAuditFixture([await base.journal.get(entry.id)], base.vault);

    await fixture.audit.auditInFlight();

    expect((await fixture.journal.get(entry.id))?.status).toBe("rolled-back");
    expect(fixture.vault.calls).toEqual([]);
  });

  it("reports prepared drift without clearing or writing the vault", async () => {
    const base = await createPersistentTransactionFixture();
    const entry = await base.journal.begin(base.confirmedPlan, 5);
    await base.journal.markExecuting(entry.id);
    const operation = base.confirmedPlan.operations[0]!;
    if (operation.kind !== "move" && operation.kind !== "rename") throw new Error("Expected structural operation");
    await base.journal.prepare(entry.id, operation, { ...operation, sourcePath: "x.md", targetPath: "a.md" }, base.confirmedPlan.preconditions);
    base.vault.modifyExternally("a.md");
    const fixture = await recoveryAuditFixture([await base.journal.get(entry.id)], base.vault);

    await fixture.audit.auditInFlight();

    const audited = await fixture.journal.get(entry.id);
    expect(audited?.status).toBe("recovery-required");
    expect(audited?.prepared).not.toBeNull();
    expect(audited?.recovery?.unresolved).toHaveLength(1);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("records only proven restored suffixes and reports every remaining applied step", async () => {
    const completed = await createPersistentTransactionFixture(undefined, undefined, [rename(), setKind("b.md")]);
    const result = await completed.service.execute(completed.confirmedPlan);
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    const entry = await completed.journal.get(result.journalId);
    if (entry === null) throw new Error("Missing completed journal");
    const last = entry.completed.at(-1)!;
    if (last.operation.kind === "move" || last.operation.kind === "rename") throw new Error("Expected field operation last");
    await completed.vault.setOwnedField("b.md", "knowledge-workbench-kind", last.operation.after, last.operation.before);
    const fixture = await recoveryAuditFixture([{ ...entry, status: "rolling-back", error: "restart" }], completed.vault);

    await fixture.audit.auditInFlight();

    const audited = await fixture.journal.get(entry.id);
    expect(audited?.status).toBe("recovery-required");
    expect(audited?.rolledBackOperationIds).toEqual([last.operation.id]);
    expect(audited?.recovery?.unresolved.map((value) => value.operationId)).toEqual([entry.completed[0]!.operation.id]);
  });

  it("rejects active history clearing atomically", async () => {
    const fixture = await recoveryAuditFixture([await interruptedEntry("executing")]);
    await expect(fixture.journal.clearHistory()).rejects.toThrow("Cannot clear history while a transaction is active");
    expect((await fixture.journal.list()).map((entry) => entry.id)).toEqual(["interrupted"]);
  });
});
