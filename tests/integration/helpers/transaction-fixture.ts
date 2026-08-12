import type { PluginDataPort } from "../../../src/core/ports";
import type { FieldState, FilePrecondition, PlannedOperation } from "../../../src/core/types";
import { ChangePlanService, type ConfirmedPlan } from "../../../src/plans/change-plan-service";
import { PluginDataStore } from "../../../src/storage/plugin-data-store";
import { OperationJournal } from "../../../src/transactions/operation-journal";
import { TransactionService } from "../../../src/transactions/transaction-service";
import { UndoService } from "../../../src/transactions/undo-service";
import { RecoveryReadinessGate } from "../../../src/transactions/recovery-readiness-gate";
import { MemoryPluginDataPort } from "../../fakes/memory-plugin-data-port";
import { ScriptedFailureVault } from "../../fakes/scripted-failure-vault";

export const rename = (sourcePath = "a.md", targetPath = "x.md"): PlannedOperation => ({
  id: `rename:${sourcePath}->${targetPath}`,
  kind: "rename",
  sourcePath,
  targetPath,
});

export const setKind = (path = "b.md", value = "reference"): PlannedOperation => ({
  id: `set:${path}:${value}`,
  kind: "set-owned-field",
  path,
  field: "knowledge-workbench-kind",
  before: { present: false },
  after: { present: true, value },
});

export const addRelated = (path = "a.md", targetPath = "target.md"): PlannedOperation => ({
  id: `related:${path}->${targetPath}`,
  kind: "add-related-link",
  path,
  targetPath,
  before: { present: false },
  after: { present: true, value: [`[[${targetPath}]]`] },
});

export interface JournalFaults {
  readonly failRecordCompletedNumbers?: readonly number[];
  readonly failRecordRolledBackNumbers?: readonly number[];
  readonly alterPersistedRecordCompleted?: Readonly<Record<number, "hash" | "mtime">>;
  readonly alterPersistedRecovery?: "comparison" | "reason";
}

export type JournalBoundary =
  | "begin"
  | "executing"
  | "prepare"
  | "clear-prepared"
  | "record-completed"
  | "rolling-back"
  | "record-rolled-back"
  | "terminal-completed"
  | "terminal-rolled-back"
  | "terminal-recovery-required";

export type SaveFailureMode = "before" | "after";

const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const journalsFrom = (value: unknown): readonly unknown[] => {
  const root = object(value);
  const operational = object(root?.operational);
  return Array.isArray(operational?.journals) ? operational.journals : [];
};

const boundaryOf = (before: unknown, after: unknown): JournalBoundary | null => {
  const previous = object(journalsFrom(before).at(-1));
  const next = object(journalsFrom(after).at(-1));
  if (previous === null && next?.status === "planned") return "begin";
  if (previous === null || next === null) return null;
  const previousCompleted = Array.isArray(previous.completed) ? previous.completed.length : 0;
  const nextCompleted = Array.isArray(next.completed) ? next.completed.length : 0;
  const previousRolled = Array.isArray(previous.rolledBackOperationIds) ? previous.rolledBackOperationIds.length : 0;
  const nextRolled = Array.isArray(next.rolledBackOperationIds) ? next.rolledBackOperationIds.length : 0;
  if (previous.status !== next.status) {
    if (next.status === "executing") return "executing";
    if (next.status === "rolling-back") return "rolling-back";
    if (next.status === "completed") return "terminal-completed";
    if (next.status === "rolled-back") return "terminal-rolled-back";
    if (next.status === "recovery-required") return "terminal-recovery-required";
  }
  if (nextCompleted > previousCompleted) return "record-completed";
  if (nextRolled > previousRolled) return "record-rolled-back";
  if (previous.prepared === null && next.prepared !== null) return "prepare";
  if (previous.prepared !== null && next.prepared === null) return "clear-prepared";
  return null;
};

export class FaultingPluginDataPort implements PluginDataPort {
  private data: unknown;
  private fired = false;
  readonly boundaries: (JournalBoundary | null)[] = [];

  constructor(
    private readonly fault: Readonly<{ boundary: JournalBoundary; mode: SaveFailureMode; failReload?: boolean }>,
    initial: unknown = undefined,
  ) {
    this.data = clone(initial);
  }

  async load(): Promise<unknown> {
    if (this.fired && this.fault.failReload === true) throw new Error("fault-port-reload-failed");
    return clone(this.data);
  }

  async save(data: unknown): Promise<void> {
    const snapshot = clone(data);
    const boundary = boundaryOf(this.data, snapshot);
    this.boundaries.push(boundary);
    if (!this.fired && boundary === this.fault.boundary) {
      this.fired = true;
      if (this.fault.mode === "before") throw new Error(`save-${boundary}-before`);
      this.data = snapshot;
      throw new Error(`save-${boundary}-after`);
    }
    this.data = snapshot;
  }
}

type AfterPrepare = () => void | Promise<void>;

class RecordingOperationJournal extends OperationJournal {
  readonly calls: string[] = [];
  private afterBegin: AfterPrepare | null = null;
  private afterPrepare: AfterPrepare | null = null;
  private prepareNumber = 0;
  private recordCompletedNumber = 0;
  private recordRolledBackNumber = 0;

  constructor(store: PluginDataStore, private readonly faults: JournalFaults = {}) {
    super(store);
  }

  onAfterBegin(callback: AfterPrepare): void {
    this.afterBegin = callback;
  }

  onAfterPrepare(callback: AfterPrepare): void;
  onAfterPrepare(prepareNumber: number, callback: AfterPrepare): void;
  onAfterPrepare(numberOrCallback: number | AfterPrepare, callback?: AfterPrepare): void {
    const prepareNumber = typeof numberOrCallback === "number" ? numberOrCallback : 1;
    const selected = typeof numberOrCallback === "function" ? numberOrCallback : callback!;
    this.afterPrepare = async () => {
      if (this.prepareNumber === prepareNumber) await selected();
    };
  }

  override async begin(...args: Parameters<OperationJournal["begin"]>) {
    this.calls.push("begin");
    const entry = await super.begin(...args);
    await this.afterBegin?.();
    return entry;
  }

  override async markExecuting(id: string): Promise<void> {
    this.calls.push("executing");
    await super.markExecuting(id);
  }

  override async prepare(
    id: string,
    operation: PlannedOperation,
    inverse: PlannedOperation,
    preconditions: readonly FilePrecondition[],
  ): Promise<void> {
    this.calls.push(`prepare:${operation.id}`);
    await super.prepare(id, operation, inverse, preconditions);
    this.prepareNumber += 1;
    await this.afterPrepare?.();
  }

  override async recordCompleted(
    id: string,
    postconditions: readonly FilePrecondition[],
    postFieldState?: FieldState,
  ): Promise<void> {
    this.calls.push("record-completed");
    this.recordCompletedNumber += 1;
    const alteration = this.faults.alterPersistedRecordCompleted?.[this.recordCompletedNumber];
    if (alteration !== undefined) {
      const altered = postconditions.map((value) => value.exists
        ? {
            ...value,
            ...(alteration === "hash"
              ? { contentHash: `altered:${value.contentHash}` }
              : { mtime: value.mtime + 1 }),
          }
        : value);
      await super.recordCompleted(id, altered, postFieldState);
      throw new Error(`record-completed-persisted-altered-${alteration}`);
    }
    if (this.faults.failRecordCompletedNumbers?.includes(this.recordCompletedNumber) === true) {
      throw new Error(`record-completed-failed:${this.recordCompletedNumber}`);
    }
    await super.recordCompleted(id, postconditions, postFieldState);
  }

  override async markRollingBack(id: string, error?: string): Promise<void> {
    this.calls.push("rolling-back");
    await super.markRollingBack(id, error);
  }

  override async recordRolledBack(id: string, operationId: string): Promise<void> {
    this.calls.push(`record-rolled-back:${operationId}`);
    this.recordRolledBackNumber += 1;
    if (this.faults.failRecordRolledBackNumbers?.includes(this.recordRolledBackNumber) === true) {
      throw new Error(`record-rolled-back-failed:${this.recordRolledBackNumber}`);
    }
    await super.recordRolledBack(id, operationId);
  }

  override async markRolledBack(id: string, error?: string): Promise<void> {
    this.calls.push("rolled-back");
    await super.markRolledBack(id, error);
  }

  override async markRecoveryRequired(...args: Parameters<OperationJournal["markRecoveryRequired"]>): Promise<void> {
    this.calls.push("recovery-required");
    const alteration = this.faults.alterPersistedRecovery;
    if (alteration !== undefined) {
      const [id, error, recovery] = args;
      const [first, ...rest] = recovery.unresolved;
      if (first === undefined) throw new Error("Expected a recovery issue to alter");
      const altered = {
        unresolved: [{
          ...first,
          ...(alteration === "comparison"
            ? { comparison: first.comparison === "differs" ? "unreadable" as const : "differs" as const }
            : { reason: `${first.reason}:altered` }),
        }, ...rest],
      };
      await super.markRecoveryRequired(id, error, altered);
      throw new Error(`recovery-persisted-altered-${alteration}`);
    }
    await super.markRecoveryRequired(...args);
  }

  override async markCompleted(id: string): Promise<void> {
    this.calls.push("completed");
    await super.markCompleted(id);
  }
}

export async function transactionFixture(
  vault = new ScriptedFailureVault(),
  operations: readonly PlannedOperation[] = [rename()],
  persistedPort: PluginDataPort = new MemoryPluginDataPort(),
  journalFaults: JournalFaults = {},
) {
  const store = new PluginDataStore(persistedPort);
  await store.load();
  let writeEnabled = true;
  const plans = new ChangePlanService(vault, () => writeEnabled);
  const preview = await plans.preview(operations);
  const confirmedPlan = await plans.confirm(preview, operations.map((operation) => operation.id));
  const journal = new RecordingOperationJournal(store, journalFaults);
  const service = new TransactionService(plans, vault, vault, journal, { now: () => 100 }, RecoveryReadinessGate.readyForTests());
  return {
    service,
    vault,
    journal,
    plans,
    confirmedPlan,
    persistedPort,
    store,
    setWriteEnabled(value: boolean): void { writeEnabled = value; },
    async journalEntries() { return await journal.list(); },
  };
}

export async function createPersistentTransactionFixture(
  persistedPort: PluginDataPort = new MemoryPluginDataPort(),
  vault = new ScriptedFailureVault(),
  operations: readonly PlannedOperation[] = [rename()],
  readiness = RecoveryReadinessGate.readyForTests(),
) {
  const store = new PluginDataStore(persistedPort);
  await store.load();
  let writeEnabled = true;
  const plans = new ChangePlanService(vault, () => writeEnabled);
  const journal = new OperationJournal(store);
  const historical = await journal.list();
  const confirmedPlan: ConfirmedPlan = historical[0]?.plan
    ?? await plans.confirm(await plans.preview(operations), operations.map((operation) => operation.id));
  const service = new TransactionService(plans, vault, vault, journal, { now: () => 100 }, readiness);
  const undo = new UndoService(journal, vault, plans);
  return {
    service,
    vault,
    journal,
    plans,
    undo,
    confirmedPlan,
    persistedPort,
    store,
    readiness,
    setWriteEnabled(value: boolean): void { writeEnabled = value; },
  };
}

export async function durableJournalEntries(persistedPort: PluginDataPort) {
  const store = new PluginDataStore(persistedPort);
  await store.load();
  return await new OperationJournal(store).list();
}
