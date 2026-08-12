import type { CloudCatalogRuntime } from "../catalog/cloud-catalog-runtime";
import { CatalogError, type CatalogErrorCode } from "../catalog/catalog-types";

export type CatalogInitializationErrorCode = CatalogErrorCode | "catalog-unavailable";

const fixedErrorCode = (error: unknown): CatalogInitializationErrorCode =>
  error instanceof CatalogError ? error.code : "catalog-unavailable";

export async function refreshCatalogProjection(catalog: CloudCatalogRuntime): Promise<void> {
  try {
    await catalog.initialize();
  } catch (error) {
    throw new Error(fixedErrorCode(error));
  }
}

export function startCatalogInitialization(
  catalog: CloudCatalogRuntime,
  report: (code: CatalogInitializationErrorCode) => void,
): void {
  try {
    void catalog.initialize().catch((error: unknown) => report(fixedErrorCode(error)));
  } catch (error) {
    report(fixedErrorCode(error));
  }
}
