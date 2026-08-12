import type { App, Modal } from "obsidian";
import {
  evaluatePlanSelection,
  type ChangePlanService,
  type ConfirmedPlan,
  type PlanConflictCode,
  type PlanPreview,
} from "../plans/change-plan-service";
import type { FieldState, PlannedOperation } from "../core/types";
import type { RuntimeSafetyPolicy } from "../runtime/safety-policy";
import {
  createWorkbenchI18n,
  type WorkbenchI18n,
  type WorkbenchLocaleProvider,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";

export interface ChangePreviewPresenter {
  request(preview: PlanPreview): Promise<ConfirmedPlan | null>;
  requestSample(): Promise<boolean>;
}

export type ModalConstructor = abstract new (app: App) => Modal;

const fieldText = (value: FieldState, i18n: WorkbenchI18n): string => value.present
  ? JSON.stringify(value.value)
  : i18n.t("changePreview.value.notSet");
const operationText = (
  operation: PlannedOperation,
  i18n: WorkbenchI18n,
): Readonly<{ before: string; after: string }> => {
  if ("sourcePath" in operation) return { before: operation.sourcePath, after: operation.targetPath };
  if ("field" in operation) return {
    before: `${operation.field}: ${fieldText(operation.before, i18n)}`,
    after: `${operation.field}: ${fieldText(operation.after, i18n)}`,
  };
  return {
    before: `knowledge-workbench-related: ${fieldText(operation.before, i18n)}`,
    after: `knowledge-workbench-related: ${fieldText(operation.after, i18n)}`,
  };
};

const CONFLICT_KEYS = {
  "target-exists": "changePreview.conflict.targetExists",
  "case-collision": "changePreview.conflict.caseCollision",
  "duplicate-target": "changePreview.conflict.duplicateTarget",
  "overlapping-operation": "changePreview.conflict.overlappingOperation",
  "related-target-missing": "changePreview.conflict.relatedTargetMissing",
  "frontmatter-unreadable": "changePreview.conflict.frontmatterUnreadable",
  "owned-field-drift": "changePreview.conflict.ownedFieldDrift",
  "invalid-path": "changePreview.conflict.invalidPath",
  "source-missing": "changePreview.conflict.sourceMissing",
  "inbound-links": "changePreview.conflict.inboundLinks",
  "metadata-not-ready": "changePreview.conflict.metadataNotReady",
  "write-locked": "changePreview.conflict.writeLocked",
  "too-many-operations": "changePreview.conflict.tooManyOperations",
  "precondition-drift": "changePreview.conflict.preconditionDrift",
  "post-state-drift": "changePreview.conflict.postStateDrift",
} as const satisfies Record<PlanConflictCode, WorkbenchMessageKey>;

const RATIONALE_KEYS = {
  move: "changePreview.rationale.move",
  rename: "changePreview.rationale.rename",
  "set-owned-field": "changePreview.rationale.setOwnedField",
  "add-related-link": "changePreview.rationale.addRelatedLink",
} as const satisfies Record<PlannedOperation["kind"], WorkbenchMessageKey>;

const BUILT_IN_RATIONALE_KEYS = {
  "Review move": "changePreview.rationale.move",
  "Review rename": "changePreview.rationale.rename",
  "Review set owned field": "changePreview.rationale.setOwnedField",
  "Review add related link": "changePreview.rationale.addRelatedLink",
  "Confirm the folder-derived note kind": "changePreview.rationale.confirmKind",
  "Move the note to its confirmed kind root": "changePreview.rationale.confirmMove",
  "Replace a generic filename with its visible title": "changePreview.rationale.confirmRename",
  "Confirm the strongest local relation": "changePreview.rationale.confirmRelation",
} as const satisfies Record<string, WorkbenchMessageKey>;

/** Injecting Modal keeps this surface pure DOM and independent of vault write adapters. */
export function createChangePreviewModalClass(
  ModalBase: ModalConstructor,
  policy: RuntimeSafetyPolicy,
  getLocale: WorkbenchLocaleProvider = () => "en",
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
      const i18n = createWorkbenchI18n(getLocale());
      const confirmationBlocked = policy.planConfirmation === "blocked";
      this.setTitle(i18n.t(confirmationBlocked
        ? "changePreview.title.readOnly"
        : "changePreview.title.plan"));
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
      intro.textContent = i18n.t(confirmationBlocked
        ? "changePreview.intro.readOnly"
        : "changePreview.intro.plan");
      const operations = doc.createElement("div");
      operations.setAttribute("role", "group");
      operations.setAttribute("aria-label", i18n.t("changePreview.operations.aria"));
      for (const operation of preview.plan.operations) {
        const row = doc.createElement("label");
        row.className = "knowledge-workbench__change-row";
        row.dataset.operationId = operation.id;
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = operation.id;
        checkbox.checked = this.selected.has(operation.id);
        const detail = doc.createElement("span");
        const values = operationText(operation, i18n);
        const rationale = preview.plan.rationales[operation.id];
        const builtInKey = rationale?.source !== "local"
          ? undefined
          : BUILT_IN_RATIONALE_KEYS[rationale.summary as keyof typeof BUILT_IN_RATIONALE_KEYS];
        const summary = rationale === undefined
          ? i18n.t(RATIONALE_KEYS[operation.kind] ?? "changePreview.reviewChange")
          : builtInKey === undefined ? rationale.summary : i18n.t(builtInKey);
        detail.textContent = `${values.before} → ${values.after}. ${summary}`;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selected.add(operation.id);
          else this.selected.delete(operation.id);
          this.updatePlanStatus(preview, status, conflicts, confirm, i18n);
        });
        row.append(checkbox, detail);
        operations.append(row);
      }
      const status = doc.createElement("p");
      status.dataset.affectedCount = "true";
      const conflicts = doc.createElement("ul");
      conflicts.className = "knowledge-workbench__change-conflicts";
      conflicts.setAttribute("aria-label", i18n.t("changePreview.conflicts.aria"));
      const error = doc.createElement("p");
      error.setAttribute("role", "alert");
      error.setAttribute("aria-live", "assertive");
      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__item-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.textContent = i18n.t("changePreview.cancel");
      cancel.addEventListener("click", () => this.cancel());
      const confirm = doc.createElement("button");
      confirm.type = confirmationBlocked ? "button" : "submit";
      confirm.dataset.action = "confirm";
      confirm.textContent = i18n.t(confirmationBlocked
        ? "changePreview.confirm.unavailable"
        : "changePreview.confirm");
      if (confirmationBlocked) {
        confirm.disabled = true;
        confirm.setAttribute(
          "aria-label",
          i18n.t("changePreview.confirm.unavailableAria"),
        );
        confirm.title = i18n.t("acceptance.unavailable");
      }
      actions.append(cancel, confirm);
      form.append(intro, operations, status, conflicts, error, actions);
      this.contentEl.append(form);
      this.updatePlanStatus(preview, status, conflicts, confirm, i18n);
      operations.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
    }

    private updatePlanStatus(
      preview: PlanPreview,
      status: HTMLElement,
      conflicts: HTMLElement,
      confirm: HTMLButtonElement,
      i18n: WorkbenchI18n,
    ): void {
      const evaluation = evaluatePlanSelection(preview, [...this.selected]);
      status.textContent = i18n.t("changePreview.status", {
        affected: i18n.number(evaluation.affectedFiles.length),
        undoable: i18n.number(evaluation.undoableOperationIds.length),
      });
      conflicts.replaceChildren();
      for (const conflict of [...evaluation.blockingConflicts, ...evaluation.warnings]) {
        const item = conflicts.ownerDocument.createElement("li");
        item.textContent = `${i18n.t(CONFLICT_KEYS[conflict.code])}${conflict.paths.length === 0 ? "" : `: ${conflict.paths.join(", ")}`}`;
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
      } catch {
        if (error !== null) {
          error.textContent = createWorkbenchI18n(getLocale()).t("changePreview.confirm.failed");
        }
        this.confirming = false;
        this.confirmationFailed = true;
        if (confirm !== null) confirm.disabled = true;
      }
    }

    private renderSample(): void {
      const i18n = createWorkbenchI18n(getLocale());
      this.setTitle(i18n.t("changePreview.sample.title"));
      const doc = this.contentEl.ownerDocument;
      const wrap = doc.createElement("div");
      wrap.className = "knowledge-workbench__change-preview";
      const example = doc.createElement("p");
      example.textContent = i18n.t("changePreview.sample.example");
      const label = doc.createElement("label");
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      const text = doc.createElement("span");
      text.textContent = i18n.t("changePreview.sample.acknowledgement");
      label.append(checkbox, text);
      const actions = doc.createElement("div");
      actions.className = "knowledge-workbench__item-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.textContent = i18n.t("changePreview.cancel");
      cancel.addEventListener("click", () => this.cancel());
      const acknowledge = doc.createElement("button");
      acknowledge.type = "button";
      acknowledge.dataset.action = "acknowledge";
      acknowledge.textContent = i18n.t("changePreview.sample.confirm");
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
