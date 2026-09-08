import { describe, expect, it } from "vitest";
import { decodeLegacyVerificationAdoption } from "../../../src/storage/legacy-verification-adoption";

const sha = (character: string): string => character.repeat(64);
const groupKey = (character: string): string => `group:${sha(character)}`;

const adopted = () => ({
  schemaVersion: 1 as const,
  state: "adopted" as const,
  verificationGeneration: 1,
  sourceImportSha256: sha("a"),
  cloudRootSha256: sha("b"),
  candidate: {
    importId: "candidate-import-1",
    manifestSha256: sha("c"),
    descriptorSha256: sha("d"),
  },
  overlays: [{
    overlayId: "overlay-1",
    groupKey: groupKey("7"),
    descriptorSha256: sha("e"),
  }],
  unified: {
    snapshotId: "unified-1",
    descriptorSha256: sha("f"),
  },
  resumableBatch: {
    batchId: "batch-1",
    checkpointSha256: sha("1"),
    sourceImportSha256: sha("a"),
    cloudRootSha256: sha("b"),
  },
});

const invalid = {
  schemaVersion: 1 as const,
  state: "invalid" as const,
};

describe("legacy verification adoption", () => {
  it("distinguishes a missing legacy field from explicit new-install none", () => {
    expect(decodeLegacyVerificationAdoption(undefined)).toEqual({ schemaVersion: 1, state: "pending" });
    expect(decodeLegacyVerificationAdoption({ schemaVersion: 1, state: "none" }))
      .toEqual({ schemaVersion: 1, state: "none" });
  });

  it.each(["pending", "ineligible", "invalid"] as const)("round-trips the exact %s sentinel", (state) => {
    expect(decodeLegacyVerificationAdoption({ schemaVersion: 1, state }))
      .toEqual({ schemaVersion: 1, state });
  });

  it("round-trips one exact adopted legacy lineage without raw paths or secrets", () => {
    const input = adopted();

    const decoded = decodeLegacyVerificationAdoption(input);
    input.candidate.importId = "mutated";
    input.overlays[0]!.groupKey = "mutated";

    expect(decoded).toEqual(adopted());
    expect(JSON.stringify(decoded)).not.toMatch(/path|account|credential|authorization|secret|response/iu);
  });

  it("accepts an adopted lineage without optional unified or resumable batch artifacts", () => {
    expect(decodeLegacyVerificationAdoption({
      ...adopted(),
      unified: null,
      resumableBatch: null,
    })).toEqual({
      ...adopted(),
      unified: null,
      resumableBatch: null,
    });
  });

  it("accepts the exact legacy root-items group key", () => {
    const input = adopted();
    input.overlays[0]!.groupKey = "txt-root-items";

    expect(decodeLegacyVerificationAdoption(input)).toEqual(input);
  });

  it.each([
    ["null", null],
    ["wrong schema", { ...adopted(), schemaVersion: 2 }],
    ["extra root key", { ...adopted(), rawPath: "/Synthetic/Library" }],
    ["zero generation", { ...adopted(), verificationGeneration: 0 }],
    ["unsafe generation", { ...adopted(), verificationGeneration: Number.MAX_SAFE_INTEGER + 1 }],
    ["uppercase source hash", { ...adopted(), sourceImportSha256: sha("A") }],
    ["scope-mismatched batch source", {
      ...adopted(),
      resumableBatch: { ...adopted().resumableBatch, sourceImportSha256: sha("9") },
    }],
    ["scope-mismatched batch root", {
      ...adopted(),
      resumableBatch: { ...adopted().resumableBatch, cloudRootSha256: sha("9") },
    }],
    ["extra candidate key", {
      ...adopted(),
      candidate: { ...adopted().candidate, path: "/Synthetic/Candidate" },
    }],
    ["extra overlay key", {
      ...adopted(),
      overlays: [{ ...adopted().overlays[0], responseBody: "private" }],
    }],
    ["duplicate overlay fingerprint", {
      ...adopted(),
      overlays: [adopted().overlays[0], adopted().overlays[0]],
    }],
    ["same overlay id with different content", {
      ...adopted(),
      overlays: [
        adopted().overlays[0],
        {
          overlayId: adopted().overlays[0]!.overlayId,
          groupKey: groupKey("8"),
          descriptorSha256: sha("9"),
        },
      ],
    }],
    ["same group key with a different overlay", {
      ...adopted(),
      overlays: [
        adopted().overlays[0],
        {
          overlayId: "overlay-2",
          groupKey: adopted().overlays[0]!.groupKey,
          descriptorSha256: sha("9"),
        },
      ],
    }],
    ["non-canonical group key", {
      ...adopted(),
      overlays: [{ ...adopted().overlays[0], groupKey: "group-1" }],
    }],
    ["uppercase group hash", {
      ...adopted(),
      overlays: [{ ...adopted().overlays[0], groupKey: `group:${sha("A")}` }],
    }],
    ["more than 128 overlay fingerprints", {
      ...adopted(),
      overlays: Array.from({ length: 129 }, (_, index) => ({
        overlayId: `overlay-${index}`,
        groupKey: `group:${index.toString(16).padStart(64, "0")}`,
        descriptorSha256: sha(index % 2 === 0 ? "e" : "f"),
      })),
    }],
    ["extra unified key", {
      ...adopted(),
      unified: { ...adopted().unified, accountId: "private" },
    }],
    ["extra batch key", {
      ...adopted(),
      resumableBatch: { ...adopted().resumableBatch, authorizationCode: "private" },
    }],
    ["extra sentinel key", { schemaVersion: 1, state: "pending", candidate: adopted().candidate }],
  ])("fails a present malformed %s closed to a sticky invalid sentinel", (_, value) => {
    expect(decodeLegacyVerificationAdoption(value)).toEqual(invalid);
  });
});
