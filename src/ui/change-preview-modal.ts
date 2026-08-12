import type { App, Modal } from "obsidian";
import {
  evaluatePlanSelection,
  type ChangePlanService,
  type ConfirmedPlan,
  type PlanPreview,
} from "../plans/change-plan-service";
import type { FieldState, PlannedOperation } from "../core/types";
import type { RuntimeSafetyPolicy } from "../runtime/safety-policy";

export interface ChangePreviewPresenter {
  request(preview: PlanPreview): Promise<ConfirmedPlan | null>;
  requestSample(): Promise<boolean>;
}

export type ModalConstructor = abstract new (app: App) => Modal;

const fieldText = (value: FieldState): string => value.present ? JSON.stringify(value.value) : "not set";
const operationText = (operation: PlannedOperation): Readonly<{ before: string; after: string }> => {
  if ("sourcePath" in operation) return { before: operation.sourcePath, after: operation.targetPath };
  if ("field" in operation) return {
    before: `${operation.field}: ${fieldText(operation.before)}`,
    after: `${operation.field}: ${fieldText(operation.after)}`,
  };
  return {
    before: `knowledge-workbench-related: ${fieldText(operation.before)}`,
    after: `knowledge-workbench-related: ${fieldText(operation.after)}`,
  };
};

const conflictText = (code: string): string => code.replaceAll("-", " ");

/** Injecting Modal keeps this surface pure DOM and independent of vault write adapters. */
export function createChangePreviewModalClass(
  ModalBase: ModalConstructor,
  policy: RuntimeSafetyPolicy,
) {
  return class ChangePreviewModal extends ModalBase implements ChangePreviewPresenter {
    private mode: "plan" | "sample" | null = null;
    private preview: PlanPreview | null = null;
    private selected = new Set<string>();
    private planResult: Promise<ConfirmedPlan | null> | null = null;
    private settlePlan: ((value: ConfirmedPlan | null) => void) | null = null;
    private sampleResult: Promise<boolean> | null = null;
    private settleSample: ((value: boolean) => void) | null = null;
    private settled = false;
    private opener: HTMLElement | null = null;
    private confirming = false;
    private confirmationFailed = false;

    constructor(app: App, private readonly plans: ChangePlanService) {
      super(app);
    }

    request(preview: PlanPreview): Promise<ConfirmedPlan | null> {
      if (this.mode !== null && this.mode !== "plan") throw new Error("Modal is already in sample mode");
      if (this.planResult !== null) return this.planResult;
      this.mode = "plan";
      this.preview = preview;
      this.selected = new Set(preview.plan.operations.map((operation) => operation.id));
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.planResult = new Promise((resolve) => { this.settlePlan = resolve; });
      this.open();
      return this.planResult;
    }

    requestSample(): Promise<boolean> {
      if (policy.planConfirmation === "blocked") return Promise.resolve(false);
      if (this.mode !== null && this.mode !== "sample") throw new Error("Modal is already in plan mode");
      if (this.sampleResult !== null) return this.sampleResult;
      this.mode = "sample";
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.sampleResult = new Promise((resolve) => { this.settleSample = resolve; });
      this.open();
      return this.sampleResult;
    }

    onOpen(): void {
      this.contentEl.replaceChildren();
      this.contentEl.addEventListener("keydown", this.handleEscape);
      if (this.mode === "sample") this.renderSample();
      else if (this.mode === "plan" && this.preview !== null) this.renderPlan(this.preview);
    }

    onClose(): void {
      this.contentEl.removeEventListener("keydown", this.handleEscape);
      if (!this.settled) {
        if (this.mode === "plan") this.resolvePlan(null);
        else if (this.mode === "sample") this.resolveSample(false);
      }
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
    }

    cancel(): void {
      if (this.mode === "plan") this.resolvePlan(null);
      else if (this.mode === "sample") this.resolveSample(false);
      this.close();
    }

    private renderPlan(preview: PlanPreview): void {
      const confirmationBlocked = policy.planConfirmation === "blocked";
      this.setTitle(confirmationBlocked ? "Change plan preview (read-only)" : "Preview organization changes");
      const doc = this.contentEl.ownerDocument;
      const form = doc.createElement("form");
      form.className = "knowledge-workbench__change-preview";
      this.contentEl.classList.toggle("knowledge-workbench__change-preview--read-only", confirmationBlocked);
      if (!confirmationBlocked) {
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          void this.confirmSelection(preview);
        });
      }
      const intro = doc.createElement("p");
      intro.textContent = confirmationBlocked
        ? "Preview only. This build cannot confirm or execute changes."
        : "Select the local changes to confirm. Nothing is executed from this preview.";
      const operations = doc.createElement("div");
      operations.setAttribute("role", "group");
      operations.setAttribute("aria-label", "Proposed changes");
      for (const operation of preview.plan.operations) {
        const row = doc.createElement("label");
        row.className = "knowledge-workbench__change-row";
        row.dataset.operationId = operation.id;
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = operation.id;
        checkbox.checked = this.selected.has(operation.id);
        const detail = doc.createElement("span");
        const values = operationText(operation);
        const rationale = preview.plan.rationales[operation.id];
        detail.textContent = `${values.before} → ${values.after}. ${rationale?.summary ?? "Review change"}`;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selected.add(operation.id);
          else this.selected.delete(operation.id);
          this.updatePlanStatus(preview, status, conflicts, confirm);
        });
        row.append(checkbox, detail);
        operations.append(row);
      }
      const status = doc.createElement("p");
      status.dataset.affectedCount = "true";
      const conflicts = doc.createElement("ul");
      conflicts.className = "knowledge-workbench__change-conflicts";
      conflicts.setAttribute("aria-label", "Plan conflicts");
      const error = doc.createElement("p");
      error.setAttribute("role", "alert");
      error.setAttribute("aria-live", "assertive");
      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__item-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => this.cancel());
      const confirm = doc.createElement("button");
      confirm.type = confirmationBlocked ? "button" : "submit";
      confirm.dataset.action = "confirm";
      confirm.textContent = confirmationBlocked ? "Confirmation unavailable" : "Confirm selected changes";
      if (confirmationBlocked) {
        confirm.disabled = true;
        confirm.setAttribute(
          "aria-label",
          "Confirmation unavailable in read-only acceptance mode",
        );
        confirm.title = "Unavailable in read-only acceptance mode";
      }
      actions.append(cancel, confirm);
      form.append(intro, operations, status, conflicts, error, actions);
      this.contentEl.append(form);
      this.updatePlanStatus(preview, status, conflicts, confirm);
      operations.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
    }

    private updatePlanStatus(
      preview: PlanPreview,
      status: HTMLElement,
      conflicts: HTMLElement,
      confirm: HTMLButtonElement,
    ): void {
      const evaluation = evaluatePlanSelection(preview, [...this.selected]);
      status.textContent = `${evaluation.affectedFiles.length} affected files; ${evaluation.undoableOperationIds.length} undoable changes`;
      conflicts.replaceChildren();
      for (const conflict of [...evaluation.blockingConflicts, ...evaluation.warnings]) {
        const item = conflicts.ownerDocument.createElement("li");
        item.textContent = `${conflictText(conflict.code)}${conflict.paths.length === 0 ? "" : `: ${conflict.paths.join(", ")}`}`;
        conflicts.append(item);
      }
      confirm.disabled = this.confirming
        || policy.planConfirmation === "blocked"
        || this.confirmationFailed
        || evaluation.selectedOperations.length === 0
        || evaluation.blockingConflicts.length > 0;
    }

    private async confirmSelection(preview: PlanPreview): Promise<void> {
      if (policy.planConfirmation === "blocked") return;
      if (this.confirming || this.confirmationFailed) return;
      const evaluation = evaluatePlanSelection(preview, [...this.selected]);
      if (evaluation.selectedOperations.length === 0 || evaluation.blockingConflicts.length > 0) return;
      this.confirming = true;
      const confirm = this.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm"]');
      if (confirm !== null) confirm.disabled = true;
      const error = this.contentEl.querySelector<HTMLElement>('[role="alert"]');
      if (error !== null) error.textContent = "";
      try {
        const plan = await this.plans.confirm(preview, [...this.selected]);
        this.resolvePlan(plan);
        this.close();
      } catch (cause) {
        if (error !== null) error.textContent = cause instanceof Error ? cause.message : String(cause);
        this.confirming = false;
        this.confirmationFailed = true;
        if (confirm !== null) confirm.disabled = true;
      }
    }

    private renderSample(): void {
      this.setTitle("Sample change preview");
      const doc = this.contentEl.ownerDocument;
      const wrap = doc.createElement("div");
      wrap.className = "knowledge-workbench__change-preview";
      const example = doc.createElement("p");
      example.textContent = "Example only: Example/Untitled.md → Notes/Visible title.md";
      const label = doc.createElement("label");
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      const text = doc.createElement("span");
      text.textContent = "I understand that future changes require confirmation";
      label.append(checkbox, text);
      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__item-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => this.cancel());
      const acknowledge = doc.createElement("button");
      acknowledge.type = "button";
      acknowledge.dataset.action = "acknowledge";
      acknowledge.textContent = "Acknowledge preview safety";
      acknowledge.disabled = true;
      checkbox.addEventListener("change", () => { acknowledge.disabled = !checkbox.checked; });
      acknowledge.addEventListener("click", () => {
        if (!checkbox.checked) return;
        this.resolveSample(true);
        this.close();
      });
      actions.append(cancel, acknowledge);
      wrap.append(example, label, actions);
      this.contentEl.append(wrap);
      checkbox.focus();
    }

    private resolvePlan(value: ConfirmedPlan | null): void {
      if (this.settled) return;
      this.settled = true;
      this.settlePlan?.(value);
      this.settlePlan = null;
    }

    private resolveSample(value: boolean): void {
      if (this.settled) return;
      this.settled = true;
      this.settleSample?.(value);
      this.settleSample = null;
    }

    private readonly handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
    };
  };
}
