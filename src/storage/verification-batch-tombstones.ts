export type VerificationBatchTombstonesV1 =
  | Readonly<{
      schemaVersion: 1;
      state: "valid";
      batchIds: readonly string[];
    }>
  | Readonly<{
      schemaVersion: 1;
      state: "invalid";
    }>;

const MAX_BATCH_IDS = 16;
const SAFE_BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VALID_KEYS = ["schemaVersion", "state", "batchIds"] as const;

const invalid = (): VerificationBatchTombstonesV1 => ({
  schemaVersion: 1,
  state: "invalid",
});

const valid = (batchIds: readonly string[]): VerificationBatchTombstonesV1 => ({
  schemaVersion: 1,
  state: "valid",
  batchIds: [...batchIds],
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

const isSafeBatchId = (value: unknown): value is string => (
  typeof value === "string"
  && value === value.normalize("NFC")
  && SAFE_BATCH_ID_PATTERN.test(value)
);

export const decodeVerificationBatchTombstones = (
  value: unknown,
): VerificationBatchTombstonesV1 => {
  if (value === undefined) return valid([]);
  if (!isRecord(value) || value.schemaVersion !== 1) return invalid();

  if (value.state === "invalid") {
    return invalid();
  }
  if (value.state !== "valid" || !hasExactKeys(value, VALID_KEYS)) return invalid();
  if (
    !Array.isArray(value.batchIds)
    || value.batchIds.length > MAX_BATCH_IDS
    || !value.batchIds.every(isSafeBatchId)
    || new Set(value.batchIds).size !== value.batchIds.length
  ) return invalid();
  return valid(value.batchIds);
};

const assertSafeBatchId = (batchId: string): void => {
  if (!isSafeBatchId(batchId)) throw new Error("Batch id is invalid");
};

export const appendSupersededVerificationBatchId = (
  tombstones: VerificationBatchTombstonesV1,
  batchId: string,
): VerificationBatchTombstonesV1 => {
  if (tombstones.state === "invalid") {
    throw new Error("Invalid tombstones require explicit repair");
  }
  assertSafeBatchId(batchId);
  const withoutExisting = tombstones.batchIds.filter((candidate) => candidate !== batchId);
  return valid([...withoutExisting, batchId].slice(-MAX_BATCH_IDS));
};

export const repairVerificationBatchTombstones = (
  tombstones: VerificationBatchTombstonesV1,
  currentWorkflowBatchId: string | null,
): VerificationBatchTombstonesV1 => {
  if (currentWorkflowBatchId === null) {
    return tombstones.state === "invalid" ? valid([]) : valid(tombstones.batchIds);
  }
  assertSafeBatchId(currentWorkflowBatchId);
  return tombstones.state === "invalid"
    ? valid([currentWorkflowBatchId])
    : appendSupersededVerificationBatchId(tombstones, currentWorkflowBatchId);
};
