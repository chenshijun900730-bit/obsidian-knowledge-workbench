import { describe, expect, it } from "vitest";
import { assertRuntimeCompositionCoherence } from "../../../src/runtime/runtime-composition";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../../src/runtime/safety-policy";

describe("runtime composition", () => {
  it("accepts matching policy and artifact modes", () => {
    expect(() => assertRuntimeCompositionCoherence(
      NORMAL_RUNTIME_POLICY,
      { mode: "normal" },
    )).not.toThrow();
    expect(() => assertRuntimeCompositionCoherence(
      READ_ONLY_ACCEPTANCE_POLICY,
      { mode: "read-only-acceptance" },
    )).not.toThrow();
  });

  it("rejects a policy and artifact mode mismatch immediately", () => {
    expect(() => assertRuntimeCompositionCoherence(
      READ_ONLY_ACCEPTANCE_POLICY,
      { mode: "normal" },
    )).toThrow("Runtime policy and artifact mode do not match");
  });
});
