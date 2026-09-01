import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCloudVerificationAuthority,
  decodeCloudVerificationScope,
  decodeLegacyVerificationAllowlist,
  deriveCloudVerificationScope,
} from "../../../src/catalog/cloud-verification-scope";
import { HybridCatalogError } from "../../../src/catalog/hybrid-catalog-types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const allowlist = () => ({
  candidate: {
    importId: "import-1",
    manifestSha256: HASH_A,
    descriptorSha256: HASH_B,
  },
  overlays: [{
    overlayId: "overlay-1",
    groupKey: `group:${HASH_C}`,
    descriptorSha256: HASH_D,
  }],
  unified: {
    snapshotId: "unified-1",
    descriptorSha256: HASH_A,
  },
  resumableBatch: {
    batchId: "batch-1",
    checkpointSha256: HASH_B,
    sourceImportSha256: HASH_A,
    cloudRootSha256: HASH_C,
  },
});

describe("cloud verification authority contracts", () => {
  it("derives a normalized non-root scope and hashes only that normalized root", () => {
    expect(deriveCloudVerificationScope({
      schemaVersion: 1,
      path: "/科学文库",
      sourceImportSha256: HASH_A,
      verificationGeneration: 3,
    })).toEqual({
      generation: 3,
      sourceImportSha256: HASH_A,
      cloudRootSha256: createHash("sha256").update("/科学文库", "utf8").digest("hex"),
    });
    expect(deriveCloudVerificationScope(null)).toBeNull();
  });

  it("rejects zero generation, malformed source identity, and a root binding", () => {
    for (const binding of [
      {
        schemaVersion: 1,
        path: "/科学文库",
        sourceImportSha256: HASH_A,
        verificationGeneration: 0,
      },
      {
        schemaVersion: 1,
        path: "/科学文库",
        sourceImportSha256: "A".repeat(64),
        verificationGeneration: 1,
      },
      {
        schemaVersion: 1,
        path: "/",
        sourceImportSha256: HASH_A,
        verificationGeneration: 1,
      },
    ]) {
      expect(() => deriveCloudVerificationScope(binding as never)).toThrow();
    }
  });

  it("strictly decodes detached scope and allowlist values", () => {
    const scope = { generation: 2, sourceImportSha256: HASH_A, cloudRootSha256: HASH_C };
    expect(decodeCloudVerificationScope(scope)).toEqual(scope);

    const raw = allowlist();
    const first = decodeLegacyVerificationAllowlist(raw);
    const mutableFirst = first as unknown as { overlays: Array<{ overlayId: string }> };
    mutableFirst.overlays[0]!.overlayId = "changed";
    expect(decodeLegacyVerificationAllowlist(raw)).toEqual(allowlist());

    for (const invalid of [
      { ...scope, generation: 0 },
      { ...scope, extra: true },
      { ...scope, cloudRootSha256: "not-a-hash" },
    ]) {
      expect(() => decodeCloudVerificationScope(invalid))
        .toThrow(new HybridCatalogError("hybrid-record-invalid"));
    }
    for (const invalid of [
      { ...allowlist(), extra: true },
      { ...allowlist(), candidate: { ...allowlist().candidate, importId: ".hidden" } },
      {
        ...allowlist(),
        overlays: [allowlist().overlays[0], { ...allowlist().overlays[0] }],
      },
    ]) {
      expect(() => decodeLegacyVerificationAllowlist(invalid))
        .toThrow(new HybridCatalogError("hybrid-record-invalid"));
    }
  });

  it("freezes the two exact authority variants and validates scoped batch lineage", () => {
    const localOnly = {
      kind: "legacy-local-only",
      sourceImportSha256: HASH_A,
      activeManifestSha256: HASH_B,
    } as const;
    expect(decodeCloudVerificationAuthority(localOnly)).toEqual(localOnly);

    const scoped = {
      kind: "scoped",
      scope: { generation: 2, sourceImportSha256: HASH_A, cloudRootSha256: HASH_C },
      legacyAllowlist: allowlist(),
    } as const;
    expect(decodeCloudVerificationAuthority(scoped)).toEqual(scoped);
    expect(decodeCloudVerificationAuthority({ ...scoped, legacyAllowlist: null }))
      .toEqual({ ...scoped, legacyAllowlist: null });

    for (const invalid of [
      { ...localOnly, extra: true },
      { ...scoped, scope: { ...scoped.scope, generation: 0 } },
      {
        ...scoped,
        legacyAllowlist: {
          ...allowlist(),
          resumableBatch: { ...allowlist().resumableBatch, cloudRootSha256: HASH_D },
        },
      },
    ]) {
      expect(() => decodeCloudVerificationAuthority(invalid))
        .toThrow(new HybridCatalogError("hybrid-record-invalid"));
    }
  });
});
