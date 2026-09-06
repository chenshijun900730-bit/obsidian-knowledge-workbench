import type { WorkbenchLocale } from "../i18n/workbench-i18n";
import { createWorkbenchI18n } from "../i18n/workbench-i18n";
import type { WorkbenchRoute } from "./workbench-route";

export interface MorePageModel {
  readonly locale: WorkbenchLocale;
  readonly connectionStatus: string | undefined;
  readonly rememberedLibrary: string | null;
  readonly activeCatalogCount: number;
  readonly openAtStartup: boolean;
  readonly onSelectRoute: (route: WorkbenchRoute) => void;
}

const appendRow = (
  root: HTMLElement,
  title: string,
  detail: string,
  route: WorkbenchRoute,
  onSelectRoute: (route: WorkbenchRoute) => void,
): void => {
  const row = root.ownerDocument.createElement("section");
  row.className = "knowledge-workbench__more-row";
  const heading = root.ownerDocument.createElement("h2");
  heading.textContent = title;
  const copy = root.ownerDocument.createElement("p");
  copy.textContent = detail;
  const action = root.ownerDocument.createElement("button");
  action.type = "button";
  action.dataset.moreRoute = route.tab === "more" ? route.page : route.tab;
  action.textContent = title;
  action.addEventListener("click", () => onSelectRoute(route));
  row.append(heading, copy, action);
  root.append(row);
};

/** Concise low-frequency navigation; detailed controls stay in their shared surfaces. */
export function renderMorePage(root: HTMLElement, model: MorePageModel): void {
  const i18n = createWorkbenchI18n(model.locale);
  root.replaceChildren();
  root.classList.add("knowledge-workbench__more");
  const connection = model.connectionStatus === undefined
    ? i18n.t("more.connection.unavailable")
    : i18n.t("more.connection.status", { status: model.connectionStatus });
  appendRow(root, i18n.t("more.connection.title"), connection, {
    tab: "more", page: "connection",
  }, model.onSelectRoute);
  appendRow(root, i18n.t("more.library.title"), model.rememberedLibrary === null
    ? i18n.t("more.library.none")
    : model.rememberedLibrary, {
    tab: "more", page: "catalog-data",
  }, model.onSelectRoute);
  appendRow(root, i18n.t("more.catalog.title"), i18n.t("more.catalog.count", {
    count: i18n.number(model.activeCatalogCount),
  }), { tab: "more", page: "catalog-data" }, model.onSelectRoute);
  appendRow(root, i18n.t("more.language.title"), i18n.t(model.openAtStartup
    ? "more.language.startupOn"
    : "more.language.startupOff"), { tab: "more", page: "language" }, model.onSelectRoute);
  appendRow(root, i18n.t("history.title"), i18n.t("more.history.summary"), {
    tab: "more", page: "history",
  }, model.onSelectRoute);
  appendRow(root, i18n.t("more.advanced.title"), i18n.t("more.advanced.summary"), {
    tab: "more", page: "knowledge-tools",
  }, model.onSelectRoute);
}
