import type {
  CatalogDifferenceKind,
  CatalogVerificationStatus,
  UnifiedCatalogRecordV1,
} from "./hybrid-catalog-types";

export interface UnifiedCatalogSearchQuery {
  readonly text: string;
  readonly statuses?: readonly CatalogVerificationStatus[];
  readonly differenceKinds?: readonly CatalogDifferenceKind[];
  readonly topLevelGroupId?: string;
  readonly hierarchyTag?: string;
  readonly includeCloudMissing?: boolean;
  readonly offset: number;
  readonly limit: number;
}

export interface UnifiedCatalogSearchPage {
  readonly items: readonly UnifiedCatalogRecordV1[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

const STATUS_VALUES: readonly CatalogVerificationStatus[] = ["unverified", "verified", "difference"];
const DIFFERENCE_VALUES: readonly CatalogDifferenceKind[] = [
  "cloud-added",
  "cloud-missing",
  "renamed",
  "moved",
];
const GROUP_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;

const invalidQuery = (): never => { throw new RangeError("invalid-unified-catalog-query"); };

const normalizeSearchText = (value: string): string =>
  value.normalize("NFC").toLocaleLowerCase("en-US").trim();

const cloneRecord = (record: UnifiedCatalogRecordV1): UnifiedCatalogRecordV1 => ({
  ...record,
  isbnCandidates: [...record.isbnCandidates],
  hierarchyTags: [...record.hierarchyTags],
  differenceKinds: [...record.differenceKinds],
});

const fixedCompare = (left: UnifiedCatalogRecordV1, right: UnifiedCatalogRecordV1): number => {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  if (left.catalogId < right.catalogId) return -1;
  if (left.catalogId > right.catalogId) return 1;
  return 0;
};

const validateEnumFilter = <T extends string>(
  values: readonly T[] | undefined,
  allowed: readonly T[],
): readonly T[] | undefined => {
  if (values === undefined) return undefined;
  const unknownValues: unknown = values;
  if (!Array.isArray(unknownValues)) return invalidQuery();
  const entries = unknownValues as readonly unknown[];
  if (entries.length === 0 || new Set(entries).size !== entries.length) return invalidQuery();
  const decoded: T[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !allowed.some((value) => value === entry)) {
      return invalidQuery();
    }
    decoded.push(entry as T);
  }
  return decoded;
};

export const createUnifiedCatalogSearchPredicate = (
  query: UnifiedCatalogSearchQuery,
): ((record: UnifiedCatalogRecordV1) => boolean) => {
  const filters = validateQuery(query);
  const text = normalizeSearchText(query.text);
  const exactIsbn = /^(?:\d{13}|\d{9}[\dXx])$/u.test(text)
    ? text.toLocaleUpperCase("en-US")
    : undefined;
  return (record) => {
    if (!filters.includeCloudMissing && !record.visibleByDefault) return false;
    if (filters.statuses !== undefined && !filters.statuses.includes(record.verificationStatus)) return false;
    if (
      filters.differenceKinds !== undefined
      && !filters.differenceKinds.some((kind) => record.differenceKinds.includes(kind))
    ) return false;
    if (filters.topLevelGroupId !== undefined && record.topLevelGroupId !== filters.topLevelGroupId) return false;
    if (filters.hierarchyTag !== undefined && !record.hierarchyTags.includes(filters.hierarchyTag)) return false;
    if (text.length === 0) return true;
    const searchableText = normalizeSearchText([
      record.filename,
      record.title,
      record.relativePath,
      ...(record.cloudPath === null ? [] : [record.cloudPath]),
      ...record.hierarchyTags,
    ].join("\u0000"));
    return searchableText.includes(text)
      || (exactIsbn !== undefined && record.isbnCandidates.includes(exactIsbn));
  };
};

const validateQuery = (query: UnifiedCatalogSearchQuery): Readonly<{
  statuses?: readonly CatalogVerificationStatus[];
  differenceKinds?: readonly CatalogDifferenceKind[];
  topLevelGroupId?: string;
  hierarchyTag?: string;
  includeCloudMissing: boolean;
}> => {
  if (
    typeof query.text !== "string"
    || !Number.isSafeInteger(query.offset)
    || query.offset < 0
    || !Number.isSafeInteger(query.limit)
    || query.limit < 1
    || query.limit > 50
    || (query.includeCloudMissing !== undefined && typeof query.includeCloudMissing !== "boolean")
  ) return invalidQuery();
  const statuses = validateEnumFilter(query.statuses, STATUS_VALUES);
  const differenceKinds = validateEnumFilter(query.differenceKinds, DIFFERENCE_VALUES);
  const topLevelGroupId = query.topLevelGroupId;
  if (topLevelGroupId !== undefined && !GROUP_PATTERN.test(topLevelGroupId)) return invalidQuery();
  const hierarchyTag = query.hierarchyTag?.normalize("NFC");
  if (
    hierarchyTag !== undefined
    && (!hierarchyTag.startsWith("folder/") || hierarchyTag.length <= "folder/".length)
  ) return invalidQuery();
  return {
    ...(statuses === undefined ? {} : { statuses }),
    ...(differenceKinds === undefined ? {} : { differenceKinds }),
    ...(topLevelGroupId === undefined ? {} : { topLevelGroupId }),
    ...(hierarchyTag === undefined ? {} : { hierarchyTag }),
    includeCloudMissing: query.includeCloudMissing ?? false,
  };
};

export class UnifiedCatalogSearchService {
  readonly #records: readonly UnifiedCatalogRecordV1[];
  #searchableText: readonly string[] | null = null;

  constructor(records: readonly UnifiedCatalogRecordV1[]) {
    this.#records = records.map(cloneRecord).sort(fixedCompare);
  }

  query(query: UnifiedCatalogSearchQuery): UnifiedCatalogSearchPage {
    const filters = validateQuery(query);
    const text = normalizeSearchText(query.text);
    const exactIsbn = /^(?:\d{13}|\d{9}[\dXx])$/u.test(text)
      ? text.toLocaleUpperCase("en-US")
      : undefined;
    const searchableText = text.length === 0 ? null : this.#searchableTextForRecords();
    const matches: number[] = [];
    for (let index = 0; index < this.#records.length; index += 1) {
      const record = this.#records[index];
      if (record === undefined) continue;
      if (!filters.includeCloudMissing && !record.visibleByDefault) continue;
      if (filters.statuses !== undefined && !filters.statuses.includes(record.verificationStatus)) continue;
      if (
        filters.differenceKinds !== undefined
        && !filters.differenceKinds.some((kind) => record.differenceKinds.includes(kind))
      ) continue;
      if (filters.topLevelGroupId !== undefined && record.topLevelGroupId !== filters.topLevelGroupId) continue;
      if (filters.hierarchyTag !== undefined && !record.hierarchyTags.includes(filters.hierarchyTag)) continue;
      if (
        text.length > 0
        && searchableText?.[index]?.includes(text) !== true
        && (exactIsbn === undefined || !record.isbnCandidates.includes(exactIsbn))
      ) continue;
      matches.push(index);
    }
    return {
      items: matches
        .slice(query.offset, query.offset + query.limit)
        .map((index) => cloneRecord(this.#records[index]!)),
      total: matches.length,
      offset: query.offset,
      limit: query.limit,
    };
  }

  #searchableTextForRecords(): readonly string[] {
    if (this.#searchableText !== null) return this.#searchableText;
    this.#searchableText = this.#records.map((record) => normalizeSearchText([
      record.filename,
      record.title,
      record.relativePath,
      ...(record.cloudPath === null ? [] : [record.cloudPath]),
      ...record.hierarchyTags,
    ].join("\u0000")));
    return this.#searchableText;
  }

}
