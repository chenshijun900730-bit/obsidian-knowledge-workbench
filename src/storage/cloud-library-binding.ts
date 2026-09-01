import { normalizeCatalogScanRoot } from "../catalog/catalog-path";
import type { BoundCloudLibraryV1 } from "./plugin-data";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BINDING_KEYS = [
  "schemaVersion",
  "path",
  "sourceImportSha256",
  "verificationGeneration",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
};

export const decodeBoundCloudLibrary = (value: unknown): BoundCloudLibraryV1 | null => {
  if (!isRecord(value) || !hasExactKeys(value, BINDING_KEYS)) return null;
  if (
    value.schemaVersion !== 1
    || typeof value.path !== "string"
    || typeof value.sourceImportSha256 !== "string"
    || !SHA256_PATTERN.test(value.sourceImportSha256)
    || typeof value.verificationGeneration !== "number"
    || !Number.isSafeInteger(value.verificationGeneration)
    || value.verificationGeneration < 1
  ) return null;

  try {
    return {
      schemaVersion: 1,
      path: normalizeCatalogScanRoot(value.path),
      sourceImportSha256: value.sourceImportSha256,
      verificationGeneration: value.verificationGeneration,
    };
  } catch {
    return null;
  }
};
