import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHybridCatalogAdapter } from "../../src/adapters/local-hybrid-catalog-adapter";
import type { BaiduCatalogSourcePort } from "../../src/catalog/catalog-ports";
import { CatalogReconciliationService } from "../../src/catalog/catalog-reconciliation-service";
import type { BaiduListEntry } from "../../src/catalog/catalog-types";
import { LargeCatalogVerificationService } from "../../src/catalog/large-catalog-verification-service";
import { UnifiedCatalogProjectionService } from "../../src/catalog/unified-catalog-projection-service";

const roots: string[] = [];
const SOURCE_HASH = "a".repeat(64);
const GROUP = `group:${"b".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("large catalog verification integration", () => {
  it("publishes a complete category through the local overlay and unified snapshot", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-large-integration-")));
    roots.push(root);
    const adapter = new LocalHybridCatalogAdapter(root);
    const writer = await adapter.createCandidateImport("import-1");
    await writer.append({
      schemaVersion: 1,
      source: "txt-candidate",
      candidateId: `txt:${"c".repeat(64)}`,
      relativePath: "Synthetic/A.pdf",
      parentRelativePath: "Synthetic",
      filename: "A.pdf",
      title: "A",
      isbnCandidates: [],
      topLevelGroupId: GROUP,
      hierarchyTags: ["folder/Synthetic"],
    });
    await writer.commit({
      importedAt: 1,
      summary: {
        sourceSha256: SOURCE_HASH,
        byteSize: 10,
        nonEmptyLineCount: 2,
        pdfCount: 1,
        directoryCount: 1,
        ignoredLeafCount: 0,
        normalizedWhitespaceCount: 0,
        maxDepth: 2,
      },
    });
    await new UnifiedCatalogProjectionService(adapter, { now: () => 1 }).rebuild();
    const requests: Array<Readonly<{ path: string; start: number }>> = [];
    const entry: BaiduListEntry = {
      fsId: "7",
      path: "/Library/Synthetic/A.pdf",
      filename: "A.pdf",
      sizeBytes: 100,
      serverModifiedAt: 20,
      isDirectory: false,
    };
    const source: BaiduCatalogSourcePort = {
      listDirectory: async (input) => {
        await input.beforeRequest();
        requests.push({ path: input.path, start: input.start });
        return { entries: [entry] };
      },
    };
    const service = new LargeCatalogVerificationService({
      source,
      store: adapter,
      reconcile: new CatalogReconciliationService(),
      now: () => 100,
    });

    const result = await service.start({
      batchId: "batch-integration",
      sourceImportSha256: SOURCE_HASH,
      cloudRoot: "/Library",
      groups: [{ groupKey: GROUP, rootRelativePath: "Synthetic", mode: "recursive" }],
    });

    expect(result).toMatchObject({ status: "complete", pdfCount: 1 });
    expect(requests).toEqual([{ path: "/Library/Synthetic", start: 0 }]);
    expect((await adapter.loadActiveOverlays())[0]?.records).toEqual([
      expect.objectContaining({ catalogId: "baidu:7", verificationStatus: "verified" }),
    ]);
    expect((await adapter.loadActiveUnified())?.records).toEqual([
      expect.objectContaining({ catalogId: "baidu:7", verificationStatus: "verified" }),
    ]);
    expect(await adapter.loadBatchReceipt("batch-integration")).toMatchObject({
      status: "complete",
      downloadedPdfBytes: 0,
    });
  });
});
