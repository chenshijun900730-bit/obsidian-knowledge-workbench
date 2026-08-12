import type { PlannedOperation } from "../core/types";
import type { SuggestedOperation } from "../suggestions/suggestion-service";
import {
  NORMAL_RUNTIME_POLICY,
  type RuntimeSafetyPolicy,
} from "../runtime/safety-policy";
import {
  createWorkbenchI18n,
  type WorkbenchI18n,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";

const operationSummary = (operation: PlannedOperation, i18n: WorkbenchI18n): string => {
  if ("sourcePath" in operation) return `${operation.sourcePath} → ${operation.targetPath}`;
  if ("field" in operation) return `${operation.path}: ${operation.field}`;
  return i18n.t("suggestions.operation.related", {
    path: operation.path,
    target: operation.targetPath,
  });
};

const BUILT_IN_RATIONALE_KEYS = {
  "Review move": "suggestions.rationale.move",
  "Review rename": "suggestions.rationale.rename",
  "Review set owned field": "suggestions.rationale.setOwnedField",
  "Review add related link": "suggestions.rationale.addRelatedLink",
  "Confirm the folder-derived note kind": "suggestions.rationale.confirmKind",
  "Move the note to its confirmed kind root": "suggestions.rationale.confirmMove",
  "Replace a generic filename with its visible title": "suggestions.rationale.confirmRename",
  "Confirm the strongest local relation": "suggestions.rationale.confirmRelation",
} as const satisfies Record<string, WorkbenchMessageKey>;

const rationaleSummary = (suggestion: SuggestedOperation, i18n: WorkbenchI18n): string => {
  if (suggestion.rationale.source === "ai-assisted") return suggestion.rationale.summary;
  const key = BUILT_IN_RATIONALE_KEYS[
    suggestion.rationale.summary as keyof typeof BUILT_IN_RATIONALE_KEYS
  ];
  return key === undefined ? suggestion.rationale.summary : i18n.t(key);
};

export function renderSuggestionsTab(
  root: HTMLElement,
  suggestions: readonly SuggestedOperation[],
  onPreview: (suggestionIds: readonly string[]) => void,
  onExplainRelation?: (paths: readonly string[], targetSuggestionId: string) => void,
  onSelectionChange?: () => void,
  policy: RuntimeSafetyPolicy = NORMAL_RUNTIME_POLICY,
  i18n: WorkbenchI18n = createWorkbenchI18n("en"),
): void {
  const doc = root.ownerDocument;
  const section = doc.createElement("section");
  section.className = "knowledge-workbench__suggestions";
  section.setAttribute("aria-label", i18n.t("suggestions.title"));
  const heading = doc.createElement("h2");
  heading.textContent = i18n.t("suggestions.title");
  section.append(heading);
  if (suggestions.length === 0) {
    const empty = doc.createElement("p");
    empty.textContent = i18n.t("suggestions.empty");
    section.append(empty);
    root.append(section);
    return;
  }

  const selected = new Set<string>();
  const list = doc.createElement("ul");
  const preview = doc.createElement("button");
  preview.type = "button";
  preview.textContent = i18n.t("suggestions.preview");
  preview.disabled = true;
  const refreshButton = (): void => { preview.disabled = selected.size === 0; };
  for (const suggestion of suggestions) {
    const item = doc.createElement("li");
    const label = doc.createElement("label");
    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = suggestion.operation.id;
    checkbox.dataset.focusKey = `suggestion-${suggestion.operation.id}`;
    const detail = doc.createElement("span");
    detail.textContent = `${operationSummary(suggestion.operation, i18n)} — ${rationaleSummary(suggestion, i18n)}`;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(suggestion.operation.id);
      else selected.delete(suggestion.operation.id);
      refreshButton();
      onSelectionChange?.();
    });
    label.append(checkbox, detail);
    item.append(label);
    list.append(item);
  }
  preview.addEventListener("click", () => {
    if (selected.size === 0) return;
    onPreview(suggestions
      .map((suggestion) => suggestion.operation.id)
      .filter((id) => selected.has(id)));
  });
  section.append(list, preview);
  if (policy.ai === "available") {
    const explain = doc.createElement("button");
    explain.type = "button";
    explain.textContent = i18n.t("suggestions.explainAi");
    explain.disabled = true;
    const refreshAiButton = (): void => { explain.disabled = selected.size !== 1 || onExplainRelation === undefined; };
    for (const checkbox of Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
      checkbox.addEventListener("change", refreshAiButton);
    }
    explain.addEventListener("click", () => {
      if (selected.size !== 1 || onExplainRelation === undefined) return;
      const id = [...selected][0]!;
      const suggestion = suggestions.find((value) => value.operation.id === id);
      if (suggestion === undefined) return;
      const path = "sourcePath" in suggestion.operation ? suggestion.operation.sourcePath : suggestion.operation.path;
      onExplainRelation([path], id);
    });
    section.append(explain);
  }
  root.append(section);
}
