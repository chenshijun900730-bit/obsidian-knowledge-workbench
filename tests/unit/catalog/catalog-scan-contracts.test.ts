import { describe, expect, it } from "vitest";
import { SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET } from "../../../src/catalog/catalog-types";

describe("small acceptance catalog scan contracts", () => {
  it("exports one frozen production budget", () => {
    expect(SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET).toEqual({
      maxPdfCount: 1_000,
      maxDirectoryCount: 20,
      maxListRequestCount: 25,
      maxDurationMs: 120_000,
    });
    expect(Object.isFrozen(SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET)).toBe(true);
    expect(Reflect.set(
      SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET as unknown as Record<string, number>,
      "maxPdfCount",
      70_000,
    )).toBe(false);
  });
});
