import { normalizeCloudAbsolutePath } from "./catalog-path";
import type {
  CatalogSnapshotRecord,
  CloudCatalogRecord,
} from "./catalog-types";

export interface CatalogSearchQuery {
  readonly text: string;
  readonly folderPrefix?: string;
  readonly modifiedAfter?: number;
  readonly offset: number;
  readonly limit: number;
}

export interface CatalogSearchPage {
  readonly items: readonly CloudCatalogRecord[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

type IndexedRecord = Readonly<{
  record: CloudCatalogRecord;
  searchableFields: readonly string[];
}>;

const normalizeSearchText = (value: string): string =>
  value.normalize("NFC").toLocaleLowerCase("en-US").trim();

const cloneRecord = (record: CloudCatalogRecord): CloudCatalogRecord => ({
  ...record,
  isbnCandidates: [...record.isbnCandidates],
});

const fixedCompare = (left: CloudCatalogRecord, right: CloudCatalogRecord): number => {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.fsId < right.fsId) return -1;
  if (left.fsId > right.fsId) return 1;
  return 0;
};

const bigrams = (value: string): readonly string[] => {
  const characters = [...value];
  if (characters.length < 2) return [];
  const result: string[] = [];
  for (let index = 0; index < characters.length - 1; index += 1) {
    const left = characters[index];
    const right = characters[index + 1];
    if (left !== undefined && right !== undefined) result.push(`${left}${right}`);
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

const insideFolder = (path: string, folderPrefix: string | undefined): boolean => {
  if (folderPrefix === undefined || folderPrefix === "/") return true;
  return path.startsWith(`${folderPrefix}/`);
};

const invalidQuery = (): never => {
  throw new RangeError("invalid-catalog-query");
};

export class CatalogSearchService {
  private readonly records: readonly IndexedRecord[];
  private readonly allIndexes: readonly number[];
  private readonly tokenIndexes = new Map<string, readonly number[]>();
  private readonly isbnIndexes = new Map<string, readonly number[]>();

  constructor(records: readonly CatalogSnapshotRecord[]) {
    const files = records
      .filter((record): record is CloudCatalogRecord => record.kind === "file")
      .map(cloneRecord)
      .sort(fixedCompare);
    this.records = files.map((record) => ({
      record,
      searchableFields: [record.filename, record.title, record.path].map(normalizeSearchText),
    }));
    this.allIndexes = this.records.map((_, index) => index);
    const mutableTokens = new Map<string, number[]>();
    const mutableIsbns = new Map<string, number[]>();
    this.records.forEach((indexed, index) => {
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
    for (const [token, indexes] of mutableTokens) this.tokenIndexes.set(token, indexes);
    for (const [isbn, indexes] of mutableIsbns) this.isbnIndexes.set(isbn, indexes);
  }

  query(query: CatalogSearchQuery): CatalogSearchPage {
    this.validateQuery(query);
    const text = normalizeSearchText(query.text);
    const exactIsbn = /^(?:\d{13}|\d{9}[\dXx])$/u.test(text)
      ? text.toLocaleUpperCase("en-US")
      : undefined;
    const folderPrefix = query.folderPrefix === undefined
      ? undefined
      : normalizeCloudAbsolutePath(query.folderPrefix);
    const candidates = this.candidatesFor(text);
    const matches: number[] = [];
    for (const index of candidates) {
      const indexed = this.records[index];
      if (indexed === undefined) continue;
      if (!insideFolder(indexed.record.path, folderPrefix)) continue;
      if (
        query.modifiedAfter !== undefined
        && indexed.record.serverModifiedAt <= query.modifiedAfter
      ) continue;
      if (
        text.length > 0
        && !indexed.searchableFields.some((field) => field.includes(text))
        && (exactIsbn === undefined || !indexed.record.isbnCandidates.includes(exactIsbn))
      ) continue;
      matches.push(index);
    }
    return {
      items: matches
        .slice(query.offset, query.offset + query.limit)
        .map((index) => cloneRecord(this.records[index]!.record)),
      total: matches.length,
      offset: query.offset,
      limit: query.limit,
    };
  }

  private candidatesFor(text: string): readonly number[] {
    if (text.length === 0) return this.allIndexes;
    if (/^(?:\d{13}|\d{9}[\dXx])$/u.test(text)) return this.isbnIndexes.get(text.toLocaleUpperCase("en-US")) ?? [];
    const tokens = [...new Set(bigrams(text))];
    if (tokens.length === 0) return this.allIndexes;
    const postings: Array<readonly number[]> = [];
    for (const token of tokens) {
      const indexes = this.tokenIndexes.get(token);
      if (indexes === undefined) return [];
      postings.push(indexes);
    }
    postings.sort((left, right) => left.length - right.length);
    const smallest = postings[0];
    if (smallest === undefined) return this.allIndexes;
    return smallest.filter((index) => postings.slice(1).every((indexes) => binaryIncludes(indexes, index)));
  }

  private validateQuery(query: CatalogSearchQuery): void {
    if (
      typeof query.text !== "string"
      || !Number.isSafeInteger(query.offset)
      || query.offset < 0
      || !Number.isSafeInteger(query.limit)
      || query.limit < 1
      || query.limit > 50
      || (
        query.modifiedAfter !== undefined
        && (!Number.isSafeInteger(query.modifiedAfter) || query.modifiedAfter < 0)
      )
    ) invalidQuery();
  }
}
