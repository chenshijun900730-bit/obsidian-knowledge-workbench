import { describe, expect, it } from "vitest";
import { CatalogTxtImportService } from "../../../src/catalog/catalog-txt-import-service";
import { CatalogTxtParser, type CatalogTxtByteSource } from "../../../src/catalog/catalog-txt-parser";
import type {
  CandidateImportWriter,
  CandidateCatalogStorePort,
} from "../../../src/catalog/hybrid-catalog-ports";
import {
  HybridCatalogError,
  type CandidateCatalogDescriptor,
  type CatalogTxtImportSummary,
  type TxtCandidateRecordV1,
} from "../../../src/catalog/hybrid-catalog-types";

const source = (value: string): CatalogTxtByteSource => ({
  byteSize: new TextEncoder().encode(value).byteLength,
  chunks: async function* () { yield new TextEncoder().encode(value); },
});

class MemoryHybridCatalogStore implements CandidateCatalogStorePort {
  readonly imports: string[] = [];
  readonly aborted: string[] = [];
  readonly records = new Map<string, TxtCandidateRecordV1[]>();
  active: Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null = null;
  failAppend = false;
  abortAfterAppend: AbortController | null = null;

  async createCandidateImport(importId: string): Promise<CandidateImportWriter> {
    this.imports.push(importId);
    const records: TxtCandidateRecordV1[] = [];
    this.records.set(importId, records);
    let descriptor: CandidateCatalogDescriptor | undefined;
    return {
      append: async (record) => {
        if (this.failAppend) throw new HybridCatalogError("hybrid-snapshot-corrupt");
        records.push(record);
        this.abortAfterAppend?.abort();
      },
      commit: async ({ summary, importedAt }) => {
        descriptor ??= {
          schemaVersion: 1,
          importId,
          importedAt,
          ...summary,
          candidateSha256: "b".repeat(64),
        };
        this.active = { descriptor, records: records.map((record) => ({
          ...record,
          isbnCandidates: [...record.isbnCandidates],
          hierarchyTags: [...record.hierarchyTags],
        })) };
        return descriptor;
      },
      abort: async () => { this.aborted.push(importId); },
    };
  }

  async loadActiveCandidates(): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null> {
    return this.active;
  }

  async loadActiveCandidateDescriptor(): Promise<CandidateCatalogDescriptor | null> {
    return this.active?.descriptor ?? null;
  }

  async loadActiveCandidateSummary() {
    if (this.active === null) return null;
    const groups = new Map<string, { label: string; rootRelativePath: string; pdfCount: number }>();
    for (const record of this.active.records) {
      const rootRelativePath = record.topLevelGroupId === "txt-root-items"
        ? ""
        : record.relativePath.split("/")[0] ?? "";
      const prior = groups.get(record.topLevelGroupId);
      groups.set(record.topLevelGroupId, {
        label: prior?.label ?? (rootRelativePath || "Root items"),
        rootRelativePath,
        pdfCount: (prior?.pdfCount ?? 0) + 1,
      });
    }
    return {
      descriptor: this.active.descriptor,
      groups: [...groups].map(([groupKey, value]) => ({
        groupKey,
        ...value,
        mode: groupKey === "txt-root-items" ? "direct-files-only" as const : "recursive" as const,
      })),
    };
  }

  async loadActiveCandidateGroups(groupKeys: readonly string[]): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null> {
    if (this.active === null) return null;
    const selected = new Set(groupKeys);
    return {
      descriptor: this.active.descriptor,
      records: this.active.records.filter((record) => selected.has(record.topLevelGroupId)),
    };
  }
}

describe("CatalogTxtImportService", () => {
  it("previews without writes and commits one complete candidate base", async () => {
    const store = new MemoryHybridCatalogStore();
    const service = new CatalogTxtImportService(new CatalogTxtParser(), store, {
      createImportId: () => "import-1",
      now: () => 100,
    });
    const input = source("├── Synthetic\n│   └── A.pdf\n");

    await expect(service.preview(input)).resolves.toMatchObject({
      pdfCount: 1,
      directoryCount: 1,
    });
    expect(store.imports).toEqual([]);

    const descriptor = await service.import(input);
    expect(descriptor).toMatchObject({ importId: "import-1", importedAt: 100, pdfCount: 1 });
    expect((await store.loadActiveCandidates())?.records).toHaveLength(1);
    expect(store.aborted).toEqual([]);
  });

  it("aborts staging when parsing or appending fails", async () => {
    const store = new MemoryHybridCatalogStore();
    const service = new CatalogTxtImportService(new CatalogTxtParser(), store, {
      createImportId: () => `import-${store.imports.length + 1}`,
      now: () => 100,
    });

    await expect(service.import(source("not-a-tree\n"))).rejects.toEqual(
      new HybridCatalogError("txt-tree-invalid"),
    );
    store.failAppend = true;
    await expect(service.import(source("├── A.pdf\n"))).rejects.toEqual(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
    expect(store.aborted).toEqual(["import-1", "import-2"]);
  });

  it("aborts staging when the owning runtime cancels an in-flight import", async () => {
    const store = new MemoryHybridCatalogStore();
    const controller = new AbortController();
    store.abortAfterAppend = controller;
    const service = new CatalogTxtImportService(new CatalogTxtParser(), store, {
      createImportId: () => "import-canceled",
      now: () => 100,
    });

    await expect(service.import(source("├── A.pdf\n"), controller.signal))
      .rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));

    expect(store.aborted).toEqual(["import-canceled"]);
    expect(store.active).toBeNull();
  });

  it("uses one fresh timestamp after parsing and returns detached aggregate values", async () => {
    const store = new MemoryHybridCatalogStore();
    let nowCalls = 0;
    const service = new CatalogTxtImportService(new CatalogTxtParser(), store, {
      createImportId: () => "import-1",
      now: () => { nowCalls += 1; return 200; },
    });
    const descriptor = await service.import(source("├── A.pdf\n"));

    expect(nowCalls).toBe(1);
    expect(descriptor).toMatchObject<CandidateCatalogDescriptor>({
      schemaVersion: 1,
      importId: "import-1",
      importedAt: 200,
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
      byteSize: 16,
      nonEmptyLineCount: 1,
      pdfCount: 1,
      directoryCount: 0,
      ignoredLeafCount: 0,
      normalizedWhitespaceCount: 0,
      maxDepth: 1,
      candidateSha256: "b".repeat(64),
    });
  });

  it("does not call the clock or store during preview", async () => {
    const store = new MemoryHybridCatalogStore();
    let nowCalls = 0;
    const service = new CatalogTxtImportService(new CatalogTxtParser(), store, {
      createImportId: () => "import-never",
      now: () => { nowCalls += 1; return 1; },
    });
    const summary: CatalogTxtImportSummary = await service.preview(source("├── A.pdf\n"));
    expect(summary.pdfCount).toBe(1);
    expect(nowCalls).toBe(0);
    expect(store.imports).toEqual([]);
  });
});
