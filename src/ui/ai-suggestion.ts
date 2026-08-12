import {
  createWorkbenchI18n,
  type WorkbenchI18n,
} from "../i18n/workbench-i18n";

export function renderAiSuggestion(
  root: HTMLElement,
  text: string,
  i18n: WorkbenchI18n = createWorkbenchI18n("en"),
): void {
  const wrap = root.ownerDocument.createElement("section");
  wrap.className = "knowledge-workbench__ai-suggestion";
  const heading = root.ownerDocument.createElement("h3");
  heading.textContent = i18n.t("ai.suggestion.title");
  const value = root.ownerDocument.createElement("p");
  value.textContent = text;
  wrap.append(heading, value);
  root.append(wrap);
}
