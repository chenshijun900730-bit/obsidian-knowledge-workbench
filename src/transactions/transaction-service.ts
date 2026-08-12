import type { Clock, VaultReadPort, VaultWritePort } from "../core/ports";
import { sameFieldState, type FieldState, type FilePrecondition, type PlannedOperation } from "../core/types";
import {
  samePrecondition,
  type ChangePlanService,
  type ConfirmedPlan,
  type PlanConflict,
} from "../plans/change-plan-service";
import {
  JournalAuthorizationError,
  type CompletedStep,
  type OperationJournal,
  type PreparedStep,
  type RecoveryIssue,
  type RecoveryReport,
} from "./operation-journal";
import type { RecoveryReadinessGate } from "./recovery-readiness-gate";

export type ExecutionResult =
  | Readonly<{ status: "stale"; conflicts: readonly PlanConflict[] }>
  | Readonly<{ status: "completed" | "rolled-back" | "recovery-required"; journalId: string }>;

const writeLocked = (): ExecutionResult => ({
  status: "stale",
  conflicts: [{ operationId: "plan", code: "write-locked", paths: [] }],
});

const invalidPlan = (): ExecutionResult => ({
  status: "stale",
  conflicts: [{ operationId: "plan", code: "precondition-drift", paths: [] }],
});

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const inverseOf = (operation: PlannedOperation): PlannedOperation => {
  if (operation.kind === "move" || operation.kind === "rename") {
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

const operationPaths = (operation: PlannedOperation): readonly string[] => {
  if (operation.kind === "move" || operation.kind === "rename") return [operation.sourcePath, operation.targetPath];
  if (operation.kind === "add-related-link") return [operation.path, operation.targetPath];
  return [operation.path];
};

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameRecoveryReport = (left: RecoveryReport, right: RecoveryReport): boolean =>
  left.unresolved.length === right.unresolved.length
  && left.unresolved.every((issue, index) => {
    const expected = right.unresolved[index];
    return expected !== undefined
      && issue.operationId === expected.operationId
      && sameStrings(issue.originalPaths, expected.originalPaths)
      && sameStrings(issue.currentPaths, expected.currentPaths)
      && issue.comparison === expected.comparison
      && issue.reason === expected.reason;
  });

class CompletedReconciliationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Completed journal reconciliation failed");
    this.name = "CompletedReconciliationError";
  }
}

export class TransactionService {
  private active = false;

  constructor(
    private readonly plans: ChangePlanService,
    private readonly reads: VaultReadPort,
    private readonly writes: VaultWritePort,
    private readonly journal: OperationJournal,
    private readonly clock: Clock,
    private readonly readiness: RecoveryReadinessGate,
  ) {}

  organizationWritesBlocked(): boolean {
    return this.readiness.organizationWritesBlocked() || this.journal.organizationWritesBlocked();
  }

  async execute(plan: ConfirmedPlan): Promise<ExecutionResult> {
    if (this.active || this.readiness.organizationWritesBlocked()) return writeLocked();
    let snapshot: ConfirmedPlan;
    try {
      snapshot = deepFreeze(structuredClone(plan));
    } catch {
      return invalidPlan();
    }
    this.active = true;
    try {
      return await this.executeExclusive(snapshot);
    } finally {
      this.active = false;
    }
  }

  private async executeExclusive(plan: ConfirmedPlan): Promise<ExecutionResult> {
    const validation = await this.plans.revalidate(plan);
    if (!validation.ok) return { status: "stale", conflicts: validation.conflicts };
    let journalId: string | null = null;
    let writeStarted = false;
    let writeReturned = false;
    try {
      const entry = await this.journal.begin(plan, this.clock.now(), async () => {
        if (this.readiness.organizationWritesBlocked()) {
          return { ok: false as const, conflicts: [{ operationId: "plan", code: "write-locked" as const, paths: [] }] };
        }
        const validation = await this.plans.revalidate(plan);
        if (this.readiness.organizationWritesBlocked()) {
          return { ok: false as const, conflicts: [{ operationId: "plan", code: "write-locked" as const, paths: [] }] };
        }
        return validation;
      });
      journalId = entry.id;
      await this.markExecutingReconciled(entry.id);
      const expected = new Map(plan.preconditions.map((value) => [value.path, value]));
      for (const operation of plan.operations) {
        const preconditions = operationPaths(operation).map((path) => {
          const value = expected.get(path);
          if (value === undefined) throw new Error(`Missing plan precondition: ${path}`);
          return value;
        });
        await this.assertOperationReady(operation, preconditions);
        await this.prepareReconciled(entry.id, operation, inverseOf(operation), preconditions);
        await this.assertOperationReady(operation, preconditions);
        writeStarted = true;
        await this.executeOperation(operation, preconditions);
        writeReturned = true;
        if (operation.kind === "move" || operation.kind === "rename") {
          const source = await this.reads.snapshot(operation.sourcePath);
          const target = await this.reads.snapshot(operation.targetPath);
          if (source.exists || !target.exists) throw new Error(`Rename postcondition failed: ${operation.id}`);
          const original = preconditions.find((value) => value.path === operation.sourcePath);
          if (original?.exists !== true || original.contentHash !== target.contentHash) {
            throw new Error(`Rename content changed: ${operation.id}`);
          }
          const postconditions: readonly FilePrecondition[] = [source, target];
          await this.recordCompletedReconciled(entry.id, operation, postconditions);
          expected.set(operation.sourcePath, source);
          expected.set(operation.targetPath, target);
        } else {
          const path = operation.path;
          const field = operation.kind === "add-related-link" ? "knowledge-workbench-related" : operation.field;
          const currentField = await this.reads.readOwnedField(path, field);
          const postcondition = await this.reads.snapshot(path);
          if (currentField === null || !sameFieldState(currentField, operation.after) || !postcondition.exists) {
            throw new Error(`Owned-field postcondition failed: ${operation.id}`);
          }
          if (operation.kind === "add-related-link" && !(await this.reads.snapshot(operation.targetPath)).exists) {
            throw new Error(`Related target disappeared after write: ${operation.targetPath}`);
          }
          await this.recordCompletedReconciled(entry.id, operation, [postcondition], operation.after);
          expected.set(path, postcondition);
        }
        writeStarted = false;
        writeReturned = false;
      }
      await this.markCompletedReconciled(entry.id);
      return { status: "completed", journalId: entry.id };
    } catch (error) {
      if (journalId === null) {
        return error instanceof JournalAuthorizationError
          ? { status: "stale", conflicts: error.conflicts }
          : writeLocked();
      }
      const message = error instanceof Error ? error.message : "Unknown transaction error";
      if (error instanceof CompletedReconciliationError) {
        let entry = await this.journal.get(journalId);
        if (entry === null) return writeLocked();
        if (entry.status === "planned" || entry.status === "executing") {
          entry = await this.markRollingBackReconciled(journalId, message);
        }
        const pending = entry.completed.slice(0, entry.completed.length - entry.rolledBackOperationIds.length).reverse();
        return await this.requireRecovery(journalId, message, await this.completedRecovery(pending, message));
      }
      return await this.rollback(journalId, message, { writeStarted, writeReturned });
    }
  }

  private async executeOperation(
    operation: PlannedOperation,
    preconditions: readonly FilePrecondition[],
  ): Promise<void> {
    if (operation.kind === "move" || operation.kind === "rename") {
      const source = preconditions.find((value) => value.path === operation.sourcePath);
      const target = preconditions.find((value) => value.path === operation.targetPath);
      if (source === undefined || target === undefined) throw new Error(`Missing rename preconditions: ${operation.id}`);
      await this.writes.renameFile(operation.sourcePath, operation.targetPath, source, target);
      return;
    }
    const field = operation.kind === "add-related-link" ? "knowledge-workbench-related" : operation.field;
    await this.writes.setOwnedField(operation.path, field, operation.before, operation.after);
  }

  private async rollback(
    journalId: string,
    error: string,
    attempted: Readonly<{ writeStarted: boolean; writeReturned: boolean }>,
  ): Promise<ExecutionResult> {
    let entry = await this.journal.get(journalId);
    if (entry === null) return writeLocked();
    if (entry.status === "completed") return { status: "completed", journalId };
    if (entry.status === "rolled-back") return { status: "rolled-back", journalId };
    if (entry.status === "recovery-required") return { status: "recovery-required", journalId };
    if (entry.status === "planned" || entry.status === "executing") entry = await this.markRollingBackReconciled(journalId, error);
    let pending = entry.completed.slice(0, entry.completed.length - entry.rolledBackOperationIds.length).reverse();
    if (entry.prepared !== null) {
      const definitelyUnapplied = !attempted.writeStarted
        || (!attempted.writeReturned && await this.preparedAtPrecondition(entry.prepared));
      if (!definitelyUnapplied) {
        return await this.requireRecovery(
          journalId,
          error,
          await this.preparedAndCompletedRecovery(entry.prepared, pending, error),
        );
      }
      await this.clearPreparedReconciled(journalId);
      entry = (await this.journal.get(journalId))!;
      pending = entry.completed.slice(0, entry.completed.length - entry.rolledBackOperationIds.length).reverse();
    }
    for (let index = 0; index < pending.length; index += 1) {
      const step = pending[index]!;
      const unresolved = pending.slice(index);
      try {
        if (!await this.atCompletedPostState(step)) {
          return await this.requireRecovery(journalId, error, await this.completedRecovery(unresolved, error));
        }
        if (!await this.inverseBoundaryReady(step)) {
          return await this.requireRecovery(journalId, error, await this.completedRecovery(unresolved, error));
        }
        await this.executeOperation(step.inverse, step.postconditions);
        if (!await this.verifyRestored(step)) {
          return await this.requireRecovery(journalId, error, await this.completedRecovery(unresolved, error));
        }
        try {
          await this.recordRolledBackReconciled(journalId, step.operation.id);
        } catch (recordError) {
          const reason = recordError instanceof Error ? recordError.message : error;
          return await this.requireRecovery(journalId, reason, await this.completedRecovery(unresolved, reason));
        }
      } catch (rollbackError) {
        const reason = rollbackError instanceof Error ? rollbackError.message : error;
        return await this.requireRecovery(journalId, reason, await this.completedRecovery(unresolved, reason));
      }
    }
    await this.markRolledBackReconciled(journalId, error);
    return { status: "rolled-back", journalId };
  }

  private async atCompletedPostState(step: CompletedStep): Promise<boolean> {
    try {
      const operation = step.operation;
      if (operation.kind === "move" || operation.kind === "rename") {
        for (const expected of step.postconditions) {
          if (!samePrecondition(await this.reads.snapshot(expected.path), expected)) return false;
        }
        return true;
      }
      if (!(await this.reads.snapshot(operation.path)).exists || step.postFieldState === undefined) return false;
      const field = operation.kind === "add-related-link" ? "knowledge-workbench-related" : operation.field;
      const current = await this.reads.readOwnedField(operation.path, field);
      return current !== null && sameFieldState(current, step.postFieldState);
    } catch {
      return false;
    }
  }

  private async preparedAtPrecondition(prepared: PreparedStep): Promise<boolean> {
    try {
      for (const expected of prepared.preconditions) {
        if (!samePrecondition(await this.reads.snapshot(expected.path), expected)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async inverseBoundaryReady(step: CompletedStep): Promise<boolean> {
    if (step.inverse.kind !== "move" && step.inverse.kind !== "rename") return true;
    try {
      const inbound = await this.reads.inboundLinks(step.inverse.sourcePath);
      return inbound !== null && inbound.length === 0;
    } catch {
      return false;
    }
  }

  private async verifyRestored(step: CompletedStep): Promise<boolean> {
    if (step.operation.kind === "move" || step.operation.kind === "rename") {
      const operation = step.operation;
      const sourceBefore = step.preconditions.find((value) => value.path === operation.sourcePath);
      const targetBefore = step.preconditions.find((value) => value.path === operation.targetPath);
      if (sourceBefore?.exists !== true || targetBefore?.exists !== false) return false;
      const source = await this.reads.snapshot(operation.sourcePath);
      const target = await this.reads.snapshot(operation.targetPath);
      return source.exists && source.contentHash === sourceBefore.contentHash && !target.exists;
    }
    const field = step.operation.kind === "add-related-link"
      ? "knowledge-workbench-related"
      : step.operation.field;
    const current = await this.reads.readOwnedField(step.operation.path, field);
    return current !== null && sameFieldState(current, step.operation.before);
  }

  private async requireRecovery(
    journalId: string,
    error: string,
    recovery: RecoveryReport,
  ): Promise<ExecutionResult> {
    const current = await this.journal.get(journalId);
    if (current?.status !== "recovery-required") {
      await this.markRecoveryRequiredReconciled(journalId, error, recovery);
    }
    return { status: "recovery-required", journalId };
  }

  private async preparedRecovery(prepared: PreparedStep, error: string): Promise<RecoveryReport> {
    return { unresolved: [await this.recoveryIssue(prepared.operation, prepared.preconditions, error)] };
  }

  private async preparedAndCompletedRecovery(
    prepared: PreparedStep,
    pending: readonly CompletedStep[],
    error: string,
  ): Promise<RecoveryReport> {
    const reports = [await this.preparedRecovery(prepared, error), await this.completedRecovery(pending, error)];
    const unresolved = new Map<string, RecoveryIssue>();
    for (const report of reports) for (const issue of report.unresolved) {
      if (!unresolved.has(issue.operationId)) unresolved.set(issue.operationId, issue);
    }
    return { unresolved: [...unresolved.values()] };
  }

  private async completedRecovery(steps: readonly CompletedStep[], error: string): Promise<RecoveryReport> {
    const unresolved: RecoveryIssue[] = [];
    for (const step of steps) unresolved.push(await this.recoveryIssue(step.operation, step.preconditions, error, step));
    return { unresolved };
  }

  private async recoveryIssue(
    operation: PlannedOperation,
    preconditions: readonly FilePrecondition[],
    reason: string,
    completed?: CompletedStep,
  ): Promise<RecoveryIssue> {
    const candidates = [...new Set([...operationPaths(operation), ...operationPaths(inverseOf(operation))])];
    const currentPaths: string[] = [];
    let unreadable = false;
    for (const path of candidates) {
      try {
        if ((await this.reads.snapshot(path)).exists) currentPaths.push(path);
      } catch {
        unreadable = true;
      }
    }
    let atPrecondition = false;
    if (!unreadable) {
      try {
        atPrecondition = completed === undefined
          ? await this.preconditionsMatch(preconditions)
          : await this.verifyRestored(completed);
      } catch {
        unreadable = true;
      }
    }
    return {
      operationId: operation.id,
      originalPaths: operationPaths(operation),
      currentPaths: currentPaths.sort(),
      comparison: unreadable ? "unreadable" : atPrecondition ? "at-precondition" : "differs",
      reason,
    };
  }

  private async preconditionsMatch(preconditions: readonly FilePrecondition[]): Promise<boolean> {
    for (const expected of preconditions) {
      if (!samePrecondition(await this.reads.snapshot(expected.path), expected)) return false;
    }
    return true;
  }

  private async markExecutingReconciled(id: string): Promise<void> {
    try {
      await this.journal.markExecuting(id);
    } catch (error) {
      if ((await this.journal.get(id))?.status === "executing") return;
      throw error;
    }
  }

  private async prepareReconciled(
    id: string,
    operation: PlannedOperation,
    inverse: PlannedOperation,
    preconditions: readonly FilePrecondition[],
  ): Promise<void> {
    try {
      await this.journal.prepare(id, operation, inverse, preconditions);
    } catch (error) {
      if ((await this.journal.get(id))?.prepared?.operation.id === operation.id) return;
      throw error;
    }
  }

  private async recordCompletedReconciled(
    id: string,
    operation: PlannedOperation,
    postconditions: readonly FilePrecondition[],
    postFieldState?: FieldState,
  ): Promise<void> {
    try {
      await this.journal.recordCompleted(id, postconditions, postFieldState);
    } catch (error) {
      const current = await this.journal.get(id);
      const completed = current?.completed.at(-1);
      const samePostconditions = completed !== undefined
        && completed.postconditions.length === postconditions.length
        && completed.postconditions.every((value, index) => samePrecondition(value, postconditions[index]!));
      const samePostFieldState = completed !== undefined
        && ((completed.postFieldState === undefined && postFieldState === undefined)
          || (completed.postFieldState !== undefined
            && postFieldState !== undefined
            && sameFieldState(completed.postFieldState, postFieldState)));
      if (current?.prepared === null
        && completed !== undefined
        && JSON.stringify(completed.operation) === JSON.stringify(operation)
        && samePostconditions
        && samePostFieldState) return;
      if (current?.prepared === null && completed !== undefined) throw new CompletedReconciliationError(error);
      throw error;
    }
  }

  private async markCompletedReconciled(id: string): Promise<void> {
    try {
      await this.journal.markCompleted(id);
    } catch (error) {
      if ((await this.journal.get(id))?.status === "completed") return;
      throw error;
    }
  }

  private async markRollingBackReconciled(id: string, error: string) {
    try {
      await this.journal.markRollingBack(id, error);
    } catch (saveError) {
      const current = await this.journal.get(id);
      if (current?.status === "rolling-back") return current;
      if (current?.status !== "planned" && current?.status !== "executing") throw saveError;
      await this.journal.markRollingBack(id, error);
    }
    const current = await this.journal.get(id);
    if (current?.status !== "rolling-back") throw new Error(`Rolling-back state was not durable: ${id}`);
    return current;
  }

  private async clearPreparedReconciled(id: string): Promise<void> {
    try {
      await this.journal.clearPrepared(id);
    } catch (error) {
      if ((await this.journal.get(id))?.prepared === null) return;
      try {
        await this.journal.clearPrepared(id);
      } catch {
        throw error;
      }
    }
  }

  private async recordRolledBackReconciled(id: string, operationId: string): Promise<void> {
    try {
      await this.journal.recordRolledBack(id, operationId);
    } catch (error) {
      if ((await this.journal.get(id))?.rolledBackOperationIds.includes(operationId) === true) return;
      throw error;
    }
  }

  private async markRolledBackReconciled(id: string, error: string): Promise<void> {
    try {
      await this.journal.markRolledBack(id, error);
    } catch (saveError) {
      const current = await this.journal.get(id);
      if (current?.status === "rolled-back") return;
      if (current?.status !== "rolling-back"
        || current.prepared !== null
        || current.rolledBackOperationIds.length !== current.completed.length) throw saveError;
      await this.journal.markRolledBack(id, error);
    }
  }

  private async markRecoveryRequiredReconciled(
    id: string,
    error: string,
    recovery: RecoveryReport,
  ): Promise<void> {
    try {
      await this.journal.markRecoveryRequired(id, error, recovery);
    } catch (saveError) {
      const current = await this.journal.get(id);
      if (current?.status === "recovery-required") {
        if (current.error === error && current.recovery !== undefined && sameRecoveryReport(current.recovery, recovery)) return;
        throw saveError;
      }
      if (current?.status !== "rolling-back") {
        throw saveError;
      }
      await this.journal.markRecoveryRequired(id, error, recovery);
    }
  }

  private async assertOperationReady(
    operation: PlannedOperation,
    preconditions: readonly FilePrecondition[],
  ): Promise<void> {
    const validation = await this.plans.revalidateOperation(operation);
    if (!validation.ok) throw new Error(`Operation became unsafe: ${validation.conflicts.map((value) => value.code).join(",")}`);
    for (const expected of preconditions) {
      const current = await this.reads.snapshot(expected.path);
      if (!samePrecondition(current, expected)) throw new Error(`Precondition drift at ${expected.path}`);
    }
  }
}
