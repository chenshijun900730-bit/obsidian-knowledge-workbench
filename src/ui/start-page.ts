import { createWorkbenchI18n, type WorkbenchMessageKey } from "../i18n/workbench-i18n";
import type { RuntimeSafetyPolicy } from "../runtime/safety-policy";
import { renderMapPane } from "./map-pane";
import { renderSuggestionsTab } from "./suggestions-tab";
import { renderTodayPane } from "./today-pane";
import type { WorkbenchActions, WorkbenchViewModel } from "./workbench-view";

export type StartSection = "overview" | "suggestions";

export interface StartPageOptions {
  readonly model: WorkbenchViewModel;
  readonly actions: WorkbenchActions;
  readonly policy: RuntimeSafetyPolicy;
}

const sourceMessageKeys = {
  unified: "start.source.unified",
  legacy: "start.source.legacy",
  none: "start.source.none",
} as const satisfies Record<WorkbenchViewModel["catalog"]["source"], WorkbenchMessageKey>;

const appendButton = (parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement => {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  parent.append(button);
  return button;
};

const appendProgressCard = (parent: HTMLElement, title: string, detail: string): void => {
  const card = parent.ownerDocument.createElement("article");
  card.className = "knowledge-workbench__start-progress-card";
  const heading = parent.ownerDocument.createElement("h2");
  heading.textContent = title;
  const value = parent.ownerDocument.createElement("p");
  value.textContent = detail;
  card.append(heading, value);
  parent.append(card);
};

export function renderStartPage(root: HTMLElement, options: StartPageOptions): void {
  const { actions, model, policy } = options;
  const i18n = createWorkbenchI18n(model.locale);
  const page = root.ownerDocument.createElement("section");
  page.className = "knowledge-workbench__start";
  const title = root.ownerDocument.createElement("h1");
  title.textContent = i18n.t("start.title");
  page.append(title);

  const progress = root.ownerDocument.createElement("div");
  progress.className = "knowledge-workbench__start-progress";
  appendProgressCard(progress, i18n.t("start.step.import"), `${i18n.t(sourceMessageKeys[model.catalog.source])} · ${i18n.t("catalog.pdfCount", { count: i18n.number(model.catalog.pdfCount) })}`);
  appendProgressCard(progress, i18n.t("start.step.search"), i18n.t("start.search.summary", {
    count: i18n.number(model.catalog.pdfCount),
  }));
  appendProgressCard(progress, i18n.t("start.step.verify"), i18n.t("start.verify.summary", {
    verified: i18n.number(model.catalog.verificationCounts.verified),
    unverified: i18n.number(model.catalog.verificationCounts.unverified),
    difference: i18n.number(model.catalog.verificationCounts.difference + model.catalog.verificationCounts.cloudMissing),
  }));
  page.append(progress);

  const next = root.ownerDocument.createElement("section");
  next.className = "knowledge-workbench__start-next";
  const nextTitle = root.ownerDocument.createElement("h2");
  nextTitle.textContent = i18n.t("start.next");
  next.append(nextTitle);
  appendButton(next, i18n.t("start.step.search"), () => actions.onSelectRoute({ tab: "library" }));
  appendButton(next, i18n.t("start.step.verify"), () => actions.onSelectRoute({
    tab: "task",
    page: "overview",
  }));
  page.append(next);

  const sections = root.ownerDocument.createElement("div");
  sections.className = "knowledge-workbench__start-sections";
  for (const section of ["overview", "suggestions"] as const satisfies readonly StartSection[]) {
    const button = appendButton(sections, i18n.t(`start.section.${section}`), () => actions.onSelectStartSection(section));
    button.dataset.startSection = section;
    button.dataset.focusKey = `start-section-${section}`;
    button.setAttribute("aria-pressed", String(model.startSection === section));
  }
  page.append(sections);

  if (model.startSection === "overview") {
    const split = root.ownerDocument.createElement("div");
    split.className = "knowledge-workbench__split knowledge-workbench__start-split";
    const today = root.ownerDocument.createElement("section");
    today.className = "knowledge-workbench__today";
    today.setAttribute("aria-label", i18n.t("today.title"));
    const map = root.ownerDocument.createElement("section");
    map.className = "knowledge-workbench__map";
    map.setAttribute("aria-label", i18n.t("map.title"));
    split.append(today, map);
    renderTodayPane(today, model.today, model.todayFilter, actions, policy, i18n);
    if (policy.quickCapture !== "allowed") today.querySelector('[data-action="quick-capture"]')?.remove();
    renderMapPane(map, model.map, model.mapFilter, model.searchQuery, model.searchResults, actions, i18n);
    page.append(split);
  } else {
    renderSuggestionsTab(page, model.suggestions ?? [], actions.onPreviewSuggestionIds ?? ((ids) => {
      for (const id of ids) actions.onPreviewSuggestion(id);
    }), actions.onExplainRelation, actions.onSuggestionSelectionChange, policy, i18n);
  }
  root.append(page);
}
