import type { PlannedOperation } from "../../src/core/types";
import { ChangePlanService } from "../../src/plans/change-plan-service";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import type { JournalEntry, JournalStatus } from "../../src/transactions/operation-journal";
import { OperationJournal } from "../../src/transactions/operation-journal";
import { RecoveryAuditService } from "../../src/transactions/recovery-audit-service";
import { RecoveryReadinessGate } from "../../src/transactions/recovery-readiness-gate";
import type { HistoryActions } from "../../src/ui/history-tab";
import { MemoryPluginDataPort } from "../fakes/memory-plugin-data-port";
import { ScriptedFailureVault } from "../fakes/scripted-failure-vault";
import { rename } from "../integration/helpers/transaction-fixture";

const clone = <T>(value: T): T => structuredClone(value);

const entryFrom = async (id: string, createdAt: number, operations: readonly PlannedOperation[] = [rename()]): Promise<JournalEntry> => {
  const vault = new ScriptedFailureVault();
  const plans = new ChangePlanService(vault, () => true);
  const preview = await plans.preview(operations);
  const plan = await plans.confirm(preview, operations.map((operation) => operation.id));
  return { id, createdAt, status: "planned", plan, prepared: null, completed: [], rolledBackOperationIds: [] };
};

export async function interruptedEntry(status: "planned" | "executing", id = "interrupted"): Promise<JournalEntry> {
  return { ...await entryFrom(id, 1), status };
}

export async function completedEntry(id: string, createdAt = Number(id) || 1): Promise<JournalEntry> {
  const base = await entryFrom(id, createdAt);
  const operation = base.plan.operations[0]!;
  if (operation.kind !== "move" && operation.kind !== "rename") throw new Error("Fixture requires a structural operation");
  const source = base.plan.preconditions.find((value) => value.path === "a.md")!;
  return {
    ...base,
    status: "completed",
    completed: [{
      operation,
      inverse: { ...operation, sourcePath: "x.md", targetPath: "a.md" },
      preconditions: base.plan.preconditions,
      postconditions: [
        { path: "a.md", exists: false },
        { path: "x.md", exists: true, mtime: source.exists ? source.mtime + 1 : 2, contentHash: source.exists ? source.contentHash : "hash" },
      ],
    }],
  };
}

export async function recoveryEntry(id: string, createdAt = Number(id) || 1): Promise<JournalEntry> {
  return {
    ...await entryFrom(id, createdAt),
    status: "recovery-required",
    error: "manual recovery",
    recovery: {
      unresolved: [{
        operationId: "rename:a.md->x.md",
        originalPaths: ["a.md", "x.md"],
        currentPaths: ["a.md"],
        comparison: "differs",
        reason: "manual recovery",
      }],
    },
  };
}

export async function journalFixture(initial: readonly unknown[] = []) {
  const port = new MemoryPluginDataPort();
  const store = new PluginDataStore(port);
  await store.load();
  const journal = new OperationJournal(store);
  const seed = async (entry: unknown): Promise<void> => {
    await store.mutateJournals((journals) => ({ journals: [...journals, clone(entry)], result: undefined }));
  };
  for (const entry of initial) await seed(entry);
  return { port, store, journal, seed };
}

export async function recoveryAuditFixture(
  initial: unknown,
  vault = new ScriptedFailureVault(),
) {
  const entries: readonly unknown[] = Array.isArray(initial) ? initial : [initial];
  const base = await journalFixture(entries);
  const gate = new RecoveryReadinessGate();
  const audit = new RecoveryAuditService(base.journal, vault, gate, base.store);
  return { ...base, vault, gate, audit };
}

export function noOpHistoryActions(): HistoryActions {
  return { onUndo: () => undefined, onViewRecovery: () => undefined, onClear: () => undefined, onExport: () => undefined };
}

export const journalStatus = (entry: JournalEntry, status: JournalStatus): JournalEntry => ({ ...entry, status });
