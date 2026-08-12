import { normalizeVaultPath, validateTargetPath } from "../core/path-policy";
import { isPlannedOperationSchema, type PlannedOperation } from "../core/types";
import type { JournalEntry } from "../transactions/operation-journal";
import type { App, Modal } from "obsidian";
import {
  NORMAL_RUNTIME_POLICY,
  type RuntimeSafetyPolicy,
} from "../runtime/safety-policy";

export interface HistoryViewModel {
  readonly entries: readonly JournalEntry[];
  readonly recoveryReport?: RecoveryReportViewModel;
}

export interface RecoveryIssueViewModel {
  readonly operationId: string;
  readonly comparison: "at-precondition" | "differs" | "unreadable";
  readonly originalPaths: readonly string[];
  readonly currentPaths: readonly string[];
}

export interface RecoveryReportViewModel {
  readonly journalId: string;
  readonly issues: readonly RecoveryIssueViewModel[];
}

export interface HistoryActions {
  readonly onUndo: (id: string) => void;
  readonly onViewRecovery: (id: string) => void;
  readonly onClear: () => void;
  readonly onExport: () => void;
}

export interface HistoryConfirmationPresenter {
  request(): Promise<boolean>;
}

export type HistoryModalConstructor = abstract new (app: App) => Modal;

export function createHistoryConfirmationModalClass(ModalBase: HistoryModalConstructor) {
  return class HistoryConfirmationModal extends ModalBase implements HistoryConfirmationPresenter {
    private result: Promise<boolean> | null = null;
    private settle: ((value: boolean) => void) | null = null;
    private settled = false;
    private opener: HTMLElement | null = null;

    request(): Promise<boolean> {
      if (this.result !== null) return this.result;
      this.opener = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.result = new Promise((resolve) => { this.settle = resolve; });
      this.open();
      return this.result;
    }

    onOpen(): void {
      this.contentEl.addEventListener("keydown", this.handleEscape);
      this.setTitle("Clear operation history?");
      const text = this.contentEl.ownerDocument.createElement("p");
      text.textContent = "Completed and rolled-back history will be removed. Recovery records remain protected.";
      const cancel = this.contentEl.ownerDocument.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => this.finish(false));
      const confirm = this.contentEl.ownerDocument.createElement("button");
      confirm.type = "button";
      confirm.textContent = "Clear history";
      confirm.addEventListener("click", () => this.finish(true));
      this.contentEl.replaceChildren(text, cancel, confirm);
      cancel.focus();
    }

    onClose(): void {
      this.contentEl.removeEventListener("keydown", this.handleEscape);
      if (!this.settled) this.finish(false, false);
      this.contentEl.replaceChildren();
      this.opener?.focus({ preventScroll: true });
      this.opener = null;
    }

    private finish(value: boolean, close = true): void {
      if (this.settled) return;
      this.settled = true;
      this.settle?.(value);
      this.settle = null;
      if (close) this.close();
    }

    private readonly handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.finish(false);
    };
  };
}

const STATUS_LABELS: Readonly<Record<JournalEntry["status"], string>> = {
  planned: "Planned",
  executing: "Executing",
  completed: "Completed",
  "rolling-back": "Rolling back",
  "rolled-back": "Rolled back",
  "recovery-required": "Recovery required",
};
const statusLabel = (status: JournalEntry["status"]): string | undefined =>
  Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) ? STATUS_LABELS[status] : undefined;

const rollbackResult = (entry: JournalEntry): string => {
  if (entry.status === "completed") return "Rollback not needed";
  if (entry.status === "rolled-back") return "Rollback complete";
  if (entry.status === "rolling-back") return "Rollback in progress";
  if (entry.status === "recovery-required") return "Recovery required";
  return entry.rolledBackOperationIds.length > 0 ? "Rollback incomplete" : "Rollback not started";
};

export function renderHistory(
  root: HTMLElement,
  model: HistoryViewModel,
  actions: HistoryActions,
  policy: RuntimeSafetyPolicy = NORMAL_RUNTIME_POLICY,
): void {
  const doc = root.ownerDocument;
  const aggregateOnly = policy.history === "aggregate-only";
  const actionButton = (label: string, action: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (aggregateOnly) {
      button.disabled = true;
      button.setAttribute("aria-label", `${label} unavailable in read-only acceptance mode`);
      button.title = "Unavailable in read-only acceptance mode";
    } else {
      button.addEventListener("click", action);
    }
    return button;
  };
  root.replaceChildren();
  if (model.entries.length === 0) {
    const empty = doc.createElement("p");
    empty.textContent = "No operation history";
    root.append(empty);
    return;
  }
  const list = doc.createElement("ol");
  list.className = "knowledge-workbench__history-list";
  for (const entry of model.entries) {
    const item = doc.createElement("li");
    const summary = doc.createElement("span");
    summary.textContent = `${statusLabel(entry.status) ?? "Unknown"} · ${entry.completed.length} completed · ${entry.rolledBackOperationIds.length} rolled back · ${rollbackResult(entry)}`;
    item.append(summary);
    if (entry.status === "completed") {
      item.append(actionButton("Undo", () => actions.onUndo(entry.id)));
    } else if (entry.status === "recovery-required") {
      item.append(actionButton("View recovery", () => actions.onViewRecovery(entry.id)));
    }
    list.append(item);
  }
  const controls = doc.createElement("div");
  const clear = actionButton("Clear history", actions.onClear);
  const exportButton = actionButton("Export history", actions.onExport);
  controls.append(clear, exportButton);
  root.append(list, controls);
  if (!aggregateOnly && model.recoveryReport !== undefined) {
    const report = doc.createElement("section");
    report.className = "knowledge-workbench__recovery-report";
    report.setAttribute("aria-label", "Recovery report");
    const title = doc.createElement("h3");
    title.textContent = `Recovery report · ${model.recoveryReport.journalId}`;
    report.append(title);
    for (const issue of model.recoveryReport.issues) {
      const row = doc.createElement("article");
      const operation = doc.createElement("h4");
      operation.textContent = issue.operationId;
      const comparison = doc.createElement("p");
      comparison.textContent = `Comparison: ${issue.comparison}`;
      const original = doc.createElement("p");
      original.textContent = `Original paths: ${issue.originalPaths.join(", ") || "None"}`;
      const current = doc.createElement("p");
      current.textContent = `Current paths: ${issue.currentPaths.join(", ") || "None"}`;
      row.append(operation, comparison, original, current);
      report.append(row);
    }
    root.append(report);
  }
}

const operationPaths = (operation: PlannedOperation): readonly string[] => {
  if (operation.kind === "move" || operation.kind === "rename") return [operation.sourcePath, operation.targetPath];
  if (operation.kind === "add-related-link") return [operation.path, operation.targetPath];
  return [operation.path];
};

const safePaths = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || !value.every((path) => typeof path === "string")) throw new Error("Invalid export paths");
  const normalized = value.map((path) => {
    const safe = normalizeVaultPath(path);
    if (safe !== path || !validateTargetPath("", safe, new Set()).ok) throw new Error("Invalid export path");
    return safe;
  });
  return [...new Set(normalized)].sort();
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeRecovery = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isObject(value)) throw new Error("Invalid recovery history");
  return {
  operationId: typeof value.operationId === "string" ? value.operationId : (() => { throw new Error("Invalid recovery operation"); })(),
  comparison: value.comparison === "at-precondition" || value.comparison === "differs" || value.comparison === "unreadable"
    ? value.comparison
    : (() => { throw new Error("Invalid recovery comparison"); })(),
  originalPaths: safePaths(value.originalPaths),
  currentPaths: safePaths(value.currentPaths),
  };
};

export function exportJournalJson(entries: unknown, exportedAt = new Date().toISOString()): string {
  if (!Array.isArray(entries) || typeof exportedAt !== "string") throw new Error("Invalid history export");
  const safeEntries = (entries as readonly unknown[]).map((entry) => {
    if (!isObject(entry)) throw new Error("Invalid history entry");
    const id = entry.id;
    const status = entry.status;
    const createdAt = entry.createdAt;
    const completed = entry.completed;
    const rolledBack = entry.rolledBackOperationIds;
    if (typeof id !== "string" || typeof status !== "string" || statusLabel(status as JournalEntry["status"]) === undefined
      || typeof createdAt !== "number" || !Number.isFinite(createdAt)
      || !Array.isArray(completed) || !Array.isArray(rolledBack) || !rolledBack.every((value) => typeof value === "string")) {
      throw new Error("Invalid history entry");
    }
    return {
      id,
      status,
      createdAt,
      completedCount: completed.length,
      rolledBackCount: rolledBack.length,
      operations: (completed as readonly unknown[]).map((step) => {
        if (!isObject(step)) throw new Error("Invalid history operation");
        const operation = step.operation;
        if (!isPlannedOperationSchema(operation)) throw new Error("Invalid history operation");
        return { id: operation.id, kind: operation.kind, paths: safePaths(operationPaths(operation)) };
      }),
      recovery: status === "recovery-required"
        ? (() => {
            if (!isObject(entry.recovery) || !Array.isArray(entry.recovery.unresolved)) throw new Error("Invalid recovery history");
            return (entry.recovery.unresolved as readonly unknown[]).map(safeRecovery);
          })()
        : undefined,
    };
  });
  return JSON.stringify({ schemaVersion: 1, exportedAt, entries: safeEntries }, null, 2);
}

export function triggerHistoryDownload(containerEl: HTMLElement, text: string, filename: string): void {
  const view = containerEl.ownerDocument.defaultView;
  if (view === null) throw new Error("History download window is unavailable");
  let url: string | null = null;
  try {
    url = view.URL.createObjectURL(new view.Blob([text], { type: "application/json" }));
    const anchor = containerEl.ownerDocument.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    if (url !== null) view.URL.revokeObjectURL(url);
  }
}
