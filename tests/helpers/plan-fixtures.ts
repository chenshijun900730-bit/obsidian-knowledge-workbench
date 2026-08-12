import { sha256 } from "../../src/core/hash";
import type { ChangePlan } from "../../src/plans/change-plan-service";

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

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => codePointCompare(left, right))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value;

export async function refingerprintPlan(plan: ChangePlan): Promise<ChangePlan> {
  const fingerprint = await sha256(JSON.stringify(canonicalize({
    operations: plan.operations,
    preconditions: plan.preconditions,
    rationales: plan.rationales,
    localRationales: plan.localRationales,
  })));
  return { ...structuredClone(plan), id: fingerprint.slice(0, 16), fingerprint };
}
