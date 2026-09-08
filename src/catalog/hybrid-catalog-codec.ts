import { createHash } from "node:crypto";
import JSONbigFactory from "json-bigint";
import { decodeCloudVerificationScope } from "./cloud-verification-scope";
import { isbnCandidatesFromFilename } from "./catalog-codec";
import { normalizeCloudAbsolutePath } from "./catalog-path";
import type { CloudCatalogRecord } from "./catalog-types";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  LARGE_CATALOG_RUN_BUDGET,
  MAX_UNIFIED_CATALOG_PDF_COUNT,
  HybridCatalogError,
  type CandidateCatalogDescriptor,
  type CatalogOverlayDescriptor,
  type CatalogDifferenceKind,
  type CatalogDifferenceRecordV1,
  type CatalogVerificationStatus,
  type LargeCatalogBatchCheckpointV3,
  type LargeCatalogBatchCheckpoint,
  type LargeCatalogBatchCheckpointV4,
  type LargeCatalogActiveCheckpointPointerV1,
  type LargeCatalogBatchClaimV1,
  type LargeCatalogBatchGroupV3,
  type LargeCatalogBatchOperationJournalV1,
  type LargeCatalogBatchPageEnvelopeV3,
  type LargeCatalogBatchStagingManifestV1,
  type LargeCatalogBatchStatus,
  type LargeCatalogErrorCode,
  type LargeCatalogRunReceiptV3,
  type LargeCatalogRunReceipt,
  type LargeCatalogRunReceiptV4,
  type LargeCatalogStopReason,
  type TxtCandidateRecordV1,
  type UnifiedCatalogDescriptor,
  type UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";

const parseJson = JSONbigFactory({ storeAsString: true, strict: true }).parse;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CANDIDATE_ID_PATTERN = /^txt:[a-f0-9]{64}$/u;
const GROUP_ID_PATTERN = /^group:[a-f0-9]{64}$/u;
const DECIMAL_ID_PATTERN = /^(?:0|[1-9]\d*)$/u;
const SAFE_LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ISBN_PATTERN = /^(?:\d{13}|\d{9}[\dX])$/u;
const CONTROL_PATTERN = /\p{Cc}/u;
const DIFFERENCE_ORDER: readonly CatalogDifferenceKind[] = [
  "cloud-added",
  "cloud-missing",
  "renamed",
  "moved",
];
const LARGE_ERROR_CODES: readonly LargeCatalogErrorCode[] = [
  "baidu-permission-denied",
  "baidu-not-found",
  "baidu-rate-limited",
  "baidu-token-expired",
  "baidu-access-unavailable",
  "invalid-baidu-response",
  "hybrid-snapshot-corrupt",
  "hybrid-batch-invalid",
  "hybrid-batch-unavailable",
];
const LARGE_PAUSE_REASONS = [
  "user-canceled",
  "selection-limit",
  "pdf-limit",
  "directory-limit",
  "list-request-limit",
  "time-limit",
] as const;

const invalid = (): never => {
  throw new HybridCatalogError("hybrid-record-invalid");
};

const parseObject = (raw: string): Readonly<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch {
    return invalid();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Readonly<Record<string, unknown>>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
};

const literal = <T extends string | number | boolean>(value: unknown, expected: T): T => {
  if (value !== expected) return invalid();
  return expected;
};

const canonicalString = (value: unknown): string => {
  if (typeof value !== "string" || value !== value.normalize("NFC")) return invalid();
  return value;
};

const safeInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return invalid();
  return value;
};

const nullableInteger = (value: unknown): number | null =>
  value === null ? null : safeInteger(value);

const safeLocalId = (value: unknown): string => {
  const text = canonicalString(value);
  if (!SAFE_LOCAL_ID_PATTERN.test(text)) return invalid();
  return text;
};

const hash = (value: unknown): string => {
  const text = canonicalString(value);
  if (!HASH_PATTERN.test(text)) return invalid();
  return text;
};

const candidateId = (value: unknown): string => {
  const text = canonicalString(value);
  if (!CANDIDATE_ID_PATTERN.test(text)) return invalid();
  return text;
};

const nullableCandidateId = (value: unknown): string | null =>
  value === null ? null : candidateId(value);

const groupId = (value: unknown): string => {
  const text = canonicalString(value);
  if (text !== "txt-root-items" && !GROUP_ID_PATTERN.test(text)) return invalid();
  return text;
};

const decimalId = (value: unknown): string => {
  const text = canonicalString(value);
  if (!DECIMAL_ID_PATTERN.test(text)) return invalid();
  return text;
};

const nullableDecimalId = (value: unknown): string | null =>
  value === null ? null : decimalId(value);

const relativePath = (value: unknown): string => {
  const text = canonicalString(value);
  if (
    text.length === 0
    || text.startsWith("/")
    || text.endsWith("/")
    || text.includes("\\")
    || CONTROL_PATTERN.test(text)
  ) return invalid();
  const segments = text.split("/");
  if (segments.some((segment) => (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment !== segment.trim()
  ))) return invalid();
  return text;
};

const parentRelativePath = (value: unknown): string => {
  if (value === "") return "";
  return relativePath(value);
};

const filename = (value: unknown): string => {
  const text = canonicalString(value);
  if (
    text.length === 0
    || text !== text.trim()
    || text.includes("/")
    || text.includes("\\")
    || CONTROL_PATTERN.test(text)
    || !/\.pdf$/iu.test(text)
  ) return invalid();
  return text;
};

const title = (value: unknown, expectedFilename: string): string => {
  const text = canonicalString(value);
  if (text !== expectedFilename.slice(0, -4)) return invalid();
  return text;
};

const cloudPath = (value: unknown, expectedFilename: string): string => {
  const text = canonicalString(value);
  if (
    text === "/"
    || !text.startsWith("/")
    || text.endsWith("/")
    || text.includes("\\")
    || CONTROL_PATTERN.test(text)
  ) return invalid();
  const segments = text.slice(1).split("/");
  if (segments.some((segment) => (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment !== segment.trim()
  ))) return invalid();
  if (segments.at(-1) !== expectedFilename) return invalid();
  return text;
};

const nullableCloudPath = (value: unknown, expectedFilename: string): string | null =>
  value === null ? null : cloudPath(value, expectedFilename);

const stringArray = (
  value: unknown,
  decode: (item: unknown) => string,
): readonly string[] => {
  if (!Array.isArray(value)) return invalid();
  return value.map(decode);
};

const isbnCandidates = (value: unknown): readonly string[] => {
  const values = stringArray(value, (item) => {
    const text = canonicalString(item);
    if (!ISBN_PATTERN.test(text)) return invalid();
    return text;
  });
  const canonical = [...new Set(values)].sort();
  if (canonical.length !== values.length || canonical.some((item, index) => item !== values[index])) {
    return invalid();
  }
  return values;
};

const hierarchyTags = (value: unknown): readonly string[] => stringArray(value, (item) => {
  const text = canonicalString(item);
  const name = text.startsWith("folder/") ? text.slice("folder/".length) : "";
  if (
    name.length === 0
    || name !== name.trim()
    || name.includes("/")
    || name.includes("\\")
    || CONTROL_PATTERN.test(name)
  ) return invalid();
  return text;
});

const differenceKinds = (value: unknown): readonly CatalogDifferenceKind[] => {
  if (!Array.isArray(value)) return invalid();
  const decoded = value.map((item): CatalogDifferenceKind => {
    if (typeof item !== "string" || !DIFFERENCE_ORDER.includes(item as CatalogDifferenceKind)) {
      return invalid();
    }
    return item as CatalogDifferenceKind;
  });
  const ordered = [...new Set(decoded)].sort(
    (left, right) => DIFFERENCE_ORDER.indexOf(left) - DIFFERENCE_ORDER.indexOf(right),
  );
  if (ordered.length !== decoded.length || ordered.some((item, index) => item !== decoded[index])) {
    return invalid();
  }
  return decoded;
};

const verificationStatus = (value: unknown): CatalogVerificationStatus => {
  if (value === "unverified" || value === "verified" || value === "difference") return value;
  return invalid();
};

const nullableBoolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") return invalid();
  return value;
};

const parentAndFilenameMatch = (
  path: string,
  parent: string,
  expectedFilename: string,
): void => {
  const index = path.lastIndexOf("/");
  const actualParent = index < 0 ? "" : path.slice(0, index);
  const actualFilename = index < 0 ? path : path.slice(index + 1);
  if (actualParent !== parent || actualFilename !== expectedFilename) invalid();
};

const validateHierarchy = (
  path: string,
  decodedGroupId: string,
  tags: readonly string[],
): void => {
  const index = path.lastIndexOf("/");
  const parent = index < 0 ? "" : path.slice(0, index);
  const segments = parent.length === 0 ? [] : parent.split("/");
  if (
    tags.length !== segments.length
    || tags.some((tag, tagIndex) => tag !== `folder/${segments[tagIndex]}`)
    || ((parent.length === 0) !== (decodedGroupId === "txt-root-items"))
  ) invalid();
};

export const decodeTxtCandidateRecord = (raw: string): TxtCandidateRecordV1 => {
  const value = parseObject(raw);
  exactKeys(value, [
    "schemaVersion",
    "source",
    "candidateId",
    "relativePath",
    "parentRelativePath",
    "filename",
    "title",
    "isbnCandidates",
    "topLevelGroupId",
    "hierarchyTags",
  ]);
  const path = relativePath(value.relativePath);
  const parent = parentRelativePath(value.parentRelativePath);
  const name = filename(value.filename);
  parentAndFilenameMatch(path, parent, name);
  const tags = hierarchyTags(value.hierarchyTags);
  const topLevelGroupId = groupId(value.topLevelGroupId);
  validateHierarchy(path, topLevelGroupId, tags);
  return {
    schemaVersion: literal(value.schemaVersion, 1),
    source: literal(value.source, "txt-candidate"),
    candidateId: candidateId(value.candidateId),
    relativePath: path,
    parentRelativePath: parent,
    filename: name,
    title: title(value.title, name),
    isbnCandidates: [...isbnCandidates(value.isbnCandidates)],
    topLevelGroupId,
    hierarchyTags: [...tags],
  };
};

const unifiedCatalogId = (
  value: unknown,
  decodedCandidateId: string | null,
  fsId: string | null,
): string => {
  const text = canonicalString(value);
  if (fsId !== null && text === `baidu:${fsId}`) return text;
  if (fsId === null && decodedCandidateId !== null && text === decodedCandidateId) return text;
  return invalid();
};

export const decodeUnifiedCatalogRecord = (raw: string): UnifiedCatalogRecordV1 => {
  const value = parseObject(raw);
  exactKeys(value, [
    "schemaVersion",
    "catalogId",
    "candidateId",
    "fsId",
    "relativePath",
    "cloudPath",
    "filename",
    "title",
    "isbnCandidates",
    "sizeBytes",
    "serverModifiedAt",
    "topLevelGroupId",
    "hierarchyTags",
    "verificationStatus",
    "differenceKinds",
    "visibleByDefault",
  ]);
  const decodedCandidateId = nullableCandidateId(value.candidateId);
  const fsId = nullableDecimalId(value.fsId);
  const path = relativePath(value.relativePath);
  const name = filename(value.filename);
  const decodedCloudPath = nullableCloudPath(value.cloudPath, name);
  const sizeBytes = nullableInteger(value.sizeBytes);
  const serverModifiedAt = nullableInteger(value.serverModifiedAt);
  const status = verificationStatus(value.verificationStatus);
  const differences = differenceKinds(value.differenceKinds);
  const visible = nullableBoolean(value.visibleByDefault);
  const decodedGroupId = groupId(value.topLevelGroupId);
  const tags = hierarchyTags(value.hierarchyTags);
  validateHierarchy(path, decodedGroupId, tags);
  const hasCloudFacts = (
    decodedCloudPath !== null
    && fsId !== null
    && sizeBytes !== null
    && serverModifiedAt !== null
  );
  const hasNoCloudFacts = decodedCloudPath === null && sizeBytes === null && serverModifiedAt === null;
  if ((sizeBytes === null) !== (serverModifiedAt === null)) invalid();
  if (status === "unverified") {
    if (
      decodedCandidateId === null
      || fsId !== null
      || !hasNoCloudFacts
      || differences.length !== 0
      || !visible
    ) invalid();
  } else if (status === "verified") {
    if (!hasCloudFacts || differences.length !== 0 || !visible) invalid();
  } else if (differences.includes("cloud-missing")) {
    if (
      differences.length !== 1
      || decodedCandidateId === null
      || !hasNoCloudFacts
      || visible
    ) invalid();
  } else {
    if (!hasCloudFacts || differences.length === 0 || !visible) invalid();
    if (differences.includes("cloud-added") && (
      differences.length !== 1
      || decodedCandidateId !== null
    )) invalid();
  }
  return {
    schemaVersion: literal(value.schemaVersion, 1),
    catalogId: unifiedCatalogId(value.catalogId, decodedCandidateId, fsId),
    candidateId: decodedCandidateId,
    fsId,
    relativePath: path,
    cloudPath: decodedCloudPath,
    filename: name,
    title: title(value.title, name),
    isbnCandidates: [...isbnCandidates(value.isbnCandidates)],
    sizeBytes,
    serverModifiedAt,
    topLevelGroupId: decodedGroupId,
    hierarchyTags: [...tags],
    verificationStatus: status,
    differenceKinds: [...differences],
    visibleByDefault: visible,
  };
};

export const decodeCatalogDifferenceRecord = (raw: string): CatalogDifferenceRecordV1 => {
  const value = parseObject(raw);
  exactKeys(value, [
    "schemaVersion",
    "catalogId",
    "topLevelGroupId",
    "kind",
    "acknowledgedAt",
  ]);
  const kinds = differenceKinds([value.kind]);
  const kind = kinds[0];
  if (kind === undefined) return invalid();
  const decodedCatalogId = canonicalString(value.catalogId);
  if (
    !CANDIDATE_ID_PATTERN.test(decodedCatalogId)
    && !/^baidu:(?:0|[1-9]\d*)$/u.test(decodedCatalogId)
  ) invalid();
  return {
    schemaVersion: literal(value.schemaVersion, 1),
    catalogId: decodedCatalogId,
    topLevelGroupId: groupId(value.topLevelGroupId),
    kind,
    acknowledgedAt: nullableInteger(value.acknowledgedAt),
  };
};

export const decodeCandidateCatalogDescriptor = (raw: string): CandidateCatalogDescriptor => {
  const value = parseObject(raw);
  exactKeys(value, [
    "schemaVersion",
    "importId",
    "importedAt",
    "sourceSha256",
    "byteSize",
    "nonEmptyLineCount",
    "pdfCount",
    "directoryCount",
    "ignoredLeafCount",
    "normalizedWhitespaceCount",
    "maxDepth",
    "candidateSha256",
  ]);
  const nonEmptyLineCount = safeInteger(
    value.nonEmptyLineCount,
    1,
    CATALOG_TXT_IMPORT_BUDGET.maxNonEmptyLineCount,
  );
  const pdfCount = safeInteger(value.pdfCount, 1, CATALOG_TXT_IMPORT_BUDGET.maxPdfCount);
  const directoryCount = safeInteger(value.directoryCount, 0, nonEmptyLineCount);
  const ignoredLeafCount = safeInteger(value.ignoredLeafCount, 0, nonEmptyLineCount);
  if (pdfCount + directoryCount + ignoredLeafCount !== nonEmptyLineCount) invalid();
  return {
    schemaVersion: literal(value.schemaVersion, 1),
    importId: safeLocalId(value.importId),
    importedAt: safeInteger(value.importedAt),
    sourceSha256: hash(value.sourceSha256),
    byteSize: safeInteger(value.byteSize, 1, CATALOG_TXT_IMPORT_BUDGET.maxBytes),
    nonEmptyLineCount,
    pdfCount,
    directoryCount,
    ignoredLeafCount,
    normalizedWhitespaceCount: safeInteger(value.normalizedWhitespaceCount, 0, nonEmptyLineCount),
    maxDepth: safeInteger(value.maxDepth, 1, CATALOG_TXT_IMPORT_BUDGET.maxDepth),
    candidateSha256: hash(value.candidateSha256),
  };
};

export const decodeUnifiedCatalogDescriptor = (raw: string): UnifiedCatalogDescriptor => {
  const value = parseObject(raw);
  const commonKeys = [
    "schemaVersion",
    "snapshotId",
    "sourceImportSha256",
    "completedAt",
    "recordCount",
    "differenceCount",
    "catalogSha256",
    "differencesSha256",
  ] as const;
  if (value.schemaVersion === 1) exactKeys(value, commonKeys);
  else if (value.schemaVersion === 2) exactKeys(value, [...commonKeys, "verificationScope"]);
  else return invalid();
  const sourceImportSha256 = hash(value.sourceImportSha256);
  const shared = {
    snapshotId: safeLocalId(value.snapshotId),
    sourceImportSha256,
    completedAt: safeInteger(value.completedAt),
    recordCount: safeInteger(value.recordCount, 0, MAX_UNIFIED_CATALOG_PDF_COUNT),
    differenceCount: safeInteger(value.differenceCount),
    catalogSha256: hash(value.catalogSha256),
    differencesSha256: hash(value.differencesSha256),
  };
  if (value.schemaVersion === 1) return { schemaVersion: 1, ...shared };
  const verificationScope = value.verificationScope === null
    ? null
    : decodeCloudVerificationScope(value.verificationScope);
  if (verificationScope !== null && verificationScope.sourceImportSha256 !== sourceImportSha256) {
    return invalid();
  }
  return {
    schemaVersion: 2,
    snapshotId: shared.snapshotId,
    sourceImportSha256: shared.sourceImportSha256,
    verificationScope,
    completedAt: shared.completedAt,
    recordCount: shared.recordCount,
    differenceCount: shared.differenceCount,
    catalogSha256: shared.catalogSha256,
    differencesSha256: shared.differencesSha256,
  };
};

export const decodeCatalogOverlayDescriptor = (raw: string): CatalogOverlayDescriptor => {
  const value = parseObject(raw);
  const commonKeys = [
    "schemaVersion",
    "overlayId",
    "sourceImportSha256",
    "topLevelGroupId",
    "completedAt",
    "recordCount",
    "differenceCount",
    "supersededCount",
    "recordsSha256",
    "differencesSha256",
    "supersededSha256",
  ] as const;
  if (value.schemaVersion === 1) exactKeys(value, commonKeys);
  else if (value.schemaVersion === 2) {
    exactKeys(value, [...commonKeys, "verificationGeneration", "cloudRootSha256"]);
  } else return invalid();
  const shared = {
    overlayId: safeLocalId(value.overlayId),
    sourceImportSha256: hash(value.sourceImportSha256),
    topLevelGroupId: groupId(value.topLevelGroupId),
    completedAt: safeInteger(value.completedAt),
    recordCount: safeInteger(value.recordCount, 0, MAX_UNIFIED_CATALOG_PDF_COUNT),
    differenceCount: safeInteger(value.differenceCount, 0, MAX_UNIFIED_CATALOG_PDF_COUNT * 4),
    supersededCount: safeInteger(value.supersededCount, 0, MAX_UNIFIED_CATALOG_PDF_COUNT),
    recordsSha256: hash(value.recordsSha256),
    differencesSha256: hash(value.differencesSha256),
    supersededSha256: hash(value.supersededSha256),
  };
  if (value.schemaVersion === 1) return { schemaVersion: 1, ...shared };
  return {
    schemaVersion: 2,
    overlayId: shared.overlayId,
    sourceImportSha256: shared.sourceImportSha256,
    verificationGeneration: safeInteger(value.verificationGeneration, 1),
    cloudRootSha256: hash(value.cloudRootSha256),
    topLevelGroupId: shared.topLevelGroupId,
    completedAt: shared.completedAt,
    recordCount: shared.recordCount,
    differenceCount: shared.differenceCount,
    supersededCount: shared.supersededCount,
    recordsSha256: shared.recordsSha256,
    differencesSha256: shared.differencesSha256,
    supersededSha256: shared.supersededSha256,
  };
};

export const encodeTxtCandidateRecordLine = (value: TxtCandidateRecordV1): string =>
  `${JSON.stringify(decodeTxtCandidateRecord(JSON.stringify(value)))}\n`;

export const encodeUnifiedCatalogRecordLine = (value: UnifiedCatalogRecordV1): string =>
  `${JSON.stringify(decodeUnifiedCatalogRecord(JSON.stringify(value)))}\n`;

export const encodeCatalogDifferenceRecordLine = (value: CatalogDifferenceRecordV1): string =>
  `${JSON.stringify(decodeCatalogDifferenceRecord(JSON.stringify(value)))}\n`;

export const encodeCatalogOverlayDescriptor = (value: CatalogOverlayDescriptor): string =>
  JSON.stringify(decodeCatalogOverlayDescriptor(JSON.stringify(value)));

export const encodeUnifiedCatalogDescriptor = (value: UnifiedCatalogDescriptor): string =>
  JSON.stringify(decodeUnifiedCatalogDescriptor(JSON.stringify(value)));

const invalidBatch = (): never => {
  throw new HybridCatalogError("hybrid-batch-invalid");
};

const parseBatchObject = (raw: string): Readonly<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch {
    return invalidBatch();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidBatch();
  return value as Readonly<Record<string, unknown>>;
};

const batchExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    invalidBatch();
  }
};

const batchString = (value: unknown): string => {
  if (typeof value !== "string" || value !== value.normalize("NFC")) return invalidBatch();
  return value;
};

const batchInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return invalidBatch();
  return value;
};

const batchHash = (value: unknown): string => {
  const text = batchString(value);
  return HASH_PATTERN.test(text) ? text : invalidBatch();
};

const batchLocalId = (value: unknown): string => {
  const text = batchString(value);
  return SAFE_LOCAL_ID_PATTERN.test(text) ? text : invalidBatch();
};

const nullableBatchHash = (value: unknown): string | null => (
  value === null ? null : batchHash(value)
);

const batchSlot = (value: unknown): "a" | "b" => (
  value === "a" || value === "b" ? value : invalidBatch()
);

const decodeBatchScope = (value: unknown) => {
  try {
    return decodeCloudVerificationScope(value);
  } catch {
    return invalidBatch();
  }
};

const sameBatchScope = (
  left: ReturnType<typeof decodeBatchScope>,
  right: ReturnType<typeof decodeBatchScope>,
): boolean => (
  left.generation === right.generation
  && left.sourceImportSha256 === right.sourceImportSha256
  && left.cloudRootSha256 === right.cloudRootSha256
);

const batchGroupKey = (value: unknown): string => {
  const text = batchString(value);
  return text === "txt-root-items" || GROUP_ID_PATTERN.test(text) ? text : invalidBatch();
};

const batchRelativeDirectory = (value: unknown): string => {
  const text = batchString(value);
  if (text === "") return "";
  if (
    text.startsWith("/")
    || text.endsWith("/")
    || text.includes("\\")
    || CONTROL_PATTERN.test(text)
  ) return invalidBatch();
  const segments = text.split("/");
  if (segments.some((segment) => (
    segment.length === 0 || segment === "." || segment === ".." || segment !== segment.trim()
  ))) return invalidBatch();
  return text;
};

const decodeFixedLargeBudget = (value: unknown): typeof LARGE_CATALOG_RUN_BUDGET => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidBatch();
  const record = value as Readonly<Record<string, unknown>>;
  batchExactKeys(record, [
    "maxSelectedTopLevelGroups",
    "maxPdfCount",
    "maxDirectoryCount",
    "maxListRequestCount",
    "maxDurationMs",
  ]);
  if (
    record.maxSelectedTopLevelGroups !== LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups
    || record.maxPdfCount !== LARGE_CATALOG_RUN_BUDGET.maxPdfCount
    || record.maxDirectoryCount !== LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount
    || record.maxListRequestCount !== LARGE_CATALOG_RUN_BUDGET.maxListRequestCount
    || record.maxDurationMs !== LARGE_CATALOG_RUN_BUDGET.maxDurationMs
  ) return invalidBatch();
  return LARGE_CATALOG_RUN_BUDGET;
};

const decodeLargeErrorCounts = (
  value: unknown,
): Readonly<Partial<Record<LargeCatalogErrorCode, number>>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidBatch();
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.some((key) => !LARGE_ERROR_CODES.includes(key as LargeCatalogErrorCode))) {
    return invalidBatch();
  }
  const decoded: Partial<Record<LargeCatalogErrorCode, number>> = {};
  for (const code of LARGE_ERROR_CODES) {
    if (!(code in record)) continue;
    decoded[code] = batchInteger(record[code]);
  }
  return decoded;
};

const decodeLargeStopReason = (value: unknown): LargeCatalogStopReason => {
  if (value === "complete") return value;
  if (
    typeof value === "string"
    && (
      LARGE_PAUSE_REASONS.includes(value as typeof LARGE_PAUSE_REASONS[number])
      || LARGE_ERROR_CODES.includes(value as LargeCatalogErrorCode)
    )
  ) return value as LargeCatalogStopReason;
  return invalidBatch();
};

const decodeLargeGroup = (value: unknown): LargeCatalogBatchGroupV3 => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidBatch();
  const record = value as Readonly<Record<string, unknown>>;
  batchExactKeys(record, [
    "groupKey",
    "rootRelativePath",
    "mode",
    "status",
    "pending",
    "committedPageKeys",
    "completedDirectoryCount",
  ]);
  const groupKey = batchGroupKey(record.groupKey);
  const rootRelativePath = batchRelativeDirectory(record.rootRelativePath);
  const mode = record.mode;
  const status = record.status;
  if (mode !== "recursive" && mode !== "direct-files-only") return invalidBatch();
  if (status !== "pending" && status !== "scanning" && status !== "complete") {
    return invalidBatch();
  }
  if (groupKey === "txt-root-items") {
    if (rootRelativePath !== "" || mode !== "direct-files-only") return invalidBatch();
  } else if (rootRelativePath === "" || mode !== "recursive") {
    return invalidBatch();
  }
  if (!Array.isArray(record.pending) || record.pending.length > LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount) {
    return invalidBatch();
  }
  const pending = record.pending.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return invalidBatch();
    const page = item as Readonly<Record<string, unknown>>;
    batchExactKeys(page, ["relativePath", "start"]);
    const relativePathValue = batchRelativeDirectory(page.relativePath);
    const start = batchInteger(page.start);
    if (start % 1000 !== 0) return invalidBatch();
    return { relativePath: relativePathValue, start };
  });
  const pendingKeys = pending.map((item) => `${item.relativePath}\u0000${item.start}`);
  if (new Set(pendingKeys).size !== pendingKeys.length) return invalidBatch();
  if (!Array.isArray(record.committedPageKeys)) return invalidBatch();
  const committedPageKeys = record.committedPageKeys.map(batchHash);
  if (new Set(committedPageKeys).size !== committedPageKeys.length) return invalidBatch();
  if (status === "complete" && pending.length !== 0) return invalidBatch();
  return {
    groupKey,
    rootRelativePath,
    mode,
    status,
    pending,
    committedPageKeys,
    completedDirectoryCount: batchInteger(record.completedDirectoryCount),
  };
};

export const decodeLargeCatalogBatchCheckpoint = (
  raw: string,
): LargeCatalogBatchCheckpointV3 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "batchId",
    "sourceImportSha256",
    "cloudRootSha256",
    "startedAt",
    "runOrdinal",
    "budget",
    "selectedGroupCount",
    "currentGroupIndex",
    "groups",
    "pdfCount",
    "directoryCount",
    "ignoredFileCount",
    "listRequestCount",
    "cumulativeListRequestCount",
    "status",
    "stopReason",
    "errorCodeCounts",
  ]);
  if (value.schemaVersion !== 3 || !Array.isArray(value.groups)) return invalidBatch();
  const groups = value.groups.map(decodeLargeGroup);
  const selectedGroupCount = batchInteger(
    value.selectedGroupCount,
    1,
    LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups,
  );
  if (groups.length !== selectedGroupCount) return invalidBatch();
  const groupKeys = groups.map((group) => group.groupKey);
  if (new Set(groupKeys).size !== groupKeys.length) return invalidBatch();
  const status = value.status as LargeCatalogBatchStatus;
  if (status !== "scanning" && status !== "complete" && status !== "paused" && status !== "partial") {
    return invalidBatch();
  }
  const stopReason = value.stopReason === null ? null : decodeLargeStopReason(value.stopReason);
  if (
    (status === "scanning" && stopReason !== null)
    || (status !== "scanning" && stopReason === null)
    || (status === "complete" && stopReason !== "complete")
    || (status === "paused" && !LARGE_PAUSE_REASONS.includes(
      stopReason as typeof LARGE_PAUSE_REASONS[number],
    ))
    || (status === "partial" && !LARGE_ERROR_CODES.includes(stopReason as LargeCatalogErrorCode))
  ) return invalidBatch();
  const currentGroupIndex = batchInteger(
    value.currentGroupIndex,
    0,
    status === "complete" ? selectedGroupCount : selectedGroupCount - 1,
  );
  if (groups.some((group, index) => {
    const expected = status === "complete"
      ? "complete"
      : index < currentGroupIndex ? "complete" : index === currentGroupIndex ? "scanning" : "pending";
    return group.status !== expected;
  })) return invalidBatch();
  if (status === "complete" && groups.some((group) => group.status !== "complete")) {
    return invalidBatch();
  }
  const listRequestCount = batchInteger(
    value.listRequestCount,
    0,
    LARGE_CATALOG_RUN_BUDGET.maxListRequestCount,
  );
  const cumulativeListRequestCount = batchInteger(value.cumulativeListRequestCount);
  if (cumulativeListRequestCount < listRequestCount) return invalidBatch();
  return {
    schemaVersion: 3,
    batchId: batchLocalId(value.batchId),
    sourceImportSha256: batchHash(value.sourceImportSha256),
    cloudRootSha256: batchHash(value.cloudRootSha256),
    startedAt: batchInteger(value.startedAt),
    runOrdinal: batchInteger(value.runOrdinal, 1),
    budget: decodeFixedLargeBudget(value.budget),
    selectedGroupCount,
    currentGroupIndex,
    groups,
    pdfCount: batchInteger(value.pdfCount, 0, LARGE_CATALOG_RUN_BUDGET.maxPdfCount),
    directoryCount: batchInteger(
      value.directoryCount,
      0,
      LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount,
    ),
    ignoredFileCount: batchInteger(value.ignoredFileCount),
    listRequestCount,
    cumulativeListRequestCount,
    status,
    stopReason,
    errorCodeCounts: decodeLargeErrorCounts(value.errorCodeCounts),
  };
};

export const encodeLargeCatalogBatchCheckpoint = (
  value: LargeCatalogBatchCheckpointV3,
): string => JSON.stringify(decodeLargeCatalogBatchCheckpoint(JSON.stringify(value)));

export const decodeLargeCatalogBatchCheckpointV3 = decodeLargeCatalogBatchCheckpoint;

export const decodeLargeCatalogBatchCheckpointV4 = (
  raw: string,
): LargeCatalogBatchCheckpointV4 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "batchId",
    "verificationScope",
    "legacyCheckpointSha256",
    "latestReceipt",
    "startedAt",
    "runOrdinal",
    "budget",
    "selectedGroupCount",
    "currentGroupIndex",
    "groups",
    "pdfCount",
    "directoryCount",
    "ignoredFileCount",
    "listRequestCount",
    "cumulativeListRequestCount",
    "status",
    "stopReason",
    "errorCodeCounts",
  ]);
  if (value.schemaVersion !== 4 || !Array.isArray(value.groups)) return invalidBatch();
  const groups = value.groups.map(decodeLargeGroup);
  const selectedGroupCount = batchInteger(
    value.selectedGroupCount,
    1,
    LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups,
  );
  if (groups.length !== selectedGroupCount) return invalidBatch();
  if (new Set(groups.map((group) => group.groupKey)).size !== groups.length) return invalidBatch();
  const status = value.status as LargeCatalogBatchStatus;
  if (status !== "scanning" && status !== "complete" && status !== "paused" && status !== "partial") {
    return invalidBatch();
  }
  const stopReason = value.stopReason === null ? null : decodeLargeStopReason(value.stopReason);
  if (
    (status === "scanning" && stopReason !== null)
    || (status !== "scanning" && stopReason === null)
    || (status === "complete" && stopReason !== "complete")
    || (status === "paused" && !LARGE_PAUSE_REASONS.includes(
      stopReason as typeof LARGE_PAUSE_REASONS[number],
    ))
    || (status === "partial" && !LARGE_ERROR_CODES.includes(stopReason as LargeCatalogErrorCode))
  ) return invalidBatch();
  const currentGroupIndex = batchInteger(
    value.currentGroupIndex,
    0,
    status === "complete" ? selectedGroupCount : selectedGroupCount - 1,
  );
  if (groups.some((group, index) => {
    const expected = status === "complete"
      ? "complete"
      : index < currentGroupIndex ? "complete" : index === currentGroupIndex ? "scanning" : "pending";
    return group.status !== expected;
  })) return invalidBatch();
  const runOrdinal = batchInteger(value.runOrdinal, 1);
  let latestReceipt: LargeCatalogBatchCheckpointV4["latestReceipt"] = null;
  if (value.latestReceipt !== null) {
    if (typeof value.latestReceipt !== "object" || Array.isArray(value.latestReceipt)) {
      return invalidBatch();
    }
    const receipt = value.latestReceipt as Readonly<Record<string, unknown>>;
    batchExactKeys(receipt, ["runOrdinal", "receiptSha256"]);
    const receiptOrdinal = batchInteger(receipt.runOrdinal, 1, runOrdinal);
    if (receiptOrdinal !== runOrdinal && receiptOrdinal !== runOrdinal - 1) {
      return invalidBatch();
    }
    latestReceipt = {
      runOrdinal: receiptOrdinal,
      receiptSha256: batchHash(receipt.receiptSha256),
    };
  }
  const listRequestCount = batchInteger(
    value.listRequestCount,
    0,
    LARGE_CATALOG_RUN_BUDGET.maxListRequestCount,
  );
  const cumulativeListRequestCount = batchInteger(value.cumulativeListRequestCount);
  if (cumulativeListRequestCount < listRequestCount) return invalidBatch();
  return {
    schemaVersion: 4,
    batchId: batchLocalId(value.batchId),
    verificationScope: decodeBatchScope(value.verificationScope),
    legacyCheckpointSha256: nullableBatchHash(value.legacyCheckpointSha256),
    latestReceipt,
    startedAt: batchInteger(value.startedAt),
    runOrdinal,
    budget: decodeFixedLargeBudget(value.budget),
    selectedGroupCount,
    currentGroupIndex,
    groups,
    pdfCount: batchInteger(value.pdfCount, 0, LARGE_CATALOG_RUN_BUDGET.maxPdfCount),
    directoryCount: batchInteger(
      value.directoryCount,
      0,
      LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount,
    ),
    ignoredFileCount: batchInteger(value.ignoredFileCount),
    listRequestCount,
    cumulativeListRequestCount,
    status,
    stopReason,
    errorCodeCounts: decodeLargeErrorCounts(value.errorCodeCounts),
  };
};

export const encodeLargeCatalogBatchCheckpointV4 = (
  value: LargeCatalogBatchCheckpointV4,
): string => JSON.stringify(decodeLargeCatalogBatchCheckpointV4(JSON.stringify(value)));

export const decodeLargeCatalogBatchCheckpointAny = (
  raw: string,
): LargeCatalogBatchCheckpoint => {
  const value = parseBatchObject(raw);
  if (value.schemaVersion === 3) return decodeLargeCatalogBatchCheckpoint(raw);
  if (value.schemaVersion === 4) return decodeLargeCatalogBatchCheckpointV4(raw);
  return invalidBatch();
};

export const decodeLargeCatalogRunReceipt = (raw: string): LargeCatalogRunReceiptV3 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "status",
    "stopReason",
    "startedAt",
    "endedAt",
    "durationMs",
    "budget",
    "selectedGroupCount",
    "completedGroupCount",
    "listRequestCount",
    "cumulativeListRequestCount",
    "directoryCount",
    "pdfCount",
    "ignoredFileCount",
    "downloadedPdfBytes",
    "errorCodeCounts",
  ]);
  if (value.schemaVersion !== 3) return invalidBatch();
  const status = value.status;
  if (status !== "complete" && status !== "paused" && status !== "partial") {
    return invalidBatch();
  }
  const stopReason = decodeLargeStopReason(value.stopReason);
  if (
    (status === "complete" && stopReason !== "complete")
    || (status === "paused" && !LARGE_PAUSE_REASONS.includes(
      stopReason as typeof LARGE_PAUSE_REASONS[number],
    ))
    || (status === "partial" && !LARGE_ERROR_CODES.includes(stopReason as LargeCatalogErrorCode))
  ) return invalidBatch();
  const startedAt = batchInteger(value.startedAt);
  const endedAt = batchInteger(value.endedAt, startedAt);
  if (value.durationMs !== endedAt - startedAt || value.downloadedPdfBytes !== 0) {
    return invalidBatch();
  }
  const selectedGroupCount = batchInteger(
    value.selectedGroupCount,
    1,
    LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups,
  );
  const listRequestCount = batchInteger(
    value.listRequestCount,
    0,
    LARGE_CATALOG_RUN_BUDGET.maxListRequestCount,
  );
  const cumulativeListRequestCount = batchInteger(value.cumulativeListRequestCount);
  if (cumulativeListRequestCount < listRequestCount) return invalidBatch();
  return {
    schemaVersion: 3,
    status,
    stopReason,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    budget: decodeFixedLargeBudget(value.budget),
    selectedGroupCount,
    completedGroupCount: batchInteger(value.completedGroupCount, 0, selectedGroupCount),
    listRequestCount,
    cumulativeListRequestCount,
    directoryCount: batchInteger(
      value.directoryCount,
      0,
      LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount,
    ),
    pdfCount: batchInteger(value.pdfCount, 0, LARGE_CATALOG_RUN_BUDGET.maxPdfCount),
    ignoredFileCount: batchInteger(value.ignoredFileCount),
    downloadedPdfBytes: 0,
    errorCodeCounts: decodeLargeErrorCounts(value.errorCodeCounts),
  };
};

export const encodeLargeCatalogRunReceipt = (value: LargeCatalogRunReceiptV3): string =>
  JSON.stringify(decodeLargeCatalogRunReceipt(JSON.stringify(value)));

export const decodeLargeCatalogRunReceiptV3 = decodeLargeCatalogRunReceipt;

export const decodeLargeCatalogRunReceiptV4 = (raw: string): LargeCatalogRunReceiptV4 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "batchId",
    "runOrdinal",
    "verificationScope",
    "legacyCheckpointSha256",
    "status",
    "stopReason",
    "startedAt",
    "endedAt",
    "durationMs",
    "budget",
    "selectedGroupCount",
    "completedGroupCount",
    "listRequestCount",
    "cumulativeListRequestCount",
    "directoryCount",
    "pdfCount",
    "ignoredFileCount",
    "downloadedPdfBytes",
    "errorCodeCounts",
  ]);
  if (value.schemaVersion !== 4) return invalidBatch();
  const status = value.status;
  if (status !== "complete" && status !== "paused" && status !== "partial") {
    return invalidBatch();
  }
  const stopReason = decodeLargeStopReason(value.stopReason);
  if (
    (status === "complete" && stopReason !== "complete")
    || (status === "paused" && !LARGE_PAUSE_REASONS.includes(
      stopReason as typeof LARGE_PAUSE_REASONS[number],
    ))
    || (status === "partial" && !LARGE_ERROR_CODES.includes(stopReason as LargeCatalogErrorCode))
  ) return invalidBatch();
  const startedAt = batchInteger(value.startedAt);
  const endedAt = batchInteger(value.endedAt, startedAt);
  if (value.durationMs !== endedAt - startedAt || value.downloadedPdfBytes !== 0) {
    return invalidBatch();
  }
  const selectedGroupCount = batchInteger(
    value.selectedGroupCount,
    1,
    LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups,
  );
  const listRequestCount = batchInteger(
    value.listRequestCount,
    0,
    LARGE_CATALOG_RUN_BUDGET.maxListRequestCount,
  );
  const cumulativeListRequestCount = batchInteger(value.cumulativeListRequestCount);
  if (cumulativeListRequestCount < listRequestCount) return invalidBatch();
  return {
    schemaVersion: 4,
    batchId: batchLocalId(value.batchId),
    runOrdinal: batchInteger(value.runOrdinal, 1),
    verificationScope: decodeBatchScope(value.verificationScope),
    legacyCheckpointSha256: nullableBatchHash(value.legacyCheckpointSha256),
    status,
    stopReason,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    budget: decodeFixedLargeBudget(value.budget),
    selectedGroupCount,
    completedGroupCount: batchInteger(value.completedGroupCount, 0, selectedGroupCount),
    listRequestCount,
    cumulativeListRequestCount,
    directoryCount: batchInteger(
      value.directoryCount,
      0,
      LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount,
    ),
    pdfCount: batchInteger(value.pdfCount, 0, LARGE_CATALOG_RUN_BUDGET.maxPdfCount),
    ignoredFileCount: batchInteger(value.ignoredFileCount),
    downloadedPdfBytes: 0,
    errorCodeCounts: decodeLargeErrorCounts(value.errorCodeCounts),
  };
};

export const encodeLargeCatalogRunReceiptV4 = (value: LargeCatalogRunReceiptV4): string =>
  JSON.stringify(decodeLargeCatalogRunReceiptV4(JSON.stringify(value)));

export const decodeLargeCatalogRunReceiptAny = (raw: string): LargeCatalogRunReceipt => {
  const value = parseBatchObject(raw);
  if (value.schemaVersion === 3) return decodeLargeCatalogRunReceipt(raw);
  if (value.schemaVersion === 4) return decodeLargeCatalogRunReceiptV4(raw);
  return invalidBatch();
};

const decodeBatchCloudRecord = (value: unknown): CloudCatalogRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidBatch();
  const record = value as Readonly<Record<string, unknown>>;
  batchExactKeys(record, [
    "schemaVersion",
    "source",
    "fsId",
    "kind",
    "path",
    "parentPath",
    "filename",
    "extension",
    "title",
    "isbnCandidates",
    "sizeBytes",
    "serverModifiedAt",
  ]);
  if (
    record.schemaVersion !== 1
    || record.source !== "baidu-netdisk"
    || record.kind !== "file"
    || record.extension !== "pdf"
  ) return invalidBatch();
  const fsId = batchString(record.fsId);
  if (!DECIMAL_ID_PATTERN.test(fsId)) return invalidBatch();
  let path: string;
  try {
    path = normalizeCloudAbsolutePath(batchString(record.path));
  } catch {
    return invalidBatch();
  }
  const filenameValue = path.slice(path.lastIndexOf("/") + 1);
  const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
  const expectedIsbns = isbnCandidatesFromFilename(filenameValue);
  if (
    record.path !== path
    || record.parentPath !== parentPath
    || record.filename !== filenameValue
    || !/\.pdf$/iu.test(filenameValue)
    || record.title !== filenameValue.slice(0, -4)
    || !Array.isArray(record.isbnCandidates)
    || JSON.stringify(record.isbnCandidates) !== JSON.stringify(expectedIsbns)
  ) return invalidBatch();
  return {
    schemaVersion: 1,
    source: "baidu-netdisk",
    fsId,
    kind: "file",
    path,
    parentPath,
    filename: filenameValue,
    extension: "pdf",
    title: filenameValue.slice(0, -4),
    isbnCandidates: [...expectedIsbns],
    sizeBytes: batchInteger(record.sizeBytes),
    serverModifiedAt: batchInteger(record.serverModifiedAt),
  };
};

const decodeBatchIdentities = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 1000) return invalidBatch();
  const identities = value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return invalidBatch();
    const record = item as Readonly<Record<string, unknown>>;
    batchExactKeys(record, ["fsId", "path"]);
    const fsId = batchString(record.fsId);
    if (!DECIMAL_ID_PATTERN.test(fsId)) return invalidBatch();
    let path: string;
    try {
      path = normalizeCloudAbsolutePath(batchString(record.path));
    } catch {
      return invalidBatch();
    }
    if (record.path !== path) return invalidBatch();
    return { fsId, path };
  });
  if (
    new Set(identities.map((item) => item.fsId)).size !== identities.length
    || new Set(identities.map((item) => item.path)).size !== identities.length
    || identities.some((item, index) => {
      const prior = identities[index - 1];
      return prior !== undefined && (
        prior.path > item.path || (prior.path === item.path && prior.fsId >= item.fsId)
      );
    })
  ) return invalidBatch();
  return identities;
};

export const decodeLargeCatalogActiveCheckpointPointer = (
  raw: string,
): LargeCatalogActiveCheckpointPointerV1 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "batchId",
    "activeSlot",
    "activeCheckpointSha256",
    "legacyCheckpointSha256",
    "verificationScope",
  ]);
  if (value.schemaVersion !== 1) return invalidBatch();
  return {
    schemaVersion: 1,
    batchId: batchLocalId(value.batchId),
    activeSlot: batchSlot(value.activeSlot),
    activeCheckpointSha256: batchHash(value.activeCheckpointSha256),
    legacyCheckpointSha256: nullableBatchHash(value.legacyCheckpointSha256),
    verificationScope: decodeBatchScope(value.verificationScope),
  };
};

export const encodeLargeCatalogActiveCheckpointPointer = (
  value: LargeCatalogActiveCheckpointPointerV1,
): string => JSON.stringify(decodeLargeCatalogActiveCheckpointPointer(JSON.stringify(value)));

export const decodeLargeCatalogBatchStagingManifest = (
  raw: string,
): LargeCatalogBatchStagingManifestV1 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "batchId",
    "nonce",
    "activeCheckpointSha256",
    "activePointerSha256",
    "verificationScope",
  ]);
  if (value.schemaVersion !== 1) return invalidBatch();
  return {
    schemaVersion: 1,
    batchId: batchLocalId(value.batchId),
    nonce: batchLocalId(value.nonce),
    activeCheckpointSha256: batchHash(value.activeCheckpointSha256),
    activePointerSha256: batchHash(value.activePointerSha256),
    verificationScope: decodeBatchScope(value.verificationScope),
  };
};

export const encodeLargeCatalogBatchStagingManifest = (
  value: LargeCatalogBatchStagingManifestV1,
): string => JSON.stringify(decodeLargeCatalogBatchStagingManifest(JSON.stringify(value)));

export const decodeLargeCatalogBatchClaim = (raw: string): LargeCatalogBatchClaimV1 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, ["schemaVersion", "batchId", "nonce", "stagingManifestSha256"]);
  if (value.schemaVersion !== 1) return invalidBatch();
  return {
    schemaVersion: 1,
    batchId: batchLocalId(value.batchId),
    nonce: batchLocalId(value.nonce),
    stagingManifestSha256: batchHash(value.stagingManifestSha256),
  };
};

export const encodeLargeCatalogBatchClaim = (value: LargeCatalogBatchClaimV1): string =>
  JSON.stringify(decodeLargeCatalogBatchClaim(JSON.stringify(value)));

export const decodeLargeCatalogBatchOperationJournal = (
  raw: string,
): LargeCatalogBatchOperationJournalV1 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "state",
    "operationId",
    "operationKind",
    "batchId",
    "verificationScope",
    "legacyCheckpointSha256",
    "runOrdinal",
    "priorActivePointerSha256",
    "targetSlot",
    "targetCheckpointSha256",
    "pageKey",
    "pageEnvelopeSha256",
    "receiptSha256",
  ]);
  if (value.schemaVersion !== 1) return invalidBatch();
  const state = value.state;
  const operationKind = value.operationKind;
  if ((state !== "prepared" && state !== "settled")
    || (operationKind !== "page" && operationKind !== "finalize")) {
    return invalidBatch();
  }
  const pageKey = value.pageKey === null ? null : batchHash(value.pageKey);
  const pageEnvelopeSha256 = nullableBatchHash(value.pageEnvelopeSha256);
  const receiptSha256 = nullableBatchHash(value.receiptSha256);
  if (
    (operationKind === "page" && (
      pageKey === null || pageEnvelopeSha256 === null || receiptSha256 !== null
    ))
    || (operationKind === "finalize" && (
      pageKey !== null || pageEnvelopeSha256 !== null || receiptSha256 === null
    ))
  ) return invalidBatch();
  return {
    schemaVersion: 1,
    state,
    operationId: batchLocalId(value.operationId),
    operationKind,
    batchId: batchLocalId(value.batchId),
    verificationScope: decodeBatchScope(value.verificationScope),
    legacyCheckpointSha256: nullableBatchHash(value.legacyCheckpointSha256),
    runOrdinal: batchInteger(value.runOrdinal, 1),
    priorActivePointerSha256: batchHash(value.priorActivePointerSha256),
    targetSlot: batchSlot(value.targetSlot),
    targetCheckpointSha256: batchHash(value.targetCheckpointSha256),
    pageKey,
    pageEnvelopeSha256,
    receiptSha256,
  };
};

export const encodeLargeCatalogBatchOperationJournal = (
  value: LargeCatalogBatchOperationJournalV1,
): string => JSON.stringify(decodeLargeCatalogBatchOperationJournal(JSON.stringify(value)));

export const decodeLargeCatalogBatchPageEnvelopeV3 = (
  raw: string,
): LargeCatalogBatchPageEnvelopeV3 => {
  const value = parseBatchObject(raw);
  batchExactKeys(value, [
    "schemaVersion",
    "pageKey",
    "verificationScope",
    "legacyCheckpointSha256",
    "priorCheckpointSha256",
    "nextCheckpointSha256",
    "records",
    "identities",
    "nextCheckpoint",
  ]);
  if (
    value.schemaVersion !== 3
    || !Array.isArray(value.records)
    || value.records.length > 1000
  ) return invalidBatch();
  const pageKey = batchHash(value.pageKey);
  const verificationScope = decodeBatchScope(value.verificationScope);
  const legacyCheckpointSha256 = nullableBatchHash(value.legacyCheckpointSha256);
  const records = value.records.map(decodeBatchCloudRecord);
  if (
    new Set(records.map((record) => record.fsId)).size !== records.length
    || new Set(records.map((record) => record.path)).size !== records.length
  ) return invalidBatch();
  const identities = decodeBatchIdentities(value.identities);
  const identityKeys = new Set(identities.map((item) => `${item.fsId}\u0000${item.path}`));
  if (records.some((record) => !identityKeys.has(`${record.fsId}\u0000${record.path}`))) {
    return invalidBatch();
  }
  const nextCheckpoint = decodeLargeCatalogBatchCheckpointV4(
    JSON.stringify(value.nextCheckpoint),
  );
  if (
    !sameBatchScope(verificationScope, nextCheckpoint.verificationScope)
    || legacyCheckpointSha256 !== nextCheckpoint.legacyCheckpointSha256
    || !nextCheckpoint.groups.some((group) => group.committedPageKeys.includes(pageKey))
  ) return invalidBatch();
  const nextCheckpointSha256 = batchHash(value.nextCheckpointSha256);
  const canonicalNextHash = createHash("sha256")
    .update(`${encodeLargeCatalogBatchCheckpointV4(nextCheckpoint)}\n`, "utf8")
    .digest("hex");
  if (nextCheckpointSha256 !== canonicalNextHash) return invalidBatch();
  return {
    schemaVersion: 3,
    pageKey,
    verificationScope,
    legacyCheckpointSha256,
    priorCheckpointSha256: batchHash(value.priorCheckpointSha256),
    nextCheckpointSha256,
    records,
    identities,
    nextCheckpoint,
  };
};

export const encodeLargeCatalogBatchPageEnvelopeV3 = (
  value: LargeCatalogBatchPageEnvelopeV3,
): string => JSON.stringify(decodeLargeCatalogBatchPageEnvelopeV3(JSON.stringify(value)));
