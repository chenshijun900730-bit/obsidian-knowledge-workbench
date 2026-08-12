import { describe, expect, it } from "vitest";
import type { PluginDataPort } from "../../src/core/ports";
import type { FieldState, FilePrecondition, PlannedOperation } from "../../src/core/types";
import { ChangePlanService, type ConfirmedPlan } from "../../src/plans/change-plan-service";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import { OperationJournal, type JournalEntry, type RecoveryReport } from "../../src/transactions/operation-journal";
import { TransactionService } from "../../src/transactions/transaction-service";
import { RecoveryReadinessGate } from "../../src/transactions/recovery-readiness-gate";
import { FakeVault } from "../fakes/fake-vault";
import { MemoryPluginDataPort } from "../fakes/memory-plugin-data-port";
import { ScriptedFailureVault } from "../fakes/scripted-failure-vault";
import { refingerprintPlan } from "../helpers/plan-fixtures";
import {
  FaultingPluginDataPort,
  addRelated,
  durableJournalEntries,
  rename,
  setKind,
  transactionFixture,
  type JournalBoundary,
  type SaveFailureMode,
} from "./helpers/transaction-fixture";

const confirmedRenamePlan = async (): Promise<ConfirmedPlan> => {
  const vault = FakeVault.withNotes(["a.md"]);
  const plans = new ChangePlanService(vault, () => true);
  const preview = await plans.preview([{
    id: "rename:a.md->x.md",
    kind: "rename",
    sourcePath: "a.md",
    targetPath: "x.md",
  }]);
  return await plans.confirm(preview, ["rename:a.md->x.md"]);
};

const confirmedTwoStepPlan = async (): Promise<ConfirmedPlan> => {
  const vault = FakeVault.withNotes(["a.md", "b.md"]);
  const plans = new ChangePlanService(vault, () => true);
  const preview = await plans.preview([
    {
      id: "01:rename:a.md->x.md",
      kind: "rename",
      sourcePath: "a.md",
      targetPath: "x.md",
    },
    {
      id: "02:set:b.md",
      kind: "set-owned-field",
      path: "b.md",
      field: "knowledge-workbench-kind",
      before: { present: false },
      after: { present: true, value: "reference" },
    },
  ]);
  return await plans.confirm(preview, preview.plan.operations.map((operation) => operation.id));
};

const inverseOf = (operation: PlannedOperation): PlannedOperation => {
  if ("sourcePath" in operation) {
    return { ...operation, sourcePath: operation.targetPath, targetPath: operation.sourcePath };
  }
  if (operation.kind === "add-related-link") {
    return {
      id: operation.id,
      kind: "set-owned-field",
      path: operation.path,
      field: "knowledge-workbench-related",
      before: operation.after,
      after: operation.before,
    };
  }
  return { ...operation, before: operation.after, after: operation.before };
};

const preconditionsFor = (plan: ConfirmedPlan, operation: PlannedOperation): readonly FilePrecondition[] => {
  const paths = "sourcePath" in operation
    ? [operation.sourcePath, operation.targetPath]
    : operation.kind === "add-related-link"
      ? [operation.path, operation.targetPath]
      : [operation.path];
  return paths.map((path) => plan.preconditions.find((value) => value.path === path)!);
};

const postconditionsFor = (plan: ConfirmedPlan, operation: PlannedOperation): readonly FilePrecondition[] => {
  if ("sourcePath" in operation) {
    const source = plan.preconditions.find((value) => value.path === operation.sourcePath);
    if (source?.exists !== true) throw new Error(`Expected source precondition: ${operation.sourcePath}`);
    return [
      { path: operation.sourcePath, exists: false },
      { path: operation.targetPath, exists: true, mtime: 100, contentHash: source.contentHash },
    ];
  }
  return [{ path: operation.path, exists: true, mtime: 100, contentHash: `post:${operation.id}` }];
};

const postFieldStateFor = (operation: PlannedOperation): FieldState | undefined =>
  operation.kind === "set-owned-field" || operation.kind === "add-related-link" ? operation.after : undefined;

const recoveryReport = (operationId = "rename:a.md->x.md"): RecoveryReport => ({
  unresolved: [{
    operationId,
    originalPaths: ["a.md"],
    currentPaths: ["x.md"],
    comparison: "differs",
    reason: "uncertain write",
  }],
});

const completeJournal = async (
  journal: OperationJournal,
  plan: ConfirmedPlan,
  createdAt: number,
): Promise<string> => {
  const entry = await journal.begin(plan, createdAt);
  await journal.markExecuting(entry.id);
  for (const operation of plan.operations) {
    await journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation));
    await journal.recordCompleted(entry.id, postconditionsFor(plan, operation), postFieldStateFor(operation));
  }
  await journal.markCompleted(entry.id);
  return entry.id;
};

const rollBackJournal = async (
  journal: OperationJournal,
  plan: ConfirmedPlan,
  createdAt: number,
): Promise<string> => {
  const entry = await journal.begin(plan, createdAt);
  await journal.markExecuting(entry.id);
  for (const operation of plan.operations) {
    await journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation));
    await journal.recordCompleted(entry.id, postconditionsFor(plan, operation), postFieldStateFor(operation));
  }
  await journal.markRollingBack(entry.id, "test rollback");
  for (const operation of [...plan.operations].reverse()) await journal.recordRolledBack(entry.id, operation.id);
  await journal.markRolledBack(entry.id, "test rollback");
  return entry.id;
};

const clone = <T>(value: T): T => structuredClone(value);

class AmbiguousSavePort implements PluginDataPort {
  private data: unknown;
  private nextFailure: "before" | "after" | null = null;
  failLoads = false;
  loadCalls = 0;
  saveCalls = 0;

  constructor(initial: unknown = undefined) {
    this.data = clone(initial);
  }

  async load(): Promise<unknown> {
    this.loadCalls += 1;
    if (this.failLoads) throw new Error("Injected reload failure");
    return clone(this.data);
  }

  async save(data: unknown): Promise<void> {
    this.saveCalls += 1;
    const snapshot = clone(data);
    const failure = this.nextFailure;
    this.nextFailure = null;
    if (failure === "before") throw new Error("Injected save-before-persist failure");
    this.data = snapshot;
    if (failure === "after") throw new Error("Injected persist-then-throw failure");
  }

  failNextSave(mode: "before" | "after"): void {
    this.nextFailure = mode;
  }

  snapshot(): unknown {
    return clone(this.data);
  }
}

describe("OperationJournal global write interlock", () => {
  it("treats exact legacy settled-only history as non-blocking for controller and transaction execution", async () => {
    const fixture = await transactionFixture();
    await fixture.store.mutateJournals(() => ({ journals: [{ status: "settled" }], result: undefined }));

    expect(fixture.journal.organizationWritesBlocked()).toBe(false);
    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("completed");
    expect(fixture.vault.calls).toEqual(["rename:a.md->x.md"]);
  });

  it("atomically grants only one global claim across journals sharing one store", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const plan = await confirmedRenamePlan();
    const first = new OperationJournal(store);
    const second = new OperationJournal(store);

    const claims = await Promise.allSettled([
      first.begin(plan, 1),
      second.begin(plan, 2),
    ]);

    const fulfilled = claims.filter((claim) => claim.status === "fulfilled");
    const rejected = claims.filter((claim) => claim.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection: unknown = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) throw new Error("Expected a rejected journal claim error");
    expect(rejection.message).toMatch(/write.?locked|unfinished|recovery/iu);
    const persisted = await first.list();
    expect(persisted).toEqual([
      expect.objectContaining({ status: "planned", prepared: null, completed: [] }),
    ]);
    expect([1, 2]).toContain(persisted[0]?.createdAt);
  });

  it("rejects a new claim when any unfinished or recovery-required record is preloaded", async () => {
    const plan = await confirmedRenamePlan();
    for (const status of ["planned", "executing", "rolling-back", "recovery-required"] as const) {
      const port = new MemoryPluginDataPort({
        schemaVersion: 1,
        settings: {},
        operational: { journals: [{ id: `unfinished-${status}`, status }] },
      });
      const store = new PluginDataStore(port);
      await store.load();
      const journal = new OperationJournal(store);

      await expect(journal.begin(plan, 1)).rejects.toThrow(/write.?locked|unfinished|recovery/iu);
      expect(port.saveCalls).toHaveLength(0);
      expect(store.operational().journals).toEqual([{ id: `unfinished-${status}`, status }]);
    }
  });

  it("rejects unknown or missing active-looking journal state and performs zero saves", async () => {
    const plan = await confirmedRenamePlan();
    for (const record of [
      { id: "future", status: "future-active", prepared: {} },
      { id: "missing-status", plan, prepared: null, completed: [], rolledBackOperationIds: [] },
    ]) {
      const port = new MemoryPluginDataPort({
        schemaVersion: 1,
        settings: {},
        operational: { journals: [record] },
      });
      const store = new PluginDataStore(port);
      await store.load();

      await expect(new OperationJournal(store).begin(plan, 3)).rejects.toThrow(/write.?locked|unfinished|malformed|recovery/iu);
      expect(port.saveCalls).toHaveLength(0);
    }
  });

  it("fails closed instead of filtering an active-looking malformed record from list", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: [{ id: 42, status: "executing" }] },
    }));
    await store.load();
    const journal = new OperationJournal(store);

    await expect(journal.list()).rejects.toThrow(/malformed|journal/iu);
    expect(store.operational().journals).toEqual([{ id: 42, status: "executing" }]);
  });

  it("allocates unique IDs when a settled journal has the same plan and timestamp", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const firstId = await completeJournal(journal, plan, 7);
    const secondId = await completeJournal(journal, plan, 7);

    expect(secondId).not.toBe(firstId);
    expect(store.operational().journals.map((entry) => (entry as { id?: unknown }).id)).toEqual([firstId, secondId]);
  });

  it("fails closed on duplicate persisted IDs before mutating either record", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const entry = await journal.begin(plan, 8);
    await store.appendJournal(structuredClone(entry));
    const before = store.operational().journals;

    await expect(journal.markExecuting(entry.id)).rejects.toThrow(/duplicate/iu);
    expect(store.operational().journals).toEqual(before);
  });

  it("fails closed on a malformed target entry before a transition and performs zero saves", async () => {
    const port = new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: {
        journals: [{
          id: "malformed-target",
          status: "planned",
          createdAt: 1,
          prepared: null,
          completed: [],
          rolledBackOperationIds: [],
        }],
      },
    });
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);

    await expect(journal.markExecuting("malformed-target")).rejects.toThrow(/malformed/iu);
    expect(port.saveCalls).toHaveLength(0);
  });

  it("fails closed after an initial journal read failure and performs zero saves", async () => {
    const port = new AmbiguousSavePort();
    port.failLoads = true;
    const store = new PluginDataStore(port);
    await expect(store.load()).rejects.toThrow("reload failure");

    await expect(new OperationJournal(store).begin(await confirmedRenamePlan(), 9))
      .rejects.toThrow(/unavailable|read|poison/iu);
    expect(port.saveCalls).toBe(0);
  });

  it.each([
    ["unknown schema with active WAL", {
      schemaVersion: 999,
      settings: {},
      operational: { journals: [{ id: "legacy-active", status: "executing" }] },
    }],
    ["malformed current-schema journal container", {
      schemaVersion: 1,
      settings: {},
      operational: { journals: { unexpected: true } },
    }],
  ] as const)("blocks claims for %s without saving", async (_name, initial) => {
    const port = new MemoryPluginDataPort(initial);
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);

    expect(journal.organizationWritesBlocked()).toBe(true);
    await expect(journal.begin(await confirmedRenamePlan(), 91)).rejects.toThrow(/locked|recovery|unfinished/iu);
    expect(port.saveCalls).toHaveLength(0);
  });
});

describe("OperationJournal state machine", () => {
  it("derives a completed step from the persisted prepare and reaches completed legally", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const operation = plan.operations[0]!;
    const entry = await journal.begin(plan, 10);

    await journal.markExecuting(entry.id);
    await journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation));
    await journal.recordCompleted(entry.id, postconditionsFor(plan, operation));
    await journal.markCompleted(entry.id);

    await expect(journal.get(entry.id)).resolves.toMatchObject({
      status: "completed",
      prepared: null,
      completed: [{
        operation,
        inverse: inverseOf(operation),
        preconditions: preconditionsFor(plan, operation),
        postconditions: postconditionsFor(plan, operation),
      }],
    });
  });

  it("rejects illegal transitions, duplicate prepares, and terminal state with a prepared step", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const operation = plan.operations[0]!;
    const entry = await journal.begin(plan, 11);

    await expect(journal.markCompleted(entry.id)).rejects.toThrow(/transition|completed/iu);
    await journal.markExecuting(entry.id);
    await expect(journal.recordCompleted(entry.id, postconditionsFor(plan, operation))).rejects.toThrow(/prepared/iu);
    await journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation));
    await expect(journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation)))
      .rejects.toThrow(/prepared|duplicate/iu);
    await expect(journal.markCompleted(entry.id)).rejects.toThrow(/prepared|incomplete/iu);
    await journal.markRollingBack(entry.id, "stop");
    await expect(journal.markRolledBack(entry.id)).rejects.toThrow(/prepared/iu);
  });

  it("enforces exact plan order and membership and cannot complete a partial plan", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedTwoStepPlan();
    const [first, second] = plan.operations;
    const entry = await journal.begin(plan, 13);
    await journal.markExecuting(entry.id);

    await expect(journal.prepare(entry.id, second!, inverseOf(second!), preconditionsFor(plan, second!)))
      .rejects.toThrow(/order|unknown/iu);
    const unknown = { ...first!, id: "unknown-operation" } as PlannedOperation;
    await expect(journal.prepare(entry.id, unknown, inverseOf(unknown), preconditionsFor(plan, first!)))
      .rejects.toThrow(/order|unknown/iu);
    await journal.prepare(entry.id, first!, inverseOf(first!), preconditionsFor(plan, first!));
    await journal.recordCompleted(entry.id, postconditionsFor(plan, first!), postFieldStateFor(first!));
    await expect(journal.markCompleted(entry.id)).rejects.toThrow(/incomplete/iu);
  });

  it("rejects wrong postcondition paths, cardinality, and owned-field after-state", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedTwoStepPlan();
    const [structural, field] = plan.operations;
    const entry = await journal.begin(plan, 14);
    await journal.markExecuting(entry.id);
    await journal.prepare(entry.id, structural!, inverseOf(structural!), preconditionsFor(plan, structural!));

    await expect(journal.recordCompleted(entry.id, [{ path: "wrong.md", exists: false }]))
      .rejects.toThrow(/postcondition/iu);
    await journal.recordCompleted(entry.id, postconditionsFor(plan, structural!));
    await journal.prepare(entry.id, field!, inverseOf(field!), preconditionsFor(plan, field!));
    await expect(journal.recordCompleted(
      entry.id,
      [{ path: "wrong.md", exists: true, mtime: 100, contentHash: "wrong" }],
      { present: true, value: "note" },
    )).rejects.toThrow(/postcondition/iu);
  });

  it.each([
    ["prepared", "operation"],
    ["prepared", "inverse"],
    ["completed", "operation"],
    ["completed", "inverse"],
  ] as const)("rejects a durable %s step whose %s has an extra undefined structural key", async (stage, member) => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedTwoStepPlan();
    const [first, field] = plan.operations;
    const entry = await journal.begin(plan, stage === "prepared" ? 1401 : 1402);
    await journal.markExecuting(entry.id);
    await journal.prepare(entry.id, first!, inverseOf(first!), preconditionsFor(plan, first!));
    await journal.recordCompleted(entry.id, postconditionsFor(plan, first!), postFieldStateFor(first!));
    await journal.prepare(entry.id, field!, inverseOf(field!), preconditionsFor(plan, field!));
    if (stage === "completed") {
      await journal.recordCompleted(entry.id, postconditionsFor(plan, field!), postFieldStateFor(field!));
    }
    await store.updateJournal(entry.id, (value) => {
      const persisted = value as JournalEntry;
      if (stage === "prepared") {
        const prepared = persisted.prepared!;
        return {
          ...persisted,
          prepared: {
            ...prepared,
            [member]: { ...prepared[member], sourcePath: undefined },
          },
        };
      }
      return {
        ...persisted,
        completed: persisted.completed.map((step, index) => index === 1
          ? { ...step, [member]: { ...step[member], sourcePath: undefined } }
          : step),
      };
    });

    await expect(journal.get(entry.id)).rejects.toThrow(/malformed/iu);
    await expect(journal.list()).rejects.toThrow(/malformed/iu);
  });

  it.each(["operation", "inverse"] as const)(
    "rejects a runtime prepare whose %s has an extra undefined structural key without saving",
    async (member) => {
      const port = new MemoryPluginDataPort();
      const store = new PluginDataStore(port);
      await store.load();
      const journal = new OperationJournal(store);
      const plan = await confirmedTwoStepPlan();
      const [first, field] = plan.operations;
      const entry = await journal.begin(plan, member === "operation" ? 1403 : 1404);
      await journal.markExecuting(entry.id);
      await journal.prepare(entry.id, first!, inverseOf(first!), preconditionsFor(plan, first!));
      await journal.recordCompleted(entry.id, postconditionsFor(plan, first!), postFieldStateFor(first!));
      const operation = member === "operation"
        ? { ...field!, sourcePath: undefined } as unknown as PlannedOperation
        : field!;
      const inverse = member === "inverse"
        ? { ...inverseOf(field!), sourcePath: undefined } as unknown as PlannedOperation
        : inverseOf(field!);
      const savesBefore = port.saveCalls.length;

      await expect(journal.prepare(entry.id, operation, inverse, preconditionsFor(plan, field!)))
        .rejects.toThrow(/malformed|schema|operation|inverse/iu);

      expect(port.saveCalls).toHaveLength(savesBefore);
      await expect(journal.get(entry.id)).resolves.toMatchObject({ prepared: null, completed: [{ operation: first }] });
    },
  );

  it("rejects a structural completion whose target hash is not the persisted original source hash", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const operation = plan.operations[0]!;
    if (!("sourcePath" in operation)) throw new Error("Expected a structural operation");
    const entry = await journal.begin(plan, 141);
    await journal.markExecuting(entry.id);
    await journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation));

    await expect(journal.recordCompleted(entry.id, [
      { path: operation.sourcePath, exists: false },
      { path: operation.targetPath, exists: true, mtime: 100, contentHash: "altered-source-content" },
    ])).rejects.toThrow(/hash|postcondition|source/iu);
  });

  it("keeps prepared evidence when rolling-back transitions to recovery-required", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const operation = plan.operations[0]!;
    const entry = await journal.begin(plan, 15);
    await journal.markExecuting(entry.id);
    await journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation));
    await journal.markRollingBack(entry.id, "uncertain write");
    await journal.markRecoveryRequired(entry.id, "uncertain write", recoveryReport(operation.id));

    await expect(journal.get(entry.id)).resolves.toMatchObject({
      status: "recovery-required",
      prepared: { operation },
    });
  });

  it.each([
    ["non-string error", (entry: JournalEntry) => ({ ...entry, status: "rolling-back", error: 42 })],
    ["recovery on a non-recovery state", (entry: JournalEntry) => ({
      ...entry,
      recovery: recoveryReport(),
    })],
    ["recovery-required without a report", (entry: JournalEntry) => ({
      ...entry,
      status: "recovery-required",
      error: "uncertain",
    })],
    ["malformed recovery issue", (entry: JournalEntry) => ({
      ...entry,
      status: "recovery-required",
      error: "uncertain",
      recovery: {
        unresolved: [{
          operationId: "rename:a.md->x.md",
          originalPaths: ["a.md"],
          currentPaths: [42],
          comparison: "maybe",
          reason: false,
        }],
      },
    })],
    ["empty recovery issue list", (entry: JournalEntry) => ({
      ...entry,
      status: "recovery-required",
      error: "uncertain",
      recovery: { unresolved: [] },
    })],
    ["blank recovery issue identity", (entry: JournalEntry) => ({
      ...entry,
      status: "recovery-required",
      error: "uncertain",
      recovery: {
        unresolved: [{
          operationId: "",
          originalPaths: ["a.md"],
          currentPaths: ["x.md"],
          comparison: "differs",
          reason: "",
        }],
      },
    })],
  ] as const)("rejects persisted journal metadata with %s", async (_name, corrupt) => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const entry = await journal.begin(await confirmedRenamePlan(), 151);
    await store.mutateJournals(() => ({ journals: [corrupt(entry)], result: undefined }));

    await expect(journal.list()).rejects.toThrow(/malformed/iu);
  });

  it("rejects a malformed recovery report before saving the transition", async () => {
    const port = new MemoryPluginDataPort();
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const entry = await journal.begin(await confirmedRenamePlan(), 152);
    await journal.markRollingBack(entry.id, "uncertain");
    const savesBefore = port.saveCalls.length;
    const malformed = {
      unresolved: [{
        operationId: "rename:a.md->x.md",
        originalPaths: ["a.md"],
        currentPaths: ["x.md"],
        comparison: "unknown",
        reason: 42,
      }],
    } as unknown as RecoveryReport;

    await expect(journal.markRecoveryRequired(entry.id, "uncertain", malformed)).rejects.toThrow(/malformed|recovery/iu);
    expect(port.saveCalls).toHaveLength(savesBefore);
    await expect(journal.get(entry.id)).resolves.toMatchObject({ status: "rolling-back" });
  });

  it.each(["planned", "executing"] as const)(
    "rejects recovery-required directly from %s before saving",
    async (status) => {
      const port = new MemoryPluginDataPort();
      const store = new PluginDataStore(port);
      await store.load();
      const journal = new OperationJournal(store);
      const entry = await journal.begin(await confirmedRenamePlan(), status === "planned" ? 153 : 154);
      if (status === "executing") await journal.markExecuting(entry.id);
      const savesBefore = port.saveCalls.length;

      await expect(journal.markRecoveryRequired(entry.id, "uncertain", recoveryReport()))
        .rejects.toThrow(/rolling.?back|transition|illegal/iu);
      expect(port.saveCalls).toHaveLength(savesBefore);
      await expect(journal.get(entry.id)).resolves.toMatchObject({ status });
    },
  );

  it("forbids every later state transition from a durable terminal", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const completedId = await completeJournal(journal, plan, 16);
    const rolledBackId = await rollBackJournal(journal, plan, 17);

    await expect(journal.markExecuting(completedId)).rejects.toThrow(/illegal/iu);
    await expect(journal.markRollingBack(completedId)).rejects.toThrow(/illegal/iu);
    await expect(journal.markRecoveryRequired(completedId, "late", recoveryReport())).rejects.toThrow(/illegal/iu);
    await expect(journal.markExecuting(rolledBackId)).rejects.toThrow(/illegal/iu);
    await expect(journal.markRecoveryRequired(rolledBackId, "late", recoveryReport())).rejects.toThrow(/illegal/iu);
  });

  it("records rollback only for known completed operations in reverse order", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedTwoStepPlan();
    const entry = await journal.begin(plan, 12);
    await journal.markExecuting(entry.id);
    for (const operation of plan.operations) {
      await journal.prepare(entry.id, operation, inverseOf(operation), preconditionsFor(plan, operation));
      await journal.recordCompleted(entry.id, postconditionsFor(plan, operation), postFieldStateFor(operation));
    }
    await journal.markRollingBack(entry.id, "rollback requested");
    const [first, second] = plan.operations;
    await expect(journal.recordRolledBack(entry.id, first!.id)).rejects.toThrow(/reverse|order/iu);
    await expect(journal.recordRolledBack(entry.id, "unknown")).rejects.toThrow(/unknown/iu);
    await journal.recordRolledBack(entry.id, second!.id);
    await expect(journal.recordRolledBack(entry.id, second!.id)).rejects.toThrow(/duplicate|already/iu);
    await journal.recordRolledBack(entry.id, first!.id);
    await journal.markRolledBack(entry.id);

    await expect(journal.get(entry.id)).resolves.toMatchObject({
      status: "rolled-back",
      rolledBackOperationIds: [second!.id, first!.id],
    });
  });
});

describe("OperationJournal protected history", () => {
  it("caps the oldest validated terminal history by createdAt and ID through a real claim", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    for (let index = 99; index >= 0; index -= 1) await completeJournal(journal, plan, 1_000 + index);
    const claimed = await journal.begin(plan, 1_100);

    expect(store.operational().journals).toHaveLength(100);
    expect(store.operational().journals).not.toContainEqual(expect.objectContaining({ createdAt: 1_000 }));
    expect(store.operational().journals).toContainEqual(expect.objectContaining({ id: claimed.id, status: "planned" }));
  });

  it("preserves malformed terminal history and rejects a new claim without saving", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const malformed = { id: "protected-malformed", status: "completed" };
    await store.appendJournal(malformed);
    const saves = (store as unknown as { operational(): { journals: readonly unknown[] } }).operational().journals.length;

    await expect(journal.begin(plan, 1_099)).rejects.toThrow(/recovery|locked|malformed/iu);
    expect(store.operational().journals).toEqual([malformed]);
    expect(saves).toBe(1);
  });

  it("does not cap malformed terminal or recovery-required records", async () => {
    const malformedCompleted = Array.from({ length: 101 }, (_, index) => ({
      id: `malformed-${index}`,
      status: "completed",
    }));
    const recovery = { id: "recovery", status: "recovery-required" };
    const store = new PluginDataStore(new MemoryPluginDataPort({
      schemaVersion: 1,
      settings: {},
      operational: { journals: [...malformedCompleted, recovery] },
    }));

    await store.load();

    expect(store.operational().journals).toEqual([...malformedCompleted, recovery]);
  });

  it("clearHistory rejects atomically when any active or malformed shape is present", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    const completedId = await completeJournal(journal, plan, 20);
    const rolledBackId = await rollBackJournal(journal, plan, 21);
    const recovery = await journal.begin(plan, 22);
    await journal.markRollingBack(recovery.id, "needs audit");
    await journal.markRecoveryRequired(recovery.id, "needs audit", recoveryReport());
    await store.appendJournal({ id: "malformed-terminal", status: "completed" });
    await store.appendJournal({ id: "planned", status: "planned" });
    await store.appendJournal({ id: "executing", status: "executing" });
    await store.appendJournal({ id: "rolling", status: "rolling-back" });
    await store.appendJournal({ id: "unknown", status: "future-active" });

    const before = store.operational().journals;
    await expect(journal.clearHistory()).rejects.toThrow(/malformed|active/iu);
    expect(store.operational().journals).toEqual(before);
    expect(store.operational().journals).toContainEqual(expect.objectContaining({ id: completedId }));
    expect(store.operational().journals).toContainEqual(expect.objectContaining({ id: rolledBackId }));
    expect(store.operational().journals).toEqual([
      expect.objectContaining({ id: completedId, status: "completed" }),
      expect.objectContaining({ id: rolledBackId, status: "rolled-back" }),
      expect.objectContaining({ id: recovery.id, status: "recovery-required" }),
      { id: "malformed-terminal", status: "completed" },
      { id: "planned", status: "planned" },
      { id: "executing", status: "executing" },
      { id: "rolling", status: "rolling-back" },
      { id: "unknown", status: "future-active" },
    ]);
  });

  it("clearHistory removes only validated completed and rolled-back entries", async () => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    await completeJournal(journal, plan, 20);
    await rollBackJournal(journal, plan, 21);
    const recovery = await journal.begin(plan, 22);
    await journal.markRollingBack(recovery.id, "needs audit");
    await journal.markRecoveryRequired(recovery.id, "needs audit", recoveryReport());

    await journal.clearHistory();

    expect(store.operational().journals).toEqual([
      expect.objectContaining({ id: recovery.id, status: "recovery-required" }),
    ]);
  });
});

describe("PluginDataStore ambiguous persistence", () => {
  it("reconciles exact persist-then-throw history clearing but rejects save-before", async () => {
    const afterPort = new AmbiguousSavePort();
    const afterStore = new PluginDataStore(afterPort);
    await afterStore.load();
    const afterJournal = new OperationJournal(afterStore);
    const plan = await confirmedRenamePlan();
    await completeJournal(afterJournal, plan, 24);
    afterPort.failNextSave("after");

    await expect(afterJournal.clearHistory()).resolves.toBeUndefined();
    expect(await afterJournal.list()).toEqual([]);

    const beforePort = new AmbiguousSavePort();
    const beforeStore = new PluginDataStore(beforePort);
    await beforeStore.load();
    const beforeJournal = new OperationJournal(beforeStore);
    await completeJournal(beforeJournal, plan, 25);
    beforePort.failNextSave("before");

    await expect(beforeJournal.clearHistory()).rejects.toThrow("save-before-persist");
    expect(await beforeJournal.list()).toHaveLength(1);
  });

  it("reloads after a throw-before-persist and remains usable from the durable snapshot", async () => {
    const port = new AmbiguousSavePort();
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    port.failNextSave("before");

    await expect(journal.begin(plan, 30)).rejects.toThrow("save-before-persist");

    expect(port.loadCalls).toBe(2);
    expect(store.operational().journals).toEqual([]);
    await expect(journal.begin(plan, 31)).resolves.toMatchObject({ status: "planned" });
  });

  it("reconciles its exact persist-then-throw claim before a later mutation can overwrite it", async () => {
    const port = new AmbiguousSavePort();
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    port.failNextSave("after");

    await expect(journal.begin(plan, 40)).resolves.toMatchObject({ id: `40:${plan.id}`, status: "planned" });
    await expect(journal.begin(plan, 41)).rejects.toThrow(/write.?locked|unfinished|recovery/iu);
    await store.setPin("safe-later-mutation", 42);

    expect(port.snapshot()).toMatchObject({
      operational: {
        pins: { "safe-later-mutation": 42 },
        journals: [expect.objectContaining({ status: "planned" })],
      },
    });
  });

  it("poisons later mutations when ambiguous persistence cannot be reloaded", async () => {
    const port = new AmbiguousSavePort();
    const store = new PluginDataStore(port);
    await store.load();
    const journal = new OperationJournal(store);
    const plan = await confirmedRenamePlan();
    port.failNextSave("after");
    port.failLoads = true;

    await expect(journal.begin(plan, 50)).rejects.toThrow(/persist-then-throw|reload/iu);
    const saveCalls = port.saveCalls;
    await expect(store.setPin("must-not-save", 51)).rejects.toThrow(/poison|reload|unavailable/iu);
    expect(port.saveCalls).toBe(saveCalls);
  });
});

describe("TransactionService core execution", () => {
  it.each([
    ["malformed schema", { id: "forged" }],
    ["forged fingerprint", null],
  ] as const)("rejects a %s before journal begin or vault write", async (_name, candidate) => {
    const fixture = await transactionFixture();
    const plan = candidate ?? { ...fixture.confirmedPlan, fingerprint: "0".repeat(64) };

    const result = await fixture.service.execute(plan as ConfirmedPlan);

    expect(result.status).toBe("stale");
    expect(fixture.journal.calls).toEqual([]);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("rechecks the effective lock after awaited revalidation and before begin", async () => {
    const fixture = await transactionFixture();
    fixture.vault.onNextSnapshot(() => fixture.setWriteEnabled(false));

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result).toMatchObject({ status: "stale", conflicts: [expect.objectContaining({ code: "write-locked" })] });
    expect(fixture.journal.calls).toEqual([]);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("claims no journal when the user lock flips after the first full revalidation returns", async () => {
    const fixture = await transactionFixture();
    const revalidate = fixture.plans.revalidate.bind(fixture.plans);
    let calls = 0;
    fixture.plans.revalidate = async (plan) => {
      const result = await revalidate(plan);
      calls += 1;
      if (calls === 1) fixture.setWriteEnabled(false);
      return result;
    };

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result).toMatchObject({
      status: "stale",
      conflicts: [expect.objectContaining({ code: "write-locked" })],
    });
    expect(calls).toBe(2);
    expect(await fixture.journalEntries()).toEqual([]);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("returns stale with zero journal and vault writes when full revalidation detects drift", async () => {
    const fixture = await transactionFixture();
    fixture.vault.modifyExternally("a.md");

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("stale");
    expect(fixture.journal.calls).toEqual([]);
    expect(fixture.vault.calls).toEqual([]);
  });

  it.each(["empty", "oversized", "missing-dependency"] as const)(
    "rejects a fingerprint-valid %s plan before journal or vault mutation",
    async (kind) => {
      const fixture = await transactionFixture();
      let plan: ConfirmedPlan;
      if (kind === "empty") plan = (await fixture.plans.preview([])).plan as ConfirmedPlan;
      else if (kind === "oversized") {
        const operations = Array.from({ length: 51 }, (_, index): PlannedOperation => ({
          id: `set-${index}`,
          kind: "set-owned-field",
          path: "a.md",
          field: "knowledge-workbench-kind",
          before: { present: false },
          after: { present: true, value: `value-${index}` },
        }));
        plan = (await fixture.plans.preview(operations)).plan as ConfirmedPlan;
      } else {
        plan = await refingerprintPlan({
          ...fixture.confirmedPlan,
          preconditions: fixture.confirmedPlan.preconditions.slice(1),
        }) as ConfirmedPlan;
      }

      const result = await fixture.service.execute(plan);

      expect(result.status).toBe("stale");
      if (result.status !== "stale") throw new Error("Expected a stale plan result");
      expect(result.conflicts.map((conflict) => conflict.code))
        .toContain(kind === "oversized" ? "too-many-operations" : "precondition-drift");
      expect(await fixture.journalEntries()).toEqual([]);
      expect(fixture.vault.calls).toEqual([]);
    },
  );

  it.each(["false-precondition-extra", "false-field-extra", "field-with-rename-keys"] as const)(
    "rejects exact-schema violation %s before journal or vault mutation",
    async (kind) => {
      const operation = setKind("a.md", "note");
      const fixture = await transactionFixture(new ScriptedFailureVault(), [operation]);
      let candidate: ConfirmedPlan;
      if (kind === "false-precondition-extra") {
        const renameFixture = await transactionFixture();
        candidate = await refingerprintPlan({
          ...renameFixture.confirmedPlan,
          preconditions: renameFixture.confirmedPlan.preconditions.map((value) => value.exists
            ? value
            : { ...value, mtime: 1, contentHash: "forbidden" }),
        }) as ConfirmedPlan;
        const result = await renameFixture.service.execute(candidate);
        expect(result.status).toBe("stale");
        expect(await renameFixture.journalEntries()).toEqual([]);
        expect(renameFixture.vault.calls).toEqual([]);
        return;
      }
      candidate = await refingerprintPlan({
        ...fixture.confirmedPlan,
        operations: fixture.confirmedPlan.operations.map((value) => kind === "false-field-extra"
          ? { ...value, before: { present: false, extra: true } }
          : { ...value, sourcePath: "a.md", targetPath: "x.md" }),
        ...(kind === "field-with-rename-keys"
          ? { preconditions: [...fixture.confirmedPlan.preconditions, { path: "x.md", exists: false } as const] }
          : {}),
      }) as ConfirmedPlan;

      const result = await fixture.service.execute(candidate);

      expect(result.status).toBe("stale");
      expect(await fixture.journalEntries()).toEqual([]);
      expect(fixture.vault.calls).toEqual([]);
    },
  );

  it("rejects a simultaneous second execute inside the service with zero additional writes", async () => {
    const fixture = await transactionFixture();
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    fixture.journal.onAfterPrepare(async () => {
      entered();
      await resume;
    });
    const first = fixture.service.execute(fixture.confirmedPlan);
    await paused;
    const journalCalls = fixture.journal.calls.length;
    const vaultCalls = fixture.vault.calls.length;

    const second = await fixture.service.execute(fixture.confirmedPlan);

    expect(second).toMatchObject({
      status: "stale",
      conflicts: [expect.objectContaining({ code: "write-locked" })],
    });
    expect(fixture.journal.calls).toHaveLength(journalCalls);
    expect(fixture.vault.calls).toHaveLength(vaultCalls);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("does not adopt another service's same-clock same-plan global claim", async () => {
    const fixture = await transactionFixture();
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    fixture.journal.onAfterBegin(async () => {
      entered();
      await resume;
    });
    const first = fixture.service.execute(fixture.confirmedPlan);
    await paused;
    const secondJournal = new OperationJournal(fixture.store);
    const secondService = new TransactionService(
      fixture.plans,
      fixture.vault,
      fixture.vault,
      secondJournal,
      { now: () => 100 },
      RecoveryReadinessGate.readyForTests(),
    );
    const before = fixture.vault.calls.length;

    const second = await secondService.execute(fixture.confirmedPlan);

    expect(second).toMatchObject({
      status: "stale",
      conflicts: [expect.objectContaining({ code: "write-locked" })],
    });
    expect(fixture.vault.calls).toHaveLength(before);
    expect(await secondJournal.list()).toHaveLength(1);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("executes an immutable entry snapshot when the caller mutates its plan after durable prepare", async () => {
    const fixture = await transactionFixture(new ScriptedFailureVault(), [setKind("a.md", "note")]);
    const mutable = structuredClone(fixture.confirmedPlan);
    fixture.journal.onAfterPrepare(1, () => {
      const operation = mutable.operations[0];
      if (operation?.kind !== "set-owned-field") throw new Error("Expected a field operation");
      (operation as { after: FieldState }).after = { present: true, value: "mutated-after-prepare" };
    });

    const result = await fixture.service.execute(mutable);

    expect(result.status).toBe("completed");
    expect(fixture.vault.setOwnedFieldCalls).toMatchObject([{
      path: "a.md",
      next: { present: true, value: "note" },
    }]);
    await expect(fixture.vault.readOwnedField("a.md", "knowledge-workbench-kind"))
      .resolves.toEqual({ present: true, value: "note" });
  });

  it("maps an uncloneable caller plan to stale before journal or vault mutation", async () => {
    const fixture = await transactionFixture();
    const uncloneable = { ...fixture.confirmedPlan, callerValue: () => undefined } as unknown as ConfirmedPlan;

    const result = await fixture.service.execute(uncloneable);

    expect(result).toMatchObject({
      status: "stale",
      conflicts: [expect.objectContaining({ code: "precondition-drift" })],
    });
    expect(await fixture.journalEntries()).toEqual([]);
    expect(fixture.vault.calls).toEqual([]);
  });

  it("executes one safe rename through prepare, write, verify, record, and terminal WAL", async () => {
    const fixture = await transactionFixture();

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("completed");
    expect(fixture.vault.calls).toEqual(["rename:a.md->x.md"]);
    expect(fixture.journal.calls).toEqual([
      "begin",
      "executing",
      "prepare:rename:a.md->x.md",
      "record-completed",
      "completed",
    ]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      status: "completed",
      prepared: null,
      completed: [{
        operation: { id: "rename:a.md->x.md" },
        postconditions: [
          { path: "a.md", exists: false },
          { path: "x.md", exists: true },
        ],
      }],
    }]);
  });
});

describe("TransactionService rollback and recovery", () => {
  it("journals before writing and rolls completed steps back in reverse order", async () => {
    const fixture = await transactionFixture(
      new ScriptedFailureVault({ failOnWriteNumbers: [2] }),
      [rename(), setKind()],
    );

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("rolled-back");
    expect(fixture.vault.calls).toEqual([
      "rename:a.md->x.md",
      "set:b.md",
      "rename:x.md->a.md",
    ]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      status: "rolled-back",
      prepared: null,
      rolledBackOperationIds: ["rename:a.md->x.md"],
    }]);
  });

  it("rolls back recorded work when the write lock flips after an operation", async () => {
    const fixture = await transactionFixture(new ScriptedFailureVault(), [rename(), setKind()]);
    fixture.vault.onAfterWrite(1, () => fixture.setWriteEnabled(false));

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("rolled-back");
    expect(fixture.vault.calls).toEqual(["rename:a.md->x.md", "rename:x.md->a.md"]);
  });

  it("rolls a field back by semantic CAS while preserving an unrelated body edit", async () => {
    const vault = new ScriptedFailureVault({ failOnWriteNumbers: [2] });
    const fixture = await transactionFixture(vault, [
      setKind("a.md", "note"),
      setKind("b.md", "reference"),
    ]);
    vault.onWriteAttempt(2, () => vault.modifyExternally("a.md", "user body edit\n"));

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("rolled-back");
    expect(vault.calls).toEqual(["set:a.md", "set:b.md", "set:a.md"]);
    await expect(vault.readOwnedField("a.md", "knowledge-workbench-kind")).resolves.toEqual({ present: false });
    await expect(vault.readNote("a.md")).resolves.toMatchObject({ content: "user body edit\n" });
  });

  it("clears an unapplied prepare and rolls back when a related target drifts after prepare", async () => {
    const fixture = await transactionFixture(new ScriptedFailureVault(), [addRelated()]);
    fixture.journal.onAfterPrepare(1, () => fixture.vault.deleteExternally("target.md"));

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("rolled-back");
    expect(fixture.vault.calls).toEqual([]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{ status: "rolled-back", prepared: null }]);
  });

  it("requires recovery when a forward write applied but recordCompleted did not persist", async () => {
    const fixture = await transactionFixture(
      new ScriptedFailureVault(),
      [rename()],
      undefined,
      { failRecordCompletedNumbers: [1] },
    );

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      status: "recovery-required",
      prepared: { operation: { id: "rename:a.md->x.md" } },
      recovery: { unresolved: [expect.objectContaining({ operationId: "rename:a.md->x.md" })] },
    }]);
  });

  it("reports the ambiguous prepared write and every earlier applied completed step", async () => {
    const operations = [setKind("a.md", "note"), setKind("b.md", "reference")];
    const fixture = await transactionFixture(
      new ScriptedFailureVault(),
      operations,
      undefined,
      { failRecordCompletedNumbers: [2] },
    );

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    const [entry] = await fixture.journalEntries();
    expect(entry?.recovery?.unresolved.map((issue) => issue.operationId).sort()).toEqual(
      operations.map((operation) => operation.id).sort(),
    );
  });

  it("does not run an inverse when applied-state verification differs", async () => {
    const fixture = await transactionFixture(
      new ScriptedFailureVault({ corruptAfterWriteNumbers: [1] }),
      [rename()],
    );

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    expect(fixture.vault.calls).toEqual(["rename:a.md->x.md"]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      status: "recovery-required",
      recovery: { unresolved: [expect.objectContaining({ comparison: "differs" })] },
    }]);
  });

  it("reports at-precondition when an inverse succeeded but rollback journaling failed", async () => {
    const fixture = await transactionFixture(
      new ScriptedFailureVault({ failOnWriteNumbers: [2] }),
      [rename(), setKind()],
      undefined,
      { failRecordRolledBackNumbers: [1] },
    );

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    expect(fixture.vault.calls).toEqual(["rename:a.md->x.md", "set:b.md", "rename:x.md->a.md"]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      status: "recovery-required",
      recovery: { unresolved: [expect.objectContaining({ comparison: "at-precondition" })] },
    }]);
  });

  it.each([
    ["source content", rename(), (vault: ScriptedFailureVault) => vault.modifyExternally("a.md")],
    ["target appearance", rename(), (vault: ScriptedFailureVault) => vault.applyEvent("create", "x.md")],
    ["case collision", rename(), (vault: ScriptedFailureVault) => vault.applyEvent("create", "X.md")],
    ["metadata readiness", rename(), (vault: ScriptedFailureVault) => vault.setMetadataReady(false)],
    ["owned field", setKind(), (vault: ScriptedFailureVault) => vault.setOwnedFieldExternally(
      "b.md",
      "knowledge-workbench-kind",
      { present: true, value: "note" },
    )],
  ] as const)("revalidates %s drift after durable prepare and performs zero forward writes", async (_name, operation, drift) => {
    const fixture = await transactionFixture(new ScriptedFailureVault(), [operation]);
    fixture.journal.onAfterPrepare(1, () => { drift(fixture.vault); });

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("rolled-back");
    expect(fixture.vault.calls).toEqual([]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{ status: "rolled-back", prepared: null }]);
  });

  it("does not guess an inverse when rename metadata becomes pending", async () => {
    const vault = new ScriptedFailureVault({ failOnWriteNumbers: [2] });
    const fixture = await transactionFixture(vault, [rename(), setKind()]);
    vault.onAfterWrite(1, () => vault.setMetadataReady(false));

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    expect(vault.calls).toEqual(["rename:a.md->x.md", "set:b.md"]);
  });

  it("does not complete an add-related write when its target disappears before recordCompleted", async () => {
    const vault = new ScriptedFailureVault();
    const fixture = await transactionFixture(vault, [addRelated()]);
    vault.onAfterWrite(1, () => vault.deleteExternally("target.md"));

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    expect(vault.calls).toEqual(["set:a.md"]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      status: "recovery-required",
      prepared: { operation: { id: "related:a.md->target.md" } },
    }]);
  });

  it("rejects without inverse or later writes when save reconciliation poisons the store", async () => {
    const port = new FaultingPluginDataPort({
      boundary: "record-completed",
      mode: "before",
      failReload: true,
    });
    const fixture = await transactionFixture(new ScriptedFailureVault(), [rename()], port);

    await expect(fixture.service.execute(fixture.confirmedPlan)).rejects.toThrow(/reload|poison|failed/iu);
    expect(fixture.vault.calls).toEqual(["rename:a.md->x.md"]);
    const writes = fixture.vault.calls.length;
    await expect(fixture.store.setPin("blocked", 1)).rejects.toThrow(/poison|reload/iu);
    expect(fixture.vault.calls).toHaveLength(writes);
  });

  it.each(["hash", "mtime"] as const)(
    "does not reconcile a persist-then-throw completed step with altered durable %s",
    async (alteration) => {
      const fixture = await transactionFixture(
        new ScriptedFailureVault(),
        [setKind()],
        undefined,
        { alterPersistedRecordCompleted: { 1: alteration } },
      );

      const result = await fixture.service.execute(fixture.confirmedPlan);

      expect(result.status).toBe("recovery-required");
      await expect(fixture.journalEntries()).resolves.toMatchObject([{
        status: "recovery-required",
        recovery: { unresolved: [expect.objectContaining({ operationId: "set:b.md:reference" })] },
      }]);
      expect(fixture.service.organizationWritesBlocked()).toBe(true);
    },
  );

  it.each(["comparison", "reason"] as const)(
    "rejects persist-then-throw recovery reconciliation with altered durable %s",
    async (alteration) => {
      const fixture = await transactionFixture(
        new ScriptedFailureVault({ corruptAfterWriteNumbers: [1] }),
        [rename()],
        undefined,
        { alterPersistedRecovery: alteration },
      );

      await expect(fixture.service.execute(fixture.confirmedPlan)).rejects.toThrow(/recovery-persisted-altered/iu);
      expect(fixture.service.organizationWritesBlocked()).toBe(true);
      await expect(fixture.journalEntries()).resolves.toMatchObject([{ status: "recovery-required" }]);
    },
  );

  it("persists an unreadable recovery comparison without running an inverse", async () => {
    const vault = new ScriptedFailureVault({
      failOnWriteNumbers: [2],
      unreadablePathsAfterWrite: { 2: ["x.md"] },
    });
    const fixture = await transactionFixture(vault, [rename(), setKind()]);

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    expect(vault.calls).toEqual(["rename:a.md->x.md", "set:b.md"]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      recovery: { unresolved: [expect.objectContaining({ comparison: "unreadable" })] },
    }]);
  });

  it.each([
    ["inverse throws", { failOnWriteNumbers: [2, 3] }],
    ["inverse restoration verification differs", { failOnWriteNumbers: [2], corruptAfterWriteNumbers: [3] }],
  ] as const)("requires recovery when %s", async (_name, options) => {
    const vault = new ScriptedFailureVault(options);
    const fixture = await transactionFixture(vault, [rename(), setKind()]);

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    expect(vault.calls).toEqual(["rename:a.md->x.md", "set:b.md", "rename:x.md->a.md"]);
    await expect(fixture.journalEntries()).resolves.toMatchObject([{
      status: "recovery-required",
      recovery: { unresolved: [expect.objectContaining({ comparison: "differs" })] },
    }]);
  });

  it.each([
    ["the first inverse fails", { failOnWriteNumbers: [3, 4] }, {}],
    ["the first rollback record fails", { failOnWriteNumbers: [3] }, { failRecordRolledBackNumbers: [1] }],
  ] as const)("reports every still-pending applied step when %s", async (_name, vaultOptions, journalFaults) => {
    const operations = [
      setKind("a.md", "note"),
      setKind("b.md", "reference"),
      setKind("target.md", "note"),
    ];
    const fixture = await transactionFixture(
      new ScriptedFailureVault(vaultOptions),
      operations,
      undefined,
      journalFaults,
    );

    const result = await fixture.service.execute(fixture.confirmedPlan);

    expect(result.status).toBe("recovery-required");
    const [entry] = await fixture.journalEntries();
    expect(entry?.recovery?.unresolved.map((issue) => issue.operationId).sort()).toEqual(
      operations.slice(0, 2).map((operation) => operation.id).sort(),
    );
  });
});

describe("TransactionService WAL persistence matrix", () => {
  const expectedStatus: Readonly<Record<JournalBoundary, Readonly<Record<SaveFailureMode, string>>>> = {
    begin: { before: "stale", after: "completed" },
    executing: { before: "rolled-back", after: "completed" },
    prepare: { before: "rolled-back", after: "completed" },
    "clear-prepared": { before: "rolled-back", after: "rolled-back" },
    "record-completed": { before: "recovery-required", after: "completed" },
    "rolling-back": { before: "rolled-back", after: "rolled-back" },
    "record-rolled-back": { before: "recovery-required", after: "rolled-back" },
    "terminal-completed": { before: "rolled-back", after: "completed" },
    "terminal-rolled-back": { before: "rolled-back", after: "rolled-back" },
    "terminal-recovery-required": { before: "recovery-required", after: "recovery-required" },
  };

  const cases = (Object.keys(expectedStatus) as JournalBoundary[]).flatMap((boundary) =>
    (["before", "after"] as const).map((mode) => ({ boundary, mode })));

  it.each(cases)("reconciles $boundary save-$mode from durable state", async ({ boundary, mode }) => {
    const port = new FaultingPluginDataPort({ boundary, mode });
    let vault = new ScriptedFailureVault();
    let operations: readonly PlannedOperation[] = [rename()];
    if (boundary === "clear-prepared") operations = [addRelated()];
    if (boundary === "rolling-back") vault = new ScriptedFailureVault({ failOnWriteNumbers: [1] });
    if (boundary === "record-rolled-back" || boundary === "terminal-rolled-back") {
      vault = new ScriptedFailureVault({ failOnWriteNumbers: [2] });
      operations = [rename(), setKind()];
    }
    if (boundary === "terminal-recovery-required") {
      vault = new ScriptedFailureVault({ corruptAfterWriteNumbers: [1] });
    }
    const fixture = await transactionFixture(vault, operations, port);
    if (boundary === "clear-prepared") {
      fixture.journal.onAfterPrepare(1, () => fixture.vault.deleteExternally("target.md"));
    }

    const result = await fixture.service.execute(fixture.confirmedPlan);
    const durable = await durableJournalEntries(port);
    const expected = expectedStatus[boundary][mode];

    expect(result.status).toBe(expected);
    if (expected === "stale") expect(durable).toEqual([]);
    else expect(durable).toMatchObject([{ status: expected }]);
    expect(port.boundaries).toContain(boundary);
  });
});
