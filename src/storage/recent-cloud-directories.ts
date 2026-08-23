import { normalizeCatalogScanRoot } from "../catalog/catalog-path";

export const MAX_RECENT_CLOUD_DIRECTORY_COUNT = 10 as const;

export interface RecentCloudDirectory {
  readonly path: string;
  readonly filename: string;
  readonly lastUsedAt: string;
}

export interface RecentCloudDirectoriesV1 {
  readonly schemaVersion: 1;
  readonly items: readonly RecentCloudDirectory[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compareCodePoints = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const freezeState = (
  items: readonly RecentCloudDirectory[],
): RecentCloudDirectoriesV1 => Object.freeze({
  schemaVersion: 1,
  items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
});

const emptyState = (): RecentCloudDirectoriesV1 => freezeState([]);

export const EMPTY_RECENT_CLOUD_DIRECTORIES: RecentCloudDirectoriesV1 = emptyState();

const filenameFromPath = (path: string): string => {
  const filename = path.split("/").at(-1);
  if (filename === undefined || filename.length === 0) throw new Error("invalid-scan-root");
  return filename;
};

const isCanonicalUtcTimestamp = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const timestampFromMilliseconds = (usedAt: number): string => {
  if (!Number.isSafeInteger(usedAt) || usedAt < 0) {
    throw new Error("invalid-recent-cloud-directory-timestamp");
  }
  try {
    const timestamp = new Date(usedAt).toISOString();
    if (!isCanonicalUtcTimestamp(timestamp)) throw new Error("invalid-recent-cloud-directory-timestamp");
    return timestamp;
  } catch {
    throw new Error("invalid-recent-cloud-directory-timestamp");
  }
};

const decodeRecentCloudDirectoriesUnsafe = (value: unknown): RecentCloudDirectoriesV1 => {
  if (
    !isObject(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.items)
    || value.items.length > MAX_RECENT_CLOUD_DIRECTORY_COUNT
  ) return emptyState();

  const decoded: RecentCloudDirectory[] = [];
  const paths = new Set<string>();
  for (const item of value.items) {
    if (
      !isObject(item)
      || typeof item.path !== "string"
      || typeof item.filename !== "string"
      || typeof item.lastUsedAt !== "string"
      || !isCanonicalUtcTimestamp(item.lastUsedAt)
    ) return emptyState();

    let path: string;
    try {
      path = normalizeCatalogScanRoot(item.path);
    } catch {
      return emptyState();
    }
    const filename = filenameFromPath(path);
    if (item.filename.normalize("NFC") !== filename || paths.has(path)) return emptyState();
    paths.add(path);
    decoded.push({ path, filename, lastUsedAt: item.lastUsedAt });
  }

  decoded.sort((left, right) => (
    compareCodePoints(right.lastUsedAt, left.lastUsedAt)
    || compareCodePoints(left.path, right.path)
  ));
  return freezeState(decoded);
};

export function decodeRecentCloudDirectories(value: unknown): RecentCloudDirectoriesV1 {
  try {
    return decodeRecentCloudDirectoriesUnsafe(value);
  } catch {
    return emptyState();
  }
}

export function rememberRecentCloudDirectory(
  current: RecentCloudDirectoriesV1,
  path: string,
  usedAt: number,
): RecentCloudDirectoriesV1 {
  const normalizedPath = normalizeCatalogScanRoot(path);
  const requestedLastUsedAt = timestampFromMilliseconds(usedAt);
  const validCurrent = decodeRecentCloudDirectories(current);
  const latestPersistedAt = validCurrent.items.reduce(
    (latest, item) => Math.max(latest, Date.parse(item.lastUsedAt)),
    -1,
  );
  const effectiveUsedAt = Math.max(Date.parse(requestedLastUsedAt), latestPersistedAt + 1);
  const entry = Object.freeze({
    path: normalizedPath,
    filename: filenameFromPath(normalizedPath),
    lastUsedAt: timestampFromMilliseconds(effectiveUsedAt),
  });
  return freezeState([
    entry,
    ...validCurrent.items.filter((item) => item.path !== normalizedPath),
  ].slice(0, MAX_RECENT_CLOUD_DIRECTORY_COUNT));
}
