export type WorkbenchTab = "library" | "task" | "more";

export type WorkbenchRoute =
  | Readonly<{ tab: "library" }>
  | Readonly<{
      tab: "task";
      page: "overview" | "folder-selection" | "category-selection";
    }>
  | Readonly<{
      tab: "more";
      page:
        | "overview"
        | "connection"
        | "catalog-data"
        | "language"
        | "history"
        | "knowledge-tools"
        | "advanced";
    }>;

export const defaultWorkbenchRoute = (): WorkbenchRoute => ({ tab: "library" });

export const routeForTab = (tab: WorkbenchTab): WorkbenchRoute => (
  tab === "library"
    ? { tab: "library" }
    : tab === "task"
      ? { tab: "task", page: "overview" }
      : { tab: "more", page: "overview" }
);

export const sameWorkbenchRoute = (left: WorkbenchRoute, right: WorkbenchRoute): boolean => {
  if (left.tab !== right.tab) return false;
  if (left.tab === "library") return true;
  return right.tab === left.tab && right.page === left.page;
};
