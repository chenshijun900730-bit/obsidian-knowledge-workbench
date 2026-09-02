import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCloudVerificationAuthority,
  decodeCloudVerificationScope,
  decodeLegacyVerificationAllowlist,
  deriveCloudVerificationScope,
  type CloudVerificationRootHasher,
} from "../../../src/catalog/cloud-verification-scope";
import { HybridCatalogError } from "../../../src/catalog/hybrid-catalog-types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const SCIENCE_LIBRARY_ROOT_SHA256 =
  "7d5d019db88e67493bc4415a5885bd32fe67d6c716346eba047d79ecca6da029";
const NFC_ROOT_SHA256 =
  "a2ec51c5fe3ba6650e8056e60b1033aeeeb25398a6ebb3d683934b99b84c57cc";
const hashVerificationRoot: CloudVerificationRootHasher = (normalizedRoot) => (
  createHash("sha256").update(normalizedRoot, "utf8").digest("hex")
);

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
    }, hashVerificationRoot)).toEqual({
      generation: 3,
      sourceImportSha256: HASH_A,
      cloudRootSha256: SCIENCE_LIBRARY_ROOT_SHA256,
    });
  });

  it("normalizes the root to NFC before invoking the injected hasher", () => {
    const observedRoots: string[] = [];
    const hasher: CloudVerificationRootHasher = (normalizedRoot) => {
      observedRoots.push(normalizedRoot);
      return hashVerificationRoot(normalizedRoot);
    };

    expect(deriveCloudVerificationScope({
      schemaVersion: 1,
      path: "/Cafe\u0301",
      sourceImportSha256: HASH_A,
      verificationGeneration: 3,
    }, hasher)).toEqual({
      generation: 3,
      sourceImportSha256: HASH_A,
      cloudRootSha256: NFC_ROOT_SHA256,
    });
    expect(observedRoots).toEqual(["/Café"]);
  });

  it("fails closed when hashing is unavailable and never hashes an absent binding", () => {
    let calls = 0;
    const unavailableHasher: CloudVerificationRootHasher = () => {
      calls += 1;
      return null;
    };
    const binding = {
      schemaVersion: 1 as const,
      path: "/科学文库",
      sourceImportSha256: HASH_A,
      verificationGeneration: 3,
    };

    expect(deriveCloudVerificationScope(binding, unavailableHasher)).toBeNull();
    expect(calls).toBe(1);
    expect(deriveCloudVerificationScope(null, unavailableHasher)).toBeNull();
    expect(calls).toBe(1);
  });

  it("rejects an injected digest that is not an exact lowercase SHA-256", () => {
    const binding = {
      schemaVersion: 1 as const,
      path: "/科学文库",
      sourceImportSha256: HASH_A,
      verificationGeneration: 3,
    };

    for (const digest of ["A".repeat(64), "a".repeat(63), "not-a-digest"]) {
      expect(() => deriveCloudVerificationScope(binding, () => digest))
        .toThrow(new HybridCatalogError("hybrid-record-invalid"));
    }
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
      expect(() => deriveCloudVerificationScope(binding as never, hashVerificationRoot)).toThrow();
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
