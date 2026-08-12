import type { DocumentKind, DocumentRecord } from "../core/types";
import { RelationScorer, type RelationReason } from "./relation-scorer";

export interface TopicCluster {
  readonly id: string;
  readonly label: string;
  readonly memberIds: readonly string[];
  readonly contributingSignals: readonly string[];
  readonly confidence: "high" | "medium" | "low";
}

export interface MapNode {
  readonly id: string;
  readonly nodeType: "document" | "topic";
  readonly path?: string;
  readonly title: string;
  readonly kind: DocumentKind | "topic";
  readonly shape: "circle" | "square" | "diamond";
}

export interface MapEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly score: number;
  readonly reasons: readonly RelationReason[];
  readonly confirmed: boolean;
}

export interface MapNodeDetails {
  readonly nodeId: string;
  readonly path?: string;
  readonly topics: readonly string[];
  readonly connectedNodeIds: readonly string[];
  readonly relations: readonly {
    readonly nodeId: string;
    readonly explanation: string;
    readonly confirmed: boolean;
  }[];
}

export interface FocusedMap {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly selected: MapNodeDetails | null;
  readonly truncated: boolean;
}

export type MapFilter = "all" | "note" | "reference";

export interface FocusMapInput {
  readonly records: readonly DocumentRecord[];
  readonly clusters?: readonly TopicCluster[];
  readonly center: Readonly<{ kind: "document" | "topic"; id: string }>;
  readonly filter: MapFilter;
}

export interface MapSearchResult {
  readonly documentId: string;
  readonly path: string;
  readonly title: string;
  readonly matchedBy: readonly ("title" | "heading" | "token")[];
}

interface CrossingCandidate {
  readonly edge: MapEdge;
  readonly targetId: string;
}

const CONFIRMED_TOPICS_FIELD = "knowledge-workbench-topics";
const FOCUS_NODE_LIMIT = 50;
const SCORE_CHECKPOINT = 500;
const TOPIC_EDGE_REASON: readonly RelationReason[] = [{ code: "confirmed-topic", weight: 80 }];

const stringList = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

const normalizeText = (value: string): string =>
  value.trim().normalize("NFC").toLocaleLowerCase("en-US");

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

const compareRecordsByPath = (left: DocumentRecord, right: DocumentRecord): number =>
  codePointCompare(left.path, right.path) || codePointCompare(left.id, right.id);

const stableTopicLabels = (record: DocumentRecord): readonly string[] => {
  const labelsByKey = new Map<string, string>();
  for (const raw of stringList(record.ownedFields[CONFIRMED_TOPICS_FIELD])) {
    const label = raw.trim().normalize("NFC");
    const key = normalizeText(label);
    if (!key) continue;
    const current = labelsByKey.get(key);
    if (current === undefined || codePointCompare(label, current) < 0) labelsByKey.set(key, label);
  }
  return [...labelsByKey.entries()]
    .sort(([left], [right]) => codePointCompare(left, right))
    .map(([, label]) => label);
};

interface MutableTopicCluster {
  readonly labels: Set<string>;
  readonly memberIds: Set<string>;
}

export function buildTopicClusters(records: readonly DocumentRecord[]): readonly TopicCluster[] {
  const grouped = new Map<string, MutableTopicCluster>();
  for (const record of records) {
    for (const raw of stringList(record.ownedFields[CONFIRMED_TOPICS_FIELD])) {
      const label = raw.trim().normalize("NFC");
      const key = normalizeText(label);
      if (!key) continue;
      const cluster = grouped.get(key) ?? { labels: new Set<string>(), memberIds: new Set<string>() };
      cluster.labels.add(label);
      cluster.memberIds.add(record.id);
      grouped.set(key, cluster);
    }
  }

  return [...grouped.entries()]
    .map(([key, cluster]): TopicCluster => ({
      id: `topic:${key}`,
      label: [...cluster.labels].sort(codePointCompare)[0]!,
      memberIds: [...cluster.memberIds].sort(codePointCompare),
      contributingSignals: ["confirmed-topic-property"],
      confidence: "high",
    }))
    .sort((left, right) => codePointCompare(left.id, right.id));
}

const mapNode = (record: DocumentRecord): MapNode => ({
  id: record.id,
  nodeType: "document",
  path: record.path,
  title: record.title,
  kind: record.kind,
  shape: record.kind === "note" ? "circle" : record.kind === "reference" ? "square" : "diamond",
});

const topicNode = (cluster: TopicCluster): MapNode => ({
  id: cluster.id,
  nodeType: "topic",
  title: cluster.label,
  kind: "topic",
  shape: "diamond",
});

const emptyFocusedMap = (): FocusedMap => ({ nodes: [], edges: [], selected: null, truncated: false });

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException("Map calculation canceled", "AbortError");
};

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

const isConfirmed = (reasons: readonly RelationReason[]): boolean =>
  reasons.some((reason) => reason.code === "explicit-link" || reason.code === "confirmed-topic");

const crossesSelection = (edge: MapEdge, selectedIds: ReadonlySet<string>): boolean =>
  selectedIds.has(edge.sourceId) !== selectedIds.has(edge.targetId);

const unselectedEndpoint = (edge: MapEdge, selectedIds: ReadonlySet<string>): string =>
  selectedIds.has(edge.sourceId) ? edge.targetId : edge.sourceId;

const explainEdge = (edge: MapEdge): string => edge.reasons
  .map((reason) => `${reason.code.replaceAll("-", " ")} (${reason.weight})`)
  .join(", ");

const buildNodeDetails = (
  selectedId: string,
  recordsById: ReadonlyMap<string, DocumentRecord>,
  selectedCluster: TopicCluster | undefined,
  edges: readonly MapEdge[],
): MapNodeDetails => {
  const record = recordsById.get(selectedId);
  const connected = edges.filter((edge) => edge.sourceId === selectedId || edge.targetId === selectedId);
  const otherId = (edge: MapEdge): string => edge.sourceId === selectedId ? edge.targetId : edge.sourceId;

  return {
    nodeId: selectedId,
    path: record?.path,
    topics: record === undefined ? selectedCluster === undefined ? [] : [selectedCluster.label] : stableTopicLabels(record),
    connectedNodeIds: connected.map(otherId).sort(codePointCompare),
    relations: connected
      .map((edge) => ({ nodeId: otherId(edge), explanation: explainEdge(edge), confirmed: edge.confirmed }))
      .sort((left, right) => codePointCompare(left.nodeId, right.nodeId)),
  };
};

export class MapService {
  constructor(
    private readonly scorer = new RelationScorer(),
    private readonly yieldControl: () => Promise<void> = yieldToEventLoop,
  ) {}

  search(records: readonly DocumentRecord[], query: string): readonly MapSearchResult[] {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return [];

    return records
      .flatMap((record): MapSearchResult[] => {
        const matchedBy: MapSearchResult["matchedBy"][number][] = [];
        if (normalizeText(record.title).includes(normalizedQuery)) matchedBy.push("title");
        if (record.headings.some((heading) => normalizeText(heading).includes(normalizedQuery))) {
          matchedBy.push("heading");
        }
        if (record.tokens.some((token) => normalizeText(token).includes(normalizedQuery))) matchedBy.push("token");
        return matchedBy.length === 0
          ? []
          : [{ documentId: record.id, path: record.path, title: record.title, matchedBy }];
      })
      .sort((left, right) =>
        right.matchedBy.length - left.matchedBy.length
        || codePointCompare(left.path, right.path)
        || codePointCompare(left.documentId, right.documentId))
      .slice(0, FOCUS_NODE_LIMIT);
  }

  async focus(
    input: FocusMapInput,
    signal: AbortSignal,
    onProgress: (scoredPairs: number) => void,
  ): Promise<FocusedMap> {
    throwIfAborted(signal);

    const eligible = input.records
      .filter((record) => input.filter === "all" || record.kind === input.filter)
      .sort(compareRecordsByPath);
    const recordsById = new Map(eligible.map((record) => [record.id, record]));
    const clusters = input.clusters ?? buildTopicClusters(input.records);
    const centerRecord = input.center.kind === "document" ? recordsById.get(input.center.id) : undefined;
    const centerCluster = input.center.kind === "topic"
      ? clusters.find((cluster) => cluster.id === input.center.id)
      : undefined;

    if (centerRecord === undefined && centerCluster === undefined) {
      throwIfAborted(signal);
      return emptyFocusedMap();
    }

    const candidates: MapEdge[] = centerCluster === undefined
      ? []
      : [...this.buildTopicEdges(centerCluster, recordsById)];
    const selectedId = centerRecord?.id ?? centerCluster!.id;
    const selectedIds = new Set([selectedId]);
    const nodes: MapNode[] = [centerRecord === undefined ? topicNode(centerCluster!) : mapNode(centerRecord)];
    let scoredPairs = 0;
    const scoreFrontier = async (selectedRecord: DocumentRecord): Promise<void> => {
      for (const unselectedRecord of eligible) {
        if (selectedIds.has(unselectedRecord.id)) continue;
        throwIfAborted(signal);
        const [left, right] = compareRecordsByPath(selectedRecord, unselectedRecord) <= 0
          ? [selectedRecord, unselectedRecord]
          : [unselectedRecord, selectedRecord];
        const score = this.scorer.score(left, right);
        scoredPairs += 1;
        if (score.total > 0) {
          candidates.push({
            sourceId: left.id,
            targetId: right.id,
            score: score.total,
            reasons: score.reasons,
            confirmed: isConfirmed(score.reasons),
          });
        }
        if (scoredPairs % SCORE_CHECKPOINT === 0) {
          onProgress(scoredPairs);
          await this.yieldControl();
          throwIfAborted(signal);
        }
      }
    };

    if (centerRecord !== undefined) await scoreFrontier(centerRecord);

    while (nodes.length < FOCUS_NODE_LIMIT) {
      throwIfAborted(signal);
      let next: CrossingCandidate | undefined;
      for (const edge of candidates) {
        if (!crossesSelection(edge, selectedIds)) continue;
        const candidate = { edge, targetId: unselectedEndpoint(edge, selectedIds) };
        if (next === undefined || this.compareCrossingCandidates(candidate, next, recordsById) < 0) {
          next = candidate;
        }
      }
      if (next === undefined) break;

      const nextRecord = recordsById.get(next.targetId);
      if (nextRecord === undefined) break;
      selectedIds.add(next.targetId);
      nodes.push(mapNode(nextRecord));
      await scoreFrontier(nextRecord);
    }

    const truncated = nodes.length === FOCUS_NODE_LIMIT
      && candidates.some((edge) => crossesSelection(edge, selectedIds));
    const edges = candidates
      .filter((edge) => selectedIds.has(edge.sourceId) && selectedIds.has(edge.targetId))
      .sort((left, right) => this.compareEdges(left, right, recordsById));
    const selected = buildNodeDetails(selectedId, recordsById, centerCluster, edges);

    throwIfAborted(signal);
    return { nodes, edges, selected, truncated };
  }

  private buildTopicEdges(
    cluster: TopicCluster,
    recordsById: ReadonlyMap<string, DocumentRecord>,
  ): readonly MapEdge[] {
    return [...new Set(cluster.memberIds)]
      .filter((id) => recordsById.has(id))
      .sort((left, right) =>
        codePointCompare(this.nodeSortKey(left, recordsById), this.nodeSortKey(right, recordsById))
        || codePointCompare(left, right))
      .map((id) => ({
        sourceId: cluster.id,
        targetId: id,
        score: 80,
        reasons: TOPIC_EDGE_REASON,
        confirmed: true,
      }));
  }

  private nodeSortKey(id: string, recordsById: ReadonlyMap<string, DocumentRecord>): string {
    return recordsById.get(id)?.path ?? id;
  }

  private compareCrossingCandidates(
    left: CrossingCandidate,
    right: CrossingCandidate,
    recordsById: ReadonlyMap<string, DocumentRecord>,
  ): number {
    return right.edge.score - left.edge.score
      || codePointCompare(this.nodeSortKey(left.targetId, recordsById), this.nodeSortKey(right.targetId, recordsById))
      || codePointCompare(left.targetId, right.targetId)
      || this.compareEdges(left.edge, right.edge, recordsById);
  }

  private compareEdges(
    left: MapEdge,
    right: MapEdge,
    recordsById: ReadonlyMap<string, DocumentRecord>,
  ): number {
    return codePointCompare(this.nodeSortKey(left.sourceId, recordsById), this.nodeSortKey(right.sourceId, recordsById))
      || codePointCompare(left.sourceId, right.sourceId)
      || codePointCompare(this.nodeSortKey(left.targetId, recordsById), this.nodeSortKey(right.targetId, recordsById))
      || codePointCompare(left.targetId, right.targetId);
  }
}
