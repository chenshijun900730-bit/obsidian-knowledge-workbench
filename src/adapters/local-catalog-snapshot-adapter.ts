import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename as nodeRename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { normalizeCloudAbsolutePath } from "../catalog/catalog-path";
import type { CatalogSnapshotPort } from "../catalog/catalog-ports";
import {
  CatalogError,
  type CatalogErrorCode,
  type CatalogScanBudget,
  type CatalogScanCheckpoint,
  type CatalogScanCheckpointV1,
  type CatalogScanCheckpointV2,
  type CatalogScanFinalization,
  type CatalogScanFinalizationResult,
  type CatalogScanPauseReason,
  type CatalogScanReceipt,
  type CatalogScanReceiptV1,
  type CatalogScanReceiptV2,
  type CatalogScanStopReason,
  type CatalogSnapshotDescriptor,
  type CatalogSnapshotRecord,
  type CloudCatalogDirectory,
  type CloudCatalogRecord,
} from "../catalog/catalog-types";

const SCAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PAGE_KEY = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ERROR_CODES = new Set<CatalogErrorCode>([
  "authorization-canceled",
  "authorization-attempt-unavailable",
  "authorization-attempt-expired",
  "authorization-code-invalid",
  "authorization-exchange-failed",
  "credentials-unavailable",
  "invalid-scan-root",
  "baidu-permission-denied",
  "baidu-not-found",
  "baidu-rate-limited",
  "baidu-token-expired",
  "baidu-access-unavailable",
  "invalid-baidu-response",
  "snapshot-corrupt",
]);
const PAUSE_REASONS = new Set<CatalogScanPauseReason>([
  "user-canceled",
  "pdf-limit",
  "directory-limit",
  "list-request-limit",
  "time-limit",
]);
const CHECKPOINT_V1_KEYS = [
  "schemaVersion",
  "scanId",
  "rootPath",
  "startedAt",
  "pending",
  "committedPageKeys",
  "completedDirectoryCount",
  "directoryCount",
  "pdfCount",
  "ignoredFileCount",
  "errorCodeCounts",
  "retryCount",
  "status",
] as const;
const CHECKPOINT_V2_KEYS = [
  "schemaVersion",
  "scanId",
  "rootPath",
  "startedAt",
  "budget",
  "listRequestCount",
  "pending",
  "committedPageKeys",
  "completedDirectoryCount",
  "directoryCount",
  "pdfCount",
  "ignoredFileCount",
  "errorCodeCounts",
  "retryCount",
  "status",
  "pauseReason",
] as const;
const RECEIPT_V1_KEYS = [
  "schemaVersion",
  "status",
  "startedAt",
  "completedAt",
  "directoryCount",
  "pdfCount",
  "ignoredFileCount",
  "errorCodeCounts",
  "retryCount",
  "snapshotSha256",
] as const;
const RECEIPT_V2_KEYS = [
  "schemaVersion",
  "status",
  "stopReason",
  "startedAt",
  "endedAt",
  "durationMs",
  "budget",
  "listRequestCount",
  "directoryCount",
  "pdfCount",
  "ignoredFileCount",
  "downloadedPdfBytes",
  "errorCodeCounts",
  "retryCount",
  "snapshotSha256",
] as const;

export interface AtomicRenamePort {
  rename(source: string, destination: string): Promise<void>;
}

const NODE_RENAME_PORT: AtomicRenamePort = { rename: nodeRename };

type JsonRecord = Readonly<Record<string, unknown>>;
type PageState = Readonly<{
  schemaVersion: 1;
  pageKey: string;
  sha256: string;
  nextCheckpoint: CatalogScanCheckpoint;
}>;

function corrupt(): never {
  throw new CatalogError("snapshot-corrupt");
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error as Readonly<{ code?: unknown }>).code === "ENOENT";

const asRecord = (value: unknown): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) corrupt();
  return value as JsonRecord;
};

const hasExactKeys = (value: JsonRecord, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === "string" && keys.includes(key));
};

const safeNonNegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) corrupt();
  return value;
};

const safePositiveInteger = (value: unknown): number => {
  const decoded = safeNonNegativeInteger(value);
  if (decoded === 0) corrupt();
  return decoded;
};

const decimalId = (value: unknown): string => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) corrupt();
  return value;
};

const normalizedPath = (value: unknown): string => {
  if (typeof value !== "string") corrupt();
  try {
    return normalizeCloudAbsolutePath(value);
  } catch {
    return corrupt();
  }
};

const normalizedText = (value: unknown, allowEmpty = false): string => {
  if (typeof value !== "string") corrupt();
  const normalized = value.normalize("NFC");
  if (!allowEmpty && normalized.length === 0) corrupt();
  return normalized;
};

const errorCodeCounts = (value: unknown): Readonly<Partial<Record<CatalogErrorCode, number>>> => {
  const record = asRecord(value);
  const result: Partial<Record<CatalogErrorCode, number>> = {};
  for (const [key, count] of Object.entries(record)) {
    if (!ERROR_CODES.has(key as CatalogErrorCode)) corrupt();
    result[key as CatalogErrorCode] = safeNonNegativeInteger(count);
  }
  return result;
};

const decodeBudget = (value: unknown): CatalogScanBudget => {
  const record = asRecord(value);
  if (!hasExactKeys(record, [
    "maxPdfCount",
    "maxDirectoryCount",
    "maxListRequestCount",
    "maxDurationMs",
  ])) corrupt();
  return {
    maxPdfCount: safePositiveInteger(record.maxPdfCount),
    maxDirectoryCount: safePositiveInteger(record.maxDirectoryCount),
    maxListRequestCount: safePositiveInteger(record.maxListRequestCount),
    maxDurationMs: safePositiveInteger(record.maxDurationMs),
  };
};

const decodePauseReason = (value: unknown): CatalogScanPauseReason => {
  if (typeof value !== "string" || !PAUSE_REASONS.has(value as CatalogScanPauseReason)) corrupt();
  return value as CatalogScanPauseReason;
};

const decodeStopReason = (value: unknown): CatalogScanStopReason => {
  if (value === "complete") return value;
  if (typeof value !== "string") corrupt();
  if (PAUSE_REASONS.has(value as CatalogScanPauseReason)) return value as CatalogScanPauseReason;
  if (ERROR_CODES.has(value as CatalogErrorCode)) return value as CatalogErrorCode;
  return corrupt();
};

const decodeStatus = (value: unknown): CatalogScanCheckpoint["status"] => {
  if (value !== "scanning" && value !== "paused" && value !== "partial") corrupt();
  return value;
};

const decodeReceiptStatus = (value: unknown): CatalogScanReceipt["status"] => {
  if (value !== "complete" && value !== "paused" && value !== "partial") corrupt();
  return value;
};

const decodeSha256 = (value: unknown): string => {
  if (typeof value !== "string" || !SHA256.test(value)) corrupt();
  return value;
};

const decodeScanIdentity = (record: JsonRecord): Readonly<{
  scanId: string;
  rootPath: string;
  startedAt: number;
}> => {
  if (typeof record.scanId !== "string" || !SCAN_ID.test(record.scanId)) corrupt();
  return {
    scanId: record.scanId,
    rootPath: normalizedPath(record.rootPath),
    startedAt: safeNonNegativeInteger(record.startedAt),
  };
};

const decodePending = (value: unknown): readonly Readonly<{ path: string; start: number }>[] => {
  if (!Array.isArray(value)) corrupt();
  return value.map((item) => {
    const entry = asRecord(item);
    if (!hasExactKeys(entry, ["path", "start"])) corrupt();
    return {
      path: normalizedPath(entry.path),
      start: safeNonNegativeInteger(entry.start),
    };
  });
};

const decodeCommittedPageKeys = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) corrupt();
  const committedPageKeys = value.map((key) => {
    if (typeof key !== "string" || !PAGE_KEY.test(key)) corrupt();
    return key;
  });
  if (new Set(committedPageKeys).size !== committedPageKeys.length) corrupt();
  return committedPageKeys;
};

const decodeCheckpointV1 = (record: JsonRecord): CatalogScanCheckpointV1 => {
  if (!hasExactKeys(record, CHECKPOINT_V1_KEYS) || record.schemaVersion !== 1) corrupt();
  return {
    schemaVersion: 1,
    ...decodeScanIdentity(record),
    pending: decodePending(record.pending),
    committedPageKeys: decodeCommittedPageKeys(record.committedPageKeys),
    completedDirectoryCount: safeNonNegativeInteger(record.completedDirectoryCount),
    directoryCount: safeNonNegativeInteger(record.directoryCount),
    pdfCount: safeNonNegativeInteger(record.pdfCount),
    ignoredFileCount: safeNonNegativeInteger(record.ignoredFileCount),
    errorCodeCounts: errorCodeCounts(record.errorCodeCounts),
    retryCount: safeNonNegativeInteger(record.retryCount),
    status: decodeStatus(record.status),
  };
};

const decodeCheckpointV2 = (record: JsonRecord): CatalogScanCheckpointV2 => {
  if (!hasExactKeys(record, CHECKPOINT_V2_KEYS) || record.schemaVersion !== 2) corrupt();
  const budget = decodeBudget(record.budget);
  const listRequestCount = safeNonNegativeInteger(record.listRequestCount);
  const directoryCount = safeNonNegativeInteger(record.directoryCount);
  const pdfCount = safeNonNegativeInteger(record.pdfCount);
  const status = decodeStatus(record.status);
  const pauseReason = record.pauseReason === null ? null : decodePauseReason(record.pauseReason);
  if (
    listRequestCount > budget.maxListRequestCount
    || directoryCount > budget.maxDirectoryCount
    || pdfCount > budget.maxPdfCount
    || (status !== "paused" && pauseReason !== null)
  ) corrupt();
  return {
    schemaVersion: 2,
    ...decodeScanIdentity(record),
    budget,
    listRequestCount,
    pending: decodePending(record.pending),
    committedPageKeys: decodeCommittedPageKeys(record.committedPageKeys),
    completedDirectoryCount: safeNonNegativeInteger(record.completedDirectoryCount),
    directoryCount,
    pdfCount,
    ignoredFileCount: safeNonNegativeInteger(record.ignoredFileCount),
    errorCodeCounts: errorCodeCounts(record.errorCodeCounts),
    retryCount: safeNonNegativeInteger(record.retryCount),
    status,
    pauseReason,
  };
};

const decodeCheckpoint = (value: unknown): CatalogScanCheckpoint => {
  const record = asRecord(value);
  if (record.schemaVersion === 1) return decodeCheckpointV1(record);
  if (record.schemaVersion === 2) return decodeCheckpointV2(record);
  return corrupt();
};

const validateStopReasonForStatus = (
  status: CatalogScanReceipt["status"],
  stopReason: CatalogScanStopReason,
): void => {
  if (status === "complete") {
    if (stopReason !== "complete") corrupt();
    return;
  }
  if (status === "paused") {
    if (
      stopReason !== "baidu-rate-limited"
      && !PAUSE_REASONS.has(stopReason as CatalogScanPauseReason)
    ) corrupt();
    return;
  }
  if (!ERROR_CODES.has(stopReason as CatalogErrorCode) || stopReason === "baidu-rate-limited") corrupt();
};

const decodeReceiptV1 = (record: JsonRecord): CatalogScanReceiptV1 => {
  if (
    !hasExactKeys(record, RECEIPT_V1_KEYS)
    || record.schemaVersion !== 1
    || record.status !== "complete"
  ) corrupt();
  return {
    schemaVersion: 1,
    status: "complete",
    startedAt: safeNonNegativeInteger(record.startedAt),
    completedAt: safeNonNegativeInteger(record.completedAt),
    directoryCount: safeNonNegativeInteger(record.directoryCount),
    pdfCount: safeNonNegativeInteger(record.pdfCount),
    ignoredFileCount: safeNonNegativeInteger(record.ignoredFileCount),
    errorCodeCounts: errorCodeCounts(record.errorCodeCounts),
    retryCount: safeNonNegativeInteger(record.retryCount),
    snapshotSha256: decodeSha256(record.snapshotSha256),
  };
};

const decodeReceiptV2 = (record: JsonRecord): CatalogScanReceiptV2 => {
  if (!hasExactKeys(record, RECEIPT_V2_KEYS) || record.schemaVersion !== 2) corrupt();
  const status = decodeReceiptStatus(record.status);
  const stopReason = decodeStopReason(record.stopReason);
  const startedAt = safeNonNegativeInteger(record.startedAt);
  const endedAt = safeNonNegativeInteger(record.endedAt);
  const durationMs = safeNonNegativeInteger(record.durationMs);
  const budget = decodeBudget(record.budget);
  const listRequestCount = safeNonNegativeInteger(record.listRequestCount);
  const directoryCount = safeNonNegativeInteger(record.directoryCount);
  const pdfCount = safeNonNegativeInteger(record.pdfCount);
  if (
    endedAt < startedAt
    || durationMs !== endedAt - startedAt
    || record.downloadedPdfBytes !== 0
    || listRequestCount > budget.maxListRequestCount
    || directoryCount > budget.maxDirectoryCount
    || pdfCount > budget.maxPdfCount
  ) corrupt();
  const snapshotSha256 = record.snapshotSha256 === null
    ? null
    : decodeSha256(record.snapshotSha256);
  if ((status === "complete") !== (snapshotSha256 !== null)) corrupt();
  validateStopReasonForStatus(status, stopReason);
  return {
    schemaVersion: 2,
    status,
    stopReason,
    startedAt,
    endedAt,
    durationMs,
    budget,
    listRequestCount,
    directoryCount,
    pdfCount,
    ignoredFileCount: safeNonNegativeInteger(record.ignoredFileCount),
    downloadedPdfBytes: 0,
    errorCodeCounts: errorCodeCounts(record.errorCodeCounts),
    retryCount: safeNonNegativeInteger(record.retryCount),
    snapshotSha256,
  };
};

const decodeReceipt = (value: unknown): CatalogScanReceipt => {
  const record = asRecord(value);
  if (record.schemaVersion === 1) return decodeReceiptV1(record);
  if (record.schemaVersion === 2) return decodeReceiptV2(record);
  return corrupt();
};

const decodeIsbnCandidates = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) corrupt();
  const candidates = value.map((candidate) => {
    if (typeof candidate !== "string" || !/^(?:\d{13}|\d{9}[\dX])$/u.test(candidate)) corrupt();
    return candidate;
  });
  if (new Set(candidates).size !== candidates.length) corrupt();
  return candidates;
};

const decodeFileRecord = (record: JsonRecord): CloudCatalogRecord => {
  if (!hasExactKeys(record, [
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
  ])) corrupt();
  if (record.schemaVersion !== 1 || record.source !== "baidu-netdisk" || record.kind !== "file" || record.extension !== "pdf") corrupt();
  return {
    schemaVersion: 1,
    source: "baidu-netdisk",
    fsId: decimalId(record.fsId),
    kind: "file",
    path: normalizedPath(record.path),
    parentPath: normalizedPath(record.parentPath),
    filename: normalizedText(record.filename),
    extension: "pdf",
    title: normalizedText(record.title, true),
    isbnCandidates: decodeIsbnCandidates(record.isbnCandidates),
    sizeBytes: safeNonNegativeInteger(record.sizeBytes),
    serverModifiedAt: safeNonNegativeInteger(record.serverModifiedAt),
  };
};

const decodeDirectoryRecord = (record: JsonRecord): CloudCatalogDirectory => {
  if (!hasExactKeys(record, [
    "schemaVersion",
    "source",
    "fsId",
    "kind",
    "path",
    "parentPath",
    "filename",
    "sizeBytes",
    "serverModifiedAt",
  ])) corrupt();
  if (record.schemaVersion !== 1 || record.source !== "baidu-netdisk" || record.kind !== "directory" || record.sizeBytes !== 0) corrupt();
  return {
    schemaVersion: 1,
    source: "baidu-netdisk",
    fsId: decimalId(record.fsId),
    kind: "directory",
    path: normalizedPath(record.path),
    parentPath: normalizedPath(record.parentPath),
    filename: normalizedText(record.filename),
    sizeBytes: 0,
    serverModifiedAt: safeNonNegativeInteger(record.serverModifiedAt),
  };
};

const decodeSnapshotRecord = (value: unknown): CatalogSnapshotRecord => {
  const record = asRecord(value);
  if (record.kind === "file") return decodeFileRecord(record);
  if (record.kind === "directory") return decodeDirectoryRecord(record);
  return corrupt();
};

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return corrupt();
  }
};

const canonicalJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

const pageBytes = (records: readonly CatalogSnapshotRecord[]): Buffer => Buffer.from(
  records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  "utf8",
);

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const decodePageRecords = (content: Buffer): readonly CatalogSnapshotRecord[] => {
  const raw = content.toString("utf8");
  if (raw.length === 0) return [];
  if (!raw.endsWith("\n")) corrupt();
  const lines = raw.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) corrupt();
  return lines.map((line) => decodeSnapshotRecord(parseJson(line)));
};

const decodePageState = (value: unknown): PageState => {
  const record = asRecord(value);
  if (!hasExactKeys(record, ["schemaVersion", "pageKey", "sha256", "nextCheckpoint"])) corrupt();
  if (
    record.schemaVersion !== 1
    || typeof record.pageKey !== "string"
    || !PAGE_KEY.test(record.pageKey)
    || typeof record.sha256 !== "string"
    || !SHA256.test(record.sha256)
  ) corrupt();
  return {
    schemaVersion: 1,
    pageKey: record.pageKey,
    sha256: record.sha256,
    nextCheckpoint: decodeCheckpoint(record.nextCheckpoint),
  };
};

const decodeDescriptor = (value: unknown): CatalogSnapshotDescriptor => {
  const record = asRecord(value);
  if (!hasExactKeys(record, ["snapshotId", "schemaVersion", "completedAt", "recordCount", "pdfCount", "sha256"])) corrupt();
  if (
    typeof record.snapshotId !== "string"
    || !SCAN_ID.test(record.snapshotId)
    || record.schemaVersion !== 1
    || typeof record.sha256 !== "string"
    || !SHA256.test(record.sha256)
  ) corrupt();
  return {
    snapshotId: record.snapshotId,
    schemaVersion: 1,
    completedAt: safeNonNegativeInteger(record.completedAt),
    recordCount: safeNonNegativeInteger(record.recordCount),
    pdfCount: safeNonNegativeInteger(record.pdfCount),
    sha256: record.sha256,
  };
};

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const immutableScanState = (checkpoint: CatalogScanCheckpoint): unknown => ({
  schemaVersion: checkpoint.schemaVersion,
  scanId: checkpoint.scanId,
  rootPath: checkpoint.rootPath,
  startedAt: checkpoint.startedAt,
  ...(checkpoint.schemaVersion === 2 ? { budget: checkpoint.budget } : {}),
  pending: checkpoint.pending,
  committedPageKeys: checkpoint.committedPageKeys,
  completedDirectoryCount: checkpoint.completedDirectoryCount,
  directoryCount: checkpoint.directoryCount,
  pdfCount: checkpoint.pdfCount,
  ignoredFileCount: checkpoint.ignoredFileCount,
});

const sameImmutableScanState = (
  left: CatalogScanCheckpoint,
  right: CatalogScanCheckpoint,
): boolean => sameJson(immutableScanState(left), immutableScanState(right));

const incrementedErrorCode = (
  current: Readonly<Partial<Record<CatalogErrorCode, number>>>,
  next: Readonly<Partial<Record<CatalogErrorCode, number>>>,
): CatalogErrorCode | null => {
  let incremented: CatalogErrorCode | null = null;
  for (const code of ERROR_CODES) {
    const before = current[code] ?? 0;
    const after = next[code] ?? 0;
    if (after === before) continue;
    if (after !== before + 1 || incremented !== null) return null;
    incremented = code;
  }
  return incremented;
};

const validV2StateTransition = (
  current: CatalogScanCheckpointV2,
  next: CatalogScanCheckpointV2,
): boolean => {
  if (!sameImmutableScanState(current, next)) return false;
  if (sameJson(current, next)) return true;
  if (current.status !== "scanning" || current.pauseReason !== null) return false;
  if (next.listRequestCount === current.listRequestCount + 1) {
    return next.status === "scanning"
      && next.pauseReason === null
      && next.retryCount === current.retryCount
      && sameJson(next.errorCodeCounts, current.errorCodeCounts);
  }
  if (next.listRequestCount !== current.listRequestCount) return false;
  if (next.status === "paused" && next.pauseReason !== null) {
    return next.retryCount === current.retryCount
      && sameJson(next.errorCodeCounts, current.errorCodeCounts);
  }
  const incremented = incrementedErrorCode(current.errorCodeCounts, next.errorCodeCounts);
  if (next.status === "paused" && next.pauseReason === null) {
    return incremented === "baidu-rate-limited"
      && next.retryCount === current.retryCount + 1;
  }
  if (next.status === "partial" && next.pauseReason === null) {
    return incremented !== null
      && incremented !== "baidu-rate-limited"
      && next.retryCount === current.retryCount;
  }
  return false;
};

const validStateTransition = (
  current: CatalogScanCheckpoint,
  next: CatalogScanCheckpoint,
): boolean => {
  if (current.schemaVersion !== next.schemaVersion) return false;
  if (current.schemaVersion === 1 && next.schemaVersion === 1) {
    return sameImmutableScanState(current, next);
  }
  if (current.schemaVersion === 2 && next.schemaVersion === 2) {
    return validV2StateTransition(current, next);
  }
  return false;
};

const extendsCheckpoint = (
  current: CatalogScanCheckpoint,
  next: CatalogScanCheckpoint,
  pageKey: string,
): boolean => next.schemaVersion === current.schemaVersion
  && next.scanId === current.scanId
  && next.rootPath === current.rootPath
  && next.startedAt === current.startedAt
  && next.committedPageKeys.length === current.committedPageKeys.length + 1
  && current.committedPageKeys.every((key, index) => next.committedPageKeys[index] === key)
  && next.committedPageKeys.at(-1) === pageKey
  && next.completedDirectoryCount >= current.completedDirectoryCount
  && next.directoryCount >= current.directoryCount
  && next.pdfCount >= current.pdfCount
  && next.ignoredFileCount >= current.ignoredFileCount
  && (
    current.schemaVersion === 1
    || (
      next.schemaVersion === 2
      && sameJson(next.budget, current.budget)
      && next.listRequestCount === current.listRequestCount
      && current.status === "scanning"
      && next.status === "scanning"
      && current.pauseReason === null
      && next.pauseReason === null
      && next.retryCount === current.retryCount
      && sameJson(next.errorCodeCounts, current.errorCodeCounts)
    )
  );

const validateRecordSet = (records: readonly CatalogSnapshotRecord[]): void => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const record of records) {
    if (ids.has(record.fsId) || paths.has(record.path)) corrupt();
    ids.add(record.fsId);
    paths.add(record.path);
    const separator = record.path.lastIndexOf("/");
    const expectedParent = record.path.slice(0, separator) || "/";
    const expectedFilename = record.path.slice(separator + 1);
    if (record.parentPath !== expectedParent || record.filename !== expectedFilename) corrupt();
  }
};

const validateFinalization = (input: CatalogScanFinalization): Readonly<{
  checkpoint: CatalogScanCheckpointV2;
  status: CatalogScanFinalization["status"];
  stopReason: CatalogScanStopReason;
  endedAt: number;
}> => {
  const decoded = decodeCheckpoint(input.checkpoint);
  if (decoded.schemaVersion !== 2) corrupt();
  const status = decodeReceiptStatus(input.status);
  const stopReason = decodeStopReason(input.stopReason);
  const endedAt = safeNonNegativeInteger(input.endedAt);
  if (endedAt < decoded.startedAt) corrupt();
  validateStopReasonForStatus(status, stopReason);
  if (status === "complete") {
    if (
      decoded.status !== "scanning"
      || decoded.pauseReason !== null
      || decoded.pending.length !== 0
    ) corrupt();
  } else if (status === "paused") {
    if (decoded.status !== "paused") corrupt();
    if (PAUSE_REASONS.has(stopReason as CatalogScanPauseReason)) {
      if (decoded.pauseReason !== stopReason) corrupt();
    } else if (
      stopReason !== "baidu-rate-limited"
      || decoded.pauseReason !== null
      || (decoded.errorCodeCounts["baidu-rate-limited"] ?? 0) === 0
    ) corrupt();
  } else if (
    decoded.status !== "partial"
    || decoded.pauseReason !== null
    || !ERROR_CODES.has(stopReason as CatalogErrorCode)
    || (decoded.errorCodeCounts[stopReason as CatalogErrorCode] ?? 0) === 0
  ) corrupt();
  return { checkpoint: decoded, status, stopReason, endedAt };
};

export class LocalCatalogSnapshotAdapter implements CatalogSnapshotPort {
  private initialized = false;

  constructor(
    private readonly root: string,
    private readonly renames: AtomicRenamePort = NODE_RENAME_PORT,
  ) {}

  async createScan(checkpoint: CatalogScanCheckpoint): Promise<void> {
    await this.ensureRoot();
    const decoded = decodeCheckpoint(checkpoint);
    const paths = this.scanPaths(decoded.scanId);
    const existing = await this.readJsonIfExists(paths.checkpoint);
    if (existing !== null) {
      if (!sameJson(decodeCheckpoint(existing), decoded)) corrupt();
      return;
    }
    await this.privateDirectory(paths.pages);
    await this.writeJsonAtomic(paths.checkpoint, decoded);
  }

  async commitPage(input: Readonly<{
    scanId: string;
    pageKey: string;
    records: readonly CatalogSnapshotRecord[];
    nextCheckpoint: CatalogScanCheckpoint;
  }>): Promise<void> {
    await this.ensureRoot();
    this.assertScanId(input.scanId);
    this.assertPageKey(input.pageKey);
    const records = input.records.map(decodeSnapshotRecord);
    const nextCheckpoint = decodeCheckpoint(input.nextCheckpoint);
    const loaded = await this.loadScan(input.scanId);
    if (loaded === null) corrupt();
    const paths = this.scanPaths(input.scanId);
    const pagePath = join(paths.pages, `${input.pageKey}.ndjson`);
    const statePath = join(paths.pages, `${input.pageKey}.state.json`);
    const content = pageBytes(records);
    const state: PageState = {
      schemaVersion: 1,
      pageKey: input.pageKey,
      sha256: sha256(content),
      nextCheckpoint,
    };

    if (sameJson(loaded.checkpoint, nextCheckpoint)) {
      await this.assertCommittedPage(pagePath, statePath, state, content);
      return;
    }
    if (!extendsCheckpoint(loaded.checkpoint, nextCheckpoint, input.pageKey)) corrupt();

    const existingPage = await this.readFileIfExists(pagePath);
    if (existingPage !== null && !existingPage.equals(content)) corrupt();
    if (existingPage === null) await this.writeFileAtomic(pagePath, content);

    const existingState = await this.readJsonIfExists(statePath);
    if (existingState !== null && !sameJson(decodePageState(existingState), state)) corrupt();
    if (existingState === null) await this.writeJsonAtomic(statePath, state);
    await this.writeJsonAtomic(paths.checkpoint, nextCheckpoint);
  }

  async loadScan(scanId: string): Promise<Readonly<{
    checkpoint: CatalogScanCheckpoint;
    records: readonly CatalogSnapshotRecord[];
  }> | null> {
    await this.ensureRoot();
    this.assertScanId(scanId);
    const paths = this.scanPaths(scanId);
    const rawCheckpoint = await this.readJsonIfExists(paths.checkpoint);
    if (rawCheckpoint === null) return null;
    let checkpoint = decodeCheckpoint(rawCheckpoint);
    if (checkpoint.scanId !== scanId) corrupt();
    const states = await this.readPageStates(paths.pages);
    for (let index = 0; index < checkpoint.committedPageKeys.length; index += 1) {
      const key = checkpoint.committedPageKeys[index];
      if (key === undefined) corrupt();
      const state = states.get(key);
      if (state === undefined) corrupt();
      if (!sameJson(state.nextCheckpoint.committedPageKeys, checkpoint.committedPageKeys.slice(0, index + 1))) corrupt();
      if (
        state.nextCheckpoint.scanId !== checkpoint.scanId
        || state.nextCheckpoint.rootPath !== checkpoint.rootPath
        || state.nextCheckpoint.startedAt !== checkpoint.startedAt
      ) corrupt();
    }

    while (true) {
      const extensions = [...states.values()].filter((state) =>
        !checkpoint.committedPageKeys.includes(state.pageKey)
        && extendsCheckpoint(checkpoint, state.nextCheckpoint, state.pageKey));
      if (extensions.length === 0) break;
      if (extensions.length !== 1) corrupt();
      const extension = extensions[0];
      if (extension === undefined) corrupt();
      await this.readVerifiedPage(paths.pages, extension);
      checkpoint = extension.nextCheckpoint;
    }

    const uncommittedStates = [...states.keys()].filter((key) => !checkpoint.committedPageKeys.includes(key));
    if (uncommittedStates.length > 0) corrupt();
    const records: CatalogSnapshotRecord[] = [];
    for (const key of checkpoint.committedPageKeys) {
      const state = states.get(key);
      if (state === undefined) corrupt();
      records.push(...await this.readVerifiedPage(paths.pages, state));
    }
    return { checkpoint, records };
  }

  async saveScanState(checkpoint: CatalogScanCheckpoint): Promise<void> {
    await this.ensureRoot();
    const next = decodeCheckpoint(checkpoint);
    const loaded = await this.loadScan(next.scanId);
    if (loaded === null || !validStateTransition(loaded.checkpoint, next)) corrupt();
    await this.writeJsonAtomic(this.scanPaths(next.scanId).checkpoint, next);
  }

  async finalizeScan(input: CatalogScanFinalization): Promise<CatalogScanFinalizationResult> {
    try {
      await this.ensureRoot();
      const finalization = validateFinalization(input);
      await this.saveScanState(finalization.checkpoint);
      const descriptor = finalization.status === "complete"
        ? await this.materializeSnapshot(finalization.checkpoint.scanId, finalization.endedAt)
        : undefined;
      const receipt = decodeReceipt({
        schemaVersion: 2,
        status: finalization.status,
        stopReason: finalization.stopReason,
        startedAt: finalization.checkpoint.startedAt,
        endedAt: finalization.endedAt,
        durationMs: finalization.endedAt - finalization.checkpoint.startedAt,
        budget: finalization.checkpoint.budget,
        listRequestCount: finalization.checkpoint.listRequestCount,
        directoryCount: finalization.checkpoint.directoryCount,
        pdfCount: finalization.checkpoint.pdfCount,
        ignoredFileCount: finalization.checkpoint.ignoredFileCount,
        downloadedPdfBytes: 0,
        errorCodeCounts: finalization.checkpoint.errorCodeCounts,
        retryCount: finalization.checkpoint.retryCount,
        snapshotSha256: descriptor?.sha256 ?? null,
      });
      if (receipt.schemaVersion !== 2) corrupt();
      const paths = this.scanPaths(finalization.checkpoint.scanId);
      const existingReceipt = await this.readJsonIfExists(paths.receipt);
      if (existingReceipt === null) {
        await this.writeJsonAtomic(paths.receipt, receipt);
      } else if (!sameJson(decodeReceipt(existingReceipt), receipt)) {
        corrupt();
      }
      if (descriptor !== undefined) {
        await this.writeJsonAtomic(join(this.root, "active.json"), descriptor);
        return { receipt, descriptor };
      }
      return { receipt };
    } catch {
      throw new CatalogError("snapshot-corrupt");
    }
  }

  async loadReceipt(scanId: string): Promise<CatalogScanReceipt | null> {
    await this.ensureRoot();
    this.assertScanId(scanId);
    const raw = await this.readJsonIfExists(this.scanPaths(scanId).receipt);
    return raw === null ? null : decodeReceipt(raw);
  }

  async promoteScan(scanId: string, completedAt: number): Promise<CatalogSnapshotDescriptor> {
    await this.ensureRoot();
    const completed = safeNonNegativeInteger(completedAt);
    const loaded = await this.loadScan(scanId);
    if (loaded === null || loaded.checkpoint.schemaVersion !== 1) corrupt();
    const descriptor = await this.materializeSnapshot(scanId, completed);

    const receipt: CatalogScanReceiptV1 = {
      schemaVersion: 1,
      status: "complete",
      startedAt: loaded.checkpoint.startedAt,
      completedAt: completed,
      directoryCount: loaded.checkpoint.directoryCount,
      pdfCount: loaded.checkpoint.pdfCount,
      ignoredFileCount: loaded.checkpoint.ignoredFileCount,
      errorCodeCounts: loaded.checkpoint.errorCodeCounts,
      retryCount: loaded.checkpoint.retryCount,
      snapshotSha256: descriptor.sha256,
    };
    await this.writeJsonAtomic(this.scanPaths(scanId).receipt, receipt);
    await this.writeJsonAtomic(join(this.root, "active.json"), descriptor);
    return descriptor;
  }

  private async materializeSnapshot(
    scanId: string,
    completedAt: number,
  ): Promise<CatalogSnapshotDescriptor> {
    this.assertScanId(scanId);
    const loaded = await this.loadScan(scanId);
    if (loaded === null || loaded.checkpoint.pending.length !== 0) corrupt();
    validateRecordSet(loaded.records);
    const actualPdfCount = loaded.records.filter((record) => record.kind === "file").length;
    if (actualPdfCount !== loaded.checkpoint.pdfCount) corrupt();

    const scanPaths = this.scanPaths(scanId);
    const pageParts: Buffer[] = [];
    for (const key of loaded.checkpoint.committedPageKeys) {
      pageParts.push(await this.readFileStrict(join(scanPaths.pages, `${key}.ndjson`)));
    }
    const content = Buffer.concat(pageParts);
    const digest = sha256(content);
    const descriptor: CatalogSnapshotDescriptor = {
      snapshotId: scanId,
      schemaVersion: 1,
      completedAt,
      recordCount: loaded.records.length,
      pdfCount: actualPdfCount,
      sha256: digest,
    };
    const snapshotDirectory = join(this.root, "snapshots", scanId);
    const catalogPath = join(snapshotDirectory, "catalog.ndjson");
    await this.privateDirectory(snapshotDirectory);
    const existingCatalog = await this.readFileIfExists(catalogPath);
    if (existingCatalog !== null && !existingCatalog.equals(content)) corrupt();
    if (existingCatalog === null) await this.writeFileAtomic(catalogPath, content);
    return descriptor;
  }

  async loadActive(): Promise<Readonly<{
    descriptor: CatalogSnapshotDescriptor;
    records: readonly CatalogSnapshotRecord[];
  }> | null> {
    await this.ensureRoot();
    const rawDescriptor = await this.readJsonIfExists(join(this.root, "active.json"));
    if (rawDescriptor === null) return null;
    const descriptor = decodeDescriptor(rawDescriptor);
    const content = await this.readFileStrict(join(
      this.root,
      "snapshots",
      descriptor.snapshotId,
      "catalog.ndjson",
    ));
    if (sha256(content) !== descriptor.sha256) corrupt();
    const records = decodePageRecords(content);
    validateRecordSet(records);
    if (
      records.length !== descriptor.recordCount
      || records.filter((record) => record.kind === "file").length !== descriptor.pdfCount
    ) corrupt();
    return { descriptor, records };
  }

  private assertScanId(scanId: string): void {
    if (!SCAN_ID.test(scanId)) corrupt();
  }

  private assertPageKey(pageKey: string): void {
    if (!PAGE_KEY.test(pageKey)) corrupt();
  }

  private scanPaths(scanId: string): Readonly<{
    directory: string;
    pages: string;
    checkpoint: string;
    receipt: string;
  }> {
    this.assertScanId(scanId);
    const directory = join(this.root, "scans", scanId);
    return {
      directory,
      pages: join(directory, "pages"),
      checkpoint: join(directory, "checkpoint.json"),
      receipt: join(directory, "receipt.json"),
    };
  }

  private async ensureRoot(): Promise<void> {
    if (this.initialized) return;
    if (!isAbsolute(this.root) || resolve(this.root) !== this.root) corrupt();
    await this.privateDirectory(this.root);
    const canonical = await realpath(this.root);
    if (canonical !== this.root) corrupt();
    this.initialized = true;
  }

  private async privateDirectory(path: string): Promise<void> {
    this.assertWithinRoot(path);
    await this.assertDirectoryAncestors(path);
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    await this.assertDirectoryAncestors(path);
    const canonical = await realpath(path);
    this.assertWithinRoot(canonical);
    await chmod(path, DIRECTORY_MODE);
  }

  private assertWithinRoot(path: string): void {
    const fromRoot = relative(this.root, path);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) corrupt();
  }

  private async assertDirectoryAncestors(path: string): Promise<void> {
    let current = path;
    const filesystemRoot = parse(path).root;
    while (true) {
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) corrupt();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (current === filesystemRoot) return;
      current = dirname(current);
    }
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await this.writeFileAtomic(path, Buffer.from(canonicalJson(value), "utf8"));
  }

  private async writeFileAtomic(path: string, content: Buffer): Promise<void> {
    await this.privateDirectory(dirname(path));
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", FILE_MODE);
      await handle.chmod(FILE_MODE);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.renames.rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async readJsonIfExists(path: string): Promise<JsonRecord | null> {
    const content = await this.readFileIfExists(path);
    if (content === null) return null;
    return asRecord(parseJson(content.toString("utf8")));
  }

  private async readFileIfExists(path: string): Promise<Buffer | null> {
    try {
      return await readFile(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async readFileStrict(path: string): Promise<Buffer> {
    const content = await this.readFileIfExists(path);
    if (content === null) corrupt();
    return content;
  }

  private async readPageStates(pagesDirectory: string): Promise<Map<string, PageState>> {
    let entries: string[];
    try {
      entries = await readdir(pagesDirectory);
    } catch (error) {
      if (isMissing(error)) return new Map();
      throw error;
    }
    const states = new Map<string, PageState>();
    for (const entry of entries.filter((name) => name.endsWith(".state.json")).sort()) {
      const raw = await this.readJsonIfExists(join(pagesDirectory, entry));
      if (raw === null) corrupt();
      const state = decodePageState(raw);
      if (entry !== `${state.pageKey}.state.json` || states.has(state.pageKey)) corrupt();
      states.set(state.pageKey, state);
    }
    return states;
  }

  private async readVerifiedPage(
    pagesDirectory: string,
    state: PageState,
  ): Promise<readonly CatalogSnapshotRecord[]> {
    const content = await this.readFileStrict(join(pagesDirectory, `${state.pageKey}.ndjson`));
    if (sha256(content) !== state.sha256) corrupt();
    return decodePageRecords(content);
  }

  private async assertCommittedPage(
    pagePath: string,
    statePath: string,
    expectedState: PageState,
    expectedContent: Buffer,
  ): Promise<void> {
    const content = await this.readFileStrict(pagePath);
    const rawState = await this.readJsonIfExists(statePath);
    if (
      rawState === null
      || !content.equals(expectedContent)
      || !sameJson(decodePageState(rawState), expectedState)
    ) corrupt();
  }
}
