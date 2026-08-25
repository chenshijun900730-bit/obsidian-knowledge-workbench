import { describe, expect, it } from "vitest";
import {
  hasDurableVerificationProgress,
  summarizeLargeCatalogVerification,
} from "../../../src/catalog/large-catalog-verification-progress";
import {
  LARGE_CATALOG_RUN_BUDGET,
  type LargeCatalogBatchCheckpointV3,
} from "../../../src/catalog/hybrid-catalog-types";

const checkpoint = (): LargeCatalogBatchCheckpointV3 => ({
  schemaVersion: 3,
  batchId: "batch-progress",
  sourceImportSha256: "a".repeat(64),
  cloudRootSha256: "b".repeat(64),
  startedAt: 100,
  runOrdinal: 3,
  budget: LARGE_CATALOG_RUN_BUDGET,
  selectedGroupCount: 2,
  currentGroupIndex: 1,
  groups: [
    {
      groupKey: `group:${"1".repeat(64)}`,
      rootRelativePath: "Science",
      mode: "recursive",
      status: "complete",
      pending: [],
      committedPageKeys: ["c".repeat(64)],
      completedDirectoryCount: 2,
    },
    {
      groupKey: `group:${"2".repeat(64)}`,
      rootRelativePath: "History",
      mode: "recursive",
      status: "scanning",
      pending: [{ relativePath: "Sub", start: 1000 }],
      committedPageKeys: ["d".repeat(64), "e".repeat(64)],
      completedDirectoryCount: 4,
    },
  ],
  pdfCount: 200,
  directoryCount: 41,
  ignoredFileCount: 3,
  listRequestCount: 20,
  cumulativeListRequestCount: 427,
  status: "paused",
  stopReason: "list-request-limit",
  errorCodeCounts: {},
});

describe("large catalog verification progress", () => {
  it("derives aggregate-only counters without exposing pending paths", () => {
    const value = summarizeLargeCatalogVerification(checkpoint(), 11_870);
    expect(value).toMatchObject({
      selectedGroupCount: 2,
      completedGroupCount: 1,
      currentGroupIndex: 1,
      currentGroupKey: `group:${"2".repeat(64)}`,
      committedPdfCount: 11_870,
      committedPageCount: 3,
      completedDirectoryCount: 6,
      pendingDirectoryCount: 1,
    });
    expect(value.progressMarker.pendingStateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(value)).not.toContain("Sub");
  });

  it("accepts only persisted structural progress", () => {
    const before = summarizeLargeCatalogVerification(checkpoint(), 11_870).progressMarker;
    const requestOnly = summarizeLargeCatalogVerification({
      ...checkpoint(),
      runOrdinal: 4,
      listRequestCount: 21,
      cumulativeListRequestCount: 428,
    }, 11_870).progressMarker;
    const committed = summarizeLargeCatalogVerification({
      ...checkpoint(),
      groups: checkpoint().groups.map((group, index) => index === 1
        ? { ...group, committedPageKeys: [...group.committedPageKeys, "f".repeat(64)] }
        : group),
    }, 11_871).progressMarker;
    expect(hasDurableVerificationProgress(before, requestOnly)).toBe(false);
    expect(hasDurableVerificationProgress(before, committed)).toBe(true);
  });
});
