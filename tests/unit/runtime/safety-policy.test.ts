import { describe, expect, it, vi } from "vitest";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
  effectiveSettings,
  normalOnly,
  policyFor,
} from "../../../src/runtime/safety-policy";
import {
  READ_ONLY_QUICK_CAPTURE_PORT,
  READ_ONLY_VAULT_WRITE_PORT,
} from "../../../src/runtime/read-only-ports";
import { EMPTY_RECENT_CLOUD_DIRECTORIES } from "../../../src/storage/recent-cloud-directories";

describe("runtime safety policy", () => {
  it("exposes exact immutable normal and acceptance capabilities", () => {
    expect(NORMAL_RUNTIME_POLICY).toEqual({
      mode: "normal",
      contentWrites: "allowed",
      quickCapture: "allowed",
      planConfirmation: "allowed",
      history: "full",
      configuration: "mutable",
      ai: "available",
      network: "allowed",
    });
    expect(READ_ONLY_ACCEPTANCE_POLICY).toEqual({
      mode: "read-only-acceptance",
      contentWrites: "blocked",
      quickCapture: "blocked",
      planConfirmation: "blocked",
      history: "aggregate-only",
      configuration: "read-only",
      ai: "blocked",
      network: "blocked",
    });
    expect(Object.isFrozen(NORMAL_RUNTIME_POLICY)).toBe(true);
    expect(Object.isFrozen(READ_ONLY_ACCEPTANCE_POLICY)).toBe(true);
    expect(policyFor("normal")).toBe(NORMAL_RUNTIME_POLICY);
    expect(policyFor("read-only-acceptance")).toBe(READ_ONLY_ACCEPTANCE_POLICY);
    expect(() => policyFor("unexpected" as never)).toThrow("Unsupported runtime mode");
  });

  it("forces persisted write and AI capability off only in acceptance mode", () => {
    const settings = {
      writeEnabled: true,
      writePreviewAcknowledged: true,
      locale: "zh-CN" as const,
      openAtStartup: true,
      folderRules: [{ prefix: "Notes", kind: "note" as const }],
      excludedPrefixes: ["Private"],
      aiEnabled: true,
      aiEndpoint: "https://example.test/v1",
      aiModel: "fixture",
      secretId: "fixture-secret",
      recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
      boundCloudLibrary: null,
      cloudVerificationGeneration: 0,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] } as const,
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" } as const,
    };
    expect(effectiveSettings(NORMAL_RUNTIME_POLICY, settings)).toEqual(settings);
    expect(effectiveSettings(READ_ONLY_ACCEPTANCE_POLICY, settings)).toEqual({
      ...settings,
      writeEnabled: false,
      aiEnabled: false,
    });
  });

  it("never constructs a normal-only dependency in acceptance mode", () => {
    const factory = vi.fn(() => ({ value: 1 }));
    expect(normalOnly(READ_ONLY_ACCEPTANCE_POLICY, factory)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(normalOnly(NORMAL_RUNTIME_POLICY, factory)).toEqual({ value: 1 });
    expect(factory).toHaveBeenCalledOnce();
  });

  it("rejects direct content writes and direct Quick Capture", async () => {
    await expect(READ_ONLY_VAULT_WRITE_PORT.renameFile(
      "A.md",
      "B.md",
      { path: "A.md", exists: true, mtime: 1, contentHash: "a" },
      { path: "B.md", exists: false },
    )).rejects.toThrow("Read-only acceptance mode blocks vault content writes");
    await expect(READ_ONLY_VAULT_WRITE_PORT.setOwnedField(
      "A.md",
      "knowledge-workbench-kind",
      { present: false },
      { present: true, value: "note" },
    )).rejects.toThrow("Read-only acceptance mode blocks vault content writes");
    await expect(READ_ONLY_QUICK_CAPTURE_PORT.capture()).resolves.toBeNull();
  });
});
