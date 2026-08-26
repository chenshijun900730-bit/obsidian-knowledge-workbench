import {
  LARGE_CATALOG_RUN_BUDGET,
} from "../catalog/hybrid-catalog-types";
import type {
  HybridCatalogActiveSummary,
  LargeCatalogBatchSummary,
} from "../catalog/hybrid-catalog-runtime";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";
import { presentCatalogStopReason } from "./catalog-stop-reason-presenter";

const boundedCount = (value: number): number => Number.isFinite(value)
  ? Math.max(0, value)
  : 0;

export interface VerificationProgressModel {
  readonly active: HybridCatalogActiveSummary;
  readonly batch: LargeCatalogBatchSummary;
  readonly busy: boolean;
  readonly currentGroupLabel: string | null;
  readonly detailsOpen: boolean;
  readonly i18n: WorkbenchI18n;
}

const progressCard = (
  doc: Document,
  titleText: string,
  valueText: string,
  progress: HTMLElement,
  hintText?: string,
): HTMLElement => {
  const card = doc.createElement("article");
  card.className = "knowledge-workbench__verification-progress-card";
  const row = doc.createElement("div");
  row.className = "knowledge-workbench__verification-progress-heading";
  const title = doc.createElement("h3");
  title.textContent = titleText;
  const value = doc.createElement("span");
  value.textContent = valueText;
  row.append(title, value);
  card.append(row, progress);
  if (hintText !== undefined) {
    const hint = doc.createElement("p");
    hint.className = "knowledge-workbench__verification-progress-hint";
    hint.textContent = hintText;
    card.append(hint);
  }
  return card;
};

const renderOverallCard = (
  doc: Document,
  model: VerificationProgressModel,
  progress: HTMLProgressElement,
): HTMLElement => {
  const total = boundedCount(model.active.pdfCount);
  const covered = Math.min(total, boundedCount(model.active.coveredCandidatePdfCount));
  const percent = total === 0
    ? 0
    : Math.min(100, Math.round((covered / total) * 1_000) / 10);
  const title = model.i18n.t("verification.progress.overall.title");
  progress.setAttribute("aria-label", title);
  return progressCard(doc, title, model.i18n.t("verification.progress.overall.value", {
    percent: model.i18n.number(percent),
    covered: model.i18n.number(covered),
    total: model.i18n.number(total),
    completed: model.i18n.number(model.active.verifiedGroupCount),
    groups: model.i18n.number(model.active.groupCount),
  }), progress);
};

const BATCH_STATUS_KEYS: Readonly<Record<LargeCatalogBatchSummary["status"], WorkbenchMessageKey>> = {
  scanning: "settings.status.scanning",
  paused: "settings.status.paused",
  partial: "settings.status.partial",
  complete: "settings.status.complete",
};

const renderCurrentCard = (
  doc: Document,
  model: VerificationProgressModel,
  progress: HTMLElement,
): HTMLElement => {
  progress.className = "knowledge-workbench__verification-current-indicator";
  progress.classList.toggle("is-running", model.busy);
  const label = model.currentGroupLabel ?? model.i18n.t("progress.empty");
  return progressCard(
    doc,
    model.i18n.t("verification.progress.current.title", {
      label,
      segment: model.i18n.number(model.batch.runOrdinal),
    }),
    model.i18n.t(BATCH_STATUS_KEYS[model.batch.status]),
    progress,
    model.i18n.t("verification.progress.current.unknown"),
  );
};

const renderSegmentCard = (
  doc: Document,
  model: VerificationProgressModel,
  progress: HTMLProgressElement,
): HTMLElement => {
  const title = model.i18n.t("verification.progress.segment.title");
  progress.setAttribute("aria-label", title);
  return progressCard(doc, title, model.i18n.t("verification.progress.segment.value", {
    current: model.i18n.number(progress.value),
    maximum: model.i18n.number(progress.max),
  }), progress);
};

const AUTO_STATE_KEYS = {
  inactive: "verification.auto.inactive",
  running: "verification.auto.running",
  "starting-next-segment": "verification.auto.next",
  "stopped-no-progress": "verification.auto.noProgress",
  "stopped-limit": "verification.auto.limit",
} as const;

const renderAutoState = (doc: Document, model: VerificationProgressModel): HTMLElement => {
  const state = doc.createElement("p");
  state.className = "knowledge-workbench__verification-auto-state";
  state.setAttribute("role", "status");
  state.textContent = model.i18n.t(AUTO_STATE_KEYS[model.batch.autoResumeState], {
    current: model.i18n.number(model.batch.autoSegmentIndex),
    maximum: model.i18n.number(model.batch.autoSegmentLimit),
  });
  return state;
};

const appendMetric = (
  doc: Document,
  list: HTMLDListElement,
  label: string,
  value: string,
  dataKey?: "requests" | "queue" | "stop",
): void => {
  const term = doc.createElement("dt");
  term.textContent = label;
  const description = doc.createElement("dd");
  description.textContent = value;
  if (dataKey === "requests") description.dataset.verificationRunRequests = "true";
  if (dataKey === "queue") description.dataset.verificationRunQueue = "true";
  if (dataKey === "stop") description.dataset.verificationRunStop = "true";
  list.append(term, description);
};

const renderRunMetrics = (doc: Document, model: VerificationProgressModel): HTMLElement => {
  const list = doc.createElement("dl");
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.segment"),
    model.i18n.t("verification.details.segmentValue", {
      current: model.i18n.number(model.batch.autoSegmentIndex),
      maximum: model.i18n.number(model.batch.autoSegmentLimit),
    }),
  );
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.requests"),
    model.i18n.t("verification.details.requestsValue", {
      current: model.i18n.number(model.batch.listRequestCount),
      maximum: model.i18n.number(LARGE_CATALOG_RUN_BUDGET.maxListRequestCount),
      cumulative: model.i18n.number(model.batch.cumulativeListRequestCount),
    }),
    "requests",
  );
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.segmentPdfs"),
    model.i18n.number(model.batch.pdfCount),
  );
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.segmentDirectories"),
    model.i18n.t("verification.details.segmentDirectoriesValue", {
      current: model.i18n.number(model.batch.directoryCount),
      maximum: model.i18n.number(LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount),
    }),
  );
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.timeBudget"),
    model.i18n.t("verification.details.timeBudgetValue", {
      minutes: model.i18n.number(LARGE_CATALOG_RUN_BUDGET.maxDurationMs / 60_000),
    }),
  );
  appendMetric(doc, list, model.i18n.t("verification.details.ignored"), model.i18n.number(model.batch.ignoredFileCount));
  appendMetric(doc, list, model.i18n.t("verification.details.committedPdfs"), model.i18n.number(model.batch.committedPdfCount));
  appendMetric(doc, list, model.i18n.t("verification.details.pages"), model.i18n.number(model.batch.committedPageCount));
  appendMetric(doc, list, model.i18n.t("verification.details.directories"), model.i18n.number(model.batch.completedDirectoryCount));
  appendMetric(doc, list, model.i18n.t("verification.details.queue"), model.i18n.number(model.batch.pendingDirectoryCount), "queue");
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.groups"),
    `${model.i18n.number(model.batch.completedGroupCount)} / ${model.i18n.number(model.batch.selectedGroupCount)}`,
  );
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.stop"),
    model.batch.stopReason === null
      ? model.i18n.t("progress.empty")
      : presentCatalogStopReason(model.batch.stopReason, model.i18n),
    "stop",
  );
  appendMetric(
    doc,
    list,
    model.i18n.t("verification.details.checkpoint"),
    model.i18n.t("verification.details.checkpointSaved"),
  );
  return list;
};

export const renderVerificationProgress = (
  doc: Document,
  model: VerificationProgressModel,
): HTMLElement => {
  const section = doc.createElement("section");
  section.className = "knowledge-workbench__verification-progress";

  const overall = doc.createElement("progress");
  overall.dataset.verificationOverallProgress = "true";
  const overallTotal = boundedCount(model.active.pdfCount);
  overall.max = Math.max(1, overallTotal);
  overall.value = Math.min(overallTotal, boundedCount(model.active.coveredCandidatePdfCount));

  const current = doc.createElement("div");
  current.dataset.verificationCurrentProgress = "true";
  current.setAttribute("role", "progressbar");
  current.setAttribute("aria-label", model.i18n.t("verification.progress.current.aria"));

  const segment = doc.createElement("progress");
  segment.dataset.verificationSegmentBudget = "true";
  segment.max = LARGE_CATALOG_RUN_BUDGET.maxPdfCount;
  segment.value = Math.min(segment.max, boundedCount(model.batch.pdfCount));

  const details = doc.createElement("details");
  details.dataset.verificationRunDetails = "true";
  details.open = model.detailsOpen;
  const summary = doc.createElement("summary");
  summary.dataset.focusKey = "verification-run-details";
  summary.textContent = model.i18n.t("verification.details.title");
  details.append(summary, renderRunMetrics(doc, model));

  section.append(
    renderOverallCard(doc, model, overall),
    renderCurrentCard(doc, model, current),
    renderSegmentCard(doc, model, segment),
    renderAutoState(doc, model),
    details,
  );
  return section;
};
