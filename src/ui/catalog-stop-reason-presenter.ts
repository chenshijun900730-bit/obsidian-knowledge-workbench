import type { CatalogScanStopReason } from "../catalog/catalog-types";
import type { LargeCatalogStopReason } from "../catalog/hybrid-catalog-types";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";

export type CatalogStopReason = CatalogScanStopReason | LargeCatalogStopReason;

const STOP_REASON_KEYS: Readonly<Record<CatalogStopReason, WorkbenchMessageKey>> = Object.freeze({
  complete: "settings.stop.complete",
  "user-canceled": "settings.stop.userCanceled",
  "selection-limit": "settings.stop.selectionLimit",
  "pdf-limit": "settings.stop.pdfLimit",
  "directory-limit": "settings.stop.directoryLimit",
  "list-request-limit": "settings.stop.listRequestLimit",
  "time-limit": "settings.stop.timeLimit",
  "authorization-canceled": "settings.stop.authorizationCanceled",
  "authorization-attempt-unavailable": "settings.stop.authorizationAttemptUnavailable",
  "authorization-attempt-expired": "settings.stop.authorizationAttemptExpired",
  "authorization-code-invalid": "settings.stop.authorizationCodeInvalid",
  "authorization-exchange-failed": "settings.stop.authorizationExchangeFailed",
  "credentials-unavailable": "settings.stop.credentialsUnavailable",
  "invalid-scan-root": "settings.stop.invalidScanRoot",
  "baidu-permission-denied": "settings.stop.baiduPermissionDenied",
  "baidu-not-found": "settings.stop.baiduNotFound",
  "baidu-rate-limited": "settings.stop.baiduRateLimited",
  "baidu-token-expired": "settings.stop.baiduTokenExpired",
  "baidu-access-unavailable": "settings.stop.baiduAccessUnavailable",
  "invalid-baidu-response": "settings.stop.invalidBaiduResponse",
  "snapshot-corrupt": "settings.stop.snapshotCorrupt",
  "hybrid-snapshot-corrupt": "settings.stop.hybridSnapshotCorrupt",
  "hybrid-batch-invalid": "settings.stop.hybridBatchInvalid",
  "hybrid-batch-unavailable": "settings.stop.hybridBatchUnavailable",
});

export const presentCatalogStopReason = (
  reason: CatalogStopReason,
  i18n: WorkbenchI18n,
): string => i18n.t(STOP_REASON_KEYS[reason]);
