import {
  decodeCatalogDifferenceRecord,
  decodeTxtCandidateRecord,
  decodeUnifiedCatalogRecord,
  encodeCatalogDifferenceRecordLine,
  encodeTxtCandidateRecordLine,
  encodeUnifiedCatalogRecordLine,
} from "./hybrid-catalog-codec";
import type { UnifiedCatalogStorePort } from "./hybrid-catalog-ports";
import {
  MAX_UNIFIED_CATALOG_PDF_COUNT,
  HybridCatalogError,
  type ActiveCatalogOverlay,
  type CatalogDifferenceRecordV1,
  type TxtCandidateRecordV1,
  type UnifiedCatalogDescriptor,
  type UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";

export interface UnifiedCatalogProjectionOptions {
  readonly now: () => number;
}

export interface UnifiedCatalogProjectionResult {
  readonly descriptor: UnifiedCatalogDescriptor;
  readonly records: readonly UnifiedCatalogRecordV1[];
  readonly differences: readonly CatalogDifferenceRecordV1[];
}

const corrupt = (): never => {
  throw new HybridCatalogError("hybrid-snapshot-corrupt");
};

const cloneRecord = (record: UnifiedCatalogRecordV1): UnifiedCatalogRecordV1 => ({
  ...record,
  isbnCandidates: [...record.isbnCandidates],
  hierarchyTags: [...record.hierarchyTags],
  differenceKinds: [...record.differenceKinds],
});

const cloneDifference = (record: CatalogDifferenceRecordV1): CatalogDifferenceRecordV1 => ({
  ...record,
});

const validatedCandidate = (record: TxtCandidateRecordV1): TxtCandidateRecordV1 =>
  decodeTxtCandidateRecord(encodeTxtCandidateRecordLine(record).slice(0, -1));

const validatedRecord = (record: UnifiedCatalogRecordV1): UnifiedCatalogRecordV1 =>
  decodeUnifiedCatalogRecord(encodeUnifiedCatalogRecordLine(record).slice(0, -1));

const validatedDifference = (record: CatalogDifferenceRecordV1): CatalogDifferenceRecordV1 =>
  decodeCatalogDifferenceRecord(encodeCatalogDifferenceRecordLine(record).slice(0, -1));

const projectCandidate = (record: TxtCandidateRecordV1): UnifiedCatalogRecordV1 => ({
  schemaVersion: 1,
  catalogId: record.candidateId,
  candidateId: record.candidateId,
  fsId: null,
  relativePath: record.relativePath,
  cloudPath: null,
  filename: record.filename,
  title: record.title,
  isbnCandidates: [...record.isbnCandidates],
  sizeBytes: null,
  serverModifiedAt: null,
  topLevelGroupId: record.topLevelGroupId,
  hierarchyTags: [...record.hierarchyTags],
  verificationStatus: "unverified",
  differenceKinds: [],
  visibleByDefault: true,
});

const fixedCompare = (left: UnifiedCatalogRecordV1, right: UnifiedCatalogRecordV1): number => {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  if (left.catalogId < right.catalogId) return -1;
  if (left.catalogId > right.catalogId) return 1;
  return 0;
};

const differenceCompare = (
  left: CatalogDifferenceRecordV1,
  right: CatalogDifferenceRecordV1,
): number => {
  if (left.catalogId < right.catalogId) return -1;
  if (left.catalogId > right.catalogId) return 1;
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;
  return 0;
};

const overlayCompare = (left: ActiveCatalogOverlay, right: ActiveCatalogOverlay): number => {
  if (left.descriptor.completedAt !== right.descriptor.completedAt) {
    return left.descriptor.completedAt - right.descriptor.completedAt;
  }
  return left.descriptor.overlayId.localeCompare(right.descriptor.overlayId, "en-US");
};

const sameRecord = (left: UnifiedCatalogRecordV1, right: UnifiedCatalogRecordV1): boolean =>
  encodeUnifiedCatalogRecordLine(left) === encodeUnifiedCatalogRecordLine(right);

export class UnifiedCatalogProjectionService {
  constructor(
    private readonly store: UnifiedCatalogStorePort,
    private readonly options: UnifiedCatalogProjectionOptions = { now: Date.now },
  ) {}

  async rebuild(signal?: AbortSignal): Promise<UnifiedCatalogProjectionResult> {
    const assertNotAborted = (): void => {
      if (signal?.aborted === true) corrupt();
    };
    assertNotAborted();
    const activeCandidates = await this.store.loadActiveCandidates();
    assertNotAborted();
    if (activeCandidates === null) return corrupt();
    const recordsById = new Map<string, UnifiedCatalogRecordV1>();
    for (const stored of activeCandidates.records) {
      const candidate = validatedCandidate(stored);
      if (recordsById.has(candidate.candidateId)) return corrupt();
      recordsById.set(candidate.candidateId, projectCandidate(candidate));
    }

    const overlays = (await this.store.loadActiveOverlays())
      .filter((overlay) => (
        overlay.descriptor.sourceImportSha256 === activeCandidates.descriptor.sourceSha256
      ))
      .sort(overlayCompare);
    assertNotAborted();
    const fsWinners = new Map<string, Readonly<{
      record: UnifiedCatalogRecordV1;
      completedAt: number;
    }>>();
    const differencesByCatalogId = new Map<string, CatalogDifferenceRecordV1[]>();

    for (const overlay of overlays) {
      if (
        overlay.descriptor.recordCount !== overlay.records.length
        || overlay.descriptor.differenceCount !== overlay.differences.length
        || overlay.descriptor.supersededCount !== overlay.supersededCatalogIds.length
      ) return corrupt();
      for (const superseded of overlay.supersededCatalogIds) recordsById.delete(superseded);
      const overlayFsIds = new Set<string>();
      const overlayCatalogIds = new Set<string>();
      for (const stored of overlay.records) {
        const record = validatedRecord(stored);
        if (overlayCatalogIds.has(record.catalogId)) return corrupt();
        overlayCatalogIds.add(record.catalogId);
        if (record.candidateId !== null) recordsById.delete(record.candidateId);
        if (record.fsId !== null) {
          if (overlayFsIds.has(record.fsId)) return corrupt();
          overlayFsIds.add(record.fsId);
          const existing = fsWinners.get(record.fsId);
          if (existing !== undefined) {
            if (existing.completedAt === overlay.descriptor.completedAt && !sameRecord(existing.record, record)) {
              return corrupt();
            }
            recordsById.delete(existing.record.catalogId);
          }
          fsWinners.set(record.fsId, { record, completedAt: overlay.descriptor.completedAt });
        }
        differencesByCatalogId.delete(record.catalogId);
        recordsById.set(record.catalogId, record);
      }
      for (const stored of overlay.differences) {
        const difference = validatedDifference(stored);
        if (difference.acknowledgedAt !== null) continue;
        if (!overlayCatalogIds.has(difference.catalogId)) return corrupt();
        const values = differencesByCatalogId.get(difference.catalogId) ?? [];
        if (values.some((value) => value.kind === difference.kind)) return corrupt();
        values.push(difference);
        differencesByCatalogId.set(difference.catalogId, values);
      }
    }

    const records = [...recordsById.values()].sort(fixedCompare);
    if (records.length > MAX_UNIFIED_CATALOG_PDF_COUNT) return corrupt();
    const activeIds = new Set(records.map((record) => record.catalogId));
    const differences = [...differencesByCatalogId.values()]
      .flat()
      .filter((difference) => activeIds.has(difference.catalogId))
      .sort(differenceCompare);
    const descriptor = await this.store.writeUnifiedSnapshot({
      sourceImportSha256: activeCandidates.descriptor.sourceSha256,
      records,
      differences,
      completedAt: this.options.now(),
      ...(signal === undefined ? {} : { signal }),
    });
    assertNotAborted();
    return {
      descriptor: { ...descriptor },
      records: records.map(cloneRecord),
      differences: differences.map(cloneDifference),
    };
  }
}
