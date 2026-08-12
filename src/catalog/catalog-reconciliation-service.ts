import { normalizeCloudAbsolutePath } from "./catalog-path";
import type { CloudCatalogRecord } from "./catalog-types";
import {
  decodeCatalogDifferenceRecord,
  decodeTxtCandidateRecord,
  decodeUnifiedCatalogRecord,
  encodeCatalogDifferenceRecordLine,
  encodeTxtCandidateRecordLine,
  encodeUnifiedCatalogRecordLine,
} from "./hybrid-catalog-codec";
import {
  HybridCatalogError,
  type ActiveCatalogOverlay,
  type CatalogDifferenceKind,
  type CatalogDifferenceRecordV1,
  type CatalogReconciliationResult,
  type TxtCandidateRecordV1,
  type UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";

export interface CatalogReconciliationInput {
  readonly sourceImportSha256: string;
  readonly topLevelGroupId: string;
  readonly cloudRoot: string;
  readonly candidates: readonly TxtCandidateRecordV1[];
  readonly activeOverlays: readonly ActiveCatalogOverlay[];
  readonly cloudRecords: readonly CloudCatalogRecord[];
  readonly completedAt: number;
  readonly complete: boolean;
}

export interface CatalogAcknowledgementInput {
  readonly overlay: CatalogReconciliationResult;
  readonly catalogIds: readonly string[];
  readonly acknowledgedAt: number;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GROUP_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;
const FS_ID_PATTERN = /^(?:0|[1-9]\d*)$/u;

const invalidRecord = (): never => {
  throw new HybridCatalogError("hybrid-record-invalid");
};

const invalidBatch = (): never => {
  throw new HybridCatalogError("hybrid-batch-invalid");
};

const fixedCompare = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const recordCompare = (left: UnifiedCatalogRecordV1, right: UnifiedCatalogRecordV1): number =>
  fixedCompare(left.relativePath, right.relativePath) || fixedCompare(left.catalogId, right.catalogId);

const differenceCompare = (
  left: CatalogDifferenceRecordV1,
  right: CatalogDifferenceRecordV1,
): number => fixedCompare(left.catalogId, right.catalogId) || fixedCompare(left.kind, right.kind);

const parentOfRelative = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
};

const directParent = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

const hierarchyTags = (relativePath: string): readonly string[] => {
  const parent = parentOfRelative(relativePath);
  return parent === "" ? [] : parent.split("/").map((segment) => `folder/${segment}`);
};

const validatedCandidate = (record: TxtCandidateRecordV1): TxtCandidateRecordV1 =>
  decodeTxtCandidateRecord(encodeTxtCandidateRecordLine(record).slice(0, -1));

const validatedUnified = (record: UnifiedCatalogRecordV1): UnifiedCatalogRecordV1 =>
  decodeUnifiedCatalogRecord(encodeUnifiedCatalogRecordLine(record).slice(0, -1));

const validatedDifference = (record: CatalogDifferenceRecordV1): CatalogDifferenceRecordV1 =>
  decodeCatalogDifferenceRecord(encodeCatalogDifferenceRecordLine(record).slice(0, -1));

const cloneResult = (result: CatalogReconciliationResult): CatalogReconciliationResult => ({
  ...result,
  records: result.records.map((record) => ({
    ...record,
    isbnCandidates: [...record.isbnCandidates],
    hierarchyTags: [...record.hierarchyTags],
    differenceKinds: [...record.differenceKinds],
  })),
  differences: result.differences.map((difference) => ({ ...difference })),
  supersededCatalogIds: [...result.supersededCatalogIds],
});

const cloudRelativePath = (
  root: string,
  groupId: string,
  record: CloudCatalogRecord,
): string => {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeCloudAbsolutePath(record.path);
  } catch {
    return invalidRecord();
  }
  const filename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  if (
    normalizedPath !== record.path
    || record.schemaVersion !== 1
    || record.source !== "baidu-netdisk"
    || record.kind !== "file"
    || !FS_ID_PATTERN.test(record.fsId)
    || record.parentPath !== directParent(normalizedPath)
    || record.filename !== filename
    || record.extension !== "pdf"
    || record.title !== filename.slice(0, -4)
    || !/\.pdf$/iu.test(filename)
    || !Number.isSafeInteger(record.sizeBytes)
    || record.sizeBytes < 0
    || !Number.isSafeInteger(record.serverModifiedAt)
    || record.serverModifiedAt < 0
    || !normalizedPath.startsWith(`${root}/`)
  ) return invalidRecord();
  const belowRoot = normalizedPath.slice(root.length + 1);
  if (belowRoot.length === 0) return invalidRecord();
  if (groupId === "txt-root-items") {
    if (belowRoot.includes("/")) return invalidRecord();
    return belowRoot;
  }
  const rootName = root.slice(root.lastIndexOf("/") + 1);
  if (rootName.length === 0) return invalidRecord();
  return `${rootName}/${belowRoot}`;
};

const cloudUnified = (
  cloud: CloudCatalogRecord,
  relativePath: string,
  groupId: string,
  candidateId: string | null,
  difference: CatalogDifferenceKind | null,
): UnifiedCatalogRecordV1 => ({
  schemaVersion: 1,
  catalogId: `baidu:${cloud.fsId}`,
  candidateId,
  fsId: cloud.fsId,
  relativePath,
  cloudPath: cloud.path,
  filename: cloud.filename,
  title: cloud.title,
  isbnCandidates: [...cloud.isbnCandidates],
  sizeBytes: cloud.sizeBytes,
  serverModifiedAt: cloud.serverModifiedAt,
  topLevelGroupId: groupId,
  hierarchyTags: hierarchyTags(relativePath),
  verificationStatus: difference === null ? "verified" : "difference",
  differenceKinds: difference === null ? [] : [difference],
  visibleByDefault: true,
});

const missingUnified = (
  candidate: TxtCandidateRecordV1,
  prior: UnifiedCatalogRecordV1 | undefined,
): UnifiedCatalogRecordV1 => ({
  schemaVersion: 1,
  catalogId: prior?.catalogId ?? candidate.candidateId,
  candidateId: candidate.candidateId,
  fsId: prior?.fsId ?? null,
  relativePath: candidate.relativePath,
  cloudPath: null,
  filename: candidate.filename,
  title: candidate.title,
  isbnCandidates: [...candidate.isbnCandidates],
  sizeBytes: null,
  serverModifiedAt: null,
  topLevelGroupId: candidate.topLevelGroupId,
  hierarchyTags: [...candidate.hierarchyTags],
  verificationStatus: "difference",
  differenceKinds: ["cloud-missing"],
  visibleByDefault: false,
});

const differenceFor = (
  record: UnifiedCatalogRecordV1,
  kind: CatalogDifferenceKind,
): CatalogDifferenceRecordV1 => ({
  schemaVersion: 1,
  catalogId: record.catalogId,
  topLevelGroupId: record.topLevelGroupId,
  kind,
  acknowledgedAt: null,
});

export class CatalogReconciliationService {
  reconcile(input: CatalogReconciliationInput): CatalogReconciliationResult {
    if (!input.complete) return invalidBatch();
    if (
      !HASH_PATTERN.test(input.sourceImportSha256)
      || !GROUP_PATTERN.test(input.topLevelGroupId)
      || !Number.isSafeInteger(input.completedAt)
      || input.completedAt < 0
    ) return invalidRecord();
    let root: string;
    try {
      root = normalizeCloudAbsolutePath(input.cloudRoot);
    } catch {
      return invalidRecord();
    }

    const candidates = input.candidates.map(validatedCandidate);
    const candidateByPath = new Map<string, TxtCandidateRecordV1>();
    const candidateById = new Map<string, TxtCandidateRecordV1>();
    for (const value of candidates) {
      if (
        value.topLevelGroupId !== input.topLevelGroupId
        || candidateByPath.has(value.relativePath)
        || candidateById.has(value.candidateId)
      ) return invalidRecord();
      if (input.topLevelGroupId !== "txt-root-items") {
        const rootName = root.slice(root.lastIndexOf("/") + 1);
        if (value.relativePath.split("/")[0] !== rootName) return invalidRecord();
      }
      candidateByPath.set(value.relativePath, value);
      candidateById.set(value.candidateId, value);
    }

    const overlays = input.activeOverlays
      .filter((value) => value.descriptor.sourceImportSha256 === input.sourceImportSha256)
      .sort((left, right) => (
        left.descriptor.completedAt - right.descriptor.completedAt
        || fixedCompare(left.descriptor.overlayId, right.descriptor.overlayId)
      ));
    const globalPriorByFsId = new Map<string, UnifiedCatalogRecordV1>();
    const currentPriorByCandidateId = new Map<string, UnifiedCatalogRecordV1>();
    const globalCompletedAt = new Map<string, number>();
    for (const active of overlays) {
      if (
        active.descriptor.recordCount !== active.records.length
        || active.descriptor.differenceCount !== active.differences.length
        || active.descriptor.supersededCount !== active.supersededCatalogIds.length
      ) return invalidRecord();
      for (const stored of active.records) {
        const record = validatedUnified(stored);
        if (record.topLevelGroupId !== active.descriptor.topLevelGroupId) return invalidRecord();
        if (record.fsId !== null) {
          const priorAt = globalCompletedAt.get(record.fsId);
          const prior = globalPriorByFsId.get(record.fsId);
          if (
            priorAt === active.descriptor.completedAt
            && prior !== undefined
            && encodeUnifiedCatalogRecordLine(prior) !== encodeUnifiedCatalogRecordLine(record)
          ) return invalidRecord();
          globalPriorByFsId.set(record.fsId, record);
          globalCompletedAt.set(record.fsId, active.descriptor.completedAt);
        }
        if (
          active.descriptor.topLevelGroupId === input.topLevelGroupId
          && record.candidateId !== null
        ) currentPriorByCandidateId.set(record.candidateId, record);
      }
    }

    const cloudValues = input.cloudRecords.map((record) => ({
      record,
      relativePath: cloudRelativePath(root, input.topLevelGroupId, record),
    }));
    const cloudFsIds = new Set<string>();
    const cloudPaths = new Set<string>();
    for (const value of cloudValues) {
      if (cloudFsIds.has(value.record.fsId) || cloudPaths.has(value.relativePath)) {
        return invalidRecord();
      }
      cloudFsIds.add(value.record.fsId);
      cloudPaths.add(value.relativePath);
    }
    cloudValues.sort((left, right) => fixedCompare(left.relativePath, right.relativePath));

    const records: UnifiedCatalogRecordV1[] = [];
    const differences: CatalogDifferenceRecordV1[] = [];
    const matchedCandidates = new Set<string>();
    const superseded = new Set<string>();
    const unmatchedCloud: typeof cloudValues = [];

    for (const value of cloudValues) {
      const prior = globalPriorByFsId.get(value.record.fsId);
      if (prior === undefined) {
        unmatchedCloud.push(value);
        continue;
      }
      const exactCandidate = candidateByPath.get(value.relativePath);
      const priorCandidate = prior.candidateId === null
        ? undefined
        : candidateById.get(prior.candidateId);
      const boundCandidate = exactCandidate ?? priorCandidate;
      if (boundCandidate !== undefined) matchedCandidates.add(boundCandidate.candidateId);
      let kind: CatalogDifferenceKind | null = null;
      if (prior.topLevelGroupId !== input.topLevelGroupId) {
        kind = "moved";
        superseded.add(prior.catalogId);
      } else if (prior.relativePath !== value.relativePath) {
        kind = parentOfRelative(prior.relativePath) === parentOfRelative(value.relativePath)
          ? "renamed"
          : "moved";
      }
      const projected = validatedUnified(cloudUnified(
        value.record,
        value.relativePath,
        input.topLevelGroupId,
        boundCandidate?.candidateId ?? prior.candidateId,
        kind,
      ));
      records.push(projected);
      if (kind !== null) differences.push(validatedDifference(differenceFor(projected, kind)));
    }

    for (const value of unmatchedCloud) {
      const exactCandidate = candidateByPath.get(value.relativePath);
      const kind: CatalogDifferenceKind | null = exactCandidate === undefined ? "cloud-added" : null;
      if (exactCandidate !== undefined) matchedCandidates.add(exactCandidate.candidateId);
      const projected = validatedUnified(cloudUnified(
        value.record,
        value.relativePath,
        input.topLevelGroupId,
        exactCandidate?.candidateId ?? null,
        kind,
      ));
      records.push(projected);
      if (kind !== null) differences.push(validatedDifference(differenceFor(projected, kind)));
    }

    for (const value of candidates) {
      if (matchedCandidates.has(value.candidateId)) continue;
      const projected = validatedUnified(missingUnified(
        value,
        currentPriorByCandidateId.get(value.candidateId),
      ));
      records.push(projected);
      differences.push(validatedDifference(differenceFor(projected, "cloud-missing")));
    }

    records.sort(recordCompare);
    differences.sort(differenceCompare);
    return cloneResult({
      sourceImportSha256: input.sourceImportSha256,
      topLevelGroupId: input.topLevelGroupId,
      completedAt: input.completedAt,
      records,
      differences,
      supersededCatalogIds: [...superseded].sort(fixedCompare),
    });
  }

  acknowledge(input: CatalogAcknowledgementInput): CatalogReconciliationResult {
    if (
      !Number.isSafeInteger(input.acknowledgedAt)
      || input.acknowledgedAt < input.overlay.completedAt
      || input.catalogIds.length === 0
      || new Set(input.catalogIds).size !== input.catalogIds.length
    ) return invalidRecord();
    const selected = new Set(input.catalogIds);
    const activeDifferenceIds = new Set(
      input.overlay.differences
        .filter((difference) => difference.acknowledgedAt === null)
        .map((difference) => difference.catalogId),
    );
    if ([...selected].some((catalogId) => !activeDifferenceIds.has(catalogId))) {
      return invalidRecord();
    }
    const superseded = new Set(input.overlay.supersededCatalogIds);
    const records = input.overlay.records.flatMap((stored): UnifiedCatalogRecordV1[] => {
      const record = validatedUnified(stored);
      if (!selected.has(record.catalogId)) return [record];
      if (record.differenceKinds.includes("cloud-missing")) {
        superseded.add(record.catalogId);
        return [];
      }
      return [validatedUnified({
        ...record,
        verificationStatus: "verified",
        differenceKinds: [],
      })];
    }).sort(recordCompare);
    const differences = input.overlay.differences.map((stored) => {
      const difference = validatedDifference(stored);
      return selected.has(difference.catalogId) && difference.acknowledgedAt === null
        ? validatedDifference({ ...difference, acknowledgedAt: input.acknowledgedAt })
        : difference;
    }).sort(differenceCompare);
    return cloneResult({
      ...input.overlay,
      completedAt: input.acknowledgedAt,
      records,
      differences,
      supersededCatalogIds: [...superseded].sort(fixedCompare),
    });
  }
}
