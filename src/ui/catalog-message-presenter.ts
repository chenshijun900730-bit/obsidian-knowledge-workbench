import type { CatalogErrorCode } from "../catalog/catalog-types";
import type { HybridCatalogViewMessageCode } from "../catalog/hybrid-catalog-runtime";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";

export type CatalogMessageCode =
  | CatalogErrorCode
  | HybridCatalogViewMessageCode
  | "invalid-large-catalog-root"
  | "verification-group-required"
  | "verification-canceled";

export type VerificationActionMessageCode =
  | "hybrid-cloud-root-mismatch"
  | "invalid-scan-root"
  | "invalid-large-catalog-root";

export interface CatalogMessagePresentation {
  readonly title: string;
  readonly preservation: string;
  readonly nextAction: string;
}

interface CatalogMessageTemplate {
  readonly title: WorkbenchMessageKey;
  readonly preservation: WorkbenchMessageKey;
  readonly nextAction: WorkbenchMessageKey;
}

const ACTIVE = "message.preservation.active" as const;
const SOURCE = "message.preservation.source" as const;
const CHECKPOINT = "message.preservation.checkpoint" as const;

const TEMPLATES: Readonly<Record<CatalogMessageCode, CatalogMessageTemplate>> = Object.freeze({
  "authorization-canceled": { title: "message.title.authorizationCanceled", preservation: ACTIVE, nextAction: "message.next.authorization" },
  "authorization-attempt-unavailable": { title: "message.title.authorizationUnavailable", preservation: ACTIVE, nextAction: "message.next.authorization" },
  "authorization-attempt-expired": { title: "message.title.authorizationUnavailable", preservation: ACTIVE, nextAction: "message.next.authorization" },
  "authorization-code-invalid": { title: "message.title.authorizationCodeInvalid", preservation: ACTIVE, nextAction: "message.next.code" },
  "authorization-exchange-failed": { title: "message.title.authorizationUnavailable", preservation: ACTIVE, nextAction: "message.next.authorization" },
  "credentials-unavailable": { title: "message.title.credentialsUnavailable", preservation: ACTIVE, nextAction: "message.next.credentials" },
  "invalid-scan-root": { title: "message.title.invalidRoot", preservation: ACTIVE, nextAction: "message.next.parentRoot" },
  "invalid-large-catalog-root": { title: "message.title.invalidRoot", preservation: ACTIVE, nextAction: "message.next.parentRoot" },
  "baidu-permission-denied": { title: "message.title.permissionDenied", preservation: CHECKPOINT, nextAction: "message.next.permission" },
  "baidu-not-found": { title: "message.title.notFound", preservation: CHECKPOINT, nextAction: "message.next.notFound" },
  "baidu-rate-limited": { title: "message.title.rateLimited", preservation: CHECKPOINT, nextAction: "message.next.later" },
  "baidu-token-expired": { title: "message.title.tokenExpired", preservation: CHECKPOINT, nextAction: "message.next.reauthorize" },
  "baidu-access-unavailable": { title: "message.title.accessUnavailable", preservation: CHECKPOINT, nextAction: "message.next.retry" },
  "invalid-baidu-response": { title: "message.title.accessUnavailable", preservation: CHECKPOINT, nextAction: "message.next.retry" },
  "snapshot-corrupt": { title: "message.title.snapshotUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "hybrid-snapshot-corrupt": { title: "message.title.snapshotUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "hybrid-record-invalid": { title: "message.title.snapshotUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "txt-source-unavailable": { title: "message.title.txtUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "txt-source-invalid": { title: "message.title.txtUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "txt-import-budget-exceeded": { title: "message.title.txtUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "txt-tree-invalid": { title: "message.title.txtUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "txt-duplicate-path": { title: "message.title.txtUnavailable", preservation: SOURCE, nextAction: "message.next.reimport" },
  "hybrid-cloud-root-mismatch": { title: "message.title.rootMismatch", preservation: CHECKPOINT, nextAction: "message.next.correctResumeRoot" },
  "hybrid-batch-invalid": { title: "message.title.batchUnavailable", preservation: ACTIVE, nextAction: "message.next.restart" },
  "hybrid-batch-unavailable": { title: "message.title.batchUnavailable", preservation: ACTIVE, nextAction: "message.next.restart" },
  "catalog-unavailable": { title: "message.title.catalogUnavailable", preservation: ACTIVE, nextAction: "message.next.normalBuild" },
  "verification-group-required": { title: "message.title.groupRequired", preservation: ACTIVE, nextAction: "message.next.selectGroup" },
  "verification-canceled": { title: "message.title.canceled", preservation: CHECKPOINT, nextAction: "message.next.resume" },
});

const MESSAGE_CODES = new Set<string>(Object.keys(TEMPLATES));

export const isCatalogMessageCode = (value: unknown): value is CatalogMessageCode =>
  typeof value === "string" && MESSAGE_CODES.has(value);

export const presentCatalogMessage = (
  code: CatalogMessageCode,
  i18n: WorkbenchI18n,
): CatalogMessagePresentation => {
  const template = TEMPLATES[code];
  return {
    title: i18n.t(template.title),
    preservation: i18n.t(template.preservation),
    nextAction: i18n.t(template.nextAction),
  };
};
