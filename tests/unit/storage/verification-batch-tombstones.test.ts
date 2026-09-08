import { describe, expect, it } from "vitest";
import {
  appendSupersededVerificationBatchId,
  decodeVerificationBatchTombstones,
  repairVerificationBatchTombstones,
} from "../../../src/storage/verification-batch-tombstones";

const valid = (...batchIds: string[]) => ({
  schemaVersion: 1 as const,
  state: "valid" as const,
  batchIds,
});

const invalid = {
  schemaVersion: 1 as const,
  state: "invalid" as const,
};

describe("verification batch tombstones", () => {
  it("decodes a missing legacy field as valid-empty and preserves exact valid values", () => {
    expect(decodeVerificationBatchTombstones(undefined)).toEqual(valid());
    expect(decodeVerificationBatchTombstones(valid("batch-1", "batch_2.3")))
      .toEqual(valid("batch-1", "batch_2.3"));
    expect(decodeVerificationBatchTombstones(invalid)).toEqual(invalid);
  });

  it.each([
    ["wrong schema", { schemaVersion: 2, state: "valid", batchIds: [] }],
    ["extra valid-envelope key", { ...valid("batch-1"), extra: true }],
    ["extra invalid-envelope key", { ...invalid, batchIds: [] }],
    ["unknown state", { schemaVersion: 1, state: "unknown", batchIds: [] }],
    ["missing valid list", { schemaVersion: 1, state: "valid" }],
    ["duplicate id", valid("batch-1", "batch-1")],
    ["empty id", valid("")],
    ["non-ASCII id", valid("批次-1")],
    ["path-like id", valid("batch/1")],
    ["oversized id", valid(`b${"a".repeat(128)}`)],
    ["more than sixteen persisted ids", valid(...Array.from({ length: 17 }, (_, index) => `batch-${index}`))],
  ])("fails a present malformed %s closed to the canonical invalid sentinel", (_, value) => {
    expect(decodeVerificationBatchTombstones(value)).toEqual(invalid);
  });

  it("moves an existing trusted id to newest without mutating its input", () => {
    const before = valid("batch-1", "batch-2", "batch-3");

    const after = appendSupersededVerificationBatchId(before, "batch-2");

    expect(after).toEqual(valid("batch-1", "batch-3", "batch-2"));
    expect(before).toEqual(valid("batch-1", "batch-2", "batch-3"));
  });

  it("drops only the oldest id when a trusted seventeenth id is appended", () => {
    const before = valid(...Array.from({ length: 16 }, (_, index) => `batch-${index}`));

    expect(appendSupersededVerificationBatchId(before, "batch-16")).toEqual(
      valid(...Array.from({ length: 16 }, (_, index) => `batch-${index + 1}`)),
    );
  });

  it("never treats append as a repair path for an invalid persisted envelope", () => {
    expect(() => appendSupersededVerificationBatchId(invalid, "batch-current"))
      .toThrow(/invalid|repair/u);
  });

  it("repairs only through the explicit helper and captures the current workflow batch", () => {
    expect(repairVerificationBatchTombstones(invalid, "batch-current"))
      .toEqual(valid("batch-current"));
    expect(repairVerificationBatchTombstones(invalid, null)).toEqual(valid());
    expect(() => repairVerificationBatchTombstones(invalid, "../unsafe"))
      .toThrow(/batch|invalid/u);
  });

  it("uses the same explicit helper to append a workflow batch to an already valid envelope", () => {
    expect(repairVerificationBatchTombstones(valid("batch-old"), "batch-current"))
      .toEqual(valid("batch-old", "batch-current"));
    expect(repairVerificationBatchTombstones(valid("batch-old"), null))
      .toEqual(valid("batch-old"));
  });
});
