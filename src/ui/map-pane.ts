import type { FocusedMap, MapFilter, MapSearchResult } from "../map/map-service";
import type { WorkbenchActions } from "./workbench-view";

const WINDOW_SIZE = 100;
const ROW_HEIGHT = 36;
const WINDOW_OVERSCAN = 10;

const appendButton = (parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement => {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  parent.append(button);
  return button;
};

const windowedList = <T>(
  doc: Document,
  rows: readonly T[],
  renderRow: (row: T) => HTMLLIElement,
): HTMLUListElement => {
  const list = doc.createElement("ul");
  list.className = "knowledge-workbench__windowed-list";
  list.dataset.totalRows = String(rows.length);
  let renderedStart = -1;
  const paint = (): void => {
    const maximumStart = Math.max(0, rows.length - WINDOW_SIZE);
    const start = rows.length <= WINDOW_SIZE
      ? 0
      : Math.min(maximumStart, Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - WINDOW_OVERSCAN));
    if (start === renderedStart) return;
    renderedStart = start;
    list.replaceChildren();
    if (start > 0) {
      const before = doc.createElement("li");
      before.className = "knowledge-workbench__window-spacer";
      before.setAttribute("aria-hidden", "true");
      before.style.height = `${start * ROW_HEIGHT}px`;
      list.append(before);
    }
    const end = Math.min(rows.length, start + WINDOW_SIZE);
    for (const row of rows.slice(start, end)) list.append(renderRow(row));
    if (end < rows.length) {
      const after = doc.createElement("li");
      after.className = "knowledge-workbench__window-spacer";
      after.setAttribute("aria-hidden", "true");
      after.style.height = `${(rows.length - end) * ROW_HEIGHT}px`;
      list.append(after);
    }
  };
  list.addEventListener("scroll", paint, { passive: true });
  paint();
  return list;
};

const renderSearch = (
  root: HTMLElement,
  query: string,
  results: readonly MapSearchResult[],
  actions: WorkbenchActions,
): void => {
  const search = root.ownerDocument.createElement("div");
  search.className = "knowledge-workbench__search";
  const label = root.ownerDocument.createElement("label");
  label.textContent = "Search map";
  const input = root.ownerDocument.createElement("input");
  input.type = "search";
  input.dataset.focusKey = "map-search";
  input.value = query;
  input.addEventListener("input", () => actions.onSearchMap(input.value));
  label.append(input);
  search.append(label);
  if (results.length > 0) {
    const list = windowedList(root.ownerDocument, results, (result) => {
      const item = root.ownerDocument.createElement("li");
      appendButton(item, `${result.title} — ${result.path}`, () => {
        actions.onSelectCenter({ kind: "document", id: result.documentId });
      });
      return item;
    });
    search.append(list);
  }
  root.append(search);
};

const appendDetailList = (parent: HTMLElement, label: string, values: readonly string[]): void => {
  const heading = parent.ownerDocument.createElement("h4");
  heading.textContent = label;
  parent.append(heading);
  if (values.length === 0) {
    const empty = parent.ownerDocument.createElement("p");
    empty.className = "knowledge-workbench__empty";
    empty.textContent = "None";
    parent.append(empty);
    return;
  }
  parent.append(windowedList(parent.ownerDocument, values, (value) => {
    const item = parent.ownerDocument.createElement("li");
    item.textContent = value;
    return item;
  }));
};

export function renderMapPane(
  root: HTMLElement,
  model: FocusedMap,
  filter: MapFilter,
  query: string,
  results: readonly MapSearchResult[],
  actions: WorkbenchActions,
): void {
  const header = root.ownerDocument.createElement("header");
  header.className = "knowledge-workbench__pane-header";
  const heading = root.ownerDocument.createElement("h2");
  heading.textContent = "Knowledge map";
  header.append(heading);
  const filters = root.ownerDocument.createElement("div");
  filters.className = "knowledge-workbench__filters";
  filters.setAttribute("aria-label", "Filter map nodes");
  for (const value of ["all", "note", "reference"] as const) {
    const button = appendButton(filters, value === "all" ? "All" : value === "note" ? "Notes" : "References", () => {
      actions.onSelectMapFilter(value);
    });
    button.setAttribute("aria-pressed", String(filter === value));
  }
  root.append(header, filters);
  renderSearch(root, query, results, actions);

  const canvas = root.ownerDocument.createElement("div");
  canvas.className = "knowledge-workbench__map-canvas";
  canvas.setAttribute("aria-label", "Focused knowledge graph");
  for (const node of model.nodes) {
    const button = appendButton(canvas, node.title, () => actions.onSelectCenter({ kind: node.nodeType, id: node.id }));
    button.className = `knowledge-workbench__node knowledge-workbench__node--${node.shape}`;
    button.dataset.nodeKind = node.kind;
  }
  if (model.edges.length > 0) {
    const edges = windowedList(root.ownerDocument, model.edges, (edge) => {
      const item = root.ownerDocument.createElement("li");
      item.className = edge.confirmed
        ? "knowledge-workbench__relation knowledge-workbench__relation--confirmed"
        : "knowledge-workbench__relation knowledge-workbench__relation--inferred";
      item.textContent = `${edge.confirmed ? "Confirmed" : "Inferred"}: ${edge.sourceId} → ${edge.targetId}`;
      return item;
    });
    edges.classList.add("knowledge-workbench__map-edges");
    canvas.append(edges);
  }
  root.append(canvas);

  if (model.selected !== null) {
    const details = root.ownerDocument.createElement("section");
    details.className = "knowledge-workbench__details";
    const heading = root.ownerDocument.createElement("h3");
    heading.textContent = "Selection details";
    details.append(heading);
    if (model.selected.path !== undefined) {
      const aiActions = root.ownerDocument.createElement("div");
      aiActions.className = "knowledge-workbench__ai-actions";
      const selectedPaths = [model.selected.path];
      if (actions.onSummarize !== undefined) appendButton(aiActions, "Summarize with AI", () => actions.onSummarize?.(selectedPaths));
      if (actions.onNameCluster !== undefined) appendButton(aiActions, "Name cluster with AI", () => actions.onNameCluster?.(selectedPaths));
      if (actions.onExplainRelation !== undefined) appendButton(aiActions, "Explain relation with AI", () => actions.onExplainRelation?.(selectedPaths));
      if (actions.onSuggestLabels !== undefined) appendButton(aiActions, "Suggest labels with AI", () => actions.onSuggestLabels?.(selectedPaths));
      if (aiActions.childElementCount > 0) details.append(aiActions);
    }
    if (model.selected.path !== undefined) {
      const path = root.ownerDocument.createElement("p");
      path.textContent = model.selected.path;
      details.append(path);
    }
    appendDetailList(details, "Topics", model.selected.topics);
    appendDetailList(details, "Connected nodes", model.selected.connectedNodeIds);
    const relationHeading = root.ownerDocument.createElement("h4");
    relationHeading.textContent = "Relation reasons";
    details.append(relationHeading);
    const relations = windowedList(root.ownerDocument, model.selected.relations, (relation) => {
      const item = root.ownerDocument.createElement("li");
      item.className = relation.confirmed
        ? "knowledge-workbench__relation knowledge-workbench__relation--confirmed"
        : "knowledge-workbench__relation knowledge-workbench__relation--inferred";
      item.textContent = `${relation.confirmed ? "Confirmed" : "Inferred"}: ${relation.nodeId} — ${relation.explanation}`;
      return item;
    });
    details.append(relations);
    root.append(details);
  }
}
