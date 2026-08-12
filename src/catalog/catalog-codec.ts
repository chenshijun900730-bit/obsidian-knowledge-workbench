import JSONbigFactory from "json-bigint";
import { CatalogError, type BaiduListEntry } from "./catalog-types";
import { normalizeCloudAbsolutePath } from "./catalog-path";

export { normalizeCloudAbsolutePath } from "./catalog-path";

const parseJson = JSONbigFactory({ storeAsString: true, strict: true }).parse;

export const isbnCandidatesFromFilename = (filename: string): readonly string[] => {
  const matches = filename.normalize("NFC").match(/(?:97[89][\d -]{10,20}[\dXx]|\d[\d -]{8,15}[\dXx])/gu) ?? [];
  return [...new Set(matches
    .map((value) => value.replace(/[^\dXx]/gu, "").toLocaleUpperCase("en-US"))
    .filter((value) => value.length === 10 || value.length === 13))]
    .sort();
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogError("invalid-baidu-response");
  }
  return value as Readonly<Record<string, unknown>>;
};

const finiteInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CatalogError("invalid-baidu-response");
  }
  return value;
};

const decimalId = (value: unknown): string => {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new CatalogError("invalid-baidu-response");
};

const mapBaiduErrno = (errno: number): CatalogError => {
  if (errno === -6 || errno === 31045) return new CatalogError("baidu-token-expired");
  if (errno === -7 || errno === 31024 || errno === 20013) {
    return new CatalogError("baidu-permission-denied");
  }
  if (errno === -9) return new CatalogError("baidu-not-found");
  if (errno === 20012 || errno === 31034) {
    return new CatalogError("baidu-rate-limited", true);
  }
  return new CatalogError("baidu-access-unavailable");
};

const decodeEntry = (value: unknown): BaiduListEntry => {
  const object = asRecord(value);
  if (typeof object.path !== "string" || typeof object.server_filename !== "string") {
    throw new CatalogError("invalid-baidu-response");
  }
  const path = normalizeCloudAbsolutePath(object.path);
  const filename = object.server_filename.normalize("NFC");
  const sizeBytes = finiteInteger(object.size);
  const serverModifiedAt = finiteInteger(object.server_mtime);
  const isDirectory = finiteInteger(object.isdir);
  if (
    filename.length === 0
    || sizeBytes < 0
    || serverModifiedAt < 0
    || (isDirectory !== 0 && isDirectory !== 1)
  ) {
    throw new CatalogError("invalid-baidu-response");
  }
  return {
    fsId: decimalId(object.fs_id),
    path,
    filename,
    sizeBytes,
    serverModifiedAt,
    isDirectory: isDirectory === 1,
  };
};

export function decodeBaiduListResponse(raw: string): Readonly<{ entries: readonly BaiduListEntry[] }> {
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch {
    throw new CatalogError("invalid-baidu-response");
  }
  const object = asRecord(value);
  const errno = finiteInteger(object.errno);
  if (errno !== 0) throw mapBaiduErrno(errno);
  if (!Array.isArray(object.list)) throw new CatalogError("invalid-baidu-response");
  return { entries: object.list.map(decodeEntry) };
}
