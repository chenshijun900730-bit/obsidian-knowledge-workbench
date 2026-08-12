import { sha256 } from "../core/hash";
import { normalizeVaultPath, validateTargetPath } from "../core/path-policy";
import type { VaultReadPort } from "../core/ports";
import {
  isFilePreconditionSchema,
  isPlannedOperationSchema,
  sameFieldState,
  type FieldState,
  type FilePrecondition,
  type PlannedOperation,
} from "../core/types";
import {
  isAuthenticatedLocalRationale,
  operationSafetyKey,
  type OperationRationale,
} from "../suggestions/suggestion-service";

declare const confirmedPlanBrand: unique symbol;
export type ConfirmedPlan = Readonly<ChangePlan & { readonly [confirmedPlanBrand]: true }>;

export type PlanConflictCode =
  | "target-exists"
  | "case-collision"
  | "duplicate-target"
  | "overlapping-operation"
  | "related-target-missing"
  | "frontmatter-unreadable"
  | "owned-field-drift"
  | "invalid-path"
  | "source-missing"
  | "inbound-links"
  | "metadata-not-ready"
  | "write-locked"
  | "too-many-operations"
  | "precondition-drift"
  | "post-state-drift";

export interface PlanConflict {
  readonly operationId: string;
  readonly code: PlanConflictCode;
  readonly paths: readonly string[];
  readonly severity?: "blocking" | "warning";
}

export interface ChangePlan {
  readonly id: string;
  readonly fingerprint: string;
  readonly operations: readonly PlannedOperation[];
  readonly preconditions: readonly FilePrecondition[];
  readonly rationales: Readonly<Record<string, OperationRationale>>;
  readonly localRationales: Readonly<Record<string, OperationRationale>>;
}

export interface PlanPreview {
  readonly plan: ChangePlan;
  readonly conflicts: readonly PlanConflict[];
  readonly affectedFiles: readonly string[];
  readonly undoableOperationIds: readonly string[];
}

export type RevalidationResult = Readonly<{ ok: true }> | Readonly<{ ok: false; conflicts: readonly PlanConflict[] }>;

export interface PlanSelectionEvaluation {
  readonly selectedOperations: readonly PlannedOperation[];
  readonly blockingConflicts: readonly PlanConflict[];
  readonly warnings: readonly PlanConflict[];
  readonly affectedFiles: readonly string[];
  readonly undoableOperationIds: readonly string[];
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

const canonicalizeForHash = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalizeForHash)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => codePointCompare(left, right))
      .map(([key, item]) => [key, canonicalizeForHash(item)]))
    : value;

const cloneFieldState = (state: FieldState): FieldState => state.present
  ? { present: true, value: typeof state.value === "string" ? state.value : [...state.value] }
  : { present: false };

const canonicalOperation = (operation: PlannedOperation): PlannedOperation => {
  if (operation.kind === "move" || operation.kind === "rename") {
    return {
      id: operation.id,
      kind: operation.kind,
      sourcePath: normalizeVaultPath(operation.sourcePath),
      targetPath: normalizeVaultPath(operation.targetPath),
    };
  }
  if (operation.kind === "set-owned-field") {
    return {
      id: operation.id,
      kind: operation.kind,
      path: normalizeVaultPath(operation.path),
      field: operation.field,
      before: cloneFieldState(operation.before),
      after: cloneFieldState(operation.after),
    };
  }
  return {
    id: operation.id,
    kind: operation.kind,
    path: normalizeVaultPath(operation.path),
    targetPath: normalizeVaultPath(operation.targetPath),
    before: cloneFieldState(operation.before),
    after: cloneFieldState(operation.after),
  };
};

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
};

const sourcePathOf = (operation: PlannedOperation): string =>
  operation.kind === "move" || operation.kind === "rename" ? operation.sourcePath : operation.path;
const mutationPaths = (operation: PlannedOperation): readonly string[] => {
  if (operation.kind === "move" || operation.kind === "rename") return [operation.sourcePath, operation.targetPath];
  return [operation.path];
};
const dependencyPaths = (operation: PlannedOperation): readonly string[] => {
  if (operation.kind === "move" || operation.kind === "rename") return [operation.sourcePath, operation.targetPath];
  if (operation.kind === "add-related-link") return [operation.path, operation.targetPath];
  return [operation.path];
};
const affectedIdentityPaths = (operation: PlannedOperation): readonly string[] => [sourcePathOf(operation)];
const pathKey = (path: string): string => normalizeVaultPath(path).toLocaleLowerCase("en-US");
const pathList = (paths: readonly string[]): readonly string[] => [...new Set(paths.map(normalizeVaultPath))].sort(codePointCompare);

const structuralGroups = (operations: readonly PlannedOperation[]): ReadonlyMap<string, readonly PlannedOperation[]> => {
  const groups = new Map<string, PlannedOperation[]>();
  for (const operation of operations) {
    if (operation.kind !== "move" && operation.kind !== "rename") continue;
    const key = pathKey(operation.targetPath);
    groups.set(key, [...(groups.get(key) ?? []), operation]);
  }
  return groups;
};

const mutationGroups = (operations: readonly PlannedOperation[]): ReadonlyMap<string, readonly PlannedOperation[]> => {
  const groups = new Map<string, PlannedOperation[]>();
  for (const operation of operations) for (const path of mutationPaths(operation)) {
    const key = pathKey(path);
    const values = groups.get(key) ?? [];
    if (!values.some((value) => value.id === operation.id)) groups.set(key, [...values, operation]);
  }
  return groups;
};

const dynamicSelectionConflicts = (operations: readonly PlannedOperation[]): readonly PlanConflict[] => {
  const conflicts: PlanConflict[] = [];
  for (const group of structuralGroups(operations).values()) {
    if (group.length < 2) continue;
    for (const operation of group) {
      const target = operation.kind === "move" || operation.kind === "rename" ? operation.targetPath : "";
      conflicts.push({ operationId: operation.id, code: "duplicate-target", paths: [target] });
    }
  }
  for (const group of mutationGroups(operations).values()) {
    if (group.length < 2) continue;
    for (const operation of group) {
      conflicts.push({ operationId: operation.id, code: "overlapping-operation", paths: pathList(mutationPaths(operation)) });
    }
  }
  const mutations = mutationGroups(operations);
  for (const operation of operations) {
    if (operation.kind !== "add-related-link") continue;
    const targetKey = pathKey(operation.targetPath);
    const mutators = (mutations.get(targetKey) ?? []).filter((candidate) => candidate.id !== operation.id);
    if (mutators.length === 0) continue;
    conflicts.push({ operationId: operation.id, code: "overlapping-operation", paths: [operation.targetPath] });
    for (const mutator of mutators) {
      conflicts.push({ operationId: mutator.id, code: "overlapping-operation", paths: [operation.targetPath] });
    }
  }
  return conflicts;
};

const conflictSeverity = (conflict: PlanConflict): "blocking" | "warning" =>
  conflict.code === "post-state-drift" && conflict.severity === "warning" ? "warning" : "blocking";

const sanitizeConflict = (conflict: PlanConflict): PlanConflict => {
  const base = {
    operationId: conflict.operationId,
    code: conflict.code,
    paths: pathList(conflict.paths),
  } as const;
  return conflictSeverity(conflict) === "warning" ? { ...base, severity: "warning" } : base;
};

const compareConflicts = (left: PlanConflict, right: PlanConflict): number =>
  codePointCompare(left.operationId, right.operationId)
  || codePointCompare(left.code, right.code)
  || codePointCompare(JSON.stringify(left.paths), JSON.stringify(right.paths))
  || codePointCompare(left.severity ?? "blocking", right.severity ?? "blocking");

const conflictKey = (conflict: PlanConflict): string => JSON.stringify([
  conflict.operationId,
  conflict.code,
  pathList(conflict.paths),
  conflictSeverity(conflict),
]);

const dedupeConflicts = (conflicts: readonly PlanConflict[]): readonly PlanConflict[] => [...new Map(
  conflicts.map((conflict) => {
    const safe = sanitizeConflict(conflict);
    return [conflictKey(safe), safe];
  }),
).values()].sort(compareConflicts);

const defaultRationale = (operation: PlannedOperation): OperationRationale => ({
  source: "local",
  summary: `Review ${operation.kind.replaceAll("-", " ")}`,
  signals: ["direct-user-selection"],
  confidence: "low",
  impact: 0,
});

const copyRationale = (supplied: OperationRationale): OperationRationale => ({
  source: supplied.source,
  summary: supplied.summary,
  signals: [...supplied.signals],
  confidence: supplied.confidence,
  impact: supplied.impact,
});

const assertRationale = (supplied: OperationRationale): void => {
  if (!Number.isFinite(supplied.impact) || supplied.impact < 0) throw new Error("Rationale impact must be finite and non-negative");
  if (!supplied.summary.trim() || supplied.signals.length === 0 || supplied.signals.some((signal) => !signal)) {
    throw new Error("Rationale must include a summary and signals");
  }
};

const sameSafetyMetrics = (left: OperationRationale, right: OperationRationale): boolean =>
  left.confidence === right.confidence
  && left.impact === right.impact
  && left.signals.length === right.signals.length
  && left.signals.every((signal, index) => signal === right.signals[index]);

const resolveRationales = (
  operation: PlannedOperation,
  suppliedDisplay?: OperationRationale,
  suppliedLocal?: OperationRationale,
  allowAiDisplay = false,
): Readonly<{ display: OperationRationale; local: OperationRationale }> => {
  if (suppliedDisplay?.source === "ai-assisted" && (suppliedLocal === undefined || !allowAiDisplay)) {
    throw new Error("Change plans require a local rationale safety baseline");
  }
  const local = suppliedLocal ?? (suppliedDisplay?.source === "local" ? suppliedDisplay : defaultRationale(operation));
  if (local.source !== "local") throw new Error("Change plans require a local rationale safety baseline");
  const display = suppliedDisplay ?? local;
  assertRationale(local);
  assertRationale(display);
  if (!sameSafetyMetrics(display, local)) throw new Error("Displayed rationale cannot alter local safety metrics");
  return {
    display: copyRationale(display),
    local: copyRationale(local),
  };
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isCanonicalPath = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return normalizeVaultPath(value) === value;
  } catch {
    return false;
  }
};
const isPlannedOperation = (value: unknown): value is PlannedOperation => {
  if (!isPlannedOperationSchema(value)) return false;
  if (value.kind === "move" || value.kind === "rename") {
    return isCanonicalPath(value.sourcePath) && isCanonicalPath(value.targetPath);
  }
  if (value.kind === "set-owned-field") {
    return isCanonicalPath(value.path);
  }
  return isCanonicalPath(value.path) && isCanonicalPath(value.targetPath);
};
const isPrecondition = (value: unknown): value is FilePrecondition => {
  return isFilePreconditionSchema(value) && isCanonicalPath(value.path);
};
const isRationale = (value: unknown): value is OperationRationale => isObject(value)
  && (value.source === "local" || value.source === "ai-assisted")
  && typeof value.summary === "string"
  && value.summary.trim().length > 0
  && Array.isArray(value.signals)
  && value.signals.length > 0
  && value.signals.every((signal) => typeof signal === "string" && signal.length > 0)
  && (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low")
  && typeof value.impact === "number"
  && Number.isFinite(value.impact)
  && value.impact >= 0;
const isLocalRationale = (value: unknown): value is OperationRationale => isRationale(value) && value.source === "local";

export function isChangePlanSchema(value: unknown): value is ChangePlan {
  if (
    !isObject(value)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.fingerprint !== "string"
    || value.fingerprint.length === 0
    || !Array.isArray(value.operations)
    || !value.operations.every(isPlannedOperation)
    || !Array.isArray(value.preconditions)
    || !value.preconditions.every(isPrecondition)
    || !isObject(value.rationales)
    || !isObject(value.localRationales)
  ) return false;
  const operationIds = value.operations.map((operation) => operation.id);
  if (new Set(operationIds).size !== operationIds.length) return false;
  const preconditionPaths = value.preconditions.map((precondition) => precondition.path);
  if (new Set(preconditionPaths).size !== preconditionPaths.length) return false;
  const rationales = value.rationales;
  const localRationales = value.localRationales;
  const rationaleKeys = Object.keys(rationales);
  const localRationaleKeys = Object.keys(localRationales);
  return rationaleKeys.length === operationIds.length
    && localRationaleKeys.length === operationIds.length
    && operationIds.every((id) => (
      isRationale(rationales[id])
      && isLocalRationale(localRationales[id])
      && sameSafetyMetrics(rationales[id], localRationales[id])
    ));
}

const fingerprintPayload = (plan: Pick<ChangePlan, "operations" | "preconditions" | "rationales" | "localRationales">): unknown => ({
  operations: plan.operations,
  preconditions: plan.preconditions,
  rationales: plan.rationales,
  localRationales: plan.localRationales,
});

const planFingerprint = (plan: Pick<ChangePlan, "operations" | "preconditions" | "rationales" | "localRationales">): Promise<string> =>
  sha256(JSON.stringify(canonicalizeForHash(fingerprintPayload(plan))));

async function createChangePlan(
  operations: readonly PlannedOperation[],
  preconditions: readonly FilePrecondition[],
  suppliedRationales: Readonly<Record<string, OperationRationale>> = {},
  suppliedLocalRationales: Readonly<Record<string, OperationRationale>> = {},
  isTrustedLocal: (value: OperationRationale | undefined, operation: PlannedOperation) => boolean = () => false,
  preserveOrder = false,
): Promise<ChangePlan> {
  const sortedOperations = [...operations].map(canonicalOperation);
  if (!preserveOrder) sortedOperations.sort((left, right) => codePointCompare(left.id, right.id));
  const uniquePreconditions = new Map<string, FilePrecondition>();
  for (const precondition of preconditions) uniquePreconditions.set(normalizeVaultPath(precondition.path), {
    ...precondition,
    path: normalizeVaultPath(precondition.path),
  });
  const sortedPreconditions = [...uniquePreconditions.values()]
    .sort((left, right) => codePointCompare(left.path, right.path));
  const rationales: Record<string, OperationRationale> = {};
  const localRationales: Record<string, OperationRationale> = {};
  for (const operation of sortedOperations) {
    const resolved = resolveRationales(
      operation,
      suppliedRationales[operation.id],
      suppliedLocalRationales[operation.id],
      isTrustedLocal(suppliedLocalRationales[operation.id], operation),
    );
    rationales[operation.id] = resolved.display;
    localRationales[operation.id] = resolved.local;
  }
  const fingerprint = await planFingerprint({
    operations: sortedOperations,
    preconditions: sortedPreconditions,
    rationales,
    localRationales,
  });
  return {
    id: fingerprint.slice(0, 16),
    fingerprint,
    operations: sortedOperations,
    preconditions: sortedPreconditions,
    rationales,
    localRationales,
  };
}

export async function verifyPlanFingerprint(plan: ChangePlan): Promise<boolean> {
  try {
    if (!isChangePlanSchema(plan)) return false;
    const expected = await planFingerprint(plan);
    return expected === plan.fingerprint && plan.id === expected.slice(0, 16);
  } catch {
    return false;
  }
}

export const samePrecondition = (left: FilePrecondition, right: FilePrecondition): boolean =>
  normalizeVaultPath(left.path) === normalizeVaultPath(right.path)
  && left.exists === right.exists
  && (!left.exists || !right.exists || (left.mtime === right.mtime && left.contentHash === right.contentHash));

const relatedPathKey = (value: string): string => {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[[") && trimmed.endsWith("]]" ) ? trimmed.slice(2, -2) : trimmed;
  const withoutAlias = inner.split("|", 1)[0] ?? inner;
  const markdownPath = withoutAlias.toLocaleLowerCase("en-US").endsWith(".md") ? withoutAlias : `${withoutAlias}.md`;
  return pathKey(markdownPath);
};

const relatedSemanticsValid = (operation: Extract<PlannedOperation, { kind: "add-related-link" }>): boolean => {
  const before = operation.before.present && isStringArray(operation.before.value) ? operation.before.value : operation.before.present ? null : [];
  const after = operation.after.present && isStringArray(operation.after.value) ? operation.after.value : null;
  if (before === null || after === null || after.length !== before.length + 1) return false;
  if (!before.every((value, index) => after[index] === value)) return false;
  return relatedPathKey(after.at(-1)!) === pathKey(operation.targetPath)
    && !before.some((value) => relatedPathKey(value) === pathKey(operation.targetPath));
};

const relatedInverseRemovalValid = (operation: Extract<PlannedOperation, { kind: "set-owned-field" }>): boolean => {
  if (operation.field !== "knowledge-workbench-related") return true;
  if (!operation.before.present || !isStringArray(operation.before.value) || operation.before.value.length === 0) return false;
  if (!operation.after.present) return operation.before.value.length === 1;
  if (!isStringArray(operation.after.value) || operation.after.value.length !== operation.before.value.length - 1) return false;
  return operation.after.value.every((value, index) => operation.before.present
    && isStringArray(operation.before.value)
    && operation.before.value[index] === value);
};

export function evaluatePlanSelection(preview: PlanPreview, selectedIds: readonly string[]): PlanSelectionEvaluation {
  const selectedSet = new Set(selectedIds);
  const selectedOperations = preview.plan.operations.filter((operation) => selectedSet.has(operation.id));
  const relevantBase = preview.conflicts.filter((conflict) => (
    conflict.code !== "duplicate-target"
    && conflict.code !== "overlapping-operation"
    && (conflict.operationId === "plan" || selectedSet.has(conflict.operationId))
  ));
  const conflicts = dedupeConflicts([...relevantBase, ...dynamicSelectionConflicts(selectedOperations)]);
  const affected = new Set(selectedOperations.flatMap(affectedIdentityPaths));
  for (const conflict of conflicts) {
    if (conflict.operationId !== "plan" && selectedSet.has(conflict.operationId) && conflict.code === "inbound-links") {
      for (const path of conflict.paths) affected.add(path);
    }
  }
  return deepFreeze({
    selectedOperations: structuredClone(selectedOperations),
    blockingConflicts: conflicts.filter((conflict) => conflictSeverity(conflict) === "blocking"),
    warnings: conflicts.filter((conflict) => conflictSeverity(conflict) === "warning"),
    affectedFiles: [...affected].map(normalizeVaultPath).sort(codePointCompare),
    undoableOperationIds: selectedOperations.map((operation) => operation.id).sort(codePointCompare),
  });
}

export class ChangePlanService {
  private readonly authenticPreviews = new WeakSet<object>();
  private readonly orderedPreviews = new WeakSet<object>();
  private readonly trustedLocalRationales = new WeakMap<object, string>();

  constructor(private readonly vault: VaultReadPort, private readonly isWriteEnabled: () => boolean) {}

  async preview(
    operations: readonly PlannedOperation[],
    suppliedConflicts: readonly PlanConflict[] = [],
    suppliedRationales: Readonly<Record<string, OperationRationale>> = {},
    suppliedLocalRationales: Readonly<Record<string, OperationRationale>> = {},
  ): Promise<PlanPreview> {
    return await this.previewInternal(operations, suppliedConflicts, suppliedRationales, suppliedLocalRationales, false);
  }

  async previewOrdered(
    operations: readonly PlannedOperation[],
    suppliedConflicts: readonly PlanConflict[] = [],
    suppliedRationales: Readonly<Record<string, OperationRationale>> = {},
    suppliedLocalRationales: Readonly<Record<string, OperationRationale>> = {},
  ): Promise<PlanPreview> {
    return await this.previewInternal(operations, suppliedConflicts, suppliedRationales, suppliedLocalRationales, true);
  }

  private async previewInternal(
    operations: readonly PlannedOperation[],
    suppliedConflicts: readonly PlanConflict[],
    suppliedRationales: Readonly<Record<string, OperationRationale>>,
    suppliedLocalRationales: Readonly<Record<string, OperationRationale>>,
    preserveOrder: boolean,
  ): Promise<PlanPreview> {
    const canonicalOperations = operations.map(canonicalOperation);
    for (const operation of canonicalOperations) {
      resolveRationales(
        operation,
        suppliedRationales[operation.id],
        suppliedLocalRationales[operation.id],
        this.isTrustedLocal(suppliedLocalRationales[operation.id], operation),
      );
    }
    if (canonicalOperations.length > 50) {
      return await this.finishPreview(canonicalOperations, [], [
        ...suppliedConflicts,
        { operationId: "plan", code: "too-many-operations", paths: [] },
      ], suppliedRationales, suppliedLocalRationales, preserveOrder);
    }

    const conflicts: PlanConflict[] = [...suppliedConflicts];
    conflicts.push(...dynamicSelectionConflicts(canonicalOperations));
    const existingPaths = new Set((await this.vault.listMarkdownPaths()).map(normalizeVaultPath));
    const paths = pathList(canonicalOperations.flatMap(dependencyPaths));
    const initialSnapshots = new Map<string, FilePrecondition>();
    for (const path of paths) initialSnapshots.set(path, await this.vault.snapshot(path));

    for (const operation of [...canonicalOperations].sort((left, right) => codePointCompare(left.id, right.id))) {
      conflicts.push(...await this.validateOperation(operation, existingPaths));
    }

    for (const path of paths) {
      const initial = initialSnapshots.get(path)!;
      const current = await this.vault.snapshot(path);
      if (!samePrecondition(initial, current)) conflicts.push({ operationId: "plan", code: "precondition-drift", paths: [path] });
    }
    return await this.finishPreview(
      canonicalOperations,
      [...initialSnapshots.values()],
      conflicts,
      suppliedRationales,
      suppliedLocalRationales,
      preserveOrder,
    );
  }

  async confirm(preview: PlanPreview, selectedIds: readonly string[]): Promise<ConfirmedPlan> {
    if (!this.isWriteEnabled()) throw new Error("Write operations are locked");
    if (!this.authenticPreviews.has(preview)) throw new Error("Plan preview is not authentic");
    if (new Set(preview.plan.operations.map((operation) => operation.id)).size !== preview.plan.operations.length) {
      throw new Error("Duplicate operation IDs");
    }
    if (new Set(selectedIds).size !== selectedIds.length) throw new Error("Duplicate selected operation IDs");
    const knownIds = new Set(preview.plan.operations.map((operation) => operation.id));
    const unknown = selectedIds.find((id) => !knownIds.has(id));
    if (unknown !== undefined) throw new Error(`Unknown selected operation ID: ${unknown}`);
    if (selectedIds.length === 0) throw new Error("Select at least one operation");
    if (!await verifyPlanFingerprint(preview.plan)) throw new Error("Plan fingerprint is invalid");
    const selection = evaluatePlanSelection(preview, selectedIds);
    if (selection.blockingConflicts.length > 0) throw new Error("Plan has blocking conflicts");

    const rationales = Object.fromEntries(selection.selectedOperations.map((operation) => [
      operation.id,
      preview.plan.rationales[operation.id] ?? defaultRationale(operation),
    ]));
    const localRationales = Object.fromEntries(selection.selectedOperations.map((operation) => [
      operation.id,
      preview.plan.localRationales[operation.id] ?? defaultRationale(operation),
    ]));
    const preserveOrder = this.orderedPreviews.has(preview);
    const fresh = preserveOrder
      ? await this.previewOrdered(selection.selectedOperations, [], rationales, localRationales)
      : await this.preview(selection.selectedOperations, [], rationales, localRationales);
    const freshEvaluation = evaluatePlanSelection(fresh, selectedIds);
    if (freshEvaluation.blockingConflicts.length > 0) throw new Error("Plan has blocking conflicts");
    const confirmed = await createChangePlan(
      freshEvaluation.selectedOperations,
      fresh.plan.preconditions,
      rationales,
      localRationales,
      (value, operation) => this.isTrustedLocal(value, operation),
      preserveOrder,
    );
    if (!this.isWriteEnabled()) throw new Error("Write operations are locked");
    return deepFreeze(structuredClone(confirmed)) as ConfirmedPlan;
  }

  async revalidate(plan: ChangePlan): Promise<RevalidationResult> {
    if (!isChangePlanSchema(plan)) {
      return deepFreeze({
        ok: false,
        conflicts: [{ operationId: "plan", code: "precondition-drift", paths: [] }],
      });
    }
    const conflicts: PlanConflict[] = [];
    if (!await verifyPlanFingerprint(plan)) {
      conflicts.push({ operationId: "plan", code: "precondition-drift", paths: [] });
    }
    if (plan.operations.length === 0) {
      conflicts.push({ operationId: "plan", code: "precondition-drift", paths: [] });
    } else if (plan.operations.length > 50) {
      conflicts.push({ operationId: "plan", code: "too-many-operations", paths: [] });
    }
    const dependencyPathList = pathList(plan.operations.flatMap(dependencyPaths));
    const preconditionPathList = pathList(plan.preconditions.map((value) => value.path));
    const dependencyPathsSet = new Set(dependencyPathList);
    const preconditionPathsSet = new Set(preconditionPathList);
    const coverageMismatch = pathList([
      ...dependencyPathList.filter((path) => !preconditionPathsSet.has(path)),
      ...preconditionPathList.filter((path) => !dependencyPathsSet.has(path)),
    ]);
    if (coverageMismatch.length > 0) {
      conflicts.push({ operationId: "plan", code: "precondition-drift", paths: coverageMismatch });
    }
    if (new Set(plan.operations.map((operation) => operation.id)).size !== plan.operations.length) {
      conflicts.push({ operationId: "plan", code: "overlapping-operation", paths: [] });
    }
    if (!this.isWriteEnabled()) conflicts.push({ operationId: "plan", code: "write-locked", paths: [] });
    for (const expected of plan.preconditions) {
      const current = await this.vault.snapshot(normalizeVaultPath(expected.path));
      if (!samePrecondition(current, expected)) conflicts.push({ operationId: "plan", code: "precondition-drift", paths: [expected.path] });
    }
    conflicts.push(...dynamicSelectionConflicts(plan.operations));
    for (const operation of plan.operations) {
      const result = await this.revalidateOperation(operation);
      if (!result.ok) conflicts.push(...result.conflicts);
    }
    if (!this.isWriteEnabled()) conflicts.push({ operationId: "plan", code: "write-locked", paths: [] });
    const stable = dedupeConflicts(conflicts);
    return stable.length === 0 ? { ok: true } : deepFreeze({ ok: false, conflicts: stable });
  }

  async revalidateOperation(operation: PlannedOperation): Promise<RevalidationResult> {
    const candidate: unknown = operation;
    if (!isPlannedOperation(candidate)) {
      const operationId = isObject(candidate) && typeof candidate.id === "string" && candidate.id.length > 0
        ? candidate.id
        : "plan";
      const conflicts: PlanConflict[] = [{ operationId, code: "invalid-path", paths: [] }];
      if (!this.isWriteEnabled()) conflicts.push({ operationId: "plan", code: "write-locked", paths: [] });
      return deepFreeze({ ok: false, conflicts: dedupeConflicts(conflicts) });
    }
    const canonical = canonicalOperation(candidate);
    const existingPaths = new Set((await this.vault.listMarkdownPaths()).map(normalizeVaultPath));
    const conflicts: PlanConflict[] = [];
    if (!this.isWriteEnabled()) conflicts.push({ operationId: "plan", code: "write-locked", paths: [] });
    conflicts.push(...await this.validateOperation(canonical, existingPaths));
    if (!this.isWriteEnabled()) conflicts.push({ operationId: "plan", code: "write-locked", paths: [] });
    const stable = dedupeConflicts(conflicts);
    return stable.length === 0 ? { ok: true } : deepFreeze({ ok: false, conflicts: stable });
  }

  private async validateOperation(
    operation: PlannedOperation,
    existingPaths: ReadonlySet<string>,
  ): Promise<readonly PlanConflict[]> {
    const conflicts: PlanConflict[] = [];
    const source = sourcePathOf(operation);
    if (!validateTargetPath("", source, new Set()).ok) {
      conflicts.push({ operationId: operation.id, code: "invalid-path", paths: [source] });
    }
    const sourceSnapshot = await this.vault.snapshot(source);
    if (!sourceSnapshot.exists) conflicts.push({ operationId: operation.id, code: "source-missing", paths: [source] });

    if (operation.kind === "move" || operation.kind === "rename") {
      const targetValidation = validateTargetPath(source, operation.targetPath, existingPaths);
      if (!targetValidation.ok) conflicts.push({ operationId: operation.id, code: targetValidation.code, paths: [operation.targetPath] });
      const links = await this.vault.inboundLinks(source);
      if (links === null) conflicts.push({ operationId: operation.id, code: "metadata-not-ready", paths: [source] });
      else if (links.length > 0) conflicts.push({ operationId: operation.id, code: "inbound-links", paths: pathList(links) });
      const target = await this.vault.snapshot(operation.targetPath);
      if (target.exists) conflicts.push({ operationId: operation.id, code: "target-exists", paths: [operation.targetPath] });
    } else {
      const field = operation.kind === "set-owned-field" ? operation.field : "knowledge-workbench-related";
      const current = await this.vault.readOwnedField(source, field);
      if (sourceSnapshot.exists && current === null) {
        conflicts.push({ operationId: operation.id, code: "frontmatter-unreadable", paths: [source] });
      } else if (current !== null && !sameFieldState(current, operation.before)) {
        conflicts.push({ operationId: operation.id, code: "owned-field-drift", paths: [source] });
      }
      if (operation.kind === "set-owned-field" && !relatedInverseRemovalValid(operation)) {
        conflicts.push({ operationId: operation.id, code: "owned-field-drift", paths: [source] });
      }
      if (operation.kind === "add-related-link") {
        if (!validateTargetPath("", operation.targetPath, new Set()).ok) {
          conflicts.push({ operationId: operation.id, code: "invalid-path", paths: [operation.targetPath] });
        }
        if (!relatedSemanticsValid(operation)) conflicts.push({ operationId: operation.id, code: "owned-field-drift", paths: [source] });
        const target = await this.vault.snapshot(operation.targetPath);
        if (!target.exists) conflicts.push({ operationId: operation.id, code: "related-target-missing", paths: [operation.targetPath] });
      }
    }
    return conflicts;
  }

  private async finishPreview(
    operations: readonly PlannedOperation[],
    preconditions: readonly FilePrecondition[],
    conflicts: readonly PlanConflict[],
    rationales: Readonly<Record<string, OperationRationale>>,
    localRationales: Readonly<Record<string, OperationRationale>>,
    preserveOrder = false,
  ): Promise<PlanPreview> {
    const plan = await createChangePlan(
      operations,
      preconditions,
      rationales,
      localRationales,
      (value, operation) => this.isTrustedLocal(value, operation),
      preserveOrder,
    );
    for (const operation of plan.operations) {
      if (plan.rationales[operation.id]?.source === "ai-assisted") {
        const local = plan.localRationales[operation.id];
        if (local !== undefined) this.trustedLocalRationales.set(local, operationSafetyKey(operation));
      }
    }
    const base: PlanPreview = {
      plan,
      conflicts: dedupeConflicts(conflicts),
      affectedFiles: [],
      undoableOperationIds: [],
    };
    const evaluation = evaluatePlanSelection(base, plan.operations.map((operation) => operation.id));
    const preview = deepFreeze({
      ...base,
      affectedFiles: evaluation.affectedFiles,
      undoableOperationIds: evaluation.undoableOperationIds,
    });
    this.authenticPreviews.add(preview);
    if (preserveOrder) this.orderedPreviews.add(preview);
    return preview;
  }

  private isTrustedLocal(value: OperationRationale | undefined, operation: PlannedOperation): boolean {
    return value !== undefined
      && (
        isAuthenticatedLocalRationale(value, operation)
        || this.trustedLocalRationales.get(value) === operationSafetyKey(operation)
      );
  }
}
