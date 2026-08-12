import type { CloudCatalogConnectionViewModel } from "../catalog/cloud-catalog-runtime";
import type { WorkbenchI18n } from "../i18n/workbench-i18n";
import type { CatalogProgressPresentation } from "./settings-tab";
import { presentCatalogStopReason } from "./catalog-stop-reason-presenter";

export const presentCatalogProgress = (
  connection: CloudCatalogConnectionViewModel | undefined,
  i18n: WorkbenchI18n,
): CatalogProgressPresentation => {
  const progress = connection?.scanProgress;
  const empty = i18n.t("progress.empty");
  const status = progress === undefined ? empty : i18n.t(`settings.status.${progress.status}`);
  const stopReason = progress?.stopReason === undefined
    ? empty
    : presentCatalogStopReason(progress.stopReason, i18n);
  return {
    scanStatus: i18n.t("progress.scan.status", { status }),
    pdfProgress: progress === undefined
      ? i18n.t("progress.scan.pdf", { current: empty, maximum: empty })
      : i18n.t("progress.scan.pdf", { current: i18n.number(progress.pdfCount), maximum: i18n.number(progress.budget.maxPdfCount) }),
    directoryProgress: progress === undefined
      ? i18n.t("progress.scan.directory", { current: empty, maximum: empty })
      : i18n.t("progress.scan.directory", { current: i18n.number(progress.directoryCount), maximum: i18n.number(progress.budget.maxDirectoryCount) }),
    requestProgress: progress === undefined
      ? i18n.t("progress.scan.request", { current: empty, maximum: empty })
      : i18n.t("progress.scan.request", { current: i18n.number(progress.listRequestCount), maximum: i18n.number(progress.budget.maxListRequestCount) }),
    timeProgress: progress === undefined
      ? i18n.t("progress.scan.elapsed", { current: empty, maximum: empty })
      : i18n.t("progress.scan.elapsed", { current: i18n.number(progress.elapsedMs), maximum: i18n.number(progress.budget.maxDurationMs) }),
    stopReason: i18n.t("progress.scan.stopReason", { reason: stopReason }),
  };
};
