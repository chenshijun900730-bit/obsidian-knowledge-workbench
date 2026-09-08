import { createHash } from "node:crypto";
import {
  decodeCloudVerificationAuthority,
  type CloudVerificationAuthority,
  type CloudVerificationScope,
} from "./cloud-verification-scope";
import {
  decodeCatalogDifferenceRecord,
  decodeTxtCandidateRecord,
  decodeUnifiedCatalogRecord,
  encodeCatalogOverlayDescriptor,
  encodeCatalogDifferenceRecordLine,
  encodeTxtCandidateRecordLine,
  encodeUnifiedCatalogDescriptor,
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

type ScopedAuthority = Extract<CloudVerificationAuthority, Readonly<{ kind: "scoped" }>>;

interface GroupSource {
  readonly groupId: string;
  readonly tier: 0 | 1 | 2;
  readonly completedAt: number;
  readonly deterministicId: string;
  readonly records: readonly UnifiedCatalogRecordV1[];
  readonly differences: readonly CatalogDifferenceRecordV1[];
  readonly supersededCatalogIds: readonly string[];
}

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

const descriptorSha256 = (overlay: ActiveCatalogOverlay): string => createHash("sha256")
  .update(`${encodeCatalogOverlayDescriptor(overlay.descriptor)}\n`)
  .digest("hex");

const trustedOverlayTier = (
  overlay: ActiveCatalogOverlay,
  authority: ScopedAuthority,
): 1 | 2 | null => {
  const descriptor = overlay.descriptor;
  if (descriptor.sourceImportSha256 !== authority.scope.sourceImportSha256) return null;
  if (descriptor.schemaVersion === 2) {
    if (
      descriptor.verificationGeneration !== authority.scope.generation
      || descriptor.cloudRootSha256 !== authority.scope.cloudRootSha256
    ) return null;
    descriptorSha256(overlay);
    return 2;
  }
  const allowlisted = authority.legacyAllowlist?.overlays.find((value) => (
    value.overlayId === descriptor.overlayId
    && value.groupKey === descriptor.topLevelGroupId
  ));
  if (allowlisted === undefined || allowlisted.descriptorSha256 !== descriptorSha256(overlay)) {
    return null;
  }
  return 1;
};

const selectTrustedOverlays = (
  values: readonly ActiveCatalogOverlay[],
  authority: CloudVerificationAuthority | null,
): readonly Readonly<{ overlay: ActiveCatalogOverlay; tier: 1 | 2 }>[] => {
  if (authority === null) return [];
  if (authority.kind !== "scoped") return corrupt();
  const winners = new Map<string, Readonly<{
    overlay: ActiveCatalogOverlay;
    tier: 1 | 2;
  }>>();
  for (const overlay of values) {
    const tier = trustedOverlayTier(overlay, authority);
    if (tier === null) continue;
    const prior = winners.get(overlay.descriptor.topLevelGroupId);
    if (
      prior === undefined
      || tier > prior.tier
      || (
        tier === prior.tier
        && (
          overlay.descriptor.completedAt > prior.overlay.descriptor.completedAt
          || (
            overlay.descriptor.completedAt === prior.overlay.descriptor.completedAt
            && overlay.descriptor.overlayId > prior.overlay.descriptor.overlayId
          )
        )
      )
    ) winners.set(overlay.descriptor.topLevelGroupId, { overlay, tier });
  }
  return [...winners.values()].sort((left, right) => overlayCompare(left.overlay, right.overlay));
};

const unifiedDescriptorSha256 = (descriptor: UnifiedCatalogDescriptor): string => createHash("sha256")
  .update(`${encodeUnifiedCatalogDescriptor(descriptor)}\n`)
  .digest("hex");

const trustedUnifiedTier = (
  descriptor: UnifiedCatalogDescriptor,
  authority: ScopedAuthority,
): 1 | 2 | null => {
  if (descriptor.sourceImportSha256 !== authority.scope.sourceImportSha256) return null;
  if (descriptor.schemaVersion === 2) {
    const scope = descriptor.verificationScope;
    if (
      scope === null
      || scope.generation !== authority.scope.generation
      || scope.sourceImportSha256 !== authority.scope.sourceImportSha256
      || scope.cloudRootSha256 !== authority.scope.cloudRootSha256
    ) return null;
    unifiedDescriptorSha256(descriptor);
    return 2;
  }
  const allowlisted = authority.legacyAllowlist?.unified;
  if (
    allowlisted === null
    || allowlisted === undefined
    || allowlisted.snapshotId !== descriptor.snapshotId
    || allowlisted.descriptorSha256 !== unifiedDescriptorSha256(descriptor)
  ) return null;
  return 1;
};

const sourceWins = (next: GroupSource, prior: GroupSource): boolean => (
  next.tier > prior.tier
  || (
    next.tier === prior.tier
    && (
      next.completedAt > prior.completedAt
      || (
        next.completedAt === prior.completedAt
        && next.deterministicId > prior.deterministicId
      )
    )
  )
);

const cloneScope = (value: CloudVerificationScope | null): CloudVerificationScope | null => (
  value === null ? null : { ...value }
);

const cloneUnifiedDescriptor = (
  value: UnifiedCatalogDescriptor,
): UnifiedCatalogDescriptor => value.schemaVersion === 2
  ? { ...value, verificationScope: cloneScope(value.verificationScope) }
  : { ...value };

const sameRecord = (left: UnifiedCatalogRecordV1, right: UnifiedCatalogRecordV1): boolean =>
  encodeUnifiedCatalogRecordLine(left) === encodeUnifiedCatalogRecordLine(right);

export class UnifiedCatalogProjectionService {
  constructor(
    private readonly store: UnifiedCatalogStorePort,
    private readonly options: UnifiedCatalogProjectionOptions = { now: Date.now },
  ) {}

  async rebuild(
    authority: CloudVerificationAuthority | null = null,
    signal?: AbortSignal,
  ): Promise<UnifiedCatalogProjectionResult> {
    const assertNotAborted = (): void => {
      if (signal?.aborted === true) corrupt();
    };
    let decodedAuthority: CloudVerificationAuthority | null = null;
    try {
      decodedAuthority = authority === null ? null : decodeCloudVerificationAuthority(authority);
    } catch {
      return corrupt();
    }
    if (decodedAuthority?.kind === "legacy-local-only") return corrupt();
    assertNotAborted();
    const activeCandidates = await this.store.loadActiveCandidates(decodedAuthority);
    assertNotAborted();
    if (activeCandidates === null) return corrupt();
    if (
      decodedAuthority?.kind === "scoped"
      && (
        activeCandidates.descriptor.sourceSha256 !== decodedAuthority.scope.sourceImportSha256
        || (
          decodedAuthority.legacyAllowlist !== null
          && decodedAuthority.legacyAllowlist.candidate.importId !== activeCandidates.descriptor.importId
        )
      )
    ) return corrupt();
    const sourcesByGroup = new Map<string, GroupSource>();
    const candidateRecordsByGroup = new Map<string, UnifiedCatalogRecordV1[]>();
    const candidateIds = new Set<string>();
    for (const stored of activeCandidates.records) {
      const candidate = validatedCandidate(stored);
      if (candidateIds.has(candidate.candidateId)) return corrupt();
      candidateIds.add(candidate.candidateId);
      const records = candidateRecordsByGroup.get(candidate.topLevelGroupId) ?? [];
      records.push(projectCandidate(candidate));
      candidateRecordsByGroup.set(candidate.topLevelGroupId, records);
    }
    for (const [groupId, records] of candidateRecordsByGroup) {
      sourcesByGroup.set(groupId, {
        groupId,
        tier: 0,
        completedAt: activeCandidates.descriptor.importedAt,
        deterministicId: activeCandidates.descriptor.importId,
        records,
        differences: [],
        supersededCatalogIds: [],
      });
    }

    const activeUnified = await this.store.loadActiveUnified(decodedAuthority);
    assertNotAborted();
    if (decodedAuthority?.kind === "scoped" && activeUnified !== null) {
      const tier = trustedUnifiedTier(activeUnified.descriptor, decodedAuthority);
      if (tier !== null) {
        if (
          activeUnified.descriptor.recordCount !== activeUnified.records.length
          || activeUnified.descriptor.differenceCount !== activeUnified.differences.length
        ) return corrupt();
        const unifiedRecords = new Map<string, UnifiedCatalogRecordV1[]>();
        const unifiedRecordIds = new Map<string, Set<string>>();
        for (const stored of activeUnified.records) {
          const record = validatedRecord(stored);
          const values = unifiedRecords.get(record.topLevelGroupId) ?? [];
          const ids = unifiedRecordIds.get(record.topLevelGroupId) ?? new Set<string>();
          if (ids.has(record.catalogId)) return corrupt();
          ids.add(record.catalogId);
          values.push(record);
          unifiedRecords.set(record.topLevelGroupId, values);
          unifiedRecordIds.set(record.topLevelGroupId, ids);
        }
        const unifiedDifferences = new Map<string, CatalogDifferenceRecordV1[]>();
        for (const stored of activeUnified.differences) {
          const difference = validatedDifference(stored);
          if (difference.acknowledgedAt !== null) continue;
          if (!unifiedRecordIds.get(difference.topLevelGroupId)?.has(difference.catalogId)) {
            return corrupt();
          }
          const values = unifiedDifferences.get(difference.topLevelGroupId) ?? [];
          if (values.some((value) => (
            value.catalogId === difference.catalogId && value.kind === difference.kind
          ))) return corrupt();
          values.push(difference);
          unifiedDifferences.set(difference.topLevelGroupId, values);
        }
        for (const [groupId, records] of unifiedRecords) {
          const source: GroupSource = {
            groupId,
            tier,
            completedAt: activeUnified.descriptor.completedAt,
            deterministicId: activeUnified.descriptor.snapshotId,
            records,
            differences: unifiedDifferences.get(groupId) ?? [],
            supersededCatalogIds: [],
          };
          const prior = sourcesByGroup.get(groupId);
          if (prior === undefined || sourceWins(source, prior)) sourcesByGroup.set(groupId, source);
        }
      }
    }

    const overlays = selectTrustedOverlays(
      await this.store.loadActiveOverlays(decodedAuthority),
      decodedAuthority,
    );
    assertNotAborted();
    for (const { overlay, tier } of overlays) {
      if (
        overlay.descriptor.recordCount !== overlay.records.length
        || overlay.descriptor.differenceCount !== overlay.differences.length
        || overlay.descriptor.supersededCount !== overlay.supersededCatalogIds.length
      ) return corrupt();
      const records = overlay.records.map(validatedRecord);
      if (new Set(records.map((record) => record.catalogId)).size !== records.length) return corrupt();
      const differences = overlay.differences
        .map(validatedDifference)
        .filter((difference) => difference.acknowledgedAt === null);
      const recordIds = new Set(records.map((record) => record.catalogId));
      for (const difference of differences) {
        if (!recordIds.has(difference.catalogId)) return corrupt();
      }
      const source: GroupSource = {
        groupId: overlay.descriptor.topLevelGroupId,
        tier,
        completedAt: overlay.descriptor.completedAt,
        deterministicId: overlay.descriptor.overlayId,
        records,
        differences,
        supersededCatalogIds: overlay.supersededCatalogIds,
      };
      const prior = sourcesByGroup.get(source.groupId);
      if (prior === undefined || sourceWins(source, prior)) sourcesByGroup.set(source.groupId, source);
    }

    const recordsById = new Map<string, UnifiedCatalogRecordV1>();
    const fsWinners = new Map<string, Readonly<{
      record: UnifiedCatalogRecordV1;
      completedAt: number;
    }>>();
    const differencesByCatalogId = new Map<string, CatalogDifferenceRecordV1[]>();

    const selectedSources = [...sourcesByGroup.values()].sort((left, right) => (
      left.completedAt - right.completedAt
      || left.deterministicId.localeCompare(right.deterministicId, "en-US")
    ));
    for (const source of selectedSources) {
      for (const superseded of source.supersededCatalogIds) recordsById.delete(superseded);
      const overlayFsIds = new Set<string>();
      const overlayCatalogIds = new Set<string>();
      for (const record of source.records) {
        if (overlayCatalogIds.has(record.catalogId)) return corrupt();
        overlayCatalogIds.add(record.catalogId);
        if (record.candidateId !== null) recordsById.delete(record.candidateId);
        if (record.fsId !== null) {
          if (overlayFsIds.has(record.fsId)) return corrupt();
          overlayFsIds.add(record.fsId);
          const existing = fsWinners.get(record.fsId);
          if (existing !== undefined) {
            if (existing.completedAt === source.completedAt && !sameRecord(existing.record, record)) {
              return corrupt();
            }
            recordsById.delete(existing.record.catalogId);
          }
          fsWinners.set(record.fsId, { record, completedAt: source.completedAt });
        }
        differencesByCatalogId.delete(record.catalogId);
        recordsById.set(record.catalogId, record);
      }
      for (const difference of source.differences) {
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
      verificationScope: decodedAuthority?.kind === "scoped"
        ? { ...decodedAuthority.scope }
        : null,
      records,
      differences,
      completedAt: this.options.now(),
      ...(signal === undefined ? {} : { signal }),
    });
    assertNotAborted();
    return {
      descriptor: cloneUnifiedDescriptor(descriptor),
      records: records.map(cloneRecord),
      differences: differences.map(cloneDifference),
    };
  }
}
