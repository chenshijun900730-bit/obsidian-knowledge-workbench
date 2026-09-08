import { describe, expect, it } from "vitest";
import { decodeBoundCloudLibrary } from "../../../src/storage/cloud-library-binding";

describe("cloud library binding", () => {
  it("accepts only a normalized non-root path bound to one TXT source and positive generation", () => {
    expect(decodeBoundCloudLibrary({
      schemaVersion: 1,
      path: "/Ke\u0301xue",
      sourceImportSha256: "a".repeat(64),
      verificationGeneration: 3,
    })).toEqual({
      schemaVersion: 1,
      path: "/K\u00e9xue",
      sourceImportSha256: "a".repeat(64),
      verificationGeneration: 3,
    });

    for (const value of [
      undefined,
      null,
      "/科学文库",
      { schemaVersion: 1, path: "/", sourceImportSha256: "a".repeat(64), verificationGeneration: 1 },
      { schemaVersion: 1, path: "/A", sourceImportSha256: "A".repeat(64), verificationGeneration: 1 },
      { schemaVersion: 1, path: "/A", sourceImportSha256: "a".repeat(64), verificationGeneration: 0 },
      { schemaVersion: 1, path: "/A", sourceImportSha256: "a".repeat(64), verificationGeneration: 1.5 },
      {
        schemaVersion: 1,
        path: "/A",
        sourceImportSha256: "a".repeat(64),
        verificationGeneration: Number.MAX_SAFE_INTEGER + 1,
      },
      { schemaVersion: 1, path: "/A//B", sourceImportSha256: "a".repeat(64), verificationGeneration: 1 },
      { schemaVersion: 2, path: "/A", sourceImportSha256: "a".repeat(64), verificationGeneration: 1 },
    ]) expect(decodeBoundCloudLibrary(value)).toBeNull();
  });

  it("returns a detached value instead of retaining caller-owned data", () => {
    const input = {
      schemaVersion: 1,
      path: "/Synthetic/Library",
      sourceImportSha256: "b".repeat(64),
      verificationGeneration: 1,
    };

    const decoded = decodeBoundCloudLibrary(input);
    input.path = "/mutated";

    expect(decoded).toEqual({
      schemaVersion: 1,
      path: "/Synthetic/Library",
      sourceImportSha256: "b".repeat(64),
      verificationGeneration: 1,
    });
  });
});
