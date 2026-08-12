import type { TodayItem, TodayViewModel } from "../today/today-service";
import type { WorkbenchActions } from "./workbench-view";
import {
  NORMAL_RUNTIME_POLICY,
  type RuntimeSafetyPolicy,
} from "../runtime/safety-policy";
import {
  createWorkbenchI18n,
  type WorkbenchI18n,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";

export type TodayFilter = "all" | "note" | "reference";

const TODAY_EXPLANATION_KEYS = {
  pinned: "today.explanation.pinned",
  unclassified: "today.explanation.unclassified",
  "recently-opened": "today.explanation.recentlyOpened",
  "recently-edited": "today.explanation.recentlyEdited",
  "high-confidence-suggestion": "today.explanation.highConfidenceSuggestion",
} as const satisfies Record<TodayItem["reason"], WorkbenchMessageKey>;

const appendButton = (parent: HTMLElement, label: string, onClick: (() => void) | undefined): HTMLButtonElement => {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = label;
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
  i18n: WorkbenchI18n,
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
    empty.textContent = i18n.t("today.empty");
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
    explanation.textContent = i18n.t(TODAY_EXPLANATION_KEYS[item.reason]);
    const actionsRow = parent.ownerDocument.createElement("div");
    actionsRow.className = "knowledge-workbench__item-actions";
    appendButton(actionsRow, i18n.t(item.suggestionId === undefined
      ? item.reason === "unclassified" || item.kind === "unclassified"
        ? "today.action.review"
        : "today.action.continue"
      : "today.action.preview"), () => {
      if (item.suggestionId === undefined) actions.onOpenNote(item.path);
      else actions.onPreviewSuggestion(item.suggestionId);
    });
    appendButton(actionsRow, i18n.t("today.pin"), () => actions.onPin(item.id));
    appendButton(actionsRow, i18n.t("today.dismiss"), () => actions.onDismiss(item.id, item.activityAt));
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
  i18n: WorkbenchI18n = createWorkbenchI18n("en"),
): void {
  const header = root.ownerDocument.createElement("header");
  header.className = "knowledge-workbench__pane-header";
  const heading = root.ownerDocument.createElement("h2");
  heading.textContent = i18n.t("today.title");
  const captureAllowed = policy.quickCapture === "allowed";
  const capture = appendButton(
    header,
    i18n.t("today.quickCapture"),
    captureAllowed ? actions.onQuickCapture : undefined,
  );
  capture.className = "knowledge-workbench__primary-action";
  capture.dataset.action = "quick-capture";
  if (captureAllowed) {
    capture.setAttribute("aria-label", i18n.t("today.quickCapture.aria"));
  } else {
    capture.disabled = true;
    capture.setAttribute(
      "aria-label",
      i18n.t("acceptance.control.unavailable", { label: i18n.t("today.quickCapture") }),
    );
    capture.title = i18n.t("acceptance.unavailable");
  }
  header.prepend(heading);

  const filters = root.ownerDocument.createElement("div");
  filters.className = "knowledge-workbench__filters";
  filters.setAttribute("aria-label", i18n.t("today.filters.aria"));
  for (const value of ["all", "note", "reference"] as const satisfies readonly TodayFilter[]) {
    const button = appendButton(filters, i18n.t(`today.filter.${value}`), () => {
      actions.onSelectTodayFilter(value);
    });
    button.setAttribute("aria-pressed", String(filter === value));
  }

  root.append(header, filters);
  renderItems(root, i18n.t("today.group.new"), model.newItems, filter, actions, i18n);
  renderItems(root, i18n.t("today.group.continue"), model.continueItems, filter, actions, i18n);
  renderItems(root, i18n.t("today.group.next"), model.nextItems, filter, actions, i18n);
}
