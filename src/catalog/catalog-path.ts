import { CatalogError } from "./catalog-types";

export const normalizeCloudAbsolutePath = (value: string): string => {
  if (!value.startsWith("/") || value.includes("\\") || /\p{Cc}/u.test(value)) {
    throw new CatalogError("invalid-scan-root");
  }
  const normalized = value.normalize("NFC");
  const segments = normalized.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    if (normalized !== "/") throw new CatalogError("invalid-scan-root");
  }
  return normalized;
};

export const normalizeCatalogScanRoot = (value: string): string => {
  const normalized = normalizeCloudAbsolutePath(value);
  if (normalized === "/") throw new CatalogError("invalid-scan-root");
  return normalized;
};
