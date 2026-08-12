import {
  isChangePlanSchema,
  verifyPlanFingerprint,
  type ConfirmedPlan,
  type PlanConflict,
  type RevalidationResult,
} from "../plans/change-plan-service";
import type { PluginDataStore } from "../storage/plugin-data-store";
import {
  isFieldStateSchema,
  isFilePreconditionSchema,
  isPlannedOperationSchema,
  sameFieldState,
  type FieldState,
  type FilePrecondition,
  type PlannedOperation,
} from "../core/types";

export type JournalStatus =
  | "planned"
  | "executing"
  | "completed"
  | "rolling-back"
  | "rolled-back"
  | "recovery-required";

export interface PreparedStep {
  readonly operation: PlannedOperation;
  readonly inverse: PlannedOperation;
  readonly preconditions: readonly FilePrecondition[];
}

export interface CompletedStep extends PreparedStep {
  readonly postconditions: readonly FilePrecondition[];
  readonly postFieldState?: FieldState;
}

export interface RecoveryIssue {
  readonly operationId: string;
  readonly originalPaths: readonly string[];
  readonly currentPaths: readonly string[];
  readonly comparison: "at-precondition" | "differs" | "unreadable";
  readonly reason: string;
}

export interface RecoveryReport {
  readonly unresolved: readonly RecoveryIssue[];
}

export interface JournalEntry {
  readonly id: string;
  readonly status: JournalStatus;
  readonly createdAt: number;
  readonly plan: ConfirmedPlan;
  readonly prepared: PreparedStep | null;
  readonly completed: readonly CompletedStep[];
  readonly rolledBackOperationIds: readonly string[];
  readonly error?: string;
  readonly recovery?: RecoveryReport;
}

export class JournalAuthorizationError extends Error {
  constructor(readonly conflicts: readonly PlanConflict[]) {
    super("Journal claim authorization failed");
    this.name = "JournalAuthorizationError";
  }
}

const BLOCKING_STATUSES = new Set<JournalStatus>([
  "planned",
  "executing",
  "rolling-back",
  "recovery-required",
]);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isLegacySettled = (value: unknown): boolean => isObject(value)
  && value.status === "settled"
  && !isObject(value.prepared);

const blocksControllerWrites = (value: unknown): boolean => {
  if (isLegacySettled(value)) return false;
  const entry = decodeEntryShape(value);
  return entry === null || BLOCKING_STATUSES.has(entry.status);
};

const clone = <T>(value: T): T => structuredClone(value);
const sameOperation = (left: PlannedOperation, right: PlannedOperation): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

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
      before: clone(operation.after),
      after: clone(operation.before),
    };
  }
  return { ...operation, before: clone(operation.after), after: clone(operation.before) };
};

const pathsOf = (operation: PlannedOperation): readonly string[] => {
  if (operation.kind === "move" || operation.kind === "rename") {
    return [operation.sourcePath, operation.targetPath];
  }
  if (operation.kind === "add-related-link") return [operation.path, operation.targetPath];
  return [operation.path];
};

const samePrecondition = (left: FilePrecondition, right: FilePrecondition): boolean =>
  left.path === right.path
  && left.exists === right.exists
  && (!left.exists || !right.exists || (left.mtime === right.mtime && left.contentHash === right.contentHash));

const RECOVERY_COMPARISONS = new Set<RecoveryIssue["comparison"]>(["at-precondition", "differs", "unreadable"]);
const ERROR_STATUSES = new Set<JournalStatus>(["rolling-back", "rolled-back", "recovery-required"]);
const hasOwn = (value: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isRecoveryIssue = (value: unknown): value is RecoveryIssue => isObject(value)
  && typeof value.operationId === "string"
  && value.operationId.trim().length > 0
  && isStringArray(value.originalPaths)
  && isStringArray(value.currentPaths)
  && typeof value.comparison === "string"
  && RECOVERY_COMPARISONS.has(value.comparison as RecoveryIssue["comparison"])
  && typeof value.reason === "string"
  && value.reason.trim().length > 0;
const isRecoveryReport = (value: unknown): value is RecoveryReport => isObject(value)
  && Array.isArray(value.unresolved)
  && value.unresolved.length > 0
  && value.unresolved.every(isRecoveryIssue);

const assertPreparedPreconditions = (
  entry: JournalEntry,
  operation: PlannedOperation,
  preconditions: readonly FilePrecondition[],
): void => {
  const expected = pathsOf(operation).map((path) => entry.plan.preconditions.find((value) => value.path === path));
  if (expected.some((value) => value === undefined)
    || expected.length !== preconditions.length
    || expected.some((value, index) => !samePrecondition(value!, preconditions[index]!))) {
    throw new Error(`Prepared preconditions do not match the persisted plan: ${operation.id}`);
  }
};

const assertPostconditions = (
  operation: PlannedOperation,
  preconditions: readonly FilePrecondition[],
  postconditions: readonly FilePrecondition[],
  postFieldState?: FieldState,
): void => {
  if (operation.kind === "move" || operation.kind === "rename") {
    const source = postconditions.find((value) => value.path === operation.sourcePath);
    const target = postconditions.find((value) => value.path === operation.targetPath);
    const originalSource = preconditions.find((value) => value.path === operation.sourcePath);
    if (postconditions.length !== 2
      || source?.exists !== false
      || target?.exists !== true
      || originalSource?.exists !== true
      || target.contentHash !== originalSource.contentHash
      || postFieldState !== undefined) {
      throw new Error(`Structural postconditions are invalid: ${operation.id}`);
    }
    return;
  }
  const source = postconditions.find((value) => value.path === operation.path);
  if (postconditions.length !== 1 || source?.exists !== true || postFieldState === undefined || !sameFieldState(postFieldState, operation.after)) {
    throw new Error(`Field postconditions are invalid: ${operation.id}`);
  }
};

const JOURNAL_STATUSES = new Set<JournalStatus>([
  "planned",
  "executing",
  "completed",
  "rolling-back",
  "rolled-back",
  "recovery-required",
]);

const decodeEntryShape = (value: unknown): JournalEntry | null => {
  if (!isObject(value)
    || typeof value.status !== "string"
    || !JOURNAL_STATUSES.has(value.status as JournalStatus)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)
    || !isChangePlanSchema(value.plan)
    || (value.prepared !== null && !isObject(value.prepared))
    || !Array.isArray(value.completed)
    || !Array.isArray(value.rolledBackOperationIds)
    || !value.rolledBackOperationIds.every((operationId) => typeof operationId === "string")) return null;
  const status = value.status as JournalStatus;
  const hasError = hasOwn(value, "error");
  const hasRecovery = hasOwn(value, "recovery");
  if ((hasError && (typeof value.error !== "string" || !ERROR_STATUSES.has(status)))
    || (status === "recovery-required" && (!hasError || !hasRecovery || !isRecoveryReport(value.recovery)))
    || (status !== "recovery-required" && hasRecovery)) return null;
  const entry = clone(value) as unknown as JournalEntry;
  try {
    for (let index = 0; index < entry.completed.length; index += 1) {
      const step = entry.completed[index];
      const operation = entry.plan.operations[index];
      if (!isObject(step)
        || operation === undefined
        || !isPlannedOperationSchema(step.operation)
        || !isPlannedOperationSchema(step.inverse)
        || !sameOperation(step.operation, operation)
        || !sameOperation(step.inverse, inverseOf(operation))
        || !Array.isArray(step.preconditions)
        || !step.preconditions.every(isFilePreconditionSchema)
        || !Array.isArray(step.postconditions)
        || !step.postconditions.every(isFilePreconditionSchema)
        || (step.postFieldState !== undefined && !isFieldStateSchema(step.postFieldState))) return null;
      assertPreparedPreconditions(entry, operation, step.preconditions);
      assertPostconditions(operation, step.preconditions, step.postconditions, step.postFieldState);
    }
    if (entry.prepared !== null) {
      const expected = entry.plan.operations[entry.completed.length];
      if (!isObject(entry.prepared)
        || expected === undefined
        || !isPlannedOperationSchema(entry.prepared.operation)
        || !isPlannedOperationSchema(entry.prepared.inverse)
        || !sameOperation(entry.prepared.operation, expected)
        || !sameOperation(entry.prepared.inverse, inverseOf(expected))
        || !Array.isArray(entry.prepared.preconditions)
        || !entry.prepared.preconditions.every(isFilePreconditionSchema)) return null;
      assertPreparedPreconditions(entry, expected, entry.prepared.preconditions);
    }
  } catch {
    return null;
  }
  const reverse = entry.completed.map((step) => step.operation.id).reverse();
  if (entry.rolledBackOperationIds.length > reverse.length
    || !entry.rolledBackOperationIds.every((operationId, index) => operationId === reverse[index])) return null;
  if (entry.status === "planned"
    && (entry.prepared !== null || entry.completed.length > 0 || entry.rolledBackOperationIds.length > 0)) return null;
  if (entry.status === "executing" && entry.rolledBackOperationIds.length > 0) return null;
  if (entry.status === "completed"
    && (entry.prepared !== null
      || entry.completed.length !== entry.plan.operations.length
      || entry.rolledBackOperationIds.length > 0)) return null;
  if (entry.status === "rolled-back"
    && (entry.prepared !== null || entry.rolledBackOperationIds.length !== entry.completed.length)) return null;
  if ((entry.status === "rolling-back" || entry.status === "recovery-required")
    && entry.prepared !== null
    && entry.rolledBackOperationIds.length > 0) return null;
  return entry;
};

const decodeValidatedEntry = async (value: unknown): Promise<JournalEntry | null> => {
  const entry = decodeEntryShape(value);
  if (entry === null || !await verifyPlanFingerprint(entry.plan)) return null;
  return entry;
};

const capValidatedHistory = async (journals: readonly unknown[], limit: number): Promise<unknown[]> => {
  const capped = clone(journals) as unknown[];
  while (capped.length > limit) {
    let disposable = capped.findIndex(isLegacySettled);
    let oldest: JournalEntry | null = null;
    for (let index = 0; index < capped.length; index += 1) {
      const entry = await decodeValidatedEntry(capped[index]);
      if (entry?.status !== "completed" && entry?.status !== "rolled-back") continue;
      if (disposable >= 0 && isLegacySettled(capped[disposable])) continue;
      if (oldest === null || entry.createdAt < oldest.createdAt || (entry.createdAt === oldest.createdAt && entry.id < oldest.id)) {
        disposable = index;
        oldest = entry;
      }
    }
    if (disposable < 0) break;
    capped.splice(disposable, 1);
  }
  return capped;
};

export class OperationJournal {
  constructor(private readonly store: PluginDataStore) {}

  organizationWritesBlocked(): boolean {
    try {
      return this.store.readJournals().some(blocksControllerWrites);
    } catch {
      return true;
    }
  }

  async begin(
    plan: ConfirmedPlan,
    createdAt: number,
    authorize?: () => Promise<RevalidationResult>,
  ): Promise<JournalEntry> {
    if (!Number.isFinite(createdAt) || !isChangePlanSchema(plan) || !await verifyPlanFingerprint(plan)) {
      throw new Error("Cannot begin a journal for a malformed plan");
    }
    let claimedId: string | null = null;
    try {
      return await this.store.mutateJournals(async (journals) => {
        const ids = new Set<string>();
        for (const value of journals) {
          if (isLegacySettled(value)) continue;
          const existing = await decodeValidatedEntry(value);
          if (existing === null) throw new Error("Recovery write-locked by malformed journal record");
          if (ids.has(existing.id)) throw new Error(`Duplicate journal ID: ${existing.id}`);
          ids.add(existing.id);
          if (BLOCKING_STATUSES.has(existing.status)) {
            throw new Error("Organization writes are locked by unfinished recovery state");
          }
        }
        const available = await capValidatedHistory(journals, 99);
        if (available.length > 99) {
          throw new Error("Cannot append journal without discarding protected recovery state");
        }
        const existingIds = new Set(available.flatMap((value) =>
          isObject(value) && typeof value.id === "string" ? [value.id] : []));
        const baseId = `${createdAt}:${plan.id}`;
        let id = baseId;
        let suffix = 1;
        while (existingIds.has(id)) {
          id = `${baseId}:${suffix}`;
          suffix += 1;
        }
        if (authorize !== undefined) {
          const authorization = await authorize();
          if (!authorization.ok) throw new JournalAuthorizationError(clone(authorization.conflicts));
        }
        claimedId = id;
        const entry: JournalEntry = {
          id,
          status: "planned",
          createdAt,
          plan: clone(plan),
          prepared: null,
          completed: [],
          rolledBackOperationIds: [],
        };
        return { journals: [...available, entry], result: entry };
      });
    } catch (error) {
      if (claimedId !== null) {
        const matches = this.store.readJournals().filter((value) => isObject(value) && value.id === claimedId);
        if (matches.length === 1) {
          const persisted = await decodeValidatedEntry(matches[0]);
          if (persisted?.status === "planned"
            && persisted.createdAt === createdAt
            && persisted.plan.fingerprint === plan.fingerprint) return persisted;
        }
      }
      throw error;
    }
  }

  async markExecuting(id: string): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "planned") throw new Error(`Illegal transition to executing from ${entry.status}`);
      return { ...entry, status: "executing" };
    });
  }

  async prepare(
    id: string,
    operation: PlannedOperation,
    inverse: PlannedOperation,
    preconditions: readonly FilePrecondition[],
  ): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "executing") throw new Error(`Cannot prepare while journal is ${entry.status}`);
      if (entry.prepared !== null) throw new Error(`A prepared step already exists: ${entry.prepared.operation.id}`);
      if (!isPlannedOperationSchema(operation)) throw new Error("Cannot prepare a malformed operation");
      if (!isPlannedOperationSchema(inverse)) throw new Error("Cannot prepare a malformed inverse");
      const expected = entry.plan.operations[entry.completed.length];
      if (expected === undefined || !sameOperation(expected, operation)) {
        throw new Error(`Operation is out of order or unknown: ${operation.id}`);
      }
      if (!sameOperation(inverseOf(operation), inverse)) throw new Error(`Inverse is inconsistent: ${operation.id}`);
      assertPreparedPreconditions(entry, operation, preconditions);
      return {
        ...entry,
        prepared: { operation: clone(operation), inverse: clone(inverse), preconditions: clone(preconditions) },
      };
    });
  }

  async clearPrepared(id: string): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "executing" && entry.status !== "rolling-back") {
        throw new Error(`Cannot clear prepared step while journal is ${entry.status}`);
      }
      if (entry.prepared === null) throw new Error("No prepared step exists");
      return { ...entry, prepared: null };
    });
  }

  async recordCompleted(
    id: string,
    postconditions: readonly FilePrecondition[],
    postFieldState?: FieldState,
  ): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "executing") throw new Error(`Cannot record completed while journal is ${entry.status}`);
      const prepared = entry.prepared;
      if (prepared === null) throw new Error("A persisted prepared step is required before completion");
      assertPostconditions(prepared.operation, prepared.preconditions, postconditions, postFieldState);
      const completed: CompletedStep = {
        operation: clone(prepared.operation),
        inverse: clone(prepared.inverse),
        preconditions: clone(prepared.preconditions),
        postconditions: clone(postconditions),
        ...(postFieldState === undefined ? {} : { postFieldState: clone(postFieldState) }),
      };
      return { ...entry, prepared: null, completed: [...entry.completed, completed] };
    });
  }

  async markRollingBack(id: string, error?: string): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "planned" && entry.status !== "executing") {
        throw new Error(`Illegal transition to rolling-back from ${entry.status}`);
      }
      return { ...entry, status: "rolling-back", ...(error === undefined ? {} : { error }) };
    });
  }

  async recordRolledBack(id: string, operationId: string): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "rolling-back") throw new Error(`Cannot record rollback while journal is ${entry.status}`);
      if (entry.prepared !== null) throw new Error("Cannot record rollback while a prepared step remains");
      const completedIds = entry.completed.map((step) => step.operation.id);
      if (!completedIds.includes(operationId)) throw new Error(`Unknown completed operation: ${operationId}`);
      if (entry.rolledBackOperationIds.includes(operationId)) throw new Error(`Operation already rolled back: ${operationId}`);
      const expected = [...completedIds].reverse()[entry.rolledBackOperationIds.length];
      if (expected !== operationId) throw new Error(`Rollback must follow reverse order; expected ${expected}`);
      return { ...entry, rolledBackOperationIds: [...entry.rolledBackOperationIds, operationId] };
    });
  }

  async markCompleted(id: string): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "executing") throw new Error(`Illegal transition to completed from ${entry.status}`);
      if (entry.prepared !== null) throw new Error("Cannot complete while a prepared step remains");
      if (entry.completed.length !== entry.plan.operations.length) throw new Error("Cannot complete with incomplete operations");
      if (entry.rolledBackOperationIds.length > 0) throw new Error("Cannot complete after rollback began");
      return { ...entry, status: "completed" };
    });
  }

  async markRolledBack(id: string, error?: string): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "rolling-back") throw new Error(`Illegal transition to rolled-back from ${entry.status}`);
      if (entry.prepared !== null) throw new Error("Cannot finish rollback while a prepared step remains");
      if (entry.rolledBackOperationIds.length !== entry.completed.length) {
        throw new Error("Cannot finish rollback before every completed operation is reversed");
      }
      return { ...entry, status: "rolled-back", ...(error === undefined ? {} : { error }) };
    });
  }

  async markRecoveryRequired(id: string, error: string, recovery: RecoveryReport): Promise<void> {
    await this.change(id, (entry) => {
      if (entry.status !== "rolling-back") {
        throw new Error(`Illegal transition to recovery-required from ${entry.status}`);
      }
      return { ...entry, status: "recovery-required", error, recovery: clone(recovery) };
    });
  }

  async get(id: string): Promise<JournalEntry | null> {
    const matches = this.store.readJournals().filter((entry) => isObject(entry) && entry.id === id);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new Error(`Duplicate journal ID: ${id}`);
    const entry = await decodeValidatedEntry(matches[0]);
    if (entry === null) throw new Error(`Malformed journal: ${id}`);
    return clone(entry);
  }

  async list(): Promise<readonly JournalEntry[]> {
    const entries: JournalEntry[] = [];
    const ids = new Set<string>();
    for (const value of this.store.readJournals()) {
      if (isLegacySettled(value)) continue;
      const entry = await decodeValidatedEntry(value);
      if (entry === null) throw new Error("Malformed journal record");
      if (ids.has(entry.id)) throw new Error(`Duplicate journal ID: ${entry.id}`);
      ids.add(entry.id);
      entries.push(entry);
    }
    entries.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    return clone(entries);
  }

  async completed(id: string): Promise<readonly CompletedStep[]> {
    return clone((await this.get(id))?.completed ?? []);
  }

  async clearHistory(): Promise<void> {
    let expected: readonly unknown[] | null = null;
    try {
      await this.store.mutateJournals(async (journals) => {
        const decoded: Array<Readonly<{ raw: unknown; entry: JournalEntry | null; legacy: boolean }>> = [];
        const ids = new Set<string>();
        for (const raw of journals) {
          if (isLegacySettled(raw)) {
            decoded.push({ raw, entry: null, legacy: true });
            continue;
          }
          const entry = await decodeValidatedEntry(raw);
          if (entry === null) throw new Error("Malformed journal record blocks history clearing");
          if (ids.has(entry.id)) throw new Error(`Duplicate journal ID: ${entry.id}`);
          ids.add(entry.id);
          if (entry.status === "planned" || entry.status === "executing" || entry.status === "rolling-back") {
            throw new Error("Cannot clear history while a transaction is active");
          }
          decoded.push({ raw, entry, legacy: false });
        }
        const retained: unknown[] = [];
        for (const value of decoded) {
          if (value.legacy) continue;
          if (value.entry?.status !== "completed" && value.entry?.status !== "rolled-back") retained.push(value.raw);
        }
        expected = clone(retained);
        return { journals: retained, result: undefined };
      });
    } catch (error) {
      if (expected !== null) {
        const durable = this.store.readJournals();
        if (JSON.stringify(durable) === JSON.stringify(expected)) return;
      }
      throw error;
    }
  }

  private async change(id: string, update: (entry: JournalEntry) => JournalEntry): Promise<void> {
    await this.store.mutateJournals(async (journals) => {
      const indexes = journals.flatMap((value, index) =>
        isObject(value) && value.id === id ? [index] : []);
      if (indexes.length === 0) throw new Error(`Journal not found: ${id}`);
      if (indexes.length !== 1) throw new Error(`Duplicate journal ID: ${id}`);
      const index = indexes[0]!;
      const current = await decodeValidatedEntry(journals[index]);
      if (current === null) throw new Error(`Malformed journal: ${id}`);
      const changed = clone(update(current));
      if (await decodeValidatedEntry(changed) === null) {
        throw new Error(`Journal transition produced malformed state: ${id}`);
      }
      const next = clone(journals) as unknown[];
      next[index] = changed;
      return { journals: next, result: undefined };
    });
  }
}
