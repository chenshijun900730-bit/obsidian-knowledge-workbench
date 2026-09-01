import { createHash } from "node:crypto";
import type { BoundCloudLibraryV1 } from "../storage/plugin-data";
import { normalizeCatalogScanRoot } from "./catalog-path";
import { HybridCatalogError } from "./hybrid-catalog-types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_GROUP_KEY_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;
const MAX_LEGACY_OVERLAYS = 128;

export interface CloudVerificationScope {
  readonly generation: number;
  readonly sourceImportSha256: string;
  readonly cloudRootSha256: string;
}

export interface LegacyVerificationAllowlist {
  readonly candidate: Readonly<{
    importId: string;
    manifestSha256: string;
    descriptorSha256: string;
  }>;
  readonly overlays: readonly Readonly<{
    overlayId: string;
    groupKey: string;
    descriptorSha256: string;
  }>[];
  readonly unified: Readonly<{
    snapshotId: string;
    descriptorSha256: string;
  }> | null;
  readonly resumableBatch: Readonly<{
    batchId: string;
    checkpointSha256: string;
    sourceImportSha256: string;
    cloudRootSha256: string;
  }> | null;
}

export type CloudVerificationAuthority =
  | Readonly<{
      kind: "legacy-local-only";
      sourceImportSha256: string;
      activeManifestSha256: string;
    }>
  | Readonly<{
      kind: "scoped";
      scope: CloudVerificationScope;
      legacyAllowlist: LegacyVerificationAllowlist | null;
    }>;

const invalid = (): never => {
  throw new HybridCatalogError("hybrid-record-invalid");
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    invalid();
  }
};

const sha256 = (value: unknown): string => (
  typeof value === "string" && SHA256_PATTERN.test(value) ? value : invalid()
);

const localId = (value: unknown): string => (
  typeof value === "string"
  && value === value.normalize("NFC")
  && SAFE_LOCAL_ID_PATTERN.test(value)
    ? value
    : invalid()
);

const groupKey = (value: unknown): string => (
  typeof value === "string"
  && value === value.normalize("NFC")
  && SAFE_GROUP_KEY_PATTERN.test(value)
    ? value
    : invalid()
);

export const decodeCloudVerificationScope = (value: unknown): CloudVerificationScope => {
  if (!isRecord(value)) return invalid();
  exactKeys(value, ["generation", "sourceImportSha256", "cloudRootSha256"]);
  if (
    typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
  ) return invalid();
  return {
    generation: value.generation,
    sourceImportSha256: sha256(value.sourceImportSha256),
    cloudRootSha256: sha256(value.cloudRootSha256),
  };
};

export const decodeLegacyVerificationAllowlist = (
  value: unknown,
): LegacyVerificationAllowlist => {
  if (!isRecord(value)) return invalid();
  exactKeys(value, ["candidate", "overlays", "unified", "resumableBatch"]);
  if (!isRecord(value.candidate)) return invalid();
  exactKeys(value.candidate, ["importId", "manifestSha256", "descriptorSha256"]);
  const candidate = {
    importId: localId(value.candidate.importId),
    manifestSha256: sha256(value.candidate.manifestSha256),
    descriptorSha256: sha256(value.candidate.descriptorSha256),
  };

  if (!Array.isArray(value.overlays) || value.overlays.length > MAX_LEGACY_OVERLAYS) {
    return invalid();
  }
  const overlays = value.overlays.map((item) => {
    if (!isRecord(item)) return invalid();
    exactKeys(item, ["overlayId", "groupKey", "descriptorSha256"]);
    return {
      overlayId: localId(item.overlayId),
      groupKey: groupKey(item.groupKey),
      descriptorSha256: sha256(item.descriptorSha256),
    };
  });
  if (
    new Set(overlays.map((item) => item.overlayId)).size !== overlays.length
    || new Set(overlays.map((item) => item.groupKey)).size !== overlays.length
  ) return invalid();

  let unified: LegacyVerificationAllowlist["unified"] = null;
  if (value.unified !== null) {
    if (!isRecord(value.unified)) return invalid();
    exactKeys(value.unified, ["snapshotId", "descriptorSha256"]);
    unified = {
      snapshotId: localId(value.unified.snapshotId),
      descriptorSha256: sha256(value.unified.descriptorSha256),
    };
  }

  let resumableBatch: LegacyVerificationAllowlist["resumableBatch"] = null;
  if (value.resumableBatch !== null) {
    if (!isRecord(value.resumableBatch)) return invalid();
    exactKeys(value.resumableBatch, [
      "batchId",
      "checkpointSha256",
      "sourceImportSha256",
      "cloudRootSha256",
    ]);
    resumableBatch = {
      batchId: localId(value.resumableBatch.batchId),
      checkpointSha256: sha256(value.resumableBatch.checkpointSha256),
      sourceImportSha256: sha256(value.resumableBatch.sourceImportSha256),
      cloudRootSha256: sha256(value.resumableBatch.cloudRootSha256),
    };
  }

  return { candidate, overlays, unified, resumableBatch };
};

export const decodeCloudVerificationAuthority = (
  value: unknown,
): CloudVerificationAuthority => {
  if (!isRecord(value)) return invalid();
  if (value.kind === "legacy-local-only") {
    exactKeys(value, ["kind", "sourceImportSha256", "activeManifestSha256"]);
    return {
      kind: "legacy-local-only",
      sourceImportSha256: sha256(value.sourceImportSha256),
      activeManifestSha256: sha256(value.activeManifestSha256),
    };
  }
  if (value.kind !== "scoped") return invalid();
  exactKeys(value, ["kind", "scope", "legacyAllowlist"]);
  const scope = decodeCloudVerificationScope(value.scope);
  const legacyAllowlist = value.legacyAllowlist === null
    ? null
    : decodeLegacyVerificationAllowlist(value.legacyAllowlist);
  const resumableBatch = legacyAllowlist?.resumableBatch ?? null;
  if (
    resumableBatch !== null
    && (
      resumableBatch.sourceImportSha256 !== scope.sourceImportSha256
      || resumableBatch.cloudRootSha256 !== scope.cloudRootSha256
    )
  ) return invalid();
  return { kind: "scoped", scope, legacyAllowlist };
};

export const deriveCloudVerificationScope = (
  binding: BoundCloudLibraryV1 | null,
): CloudVerificationScope | null => {
  if (binding === null) return null;
  if (
    binding.schemaVersion !== 1
    || !Number.isSafeInteger(binding.verificationGeneration)
    || binding.verificationGeneration < 1
    || !SHA256_PATTERN.test(binding.sourceImportSha256)
  ) return invalid();
  const root = normalizeCatalogScanRoot(binding.path);
  return {
    generation: binding.verificationGeneration,
    sourceImportSha256: binding.sourceImportSha256,
    cloudRootSha256: createHash("sha256").update(root, "utf8").digest("hex"),
  };
};

export const cloudVerificationScopesEqual = (
  left: CloudVerificationScope | null,
  right: CloudVerificationScope | null,
): boolean => (
  left === null || right === null
    ? left === right
    : left.generation === right.generation
      && left.sourceImportSha256 === right.sourceImportSha256
      && left.cloudRootSha256 === right.cloudRootSha256
);
