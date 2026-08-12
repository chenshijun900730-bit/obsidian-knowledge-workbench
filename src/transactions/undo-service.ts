import type { VaultReadPort } from "../core/ports";
import { sameFieldState, type PlannedOperation } from "../core/types";
import { samePrecondition, type ChangePlanService, type PlanConflict, type PlanPreview } from "../plans/change-plan-service";
import type { CompletedStep, OperationJournal } from "./operation-journal";

const operationPaths = (operation: PlannedOperation): readonly string[] => {
  if (operation.kind === "move" || operation.kind === "rename") return [operation.sourcePath, operation.targetPath];
  if (operation.kind === "add-related-link") return [operation.path, operation.targetPath];
  return [operation.path];
};

export class UndoService {
  constructor(
    private readonly journal: OperationJournal,
    private readonly reads: VaultReadPort,
    private readonly plans: ChangePlanService,
  ) {}

  async preview(journalId: string): Promise<PlanPreview> {
    const entry = await this.journal.get(journalId);
    if (entry?.status !== "completed") throw new Error("Only completed operations can be undone");
    const safe: PlannedOperation[] = [];
    const conflicts: PlanConflict[] = [];
    for (const step of [...entry.completed].reverse()) {
      if (await this.atAppliedState(step)) safe.push(structuredClone(step.inverse));
      else conflicts.push({
        operationId: step.operation.id,
        code: "post-state-drift",
        paths: operationPaths(step.operation),
        severity: "warning",
      });
    }
    const visible = conflicts.map((conflict) => ({ ...conflict, operationId: "plan" }));
    return await this.plans.previewOrdered(safe, visible);
  }

  private async atAppliedState(step: CompletedStep): Promise<boolean> {
    try {
      if (step.operation.kind === "move" || step.operation.kind === "rename") {
        for (const expected of step.postconditions) {
          if (!samePrecondition(await this.reads.snapshot(expected.path), expected)) return false;
        }
        return true;
      }
      if (!(await this.reads.snapshot(step.operation.path)).exists || step.postFieldState === undefined) return false;
      const field = step.operation.kind === "add-related-link"
        ? "knowledge-workbench-related"
        : step.operation.field;
      const current = await this.reads.readOwnedField(step.operation.path, field);
      return current !== null && sameFieldState(current, step.postFieldState);
    } catch {
      return false;
    }
  }
}
