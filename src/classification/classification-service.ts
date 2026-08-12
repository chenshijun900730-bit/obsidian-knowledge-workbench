import type { DocumentKind, DocumentRecord } from "../core/types";
import type { IndexPathPolicy } from "../indexing/index-service";
import type { FolderRuleProposal, PluginSettings } from "../storage/plugin-data";

export type ClassificationResult = Readonly<{ kind: DocumentKind; reason: string }>;
export interface ClassifiedRecords {
  readonly records: readonly DocumentRecord[];
  readonly resultsById: Readonly<Record<string, ClassificationResult>>;
}

const normalizePath = (path: string): string => path.normalize("NFC")
  .replaceAll("\\", "/")
  .replace(/\/{2,}/gu, "/");
const normalizePrefix = (prefix: string): string => normalizePath(prefix).replace(/\/+$/u, "");
const hasDotPrefixedSegment = (path: string): boolean => path.split("/").some((segment) => segment.startsWith("."));
const canonicalExcludedPrefixes = (prefixes: readonly string[]): readonly string[] => {
  const normalized = [...new Set(prefixes
    .map(normalizePrefix)
    .filter((prefix) => prefix.length > 0 && !hasDotPrefixedSegment(prefix)))]
    .sort();
  const canonical: string[] = [];
  for (const prefix of normalized) {
    if (!canonical.some((ancestor) => prefix.startsWith(`${ancestor}/`))) canonical.push(prefix);
  }
  return canonical;
};

export function isExcluded(path: string, settings: Pick<PluginSettings, "excludedPrefixes">): boolean {
  const normalizedPath = normalizePath(path);
  if (hasDotPrefixedSegment(normalizedPath)) return true;
  return canonicalExcludedPrefixes(settings.excludedPrefixes)
    .some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`));
}

export function createIndexPathPolicy(
  settingsProvider: () => Pick<PluginSettings, "excludedPrefixes">,
): IndexPathPolicy {
  return {
    key: () => JSON.stringify(canonicalExcludedPrefixes(settingsProvider().excludedPrefixes)),
    includes: (path) => !isExcluded(path, settingsProvider()),
  };
}

export class ClassificationService {
  classify(record: DocumentRecord, settings: Pick<PluginSettings, "folderRules">): ClassificationResult {
    const explicit = record.ownedFields["knowledge-workbench-kind"];
    if (explicit === "note" || explicit === "reference") return { kind: explicit, reason: "explicit-property" };
    const path = normalizePath(record.path);
    for (const rule of settings.folderRules) {
      const prefix = normalizePrefix(rule.prefix);
      if (path === `${prefix}.md` || path.startsWith(`${prefix}/`)) {
        return { kind: rule.kind, reason: `folder-rule:${rule.prefix}` };
      }
    }
    return { kind: "unclassified", reason: "no-rule" };
  }

  isExcluded(path: string, settings: Pick<PluginSettings, "excludedPrefixes">): boolean {
    return isExcluded(path, settings);
  }
}

export function classifyRecords(
  records: readonly DocumentRecord[],
  service: ClassificationService,
  settings: Pick<PluginSettings, "folderRules">,
): ClassifiedRecords {
  const resultsById: Record<string, ClassificationResult> = {};
  const classified = records.map((record) => {
    const result = service.classify(record, settings);
    resultsById[record.id] = result;
    return result.kind === record.kind ? record : { ...record, kind: result.kind };
  });
  return { records: classified, resultsById };
}

interface FolderCounts {
  noteCount: number;
  unclassifiedCount: number;
  samplePaths: string[];
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function suggestFolderRules(records: readonly DocumentRecord[]): readonly FolderRuleProposal[] {
  const countsByPrefix = new Map<string, FolderCounts>();
  for (const record of records) {
    const path = normalizePath(record.path);
    const segments = path.split("/");
    const prefixDepth = Math.min(2, segments.length - 1);
    for (let depth = 1; depth <= prefixDepth; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      const counts = countsByPrefix.get(prefix) ?? { noteCount: 0, unclassifiedCount: 0, samplePaths: [] };
      counts.noteCount += 1;
      if (record.kind === "unclassified") counts.unclassifiedCount += 1;
      counts.samplePaths.push(path);
      countsByPrefix.set(prefix, counts);
    }
  }

  return [...countsByPrefix]
    .filter(([, counts]) => counts.noteCount >= 10 && counts.unclassifiedCount * 5 >= counts.noteCount * 4)
    .sort(([left], [right]) => compareText(left, right))
    .map(([prefix, counts]) => ({
      prefix,
      kind: "reference",
      noteCount: counts.noteCount,
      unclassifiedCount: counts.unclassifiedCount,
      samplePaths: [...counts.samplePaths].sort(compareText).slice(0, 3),
    }));
}
