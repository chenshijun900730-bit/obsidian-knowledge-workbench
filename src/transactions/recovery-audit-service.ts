import type { VaultReadPort } from "../core/ports";
import { sameFieldState, type FilePrecondition } from "../core/types";
import { samePrecondition } from "../plans/change-plan-service";
import type { PluginDataStore } from "../storage/plugin-data-store";
import type { CompletedStep, JournalEntry, OperationJournal, PreparedStep, RecoveryIssue, RecoveryReport } from "./operation-journal";
import type { RecoveryReadinessGate } from "./recovery-readiness-gate";

type EvidenceState = "applied" | "restored" | "unresolved";
type Evidence = Readonly<{ state: EvidenceState; unreadable: boolean }>;

export class RecoveryAuditService {
  private inFlight: Promise<void> | null = null;
  private successful = false;
  private attempted = false;

  constructor(
    private readonly journal: OperationJournal,
    private readonly reads: VaultReadPort,
    private readonly gate: RecoveryReadinessGate,
    private readonly store: PluginDataStore,
  ) {}

  auditInFlight(): Promise<void> {
    if (this.successful) return Promise.resolve();
    if (this.inFlight !== null) return this.inFlight;
    const operation = this.runAudit(this.gate.lease());
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    }).catch(() => undefined);
    return operation;
  }

  private async runAudit(lease: number): Promise<void> {
    if (this.attempted) await this.store.reload();
    this.attempted = true;
    const entries = await this.journal.list();
    const active = entries.filter((entry) => entry.status === "planned" || entry.status === "executing" || entry.status === "rolling-back");
    if (active.length > 1) throw new Error("Multiple active journals require manual recovery");
    for (const entry of [...entries].reverse()) await this.auditEntry(entry);
    if (!this.gate.open(lease)) throw new Error("Recovery readiness lease expired");
    this.successful = true;
  }

  private async auditEntry(initial: JournalEntry): Promise<void> {
    if (initial.status === "completed" || initial.status === "recovery-required") return;
    if (initial.status === "rolled-back") {
      for (const step of initial.completed) {
        const evidence = await this.completedEvidence(step);
        if (evidence.state !== "restored") {
          throw new Error(`Rolled-back journal is not restored: ${initial.id}:${step.operation.id}:${evidence.state}`);
        }
      }
      return;
    }
    let entry = initial;
    if (entry.status === "planned" || entry.status === "executing") {
      await this.reconcile(
        entry.id,
        () => this.journal.markRollingBack(entry.id, "startup recovery audit"),
        { ...entry, status: "rolling-back", error: "startup recovery audit" },
      );
      entry = this.require(await this.journal.get(entry.id));
    }

    const issues: RecoveryIssue[] = [];
    if (entry.prepared !== null) {
      const evidence = await this.preparedEvidence(entry.prepared);
      if (evidence.state === "restored") {
        await this.reconcile(
          entry.id,
          () => this.journal.clearPrepared(entry.id),
          { ...entry, prepared: null },
        );
        entry = this.require(await this.journal.get(entry.id));
      } else {
        issues.push(await this.issue(entry.prepared, evidence, "Prepared operation cannot be proven unapplied"));
      }
    }

    const reversed = [...entry.completed].reverse();
    for (let index = 0; index < reversed.length; index += 1) {
      const step = reversed[index]!;
      const recorded = entry.rolledBackOperationIds[index] === step.operation.id;
      const evidence = await this.completedEvidence(step);
      if (recorded) {
        if (evidence.state !== "restored") issues.push(await this.issue(step, evidence, "Recorded rollback is not restored"));
        continue;
      }
      if (evidence.state === "restored" && entry.prepared === null && issues.length === 0) {
        const expectedIds = [...entry.rolledBackOperationIds, step.operation.id];
        await this.reconcile(
          entry.id,
          () => this.journal.recordRolledBack(entry.id, step.operation.id),
          { ...entry, rolledBackOperationIds: expectedIds },
        );
        entry = this.require(await this.journal.get(entry.id));
      } else {
        issues.push(await this.issue(
          step,
          evidence,
          evidence.state === "applied" ? "Completed operation remains applied" : "Completed operation state is unresolved",
        ));
      }
    }

    if (issues.length === 0 && entry.prepared === null && entry.rolledBackOperationIds.length === entry.completed.length) {
      await this.reconcile(
        entry.id,
        () => this.journal.markRolledBack(entry.id, "startup recovery audit"),
        { ...entry, status: "rolled-back", error: "startup recovery audit" },
      );
      return;
    }
    const recovery: RecoveryReport = { unresolved: issues };
    await this.reconcile(
      entry.id,
      () => this.journal.markRecoveryRequired(entry.id, "startup recovery audit", recovery),
      { ...entry, status: "recovery-required", error: "startup recovery audit", recovery },
    );
  }

  private async preparedEvidence(step: PreparedStep): Promise<Evidence> {
    const result = await this.preconditionsEvidence(step.preconditions);
    return { state: result.matches ? "restored" : "unresolved", unreadable: result.unreadable };
  }

  private async completedEvidence(step: CompletedStep): Promise<Evidence> {
    try {
      if (step.operation.kind === "move" || step.operation.kind === "rename") {
        const applied = await this.preconditionsEvidence(step.postconditions);
        if (applied.unreadable) return { state: "unresolved", unreadable: true };
        if (applied.matches) return { state: "applied", unreadable: false };
        const restored = await this.preconditionsEvidence(step.preconditions);
        if (restored.unreadable) return { state: "unresolved", unreadable: true };
        return { state: restored.matches ? "restored" : "unresolved", unreadable: false };
      }
      const path = step.operation.path;
      if (!(await this.reads.snapshot(path)).exists || step.postFieldState === undefined) return { state: "unresolved", unreadable: false };
      const field = step.operation.kind === "add-related-link" ? "knowledge-workbench-related" : step.operation.field;
      const current = await this.reads.readOwnedField(path, field);
      if (current === null) return { state: "unresolved", unreadable: false };
      if (sameFieldState(current, step.postFieldState)) return { state: "applied", unreadable: false };
      if (sameFieldState(current, step.operation.before)) return { state: "restored", unreadable: false };
      return { state: "unresolved", unreadable: false };
    } catch {
      return { state: "unresolved", unreadable: true };
    }
  }

  private async preconditionsEvidence(
    preconditions: readonly FilePrecondition[],
  ): Promise<Readonly<{ matches: boolean; unreadable: boolean }>> {
    let matches = true;
    let unreadable = false;
    for (const expected of preconditions) {
      try {
        if (!samePrecondition(await this.reads.snapshot(expected.path), expected)) matches = false;
      } catch {
        matches = false;
        unreadable = true;
      }
    }
    return { matches, unreadable };
  }

  private async issue(
    step: PreparedStep,
    evidence: Evidence,
    reason: string,
  ): Promise<RecoveryIssue> {
    const originalPaths = step.operation.kind === "move" || step.operation.kind === "rename"
      ? [step.operation.sourcePath, step.operation.targetPath]
      : step.operation.kind === "add-related-link"
        ? [step.operation.path, step.operation.targetPath]
        : [step.operation.path];
    const candidates = step.inverse.kind === "move" || step.inverse.kind === "rename"
      ? [step.inverse.sourcePath, step.inverse.targetPath]
      : [step.inverse.path];
    const currentPaths: string[] = [];
    let unreadable = false;
    for (const path of [...new Set([...originalPaths, ...candidates])]) {
      try {
        if ((await this.reads.snapshot(path)).exists) currentPaths.push(path);
      } catch {
        unreadable = true;
      }
    }
    return {
      operationId: step.operation.id,
      originalPaths,
      currentPaths: currentPaths.sort(),
      comparison: unreadable || evidence.unreadable ? "unreadable" : evidence.state === "restored" ? "at-precondition" : "differs",
      reason,
    };
  }

  private async reconcile(
    id: string,
    transition: () => Promise<void>,
    expected: JournalEntry,
  ): Promise<void> {
    try {
      await transition();
      const current = this.require(await this.journal.get(id));
      if (!this.sameEntry(current, expected)) throw new Error(`Recovery audit transition was not exact: ${id}`);
      return;
    } catch (firstError) {
      let durable: JournalEntry;
      try {
        durable = this.require(await this.journal.get(id));
      } catch {
        throw firstError;
      }
      if (this.sameEntry(durable, expected)) return;
      throw firstError;
    }
  }

  private sameEntry(left: JournalEntry, right: JournalEntry): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private require(entry: JournalEntry | null): JournalEntry {
    if (entry === null) throw new Error("Recovery journal disappeared");
    return entry;
  }
}
