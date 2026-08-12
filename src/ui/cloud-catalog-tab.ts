import type {
  CatalogDisplayItem,
  CloudCatalogViewModel,
} from "../catalog/cloud-catalog-runtime";
import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
} from "../catalog/hybrid-catalog-types";
import {
  createWorkbenchI18n,
  type WorkbenchI18n,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";

export interface CloudCatalogTabActions {
  readonly onSearchCatalog: (query: string) => void;
  readonly onFilterCatalogFolder: (prefix: string) => void;
  readonly onToggleCatalogStatus: (status: CatalogVerificationStatus) => void;
  readonly onToggleCatalogDifference: (kind: CatalogDifferenceKind) => void;
  readonly onFilterCatalogGroup: (groupKey: string) => void;
  readonly onFilterCatalogTag: (tag: string) => void;
  readonly onToggleCatalogCloudMissing: (include: boolean) => void;
  readonly onCatalogPage: (page: number) => void;
  readonly onCopyCatalogFilename: (catalogId: string) => void;
  readonly onCopyCatalogPath: (catalogId: string) => void;
  readonly onOpenBaidu: () => void;
  readonly onSelectCatalogRecord?: (catalogId: string) => void;
  readonly onSetCatalogFiltersExpanded?: (expanded: boolean) => void;
}

export interface CloudCatalogTabOptions {
  readonly i18n: WorkbenchI18n;
  readonly selectedCatalogId: string | null;
  readonly filtersExpanded: boolean;
}

const defaultOptions = (): CloudCatalogTabOptions => ({
  i18n: createWorkbenchI18n("en"),
  selectedCatalogId: null,
  filtersExpanded: false,
});

const fixedStateMessage = (
  model: CloudCatalogViewModel,
  i18n: WorkbenchI18n,
): string | undefined => {
  if (model.status === "unconfigured") return i18n.t("catalog.state.unconfigured");
  if (model.status === "no-snapshot") return i18n.t("catalog.state.noSnapshot");
  if (model.status === "loading") return i18n.t("catalog.state.loading");
  if (model.status === "error") return i18n.t("catalog.state.error");
  if (model.status === "unavailable") return i18n.t("catalog.state.unavailable");
  if (model.status === "ready" && model.total === 0) return i18n.t("catalog.state.empty");
  return undefined;
};

const statusKey = (value: CatalogVerificationStatus): WorkbenchMessageKey => {
  if (value === "unverified") return "catalog.status.unverified";
  if (value === "verified") return "catalog.status.verified";
  return "catalog.status.difference";
};

const differenceKey = (value: CatalogDifferenceKind): WorkbenchMessageKey => {
  if (value === "cloud-added") return "catalog.difference.cloudAdded";
  if (value === "cloud-missing") return "catalog.difference.cloudMissing";
  if (value === "renamed") return "catalog.difference.renamed";
  return "catalog.difference.moved";
};

const appendTextInput = (
  parent: HTMLElement,
  input: Readonly<{
    labelText: string;
    placeholder?: string;
    value: string;
    dataName: "catalogSearch" | "catalogFolder";
    focusKey: string;
    eventName: "input" | "change";
    onValue: (value: string) => void;
  }>,
): HTMLInputElement => {
  const label = parent.ownerDocument.createElement("label");
  label.className = "knowledge-workbench__catalog-field";
  const text = parent.ownerDocument.createElement("span");
  text.textContent = input.labelText;
  const field = parent.ownerDocument.createElement("input");
  field.type = input.dataName === "catalogSearch" ? "search" : "text";
  field.value = input.value;
  field.placeholder = input.placeholder ?? "";
  field.dataset[input.dataName] = "true";
  field.dataset.focusKey = input.focusKey;
  field.autocomplete = "off";
  field.addEventListener(input.eventName, () => input.onValue(field.value));
  label.append(text, field);
  parent.append(label);
  return field;
};

const filterButton = (
  parent: HTMLElement,
  input: Readonly<{
    label: string;
    pressed: boolean;
    dataName: "catalogStatus" | "catalogDifference" | "catalogGroup" | "catalogTag";
    dataValue: string;
    focusKey: string;
    onClick: () => void;
  }>,
): HTMLButtonElement => {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.className = "knowledge-workbench__catalog-chip";
  button.textContent = input.label;
  button.dataset[input.dataName] = input.dataValue;
  button.dataset.focusKey = input.focusKey;
  button.setAttribute("aria-pressed", String(input.pressed));
  button.addEventListener("click", input.onClick);
  parent.append(button);
  return button;
};

const appendStatusFilters = (
  parent: HTMLElement,
  model: CloudCatalogViewModel,
  actions: CloudCatalogTabActions,
  i18n: WorkbenchI18n,
): void => {
  const statuses = parent.ownerDocument.createElement("div");
  statuses.className = "knowledge-workbench__catalog-chips";
  statuses.setAttribute("aria-label", i18n.t("catalog.filters.status"));
  for (const value of ["unverified", "verified", "difference"] as const) {
    filterButton(statuses, {
      label: `${i18n.t(statusKey(value))} ${i18n.number(model.verificationCounts[value])}`,
      pressed: model.verificationStatuses.includes(value),
      dataName: "catalogStatus",
      dataValue: value,
      focusKey: `catalog-status-${value}`,
      onClick: () => actions.onToggleCatalogStatus(value),
    });
  }
  parent.append(statuses);
};

const appendAdvancedFilters = (
  parent: HTMLElement,
  model: CloudCatalogViewModel,
  actions: CloudCatalogTabActions,
  options: CloudCatalogTabOptions,
): void => {
  const { i18n } = options;
  const doc = parent.ownerDocument;
  const details = doc.createElement("details");
  details.className = "knowledge-workbench__catalog-advanced";
  details.dataset.catalogAdvancedFilters = "true";
  details.open = options.filtersExpanded;
  const summary = doc.createElement("summary");
  summary.textContent = i18n.t("catalog.filters.advanced");
  let lastOpen = options.filtersExpanded;
  let userTogglePending = false;
  summary.addEventListener("click", () => { userTogglePending = true; });
  details.addEventListener("toggle", () => {
    const open = details.open;
    const changed = open !== lastOpen;
    lastOpen = open;
    const userInitiated = userTogglePending;
    userTogglePending = false;
    if (changed && userInitiated) actions.onSetCatalogFiltersExpanded?.(open);
  });
  const content = doc.createElement("div");
  content.className = "knowledge-workbench__catalog-advanced-content";

  if (model.source === "legacy") {
    appendTextInput(content, {
      labelText: i18n.t("catalog.filters.folderPrefix"),
      value: model.folderPrefix,
      dataName: "catalogFolder",
      focusKey: "catalog-folder",
      eventName: "change",
      onValue: actions.onFilterCatalogFolder,
    });
  } else if (model.source === "unified") {
    const differences = doc.createElement("div");
    differences.className = "knowledge-workbench__catalog-chips";
    differences.setAttribute("aria-label", i18n.t("catalog.filters.difference"));
    for (const value of ["cloud-added", "cloud-missing", "renamed", "moved"] as const) {
      filterButton(differences, {
        label: i18n.t(differenceKey(value)),
        pressed: model.differenceKinds.includes(value),
        dataName: "catalogDifference",
        dataValue: value,
        focusKey: `catalog-difference-${value}`,
        onClick: () => actions.onToggleCatalogDifference(value),
      });
    }

    const groups = doc.createElement("div");
    groups.className = "knowledge-workbench__catalog-chips";
    groups.setAttribute("aria-label", i18n.t("catalog.filters.category"));
    for (const group of model.groups) {
      filterButton(groups, {
        label: `${group.label} ${i18n.number(group.count)}`,
        pressed: model.topLevelGroupId === group.groupKey,
        dataName: "catalogGroup",
        dataValue: group.groupKey,
        focusKey: `catalog-group-${group.groupKey}`,
        onClick: () => actions.onFilterCatalogGroup(
          model.topLevelGroupId === group.groupKey ? "" : group.groupKey,
        ),
      });
    }

    const tags = doc.createElement("div");
    tags.className = "knowledge-workbench__catalog-chips";
    tags.setAttribute("aria-label", i18n.t("catalog.filters.directory"));
    for (const tag of model.hierarchyTags) {
      filterButton(tags, {
        label: `${tag.label} ${i18n.number(tag.count)}`,
        pressed: model.hierarchyTag === tag.tag,
        dataName: "catalogTag",
        dataValue: tag.tag,
        focusKey: `catalog-tag-${tag.tag}`,
        onClick: () => actions.onFilterCatalogTag(model.hierarchyTag === tag.tag ? "" : tag.tag),
      });
    }

    const missingLabel = doc.createElement("label");
    missingLabel.className = "knowledge-workbench__catalog-missing-toggle";
    const missing = doc.createElement("input");
    missing.type = "checkbox";
    missing.checked = model.includeCloudMissing;
    missing.dataset.catalogCloudMissing = "true";
    missing.dataset.focusKey = "catalog-cloud-missing";
    missing.addEventListener("change", () => actions.onToggleCatalogCloudMissing(missing.checked));
    const missingText = doc.createElement("span");
    missingText.textContent = i18n.t("catalog.filters.cloudMissing", {
      count: i18n.number(model.verificationCounts.cloudMissing),
    });
    missingLabel.append(missing, missingText);
    content.append(differences, groups, tags, missingLabel);
  }

  details.append(summary, content);
  parent.append(details);
};

const appendCopyActions = (
  parent: HTMLElement,
  record: CatalogDisplayItem,
  actions: CloudCatalogTabActions,
  i18n: WorkbenchI18n,
): void => {
  const itemActions = parent.ownerDocument.createElement("div");
  itemActions.className = "knowledge-workbench__catalog-actions";
  const copyFilename = parent.ownerDocument.createElement("button");
  copyFilename.type = "button";
  copyFilename.dataset.action = "copy-catalog-filename";
  copyFilename.textContent = i18n.t("catalog.copy.filename");
  copyFilename.addEventListener("click", (event) => {
    event.stopPropagation();
    actions.onCopyCatalogFilename(record.catalogId);
  });
  const copyPath = parent.ownerDocument.createElement("button");
  copyPath.type = "button";
  copyPath.dataset.action = "copy-cloud-path";
  copyPath.textContent = i18n.t("catalog.copy.cloudPath");
  copyPath.disabled = !record.cloudPathAvailable;
  if (!record.cloudPathAvailable) copyPath.title = i18n.t("catalog.copy.pathUnavailable");
  copyPath.addEventListener("click", (event) => {
    event.stopPropagation();
    actions.onCopyCatalogPath(record.catalogId);
  });
  itemActions.append(copyFilename, copyPath);
  parent.append(itemActions);
};

const appendIdentity = (
  parent: HTMLElement,
  record: CatalogDisplayItem,
  i18n: WorkbenchI18n,
): void => {
  const identity = parent.ownerDocument.createElement("div");
  identity.className = "knowledge-workbench__catalog-identity";
  const filename = parent.ownerDocument.createElement("strong");
  filename.textContent = record.filename;
  const path = parent.ownerDocument.createElement("code");
  path.textContent = record.pathLabel;
  const verification = parent.ownerDocument.createElement("span");
  verification.className = `knowledge-workbench__catalog-verification is-${record.verificationStatus}`;
  verification.textContent = i18n.t(
    record.verificationStatus === "difference" ? "catalog.status.hasDifference" : statusKey(record.verificationStatus),
  );
  identity.append(filename, path, verification);
  if (record.differenceKinds.length > 0) {
    const differenceLabels = parent.ownerDocument.createElement("span");
    differenceLabels.className = "knowledge-workbench__catalog-differences";
    differenceLabels.textContent = record.differenceKinds.map((kind) => i18n.t(differenceKey(kind))).join(" · ");
    identity.append(differenceLabels);
  }
  if (record.hierarchyTags.length > 0) {
    const directoryTags = parent.ownerDocument.createElement("span");
    directoryTags.className = "knowledge-workbench__catalog-directory-tags";
    directoryTags.textContent = record.hierarchyTags
      .map((tag) => tag.startsWith("folder/") ? tag.slice("folder/".length) : tag)
      .join(" › ");
    identity.append(directoryTags);
  }
  parent.append(identity);
};

const appendResults = (
  parent: HTMLElement,
  model: CloudCatalogViewModel,
  actions: CloudCatalogTabActions,
  options: CloudCatalogTabOptions,
): void => {
  const list = parent.ownerDocument.createElement("ul");
  list.className = "knowledge-workbench__catalog-results";
  list.dataset.catalogResults = "true";
  list.setAttribute("aria-label", options.i18n.t("catalog.results.label"));
  for (const record of model.items.slice(0, model.pageSize)) {
    const item = parent.ownerDocument.createElement("li");
    item.dataset.catalogResult = record.catalogId;
    item.classList.toggle("is-selected", options.selectedCatalogId === record.catalogId);
    appendIdentity(item, record, options.i18n);
    const select = parent.ownerDocument.createElement("button");
    select.type = "button";
    select.dataset.action = "select-catalog-record";
    select.dataset.focusKey = `catalog-select-${record.catalogId}`;
    select.textContent = options.i18n.t("catalog.select.record");
    select.setAttribute("aria-pressed", String(options.selectedCatalogId === record.catalogId));
    select.addEventListener("click", () => actions.onSelectCatalogRecord?.(record.catalogId));
    item.append(select);
    appendCopyActions(item, record, actions, options.i18n);
    list.append(item);
  }
  parent.append(list);
};

const appendDetails = (
  parent: HTMLElement,
  model: CloudCatalogViewModel,
  actions: CloudCatalogTabActions,
  options: CloudCatalogTabOptions,
): void => {
  const record = model.items.find((item) => item.catalogId === options.selectedCatalogId);
  const details = parent.ownerDocument.createElement("aside");
  details.className = "knowledge-workbench__catalog-details";
  const heading = parent.ownerDocument.createElement("h3");
  heading.textContent = options.i18n.t("catalog.details.title");
  details.append(heading);
  if (record === undefined) {
    details.dataset.catalogDetailsEmpty = "true";
    const empty = parent.ownerDocument.createElement("p");
    empty.textContent = options.i18n.t("catalog.details.empty");
    details.append(empty);
    parent.append(details);
    return;
  }
  details.dataset.catalogDetails = record.catalogId;
  const filename = parent.ownerDocument.createElement("strong");
  filename.textContent = record.filename;
  const description = parent.ownerDocument.createElement("dl");
  const entries: readonly [string, string][] = [
    [options.i18n.t("catalog.details.path"), record.pathLabel],
    [options.i18n.t("catalog.details.source"), options.i18n.t(
      record.catalogId.startsWith("txt:") ? "catalog.source.txt" : "catalog.source.baidu",
    )],
    [options.i18n.t("catalog.details.status"), options.i18n.t(statusKey(record.verificationStatus))],
    [options.i18n.t("catalog.details.tags"), record.hierarchyTags
      .map((tag) => tag.startsWith("folder/") ? tag.slice("folder/".length) : tag)
      .join(" › ") || "—"],
  ];
  for (const [term, value] of entries) {
    const dt = parent.ownerDocument.createElement("dt");
    dt.textContent = term;
    const dd = parent.ownerDocument.createElement("dd");
    dd.textContent = value;
    description.append(dt, dd);
  }
  details.append(filename, description);
  appendCopyActions(details, record, actions, options.i18n);
  parent.append(details);
};

export function renderCloudCatalogTab(
  root: HTMLElement,
  model: CloudCatalogViewModel,
  actions: CloudCatalogTabActions,
  suppliedOptions: CloudCatalogTabOptions = defaultOptions(),
): void {
  root.replaceChildren();
  const options = suppliedOptions;
  const { i18n } = options;
  const doc = root.ownerDocument;
  const section = doc.createElement("section");
  section.className = "knowledge-workbench__cloud-catalog";
  section.setAttribute("aria-label", i18n.t("catalog.title"));

  const header = doc.createElement("div");
  header.className = "knowledge-workbench__catalog-header";
  const heading = doc.createElement("h2");
  heading.textContent = i18n.t("catalog.title");
  const summary = doc.createElement("p");
  summary.className = "knowledge-workbench__catalog-summary";
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  summary.textContent = i18n.t("catalog.summary", {
    pdfCount: i18n.number(model.pdfCount),
    matchCount: i18n.number(model.total),
  });
  const open = doc.createElement("button");
  open.type = "button";
  open.dataset.action = "open-baidu";
  open.textContent = i18n.t("catalog.openCloud");
  open.addEventListener("click", actions.onOpenBaidu);
  header.append(heading, summary, open);

  const searchRegion = doc.createElement("div");
  searchRegion.className = "knowledge-workbench__catalog-search";
  appendTextInput(searchRegion, {
    labelText: i18n.t("catalog.search.label"),
    placeholder: i18n.t("catalog.search.placeholder"),
    value: model.query,
    dataName: "catalogSearch",
    focusKey: "catalog-search",
    eventName: "input",
    onValue: actions.onSearchCatalog,
  });
  const notice = doc.createElement("p");
  notice.className = "knowledge-workbench__catalog-notice";
  notice.textContent = i18n.t("catalog.indexNotice");
  searchRegion.append(notice);

  const filters = doc.createElement("div");
  filters.className = "knowledge-workbench__catalog-filters";
  if (model.source === "unified") appendStatusFilters(filters, model, actions, i18n);
  appendAdvancedFilters(filters, model, actions, options);
  section.append(header, searchRegion, filters);

  if (model.status === "partial") {
    const partial = doc.createElement("p");
    partial.className = "knowledge-workbench__catalog-notice";
    partial.textContent = i18n.t("catalog.state.partial");
    section.append(partial);
  }

  const stateMessage = fixedStateMessage(model, i18n);
  if (stateMessage !== undefined) {
    const empty = doc.createElement("p");
    empty.className = "knowledge-workbench__empty";
    empty.textContent = stateMessage;
    section.append(empty);
  } else {
    const body = doc.createElement("div");
    body.className = "knowledge-workbench__catalog-body";
    appendResults(body, model, actions, options);
    appendDetails(body, model, actions, options);
    section.append(body);
  }

  const pageCount = model.total === 0 ? 1 : Math.ceil(model.total / model.pageSize);
  const pagination = doc.createElement("nav");
  pagination.className = "knowledge-workbench__catalog-pagination";
  pagination.setAttribute("aria-label", i18n.t("catalog.page.label"));
  const previous = doc.createElement("button");
  previous.type = "button";
  previous.dataset.action = "catalog-previous-page";
  previous.textContent = i18n.t("catalog.page.previous");
  previous.disabled = model.page <= 0;
  previous.addEventListener("click", () => actions.onCatalogPage(Math.max(0, model.page - 1)));
  const page = doc.createElement("span");
  page.textContent = i18n.t("catalog.page.current", {
    current: i18n.number(Math.min(model.page + 1, pageCount)),
    total: i18n.number(pageCount),
  });
  const next = doc.createElement("button");
  next.type = "button";
  next.dataset.action = "catalog-next-page";
  next.textContent = i18n.t("catalog.page.next");
  next.disabled = model.page + 1 >= pageCount;
  next.addEventListener("click", () => actions.onCatalogPage(Math.min(pageCount - 1, model.page + 1)));
  pagination.append(previous, page, next);
  section.append(pagination);
  root.append(section);
}
