import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { UnifiedCatalogSearchService } from "../../src/catalog/unified-catalog-search-service";
import type { UnifiedCatalogRecordV1 } from "../../src/catalog/hybrid-catalog-types";

const GROUPS = Array.from({ length: 8 }, (_, index) => `group:${index.toString(16).padStart(64, "0")}`);

const records = Array.from({ length: 70_000 }, (_, index): UnifiedCatalogRecordV1 => {
  const padded = String(index).padStart(5, "0");
  const groupIndex = index % GROUPS.length;
  const folder = `Synthetic-${groupIndex}`;
  const filename = index % 2 === 0 ? `因果方法 ${padded}.pdf` : `Causal Guide ${padded}.pdf`;
  return {
    schemaVersion: 1,
    catalogId: `txt:${index.toString(16).padStart(64, "0")}`,
    candidateId: `txt:${index.toString(16).padStart(64, "0")}`,
    fsId: null,
    relativePath: `${folder}/${filename}`,
    cloudPath: null,
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: index % 1000 === 0 ? [`978${String(index).padStart(10, "0")}`] : [],
    sizeBytes: null,
    serverModifiedAt: null,
    topLevelGroupId: GROUPS[groupIndex]!,
    hierarchyTags: [`folder/${folder}`],
    verificationStatus: "unverified",
    differenceKinds: [],
    visibleByDefault: true,
  };
});

const percentile95 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
};

describe("hybrid catalog search product performance", () => {
  it("builds and searches 70,000 deterministic records within product gates", () => {
    const startedAt = performance.now();
    const search = new UnifiedCatalogSearchService(records);
    const buildElapsedMs = performance.now() - startedAt;
    const samples: number[] = [];
    const totals: number[] = [];
    const returnedCounts: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const queryStartedAt = performance.now();
      const result = search.query({
        text: index % 2 === 0 ? "因果方法" : "causal guide",
        ...(index % 5 === 0 ? { topLevelGroupId: GROUPS[index % GROUPS.length]! } : {}),
        offset: index,
        limit: 50,
      });
      samples.push(performance.now() - queryStartedAt);
      totals.push(result.total);
      returnedCounts.push(result.items.length);
    }
    const report = {
      recordCount: records.length,
      buildElapsedMs,
      queryP95Ms: percentile95(samples),
      querySampleCount: samples.length,
      maxReturnedItems: Math.max(...returnedCounts),
    };
    process.stdout.write(`[hybrid catalog performance]\n${JSON.stringify(report, null, 2)}\n`);
    expect(buildElapsedMs).toBeLessThanOrEqual(10_000);
    expect(percentile95(samples)).toBeLessThanOrEqual(250);
    expect(Math.max(...returnedCounts)).toBeLessThanOrEqual(50);
    expect(totals.every((total) => total > 0)).toBe(true);
  }, 180_000);
});
