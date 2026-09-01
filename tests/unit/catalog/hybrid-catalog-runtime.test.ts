import { describe, expect, it, vi } from "vitest";
import {
  HybridCatalogRuntimeService,
  type HybridCatalogRuntimeDependencies,
} from "../../../src/catalog/hybrid-catalog-runtime";
import {
  HybridCatalogError,
  LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  LARGE_CATALOG_RUN_BUDGET,
  type CandidateCatalogDescriptor,
  type CatalogTxtImportSummary,
  type LargeCatalogBatchCheckpointV3,
  type LargeCatalogBatchCheckpointV4,
  type TxtCandidateRecordV1,
  type UnifiedCatalogRecordV1,
} from "../../../src/catalog/hybrid-catalog-types";
import type {
  HybridCatalogActivationSnapshot,
  LoadedLargeCatalogBatchV4,
} from "../../../src/catalog/hybrid-catalog-ports";
import type {
  CloudVerificationAuthority,
  CloudVerificationScope,
} from "../../../src/catalog/cloud-verification-scope";
import type {
  LargeCatalogVerificationSummary,
  LargeCatalogVerificationSegmentInput,
  LargeCatalogVerificationStartInput,
  LargeVerificationProgressEvent,
} from "../../../src/catalog/large-catalog-verification-service";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_D = "d".repeat(64);
const GROUP_A = `group:${"1".repeat(64)}`;
const GROUP_B = `group:${"2".repeat(64)}`;
const DEFAULT_SCOPE: CloudVerificationScope = {
  generation: 1,
  sourceImportSha256: HASH_A,
  cloudRootSha256: HASH_D,
};

const authority = (
  resumableBatch: Extract<CloudVerificationAuthority, { kind: "scoped" }>["legacyAllowlist"] = null,
): CloudVerificationAuthority => ({
  kind: "scoped",
  scope: { ...DEFAULT_SCOPE },
  legacyAllowlist: resumableBatch,
});

const summary = (sourceSha256 = HASH_A): CatalogTxtImportSummary => ({
  sourceSha256,
  byteSize: 128,
  nonEmptyLineCount: 5,
  pdfCount: 3,
  directoryCount: 2,
  ignoredLeafCount: 0,
  normalizedWhitespaceCount: 0,
  maxDepth: 2,
});

const descriptor = (): CandidateCatalogDescriptor => ({
  schemaVersion: 1,
  importId: "import-1",
  importedAt: 100,
  candidateSha256: "c".repeat(64),
  ...summary(),
});

const candidate = (
  candidateId: string,
  relativePath: string,
  topLevelGroupId: string,
): TxtCandidateRecordV1 => {
  const pieces = relativePath.split("/");
  const filename = pieces.at(-1)!;
  const parents = pieces.slice(0, -1);
  return {
    schemaVersion: 1,
    source: "txt-candidate",
    candidateId,
    relativePath,
    parentRelativePath: parents.join("/"),
    filename,
    title: filename.slice(0, -4),
    isbnCandidates: [],
    topLevelGroupId,
    hierarchyTags: parents.map((value) => `folder/${value}`),
  };
};

const unified = (
  value: TxtCandidateRecordV1,
  verificationStatus: UnifiedCatalogRecordV1["verificationStatus"],
  differenceKinds: UnifiedCatalogRecordV1["differenceKinds"] = [],
): UnifiedCatalogRecordV1 => ({
  schemaVersion: 1,
  catalogId: value.candidateId,
  candidateId: value.candidateId,
  fsId: verificationStatus === "unverified" ? null : "1",
  relativePath: value.relativePath,
  cloudPath: verificationStatus === "unverified" ? null : `/Library/${value.relativePath}`,
  filename: value.filename,
  title: value.title,
  isbnCandidates: [],
  sizeBytes: verificationStatus === "unverified" ? null : 10,
  serverModifiedAt: verificationStatus === "unverified" ? null : 20,
  topLevelGroupId: value.topLevelGroupId,
  hierarchyTags: value.hierarchyTags,
  verificationStatus,
  differenceKinds,
  visibleByDefault: !differenceKinds.includes("cloud-missing"),
});

const pausedCheckpoint = (): LargeCatalogBatchCheckpointV3 => ({
  schemaVersion: 3,
  batchId: "batch-paused",
  sourceImportSha256: HASH_A,
  cloudRootSha256: "d".repeat(64),
  startedAt: 200,
  runOrdinal: 1,
  budget: LARGE_CATALOG_RUN_BUDGET,
  selectedGroupCount: 1,
  currentGroupIndex: 0,
  groups: [{
    groupKey: GROUP_A,
    rootRelativePath: "Science",
    mode: "recursive",
    status: "scanning",
    pending: [{ relativePath: "", start: 1000 }],
    committedPageKeys: ["e".repeat(64)],
    completedDirectoryCount: 1,
  }],
  pdfCount: 7,
  directoryCount: 2,
  ignoredFileCount: 1,
  listRequestCount: 3,
  cumulativeListRequestCount: 3,
  status: "paused",
  stopReason: "list-request-limit",
  errorCodeCounts: {},
});

const twoGroupPausedCheckpoint = (): LargeCatalogBatchCheckpointV3 => {
  const first = pausedCheckpoint();
  return {
    ...first,
    selectedGroupCount: 2,
    groups: [
      first.groups[0]!,
      {
        groupKey: GROUP_B,
        rootRelativePath: "History",
        mode: "recursive",
        status: "pending",
        pending: [{ relativePath: "", start: 0 }],
        committedPageKeys: [],
        completedDirectoryCount: 0,
      },
    ],
  };
};

const scopedCheckpoint = (
  overrides: Partial<LargeCatalogBatchCheckpointV4> = {},
): LargeCatalogBatchCheckpointV4 => {
  const legacy = pausedCheckpoint();
  return {
    schemaVersion: 4,
    batchId: legacy.batchId,
    verificationScope: { ...DEFAULT_SCOPE },
    legacyCheckpointSha256: null,
    latestReceipt: null,
    startedAt: legacy.startedAt,
    runOrdinal: legacy.runOrdinal,
    budget: legacy.budget,
    selectedGroupCount: legacy.selectedGroupCount,
    currentGroupIndex: legacy.currentGroupIndex,
    groups: legacy.groups,
    pdfCount: legacy.pdfCount,
    directoryCount: legacy.directoryCount,
    ignoredFileCount: legacy.ignoredFileCount,
    listRequestCount: legacy.listRequestCount,
    cumulativeListRequestCount: legacy.cumulativeListRequestCount,
    status: legacy.status,
    stopReason: legacy.stopReason,
    errorCodeCounts: legacy.errorCodeCounts,
    ...overrides,
  };
};

const promotedBatch = (): LoadedLargeCatalogBatchV4 => ({
  kind: "scoped-v4",
  checkpoint: scopedCheckpoint({ legacyCheckpointSha256: HASH_B }),
  checkpointSha256: "7".repeat(64),
  records: [],
  identities: [],
  identitiesComplete: true,
});

const verificationSummary = (
  overrides: Partial<LargeCatalogVerificationSummary> = {},
): LargeCatalogVerificationSummary => {
  const base: LargeCatalogVerificationSummary = {
    batchId: "batch-new",
    verificationScope: { ...DEFAULT_SCOPE },
    legacyPromotionRequired: false,
    status: "paused",
    stopReason: "pdf-limit",
    runOrdinal: 1,
    selectedGroupCount: 1,
    selectedGroupKeys: [GROUP_A],
    completedGroupCount: 0,
    remainingGroupCount: 1,
    currentGroupIndex: 0,
    currentGroupKey: GROUP_A,
    pdfCount: 9_000,
    directoryCount: 4,
    ignoredFileCount: 0,
    listRequestCount: 10,
    cumulativeListRequestCount: 10,
    committedPdfCount: 9_000,
    committedPageCount: 9,
    completedDirectoryCount: 3,
    pendingDirectoryCount: 1,
    progressMarker: {
      committedPdfCount: 9_000,
      committedPageCount: 9,
      completedDirectoryCount: 3,
      completedGroupCount: 0,
      currentGroupIndex: 0,
      pendingStateSha256: "9".repeat(64),
    },
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    progressMarker: {
      ...base.progressMarker,
      committedPdfCount: merged.committedPdfCount,
      committedPageCount: merged.committedPageCount,
      completedDirectoryCount: merged.completedDirectoryCount,
      completedGroupCount: merged.completedGroupCount,
      currentGroupIndex: merged.currentGroupIndex,
      ...(overrides.progressMarker ?? {}),
    },
  };
};

const verificationProgressEvent = (
  value: LargeCatalogVerificationSummary,
  phase: LargeVerificationProgressEvent["phase"],
  recoveredFromScanning = false,
): LargeVerificationProgressEvent => ({
  phase,
  summary: value,
  recoveredFromScanning,
});

const fixture = (options: Readonly<{
  previewSummaries?: readonly CatalogTxtImportSummary[];
  latest?: LargeCatalogBatchCheckpointV3 | LargeCatalogBatchCheckpointV4 | null;
  verificationAuthority?: CloudVerificationAuthority | null;
  openError?: Error;
  importPromise?: Promise<CandidateCatalogDescriptor>;
  projectPromise?: Promise<void>;
  projectError?: Error;
  verificationResults?: readonly LargeCatalogVerificationSummary[];
  verificationStarts?: readonly LargeCatalogVerificationSummary[];
  verificationRecoveries?: readonly boolean[];
  verificationStartPromise?: Promise<LargeCatalogVerificationSummary>;
  verificationRunPromise?: Promise<LargeCatalogVerificationSummary>;
  promotionPromise?: Promise<LoadedLargeCatalogBatchV4>;
}> = {}) => {
  const candidates = [
    candidate("txt:root", "Root.pdf", "txt-root-items"),
    candidate("txt:a", "Science/A.pdf", GROUP_A),
    candidate("txt:b", "History/B.pdf", GROUP_B),
  ];
  let activeCandidates: Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null = { descriptor: descriptor(), records: candidates };
  let activeUnified: Readonly<{
    descriptor: Readonly<{
      schemaVersion: 1;
      snapshotId: string;
      sourceImportSha256: string;
      completedAt: number;
      recordCount: number;
      differenceCount: number;
      catalogSha256: string;
      differencesSha256: string;
    }>;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly [];
  }> | null = {
    descriptor: {
      schemaVersion: 1,
      snapshotId: "snapshot-1",
      sourceImportSha256: HASH_A,
      completedAt: 150,
      recordCount: 3,
      differenceCount: 1,
      catalogSha256: "f".repeat(64),
      differencesSha256: "0".repeat(64),
    },
    records: [
      unified(candidates[0]!, "unverified"),
      unified(candidates[1]!, "verified"),
      unified(candidates[2]!, "difference", ["cloud-missing"]),
    ],
    differences: [],
  };
  const openCalls: string[] = [];
  const previewSummaries = [...(options.previewSummaries ?? [summary(), summary()])];
  const latestCheckpointSha256 = HASH_B;
  const selectedAuthority = options.verificationAuthority === undefined
    ? authority(options.latest?.schemaVersion === 3 ? {
      candidate: {
        importId: "import-1",
        manifestSha256: "4".repeat(64),
        descriptorSha256: "5".repeat(64),
      },
      overlays: [],
      unified: null,
      resumableBatch: {
        batchId: options.latest.batchId,
        checkpointSha256: latestCheckpointSha256,
        sourceImportSha256: options.latest.sourceImportSha256,
        cloudRootSha256: options.latest.cloudRootSha256,
      },
    } : null)
    : options.verificationAuthority;
  const imports = {
    preview: vi.fn(async () => previewSummaries.shift() ?? summary()),
    import: vi.fn(async (_source, _signal?: AbortSignal) => {
      const imported = await (options.importPromise ?? Promise.resolve(descriptor()));
      activeCandidates = { descriptor: descriptor(), records: candidates };
      return imported;
    }),
  };
  const store = {
    loadActiveCandidateDescriptor: vi.fn(async () => activeCandidates?.descriptor ?? null),
    loadActiveCandidateSummary: vi.fn(async () => activeCandidates === null ? null : ({
      descriptor: activeCandidates.descriptor,
      groups: [...new Map(activeCandidates.records.map((record) => [record.topLevelGroupId, record]))]
        .map(([groupKey, record]) => ({
          groupKey,
          label: groupKey === "txt-root-items" ? "Root items" : record.relativePath.split("/")[0]!,
          rootRelativePath: groupKey === "txt-root-items" ? "" : record.relativePath.split("/")[0]!,
          pdfCount: activeCandidates!.records.filter((value) => value.topLevelGroupId === groupKey).length,
          mode: groupKey === "txt-root-items" ? "direct-files-only" as const : "recursive" as const,
        })),
    })),
    loadActiveCandidateGroups: vi.fn(async (groupKeys: readonly string[]) => {
      if (activeCandidates === null) return null;
      const selected = new Set(groupKeys);
      return {
        descriptor: activeCandidates.descriptor,
        records: activeCandidates.records.filter((record) => selected.has(record.topLevelGroupId)),
      };
    }),
    loadActiveCandidates: vi.fn(async () => activeCandidates),
    loadActiveUnified: vi.fn(async () => activeUnified),
    loadActiveUnifiedSummary: vi.fn(async () => activeUnified === null ? null : ({
      descriptor: activeUnified.descriptor,
      aggregate: {
        verificationCounts: activeUnified.records.reduce((counts, record) => {
          counts[record.verificationStatus] += 1;
          if (record.differenceKinds.includes("cloud-missing")) counts.cloudMissing += 1;
          return counts;
        }, { unverified: 0, verified: 0, difference: 0, cloudMissing: 0 }),
        differenceGroupKeys: activeUnified.records
          .filter((record) => record.verificationStatus === "difference")
          .map((record) => record.topLevelGroupId),
        groups: [],
        hierarchyTags: [],
        differenceKindCounts: { "cloud-added": 0, "cloud-missing": 0, renamed: 0, moved: 0 },
      },
    })),
    loadActiveOverlayDescriptors: vi.fn(async () => [{
      schemaVersion: 1 as const,
      overlayId: "overlay-1",
      sourceImportSha256: HASH_A,
      topLevelGroupId: GROUP_A,
      completedAt: 140,
      recordCount: 1,
      differenceCount: 0,
      supersededCount: 0,
      recordsSha256: "1".repeat(64),
      differencesSha256: "2".repeat(64),
      supersededSha256: "3".repeat(64),
    }]),
    loadActiveOverlays: vi.fn(async () => [{
      descriptor: {
        schemaVersion: 1 as const,
        overlayId: "overlay-1",
        sourceImportSha256: HASH_A,
        topLevelGroupId: GROUP_A,
        completedAt: 140,
        recordCount: 1,
        differenceCount: 0,
        supersededCount: 0,
        recordsSha256: "1".repeat(64),
        differencesSha256: "2".repeat(64),
        supersededSha256: "3".repeat(64),
      },
      records: [],
      differences: [],
      supersededCatalogIds: [],
    }]),
    loadLatestBatch: vi.fn(async () => {
      const latest = options.latest;
      if (latest === undefined || latest === null) return null;
      if (latest.schemaVersion === 3) {
        return {
          kind: "legacy-v3" as const,
          checkpoint: latest,
          checkpointSha256: latestCheckpointSha256,
          records: [],
          identities: [],
          identitiesComplete: true,
        };
      }
      return {
        kind: "scoped-v4" as const,
        checkpoint: latest,
        checkpointSha256: latestCheckpointSha256,
        records: [],
        identities: [],
        identitiesComplete: true as const,
      };
    }),
    loadLegacyLocalAuthority: vi.fn(async () => ({
      kind: "legacy-local-only" as const,
      sourceImportSha256: HASH_A,
      activeManifestSha256: "4".repeat(64),
    })),
    prepareLegacyVerificationAdoption: vi.fn(async (scope: CloudVerificationScope) => ({
      schemaVersion: 1 as const,
      state: "adopted" as const,
      verificationGeneration: scope.generation,
      sourceImportSha256: scope.sourceImportSha256,
      cloudRootSha256: scope.cloudRootSha256,
      candidate: {
        importId: "import-1",
        manifestSha256: "4".repeat(64),
        descriptorSha256: "5".repeat(64),
      },
      overlays: [],
      unified: null,
      resumableBatch: null,
    })),
    revalidatePreparedLegacyAdoption: vi.fn(async () => undefined),
    loadLegacyArtifactSetSha256: vi.fn(async () => "6".repeat(64)),
    promoteAdoptedLegacyBatch: vi.fn(async () => {
      if (options.promotionPromise !== undefined) return options.promotionPromise;
      if (options.latest?.schemaVersion !== 3) throw new Error("no-legacy-batch");
      return promotedBatch();
    }),
    restoreCatalogActivation: vi.fn(async (_input: HybridCatalogActivationSnapshot) => undefined),
  };
  const project = {
    rebuild: vi.fn(async (_authority?: CloudVerificationAuthority | null, _signal?: AbortSignal) => {
      await options.projectPromise;
      if (options.projectError !== undefined) throw options.projectError;
      activeUnified = activeUnified === null ? null : { ...activeUnified, descriptor: {
        ...activeUnified.descriptor,
        completedAt: activeUnified.descriptor.completedAt + 1,
      } };
      return activeUnified;
    }),
  };
  const defaultComplete = verificationSummary({
    status: "complete",
    stopReason: "complete",
    runOrdinal: 2,
    completedGroupCount: 1,
    remainingGroupCount: 0,
    currentGroupIndex: 1,
    currentGroupKey: null,
    pdfCount: 1,
    directoryCount: 1,
    listRequestCount: 1,
    cumulativeListRequestCount: 4,
    committedPdfCount: 1,
    committedPageCount: 1,
    completedDirectoryCount: 1,
    pendingDirectoryCount: 0,
  });
  const verificationResults = [...(options.verificationResults ?? [defaultComplete])];
  const verificationStarts = [...(options.verificationStarts ?? verificationResults.map((result) => (
    verificationSummary({
      ...result,
      status: "scanning",
      stopReason: null,
      committedPdfCount: Math.max(0, result.committedPdfCount - 1),
      committedPageCount: Math.max(0, result.committedPageCount - 1),
      progressMarker: {
        ...result.progressMarker,
        committedPdfCount: Math.max(0, result.committedPdfCount - 1),
        committedPageCount: Math.max(0, result.committedPageCount - 1),
        pendingStateSha256: "8".repeat(64),
      },
    })
  )))];
  const verificationRecoveries = [...(options.verificationRecoveries ?? [])];
  const nextVerificationStep = (): Readonly<{
    start: LargeCatalogVerificationSummary;
    result: LargeCatalogVerificationSummary;
    recoveredFromScanning: boolean;
  }> => {
    const start = verificationStarts.shift();
    const result = verificationResults.shift();
    if (start === undefined || result === undefined) {
      throw new Error("verification-result-exhausted");
    }
    return { start, result, recoveredFromScanning: verificationRecoveries.shift() ?? false };
  };
  const verification = {
    start: vi.fn(async (input: LargeCatalogVerificationStartInput) => {
      if (options.verificationStartPromise !== undefined) {
        return options.verificationStartPromise;
      }
      const { start, result, recoveredFromScanning } = nextVerificationStep();
      await input.onProgress?.(verificationProgressEvent(
        start,
        "segment-started",
        recoveredFromScanning,
      ));
      await input.onProgress?.(verificationProgressEvent(
        result,
        "segment-finalized",
        recoveredFromScanning,
      ));
      return result;
    }),
    runSegment: vi.fn(async (input: LargeCatalogVerificationSegmentInput) => {
      if (options.verificationRunPromise !== undefined) {
        return options.verificationRunPromise;
      }
      const { start, result, recoveredFromScanning } = nextVerificationStep();
      await input.onProgress?.(verificationProgressEvent(
        start,
        "segment-started",
        recoveredFromScanning,
      ));
      await input.onProgress?.(verificationProgressEvent(
        result,
        "segment-finalized",
        recoveredFromScanning,
      ));
      return result;
    }),
  };
  const dependencies: HybridCatalogRuntimeDependencies = {
    source: {
      open: async (path: string) => {
        openCalls.push(path);
        if (options.openError !== undefined) throw options.openError;
        return { byteSize: 1, chunks: async function* () { yield new Uint8Array([1]); } };
      },
    },
    imports,
    store,
    project: project as never,
    verification,
    createBatchId: () => "batch-new",
  };
  const runtime = new HybridCatalogRuntimeService(dependencies);
  runtime.setVerificationAuthority(selectedAuthority);
  return {
    runtime,
    candidates,
    openCalls,
    imports,
    store,
    project,
    verification,
  };
};

describe("HybridCatalogRuntimeService", () => {
  it("synchronously revokes trusted verification state when authority changes", async () => {
    const value = fixture({ latest: scopedCheckpoint() });
    await value.runtime.initialize();
    expect(value.runtime.snapshot()).toMatchObject({
      active: { verifiedCount: 1, differenceCount: 1, verifiedGroupCount: 1 },
      batch: { batchId: "batch-paused" },
    });

    value.runtime.setVerificationAuthority({
      kind: "scoped",
      scope: { ...DEFAULT_SCOPE, generation: 2 },
      legacyAllowlist: null,
    });

    expect(value.runtime.snapshot()).toMatchObject({
      status: "ready",
      executionActive: false,
      active: {
        sourceImportSha256: HASH_A,
        legacyArtifactSetSha256: null,
        unverifiedCount: 3,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [
          { verificationStatus: "unverified" },
          { verificationStatus: "unverified" },
          { verificationStatus: "unverified" },
        ],
      },
    });
    expect(value.runtime.snapshot().batch).toBeUndefined();
  });

  it("does not let an older initialize overwrite a newer authority result", async () => {
    const value = fixture();
    const initialCandidate = await value.store.loadActiveCandidateSummary();
    expect(initialCandidate).not.toBeNull();
    let resolveOldCandidate!: (candidateValue: typeof initialCandidate) => void;
    const oldCandidate = new Promise<typeof initialCandidate>((resolve) => {
      resolveOldCandidate = resolve;
    });
    value.store.loadActiveCandidateSummary.mockClear();
    value.store.loadActiveCandidateSummary
      .mockImplementationOnce(async () => oldCandidate)
      .mockResolvedValueOnce({
        ...initialCandidate!,
        descriptor: { ...initialCandidate!.descriptor, sourceSha256: HASH_B },
      });
    value.store.loadActiveUnifiedSummary.mockResolvedValueOnce(null);
    value.store.loadActiveOverlayDescriptors.mockResolvedValueOnce([]);

    const older = value.runtime.initialize();
    await vi.waitFor(() => {
      expect(value.store.loadActiveCandidateSummary).toHaveBeenCalledTimes(1);
    });
    value.runtime.setVerificationAuthority({
      kind: "scoped",
      scope: { ...DEFAULT_SCOPE, generation: 2, sourceImportSha256: HASH_B },
      legacyAllowlist: null,
    });
    await value.runtime.initialize();
    expect(value.runtime.snapshot().active?.sourceImportSha256).toBe(HASH_B);

    resolveOldCandidate(initialCandidate);
    await older;

    expect(value.runtime.snapshot().active?.sourceImportSha256).toBe(HASH_B);
    expect(value.runtime.snapshot().active?.verifiedCount).toBe(0);
  });

  it("does not publish an old projection rebuild after authority changes", async () => {
    let finishProjection!: () => void;
    const projectPromise = new Promise<void>((resolve) => { finishProjection = resolve; });
    const value = fixture({ projectPromise });
    await value.runtime.initialize();

    const rebuilding = value.runtime.rebuildVerificationProjection();
    await vi.waitFor(() => { expect(value.project.rebuild).toHaveBeenCalledOnce(); });
    value.runtime.setVerificationAuthority({
      kind: "scoped",
      scope: { ...DEFAULT_SCOPE, generation: 2 },
      legacyAllowlist: null,
    });
    expect(value.runtime.snapshot().active?.verifiedCount).toBe(0);

    finishProjection();
    await rebuilding;

    expect(value.runtime.snapshot()).toMatchObject({
      status: "ready",
      executionActive: false,
      active: { verifiedCount: 0, differenceCount: 0 },
    });
    expect(value.runtime.snapshot().batch).toBeUndefined();
  });

  it("rejects an authority change while verification is executing", async () => {
    let finish!: (value: LargeCatalogVerificationSummary) => void;
    const verificationStartPromise = new Promise<LargeCatalogVerificationSummary>((resolve) => {
      finish = resolve;
    });
    const value = fixture({ verificationStartPromise });
    await value.runtime.initialize();
    const running = value.runtime.startLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A],
    });
    await vi.waitFor(() => { expect(value.verification.start).toHaveBeenCalledOnce(); });

    expect(() => value.runtime.setVerificationAuthority(authority(null))).not.toThrow();
    expect(() => value.runtime.setVerificationAuthority(null))
      .toThrow(new HybridCatalogError("hybrid-batch-unavailable"));
    expect(value.runtime.snapshot()).toMatchObject({ status: "scanning", executionActive: true });

    value.runtime.cancelLargeVerification();
    finish(verificationSummary({ status: "paused", stopReason: "user-canceled" }));
    await running;
  });

  it("reports no live execution in every resting snapshot", async () => {
    const value = fixture();

    expect(value.runtime.snapshot().executionActive).toBe(false);
    await value.runtime.initialize();
    expect(value.runtime.snapshot().executionActive).toBe(false);
  });

  it("publishes executionActive before the verification promise emits progress", async () => {
    let finish!: (value: LargeCatalogVerificationSummary) => void;
    const verificationStartPromise = new Promise<LargeCatalogVerificationSummary>((resolve) => {
      finish = resolve;
    });
    const value = fixture({ verificationStartPromise });
    await value.runtime.initialize();

    const running = value.runtime.startLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A],
    });
    await vi.waitFor(() => { expect(value.verification.start).toHaveBeenCalledOnce(); });

    expect(value.runtime.snapshot()).toMatchObject({
      status: "scanning",
      executionActive: true,
    });
    value.runtime.cancelLargeVerification();
    const signal = value.verification.start.mock.calls[0]?.[0].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    finish(verificationSummary({ status: "paused", stopReason: "user-canceled" }));
    await running;
    expect(value.runtime.snapshot().executionActive).toBe(false);
  });

  it("requires a current scoped authority before starting network-capable work", async () => {
    const value = fixture({ verificationAuthority: null });
    await value.runtime.initialize();

    await expect(value.runtime.startLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-unavailable"));

    expect(value.verification.start).not.toHaveBeenCalled();
    expect(value.store.promoteAdoptedLegacyBatch).not.toHaveBeenCalled();
  });

  it("projects a current orphan-scanning V4 checkpoint as offline paused and resumable", async () => {
    const value = fixture({ latest: scopedCheckpoint({ status: "scanning", stopReason: null }) });

    await value.runtime.initialize();

    expect(value.runtime.snapshot()).toMatchObject({
      status: "paused",
      executionActive: false,
      batch: {
        status: "paused",
        stopReason: "user-canceled",
        resumeAvailable: true,
        verificationScope: DEFAULT_SCOPE,
        legacyPromotionRequired: false,
      },
    });
    expect(value.verification.runSegment).not.toHaveBeenCalled();
  });

  it("keeps an old-generation V4 checkpoint as non-resumable history", async () => {
    const stale = scopedCheckpoint({
      verificationScope: { ...DEFAULT_SCOPE, generation: 2 },
    });
    const value = fixture({ latest: stale });

    await value.runtime.initialize();

    expect(value.runtime.snapshot().batch).toMatchObject({
      verificationScope: { ...DEFAULT_SCOPE, generation: 2 },
      legacyPromotionRequired: false,
      resumeAvailable: false,
    });
  });

  it("keeps an unlisted legacy V3 checkpoint visible but never resumable", async () => {
    const value = fixture({
      latest: pausedCheckpoint(),
      verificationAuthority: authority(null),
    });

    await value.runtime.initialize();

    expect(value.runtime.snapshot().batch).toMatchObject({
      verificationScope: null,
      legacyPromotionRequired: true,
      resumeAvailable: false,
    });
  });

  it("promotes an exactly adopted V3 before publishing a live execution", async () => {
    let finishPromotion!: (value: LoadedLargeCatalogBatchV4) => void;
    const promotionPromise = new Promise<LoadedLargeCatalogBatchV4>((resolve) => {
      finishPromotion = resolve;
    });
    let finish!: (value: LargeCatalogVerificationSummary) => void;
    const verificationRunPromise = new Promise<LargeCatalogVerificationSummary>((resolve) => {
      finish = resolve;
    });
    const value = fixture({
      latest: pausedCheckpoint(),
      promotionPromise,
      verificationRunPromise,
    });
    await value.runtime.initialize();

    const running = value.runtime.resumeLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A],
    });
    await vi.waitFor(() => { expect(value.store.promoteAdoptedLegacyBatch).toHaveBeenCalledOnce(); });

    expect(value.runtime.snapshot()).toMatchObject({
      status: "paused",
      executionActive: false,
      batch: { legacyPromotionRequired: true },
    });
    expect(value.verification.runSegment).not.toHaveBeenCalled();
    finishPromotion(promotedBatch());
    await vi.waitFor(() => { expect(value.verification.runSegment).toHaveBeenCalledOnce(); });

    expect(value.store.promoteAdoptedLegacyBatch.mock.invocationCallOrder[0])
      .toBeLessThan(value.verification.runSegment.mock.invocationCallOrder[0]!);
    expect(value.runtime.snapshot()).toMatchObject({
      status: "scanning",
      executionActive: true,
      batch: { legacyPromotionRequired: false, verificationScope: DEFAULT_SCOPE },
    });
    value.runtime.cancelLargeVerification();
    finish(verificationSummary({ status: "paused", stopReason: "user-canceled" }));
    await running;
    expect(value.runtime.snapshot().executionActive).toBe(false);
  });

  it("rejects reordered or replaced resume groups before legacy promotion or network", async () => {
    const value = fixture({ latest: twoGroupPausedCheckpoint() });
    await value.runtime.initialize();

    expect(value.runtime.snapshot().batch?.selectedGroupKeys).toEqual([GROUP_A, GROUP_B]);
    await expect(value.runtime.resumeLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_B, GROUP_A],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    await expect(value.runtime.resumeLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A, "txt-root-items"],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));

    expect(value.store.promoteAdoptedLegacyBatch).not.toHaveBeenCalled();
    expect(value.verification.runSegment).not.toHaveBeenCalled();
  });

  it("resumes an exact persisted V4 group order and detaches snapshot arrays", async () => {
    const legacy = twoGroupPausedCheckpoint();
    const latest = scopedCheckpoint({
      selectedGroupCount: legacy.selectedGroupCount,
      groups: legacy.groups,
    });
    const result = verificationSummary({
      status: "complete",
      stopReason: "complete",
      selectedGroupCount: 2,
      selectedGroupKeys: [GROUP_A, GROUP_B],
      completedGroupCount: 2,
      remainingGroupCount: 0,
      currentGroupIndex: 2,
      currentGroupKey: null,
    });
    const value = fixture({ latest, verificationResults: [result] });
    await value.runtime.initialize();
    const exposed = value.runtime.snapshot().batch!.selectedGroupKeys as string[];
    exposed.reverse();
    expect(value.runtime.snapshot().batch?.selectedGroupKeys).toEqual([GROUP_A, GROUP_B]);

    await value.runtime.resumeLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A, GROUP_B],
    });

    expect(value.verification.runSegment).toHaveBeenCalledWith(expect.objectContaining({
      allowedGroupKeys: [GROUP_A, GROUP_B],
    }));
  });

  it("proxies detached local-only authority and adoption revalidation without network", async () => {
    const value = fixture();
    const local = await value.runtime.prepareLegacyLocalVerificationAuthority();
    const prepared = await value.runtime.prepareLegacyVerificationAdoption(DEFAULT_SCOPE);
    await value.runtime.revalidatePreparedLegacyAdoption(prepared);

    expect(local).toEqual({
      kind: "legacy-local-only",
      sourceImportSha256: HASH_A,
      activeManifestSha256: "4".repeat(64),
    });
    expect(value.store.prepareLegacyVerificationAdoption).toHaveBeenCalledWith(DEFAULT_SCOPE);
    expect(value.store.revalidatePreparedLegacyAdoption).toHaveBeenCalledWith(prepared);
    expect(value.verification.start).not.toHaveBeenCalled();
    expect(value.verification.runSegment).not.toHaveBeenCalled();
  });

  it("initializes aggregate-only local state and a resumable batch without source or network calls", async () => {
    const value = fixture({ latest: pausedCheckpoint() });

    await value.runtime.initialize();

    expect(value.openCalls).toEqual([]);
    expect(value.verification.start).not.toHaveBeenCalled();
    expect(value.verification.runSegment).not.toHaveBeenCalled();
    expect(value.runtime.snapshot()).toMatchObject({
      status: "paused",
      active: {
        importedAt: 100,
        pdfCount: 3,
        unverifiedCount: 1,
        verifiedCount: 1,
        differenceCount: 1,
        cloudMissingCount: 1,
        groupCount: 3,
        verifiedGroupCount: 1,
        coveredCandidatePdfCount: 1,
      },
      batch: {
        status: "paused",
        resumeAvailable: true,
        cumulativeListRequestCount: 3,
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: GROUP_A,
        committedPdfCount: 0,
        committedPageCount: 1,
        completedDirectoryCount: 1,
        pendingDirectoryCount: 1,
      },
    });
    expect(value.runtime.snapshot().active?.groups.map((group) => group.label))
      .toEqual(["Root items", "History", "Science"]);
    expect(value.runtime.snapshot().active?.groups.map((group) => group.rootRelativePath))
      .toEqual(["", "History", "Science"]);
    expect(value.runtime.snapshot().batch?.batchId).toBe("batch-paused");
    const detached = value.runtime.snapshot();
    (detached.batch as { batchId: string }).batchId = "mutated";
    expect(value.runtime.snapshot().batch?.batchId).toBe("batch-paused");
    expect(JSON.stringify(value.runtime.snapshot())).not.toContain("/Library");
  });

  it("counts complete overlay candidates instead of verified records", async () => {
    const value = fixture();

    await value.runtime.initialize();

    expect(value.runtime.snapshot().active).toMatchObject({
      pdfCount: 3,
      verifiedCount: 1,
      differenceCount: 1,
      coveredCandidatePdfCount: 1,
      verifiedGroupCount: 1,
    });
  });

  it.each([
    ["baidu-rate-limited", true],
    ["baidu-token-expired", true],
    ["baidu-access-unavailable", true],
    ["baidu-permission-denied", false],
    ["baidu-not-found", false],
    ["invalid-baidu-response", false],
    ["hybrid-snapshot-corrupt", false],
  ] as const)("maps %s to resumeAvailable=%s", async (stopReason, resumeAvailable) => {
    const latest = {
      ...pausedCheckpoint(),
      status: "partial" as const,
      stopReason,
      errorCodeCounts: { [stopReason]: 1 },
    };
    const value = fixture({ latest });

    await value.runtime.initialize();

    expect(value.runtime.snapshot().batch?.resumeAvailable).toBe(resumeAvailable);
  });

  it("does not offer resume for a persisted path-not-found failure", async () => {
    const failed = {
      ...pausedCheckpoint(),
      status: "partial" as const,
      stopReason: "baidu-not-found" as const,
      errorCodeCounts: { "baidu-not-found": 1 },
    };
    const value = fixture({ latest: failed });

    await value.runtime.initialize();

    expect(value.runtime.snapshot()).toMatchObject({
      status: "partial",
      batch: {
        status: "partial",
        stopReason: "baidu-not-found",
        resumeAvailable: false,
      },
    });
    await expect(value.runtime.resumeLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A],
    }))
      .rejects.toEqual(new HybridCatalogError("hybrid-batch-unavailable"));
    expect(value.verification.runSegment).not.toHaveBeenCalled();
  });

  it("previews without writes and imports only after a fresh matching hash", async () => {
    const value = fixture();
    await value.runtime.initialize();

    await value.runtime.previewTxt("/synthetic/private-inventory.txt");
    expect(value.runtime.snapshot()).toMatchObject({ status: "previewed", candidate: summary() });
    expect(value.imports.import).not.toHaveBeenCalled();
    expect(value.project.rebuild).not.toHaveBeenCalled();

    await value.runtime.importTxt("/synthetic/private-inventory.txt");
    expect(value.openCalls).toEqual([
      "/synthetic/private-inventory.txt",
      "/synthetic/private-inventory.txt",
      "/synthetic/private-inventory.txt",
    ]);
    expect(value.imports.preview).toHaveBeenCalledTimes(2);
    expect(value.imports.import).toHaveBeenCalledTimes(1);
    expect(value.project.rebuild).toHaveBeenCalledTimes(1);
    expect(value.runtime.snapshot()).toMatchObject({ status: "ready" });
    expect(value.runtime.snapshot()).not.toHaveProperty("candidate");
    expect(JSON.stringify(value.runtime.snapshot())).not.toContain("private-inventory");
  });

  it("rejects a changed source before creating an import", async () => {
    const value = fixture({ previewSummaries: [summary(HASH_A), summary(HASH_B)] });
    await value.runtime.previewTxt("/synthetic/inventory.txt");

    await expect(value.runtime.importTxt("/synthetic/inventory.txt"))
      .rejects.toEqual(new HybridCatalogError("txt-source-invalid"));

    expect(value.imports.import).not.toHaveBeenCalled();
    expect(value.project.rebuild).not.toHaveBeenCalled();
    expect(value.runtime.snapshot()).toMatchObject({
      status: "error",
      messageCode: "txt-source-invalid",
    });
  });

  it("maps selected groups in declared order, enforces five, and exposes only aggregate pause state", async () => {
    const value = fixture({ verificationResults: [verificationSummary({
      status: "paused",
      stopReason: "user-canceled",
      selectedGroupCount: 2,
      remainingGroupCount: 2,
      currentGroupKey: "txt-root-items",
      pdfCount: 10,
      directoryCount: 2,
      listRequestCount: 300,
      cumulativeListRequestCount: 300,
      committedPdfCount: 10,
      committedPageCount: 1,
      completedDirectoryCount: 2,
      pendingDirectoryCount: 1,
    })] });
    await value.runtime.initialize();

    await value.runtime.startLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: ["txt-root-items", GROUP_A],
    });

    const startInput = value.verification.start.mock.calls[0]?.[0];
    expect(startInput).toMatchObject({
      batchId: "batch-new",
      sourceImportSha256: HASH_A,
      cloudRoot: "/Synthetic",
      groups: [
        { groupKey: "txt-root-items", rootRelativePath: "", mode: "direct-files-only" },
        { groupKey: GROUP_A, rootRelativePath: "Science", mode: "recursive" },
      ],
    });
    expect(startInput?.signal).toBeInstanceOf(AbortSignal);
    expect(value.runtime.snapshot()).toMatchObject({
      status: "paused",
      batch: {
        batchId: "batch-new",
        resumeAvailable: true,
        listRequestCount: 300,
        selectedGroupCount: 2,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: "txt-root-items",
        committedPdfCount: 10,
        committedPageCount: 1,
        completedDirectoryCount: 2,
        pendingDirectoryCount: 1,
      },
    });
    expect(JSON.stringify(value.runtime.snapshot())).not.toContain("/Synthetic");
    expect(JSON.stringify(value.runtime.snapshot())).not.toContain("pendingStateSha256");
    expect(value.store.loadActiveCandidateSummary).toHaveBeenCalledTimes(2);

    await expect(value.runtime.startLargeVerification({
      cloudRoot: "/Synthetic",
      groupKeys: [GROUP_A, GROUP_B, "txt-root-items", GROUP_A, GROUP_B, GROUP_A],
    })).rejects.toEqual(new HybridCatalogError("hybrid-batch-invalid"));
    expect(value.verification.start).toHaveBeenCalledTimes(1);
  });

  it.each(["pdf-limit", "directory-limit", "list-request-limit", "time-limit"] as const)(
    "automatically continues after %s without another confirmation",
    async (stopReason) => {
      const paused = verificationSummary({ status: "paused", stopReason, runOrdinal: 1 });
      const complete = verificationSummary({
        status: "complete",
        stopReason: "complete",
        runOrdinal: 2,
        completedGroupCount: 1,
        remainingGroupCount: 0,
      });
      const value = fixture({ verificationResults: [paused, complete] });
      await value.runtime.initialize();

      await value.runtime.startLargeVerification({
        cloudRoot: "/Synthetic",
        groupKeys: [GROUP_A],
      });

      expect(value.verification.start).toHaveBeenCalledOnce();
      expect(value.verification.runSegment).toHaveBeenCalledOnce();
      expect(value.runtime.snapshot()).toMatchObject({
        status: "ready",
        batch: {
          status: "complete",
          autoResumeState: "inactive",
          autoSegmentIndex: 2,
          autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
        },
      });
    },
  );

  it("does not start another segment when cancellation lands between segments", async () => {
    const value = fixture({
      verificationResults: [verificationSummary({ status: "paused", stopReason: "pdf-limit" })],
    });
    await value.runtime.initialize();
    const unsubscribe = value.runtime.subscribe(() => {
      if (value.runtime.snapshot().batch?.autoResumeState === "starting-next-segment") {
        value.runtime.cancelLargeVerification();
      }
    });

    await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });
    unsubscribe();

    expect(value.verification.runSegment).not.toHaveBeenCalled();
  });

  it("stops on a budget boundary with no durable progress", async () => {
    const same = verificationSummary({ status: "paused", stopReason: "directory-limit" });
    const value = fixture({ verificationResults: [same], verificationStarts: [same] });
    await value.runtime.initialize();

    await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });

    expect(value.runtime.snapshot().batch?.autoResumeState).toBe("stopped-no-progress");
    expect(value.verification.runSegment).not.toHaveBeenCalled();
  });

  it("allows one recovered-scanning normalization without advancing the segment index", async () => {
    const same = verificationSummary({ status: "paused", stopReason: "directory-limit" });
    const value = fixture({
      verificationResults: [same, same],
      verificationStarts: [same, same],
      verificationRecoveries: [true, false],
    });
    await value.runtime.initialize();

    await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });

    expect(value.verification.runSegment).toHaveBeenCalledOnce();
    expect(value.runtime.snapshot().batch).toMatchObject({
      autoResumeState: "stopped-no-progress",
      autoSegmentIndex: 1,
    });
  });

  it("stops after twelve automatic-chain segments", async () => {
    const budgetResults = Array.from({ length: 12 }, (_, index) => verificationSummary({
      status: "paused",
      stopReason: "pdf-limit",
      runOrdinal: index + 1,
      committedPageCount: index + 1,
      committedPdfCount: (index + 1) * 9_000,
    }));
    const complete = verificationSummary({
      status: "complete",
      stopReason: "complete",
      runOrdinal: 13,
      completedGroupCount: 1,
      remainingGroupCount: 0,
    });
    const value = fixture({ verificationResults: [...budgetResults, complete] });
    await value.runtime.initialize();

    await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });

    expect(value.verification.start).toHaveBeenCalledOnce();
    expect(value.verification.runSegment).toHaveBeenCalledTimes(11);
    expect(value.runtime.snapshot().batch).toMatchObject({
      autoResumeState: "stopped-limit",
      autoSegmentIndex: 12,
      autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
    });

    await value.runtime.resumeLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });

    expect(value.verification.runSegment).toHaveBeenCalledTimes(12);
    expect(value.runtime.snapshot().batch).toMatchObject({
      status: "complete",
      autoResumeState: "inactive",
      autoSegmentIndex: 1,
    });
  });

  it.each([
    "user-canceled",
    "baidu-rate-limited",
    "baidu-token-expired",
    "baidu-access-unavailable",
    "baidu-permission-denied",
    "baidu-not-found",
    "invalid-baidu-response",
    "hybrid-snapshot-corrupt",
    "hybrid-batch-invalid",
    "hybrid-batch-unavailable",
  ] as const)(
    "stops the automatic chain on %s",
    async (stopReason) => {
      const status = stopReason === "user-canceled" ? "paused" as const : "partial" as const;
      const value = fixture({
        verificationResults: [verificationSummary({ status, stopReason })],
      });
      await value.runtime.initialize();

      await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });

      expect(value.verification.runSegment).not.toHaveBeenCalled();
    },
  );

  it("resumes the latest persisted batch only after an explicit call and requires a fresh root", async () => {
    const value = fixture({
      latest: pausedCheckpoint(),
      verificationResults: [verificationSummary({
        batchId: "batch-paused",
        status: "complete",
        stopReason: "complete",
        runOrdinal: 2,
        completedGroupCount: 1,
        remainingGroupCount: 0,
        currentGroupIndex: 1,
        currentGroupKey: null,
      })],
    });
    await value.runtime.initialize();
    expect(value.verification.runSegment).not.toHaveBeenCalled();

    await value.runtime.resumeLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });

    const resumeInput = value.verification.runSegment.mock.calls[0]?.[0];
    expect(resumeInput).toMatchObject({
      batchId: "batch-paused",
      cloudRoot: "/Synthetic",
      allowedGroupKeys: [GROUP_A],
    });
    expect(resumeInput?.signal).toBeInstanceOf(AbortSignal);
    expect(value.runtime.snapshot()).toMatchObject({
      status: "ready",
      batch: { batchId: "batch-paused", status: "complete", resumeAvailable: false },
    });
    expect(JSON.stringify(value.runtime.snapshot())).not.toContain("/Synthetic");
  });

  it("becomes inert after dispose", async () => {
    const value = fixture();
    value.runtime.dispose();

    await value.runtime.initialize();
    await value.runtime.previewTxt("/must-not-open.txt");
    await value.runtime.importTxt("/must-not-open.txt");
    await value.runtime.startLargeVerification({ cloudRoot: "/NoCall", groupKeys: [GROUP_A] });
    await value.runtime.resumeLargeVerification({ cloudRoot: "/NoCall", groupKeys: [GROUP_A] });
    value.runtime.cancelLargeVerification();

    expect(value.openCalls).toEqual([]);
    expect(value.verification.start).not.toHaveBeenCalled();
    expect(value.verification.runSegment).not.toHaveBeenCalled();
    expect(value.runtime.snapshot()).toMatchObject({ status: "unavailable" });
  });

  it("cannot revive from an initialize result that settles after dispose", async () => {
    const value = fixture();
    const initialCandidate = await value.store.loadActiveCandidateSummary();
    let finishCandidate!: (candidateValue: typeof initialCandidate) => void;
    const delayedCandidate = new Promise<typeof initialCandidate>((resolve) => {
      finishCandidate = resolve;
    });
    value.store.loadActiveCandidateSummary.mockClear();
    value.store.loadActiveCandidateSummary.mockImplementationOnce(async () => delayedCandidate);

    const initializing = value.runtime.initialize();
    await vi.waitFor(() => {
      expect(value.store.loadActiveCandidateSummary).toHaveBeenCalledOnce();
    });
    value.runtime.dispose();
    finishCandidate(initialCandidate);
    await initializing;

    expect(value.runtime.snapshot()).toEqual({
      status: "unavailable",
      executionActive: false,
      messageCode: "catalog-unavailable",
    });
  });

  it("cancels an in-flight TXT import on dispose before projection rebuild", async () => {
    let finishImport!: (value: CandidateCatalogDescriptor) => void;
    const importPromise = new Promise<CandidateCatalogDescriptor>((resolve) => {
      finishImport = resolve;
    });
    const value = fixture({ importPromise });
    await value.runtime.initialize();
    await value.runtime.previewTxt("/synthetic/private-inventory.txt");

    const running = value.runtime.importTxt("/synthetic/private-inventory.txt");
    await vi.waitFor(() => { expect(value.imports.import).toHaveBeenCalledTimes(1); });
    const signal = value.imports.import.mock.calls[0]?.[1];
    value.runtime.dispose();
    finishImport(descriptor());
    await running;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(value.project.rebuild).not.toHaveBeenCalled();
    expect(value.runtime.snapshot()).toEqual({
      status: "unavailable",
      executionActive: false,
      messageCode: "catalog-unavailable",
    });
  });

  it("restores the prior candidate and projection when disposed during projection rebuild", async () => {
    let finishProjection!: () => void;
    const projectPromise = new Promise<void>((resolve) => { finishProjection = resolve; });
    const value = fixture({ projectPromise });
    const priorCandidate = (await value.store.loadActiveCandidates())?.descriptor;
    const priorUnified = (await value.store.loadActiveUnified())?.descriptor;
    let restoreAttempt = 0;
    value.store.restoreCatalogActivation.mockImplementation(async (input) => {
      expect(input).toEqual({
        candidate: priorCandidate,
        unified: priorUnified,
      });
      restoreAttempt += 1;
      if (restoreAttempt === 1) throw new Error("injected-first-restore-failure");
    });
    await value.runtime.initialize();
    await value.runtime.previewTxt("/synthetic/private-inventory.txt");

    const running = value.runtime.importTxt("/synthetic/private-inventory.txt");
    await vi.waitFor(() => { expect(value.project.rebuild).toHaveBeenCalledTimes(1); });
    const signal = value.project.rebuild.mock.calls[0]?.[1];
    value.runtime.dispose();
    finishProjection();
    await running;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(value.store.restoreCatalogActivation).toHaveBeenCalledTimes(2);
    expect(value.runtime.snapshot()).toEqual({
      status: "unavailable",
      executionActive: false,
      messageCode: "catalog-unavailable",
    });
  });

  it("restores the prior activation when projection rebuild fails", async () => {
    const value = fixture({ projectError: new Error("projection-write-failed") });
    const priorCandidate = (await value.store.loadActiveCandidates())?.descriptor;
    const priorUnified = (await value.store.loadActiveUnified())?.descriptor;
    await value.runtime.initialize();
    await value.runtime.previewTxt("/synthetic/private-inventory.txt");

    await expect(value.runtime.importTxt("/synthetic/private-inventory.txt"))
      .rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));

    expect(value.store.restoreCatalogActivation).toHaveBeenCalledWith({
      candidate: priorCandidate,
      unified: priorUnified,
    });
    expect(value.runtime.snapshot()).toMatchObject({
      status: "error",
      messageCode: "hybrid-snapshot-corrupt",
    });
    expect(JSON.stringify(value.runtime.snapshot())).not.toContain("projection-write-failed");

    await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });
    expect(value.verification.start.mock.calls[0]?.[0].authority).toEqual(authority(null));
  });

  it("maps native source failures to a fixed code without exposing path details", async () => {
    const value = fixture({ openError: new Error("/private/path permission denied") });

    await expect(value.runtime.previewTxt("/private/path"))
      .rejects.toEqual(new HybridCatalogError("txt-source-unavailable"));

    expect(value.runtime.snapshot()).toMatchObject({
      status: "error",
      messageCode: "txt-source-unavailable",
    });
    expect(JSON.stringify(value.runtime.snapshot())).not.toContain("/private/path");
  });
});
