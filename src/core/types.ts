export type VaultPath = string;
export type DocumentKind = "note" | "reference" | "unclassified";
export const OWNED_FIELDS = [
  "knowledge-workbench-kind",
  "knowledge-workbench-topics",
  "knowledge-workbench-related",
] as const;
export type OwnedField = (typeof OWNED_FIELDS)[number];
export type OwnedFieldValue = string | readonly string[];
export type FieldState = Readonly<{ present: false } | { present: true; value: OwnedFieldValue }>;

export interface VaultNote {
  readonly path: VaultPath;
  readonly basename: string;
  readonly mtime: number;
  readonly size: number;
  readonly content: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly headings: readonly string[];
  /** Normalized, resolved vault destination paths; never raw Wikilink text. */
  readonly outgoingLinks: readonly string[];
}

export interface DocumentRecord {
  readonly id: string;
  readonly path: VaultPath;
  readonly basename: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly headings: readonly string[];
  readonly tags: readonly string[];
  readonly ownedFields: Readonly<Partial<Record<OwnedField, unknown>>>;
  readonly relationFields: Readonly<Record<string, OwnedFieldValue>>;
  /** Normalized, resolved vault destination paths; never raw Wikilink text. */
  readonly outgoingLinks: readonly string[];
  readonly tokens: readonly string[];
  readonly mtime: number;
  readonly size: number;
  readonly contentHash: string;
}

export type FilePrecondition =
  | Readonly<{ path: VaultPath; exists: false }>
  | Readonly<{ path: VaultPath; exists: true; mtime: number; contentHash: string }>;

export type PlannedOperation =
  | Readonly<{ id: string; kind: "move"; sourcePath: VaultPath; targetPath: VaultPath }>
  | Readonly<{ id: string; kind: "rename"; sourcePath: VaultPath; targetPath: VaultPath }>
  | Readonly<{ id: string; kind: "set-owned-field"; path: VaultPath; field: OwnedField; before: FieldState; after: FieldState }>
  | Readonly<{ id: string; kind: "add-related-link"; path: VaultPath; targetPath: VaultPath; before: FieldState; after: FieldState }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
};
const isOwnedValue = (value: unknown): value is OwnedFieldValue => typeof value === "string"
  || (Array.isArray(value) && value.every((item) => typeof item === "string"));

export const isFieldStateSchema = (value: unknown): value is FieldState => {
  if (!isRecord(value) || typeof value.present !== "boolean") return false;
  if (!value.present) return hasExactKeys(value, ["present"]);
  return hasExactKeys(value, ["present", "value"]) && isOwnedValue(value.value);
};

export const isFilePreconditionSchema = (value: unknown): value is FilePrecondition => {
  if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0 || typeof value.exists !== "boolean") return false;
  if (!value.exists) return hasExactKeys(value, ["path", "exists"]);
  return hasExactKeys(value, ["path", "exists", "mtime", "contentHash"])
    && typeof value.mtime === "number"
    && Number.isFinite(value.mtime)
    && typeof value.contentHash === "string"
    && value.contentHash.length > 0;
};

export const isPlannedOperationSchema = (value: unknown): value is PlannedOperation => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 || typeof value.kind !== "string") return false;
  if (value.kind === "move" || value.kind === "rename") {
    return hasExactKeys(value, ["id", "kind", "sourcePath", "targetPath"])
      && typeof value.sourcePath === "string"
      && value.sourcePath.length > 0
      && typeof value.targetPath === "string"
      && value.targetPath.length > 0;
  }
  if (value.kind === "set-owned-field") {
    return hasExactKeys(value, ["id", "kind", "path", "field", "before", "after"])
      && typeof value.path === "string"
      && value.path.length > 0
      && typeof value.field === "string"
      && (OWNED_FIELDS as readonly string[]).includes(value.field)
      && isFieldStateSchema(value.before)
      && isFieldStateSchema(value.after);
  }
  if (value.kind === "add-related-link") {
    return hasExactKeys(value, ["id", "kind", "path", "targetPath", "before", "after"])
      && typeof value.path === "string"
      && value.path.length > 0
      && typeof value.targetPath === "string"
      && value.targetPath.length > 0
      && isFieldStateSchema(value.before)
      && isFieldStateSchema(value.after);
  }
  return false;
};

export const sameFieldState = (left: FieldState, right: FieldState): boolean => {
  if (left.present !== right.present) return false;
  if (!left.present || !right.present) return true;
  if (typeof left.value === "string" || typeof right.value === "string") return left.value === right.value;
  return left.value.length === right.value.length && left.value.every((value, index) => value === right.value[index]);
};
