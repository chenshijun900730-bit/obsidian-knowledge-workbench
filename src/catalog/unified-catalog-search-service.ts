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

interface IndexedUnifiedRecord {
  readonly record: UnifiedCatalogRecordV1;
  readonly searchableFields: readonly string[];
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

const bigrams = (value: string): readonly string[] => {
  const characters = [...value];
  const result: string[] = [];
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.push(`${characters[index]!}${characters[index + 1]!}`);
  }
  return result;
};

const binaryIncludes = (values: readonly number[], target: number): boolean => {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle];
    if (value === target) return true;
    if (value === undefined || value > target) high = middle - 1;
    else low = middle + 1;
  }
  return false;
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

export class UnifiedCatalogSearchService {
  readonly #records: readonly IndexedUnifiedRecord[];
  readonly #allIndexes: readonly number[];
  readonly #tokenIndexes = new Map<string, readonly number[]>();
  readonly #isbnIndexes = new Map<string, readonly number[]>();

  constructor(records: readonly UnifiedCatalogRecordV1[]) {
    const cloned = records.map(cloneRecord).sort(fixedCompare);
    this.#records = cloned.map((record) => ({
      record,
      searchableFields: [
        record.filename,
        record.title,
        record.relativePath,
        ...(record.cloudPath === null ? [] : [record.cloudPath]),
        ...record.hierarchyTags,
      ].map(normalizeSearchText),
    }));
    this.#allIndexes = this.#records.map((_, index) => index);
    const mutableTokens = new Map<string, number[]>();
    const mutableIsbns = new Map<string, number[]>();
    this.#records.forEach((indexed, index) => {
      const tokens = new Set(indexed.searchableFields.flatMap((field) => bigrams(field)));
      for (const token of tokens) {
        const postings = mutableTokens.get(token);
        if (postings === undefined) mutableTokens.set(token, [index]);
        else postings.push(index);
      }
      for (const isbn of indexed.record.isbnCandidates) {
        const postings = mutableIsbns.get(isbn);
        if (postings === undefined) mutableIsbns.set(isbn, [index]);
        else postings.push(index);
      }
    });
    for (const [token, indexes] of mutableTokens) this.#tokenIndexes.set(token, indexes);
    for (const [isbn, indexes] of mutableIsbns) this.#isbnIndexes.set(isbn, indexes);
  }

  query(query: UnifiedCatalogSearchQuery): UnifiedCatalogSearchPage {
    const filters = this.#validateQuery(query);
    const text = normalizeSearchText(query.text);
    const exactIsbn = /^(?:\d{13}|\d{9}[\dXx])$/u.test(text)
      ? text.toLocaleUpperCase("en-US")
      : undefined;
    const matches: number[] = [];
    for (const index of this.#candidatesFor(text)) {
      const indexed = this.#records[index];
      if (indexed === undefined) continue;
      const record = indexed.record;
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
        && !indexed.searchableFields.some((field) => field.includes(text))
        && (exactIsbn === undefined || !record.isbnCandidates.includes(exactIsbn))
      ) continue;
      matches.push(index);
    }
    return {
      items: matches
        .slice(query.offset, query.offset + query.limit)
        .map((index) => cloneRecord(this.#records[index]!.record)),
      total: matches.length,
      offset: query.offset,
      limit: query.limit,
    };
  }

  #candidatesFor(text: string): readonly number[] {
    if (text.length === 0) return this.#allIndexes;
    if (/^(?:\d{13}|\d{9}[\dXx])$/u.test(text)) {
      return this.#isbnIndexes.get(text.toLocaleUpperCase("en-US")) ?? [];
    }
    const tokens = [...new Set(bigrams(text))];
    if (tokens.length === 0) return this.#allIndexes;
    const postings: Array<readonly number[]> = [];
    for (const token of tokens) {
      const indexes = this.#tokenIndexes.get(token);
      if (indexes === undefined) return [];
      postings.push(indexes);
    }
    postings.sort((left, right) => left.length - right.length);
    const smallest = postings[0];
    if (smallest === undefined) return this.#allIndexes;
    return smallest.filter((index) => postings.slice(1).every((indexes) => (
      binaryIncludes(indexes, index)
    )));
  }

  #validateQuery(query: UnifiedCatalogSearchQuery): Readonly<{
    statuses?: readonly CatalogVerificationStatus[];
    differenceKinds?: readonly CatalogDifferenceKind[];
    topLevelGroupId?: string;
    hierarchyTag?: string;
    includeCloudMissing: boolean;
  }> {
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
  }
}
