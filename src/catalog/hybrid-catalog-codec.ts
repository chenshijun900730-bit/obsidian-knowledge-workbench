import JSONbigFactory from "json-bigint";
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
  type LargeCatalogBatchGroupV3,
  type LargeCatalogBatchStatus,
  type LargeCatalogErrorCode,
  type LargeCatalogRunReceiptV3,
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
  exactKeys(value, [
    "schemaVersion",
    "snapshotId",
    "sourceImportSha256",
    "completedAt",
    "recordCount",
    "differenceCount",
    "catalogSha256",
    "differencesSha256",
  ]);
  return {
    schemaVersion: literal(value.schemaVersion, 1),
    snapshotId: safeLocalId(value.snapshotId),
    sourceImportSha256: hash(value.sourceImportSha256),
    completedAt: safeInteger(value.completedAt),
    recordCount: safeInteger(value.recordCount, 0, MAX_UNIFIED_CATALOG_PDF_COUNT),
    differenceCount: safeInteger(value.differenceCount),
    catalogSha256: hash(value.catalogSha256),
    differencesSha256: hash(value.differencesSha256),
  };
};

export const decodeCatalogOverlayDescriptor = (raw: string): CatalogOverlayDescriptor => {
  const value = parseObject(raw);
  exactKeys(value, [
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
  ]);
  return {
    schemaVersion: literal(value.schemaVersion, 1),
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
};

export const encodeTxtCandidateRecordLine = (value: TxtCandidateRecordV1): string =>
  `${JSON.stringify(decodeTxtCandidateRecord(JSON.stringify(value)))}\n`;

export const encodeUnifiedCatalogRecordLine = (value: UnifiedCatalogRecordV1): string =>
  `${JSON.stringify(decodeUnifiedCatalogRecord(JSON.stringify(value)))}\n`;

export const encodeCatalogDifferenceRecordLine = (value: CatalogDifferenceRecordV1): string =>
  `${JSON.stringify(decodeCatalogDifferenceRecord(JSON.stringify(value)))}\n`;

export const encodeCatalogOverlayDescriptor = (value: CatalogOverlayDescriptor): string =>
  JSON.stringify(decodeCatalogOverlayDescriptor(JSON.stringify(value)));

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
    decoded[code] = batchInteger(record[code], 1);
  }
  if (JSON.stringify(record) !== JSON.stringify(decoded)) return invalidBatch();
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
