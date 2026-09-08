import type { FocusedMap, MapFilter, MapSearchResult } from "../map/map-service";
import type { WorkbenchActions } from "./workbench-view";
import {
  createWorkbenchI18n,
  type WorkbenchI18n,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";
import { createWindowedList } from "./windowed-list";

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

const renderSearch = (
  root: HTMLElement,
  query: string,
  results: readonly MapSearchResult[],
  actions: WorkbenchActions,
  i18n: WorkbenchI18n,
): void => {
  const search = root.ownerDocument.createElement("div");
  search.className = "knowledge-workbench__search";
  const label = root.ownerDocument.createElement("label");
  label.textContent = i18n.t("map.search.label");
  const input = root.ownerDocument.createElement("input");
  input.type = "search";
  input.dataset.focusKey = "map-search";
  input.value = query;
  input.addEventListener("input", () => actions.onSearchMap(input.value));
  label.append(input);
  search.append(label);
  if (results.length > 0) {
    const surface = createWindowedList(root.ownerDocument, {
      rows: results,
      rowHeight: ROW_HEIGHT,
      windowSize: WINDOW_SIZE,
      overscan: WINDOW_OVERSCAN,
      renderRow: (result) => {
        const item = root.ownerDocument.createElement("li");
        appendButton(item, `${result.title} — ${result.path}`, () => {
          actions.onSelectCenter({ kind: "document", id: result.documentId });
        });
        return item;
      },
    });
    search.append(surface.element);
  }
  root.append(search);
};

const appendDetailList = (
  parent: HTMLElement,
  label: string,
  values: readonly string[],
  i18n: WorkbenchI18n,
): void => {
  const heading = parent.ownerDocument.createElement("h4");
  heading.textContent = label;
  parent.append(heading);
  if (values.length === 0) {
    const empty = parent.ownerDocument.createElement("p");
    empty.className = "knowledge-workbench__empty";
    empty.textContent = i18n.t("map.details.none");
    parent.append(empty);
    return;
  }
  const surface = createWindowedList(parent.ownerDocument, {
    rows: values,
    rowHeight: ROW_HEIGHT,
    windowSize: WINDOW_SIZE,
    overscan: WINDOW_OVERSCAN,
    renderRow: (value) => {
      const item = parent.ownerDocument.createElement("li");
      item.textContent = value;
      return item;
    },
  });
  parent.append(surface.element);
};

const MAP_REASON_KEYS = {
  "explicit link": "map.reason.explicitLink",
  "confirmed topic": "map.reason.confirmedTopic",
  "shared tag": "map.reason.sharedTag",
  "compatible frontmatter": "map.reason.compatibleFrontmatter",
  "source proximity": "map.reason.sourceProximity",
  "same folder": "map.reason.sameFolder",
  "token overlap": "map.reason.tokenOverlap",
} as const satisfies Record<string, WorkbenchMessageKey>;

const localizedExplanation = (value: string, i18n: WorkbenchI18n): string => value
  .split(", ")
  .map((part) => {
    const match = /^(.+?) \(([^)]+)\)$/u.exec(part);
    if (match === null) return i18n.t("map.reason.other");
    const key = MAP_REASON_KEYS[match[1] as keyof typeof MAP_REASON_KEYS] ?? "map.reason.other";
    return `${i18n.t(key)} (${match[2]})`;
  })
  .join(", ");

export function renderMapPane(
  root: HTMLElement,
  model: FocusedMap,
  filter: MapFilter,
  query: string,
  results: readonly MapSearchResult[],
  actions: WorkbenchActions,
  i18n: WorkbenchI18n = createWorkbenchI18n("en"),
): void {
  const header = root.ownerDocument.createElement("header");
  header.className = "knowledge-workbench__pane-header";
  const heading = root.ownerDocument.createElement("h2");
  heading.textContent = i18n.t("map.title");
  header.append(heading);
  const filters = root.ownerDocument.createElement("div");
  filters.className = "knowledge-workbench__filters";
  filters.setAttribute("aria-label", i18n.t("map.filters.aria"));
  for (const value of ["all", "note", "reference"] as const satisfies readonly MapFilter[]) {
    const button = appendButton(filters, i18n.t(`map.filter.${value}`), () => {
      actions.onSelectMapFilter(value);
    });
    button.setAttribute("aria-pressed", String(filter === value));
  }
  root.append(header, filters);
  renderSearch(root, query, results, actions, i18n);

  const canvas = root.ownerDocument.createElement("div");
  canvas.className = "knowledge-workbench__map-canvas";
  canvas.setAttribute("aria-label", i18n.t("map.canvas.aria"));
  for (const node of model.nodes) {
    const button = appendButton(canvas, node.title, () => actions.onSelectCenter({ kind: node.nodeType, id: node.id }));
    button.className = `knowledge-workbench__node knowledge-workbench__node--${node.shape}`;
    button.dataset.nodeKind = node.kind;
  }
  if (model.edges.length > 0) {
    const edges = createWindowedList(root.ownerDocument, {
      rows: model.edges,
      rowHeight: ROW_HEIGHT,
      windowSize: WINDOW_SIZE,
      overscan: WINDOW_OVERSCAN,
      renderRow: (edge) => {
        const item = root.ownerDocument.createElement("li");
        item.className = edge.confirmed
          ? "knowledge-workbench__relation knowledge-workbench__relation--confirmed"
          : "knowledge-workbench__relation knowledge-workbench__relation--inferred";
        item.textContent = i18n.t("map.relation.edge", {
          status: i18n.t(edge.confirmed ? "map.relation.confirmed" : "map.relation.inferred"),
          source: edge.sourceId,
          target: edge.targetId,
        });
        return item;
      },
    });
    edges.element.classList.add("knowledge-workbench__map-edges");
    canvas.append(edges.element);
  }
  root.append(canvas);

  if (model.selected !== null) {
    const details = root.ownerDocument.createElement("section");
    details.className = "knowledge-workbench__details";
    const heading = root.ownerDocument.createElement("h3");
    heading.textContent = i18n.t("map.selection.title");
    details.append(heading);
    if (model.selected.path !== undefined) {
      const aiActions = root.ownerDocument.createElement("div");
      aiActions.className = "knowledge-workbench__ai-actions";
      const selectedPaths = [model.selected.path];
      if (actions.onSummarize !== undefined) appendButton(aiActions, i18n.t("map.ai.summarize"), () => actions.onSummarize?.(selectedPaths));
      if (actions.onNameCluster !== undefined) appendButton(aiActions, i18n.t("map.ai.nameCluster"), () => actions.onNameCluster?.(selectedPaths));
      if (actions.onExplainRelation !== undefined) appendButton(aiActions, i18n.t("map.ai.explainRelation"), () => actions.onExplainRelation?.(selectedPaths));
      if (actions.onSuggestLabels !== undefined) appendButton(aiActions, i18n.t("map.ai.suggestLabels"), () => actions.onSuggestLabels?.(selectedPaths));
      if (aiActions.childElementCount > 0) details.append(aiActions);
    }
    if (model.selected.path !== undefined) {
      const path = root.ownerDocument.createElement("p");
      path.textContent = model.selected.path;
      details.append(path);
    }
    appendDetailList(details, i18n.t("map.details.topics"), model.selected.topics, i18n);
    appendDetailList(details, i18n.t("map.details.connected"), model.selected.connectedNodeIds, i18n);
    const relationHeading = root.ownerDocument.createElement("h4");
    relationHeading.textContent = i18n.t("map.details.reasons");
    details.append(relationHeading);
    const relations = createWindowedList(root.ownerDocument, {
      rows: model.selected.relations,
      rowHeight: ROW_HEIGHT,
      windowSize: WINDOW_SIZE,
      overscan: WINDOW_OVERSCAN,
      renderRow: (relation) => {
        const item = root.ownerDocument.createElement("li");
        item.className = relation.confirmed
          ? "knowledge-workbench__relation knowledge-workbench__relation--confirmed"
          : "knowledge-workbench__relation knowledge-workbench__relation--inferred";
        item.textContent = i18n.t("map.relation.detail", {
          status: i18n.t(relation.confirmed ? "map.relation.confirmed" : "map.relation.inferred"),
          node: relation.nodeId,
          explanation: localizedExplanation(relation.explanation, i18n),
        });
        return item;
      },
    });
    details.append(relations.element);
    root.append(details);
  }
}
