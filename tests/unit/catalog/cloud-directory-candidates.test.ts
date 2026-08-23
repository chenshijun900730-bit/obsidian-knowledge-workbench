import { describe, expect, it } from "vitest";
import {
  buildLocalCloudDirectoryCandidates,
  rankCloudDirectoryCandidates,
  type CloudDirectoryCandidate,
  type CloudDirectoryCandidateSource,
} from "../../../src/catalog/cloud-directory-candidates";
import type { CachedCloudDirectory } from "../../../src/catalog/cloud-directory-discovery-service";
import type { HybridCatalogGroupViewModel } from "../../../src/catalog/hybrid-catalog-runtime";
import type { RecentCloudDirectoriesV1 } from "../../../src/storage/recent-cloud-directories";

const ALL_SOURCES = new Set<CloudDirectoryCandidateSource>([
  "recent",
  "session-cache",
  "cloud-locator",
  "txt-group",
]);

const recent = (...paths: readonly string[]): RecentCloudDirectoriesV1 => ({
  schemaVersion: 1,
  items: paths.map((path, index) => ({
    path,
    filename: path.slice(path.lastIndexOf("/") + 1),
    lastUsedAt: new Date(1_000 - index).toISOString(),
  })),
});

const cached = (fsId: string, path: string): CachedCloudDirectory => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
});

const group = (
  groupKey: string,
  label: string,
): Pick<HybridCatalogGroupViewModel, "groupKey" | "label"> => ({ groupKey, label });

const exact = (
  source: "recent" | "session-cache" | "cloud-locator",
  path: string,
  cloudFsId?: string,
): CloudDirectoryCandidate => ({
  kind: "exact",
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  source,
  pathState: source === "recent" ? "previously-used" : "session-verified",
  ...(cloudFsId === undefined ? {} : { cloudFsId }),
});

describe("cloud directory candidates", () => {
  it("builds detached source-level candidates without inventing TXT paths", () => {
    const recentInput = recent("/Library/Science");
    const cachedInput = [cached("1", "/Library/Science"), cached("2", "/Other/Literature")];
    const groups = [
      group("txt-root-items", "Root items"),
      group("group:science", "Science"),
      group("group:literature", "文学253册"),
    ];

    const result = buildLocalCloudDirectoryCandidates({
      recent: recentInput,
      cached: cachedInput,
      groups,
    });

    expect(result).toEqual([
      exact("recent", "/Library/Science"),
      exact("session-cache", "/Library/Science", "1"),
      exact("session-cache", "/Other/Literature", "2"),
      {
        kind: "name-hint",
        filename: "Science",
        source: "txt-group",
        catalogGroupKey: "group:science",
      },
      {
        kind: "name-hint",
        filename: "文学253册",
        source: "txt-group",
        catalogGroupKey: "group:literature",
      },
    ]);
    expect(result.filter((candidate) => candidate.kind === "name-hint"))
      .toSatisfy((hints: readonly CloudDirectoryCandidate[]) => hints.every((hint) => !("path" in hint)));
    expect(result).not.toBe(cachedInput);
    expect(result[1]).not.toBe(cachedInput[0]);
    expect(result.some((candidate) => (
      candidate.kind !== "name-hint" && candidate.path.includes("Root items")
    ))).toBe(false);
  });

  it("merges equal normalized paths while preserving fixed source labels", () => {
    const ranked = rankCloudDirectoryCandidates({
      candidates: [
        exact("session-cache", "/Library/e\u0301", "9"),
        exact("recent", "/Library/é"),
      ],
      query: "",
      enabledSources: ALL_SOURCES,
      selectedPath: null,
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      candidate: exact("recent", "/Library/é"),
      sources: ["recent", "session-cache"],
      selected: false,
    });
  });

  it("keeps same-name directories with different full paths", () => {
    const ranked = rankCloudDirectoryCandidates({
      candidates: [
        exact("session-cache", "/Archive/科学文库", "1"),
        exact("session-cache", "/Books/科学文库", "2"),
      ],
      query: "科学",
      enabledSources: ALL_SOURCES,
      selectedPath: null,
    });

    expect(ranked.map(({ candidate }) => candidate.kind === "name-hint" ? "" : candidate.path))
      .toEqual(["/Archive/科学文库", "/Books/科学文库"]);
  });

  it("orders selected path, source priority, fuzzy score, and stable keys", () => {
    const ranked = rankCloudDirectoryCandidates({
      candidates: [
        exact("recent", "/Recent/Other"),
        exact("session-cache", "/Cache/Science", "1"),
        {
          kind: "name-hint",
          filename: "Science",
          source: "txt-group",
          catalogGroupKey: "group:b",
        },
        {
          kind: "name-hint",
          filename: "Science",
          source: "txt-group",
          catalogGroupKey: "group:a",
        },
      ],
      query: "",
      enabledSources: ALL_SOURCES,
      selectedPath: "/Cache/Science",
    });

    expect(ranked.map(({ candidate }) => (
      candidate.kind === "name-hint" ? candidate.catalogGroupKey : candidate.path
    ))).toEqual([
      "/Cache/Science",
      "/Recent/Other",
      "group:a",
      "group:b",
    ]);
    expect(ranked[0]?.selected).toBe(true);
  });

  it("uses any enabled merged source but never lets a hidden conflict reveal an exact row", () => {
    const candidates: readonly CloudDirectoryCandidate[] = [
      exact("recent", "/Library/Science"),
      exact("session-cache", "/Library/Science", "1"),
      {
        kind: "conflict",
        filename: "Science",
        path: "/Library/Science",
        source: "cloud-locator",
        reason: "same-path-different-identity",
      },
    ];

    const ranked = rankCloudDirectoryCandidates({
      candidates,
      query: "",
      enabledSources: new Set(["recent"]),
      selectedPath: "/Library/Science",
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.candidate).toEqual({
      kind: "conflict",
      filename: "Science",
      path: "/Library/Science",
      source: "cloud-locator",
      reason: "same-path-different-identity",
    });
    expect(ranked[0]?.sources).toEqual(["recent", "session-cache", "cloud-locator"]);
    expect(ranked[0]?.selected).toBe(false);
    expect(rankCloudDirectoryCandidates({
      candidates,
      query: "",
      enabledSources: new Set(),
      selectedPath: "/Library/Science",
    })).toEqual([]);
  });

  it("matches Chinese and numeric fragments without pinyin or group-key inference", () => {
    const candidates: readonly CloudDirectoryCandidate[] = [
      {
        kind: "name-hint",
        filename: "文学253册",
        source: "txt-group",
        catalogGroupKey: "group:wenxue-hidden-token",
      },
    ];

    expect(rankCloudDirectoryCandidates({
      candidates,
      query: "文学 253",
      enabledSources: ALL_SOURCES,
      selectedPath: null,
    })).toHaveLength(1);
    expect(rankCloudDirectoryCandidates({
      candidates,
      query: "wenxue",
      enabledSources: ALL_SOURCES,
      selectedPath: null,
    })).toEqual([]);
    expect(rankCloudDirectoryCandidates({
      candidates,
      query: "hidden token",
      enabledSources: ALL_SOURCES,
      selectedPath: null,
    })).toEqual([]);
  });

  it("returns detached ranked candidates and source arrays", () => {
    const candidate = exact("recent", "/Library/Science");
    const first = rankCloudDirectoryCandidates({
      candidates: [candidate],
      query: "",
      enabledSources: ALL_SOURCES,
      selectedPath: null,
    });
    const second = rankCloudDirectoryCandidates({
      candidates: [candidate],
      query: "",
      enabledSources: ALL_SOURCES,
      selectedPath: null,
    });

    expect(first).not.toBe(second);
    expect(first[0]?.candidate).not.toBe(candidate);
    expect(first[0]?.candidate).not.toBe(second[0]?.candidate);
    expect(first[0]?.sources).not.toBe(second[0]?.sources);
  });
});
