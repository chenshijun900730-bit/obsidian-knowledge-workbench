import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { CatalogSearchService } from "../../src/catalog/catalog-search-service";
import type { CloudCatalogRecord } from "../../src/catalog/catalog-types";

const subjects = ["统计", "物理", "计算机", "经济", "教育", "生物", "工程", "哲学"] as const;

const records = Array.from({ length: 100_000 }, (_, index): CloudCatalogRecord => {
  const padded = String(index).padStart(6, "0");
  const subject = subjects[index % subjects.length]!;
  const title = index % 2 === 0
    ? `现代因果推断方法 ${padded}`
    : `Causal Inference Handbook ${padded}`;
  const filename = `${title}.pdf`;
  return {
    schemaVersion: 1,
    source: "baidu-netdisk",
    fsId: String(index + 1),
    kind: "file",
    path: `/${subject}/${filename}`,
    parentPath: `/${subject}`,
    filename,
    extension: "pdf",
    title,
    isbnCandidates: index % 1000 === 0 ? [`978${String(index).padStart(10, "0")}`] : [],
    sizeBytes: 1024 + index,
    serverModifiedAt: 1_700_000_000 + index,
  };
});

const percentile95 = (samples: readonly number[]): number => {
  if (samples.length === 0) throw new Error("performance-samples-empty");
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
};

describe("catalog search product performance", () => {
  it("builds and searches 100,000 deterministic records within the product gates", () => {
    const buildStartedAt = performance.now();
    const search = new CatalogSearchService(records);
    const buildElapsedMs = performance.now() - buildStartedAt;
    const queryTimesMs: number[] = [];
    const resultSizes: number[] = [];
    const resultTotals: number[] = [];

    for (let index = 0; index < 50; index += 1) {
      const kind = index % 5;
      const query = kind === 0
        ? { text: "现代因果推断", offset: index, limit: 50 }
        : kind === 1
          ? { text: "causal inference", offset: index, limit: 50 }
          : kind === 2
            ? { text: "", folderPrefix: `/${subjects[index % subjects.length]!}`, offset: index, limit: 50 }
            : kind === 3
              ? { text: `978${String((index % 10) * 1000).padStart(10, "0")}`, offset: 0, limit: 50 }
              : { text: "因", offset: index, limit: 50 };
      const startedAt = performance.now();
      const result = search.query(query);
      queryTimesMs.push(performance.now() - startedAt);
      resultSizes.push(result.items.length);
      resultTotals.push(result.total);
    }

    const report = {
      recordCount: records.length,
      buildElapsedMs,
      queryP95Ms: percentile95(queryTimesMs),
      querySampleCount: queryTimesMs.length,
      maximumResultSize: Math.max(...resultSizes),
      scope: "in-memory deterministic CloudCatalogRecord construction excluded; index build and query only",
    };
    process.stdout.write(`[cloud catalog performance]\n${JSON.stringify(report, null, 2)}\n`);

    expect(buildElapsedMs).toBeLessThanOrEqual(10_000);
    expect(percentile95(queryTimesMs)).toBeLessThanOrEqual(250);
    expect(resultSizes.every((size) => size <= 50)).toBe(true);
    expect(resultTotals.every((total) => total > 0)).toBe(true);
  }, 180_000);
});
