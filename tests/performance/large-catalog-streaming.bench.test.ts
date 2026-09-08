import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalHybridCatalogAdapter } from "../../src/adapters/local-hybrid-catalog-adapter";
import { UnifiedCatalogProjectionService } from "../../src/catalog/unified-catalog-projection-service";

const PDF_COUNT = 68_959;
let root = "";

afterAll(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

describe("large catalog streaming", () => {
  it("keeps a 68,959-record summary and query page bounded", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kw-streaming-bench-")));
    const adapter = new LocalHybridCatalogAdapter(root);
    let writer = await adapter.createCandidateImport("import-large");
    for (let index = 0; index < PDF_COUNT; index += 1) {
      const groupOrdinal = index % 24;
      const group = groupOrdinal.toString().padStart(2, "0");
      await writer.append({
        schemaVersion: 1,
        source: "txt-candidate",
        candidateId: `txt:${index.toString(16).padStart(64, "0")}`,
        relativePath: `Group-${group}/Book-${index.toString().padStart(5, "0")}.pdf`,
        parentRelativePath: `Group-${group}`,
        filename: `Book-${index.toString().padStart(5, "0")}.pdf`,
        title: `Book-${index.toString().padStart(5, "0")}`,
        isbnCandidates: [],
        topLevelGroupId: `group:${groupOrdinal.toString(16).padStart(64, "0")}`,
        hierarchyTags: [`folder/Group-${group}`],
      });
    }
    await writer.commit({
      importedAt: 1,
      summary: {
        sourceSha256: "a".repeat(64),
        byteSize: 5_000_000,
        nonEmptyLineCount: PDF_COUNT + 24,
        pdfCount: PDF_COUNT,
        directoryCount: 24,
        ignoredLeafCount: 0,
        normalizedWhitespaceCount: 0,
        maxDepth: 2,
      },
    });
    writer = undefined as never;
    await new UnifiedCatalogProjectionService(adapter, { now: () => 2 }).rebuild(null);
    const forceGc = process.getBuiltinModule("vm").runInThisContext(
      "typeof gc === 'function' ? gc : undefined",
    ) as (() => void) | undefined;
    forceGc?.();

    const beforeUsage = process.memoryUsage();
    const before = beforeUsage.rss;
    const startedAt = performance.now();
    const candidates = await adapter.loadActiveCandidateSummary();
    const summarizedAt = performance.now();
    const afterCandidates = process.memoryUsage().rss;
    const candidateHeapMiB = (process.memoryUsage().heapUsed - beforeUsage.heapUsed) / 1_048_576;
    const unified = await adapter.queryActiveUnified({
      text: "",
      includeCloudMissing: false,
      offset: 0,
      limit: 50,
    }, null);
    const finishedAt = performance.now();
    const afterUnifiedUsage = process.memoryUsage();
    const afterUnified = afterUnifiedUsage.rss;

    expect(candidates?.descriptor.pdfCount).toBe(PDF_COUNT);
    expect(candidates?.groups).toHaveLength(24);
    expect(unified?.descriptor.recordCount).toBe(PDF_COUNT);
    expect(unified?.page.items).toHaveLength(50);
    const metrics = {
      candidateMs: Math.round(summarizedAt - startedAt),
      queryMs: Math.round(finishedAt - summarizedAt),
      candidateRssMiB: Math.round((afterCandidates - before) / 1_048_576),
      totalRssMiB: Math.round((afterUnified - before) / 1_048_576),
      candidateHeapMiB: Math.round(candidateHeapMiB),
      totalHeapMiB: Math.round((afterUnifiedUsage.heapUsed - beforeUsage.heapUsed) / 1_048_576),
    };
    expect(metrics.candidateMs).toBeLessThan(5_000);
    expect(metrics.queryMs).toBeLessThan(5_000);
    expect(metrics.totalRssMiB).toBeLessThan(96);
  }, 180_000);
});
