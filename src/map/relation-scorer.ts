import type { DocumentRecord } from "../core/types";

export interface RelationReason {
  readonly code:
    | "explicit-link"
    | "confirmed-topic"
    | "shared-tag"
    | "compatible-frontmatter"
    | "source-proximity"
    | "same-folder"
    | "token-overlap";
  readonly weight: number;
}

export interface RelationScore {
  readonly total: number;
  readonly reasons: readonly RelationReason[];
}

const COMPATIBLE_FRONTMATTER_KEYS = ["author", "domain", "type"] as const;
const CONFIRMED_TOPICS_FIELD = "knowledge-workbench-topics";

const stringList = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

const normalizeText = (value: string): string =>
  value.trim().normalize("NFC").toLocaleLowerCase("en-US");

const normalizedTextSet = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.map(normalizeText).filter(Boolean));

const normalizeLinkPath = (value: string): string => value.replace(/\\/g, "/").normalize("NFC");

const folderOf = (path: string): string => {
  const normalized = normalizeLinkPath(path);
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : "";
};

const intersects = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
};

const sourceHostnames = (value: unknown): ReadonlySet<string> => {
  const hostnames = new Set<string>();
  for (const source of stringList(value)) {
    try {
      const url = new URL(source.trim().normalize("NFC"));
      if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) {
        hostnames.add(url.hostname.normalize("NFC").toLocaleLowerCase("en-US"));
      }
    } catch {
      // Non-URL source values do not establish hostname proximity.
    }
  }
  return hostnames;
};

const tokenWeight = (left: readonly string[], right: readonly string[]): number => {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;

  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) overlap += 1;
  }
  return (overlap / union.size) * 20;
};

const hasExplicitLink = (left: DocumentRecord, right: DocumentRecord): boolean => {
  const leftPath = normalizeLinkPath(left.path);
  const rightPath = normalizeLinkPath(right.path);
  return (
    left.outgoingLinks.some((path) => normalizeLinkPath(path) === rightPath) ||
    right.outgoingLinks.some((path) => normalizeLinkPath(path) === leftPath)
  );
};

export class RelationScorer {
  score(left: DocumentRecord, right: DocumentRecord): RelationScore {
    if (left.id === right.id) return { total: 0, reasons: [] };

    const reasons: RelationReason[] = [];
    if (hasExplicitLink(left, right)) reasons.push({ code: "explicit-link", weight: 100 });

    const leftTopics = normalizedTextSet(stringList(left.ownedFields[CONFIRMED_TOPICS_FIELD]));
    const rightTopics = normalizedTextSet(stringList(right.ownedFields[CONFIRMED_TOPICS_FIELD]));
    if (intersects(leftTopics, rightTopics)) reasons.push({ code: "confirmed-topic", weight: 80 });

    if (intersects(normalizedTextSet(left.tags), normalizedTextSet(right.tags))) {
      reasons.push({ code: "shared-tag", weight: 60 });
    }

    const hasCompatibleFrontmatter = COMPATIBLE_FRONTMATTER_KEYS.some((key) =>
      intersects(
        normalizedTextSet(stringList(left.relationFields[key])),
        normalizedTextSet(stringList(right.relationFields[key])),
      ),
    );
    if (hasCompatibleFrontmatter) reasons.push({ code: "compatible-frontmatter", weight: 55 });

    if (
      intersects(
        sourceHostnames(left.relationFields.source),
        sourceHostnames(right.relationFields.source),
      )
    ) {
      reasons.push({ code: "source-proximity", weight: 45 });
    }

    const leftFolder = folderOf(left.path);
    if (leftFolder && leftFolder === folderOf(right.path)) {
      reasons.push({ code: "same-folder", weight: 40 });
    }

    const overlapWeight = tokenWeight(left.tokens, right.tokens);
    if (overlapWeight > 0) reasons.push({ code: "token-overlap", weight: overlapWeight });

    return {
      total: reasons.reduce((sum, reason) => sum + reason.weight, 0),
      reasons,
    };
  }
}
