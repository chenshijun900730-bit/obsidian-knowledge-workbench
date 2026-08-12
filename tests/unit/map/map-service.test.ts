import { setTimeout as nodeSetTimeout } from "node:timers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DocumentRecord } from "../../../src/core/types";
import {
  buildTopicClusters,
  MapService,
  type FocusMapInput,
  type FocusedMap,
  type MapEdge,
  type MapNode,
  type TopicCluster,
} from "../../../src/map/map-service";
import { RelationScorer } from "../../../src/map/relation-scorer";

beforeAll(() => vi.stubGlobal("window", { setTimeout: nodeSetTimeout }));
afterAll(() => vi.unstubAllGlobals());

const record = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  path: `${id}.md`,
  basename: id,
  title: id,
  kind: "note",
  aliases: [],
  headings: [],
  tags: [],
  ownedFields: {},
  relationFields: {},
  outgoingLinks: [],
  tokens: [],
  mtime: 0,
  size: 1,
  contentHash: id,
  ...overrides,
}) as DocumentRecord;

const referenceCodePointCompare = (left: string, right: string): number => {
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

const referenceRecordCompare = (left: DocumentRecord, right: DocumentRecord): number =>
  referenceCodePointCompare(left.path, right.path) || referenceCodePointCompare(left.id, right.id);

const referenceNodeSortKey = (id: string, recordsById: ReadonlyMap<string, DocumentRecord>): string =>
  recordsById.get(id)?.path ?? id;

const referenceEdgeCompare = (
  left: MapEdge,
  right: MapEdge,
  recordsById: ReadonlyMap<string, DocumentRecord>,
): number => referenceCodePointCompare(
  referenceNodeSortKey(left.sourceId, recordsById),
  referenceNodeSortKey(right.sourceId, recordsById),
) || referenceCodePointCompare(left.sourceId, right.sourceId)
  || referenceCodePointCompare(
    referenceNodeSortKey(left.targetId, recordsById),
    referenceNodeSortKey(right.targetId, recordsById),
  )
  || referenceCodePointCompare(left.targetId, right.targetId);

const referenceCrossesSelection = (edge: MapEdge, selectedIds: ReadonlySet<string>): boolean =>
  selectedIds.has(edge.sourceId) !== selectedIds.has(edge.targetId);

const referenceUnselectedEndpoint = (edge: MapEdge, selectedIds: ReadonlySet<string>): string =>
  selectedIds.has(edge.sourceId) ? edge.targetId : edge.sourceId;

const referenceDocumentNode = (value: DocumentRecord): MapNode => ({
  id: value.id,
  nodeType: "document",
  path: value.path,
  title: value.title,
  kind: value.kind,
  shape: value.kind === "note" ? "circle" : value.kind === "reference" ? "square" : "diamond",
});

const referenceTopicNode = (value: TopicCluster): MapNode => ({
  id: value.id,
  nodeType: "topic",
  title: value.label,
  kind: "topic",
  shape: "diamond",
});

const referenceTopicEdges = (
  cluster: TopicCluster,
  recordsById: ReadonlyMap<string, DocumentRecord>,
): readonly MapEdge[] => [...new Set(cluster.memberIds)]
  .filter((id) => recordsById.has(id))
  .sort((left, right) => referenceCodePointCompare(
    referenceNodeSortKey(left, recordsById),
    referenceNodeSortKey(right, recordsById),
  ) || referenceCodePointCompare(left, right))
  .map((id) => ({
    sourceId: cluster.id,
    targetId: id,
    score: 80,
    reasons: [{ code: "confirmed-topic" as const, weight: 80 }],
    confirmed: true,
  }));

const referenceDetails = (
  selectedId: string,
  recordsById: ReadonlyMap<string, DocumentRecord>,
  selectedCluster: TopicCluster | undefined,
  edges: readonly MapEdge[],
): FocusedMap["selected"] => {
  const selectedRecord = recordsById.get(selectedId);
  const connected = edges.filter((edge) => edge.sourceId === selectedId || edge.targetId === selectedId);
  const otherId = (edge: MapEdge): string => edge.sourceId === selectedId ? edge.targetId : edge.sourceId;
  return {
    nodeId: selectedId,
    path: selectedRecord?.path,
    topics: selectedRecord === undefined
      ? selectedCluster === undefined ? [] : [selectedCluster.label]
      : buildTopicClusters([selectedRecord]).map((cluster) => cluster.label),
    connectedNodeIds: connected.map(otherId).sort(referenceCodePointCompare),
    relations: connected
      .map((edge) => ({
        nodeId: otherId(edge),
        explanation: edge.reasons
          .map((reason) => `${reason.code.replaceAll("-", " ")} (${reason.weight})`)
          .join(", "),
        confirmed: edge.confirmed,
      }))
      .sort((left, right) => referenceCodePointCompare(left.nodeId, right.nodeId)),
  };
};

const exhaustiveFocusReference = (
  input: FocusMapInput,
  scorer = new RelationScorer(),
): FocusedMap => {
  const eligible = input.records
    .filter((value) => input.filter === "all" || value.kind === input.filter)
    .sort(referenceRecordCompare);
  const recordsById = new Map(eligible.map((value) => [value.id, value]));
  const clusters = input.clusters ?? buildTopicClusters(input.records);
  const centerRecord = input.center.kind === "document" ? recordsById.get(input.center.id) : undefined;
  const centerCluster = input.center.kind === "topic"
    ? clusters.find((cluster) => cluster.id === input.center.id)
    : undefined;
  if (centerRecord === undefined && centerCluster === undefined) {
    return { nodes: [], edges: [], selected: null, truncated: false };
  }

  const candidates: MapEdge[] = [];
  for (let leftIndex = 0; leftIndex < eligible.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < eligible.length; rightIndex += 1) {
      const left = eligible[leftIndex]!;
      const right = eligible[rightIndex]!;
      const score = scorer.score(left, right);
      if (score.total > 0) {
        candidates.push({
          sourceId: left.id,
          targetId: right.id,
          score: score.total,
          reasons: score.reasons,
          confirmed: score.reasons.some((reason) =>
            reason.code === "explicit-link" || reason.code === "confirmed-topic"),
        });
      }
    }
  }
  if (centerCluster !== undefined) candidates.push(...referenceTopicEdges(centerCluster, recordsById));

  const selectedId = centerRecord?.id ?? centerCluster!.id;
  const selectedIds = new Set([selectedId]);
  const nodes: MapNode[] = [centerRecord === undefined
    ? referenceTopicNode(centerCluster!)
    : referenceDocumentNode(centerRecord)];
  while (nodes.length < 50) {
    const next = candidates
      .filter((edge) => referenceCrossesSelection(edge, selectedIds))
      .map((edge) => ({ edge, targetId: referenceUnselectedEndpoint(edge, selectedIds) }))
      .sort((left, right) => right.edge.score - left.edge.score
        || referenceCodePointCompare(
          referenceNodeSortKey(left.targetId, recordsById),
          referenceNodeSortKey(right.targetId, recordsById),
        )
        || referenceCodePointCompare(left.targetId, right.targetId)
        || referenceEdgeCompare(left.edge, right.edge, recordsById))[0];
    if (next === undefined) break;
    const nextRecord = recordsById.get(next.targetId);
    if (nextRecord === undefined) break;
    selectedIds.add(next.targetId);
    nodes.push(referenceDocumentNode(nextRecord));
  }

  const truncated = nodes.length === 50
    && candidates.some((edge) => referenceCrossesSelection(edge, selectedIds));
  const edges = candidates
    .filter((edge) => selectedIds.has(edge.sourceId) && selectedIds.has(edge.targetId))
    .sort((left, right) => referenceEdgeCompare(left, right, recordsById));
  return {
    nodes,
    edges,
    selected: referenceDetails(selectedId, recordsById, centerCluster, edges),
    truncated,
  };
};

class CountingScorer extends RelationScorer {
  calls = 0;

  override score(left: DocumentRecord, right: DocumentRecord) {
    this.calls += 1;
    return super.score(left, right);
  }
}

it("returns no more than 50 focused nodes", async () => {
  const records = Array.from({ length: 80 }, (_, index) =>
    record(String(index), { kind: "reference", tags: ["shared"] }),
  );
  const map = await new MapService().focus(
    { records, center: { kind: "document", id: "0" }, filter: "all" },
    new AbortController().signal,
    () => undefined,
  );

  expect(map.nodes.length).toBeLessThanOrEqual(50);
});

describe("buildTopicClusters", () => {
  it("normalizes topics and produces stable labels, members, IDs, and output order", () => {
    const records = [
      record("z", { ownedFields: { "knowledge-workbench-topics": [" tools ", "Cafe\u0301"] } }),
      record("a", { ownedFields: { "knowledge-workbench-topics": ["TOOLS", "CAFÉ"] } }),
      record("m", { ownedFields: { "knowledge-workbench-topics": ["Tools"] } }),
    ];

    const forward = buildTopicClusters(records);
    const reverse = buildTopicClusters([...records].reverse());

    expect(reverse).toEqual(forward);
    expect(forward).toEqual([
      {
        id: "topic:café",
        label: "CAFÉ",
        memberIds: ["a", "z"],
        contributingSignals: ["confirmed-topic-property"],
        confidence: "high",
      },
      {
        id: "topic:tools",
        label: "TOOLS",
        memberIds: ["a", "m", "z"],
        contributingSignals: ["confirmed-topic-property"],
        confidence: "high",
      },
    ]);
  });

  it("uses Unicode code-point order instead of UTF-16 or locale order", () => {
    const clusters = buildTopicClusters([
      record("𐀀", { ownedFields: { "knowledge-workbench-topics": ["𐀀"] } }),
      record("\uE000", { ownedFields: { "knowledge-workbench-topics": ["\uE000"] } }),
    ]);

    expect(clusters.map((cluster) => cluster.id)).toEqual(["topic:\uE000", "topic:𐀀"]);
  });
});

describe("MapService.search", () => {
  it("normalizes search text and reports matches in title-heading-token order", () => {
    const records = [
      record("all", {
        path: "all.md",
        title: "Café field guide",
        headings: ["About CAFE\u0301"],
        tokens: ["café-token"],
      }),
    ];

    expect(new MapService().search(records, " cafe\u0301 ")).toEqual([
      {
        documentId: "all",
        path: "all.md",
        title: "Café field guide",
        matchedBy: ["title", "heading", "token"],
      },
    ]);
  });

  it("sorts by match count then true code-point path and caps results at 50", () => {
    const records = [
      record("astral", { path: "𐀀.md", title: "needle" }),
      record("private", { path: "\uE000.md", title: "needle" }),
      record("best", { path: "z.md", title: "needle", headings: ["needle"], tokens: ["needle"] }),
      ...Array.from({ length: 60 }, (_, index) =>
        record(`extra-${index}`, { path: `𐀁/${String(index).padStart(2, "0")}.md`, title: "needle" }),
      ),
    ];
    const service = new MapService();
    const results = service.search(records, "NEEDLE");

    expect(results).toHaveLength(50);
    expect(results[0]?.documentId).toBe("best");
    expect(results[1]?.path).toBe("\uE000.md");
    expect(results[2]?.path).toBe("𐀀.md");
    expect(service.search([...records].reverse(), "needle")).toEqual(results);
    expect(service.search(records, "   ")).toEqual([]);
  });
});

describe("MapService.focus", () => {
  const signal = (): AbortSignal => new AbortController().signal;

  it("bounds relation scoring by the 50-node focused frontier", async () => {
    const records = Array.from({ length: 500 }, (_, index) =>
      record(`record-${String(index).padStart(3, "0")}`, { tags: ["shared"] }),
    );
    const scorer = new CountingScorer();
    const map = await new MapService(scorer, async () => undefined).focus(
      { records, center: { kind: "document", id: "record-000" }, filter: "all" },
      signal(),
      () => undefined,
    );

    expect(map.nodes).toHaveLength(50);
    expect(map.truncated).toBe(true);
    expect(scorer.calls).toBeLessThanOrEqual(50 * records.length);
  });

  it("matches the exhaustive reference for canonical reverse edges and an indirect best edge", async () => {
    const records = [
      record("center", {
        path: "z-center.md",
        tags: ["low-route"],
        ownedFields: { "knowledge-workbench-topics": ["Route"] },
      }),
      record("branch", {
        path: "b-branch.md",
        ownedFields: { "knowledge-workbench-topics": ["Route"] },
        outgoingLinks: ["d-external.md"],
      }),
      record("external", { path: "d-external.md" }),
      record("low", { path: "a-low.md", tags: ["low-route"] }),
    ];
    const input: FocusMapInput = {
      records,
      center: { kind: "document", id: "center" },
      filter: "all",
    };

    const map = await new MapService().focus(input, signal(), () => undefined);

    expect(map).toEqual(exhaustiveFocusReference(input));
    expect(map.nodes.map((node) => node.id)).toEqual(["center", "branch", "external", "low"]);
    expect(map.edges.map((edge) => [edge.sourceId, edge.targetId])).toContainEqual(["low", "center"]);
  });

  it("matches the exhaustive reference when a topic member exposes a stronger external edge", async () => {
    const records = [
      record("member-a", {
        path: "a.md",
        ownedFields: { "knowledge-workbench-topics": ["Shared"] },
        outgoingLinks: ["external.md"],
      }),
      record("member-b", {
        path: "b.md",
        ownedFields: { "knowledge-workbench-topics": ["Shared"] },
      }),
      record("external", { path: "external.md" }),
    ];
    const clusters = buildTopicClusters(records);
    const input: FocusMapInput = {
      records,
      clusters,
      center: { kind: "topic", id: clusters[0]!.id },
      filter: "all",
    };

    const map = await new MapService().focus(input, signal(), () => undefined);

    expect(map).toEqual(exhaustiveFocusReference(input));
    expect(map.nodes.map((node) => node.id)).toEqual(["topic:shared", "member-a", "external", "member-b"]);
  });

  it("matches the exhaustive reference and detects a crossing edge discovered at the 50-node cap", async () => {
    const records = Array.from({ length: 51 }, (_, index) => {
      const id = `chain-${String(index).padStart(2, "0")}`;
      const nextId = `chain-${String(index + 1).padStart(2, "0")}`;
      return record(id, { outgoingLinks: index === 50 ? [] : [`${nextId}.md`] });
    });
    const input: FocusMapInput = {
      records,
      center: { kind: "document", id: "chain-00" },
      filter: "all",
    };

    const map = await new MapService().focus(input, signal(), () => undefined);

    expect(map).toEqual(exhaustiveFocusReference(input));
    expect(map.nodes).toHaveLength(50);
    expect(map.nodes.at(-1)?.id).toBe("chain-49");
    expect(map.truncated).toBe(true);
  });

  it("applies the kind filter before the cap and returns empty when it excludes the center", async () => {
    const references = Array.from({ length: 60 }, (_, index) =>
      record(`reference-${index}`, { kind: "reference", tags: ["shared"] }),
    );
    const notes = [record("note-center", { tags: ["notes"] }), record("note-target", { tags: ["notes"] })];
    const records = [...references, ...notes];
    const focusedInput: FocusMapInput = {
      records,
      center: { kind: "document", id: "note-center" },
      filter: "note",
    };
    const excludedInput: FocusMapInput = {
      records,
      center: { kind: "document", id: "note-center" },
      filter: "reference",
    };
    const service = new MapService();
    const focused = await service.focus(focusedInput, signal(), () => undefined);
    const excluded = await service.focus(excludedInput, signal(), () => undefined);

    expect(focused).toEqual(exhaustiveFocusReference(focusedInput));
    expect(excluded).toEqual(exhaustiveFocusReference(excludedInput));
    expect(focused.nodes.map((node) => node.id)).toEqual(["note-center", "note-target"]);
    expect(focused.edges).toHaveLength(1);
    expect(excluded).toEqual({ nodes: [], edges: [], selected: null, truncated: false });
  });

  it("includes a topic center inside the 50-node cap", async () => {
    const records = Array.from({ length: 60 }, (_, index) =>
      record(`member-${String(index).padStart(2, "0")}`, {
        ownedFields: { "knowledge-workbench-topics": ["Shared"] },
      }),
    );
    const clusters = buildTopicClusters(records);
    const map = await new MapService().focus(
      { records, clusters, center: { kind: "topic", id: clusters[0]!.id }, filter: "all" },
      signal(),
      () => undefined,
    );

    expect(map.nodes).toHaveLength(50);
    expect(map.nodes[0]).toMatchObject({ id: "topic:shared", nodeType: "topic" });
    expect(map.nodes.filter((node) => node.nodeType === "document")).toHaveLength(49);
    expect(map.edges.filter((edge) => edge.sourceId === "topic:shared")).toHaveLength(49);
    expect(map.truncated).toBe(true);
  });

  it("returns every positive edge among selected nodes and complete center details", async () => {
    const records = [
      record("A", { path: "triangle/A.md", tags: ["triangle"] }),
      record("B", { path: "triangle/B.md", tags: ["triangle"] }),
      record("C", { path: "triangle/C.md", tags: ["triangle"] }),
    ];
    const map = await new MapService().focus(
      { records, center: { kind: "document", id: "A" }, filter: "all" },
      signal(),
      () => undefined,
    );

    expect(map.edges.map((edge) => [edge.sourceId, edge.targetId])).toEqual([
      ["A", "B"],
      ["A", "C"],
      ["B", "C"],
    ]);
    expect(map.selected).toMatchObject({
      nodeId: "A",
      connectedNodeIds: ["B", "C"],
      relations: [
        { nodeId: "B", explanation: "shared tag (60), same folder (40)", confirmed: false },
        { nodeId: "C", explanation: "shared tag (60), same folder (40)", confirmed: false },
      ],
    });
    const nodeIds = new Set(map.nodes.map((node) => node.id));
    expect(map.edges.every((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))).toBe(true);
  });

  it("is input-order independent and breaks equal traversal scores by target path", async () => {
    const targets = Array.from({ length: 50 }, (_, index) => {
      const pathIndex = String(index).padStart(2, "0");
      const reverseId = String(99 - index).padStart(2, "0");
      return record(`target-${reverseId}`, { path: `paths/${pathIndex}.md`, tags: ["shared"] });
    });
    const records = [record("center", { path: "center.md", tags: ["shared"] }), ...targets];
    const forwardInput: FocusMapInput = {
      records,
      center: { kind: "document", id: "center" },
      filter: "all",
    };
    const reverseInput: FocusMapInput = {
      records: [...records].reverse(),
      center: { kind: "document", id: "center" },
      filter: "all",
    };
    const service = new MapService();
    const forward = await service.focus(forwardInput, signal(), () => undefined);
    const reverse = await service.focus(reverseInput, signal(), () => undefined);

    expect(forward).toEqual(exhaustiveFocusReference(forwardInput));
    expect(reverse).toEqual(exhaustiveFocusReference(reverseInput));
    expect(reverse).toEqual(forward);
    expect(forward.nodes.map((node) => node.id)).not.toContain("target-50");
    expect(forward.nodes.at(-1)?.id).toBe("target-51");
  });

  it("uses true code-point path order for equal traversal scores", async () => {
    const records = [
      record("center", { tags: ["shared"] }),
      record("astral", { path: "𐀀.md", tags: ["shared"] }),
      record("private", { path: "\uE000.md", tags: ["shared"] }),
    ];
    const map = await new MapService().focus(
      { records, center: { kind: "document", id: "center" }, filter: "all" },
      signal(),
      () => undefined,
    );

    expect(map.nodes.map((node) => node.id)).toEqual(["center", "private", "astral"]);
  });

  it.each([
    [50, false],
    [51, true],
  ] as const)("reports cap truncation only for reachable nodes (%i documents)", async (count, truncated) => {
    const records = Array.from({ length: count }, (_, index) =>
      record(`reachable-${String(index).padStart(2, "0")}`, { tags: ["shared"] }),
    );
    const map = await new MapService().focus(
      { records, center: { kind: "document", id: "reachable-00" }, filter: "all" },
      signal(),
      () => undefined,
    );

    expect(map.truncated).toBe(truncated);
  });

  it("does not mark disconnected records as truncated", async () => {
    const records = [
      record("center"),
      ...Array.from({ length: 80 }, (_, index) =>
        record(`isolated-${index}`, { tags: ["disconnected-component"] }),
      ),
    ];
    const input: FocusMapInput = {
      records,
      center: { kind: "document", id: "center" },
      filter: "all",
    };
    const map = await new MapService().focus(input, signal(), () => undefined);

    expect(map).toEqual(exhaustiveFocusReference(input));
    expect(map.nodes.map((node) => node.id)).toEqual(["center"]);
    expect(map.truncated).toBe(false);
  });

  it("builds stable confirmed topic-member edges and selected topic details", async () => {
    const records = [
      record("b", { ownedFields: { "knowledge-workbench-topics": ["AI Tools"] } }),
      record("a", { ownedFields: { "knowledge-workbench-topics": ["ai tools"] } }),
    ];
    const clusters = buildTopicClusters(records);
    const map = await new MapService().focus(
      { records, clusters, center: { kind: "topic", id: clusters[0]!.id }, filter: "all" },
      signal(),
      () => undefined,
    );

    expect(map.edges.filter((edge) => edge.sourceId === "topic:ai tools")).toEqual([
      {
        sourceId: "topic:ai tools",
        targetId: "a",
        score: 80,
        reasons: [{ code: "confirmed-topic", weight: 80 }],
        confirmed: true,
      },
      {
        sourceId: "topic:ai tools",
        targetId: "b",
        score: 80,
        reasons: [{ code: "confirmed-topic", weight: 80 }],
        confirmed: true,
      },
    ]);
    expect(map.selected).toMatchObject({ topics: ["AI Tools"], connectedNodeIds: ["a", "b"] });
  });

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new MapService().focus(
        { records: [record("center")], center: { kind: "document", id: "center" }, filter: "all" },
        controller.signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("checks cancellation after each 500-pair progress checkpoint", async () => {
    const controller = new AbortController();
    const records = Array.from({ length: 34 }, (_, index) =>
      record(`record-${index}`, { tags: ["shared"] }),
    );
    const checkpoints: number[] = [];
    const service = new MapService(new RelationScorer(), async () => undefined);

    await expect(
      service.focus(
        { records, center: { kind: "document", id: "record-0" }, filter: "all" },
        controller.signal,
        (scoredPairs) => {
          checkpoints.push(scoredPairs);
          controller.abort();
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoints).toEqual([500]);
  });

  it("lets the default event loop yield observe asynchronous cancellation", async () => {
    const controller = new AbortController();
    const records = Array.from({ length: 34 }, (_, index) =>
      record(`record-${index}`, { tags: ["shared"] }),
    );
    window.setTimeout(() => controller.abort(), 0);

    await expect(
      new MapService().focus(
        { records, center: { kind: "document", id: "record-0" }, filter: "all" },
        controller.signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
