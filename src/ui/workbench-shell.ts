import type { CloudCatalogConnectionViewModel } from "../catalog/cloud-catalog-runtime";
import type { WorkbenchI18n, WorkbenchLocale } from "../i18n/workbench-i18n";
import type { WorkbenchTab } from "./workbench-route";

export type { WorkbenchTab } from "./workbench-route";

const NAVIGATION = [
  { page: "library", key: "nav.library", icon: "⌕" },
  { page: "task", key: "nav.task", icon: "✓" },
  { page: "more", key: "nav.more", icon: "•••" },
] as const;

export interface WorkbenchShellOptions {
  readonly activePage: WorkbenchTab;
  readonly i18n: WorkbenchI18n;
  readonly connectionStatus: CloudCatalogConnectionViewModel["status"] | "unavailable";
  readonly onSelectPage: (page: WorkbenchTab) => void;
  readonly onSetLocale: (locale: WorkbenchLocale) => void;
}

export interface WorkbenchShellElements {
  readonly header: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly status: HTMLElement;
  readonly progress: HTMLElement;
  readonly panel: HTMLElement;
}

let shellSequence = 0;
const shellIds = new WeakMap<HTMLElement, string>();

const idPrefixFor = (root: HTMLElement): string => {
  const existing = shellIds.get(root);
  if (existing !== undefined) return existing;
  const created = `knowledge-workbench-${++shellSequence}`;
  shellIds.set(root, created);
  return created;
};

export function renderWorkbenchShell(root: HTMLElement, options: WorkbenchShellOptions): WorkbenchShellElements {
  const doc = root.ownerDocument;
  const idPrefix = idPrefixFor(root);
  const shell = doc.createElement("div");
  shell.className = "knowledge-workbench__shell";

  const sidebar = doc.createElement("nav");
  sidebar.className = "knowledge-workbench__sidebar";
  sidebar.dataset.workbenchSidebar = "true";
  sidebar.setAttribute("aria-label", options.i18n.t("app.name"));
  const buttons = NAVIGATION.map((destination) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.id = `${idPrefix}-page-${destination.page}`;
    button.dataset.workbenchPage = destination.page;
    button.dataset.workbenchIcon = destination.icon;
    button.dataset.focusKey = `page-${destination.page}`;
    if (destination.page === options.activePage) button.setAttribute("aria-current", "page");
    const navigationLabel = options.i18n.t(destination.key);
    button.setAttribute("aria-label", navigationLabel);
    const label = doc.createElement("span");
    label.className = "knowledge-workbench__nav-label";
    label.textContent = navigationLabel;
    button.append(label);
    button.addEventListener("click", () => options.onSelectPage(destination.page));
    sidebar.append(button);
    return button;
  });
  sidebar.addEventListener("keydown", (event) => {
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    let target = current;
    if (event.key === "ArrowDown") target = (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") target = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[target]!.focus();
  });

  const content = doc.createElement("div");
  content.className = "knowledge-workbench__content";
  const header = doc.createElement("header");
  header.className = "knowledge-workbench__header";
  const localeLabel = doc.createElement("label");
  const localeId = `${idPrefix}-locale`;
  localeLabel.htmlFor = localeId;
  const localeName = options.i18n.locale === "zh-CN" ? "界面语言" : "Interface language";
  localeLabel.textContent = localeName;
  const locale = doc.createElement("select");
  locale.id = localeId;
  locale.dataset.workbenchLocale = "true";
  locale.dataset.focusKey = "workbench-locale";
  locale.setAttribute("aria-label", localeName);
  for (const value of ["zh-CN", "en"] as const) {
    const option = doc.createElement("option");
    option.value = value;
    option.selected = value === options.i18n.locale;
    option.textContent = options.i18n.t(value === "zh-CN" ? "language.chinese" : "language.english");
    locale.append(option);
  }
  locale.addEventListener("change", () => options.onSetLocale(locale.value as WorkbenchLocale));
  const connection = doc.createElement("span");
  connection.className = "knowledge-workbench__connection";
  connection.textContent = options.connectionStatus;
  header.append(localeLabel, locale, connection);

  const status = doc.createElement("div");
  status.className = "knowledge-workbench__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const progress = doc.createElement("div");
  progress.className = "knowledge-workbench__progress-row";
  const panel = doc.createElement("main");
  panel.id = `${idPrefix}-panel`;
  panel.setAttribute("aria-labelledby", `${idPrefix}-page-${options.activePage}`);
  content.append(header, status, progress, panel);
  shell.append(sidebar, content);
  root.append(shell);
  return { header, sidebar, status, progress, panel };
}
