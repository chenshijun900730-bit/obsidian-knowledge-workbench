import { OWNED_FIELDS, type DocumentRecord, type OwnedField, type OwnedFieldValue, type VaultNote } from "../core/types";
import { sha256 } from "../core/hash";

const RELATION_FIELDS = ["source", "author", "domain", "type"] as const;
const MAX_TOKEN_CODE_POINTS = 128;
const isString = (value: unknown): value is string => typeof value === "string";
const stringList = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter(isString) : typeof value === "string" ? [value] : [];
const bodyWithoutInitialFrontmatter = (content: string): string => {
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u);
  return frontmatter === null ? content : content.slice(frontmatter[0].length);
};

export async function extractDocumentRecord(note: VaultNote): Promise<DocumentRecord> {
  const frontmatterTitle = typeof note.frontmatter.title === "string" ? note.frontmatter.title.trim() : "";
  const title = frontmatterTitle || note.headings[0]?.trim() || note.basename;
  const ownedFields: Partial<Record<OwnedField, OwnedFieldValue>> = {};
  for (const field of OWNED_FIELDS) {
    const value = note.frontmatter[field];
    if (typeof value === "string") ownedFields[field] = value;
    else if (Array.isArray(value)) {
      const strings = value.filter(isString);
      if (strings.length === value.length) ownedFields[field] = [...strings];
    }
  }
  const relationFields: Record<string, OwnedFieldValue> = {};
  for (const field of RELATION_FIELDS) {
    const value = note.frontmatter[field];
    if (typeof value === "string" && value.length <= 500) relationFields[field] = value;
    else if (Array.isArray(value) && value.length <= 20) {
      const strings = value.filter(isString);
      if (strings.length === value.length && strings.every((item) => item.length <= 500)) relationFields[field] = [...strings];
    }
  }
  const tokenSource = [title, ...note.headings, bodyWithoutInitialFrontmatter(note.content)].join("\n").normalize("NFC").toLocaleLowerCase("en-US");
  const tokenCounts = new Map<string, number>();
  for (const raw of tokenSource.match(/[\p{Script=Han}]+|[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []) {
    const characters = [...raw];
    const tokens = /^\p{Script=Han}+$/u.test(raw) && characters.length > 2 ? characters.slice(0, -1).map((value, index) => `${value}${characters[index + 1]}`) : [raw];
    for (const token of tokens) {
      if ([...token].length <= MAX_TOKEN_CODE_POINTS) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }
  const tokens = [...tokenCounts].sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right)).slice(0, 256).map(([token]) => token);
  const explicitKind = ownedFields["knowledge-workbench-kind"];
  return {
    id: note.path.normalize("NFC"),
    path: note.path.normalize("NFC"),
    basename: note.basename,
    kind: explicitKind === "note" || explicitKind === "reference" ? explicitKind : "unclassified",
    title,
    aliases: stringList(note.frontmatter.aliases),
    headings: [...note.headings],
    tags: stringList(note.frontmatter.tags).map((tag) => tag.replace(/^#/, "")).sort(),
    ownedFields,
    relationFields,
    outgoingLinks: [...note.outgoingLinks].sort(),
    tokens,
    mtime: note.mtime,
    size: note.size,
    contentHash: await sha256(note.content),
  };
}
