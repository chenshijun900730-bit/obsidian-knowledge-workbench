import type { TodayItem, TodayViewModel } from "../today/today-service";
import type { WorkbenchActions } from "./workbench-view";
import {
  NORMAL_RUNTIME_POLICY,
  type RuntimeSafetyPolicy,
} from "../runtime/safety-policy";

export type TodayFilter = "all" | "note" | "reference";

const ACCEPTANCE_CAPTURE_LABEL = "Quick Capture creates Markdown and is unavailable in read-only acceptance mode";

const appendButton = (parent: HTMLElement, label: string, onClick: (() => void) | undefined, className?: string): HTMLButtonElement => {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className !== undefined) button.className = className;
  if (onClick !== undefined) button.addEventListener("click", onClick);
  parent.append(button);
  return button;
};

const renderItems = (
  parent: HTMLElement,
  heading: string,
  items: readonly TodayItem[],
  filter: TodayFilter,
  actions: WorkbenchActions,
): void => {
  const section = parent.ownerDocument.createElement("section");
  section.className = "knowledge-workbench__today-group";
  const title = parent.ownerDocument.createElement("h3");
  title.textContent = heading;
  section.append(title);
  const visible = items.filter((item) => filter === "all" || item.kind === filter);
  if (visible.length === 0) {
    const empty = parent.ownerDocument.createElement("p");
    empty.className = "knowledge-workbench__empty";
    empty.textContent = "Nothing waiting here.";
    section.append(empty);
  }
  for (const item of visible) {
    const article = parent.ownerDocument.createElement("article");
    article.className = "knowledge-workbench__today-item";
    const itemTitle = parent.ownerDocument.createElement("h4");
    itemTitle.textContent = item.title;
    const path = parent.ownerDocument.createElement("p");
    path.className = "knowledge-workbench__path";
    path.textContent = item.path;
    const explanation = parent.ownerDocument.createElement("p");
    explanation.textContent = item.explanation;
    const actionsRow = parent.ownerDocument.createElement("div");
    actionsRow.className = "knowledge-workbench__item-actions";
    appendButton(actionsRow, item.actionLabel, () => {
      if (item.suggestionId === undefined) actions.onOpenNote(item.path);
      else actions.onPreviewSuggestion(item.suggestionId);
    });
    appendButton(actionsRow, "Pin", () => actions.onPin(item.id));
    appendButton(actionsRow, "Dismiss", () => actions.onDismiss(item.id, item.activityAt));
    article.append(itemTitle, path, explanation, actionsRow);
    section.append(article);
  }
  parent.append(section);
};

export function renderTodayPane(
  root: HTMLElement,
  model: TodayViewModel,
  filter: TodayFilter,
  actions: WorkbenchActions,
  policy: RuntimeSafetyPolicy = NORMAL_RUNTIME_POLICY,
): void {
  const header = root.ownerDocument.createElement("header");
  header.className = "knowledge-workbench__pane-header";
  const heading = root.ownerDocument.createElement("h2");
  heading.textContent = "Today";
  const captureAllowed = policy.quickCapture === "allowed";
  const capture = appendButton(
    header,
    "Quick capture",
    captureAllowed ? actions.onQuickCapture : undefined,
    "knowledge-workbench__primary-action",
  );
  capture.dataset.action = "quick-capture";
  if (captureAllowed) {
    capture.setAttribute("aria-label", "Quick capture a note");
  } else {
    capture.disabled = true;
    capture.setAttribute(
      "aria-label",
      ACCEPTANCE_CAPTURE_LABEL,
    );
    capture.title = "Unavailable in read-only acceptance mode";
  }
  header.prepend(heading);

  const filters = root.ownerDocument.createElement("div");
  filters.className = "knowledge-workbench__filters";
  filters.setAttribute("aria-label", "Filter today items");
  for (const value of ["all", "note", "reference"] as const) {
    const button = appendButton(filters, value === "all" ? "All" : value === "note" ? "Notes" : "References", () => {
      actions.onSelectTodayFilter(value);
    });
    button.setAttribute("aria-pressed", String(filter === value));
  }

  root.append(header, filters);
  renderItems(root, "New", model.newItems, filter, actions);
  renderItems(root, "Continue", model.continueItems, filter, actions);
  renderItems(root, "Next", model.nextItems, filter, actions);
}
