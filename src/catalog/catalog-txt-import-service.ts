import type { CatalogTxtByteSource, CatalogTxtParser } from "./catalog-txt-parser";
import type { CandidateCatalogStorePort, CandidateImportWriter } from "./hybrid-catalog-ports";
import {
  HybridCatalogError,
  type CandidateCatalogDescriptor,
  type CatalogTxtImportSummary,
} from "./hybrid-catalog-types";

export interface CatalogTxtImportServiceOptions {
  readonly createImportId: () => string;
  readonly now: () => number;
}

export class CatalogTxtImportService {
  constructor(
    private readonly parser: CatalogTxtParser,
    private readonly store: CandidateCatalogStorePort,
    private readonly options: CatalogTxtImportServiceOptions,
  ) {}

  async preview(source: CatalogTxtByteSource): Promise<CatalogTxtImportSummary> {
    const summary = await this.parser.parse({
      source,
      onCandidate: async () => undefined,
    });
    return { ...summary };
  }

  async import(
    source: CatalogTxtByteSource,
    signal?: AbortSignal,
  ): Promise<CandidateCatalogDescriptor> {
    const assertNotAborted = (): void => {
      if (signal?.aborted === true) throw new HybridCatalogError("hybrid-snapshot-corrupt");
    };
    assertNotAborted();
    let importId: string;
    try {
      importId = this.options.createImportId();
    } catch {
      throw new HybridCatalogError("hybrid-snapshot-corrupt");
    }
    let writer: CandidateImportWriter;
    try {
      writer = await this.store.createCandidateImport(importId);
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw new HybridCatalogError("hybrid-snapshot-corrupt");
    }
    try {
      const summary = await this.parser.parse({
        source,
        onCandidate: async (record) => {
          assertNotAborted();
          await writer.append(record);
          assertNotAborted();
        },
      });
      assertNotAborted();
      const importedAt = this.options.now();
      return await writer.commit({
        summary,
        importedAt,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      try {
        await writer.abort();
      } catch {
        // Preserve the original fixed failure; staging cleanup is best effort here.
      }
      if (error instanceof HybridCatalogError) throw error;
      throw new HybridCatalogError("hybrid-snapshot-corrupt");
    }
  }
}
