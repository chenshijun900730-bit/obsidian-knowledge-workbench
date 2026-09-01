export interface LegacyCandidateFingerprintV1 {
  readonly importId: string;
  readonly manifestSha256: string;
  readonly descriptorSha256: string;
}

export interface LegacyOverlayFingerprintV1 {
  readonly overlayId: string;
  readonly groupKey: string;
  readonly descriptorSha256: string;
}

export interface LegacyUnifiedFingerprintV1 {
  readonly snapshotId: string;
  readonly descriptorSha256: string;
}

export interface LegacyResumableBatchFingerprintV1 {
  readonly batchId: string;
  readonly checkpointSha256: string;
  readonly sourceImportSha256: string;
  readonly cloudRootSha256: string;
}

export type LegacyVerificationAdoptionV1 =
  | Readonly<{ schemaVersion: 1; state: "none" }>
  | Readonly<{ schemaVersion: 1; state: "pending" }>
  | Readonly<{ schemaVersion: 1; state: "ineligible" }>
  | Readonly<{ schemaVersion: 1; state: "invalid" }>
  | Readonly<{
      schemaVersion: 1;
      state: "adopted";
      verificationGeneration: number;
      sourceImportSha256: string;
      cloudRootSha256: string;
      candidate: LegacyCandidateFingerprintV1;
      overlays: readonly LegacyOverlayFingerprintV1[];
      unified: LegacyUnifiedFingerprintV1 | null;
      resumableBatch: LegacyResumableBatchFingerprintV1 | null;
    }>;

export type MissingLegacyVerificationAdoptionState = "pending" | "invalid";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_GROUP_KEY_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;
const MAX_OVERLAYS = 128;
const SENTINEL_KEYS = ["schemaVersion", "state"] as const;
const ADOPTED_KEYS = [
  "schemaVersion",
  "state",
  "verificationGeneration",
  "sourceImportSha256",
  "cloudRootSha256",
  "candidate",
  "overlays",
  "unified",
  "resumableBatch",
] as const;
const CANDIDATE_KEYS = ["importId", "manifestSha256", "descriptorSha256"] as const;
const OVERLAY_KEYS = ["overlayId", "groupKey", "descriptorSha256"] as const;
const UNIFIED_KEYS = ["snapshotId", "descriptorSha256"] as const;
const BATCH_KEYS = [
  "batchId",
  "checkpointSha256",
  "sourceImportSha256",
  "cloudRootSha256",
] as const;

const invalid = (): LegacyVerificationAdoptionV1 => ({
  schemaVersion: 1,
  state: "invalid",
});

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

const safeLocalId = (value: unknown): string | null => (
  typeof value === "string"
  && value === value.normalize("NFC")
  && SAFE_LOCAL_ID_PATTERN.test(value)
    ? value
    : null
);

const safeGroupKey = (value: unknown): string | null => (
  typeof value === "string"
  && value === value.normalize("NFC")
  && SAFE_GROUP_KEY_PATTERN.test(value)
    ? value
    : null
);

const sha256 = (value: unknown): string | null => (
  typeof value === "string" && SHA256_PATTERN.test(value) ? value : null
);

const decodeCandidate = (value: unknown): LegacyCandidateFingerprintV1 | null => {
  if (!isRecord(value) || !hasExactKeys(value, CANDIDATE_KEYS)) return null;
  const importId = safeLocalId(value.importId);
  const manifestSha256 = sha256(value.manifestSha256);
  const descriptorSha256 = sha256(value.descriptorSha256);
  if (importId === null || manifestSha256 === null || descriptorSha256 === null) return null;
  return { importId, manifestSha256, descriptorSha256 };
};

const decodeOverlay = (value: unknown): LegacyOverlayFingerprintV1 | null => {
  if (!isRecord(value) || !hasExactKeys(value, OVERLAY_KEYS)) return null;
  const overlayId = safeLocalId(value.overlayId);
  const groupKey = safeGroupKey(value.groupKey);
  const descriptorSha256 = sha256(value.descriptorSha256);
  if (overlayId === null || groupKey === null || descriptorSha256 === null) return null;
  return { overlayId, groupKey, descriptorSha256 };
};

const decodeUnified = (value: unknown): LegacyUnifiedFingerprintV1 | null => {
  if (!isRecord(value) || !hasExactKeys(value, UNIFIED_KEYS)) return null;
  const snapshotId = safeLocalId(value.snapshotId);
  const descriptorSha256 = sha256(value.descriptorSha256);
  if (snapshotId === null || descriptorSha256 === null) return null;
  return { snapshotId, descriptorSha256 };
};

const decodeBatch = (value: unknown): LegacyResumableBatchFingerprintV1 | null => {
  if (!isRecord(value) || !hasExactKeys(value, BATCH_KEYS)) return null;
  const batchId = safeLocalId(value.batchId);
  const checkpointSha256 = sha256(value.checkpointSha256);
  const sourceImportSha256 = sha256(value.sourceImportSha256);
  const cloudRootSha256 = sha256(value.cloudRootSha256);
  if (
    batchId === null
    || checkpointSha256 === null
    || sourceImportSha256 === null
    || cloudRootSha256 === null
  ) return null;
  return { batchId, checkpointSha256, sourceImportSha256, cloudRootSha256 };
};

export const decodeLegacyVerificationAdoption = (
  value: unknown,
  missingState: MissingLegacyVerificationAdoptionState = "pending",
): LegacyVerificationAdoptionV1 => {
  if (value === undefined) return { schemaVersion: 1, state: missingState };
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.state !== "string") {
    return invalid();
  }
  if (value.state !== "adopted") {
    if (
      !hasExactKeys(value, SENTINEL_KEYS)
      || !["none", "pending", "ineligible", "invalid"].includes(value.state)
    ) return invalid();
    return {
      schemaVersion: 1,
      state: value.state as "none" | "pending" | "ineligible" | "invalid",
    };
  }
  if (
    !hasExactKeys(value, ADOPTED_KEYS)
    || typeof value.verificationGeneration !== "number"
    || !Number.isSafeInteger(value.verificationGeneration)
    || value.verificationGeneration < 1
    || !Array.isArray(value.overlays)
    || value.overlays.length > MAX_OVERLAYS
  ) return invalid();

  const sourceImportSha256 = sha256(value.sourceImportSha256);
  const cloudRootSha256 = sha256(value.cloudRootSha256);
  const candidate = decodeCandidate(value.candidate);
  const overlays = value.overlays.map(decodeOverlay);
  const unified = value.unified === null ? null : decodeUnified(value.unified);
  const resumableBatch = value.resumableBatch === null ? null : decodeBatch(value.resumableBatch);
  if (
    sourceImportSha256 === null
    || cloudRootSha256 === null
    || candidate === null
    || overlays.some((overlay) => overlay === null)
    || (value.unified !== null && unified === null)
    || (value.resumableBatch !== null && resumableBatch === null)
  ) return invalid();

  const decodedOverlays = overlays as LegacyOverlayFingerprintV1[];
  const overlayIds = decodedOverlays.map((overlay) => overlay.overlayId);
  const groupKeys = decodedOverlays.map((overlay) => overlay.groupKey);
  if (
    new Set(overlayIds).size !== overlayIds.length
    || new Set(groupKeys).size !== groupKeys.length
  ) return invalid();
  if (
    resumableBatch !== null
    && (
      resumableBatch.sourceImportSha256 !== sourceImportSha256
      || resumableBatch.cloudRootSha256 !== cloudRootSha256
    )
  ) return invalid();

  return {
    schemaVersion: 1,
    state: "adopted",
    verificationGeneration: value.verificationGeneration,
    sourceImportSha256,
    cloudRootSha256,
    candidate,
    overlays: decodedOverlays,
    unified,
    resumableBatch,
  };
};
