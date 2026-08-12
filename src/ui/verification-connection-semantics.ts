import type { CloudCatalogConnectionViewModel } from "../catalog/cloud-catalog-runtime";
import type { CatalogErrorCode } from "../catalog/catalog-types";

const AUTHORIZED_CONNECTION_STATES = new Set<CloudCatalogConnectionViewModel["status"]>([
  "authorized",
  "scanning",
  "paused",
  "partial",
]);

export const connectionCanVerify = (
  connection: CloudCatalogConnectionViewModel | undefined,
): boolean => connection !== undefined && AUTHORIZED_CONNECTION_STATES.has(connection.status);

type VerificationCapability =
  | "missing"
  | "unconfigured"
  | "configured"
  | "authorizing"
  | "authorized-capable";

type VerificationFault = CatalogErrorCode | "catalog-unavailable" | "none";

export type VerificationConnectionSemanticKey = `${VerificationCapability}:${VerificationFault}`;

export const verificationConnectionSemanticKey = (
  connection: CloudCatalogConnectionViewModel | undefined,
): VerificationConnectionSemanticKey => {
  if (connection === undefined) return "missing:none";
  const capability: VerificationCapability = connection.status === "unconfigured"
    || connection.status === "configured"
    || connection.status === "authorizing"
    ? connection.status
    : "authorized-capable";
  return `${capability}:${connection.messageCode ?? "none"}`;
};
