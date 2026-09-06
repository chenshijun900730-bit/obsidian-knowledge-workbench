import type { CloudCatalogViewModel } from "../catalog/cloud-catalog-runtime";
import type { WorkbenchI18n } from "../i18n/workbench-i18n";
import {
  renderCloudCatalogTab,
  type CloudCatalogTabActions,
} from "./cloud-catalog-tab";
import type { LibraryWorkflowState } from "./library-workflow-state";

export interface RecentLibraryItem {
  readonly catalogId: string;
  readonly filename: string;
  readonly directoryTag: string;
}

export interface LibraryPageModel {
  readonly catalog: CloudCatalogViewModel;
  readonly selectedCatalogId: string | null;
  readonly recentItems: readonly RecentLibraryItem[];
  readonly filtersExpanded: boolean;
  readonly workflow: LibraryWorkflowState;
  readonly i18n: WorkbenchI18n;
}

export interface LibraryPageActions extends CloudCatalogTabActions {
  readonly onOpenTask: () => void;
  readonly onOpenCatalogDetail: (catalogId: string) => void;
}

const NON_ACTIONABLE_WORKFLOWS = new Set<LibraryWorkflowState["kind"]>([
  "complete",
  "unavailable",
]);

const createTaskReminder = (
  doc: Document,
  model: LibraryPageModel,
  actions: LibraryPageActions,
): HTMLElement | null => {
  if (NON_ACTIONABLE_WORKFLOWS.has(model.workflow.kind)) return null;

  const reminder = doc.createElement("aside");
  reminder.className = "knowledge-workbench__library-task-reminder";
  reminder.dataset.libraryTaskReminder = "true";
  reminder.setAttribute("aria-label", model.i18n.t("library.taskReminder.title"));

  const title = doc.createElement("strong");
  title.textContent = model.i18n.t("library.taskReminder.title");
  const action = doc.createElement("button");
  action.type = "button";
  action.dataset.action = "open-library-task";
  action.textContent = model.i18n.t("library.taskReminder.action");
  action.addEventListener("click", actions.onOpenTask);
  reminder.append(title, action);
  return reminder;
};

const createRecentItems = (
  doc: Document,
  model: LibraryPageModel,
): HTMLElement | null => {
  if (model.catalog.query.trim().length > 0 || model.recentItems.length === 0) {
    return null;
  }

  const section = doc.createElement("section");
  section.className = "knowledge-workbench__library-recent";
  section.dataset.libraryRecent = "true";
  section.setAttribute("aria-label", model.i18n.t("library.recent.aria"));

  const heading = doc.createElement("h2");
  heading.textContent = model.i18n.t("library.recent.title");
  const list = doc.createElement("ul");

  for (const item of model.recentItems.slice(0, 5)) {
    const row = doc.createElement("li");
    row.dataset.libraryRecentItem = item.catalogId;

    const filename = doc.createElement("strong");
    filename.textContent = item.filename;
    const directory = doc.createElement("span");
    directory.textContent = model.i18n.t("library.recent.directory", {
      directory: item.directoryTag,
    });
    row.append(filename, directory);
    list.append(row);
  }

  section.append(heading, list);
  return section;
};

const insertAfterSearch = (
  catalogHost: HTMLElement,
  nodes: readonly HTMLElement[],
): void => {
  const search = catalogHost.querySelector<HTMLElement>(
    ".knowledge-workbench__catalog-search",
  );
  if (search === null) {
    for (const node of nodes) catalogHost.append(node);
    return;
  }

  let anchor: Element = search;
  for (const node of nodes) {
    anchor.after(node);
    anchor = node;
  }
};

export function renderLibraryPage(
  root: HTMLElement,
  model: LibraryPageModel,
  actions: LibraryPageActions,
): void {
  root.replaceChildren();
  const doc = root.ownerDocument;
  const page = doc.createElement("section");
  page.className = "knowledge-workbench__library-page";
  page.dataset.libraryPage = "true";

  const heading = doc.createElement("h1");
  heading.textContent = model.i18n.t("library.title");
  const boundary = doc.createElement("p");
  boundary.className = "knowledge-workbench__library-boundary";
  boundary.dataset.libraryBoundary = "true";
  boundary.textContent = model.i18n.t("library.boundary");
  const catalogHost = doc.createElement("div");
  catalogHost.className = "knowledge-workbench__library-catalog";
  page.append(heading, boundary, catalogHost);
  root.append(page);

  renderCloudCatalogTab(catalogHost, model.catalog, actions, {
    i18n: model.i18n,
    selectedCatalogId: model.selectedCatalogId,
    filtersExpanded: model.filtersExpanded,
  });

  const extraNodes = [
    createTaskReminder(doc, model, actions),
    createRecentItems(doc, model),
  ].filter((node): node is HTMLElement => node !== null);
  insertAfterSearch(catalogHost, extraNodes);
}
