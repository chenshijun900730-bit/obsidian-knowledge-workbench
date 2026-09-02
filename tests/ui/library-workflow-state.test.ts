import { describe, expect, it } from "vitest";
import type { CloudCatalogConnectionViewModel } from "../../src/catalog/cloud-catalog-runtime";
import type {
  HybridCatalogActiveSummary,
  HybridCatalogGroupViewModel,
  HybridCatalogViewModel,
  LargeCatalogBatchSummary,
} from "../../src/catalog/hybrid-catalog-runtime";
import type { BoundCloudLibraryV1 } from "../../src/storage/plugin-data";
import type { LegacyVerificationAdoptionV1 } from "../../src/storage/legacy-verification-adoption";
import type { VerificationBatchTombstonesV1 } from "../../src/storage/verification-batch-tombstones";
import {
  deriveLibraryWorkflowState,
  recommendNextVerificationGroup,
  type LibraryPrimaryAction,
  type LibraryWorkflowInput,
  type LibraryWorkflowKind,
} from "../../src/ui/library-workflow-state";

const SOURCE_A = "a".repeat(64);
const SOURCE_B = "b".repeat(64);
const CLOUD_ROOT_SHA256 = "37ce1ca5ce7b633704d49e0466d0365f6a9f5aedadfb19b71e9ac23bd8d5de05";

const connection = (
  overrides: Partial<CloudCatalogConnectionViewModel> = {},
): CloudCatalogConnectionViewModel => ({
  status: "authorized",
  ...overrides,
});

const group = (
  label: string,
  pdfCount: number,
  verificationStatus: HybridCatalogGroupViewModel["verificationStatus"] = "unverified",
  groupKey = `group:${label}`,
): HybridCatalogGroupViewModel => ({
  groupKey,
  rootRelativePath: label,
  label,
  pdfCount,
  mode: "recursive",
  verificationStatus,
});

const active = (
  groups: readonly HybridCatalogGroupViewModel[] = [group("Science", 12)],
  sourceImportSha256 = SOURCE_A,
): HybridCatalogActiveSummary => ({
  sourceImportSha256,
  legacyArtifactSetSha256: null,
  importedAt: 1,
  pdfCount: groups.reduce((sum, item) => sum + item.pdfCount, 0),
  unverifiedCount: groups
    .filter((item) => item.verificationStatus === "unverified")
    .reduce((sum, item) => sum + item.pdfCount, 0),
  verifiedCount: groups
    .filter((item) => item.verificationStatus === "verified")
    .reduce((sum, item) => sum + item.pdfCount, 0),
  differenceCount: groups
    .filter((item) => item.verificationStatus === "difference")
    .reduce((sum, item) => sum + item.pdfCount, 0),
  cloudMissingCount: 0,
  groupCount: groups.length,
  verifiedGroupCount: groups.filter((item) => item.verificationStatus !== "unverified").length,
  coveredCandidatePdfCount: groups
    .filter((item) => item.verificationStatus !== "unverified")
    .reduce((sum, item) => sum + item.pdfCount, 0),
  groups,
});

const candidate = (sourceSha256 = SOURCE_A) => ({
  sourceSha256,
  byteSize: 100,
  nonEmptyLineCount: 2,
  pdfCount: 1,
  directoryCount: 1,
  ignoredLeafCount: 0,
  normalizedWhitespaceCount: 0,
  maxDepth: 2,
});

const batch = (
  overrides: Partial<LargeCatalogBatchSummary> = {},
): LargeCatalogBatchSummary => ({
  batchId: "batch-current",
  status: "paused",
  stopReason: "user-canceled",
  resumeAvailable: true,
  runOrdinal: 1,
  remainingGroupCount: 1,
  pdfCount: 5,
  directoryCount: 2,
  ignoredFileCount: 0,
  listRequestCount: 2,
  cumulativeListRequestCount: 2,
  selectedGroupCount: 1,
  selectedGroupKeys: ["group:Science"],
  completedGroupCount: 0,
  currentGroupIndex: 0,
  currentGroupKey: "group:Science",
  committedPdfCount: 5,
  committedPageCount: 1,
  completedDirectoryCount: 1,
  pendingDirectoryCount: 1,
  autoResumeState: "inactive",
  autoSegmentIndex: 0,
  autoSegmentLimit: 12,
  verificationScope: {
    generation: 3,
    sourceImportSha256: SOURCE_A,
    cloudRootSha256: CLOUD_ROOT_SHA256,
  },
  legacyPromotionRequired: false,
  ...overrides,
});

const hybrid = (
  overrides: Partial<HybridCatalogViewModel> = {},
): HybridCatalogViewModel => ({
  status: "ready",
  executionActive: false,
  active: active(),
  ...overrides,
});

const binding = (
  overrides: Partial<BoundCloudLibraryV1> = {},
): BoundCloudLibraryV1 => ({
  schemaVersion: 1,
  path: "/Science",
  sourceImportSha256: SOURCE_A,
  verificationGeneration: 3,
  ...overrides,
});

const validTombstones = (
  batchIds: readonly string[] = [],
): VerificationBatchTombstonesV1 => ({
  schemaVersion: 1,
  state: "valid",
  batchIds,
});

const noAdoption = (): LegacyVerificationAdoptionV1 => ({
  schemaVersion: 1,
  state: "none",
});

const baseInput = (): LibraryWorkflowInput => ({
  connection: connection(),
  hybrid: hybrid(),
  boundCloudLibrary: binding(),
  cloudVerificationGeneration: 3,
  verificationBatchTombstones: validTombstones(),
  legacyVerificationAdoption: noAdoption(),
  pendingCatalogTxt: null,
  cloudVerificationRootHasher: () => CLOUD_ROOT_SHA256,
  capabilityAvailable: true,
});

type WorkflowCase = Readonly<{
  name: string;
  input: LibraryWorkflowInput;
  kind: LibraryWorkflowKind;
  action: LibraryPrimaryAction;
  titleKey: string;
  details: boolean;
}>;

describe("library workflow state", () => {
  const cases: readonly WorkflowCase[] = [
    {
      name: "needs TXT",
      input: { ...baseInput(), hybrid: hybrid({ status: "empty", active: undefined }) },
      kind: "needs-txt",
      action: "choose-txt",
      titleKey: "workflow.needsTxt.title",
      details: false,
    },
    {
      name: "confirms the retained TXT preview",
      input: {
        ...baseInput(),
        hybrid: hybrid({ status: "previewed", active: undefined, candidate: candidate() }),
        pendingCatalogTxt: { path: "/synthetic/catalog.txt", sourceSha256: SOURCE_A },
      },
      kind: "confirm-txt-import",
      action: "import-txt",
      titleKey: "workflow.confirmTxtImport.title",
      details: false,
    },
    {
      name: "needs a connection",
      input: { ...baseInput(), connection: connection({ status: "unconfigured" }) },
      kind: "needs-connection",
      action: "open-connection",
      titleKey: "workflow.needsConnection.title",
      details: false,
    },
    {
      name: "needs an explicit library binding",
      input: { ...baseInput(), boundCloudLibrary: null },
      kind: "needs-library",
      action: "choose-library",
      titleKey: "workflow.needsLibrary.title",
      details: false,
    },
    {
      name: "is ready with one recommendation",
      input: baseInput(),
      kind: "ready",
      action: "start",
      titleKey: "workflow.ready.title",
      details: false,
    },
    {
      name: "keeps an executing request pausable",
      input: {
        ...baseInput(),
        capabilityAvailable: false,
        connection: connection({ status: "partial", messageCode: "baidu-token-expired" }),
        hybrid: hybrid({
          status: "scanning",
          executionActive: true,
          active: undefined,
          batch: batch({ status: "scanning", resumeAvailable: false }),
        }),
      },
      kind: "running",
      action: "pause",
      titleKey: "workflow.running.title",
      details: true,
    },
    {
      name: "resumes a current paused batch",
      input: { ...baseInput(), hybrid: hybrid({ status: "paused", batch: batch() }) },
      kind: "paused",
      action: "resume",
      titleKey: "workflow.paused.title",
      details: true,
    },
    {
      name: "repairs an authorization fault",
      input: {
        ...baseInput(),
        connection: connection({ status: "partial", messageCode: "baidu-token-expired" }),
      },
      kind: "repair-connection",
      action: "open-connection",
      titleKey: "workflow.repairConnection.title",
      details: true,
    },
    {
      name: "repairs a current integrity fault",
      input: {
        ...baseInput(),
        hybrid: hybrid({ status: "error", messageCode: "invalid-baidu-response" }),
      },
      kind: "repair-library",
      action: "choose-library",
      titleKey: "workflow.repairLibrary.title",
      details: true,
    },
    {
      name: "retries a transient current batch",
      input: {
        ...baseInput(),
        hybrid: hybrid({
          status: "partial",
          batch: batch({ status: "partial", stopReason: "baidu-rate-limited" }),
        }),
      },
      kind: "retry-later",
      action: "retry",
      titleKey: "workflow.retryLater.title",
      details: true,
    },
    {
      name: "completes only after every recommendable group",
      input: {
        ...baseInput(),
        hybrid: hybrid({ active: active([group("Science", 12, "verified")]) }),
      },
      kind: "complete",
      action: "open-library",
      titleKey: "workflow.complete.title",
      details: false,
    },
    {
      name: "keeps the local library available when cloud capability is unavailable",
      input: { ...baseInput(), capabilityAvailable: false },
      kind: "unavailable",
      action: "open-library",
      titleKey: "workflow.unavailable.title",
      details: true,
    },
  ];

  it.each(cases)("derives $name", ({ input, kind, action, titleKey, details }) => {
    const state = deriveLibraryWorkflowState(input);

    expect(state).toMatchObject({
      kind,
      primaryAction: action,
      titleKey,
      descriptionKey: titleKey.replace(/\.title$/u, ".description"),
      canShowTechnicalDetails: details,
    });
    expect(state).not.toBeInstanceOf(Promise);
    expect(state.recommendedGroup === null || state.kind === "ready").toBe(true);
  });

  it("applies setup, connection, binding, and invalid-envelope precedence before resume", () => {
    const resumable = hybrid({ status: "paused", batch: batch() });

    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: { ...resumable, active: undefined },
      connection: connection({ status: "partial", messageCode: "baidu-token-expired" }),
    }).kind).toBe("needs-txt");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: resumable,
      connection: connection({ status: "partial", messageCode: "baidu-token-expired" }),
    }).kind).toBe("repair-connection");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: hybrid({ status: "partial", messageCode: "baidu-token-expired" }),
      verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
    }).kind).toBe("repair-connection");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: hybrid({
        status: "partial",
        messageCode: "baidu-token-expired",
        batch: batch({ verificationScope: null, legacyPromotionRequired: true }),
      }),
    }).kind).toBe("repair-connection");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: resumable,
      boundCloudLibrary: binding({ sourceImportSha256: SOURCE_B }),
    }).kind).toBe("needs-library");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: resumable,
      verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
    })).toMatchObject({ kind: "repair-library", primaryAction: "choose-library" });
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: resumable,
      legacyVerificationAdoption: { schemaVersion: 1, state: "invalid" },
    })).toMatchObject({ kind: "repair-library", primaryAction: "choose-library" });
  });

  it("requires the retained path and matching candidate hash before confirming import", () => {
    const previewed = hybrid({ status: "previewed", active: undefined, candidate: candidate() });

    expect(deriveLibraryWorkflowState({ ...baseInput(), hybrid: previewed }).kind)
      .toBe("needs-txt");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: previewed,
      pendingCatalogTxt: { path: "/synthetic/catalog.txt", sourceSha256: SOURCE_B },
    }).kind).toBe("needs-txt");
  });

  it("fails closed to library repair when the composition cannot derive a valid root digest", () => {
    const paused = hybrid({ status: "paused", batch: batch() });

    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: paused,
      cloudVerificationRootHasher: () => null,
    })).toMatchObject({ kind: "needs-library", primaryAction: "choose-library" });
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: paused,
      cloudVerificationRootHasher: () => "invalid-digest",
    })).toMatchObject({ kind: "needs-library", primaryAction: "choose-library" });
  });

  it("does not let superseded, unlisted legacy, or scope-mismatched batches block a fresh start", () => {
    const paused = hybrid({ status: "paused", batch: batch() });

    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: paused,
      verificationBatchTombstones: validTombstones(["batch-current"]),
    }).kind).toBe("ready");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: hybrid({
        status: "paused",
        batch: batch({ verificationScope: null, legacyPromotionRequired: true }),
      }),
    }).kind).toBe("ready");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: hybrid({
        status: "paused",
        batch: batch({
          verificationScope: {
            generation: 2,
            sourceImportSha256: SOURCE_A,
            cloudRootSha256: CLOUD_ROOT_SHA256,
          },
        }),
      }),
    }).kind).toBe("ready");
  });

  it("accepts only the exactly adopted legacy batch for resume", () => {
    const adoption: LegacyVerificationAdoptionV1 = {
      schemaVersion: 1,
      state: "adopted",
      verificationGeneration: 3,
      sourceImportSha256: SOURCE_A,
      cloudRootSha256: CLOUD_ROOT_SHA256,
      candidate: {
        importId: "import-1",
        manifestSha256: "c".repeat(64),
        descriptorSha256: "d".repeat(64),
      },
      overlays: [],
      unified: null,
      resumableBatch: {
        batchId: "batch-current",
        checkpointSha256: "e".repeat(64),
        sourceImportSha256: SOURCE_A,
        cloudRootSha256: CLOUD_ROOT_SHA256,
      },
    };

    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      legacyVerificationAdoption: adoption,
      hybrid: hybrid({
        status: "paused",
        batch: batch({ legacyPromotionRequired: true }),
      }),
    }).kind).toBe("paused");
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      legacyVerificationAdoption: {
        ...adoption,
        resumableBatch: adoption.resumableBatch === null
          ? null
          : { ...adoption.resumableBatch, batchId: "another-batch" },
      },
      hybrid: hybrid({
        status: "paused",
        batch: batch({ legacyPromotionRequired: true }),
      }),
    }).kind).toBe("ready");
  });

  it("treats an older adopted scope as history after an explicit new binding", () => {
    const oldAdoption: LegacyVerificationAdoptionV1 = {
      schemaVersion: 1,
      state: "adopted",
      verificationGeneration: 2,
      sourceImportSha256: SOURCE_B,
      cloudRootSha256: "f".repeat(64),
      candidate: {
        importId: "old-import",
        manifestSha256: "c".repeat(64),
        descriptorSha256: "d".repeat(64),
      },
      overlays: [],
      unified: null,
      resumableBatch: null,
    };

    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      legacyVerificationAdoption: oldAdoption,
    })).toMatchObject({ kind: "ready", primaryAction: "start" });
  });

  it("maps path and current-batch integrity failures to explicit library repair", () => {
    for (const messageCode of [
      "baidu-not-found",
      "hybrid-cloud-root-mismatch",
      "invalid-baidu-response",
      "hybrid-batch-invalid",
    ] as const) {
      expect(deriveLibraryWorkflowState({
        ...baseInput(),
        hybrid: hybrid({ status: "error", messageCode, batch: batch() }),
      })).toMatchObject({ kind: "repair-library", primaryAction: "choose-library" });
    }
  });

  it("recovers snapshot corruption without an active catalog through TXT selection", () => {
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: hybrid({ status: "error", active: undefined, messageCode: "hybrid-snapshot-corrupt" }),
    })).toMatchObject({
      kind: "needs-txt",
      primaryAction: "choose-txt",
      canShowTechnicalDetails: true,
    });
  });

  it("moves through two categories and completes only after the second finishes", () => {
    const first = group("First", 1, "verified");
    const second = group("Second", 2);

    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: hybrid({
        active: active([first, second]),
        batch: batch({ status: "complete", stopReason: "complete", resumeAvailable: false }),
      }),
    }).recommendedGroup?.groupKey).toBe(second.groupKey);
    expect(deriveLibraryWorkflowState({
      ...baseInput(),
      hybrid: hybrid({
        active: active([first, { ...second, verificationStatus: "verified" }]),
        batch: batch({ status: "complete", stopReason: "complete", resumeAvailable: false }),
      }),
    }).kind).toBe("complete");
  });

  it("returns a detached recommendation without mutating the input", () => {
    const groups = Object.freeze([
      Object.freeze(group("first", 252)),
      Object.freeze(group("second", 122)),
      Object.freeze(group("third", 122)),
      Object.freeze(group("root", 1, "unverified", "txt-root-items")),
      Object.freeze(group("verified", 2, "verified")),
      Object.freeze(group("difference", 3, "difference")),
    ]);
    const before = JSON.parse(JSON.stringify(groups)) as unknown;

    const result = recommendNextVerificationGroup(groups);

    expect(result?.groupKey).toBe("group:second");
    expect(result).not.toBe(groups[1]);
    expect(groups).toEqual(before);
  });

  it("clones the recommendation attached to workflow state", () => {
    const recommended = group("Small", 1);
    const input = {
      ...baseInput(),
      hybrid: hybrid({ active: active([recommended]) }),
    };

    const state = deriveLibraryWorkflowState(input);

    expect(state.recommendedGroup).toEqual(recommended);
    expect(state.recommendedGroup).not.toBe(recommended);
  });
});
