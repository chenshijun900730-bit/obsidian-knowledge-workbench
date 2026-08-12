import { describe, expect, it } from "vitest";
import { isStrictBoundedSemver } from "../../../src/runtime/strict-semver.mjs";

describe("strict bounded semantic-version contract", () => {
  it.each([
    "0.0.0",
    "0.1.0",
    "999.999.999",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3-0",
    "1.2.3-alpha-beta",
  ])("accepts %s", (version) => {
    expect(isStrictBoundedSemver(version)).toBe(true);
  });

  it.each([
    "",
    "1",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1000.0.0",
    "1.0.0-",
    "1.0.0-alpha.",
    "1.0.0-alpha..1",
    "1.0.0-01",
    "1.0.0+build",
    `1.0.0-${"a".repeat(33)}`,
  ])("rejects %s", (version) => {
    expect(isStrictBoundedSemver(version)).toBe(false);
  });
});
