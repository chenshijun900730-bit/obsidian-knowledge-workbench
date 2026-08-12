import type { ClassificationResult } from "../classification/classification-service";
import { normalizeVaultPath, validateTargetPath } from "../core/path-policy";
import type { DocumentRecord, FieldState, PlannedOperation } from "../core/types";
import type { MapEdge } from "../map/map-service";
import { RelationScorer } from "../map/relation-scorer";
import type { FolderRule } from "../storage/plugin-data";

export interface SuggestionInput {
  readonly records: readonly DocumentRecord[];
  readonly classifications: Readonly<Record<string, ClassificationResult>>;
  readonly folderRules: readonly FolderRule[];
  readonly relations: readonly MapEdge[];
}

export interface Finding {
  readonly kind: "duplicate-content" | "empty-file" | "unused-structure";
  readonly documentIds: readonly string[];
  readonly explanation: string;
}

export interface OperationRationale {
  readonly source: "local" | "ai-assisted";
  readonly summary: string;
  readonly signals: readonly string[];
  readonly confidence: "high" | "medium" | "low";
  readonly impact: number;
}

export type LocalOperationRationale = OperationRationale;
const authenticatedLocalRationales = new WeakMap<object, string>();

export const operationSafetyKey = (operation: PlannedOperation): string => {
  if ("sourcePath" in operation) {
    return JSON.stringify([
      operation.id,
      operation.kind,
      normalizeVaultPath(operation.sourcePath),
      normalizeVaultPath(operation.targetPath),
    ]);
  }
  const before = operation.before.present
    ? [true, typeof operation.before.value === "string" ? operation.before.value : [...operation.before.value]]
    : [false];
  const after = operation.after.present
    ? [true, typeof operation.after.value === "string" ? operation.after.value : [...operation.after.value]]
    : [false];
  if ("field" in operation) {
    return JSON.stringify([
      operation.id,
      operation.kind,
      normalizeVaultPath(operation.path),
      operation.field,
      before,
      after,
    ]);
  }
  return JSON.stringify([
    operation.id,
    operation.kind,
    normalizeVaultPath(operation.path),
    normalizeVaultPath(operation.targetPath),
    before,
    after,
  ]);
};

export const isAuthenticatedLocalRationale = (
  value: OperationRationale | undefined,
  operation: PlannedOperation,
): value is LocalOperationRationale => value !== undefined
  && authenticatedLocalRationales.get(value) === operationSafetyKey(operation);

export interface SuggestedOperation {
  readonly operation: PlannedOperation;
  /** Immutable local safety baseline; AI may never replace these metrics. */
  readonly localRationale: LocalOperationRationale;
  readonly rationale: OperationRationale;
}

export interface SuggestionResult {
  readonly suggestions: readonly SuggestedOperation[];
  readonly operations: readonly PlannedOperation[];
  readonly findings: readonly Finding[];
}

export type RationaleEnhancer = (local: OperationRationale, operation: PlannedOperation) => Partial<OperationRationale> | null;

interface Candidate {
  readonly documentId: string;
  readonly sourcePath: string;
  readonly precedence: number;
  readonly structuralTarget?: string;
  readonly operation: PlannedOperation;
  readonly rationale: OperationRationale;
}

interface IndexedRelation {
  readonly edge: MapEdge;
  readonly score: number;
  readonly target: DocumentRecord;
}

const codePointCompare = (left: string, right: string): number => {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done && rightPoint.done) return 0;
      return leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0)! - rightPoint.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
};

const canonicalPathKey = (path: string): string => normalizeVaultPath(path).toLocaleLowerCase("en-US");
const leafOf = (path: string): string => normalizeVaultPath(path).split("/").at(-1) ?? "";
const folderOf = (path: string): string => {
  const normalized = normalizeVaultPath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
};
const withoutMarkdownExtension = (path: string): string => path.toLocaleLowerCase("en-US").endsWith(".md")
  ? path.slice(0, -3)
  : path;
const isInside = (path: string, prefix: string): boolean => {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedPrefix = normalizeVaultPath(prefix).replace(/\/+$/u, "");
  return normalizedPath === `${normalizedPrefix}.md` || normalizedPath.startsWith(`${normalizedPrefix}/`);
};
const operationId = (...parts: readonly string[]): string => `operation:${JSON.stringify(parts)}`;
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const listFieldState = (value: unknown): FieldState | null => {
  if (value === undefined) return { present: false };
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return { present: true, value: [...value] };
};
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const asList = (state: FieldState): readonly string[] => state.present && isStringArray(state.value) ? state.value : [];
const relatedTarget = (value: string): string => {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[[") && trimmed.endsWith("]]" ) ? trimmed.slice(2, -2) : trimmed;
  return canonicalPathKey(`${withoutMarkdownExtension(inner.split("|", 1)[0] ?? inner)}.md`);
};
const sanitizeTitle = (title: string): string => normalizeVaultPath(title)
  .replaceAll("/", "-")
  .replace(/[<>:"\\|?*]/gu, "-")
  .trim()
  .replace(/^[. ]+|[. ]+$/gu, "");
const confidenceForScore = (score: number): OperationRationale["confidence"] => score >= 80 ? "high" : score >= 50 ? "medium" : "low";

const localRationale = (
  summary: string,
  signals: readonly string[],
  confidence: OperationRationale["confidence"],
  impact: number,
): OperationRationale => ({ source: "local", summary, signals: [...signals], confidence, impact });

const compareRecords = (left: DocumentRecord, right: DocumentRecord): number =>
  codePointCompare(normalizeVaultPath(left.path), normalizeVaultPath(right.path)) || codePointCompare(left.id, right.id);

const compareCandidates = (left: Candidate, right: Candidate): number =>
  left.precedence - right.precedence
  || codePointCompare(normalizeVaultPath(left.sourcePath), normalizeVaultPath(right.sourcePath))
  || codePointCompare(left.documentId, right.documentId)
  || codePointCompare(left.operation.id, right.operation.id);

const compareRelations = (left: IndexedRelation, right: IndexedRelation): number =>
  right.score - left.score
  || codePointCompare(normalizeVaultPath(left.target.path), normalizeVaultPath(right.target.path))
  || codePointCompare(left.target.id, right.target.id)
  || codePointCompare(
    JSON.stringify([...left.edge.reasons].sort((a, b) => codePointCompare(a.code, b.code) || b.weight - a.weight)),
    JSON.stringify([...right.edge.reasons].sort((a, b) => codePointCompare(a.code, b.code) || b.weight - a.weight)),
  );

const indexStrongestConfirmedRelations = (
  relations: readonly MapEdge[],
  recordsById: ReadonlyMap<string, DocumentRecord>,
): ReadonlyMap<string, IndexedRelation> => {
  const strongest = new Map<string, IndexedRelation>();
  const consider = (source: DocumentRecord, target: DocumentRecord, edge: MapEdge, score: number): void => {
    const candidate = { edge, score, target };
    const current = strongest.get(source.id);
    if (current === undefined || compareRelations(candidate, current) < 0) strongest.set(source.id, candidate);
  };
  for (const edge of relations) {
    const score = edge.score;
    if (!edge.confirmed || !Number.isFinite(score) || score < 80) continue;
    const source = recordsById.get(edge.sourceId);
    const target = recordsById.get(edge.targetId);
    if (source === undefined || target === undefined || source.id === target.id) continue;
    consider(source, target, edge, score);
    consider(target, source, edge, score);
  }
  return strongest;
};

const freezeRationale = (value: OperationRationale): OperationRationale => Object.freeze({
  ...value,
  signals: Object.freeze([...value.signals]),
});
const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};
const freezeOperation = (operation: PlannedOperation): PlannedOperation =>
  deepFreeze(structuredClone(operation));
const freezeLocalRationale = (value: OperationRationale, operation: PlannedOperation): LocalOperationRationale => {
  const local = freezeRationale({ ...value, source: "local" });
  authenticatedLocalRationales.set(local, operationSafetyKey(operation));
  return local;
};

export class SuggestionService {
  constructor(private readonly enhanceRationale?: RationaleEnhancer) {}

  generate(input: SuggestionInput): SuggestionResult {
    const records = [...input.records].sort(compareRecords);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const strongestRelations = indexStrongestConfirmedRelations(input.relations, recordsById);
    const existingPaths = new Set(records.map((record) => normalizeVaultPath(record.path)));
    const currentSourceKeys = new Set(records.map((record) => canonicalPathKey(record.path)));
    const candidates: Candidate[] = [];

    for (const record of records) {
      const sourcePath = normalizeVaultPath(record.path);
      const classification = input.classifications[record.id];
      const ownedKind = record.ownedFields["knowledge-workbench-kind"];
      if (
        classification !== undefined
        && classification.reason.startsWith("folder-rule:")
        && (classification.kind === "note" || classification.kind === "reference")
        && !hasOwn(record.ownedFields, "knowledge-workbench-kind")
      ) {
        const operation: PlannedOperation = {
          id: operationId("set-owned-field", sourcePath, "knowledge-workbench-kind", classification.kind),
          kind: "set-owned-field",
          path: sourcePath,
          field: "knowledge-workbench-kind",
          before: { present: false },
          after: { present: true, value: classification.kind },
        };
        candidates.push({
          documentId: record.id,
          sourcePath,
          precedence: 1,
          operation,
          rationale: localRationale(
            "Confirm the folder-derived note kind",
            [classification.reason, `kind:${classification.kind}`],
            "high",
            80,
          ),
        });
      }

      if (ownedKind === "note" || ownedKind === "reference") {
        const root = input.folderRules.find((rule) => rule.kind === ownedKind)?.prefix;
        if (root !== undefined && !isInside(sourcePath, root)) {
          const target = normalizeVaultPath(`${root}/${leafOf(sourcePath)}`);
          const validation = validateTargetPath(sourcePath, target, existingPaths);
          if (validation.ok && canonicalPathKey(validation.normalized) !== canonicalPathKey(sourcePath)) {
            const operation: PlannedOperation = {
              id: operationId("move", sourcePath, validation.normalized),
              kind: "move",
              sourcePath,
              targetPath: validation.normalized,
            };
            candidates.push({
              documentId: record.id,
              sourcePath,
              precedence: 2,
              structuralTarget: validation.normalized,
              operation,
              rationale: localRationale(
                "Move the note to its confirmed kind root",
                [`explicit-kind:${ownedKind}`, `configured-root:${normalizeVaultPath(root)}`],
                "high",
                70,
              ),
            });
          }
        }
      }

      if (["untitled", "readme", "skill", "note"].includes(record.basename.toLocaleLowerCase("en-US"))) {
        const title = sanitizeTitle(record.title);
        if (title.length > 0) {
          const folder = folderOf(sourcePath);
          const target = normalizeVaultPath(`${folder.length === 0 ? "" : `${folder}/`}${title}.md`);
          const validation = validateTargetPath(sourcePath, target, existingPaths);
          if (validation.ok && canonicalPathKey(validation.normalized) !== canonicalPathKey(sourcePath)) {
            const operation: PlannedOperation = {
              id: operationId("rename", sourcePath, validation.normalized),
              kind: "rename",
              sourcePath,
              targetPath: validation.normalized,
            };
            candidates.push({
              documentId: record.id,
              sourcePath,
              precedence: 3,
              structuralTarget: validation.normalized,
              operation,
              rationale: localRationale(
                "Replace a generic filename with its visible title",
                [`generic-basename:${record.basename}`, "visible-title"],
                "medium",
                60,
              ),
            });
          }
        }
      }

      const relation = strongestRelations.get(record.id);
      if (relation !== undefined) {
        const before = listFieldState(record.ownedFields["knowledge-workbench-related"]);
        const targetPath = normalizeVaultPath(relation.target.path);
        const targetKey = canonicalPathKey(targetPath);
        if (before !== null && !asList(before).some((value) => relatedTarget(value) === targetKey)) {
          const link = `[[${withoutMarkdownExtension(targetPath)}]]`;
          const operation: PlannedOperation = {
            id: operationId("add-related-link", sourcePath, targetPath),
            kind: "add-related-link",
            path: sourcePath,
            targetPath,
            before,
            after: { present: true, value: [...asList(before), link] },
          };
          candidates.push({
            documentId: record.id,
            sourcePath,
            precedence: 4,
            operation,
            rationale: localRationale(
              "Confirm the strongest local relation",
              relation.edge.reasons.map((reason) => `${reason.code}:${reason.weight}`),
              confidenceForScore(relation.score),
              Math.max(0, Math.min(100, relation.score)),
            ),
          });
        }
      }
    }

    const selectedDocuments = new Set<string>();
    const reservedSources = new Set<string>();
    const reservedTargets = new Set<string>();
    const reservedIds = new Set<string>();
    const selected: SuggestedOperation[] = [];
    for (const candidate of candidates.sort(compareCandidates)) {
      if (selectedDocuments.has(candidate.documentId)) continue;
      const sourceKey = canonicalPathKey(candidate.sourcePath);
      const targetKey = candidate.structuralTarget === undefined ? undefined : canonicalPathKey(candidate.structuralTarget);
      if (
        reservedSources.has(sourceKey)
        || reservedIds.has(candidate.operation.id)
        || (targetKey !== undefined && (reservedTargets.has(targetKey) || currentSourceKeys.has(targetKey)))
      ) continue;
      selectedDocuments.add(candidate.documentId);
      reservedSources.add(sourceKey);
      reservedIds.add(candidate.operation.id);
      if (targetKey !== undefined) reservedTargets.add(targetKey);
      const operation = freezeOperation(candidate.operation);
      const localRationale = freezeLocalRationale(candidate.rationale, operation);
      const enhancedRationale = this.enhance(localRationale, operation);
      selected.push(Object.freeze({
        operation,
        localRationale,
        rationale: enhancedRationale === localRationale ? localRationale : freezeRationale(enhancedRationale),
      }));
    }

    return {
      suggestions: selected,
      operations: selected.map((value) => value.operation),
      findings: this.findings(records),
    };
  }

  private enhance(local: OperationRationale, operation: PlannedOperation): OperationRationale {
    try {
      const enhanced = this.enhanceRationale?.(local, operation);
      const source = enhanced?.source;
      if (source !== "ai-assisted") return local;
      const summary = enhanced?.summary;
      if (typeof summary !== "string") return local;
      const trimmedSummary = summary.trim();
      if (trimmedSummary.length === 0) return local;
      return { ...local, source, summary: trimmedSummary };
    } catch {
      return local;
    }
  }

  private findings(records: readonly DocumentRecord[]): readonly Finding[] {
    const values: Finding[] = [];
    const duplicateGroups = new Map<string, string[]>();
    for (const record of records) {
      const group = duplicateGroups.get(record.contentHash) ?? [];
      group.push(record.id);
      duplicateGroups.set(record.contentHash, group);
    }
    for (const [hash, ids] of [...duplicateGroups].sort(([left], [right]) => codePointCompare(left, right))) {
      if (ids.length < 2) continue;
      values.push({
        kind: "duplicate-content",
        documentIds: [...ids].sort(codePointCompare),
        explanation: `Matching local content hash ${hash}; review only`,
      });
    }
    const emptyIds = records.filter((record) => record.size === 0).map((record) => record.id).sort(codePointCompare);
    if (emptyIds.length > 0) {
      values.push({ kind: "empty-file", documentIds: emptyIds, explanation: "Empty files are informational and never deleted automatically" });
    }
    return values;
  }
}

const confirmedTopics = (record: DocumentRecord): readonly string[] => {
  const value = record.ownedFields["knowledge-workbench-topics"];
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return [...new Set(list.map((item) => item.trim().normalize("NFC").toLocaleLowerCase("en-US")).filter(Boolean))]
    .sort(codePointCompare);
};

/** Builds only confirmed, center-independent relation candidates without a full-vault pair scan. */
export function buildConfirmedRelationCandidates(
  records: readonly DocumentRecord[],
  scorer = new RelationScorer(),
): readonly MapEdge[] {
  interface CandidatePair {
    readonly sourceId: string;
    readonly targetId: string;
    readonly explicit: boolean;
  }
  const stable = [...records].sort(compareRecords);
  const byPath = new Map(stable.map((record) => [canonicalPathKey(record.path), record]));
  const byId = new Map(stable.map((record) => [record.id, record]));
  const pairs = new Map<string, CandidatePair>();
  const reservePair = (left: DocumentRecord, right: DocumentRecord, explicit: boolean): void => {
    if (left.id === right.id) return;
    const ordered = compareRecords(left, right) <= 0 ? [left.id, right.id] as const : [right.id, left.id] as const;
    const key = JSON.stringify(ordered);
    const current = pairs.get(key);
    pairs.set(key, { sourceId: ordered[0], targetId: ordered[1], explicit: explicit || current?.explicit === true });
  };
  for (const record of stable) {
    for (const path of record.outgoingLinks) {
      const target = byPath.get(canonicalPathKey(path));
      if (target !== undefined) reservePair(record, target, true);
    }
  }
  const topicBuckets = new Map<string, DocumentRecord[]>();
  for (const record of stable) for (const topic of confirmedTopics(record)) {
    const bucket = topicBuckets.get(topic) ?? [];
    bucket.push(record);
    topicBuckets.set(topic, bucket);
  }
  for (const bucket of topicBuckets.values()) {
    const anchor = bucket[0];
    if (anchor === undefined) continue;
    for (let index = 1; index < bucket.length; index += 1) reservePair(anchor, bucket[index]!, false);
  }
  return [...pairs.values()]
    .map(({ sourceId, targetId, explicit }): MapEdge => {
      const source = byId.get(sourceId)!;
      const target = byId.get(targetId)!;
      const sourceView = { ...source, outgoingLinks: explicit ? [target.path] : [] };
      const targetView = { ...target, outgoingLinks: [] };
      const score = scorer.score(sourceView, targetView);
      return { sourceId, targetId, score: score.total, reasons: score.reasons, confirmed: true };
    })
    .sort((left, right) => codePointCompare(left.sourceId, right.sourceId) || codePointCompare(left.targetId, right.targetId));
}
