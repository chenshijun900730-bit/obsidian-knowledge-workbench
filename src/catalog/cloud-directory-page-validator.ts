import { normalizeCloudAbsolutePath } from "./catalog-path";
import { CatalogError, type BaiduListEntry } from "./catalog-types";

const invalidResponse = (): CatalogError => new CatalogError("invalid-baidu-response");

const directParent = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

const normalizedTraversalPath = (value: string): string => {
  try {
    return normalizeCloudAbsolutePath(value);
  } catch {
    throw invalidResponse();
  }
};

const validateEntry = (input: Readonly<{
  entry: unknown;
  currentPath: string;
  traversalRoot: string;
}>): BaiduListEntry => {
  const currentPath = normalizedTraversalPath(input.currentPath);
  const traversalRoot = normalizedTraversalPath(input.traversalRoot);
  if (typeof input.entry !== "object" || input.entry === null || Array.isArray(input.entry)) {
    throw invalidResponse();
  }
  const candidate = input.entry as Record<string, unknown>;
  if (
    typeof candidate.path !== "string"
    || typeof candidate.filename !== "string"
    || typeof candidate.fsId !== "string"
    || typeof candidate.sizeBytes !== "number"
    || typeof candidate.serverModifiedAt !== "number"
    || typeof candidate.isDirectory !== "boolean"
  ) throw invalidResponse();

  let path: string;
  try {
    path = normalizeCloudAbsolutePath(candidate.path);
  } catch {
    throw invalidResponse();
  }
  const filename = candidate.filename.normalize("NFC");
  const inTraversal = traversalRoot === "/"
    ? path !== "/"
    : path.startsWith(`${traversalRoot}/`);
  if (
    path !== candidate.path
    || !inTraversal
    || directParent(path) !== currentPath
    || path.slice(path.lastIndexOf("/") + 1) !== filename
    || !/^(?:0|[1-9]\d*)$/u.test(candidate.fsId)
    || !Number.isSafeInteger(candidate.sizeBytes)
    || candidate.sizeBytes < 0
    || !Number.isSafeInteger(candidate.serverModifiedAt)
    || candidate.serverModifiedAt < 0
    || (candidate.isDirectory && candidate.sizeBytes !== 0)
  ) throw invalidResponse();

  return {
    fsId: candidate.fsId,
    path,
    filename,
    sizeBytes: candidate.sizeBytes,
    serverModifiedAt: candidate.serverModifiedAt,
    isDirectory: candidate.isDirectory,
  };
};

export function validateBaiduListEntry(input: Readonly<{
  entry: unknown;
  currentPath: string;
  traversalRoot: string;
}>): BaiduListEntry {
  try {
    return validateEntry(input);
  } catch {
    throw invalidResponse();
  }
}
