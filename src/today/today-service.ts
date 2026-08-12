import type { Clock } from "../core/ports";
import type { DocumentKind, DocumentRecord } from "../core/types";
import type { OperationalState } from "../storage/plugin-data";

export type TodayReason =
  | "pinned"
  | "unclassified"
  | "recently-opened"
  | "recently-edited"
  | "high-confidence-suggestion";

export interface SuggestionSummary {
  readonly suggestionId: string;
  readonly documentId: string;
  readonly confidence: "high" | "medium" | "low";
  readonly impact: number;
  readonly explanation: string;
  readonly actionLabel: string;
}

export interface TodayInput extends Pick<OperationalState, "pins" | "dismissals" | "lastOpened"> {
  readonly records: readonly DocumentRecord[];
  readonly suggestions: readonly SuggestionSummary[];
}

export interface TodayItem {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly kind: DocumentKind;
  readonly reason: TodayReason;
  readonly explanation: string;
  readonly actionLabel: string;
  readonly suggestionId?: string;
  readonly score: number;
  readonly activityAt: number;
}

export interface TodayViewModel {
  readonly newItems: readonly TodayItem[];
  readonly continueItems: readonly TodayItem[];
  readonly nextItems: readonly TodayItem[];
}

const DAY = 86_400_000;
const DISMISSAL_TTL = 30 * DAY;
const GROUP_LIMIT = 7;
const PINNED_BONUS = 1_000;
const UNCLASSIFIED_BONUS = 500;
const SUGGESTION_BONUS = 300;

const codePointCompare = (left: string, right: string): number => {
  const leftCodePoints = left[Symbol.iterator]();
  const rightCodePoints = right[Symbol.iterator]();
  while (true) {
    const leftCodePoint = leftCodePoints.next();
    const rightCodePoint = rightCodePoints.next();
    if (leftCodePoint.done || rightCodePoint.done) {
      if (leftCodePoint.done && rightCodePoint.done) return 0;
      return leftCodePoint.done ? -1 : 1;
    }
    const difference = leftCodePoint.value.codePointAt(0)! - rightCodePoint.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
};

const recencyScore = (now: number, activityAt: number): number => {
  const age = now - activityAt;
  if (age <= 0) return 100;
  if (age >= DISMISSAL_TTL) return 0;
  return 100 * (1 - age / DISMISSAL_TTL);
};

const isRecent = (now: number, activityAt: number): boolean => now - activityAt <= DISMISSAL_TTL;

const sortAndCap = (items: readonly TodayItem[]): readonly TodayItem[] => [...items]
  .sort((left, right) => (
    right.score - left.score
    || right.activityAt - left.activityAt
    || codePointCompare(left.path, right.path)
  ))
  .slice(0, GROUP_LIMIT);

const clampedImpact = (impact: number): number => Math.min(100, Math.max(0, impact));

export class TodayService {
  constructor(private readonly clock: Clock) {}

  build(input: TodayInput): TodayViewModel {
    const now = this.clock.now();
    const visible = input.records.filter((record) => {
      const dismissal = input.dismissals[record.id];
      return dismissal === undefined
        || dismissal.mtime !== record.mtime
        || now - dismissal.dismissedAt >= DISMISSAL_TTL;
    });
    const isPinned = (record: DocumentRecord): boolean => Object.prototype.hasOwnProperty.call(input.pins, record.id);
    const toItem = (
      record: DocumentRecord,
      reason: TodayReason,
      bonus: number,
      activityAt: number,
      explanation: string,
      actionLabel: string,
      suggestionId?: string,
    ): TodayItem => ({
      id: record.id,
      path: record.path,
      title: record.title,
      kind: record.kind,
      reason,
      explanation,
      actionLabel,
      suggestionId,
      score: (isPinned(record) ? PINNED_BONUS : 0) + bonus + recencyScore(now, activityAt),
      activityAt,
    });

    const newItems = sortAndCap(visible.flatMap((record) => {
      if (record.kind !== "unclassified" || (!isPinned(record) && !isRecent(now, record.mtime))) return [];
      const pinned = isPinned(record);
      return [toItem(
        record,
        pinned ? "pinned" : "unclassified",
        UNCLASSIFIED_BONUS,
        record.mtime,
        pinned ? "Pinned for today" : "No confirmed note kind or topic",
        "Review note",
      )];
    }));

    const continueItems = sortAndCap(visible.flatMap((record) => {
      if (record.kind === "unclassified") return [];
      const openedAt = input.lastOpened[record.id];
      const activityAt = openedAt === undefined ? record.mtime : Math.max(record.mtime, openedAt);
      if (!isPinned(record) && !isRecent(now, activityAt)) return [];
      if (isPinned(record)) {
        return [toItem(record, "pinned", 0, activityAt, "Pinned for today", "Continue note")];
      }
      const openedMoreRecently = openedAt !== undefined && openedAt > record.mtime;
      return [toItem(
        record,
        openedMoreRecently ? "recently-opened" : "recently-edited",
        0,
        activityAt,
        openedMoreRecently ? "Opened recently" : "Edited recently",
        "Continue note",
      )];
    }));

    const recordsById = new Map(visible.map((record) => [record.id, record]));
    const next = input.suggestions
      .filter((suggestion) => (
        suggestion.confidence === "high"
        && Number.isFinite(suggestion.impact)
        && recordsById.has(suggestion.documentId)
      ))
      .sort((left, right) => (
        right.impact - left.impact
        || codePointCompare(left.suggestionId, right.suggestionId)
      ))[0];
    const nextRecord = next === undefined ? undefined : recordsById.get(next.documentId);
    const nextItems = next === undefined || nextRecord === undefined
      ? []
      : [toItem(
        nextRecord,
        "high-confidence-suggestion",
        SUGGESTION_BONUS + clampedImpact(next.impact),
        Math.max(nextRecord.mtime, input.lastOpened[nextRecord.id] ?? nextRecord.mtime),
        next.explanation,
        next.actionLabel,
        next.suggestionId,
      )];

    return { newItems, continueItems, nextItems };
  }
}
