import { normalizeCatalogScanRoot } from "./catalog-path";
import type { CachedCloudDirectory } from "./cloud-directory-discovery-service";
import { scoreCloudDirectoryCandidate } from "./cloud-directory-search";
import type { HybridCatalogGroupViewModel } from "./hybrid-catalog-runtime";
import type { RecentCloudDirectoriesV1 } from "../storage/recent-cloud-directories";

export type CloudDirectoryCandidate =
  | Readonly<{
      kind: "exact";
      path: string;
      filename: string;
      source: "recent" | "session-cache" | "cloud-locator";
      pathState: "previously-used" | "session-verified";
      cloudFsId?: string;
    }>
  | Readonly<{
      kind: "name-hint";
      filename: string;
      source: "txt-group";
      catalogGroupKey: string;
    }>
  | Readonly<{
      kind: "conflict";
      filename: string;
      path: string;
      source: "cloud-locator";
      reason: "same-path-different-identity";
    }>;

export type CloudDirectoryCandidateSource = CloudDirectoryCandidate["source"];

export interface RankedCloudDirectoryCandidate {
  readonly candidate: CloudDirectoryCandidate;
  readonly sources: readonly CloudDirectoryCandidateSource[];
  readonly score: number;
  readonly selected: boolean;
}

export interface CloudDirectoryCandidateRuntime {
  snapshot(): readonly CloudDirectoryCandidate[];
  remember(path: string): Promise<void>;
  clearRecent(): Promise<void>;
}

const SOURCE_ORDER: readonly CloudDirectoryCandidateSource[] = [
  "recent",
  "session-cache",
  "cloud-locator",
  "txt-group",
];

const sourceRank = (source: CloudDirectoryCandidateSource): number => {
  const rank = SOURCE_ORDER.indexOf(source);
  return rank < 0 ? SOURCE_ORDER.length : rank;
};

const fixedCompare = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizedCandidate = (
  candidate: CloudDirectoryCandidate,
): CloudDirectoryCandidate => {
  if (candidate.kind === "name-hint") {
    return {
      kind: "name-hint",
      filename: candidate.filename.normalize("NFC"),
      source: "txt-group",
      catalogGroupKey: candidate.catalogGroupKey,
    };
  }
  const path = normalizeCatalogScanRoot(candidate.path);
  if (candidate.kind === "conflict") {
    return {
      kind: "conflict",
      filename: candidate.filename.normalize("NFC"),
      path,
      source: "cloud-locator",
      reason: "same-path-different-identity",
    };
  }
  return {
    kind: "exact",
    path,
    filename: candidate.filename.normalize("NFC"),
    source: candidate.source,
    pathState: candidate.pathState,
    ...(candidate.cloudFsId === undefined ? {} : { cloudFsId: candidate.cloudFsId }),
  };
};

const mergeKey = (candidate: CloudDirectoryCandidate): string => candidate.kind === "name-hint"
  ? `hint\u0000${candidate.catalogGroupKey}`
  : `path\u0000${candidate.path}`;

const stableKey = (candidate: CloudDirectoryCandidate): string => candidate.kind === "name-hint"
  ? candidate.catalogGroupKey
  : candidate.path;

const candidateIdentity = (candidate: CloudDirectoryCandidate): string => {
  if (candidate.kind === "name-hint") {
    return `${candidate.filename}\u0000${candidate.catalogGroupKey}`;
  }
  if (candidate.kind === "conflict") {
    return `${candidate.path}\u0000${candidate.filename}\u0000conflict`;
  }
  return [
    candidate.path,
    candidate.filename,
    candidate.cloudFsId ?? "",
    candidate.pathState,
  ].join("\u0000");
};

const representativeFor = (
  candidates: readonly CloudDirectoryCandidate[],
): CloudDirectoryCandidate => {
  const conflicts = candidates
    .filter((candidate): candidate is Extract<CloudDirectoryCandidate, { kind: "conflict" }> => (
      candidate.kind === "conflict"
    ))
    .sort((left, right) => fixedCompare(candidateIdentity(left), candidateIdentity(right)));
  const conflict = conflicts[0];
  if (conflict !== undefined) return conflict;
  const sorted = [...candidates].sort((left, right) => (
    sourceRank(left.source) - sourceRank(right.source)
    || fixedCompare(candidateIdentity(left), candidateIdentity(right))
  ));
  const representative = sorted[0];
  if (representative === undefined) throw new Error("cloud-directory-candidate-group-empty");
  return representative;
};

const cloneCandidate = (candidate: CloudDirectoryCandidate): CloudDirectoryCandidate => ({
  ...candidate,
});

export function buildLocalCloudDirectoryCandidates(input: Readonly<{
  recent: RecentCloudDirectoriesV1;
  cached: readonly CachedCloudDirectory[];
  groups: readonly Pick<HybridCatalogGroupViewModel, "groupKey" | "label">[];
}>): readonly CloudDirectoryCandidate[] {
  return [
    ...input.recent.items.map((item): CloudDirectoryCandidate => ({
      kind: "exact",
      path: normalizeCatalogScanRoot(item.path),
      filename: item.filename.normalize("NFC"),
      source: "recent",
      pathState: "previously-used",
    })),
    ...input.cached.map((item): CloudDirectoryCandidate => ({
      kind: "exact",
      path: normalizeCatalogScanRoot(item.path),
      filename: item.filename.normalize("NFC"),
      source: "session-cache",
      pathState: "session-verified",
      cloudFsId: item.fsId,
    })),
    ...input.groups
      .filter((item) => item.groupKey !== "txt-root-items")
      .map((item): CloudDirectoryCandidate => ({
        kind: "name-hint",
        filename: item.label.normalize("NFC"),
        source: "txt-group",
        catalogGroupKey: item.groupKey,
      })),
  ];
}

export function rankCloudDirectoryCandidates(input: Readonly<{
  candidates: readonly CloudDirectoryCandidate[];
  query: string;
  enabledSources: ReadonlySet<CloudDirectoryCandidateSource>;
  selectedPath: string | null;
}>): readonly RankedCloudDirectoryCandidate[] {
  const groups = new Map<string, CloudDirectoryCandidate[]>();
  for (const inputCandidate of input.candidates) {
    const candidate = normalizedCandidate(inputCandidate);
    const key = mergeKey(candidate);
    const grouped = groups.get(key);
    if (grouped === undefined) groups.set(key, [candidate]);
    else grouped.push(candidate);
  }

  const normalizedSelectedPath = input.selectedPath === null
    ? null
    : normalizeCatalogScanRoot(input.selectedPath);
  const ranked: Array<RankedCloudDirectoryCandidate & { sourceRank: number; stableKey: string }> = [];
  for (const candidates of groups.values()) {
    const sources = SOURCE_ORDER.filter((source) => (
      candidates.some((candidate) => candidate.source === source)
    ));
    if (!sources.some((source) => input.enabledSources.has(source))) continue;
    const candidate = representativeFor(candidates);
    const score = scoreCloudDirectoryCandidate(
      candidate.kind === "name-hint"
        ? { filename: candidate.filename }
        : { filename: candidate.filename, path: candidate.path },
      input.query,
    );
    if (score === null) continue;
    const selected = candidate.kind === "exact" && candidate.path === normalizedSelectedPath;
    ranked.push({
      candidate: cloneCandidate(candidate),
      sources: [...sources],
      score,
      selected,
      sourceRank: Math.min(...sources.map(sourceRank)),
      stableKey: stableKey(candidate),
    });
  }

  return ranked
    .sort((left, right) => (
      Number(right.selected) - Number(left.selected)
      || left.sourceRank - right.sourceRank
      || left.score - right.score
      || fixedCompare(left.stableKey, right.stableKey)
    ))
    .map(({ candidate, sources, score, selected }) => ({
      candidate: cloneCandidate(candidate),
      sources: [...sources],
      score,
      selected,
    }));
}
