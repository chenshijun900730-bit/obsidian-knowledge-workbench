# Category Verification Progress and Auto-Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add truthful three-layer category-verification progress and automatically continue bounded Baidu metadata-listing segments after one confirmation, while stopping safely on cancellation, errors, no progress, or the 12-segment session ceiling.

**Architecture:** Derive aggregate-only progress from the existing checkpoint V3 and committed batch records without changing the persisted schema. The verification service emits post-persistence progress events; the hybrid runtime owns one sticky-cancel auto-chain and projects safe view models; a focused DOM renderer displays overall coverage, indeterminate current activity, a determinate per-segment quota, and collapsed technical details.

**Tech Stack:** TypeScript 5.8, Vitest 4, jsdom, Obsidian 1.13 DOM APIs, Node.js crypto, existing schema-V3 hybrid catalog storage, CSS with Obsidian theme variables, esbuild.

---

## Scope and safety invariants

- Use `docs/superpowers/specs/2026-08-26-category-verification-progress-auto-resume-design.md` as the product contract.
- Execute on a dedicated `codex/verification-progress-auto-resume` branch created from the plan commit; do not create a duplicate repository.
- Never stage or modify the 11 unrelated untracked research Markdown files at the repository root.
- Do not use PMH, run PMH experiments, create PMH checkpoints, or inspect another task's logs or memories.
- Do not perform real OAuth, a real Baidu request, a real TXT import, PDF download, cloud mutation, or real Vault write during implementation and automated verification.
- All tests use synthetic paths, group keys, records, stop reasons, clocks, and list responses.
- Preserve checkpoint V3, overlay activation, the five-category selection cap, and every per-segment budget.
- Opening Obsidian or initializing the runtime must remain offline. Only the existing user-confirmed start/resume action may begin the auto-chain.
- The automatic chain continues only budget pauses. User cancellation, rate limiting, authorization/access faults, path/permission faults, malformed responses, and local consistency errors stop it.
- Each task follows RED → focused GREEN → relevant regression → one Chinese conventional commit. Stage only the files listed by that task.

## File responsibility map

New files:

- `src/catalog/large-catalog-verification-progress.ts` — pure aggregate summary, hashed progress marker, event types, and durable-progress comparison.
- `src/ui/verification-progress.ts` — pure three-layer progress and collapsed run-details renderer.
- `tests/unit/catalog/large-catalog-verification-progress.test.ts` — aggregate and progress-marker contracts.
- `tests/ui/verification-progress.test.ts` — progress semantics, ARIA, details, and bounded percentages.

Existing files changed:

- `src/catalog/large-catalog-verification-service.ts` — emit aggregate-only events only after persistence succeeds.
- `src/catalog/hybrid-catalog-runtime.ts` — truthful coverage, reason-aware resume, automatic segment chain, sticky cancellation, no-progress guard, 12-segment ceiling, and active-summary refresh.
- `src/catalog/hybrid-catalog-types.ts` — non-persisted auto-chain limit constant only; checkpoint V3 remains unchanged.
- `src/ui/verification-page.ts` — compose the focused progress renderer and map actions to stopped states.
- `src/ui/workbench-view.ts` — preserve run-details expansion and focus across runtime re-renders.
- `src/ui/settings-sections.ts` — keep the settings summary short and fold technical counters.
- `src/i18n/workbench-i18n.ts` — exact Chinese/English progress, state, recovery, and accessibility strings.
- `styles.css` — responsive progress cards, native progress bars, status cards, details, and reduced motion.
- `tests/unit/catalog/large-catalog-verification-service.test.ts` — post-persistence event order and privacy.
- `tests/unit/catalog/hybrid-catalog-runtime.test.ts` — coverage, auto-chain, stop matrix, progress refresh, and restart isolation.
- `tests/ui/verification-page.test.ts` — page integration and action mapping.
- `tests/ui/workbench-view.test.ts` — re-rendered segment progress, details state, and focus.
- `tests/ui/settings-sections.test.ts` — settings summary/details and bilingual rendering.
- `tests/ui/catalog-large-scan-confirmation-modal.test.ts` — keep shared hybrid-summary fixtures type-complete.
- `tests/ui/settings-tab.test.ts` — keep native-settings hybrid-summary fixtures type-complete.
- `tests/ui/workbench-controller.test.ts` — keep controller/runtime hybrid-summary fixtures type-complete.
- `tests/unit/catalog/large-catalog-batch-contracts.test.ts` — prove the auto-chain limit never enters checkpoint V3.
- `docs/superpowers/specs/2026-08-26-category-verification-progress-auto-resume-design.md` — final implementation status after all gates pass.

### Task 1: Add pure aggregate progress contracts

**Files:**

- Create: `src/catalog/large-catalog-verification-progress.ts`
- Create: `tests/unit/catalog/large-catalog-verification-progress.test.ts`

- [ ] **Step 1: Write the failing aggregate and durable-progress tests**

Create `tests/unit/catalog/large-catalog-verification-progress.test.ts` with a complete checkpoint fixture and these assertions:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-verification-progress.test.ts
```

Expected: FAIL because `src/catalog/large-catalog-verification-progress.ts` does not exist.

- [ ] **Step 3: Implement the pure summary and marker module**

Create `src/catalog/large-catalog-verification-progress.ts` with these public contracts and pure calculations:

```ts
import { createHash } from "node:crypto";
import type {
  LargeCatalogBatchCheckpointV3,
  LargeCatalogStopReason,
} from "./hybrid-catalog-types";

export interface LargeVerificationProgressMarker {
  readonly committedPdfCount: number;
  readonly committedPageCount: number;
  readonly completedDirectoryCount: number;
  readonly completedGroupCount: number;
  readonly currentGroupIndex: number;
  readonly pendingStateSha256: string;
}

export interface LargeCatalogVerificationSummary {
  readonly batchId: string;
  readonly status: "scanning" | "complete" | "paused" | "partial";
  readonly stopReason: LargeCatalogStopReason | null;
  readonly runOrdinal: number;
  readonly selectedGroupCount: number;
  readonly completedGroupCount: number;
  readonly remainingGroupCount: number;
  readonly currentGroupIndex: number;
  readonly currentGroupKey: string | null;
  readonly pdfCount: number;
  readonly directoryCount: number;
  readonly ignoredFileCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
  readonly committedPdfCount: number;
  readonly committedPageCount: number;
  readonly completedDirectoryCount: number;
  readonly pendingDirectoryCount: number;
  readonly progressMarker: LargeVerificationProgressMarker;
}

export type LargeVerificationProgressPhase =
  | "segment-started"
  | "request-permitted"
  | "page-committed"
  | "group-completed"
  | "segment-finalized";

export interface LargeVerificationProgressEvent {
  readonly phase: LargeVerificationProgressPhase;
  readonly summary: LargeCatalogVerificationSummary;
  readonly recoveredFromScanning: boolean;
}

const pendingStateHash = (checkpoint: LargeCatalogBatchCheckpointV3): string => {
  const state = checkpoint.groups.map((group) => ({
    key: group.groupKey,
    status: group.status,
    pending: group.pending.map((page) => [page.relativePath, page.start] as const),
  }));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
};

export const summarizeLargeCatalogVerification = (
  checkpoint: LargeCatalogBatchCheckpointV3,
  committedPdfCount: number,
): LargeCatalogVerificationSummary => {
  const completedGroupCount = checkpoint.groups.filter((group) => group.status === "complete").length;
  const committedPageCount = checkpoint.groups.reduce(
    (total, group) => total + group.committedPageKeys.length,
    0,
  );
  const completedDirectoryCount = checkpoint.groups.reduce(
    (total, group) => total + group.completedDirectoryCount,
    0,
  );
  const pendingDirectoryCount = checkpoint.groups.reduce(
    (total, group) => total + group.pending.length,
    0,
  );
  const currentGroupKey = checkpoint.groups[checkpoint.currentGroupIndex]?.groupKey ?? null;
  const progressMarker: LargeVerificationProgressMarker = {
    committedPdfCount,
    committedPageCount,
    completedDirectoryCount,
    completedGroupCount,
    currentGroupIndex: checkpoint.currentGroupIndex,
    pendingStateSha256: pendingStateHash(checkpoint),
  };
  return {
    batchId: checkpoint.batchId,
    status: checkpoint.status,
    stopReason: checkpoint.stopReason,
    runOrdinal: checkpoint.runOrdinal,
    selectedGroupCount: checkpoint.selectedGroupCount,
    completedGroupCount,
    remainingGroupCount: checkpoint.selectedGroupCount - completedGroupCount,
    currentGroupIndex: checkpoint.currentGroupIndex,
    currentGroupKey,
    pdfCount: checkpoint.pdfCount,
    directoryCount: checkpoint.directoryCount,
    ignoredFileCount: checkpoint.ignoredFileCount,
    listRequestCount: checkpoint.listRequestCount,
    cumulativeListRequestCount: checkpoint.cumulativeListRequestCount,
    committedPdfCount,
    committedPageCount,
    completedDirectoryCount,
    pendingDirectoryCount,
    progressMarker,
  };
};

export const hasDurableVerificationProgress = (
  before: LargeVerificationProgressMarker,
  after: LargeVerificationProgressMarker,
): boolean => (
  after.committedPdfCount > before.committedPdfCount
  || after.committedPageCount > before.committedPageCount
  || after.completedDirectoryCount > before.completedDirectoryCount
  || after.completedGroupCount > before.completedGroupCount
  || after.currentGroupIndex > before.currentGroupIndex
  || after.pendingStateSha256 !== before.pendingStateSha256
);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-verification-progress.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/catalog/large-catalog-verification-progress.ts tests/unit/catalog/large-catalog-verification-progress.test.ts
git commit -m "feat(核验): 增加可信进度聚合契约"
```

### Task 2: Emit progress only after durable service writes

**Files:**

- Modify: `src/catalog/large-catalog-verification-service.ts`
- Modify: `tests/unit/catalog/large-catalog-verification-service.test.ts`

- [ ] **Step 1: Write failing event-order, atomicity, and privacy tests**

Add imports for `LargeVerificationProgressEvent`, then add a test that records events from an ordinary one-page run:

```ts
it("emits aggregate progress only after persisted boundaries", async () => {
  const source = new ScriptedSource([
    { path: "/Library/Synthetic", start: 0, entries: [file("/Library/Synthetic/A.pdf", "1")] },
  ]);
  const { adapter, service } = await harness(source);
  const events: LargeVerificationProgressEvent[] = [];
  const result = await service.start({
    batchId: "batch-events",
    sourceImportSha256: HASH_A,
    cloudRoot: "/Library",
    groups: [selection()],
    onProgress: (event) => { events.push(event); },
  });

  expect(events.map((event) => event.phase)).toEqual([
    "segment-started",
    "request-permitted",
    "page-committed",
    "group-completed",
    "segment-finalized",
  ]);
  expect(events.find((event) => event.phase === "request-permitted")?.summary)
    .toMatchObject({ listRequestCount: 1, committedPdfCount: 0 });
  expect(events.find((event) => event.phase === "page-committed")?.summary)
    .toMatchObject({ pdfCount: 1, committedPdfCount: 1, committedPageCount: 1 });
  expect(events.at(-1)?.summary).toEqual(result);
  expect(JSON.stringify(events)).not.toContain("/Library");
  expect(JSON.stringify(events)).not.toContain("A.pdf");
  expect((await adapter.loadBatch("batch-events"))?.records).toHaveLength(1);
});
```

In the existing 501-directory budget test, pass an event collector and add:

```ts
expect(events.at(-1)?.phase).toBe("segment-finalized");
expect(events.at(-1)?.summary).toMatchObject({
  status: "paused",
  stopReason: "directory-limit",
  committedPdfCount: 0,
  committedPageCount: 0,
});
expect(events.some((event) => event.phase === "page-committed")).toBe(false);
```

Add this fail-isolation test with the existing one-file scripted source:

```ts
it("keeps persisted results when a progress listener throws", async () => {
  const source = new ScriptedSource([
    { path: "/Library/Synthetic", start: 0, entries: [file("/Library/Synthetic/A.pdf", "1")] },
  ]);
  const { adapter, service } = await harness(source);
  const result = await service.start({
    batchId: "batch-listener-failure",
    sourceImportSha256: HASH_A,
    cloudRoot: "/Library",
    groups: [selection()],
    onProgress: () => { throw new Error("synthetic-progress-listener-failure"); },
  });
  expect(result.status).toBe("complete");
  expect((await adapter.loadBatch("batch-listener-failure"))?.records).toHaveLength(1);
});
```

- [ ] **Step 2: Run the service tests and verify RED**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-verification-service.test.ts
```

Expected: FAIL because start/segment inputs have no `onProgress` contract and no events are emitted.

- [ ] **Step 3: Replace the service-local summary with the pure aggregate summary**

In `src/catalog/large-catalog-verification-service.ts`:

```ts
import {
  summarizeLargeCatalogVerification,
  type LargeCatalogVerificationSummary,
  type LargeVerificationProgressEvent,
} from "./large-catalog-verification-progress";

export type {
  LargeCatalogVerificationSummary,
  LargeVerificationProgressEvent,
} from "./large-catalog-verification-progress";

type ProgressListener = (event: LargeVerificationProgressEvent) => void | Promise<void>;
```

Add `readonly onProgress?: ProgressListener` to both `LargeCatalogVerificationStartInput` and `LargeCatalogVerificationSegmentInput`. Delete the old service-local `LargeCatalogVerificationSummary` and `summaryFrom` definitions.

- [ ] **Step 4: Add one fail-isolated notification helper and committed-record count**

Add this private method:

```ts
async #notify(
  listener: ProgressListener | undefined,
  phase: LargeVerificationProgressEvent["phase"],
  checkpoint: LargeCatalogBatchCheckpointV3,
  committedPdfCount: number,
  recoveredFromScanning: boolean,
): Promise<void> {
  if (listener === undefined) return;
  try {
    await listener({
      phase,
      summary: summarizeLargeCatalogVerification(checkpoint, committedPdfCount),
      recoveredFromScanning,
    });
  } catch {
    // Progress presentation must not invalidate already-persisted catalog data.
  }
}
```

In `runSegment`, capture `const recoveredFromScanning = loaded.checkpoint.status === "scanning"` and initialize `let committedPdfCount = loaded.records.length`. Pass the listener, count, and recovery flag into `#execute`.

- [ ] **Step 5: Notify at the exact persistence boundaries**

Make these calls only after their corresponding store promise resolves:

```ts
await this.#notify(input.onProgress, "segment-started", checkpoint, committedPdfCount, recoveredFromScanning);

await this.#store.saveBatchPermit(permitted);
checkpoint = permitted;
await this.#notify(listener, "request-permitted", checkpoint, committedPdfCount, recoveredFromScanning);

await this.#store.commitBatchPage({
  batchId: checkpoint.batchId,
  pageKey,
  records: converted.records,
  identities: converted.identities,
  nextCheckpoint: next,
});
committedPdfCount += converted.records.length;
checkpoint = next;
await this.#notify(listener, "page-committed", checkpoint, committedPdfCount, recoveredFromScanning);
```

For a non-final group, emit only after `advanceBatchGroup(checkpoint)` resolves:

```ts
await this.#store.advanceBatchGroup(checkpoint);
await this.#notify(listener, "group-completed", checkpoint, committedPdfCount, recoveredFromScanning);
```

For the final group, call `finalizeBatchRun` first, then emit `group-completed` and `segment-finalized` from the same persisted terminal checkpoint. Update `#finalizePaused` and `#finalizePartial` to receive listener/count/recovery arguments, await `finalizeBatchRun`, emit `segment-finalized`, and return `summarizeLargeCatalogVerification(terminal, committedPdfCount)`. Do not emit `page-committed` for a page rejected before `commitBatchPage`.

- [ ] **Step 6: Run focused service and adapter regressions**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-verification-service.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts
```

Expected: PASS. Existing pause, resume, cancellation, rate-limit, page-atomicity, and checkpoint-transition tests remain green.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/catalog/large-catalog-verification-service.ts tests/unit/catalog/large-catalog-verification-service.test.ts
git commit -m "feat(核验): 发布持久化后进度事件"
```

### Task 3: Project truthful coverage and reason-aware recovery

**Files:**

- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `tests/ui/catalog-large-scan-confirmation-modal.test.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `tests/ui/settings-tab.test.ts`
- Modify: `tests/ui/verification-page.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`

- [ ] **Step 1: Write failing coverage and recovery-matrix tests**

Extend the runtime fixture so active overlay groups deliberately differ from `verifiedCount`, then assert:

```ts
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
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```bash
npx vitest run tests/unit/catalog/hybrid-catalog-runtime.test.ts
```

Expected: FAIL because `coveredCandidatePdfCount` is absent and partial batches are never resumable.

- [ ] **Step 3: Add truthful active and richer batch view models**

Add `coveredCandidatePdfCount` to `HybridCatalogActiveSummary`. Expand `LargeCatalogBatchSummary` with the aggregate fields from `LargeCatalogVerificationSummary`, but deliberately omit `progressMarker.pendingStateSha256` from `snapshot()` output.

The added batch fields are exact aggregate numbers:

```ts
readonly selectedGroupCount: number;
readonly completedGroupCount: number;
readonly currentGroupIndex: number;
readonly currentGroupKey: string | null;
readonly committedPdfCount: number;
readonly committedPageCount: number;
readonly completedDirectoryCount: number;
readonly pendingDirectoryCount: number;
```

Make `batchFromVerification` copy these fields explicitly. Do not spread the service summary into the UI model:

```ts
selectedGroupCount: summary.selectedGroupCount,
completedGroupCount: summary.completedGroupCount,
currentGroupIndex: summary.currentGroupIndex,
currentGroupKey: summary.currentGroupKey,
committedPdfCount: summary.committedPdfCount,
committedPageCount: summary.committedPageCount,
completedDirectoryCount: summary.completedDirectoryCount,
pendingDirectoryCount: summary.pendingDirectoryCount,
```

Compute coverage inside `loadActive` from `verifiedGroups` and the candidate-group map:

```ts
const coveredCandidatePdfCount = [...candidatesByGroup.entries()].reduce(
  (total, [groupKey, records]) => verifiedGroups.has(groupKey) ? total + records.length : total,
  0,
);
```

Return that value beside `pdfCount`, `verifiedCount`, and `verifiedGroupCount`.

Because the summaries are deliberately required rather than optional, update every synthetic `HybridCatalogActiveSummary` and `LargeCatalogBatchSummary` literal in the files listed for this task. Use these exact neutral defaults when a test is not exercising progress:

```ts
coveredCandidatePdfCount: 0,

selectedGroupCount: 1,
completedGroupCount: 0,
currentGroupIndex: 0,
currentGroupKey: null,
committedPdfCount: 0,
committedPageCount: 0,
completedDirectoryCount: 0,
pendingDirectoryCount: 0,
```

For existing verified fixtures, set `coveredCandidatePdfCount` to the number of candidates in groups with active complete overlays, not to `verifiedCount`. Do not weaken the fields to optional values to avoid updating the fixtures.

- [ ] **Step 4: Make resume availability depend on status and reason**

Replace the status-only function with:

```ts
const RETRYABLE_PARTIAL_REASONS = new Set<LargeCatalogStopReason>([
  "baidu-rate-limited",
  "baidu-token-expired",
  "baidu-access-unavailable",
]);

const resumeAvailableFor = (
  status: "complete" | "paused" | "partial",
  stopReason: LargeCatalogStopReason | null,
): boolean => status === "paused"
  || (status === "partial" && stopReason !== null && RETRYABLE_PARTIAL_REASONS.has(stopReason));
```

Use `summarizeLargeCatalogVerification(latest.checkpoint, latest.records.length)` during initialize so restored batches have the same aggregate fields as live results.

- [ ] **Step 5: Refresh active state after every terminal segment**

In `publishVerificationResult`, always call `loadActive()` before replacing the view model, including paused and partial results:

```ts
const active = await this.loadActive();
if (this.disposed) return;
this.viewModel = {
  status: result.status === "complete"
    ? active === undefined ? "empty" : "ready"
    : result.status === "partial" ? "partial" : "paused",
  ...(active === undefined ? {} : { active: cloneActive(active) }),
  batch: batchFromVerification(result),
};
this.emit();
```

- [ ] **Step 6: Run runtime and catalog-search regressions**

Run:

```bash
npx vitest run \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/unit/catalog/unified-catalog-search-service.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts
```

Expected: PASS with no path strings in serialized runtime snapshots.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/catalog/hybrid-catalog-runtime.ts tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts tests/ui/verification-page.test.ts \
  tests/ui/workbench-controller.test.ts tests/ui/workbench-view.test.ts
git commit -m "fix(核验): 使用完整分类计算覆盖率"
```

### Task 4: Automatically continue budget-paused segments

**Files:**

- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `tests/ui/catalog-large-scan-confirmation-modal.test.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `tests/ui/settings-tab.test.ts`
- Modify: `tests/ui/verification-page.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`

- [ ] **Step 1: Make the runtime test fixture script segment results**

Add these exact fields to the runtime fixture options before creating the paired queues:

```ts
readonly verificationResults?: readonly LargeCatalogVerificationSummary[];
readonly verificationStarts?: readonly LargeCatalogVerificationSummary[];
```

Define deterministic summary/event helpers and replace the fixed verification fakes with paired queues:

```ts
const verificationSummary = (
  overrides: Partial<LargeCatalogVerificationSummary> = {},
): LargeCatalogVerificationSummary => {
  const base: LargeCatalogVerificationSummary = {
    batchId: "batch-new",
    status: "paused",
    stopReason: "pdf-limit",
    runOrdinal: 1,
    selectedGroupCount: 1,
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
  summary: LargeCatalogVerificationSummary,
  phase: LargeVerificationProgressEvent["phase"],
): LargeVerificationProgressEvent => ({
  phase,
  summary,
  recoveredFromScanning: false,
});

const verificationResults = [...(options.verificationResults ?? [
  verificationSummary({ status: "complete", stopReason: "complete", completedGroupCount: 1, remainingGroupCount: 0 }),
])];
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
const nextVerificationStep = (): Readonly<{
  start: LargeCatalogVerificationSummary;
  result: LargeCatalogVerificationSummary;
}> => {
  const start = verificationStarts.shift();
  const result = verificationResults.shift();
  if (start === undefined || result === undefined) throw new Error("verification-result-exhausted");
  return { start, result };
};
const verification = {
  start: vi.fn(async (input: LargeCatalogVerificationStartInput) => {
    const { start, result } = nextVerificationStep();
    await input.onProgress?.(verificationProgressEvent(start, "segment-started"));
    await input.onProgress?.(verificationProgressEvent(result, "segment-finalized"));
    return result;
  }),
  runSegment: vi.fn(async (input: LargeCatalogVerificationSegmentInput) => {
    const { start, result } = nextVerificationStep();
    await input.onProgress?.(verificationProgressEvent(start, "segment-started"));
    await input.onProgress?.(verificationProgressEvent(result, "segment-finalized"));
    return result;
  }),
};
```

Import `LargeCatalogVerificationSummary` and `LargeVerificationProgressEvent` from the progress module. Tests that need a terminal pause must supply `user-canceled` or an error result explicitly; budget pauses now intentionally continue.

- [ ] **Step 2: Add RED auto-continuation and stop-matrix tests**

Add one parameterized test for the four budget reasons and one stop test:

```ts
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
    await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });
    expect(value.verification.start).toHaveBeenCalledOnce();
    expect(value.verification.runSegment).toHaveBeenCalledOnce();
    expect(value.runtime.snapshot()).toMatchObject({ status: "ready", batch: { status: "complete" } });
  },
);

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
    const value = fixture({ verificationResults: [verificationSummary({ status, stopReason })] });
    await value.runtime.initialize();
    await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });
    expect(value.verification.runSegment).not.toHaveBeenCalled();
  },
);
```

- [ ] **Step 3: Run runtime tests and verify RED**

Run:

```bash
npx vitest run \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts
```

Expected: budget cases FAIL because the runtime publishes paused after the first segment.

- [ ] **Step 4: Add explicit auto state to the non-persisted batch view**

Add:

```ts
export type LargeCatalogAutoResumeState =
  | "inactive"
  | "running"
  | "starting-next-segment"
  | "stopped-no-progress"
  | "stopped-limit";
```

Add `autoResumeState`, `autoSegmentIndex`, and `autoSegmentLimit` to `LargeCatalogBatchSummary`. Initialize restored batches as `inactive`, index `0`, and the fixed limit.

Also expand `LargeCatalogBatchSummary.status` to include `"scanning"`. `resumeAvailable` is always false while scanning.

In `src/catalog/hybrid-catalog-types.ts`, add the non-persisted UI/runtime constant outside checkpoint and receipt interfaces:

```ts
export const LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS = 12 as const;
```

Update every synthetic batch literal in the files listed for this task with these exact non-running defaults unless the test is explicitly exercising the automatic chain:

```ts
autoResumeState: "inactive",
autoSegmentIndex: 0,
autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
```

Import the limit rather than repeating `12` in fixtures. Do not add these fields to persisted checkpoint literals.

- [ ] **Step 5: Implement a single serial chain for start and resume**

Add a private `runVerificationChain` that owns the controller for the entire chain. Use this exact continuation predicate:

```ts
const AUTO_CONTINUE_REASONS = new Set<LargeCatalogStopReason>([
  "pdf-limit",
  "directory-limit",
  "list-request-limit",
  "time-limit",
]);

const canAutoContinue = (result: LargeCatalogVerificationSummary): boolean => (
  result.status === "paused"
  && result.stopReason !== null
  && AUTO_CONTINUE_REASONS.has(result.stopReason)
);
```

Keep `busy = true` until the full chain ends. Add the runtime identity field beside the existing controller state:

```ts
private scanGeneration = 0;
```

Each public start/resume entry point captures `const generation = ++this.scanGeneration`, installs one controller, and passes both into the chain. `startLargeVerification` calls `verification.start` once; `resumeLargeVerification` calls `verification.runSegment` once; subsequent budget pauses are handled only by the same private loop. Before each automatic next call, publish `autoResumeState: "starting-next-segment"`; while the service runs, publish `"running"`.

Use one typed auto-view object and the following loop shape; Task 5 adds the two guard branches without changing its call order:

```ts
interface AutoChainView {
  readonly autoResumeState: LargeCatalogAutoResumeState;
  readonly autoSegmentIndex: number;
  readonly autoSegmentLimit: number;
}

private async runVerificationChain(input: Readonly<{
  cloudRoot: string;
  controller: AbortController;
  generation: number;
  first: (
    onProgress: (event: LargeVerificationProgressEvent) => Promise<void>,
  ) => Promise<LargeCatalogVerificationSummary>;
}>): Promise<void> {
  let autoSegmentIndex = 1;
  const isCurrent = (): boolean => !this.disposed
    && this.scanController === input.controller
    && !input.controller.signal.aborted
    && this.scanGeneration === input.generation;
  const autoView = (state: LargeCatalogAutoResumeState): AutoChainView => ({
    autoResumeState: state,
    autoSegmentIndex,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  });
  const onProgress = async (event: LargeVerificationProgressEvent): Promise<void> => {
    if (!isCurrent()) return;
    const active = event.phase === "group-completed"
      ? await this.loadActive()
      : this.viewModel.active;
    if (!isCurrent()) return;
    this.viewModel = {
      status: "scanning",
      ...(active === undefined ? {} : { active: cloneActive(active) }),
      batch: batchFromVerification(event.summary, autoView("running")),
    };
    this.emit();
  };

  let result = await input.first(onProgress);
  while (isCurrent() && canAutoContinue(result)) {
    await this.publishVerificationResult(result, autoView("starting-next-segment"), true);
    if (!isCurrent()) return;
    autoSegmentIndex += 1;
    result = await this.dependencies.verification.runSegment({
      batchId: result.batchId,
      cloudRoot: input.cloudRoot,
      signal: input.controller.signal,
      onProgress,
    });
  }
  if (isCurrent()) await this.publishVerificationResult(result, autoView("inactive"), false);
}
```

Change `publishVerificationResult` to accept `(result, autoView, keepScanning)`. It always refreshes active state, builds the batch with `batchFromVerification(result, autoView)`, and uses top-level status `"scanning"` when `keepScanning` is true.

Both public entry points create one controller and generation, then call this helper. Their `finally` block clears `scanController` and `busy` only if the same controller/generation still owns the chain:

```ts
if (this.scanController === controller && this.scanGeneration === generation) {
  this.scanController = null;
  this.busy = false;
}
```

- [ ] **Step 6: Run runtime tests and verify GREEN**

Run:

```bash
npx vitest run \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts
```

Expected: PASS. Exactly one chain is active, budget pauses continue, and errors do not retry.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/catalog/hybrid-catalog-types.ts src/catalog/hybrid-catalog-runtime.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts tests/ui/verification-page.test.ts \
  tests/ui/workbench-controller.test.ts tests/ui/workbench-view.test.ts
git commit -m "feat(核验): 自动续跑预算片段"
```

### Task 5: Add sticky cancellation, no-progress protection, and the 12-segment ceiling

**Files:**

- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `tests/unit/catalog/large-catalog-batch-contracts.test.ts`

- [ ] **Step 1: Write failing safety tests**

Add tests for all three guards:

```ts
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

it("stops after twelve automatic-chain segments", async () => {
  const results = Array.from({ length: 12 }, (_, index) => verificationSummary({
    status: "paused",
    stopReason: "pdf-limit",
    runOrdinal: index + 1,
    committedPageCount: index + 1,
    committedPdfCount: (index + 1) * 9_000,
  }));
  const value = fixture({ verificationResults: results });
  await value.runtime.initialize();
  await value.runtime.startLargeVerification({ cloudRoot: "/Synthetic", groupKeys: [GROUP_A] });
  expect(value.verification.start).toHaveBeenCalledOnce();
  expect(value.verification.runSegment).toHaveBeenCalledTimes(11);
  expect(value.runtime.snapshot().batch).toMatchObject({
    autoResumeState: "stopped-limit",
    autoSegmentIndex: 12,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  });
});
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```bash
npx vitest run tests/unit/catalog/hybrid-catalog-runtime.test.ts
```

Expected: FAIL because cancellation is not sticky between calls and neither guard exists.

- [ ] **Step 3: Confirm the chain limit remains runtime-only**

Keep `LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS` outside `LargeCatalogBatchCheckpointV3`. Add this assertion to `tests/unit/catalog/large-catalog-batch-contracts.test.ts` beside the existing checkpoint-shape contracts:

```ts
expect(Object.keys(pausedCheckpoint())).not.toContain("autoSegmentLimit");
expect(LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS).toBe(12);
```

Do not add the limit to checkpoint codecs, receipts, manifests, or adapter transition validation.

- [ ] **Step 4: Capture a start marker from service events and compare the terminal marker**

Add these variables beside `autoSegmentIndex`, and set them only from `segment-started`:

```ts
let segmentStartMarker: LargeVerificationProgressMarker | null = null;
let recoveredFromScanning = false;

if (event.phase === "segment-started") {
  segmentStartMarker = event.summary.progressMarker;
  recoveredFromScanning = event.recoveredFromScanning;
}
```

At a budget terminal result:

```ts
const progressed = segmentStartMarker !== null
  && hasDurableVerificationProgress(segmentStartMarker, result.progressMarker);
if (!progressed && !recoveredFromScanning) {
  await this.publishVerificationResult(result, {
    autoResumeState: "stopped-no-progress",
    autoSegmentIndex,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  }, false);
  return;
}
segmentStartMarker = null;
recoveredFromScanning = false;
```

When `progressed` is false but `recoveredFromScanning` is true, allow the next `runSegment` because it resets the now-finalized old segment; do not increment `autoSegmentIndex` for that normalization call. A later identical marker has `recoveredFromScanning: false` and stops.

Replace Task 4's unconditional increment with:

```ts
if (progressed) autoSegmentIndex += 1;
```

- [ ] **Step 5: Keep cancellation sticky for the full chain**

Reuse one `AbortController` and one generation for start, every automatic resume, and the terminal publish. Immediately before the next `runSegment`, require:

```ts
const current = !this.disposed
  && this.scanController === controller
  && !controller.signal.aborted
  && generation === this.scanGeneration;
if (!current) return;
```

`cancelLargeVerification` aborts this controller even while the runtime is in `starting-next-segment`. `dispose` aborts it and increments the generation so late callbacks cannot emit.

- [ ] **Step 6: Enforce the 12-segment boundary before the thirteenth call**

Before incrementing or invoking the next segment, enforce:

```ts
if (autoSegmentIndex >= LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS) {
  await this.publishVerificationResult(result, {
    autoResumeState: "stopped-limit",
    autoSegmentIndex,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  }, false);
  return;
}
```

Leave the persisted checkpoint untouched. A later explicit resume starts a fresh chain with index 1.

- [ ] **Step 7: Run runtime and service safety regressions**

Run:

```bash
npx vitest run \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/unit/catalog/large-catalog-verification-service.test.ts \
  tests/unit/catalog/large-catalog-batch-contracts.test.ts
```

Expected: PASS, including existing restart-offline, cancellation, 501-directory, time-limit, and rate-limit cases.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/catalog/hybrid-catalog-runtime.ts tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/unit/catalog/large-catalog-batch-contracts.test.ts
git commit -m "fix(核验): 阻止自动续跑失控"
```

### Task 6: Render truthful three-layer progress and collapsed run details

**Files:**

- Create: `src/ui/verification-progress.ts`
- Create: `tests/ui/verification-progress.test.ts`
- Modify: `src/ui/verification-page.ts`
- Modify: `tests/ui/verification-page.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `styles.css`

- [ ] **Step 1: Write failing renderer tests for semantics and ARIA**

Create `tests/ui/verification-progress.test.ts` with a complete, path-free model and Chinese/English cases:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS } from "../../src/catalog/hybrid-catalog-types";
import { createWorkbenchI18n, type WorkbenchLocale } from "../../src/i18n/workbench-i18n";
import {
  renderVerificationProgress,
  type VerificationProgressModel,
} from "../../src/ui/verification-progress";

const progressModel = (locale: WorkbenchLocale): VerificationProgressModel => ({
  active: {
    importedAt: 1,
    pdfCount: 68_959,
    coveredCandidatePdfCount: 11_870,
    unverifiedCount: 57_089,
    verifiedCount: 10_000,
    differenceCount: 1_870,
    cloudMissingCount: 0,
    groupCount: 24,
    verifiedGroupCount: 7,
    groups: [],
  },
  batch: {
    batchId: "batch-progress",
    status: "scanning",
    stopReason: null,
    resumeAvailable: false,
    runOrdinal: 2,
    selectedGroupCount: 1,
    completedGroupCount: 0,
    remainingGroupCount: 1,
    currentGroupIndex: 0,
    currentGroupKey: `group:${"1".repeat(64)}`,
    pdfCount: 9_500,
    directoryCount: 120,
    ignoredFileCount: 3,
    listRequestCount: 27,
    cumulativeListRequestCount: 427,
    committedPdfCount: 11_870,
    committedPageCount: 14,
    completedDirectoryCount: 112,
    pendingDirectoryCount: 8,
    autoResumeState: "running",
    autoSegmentIndex: 2,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  },
  busy: true,
  currentGroupLabel: locale === "zh-CN" ? "文学" : "Literature",
  detailsOpen: false,
  i18n: createWorkbenchI18n(locale),
});

const render = (model: VerificationProgressModel): HTMLDivElement => {
  const root = document.createElement("div");
  root.append(renderVerificationProgress(document, model));
  return root;
};

describe("verification progress", () => {
  it.each([
    ["zh-CN", "云端总量尚未知", "本段安全配额"],
    ["en", "Cloud total is unknown", "This segment's safety quota"],
  ] as const)("renders truthful progress semantics in %s", (locale, unknownText, quotaText) => {
    const root = render(progressModel(locale));
expect(root.querySelector<HTMLProgressElement>(
  '[data-verification-overall-progress]',
)?.value).toBe(11_870);
expect(root.querySelector<HTMLProgressElement>(
  '[data-verification-overall-progress]',
)?.max).toBe(68_959);

const current = root.querySelector<HTMLElement>('[data-verification-current-progress]')!;
expect(current.getAttribute("role")).toBe("progressbar");
expect(current.hasAttribute("aria-valuenow")).toBe(false);
expect(current.hasAttribute("aria-valuemax")).toBe(false);
expect(root.textContent).toContain(unknownText);

const segment = root.querySelector<HTMLProgressElement>(
  '[data-verification-segment-budget]',
)!;
expect(segment.value).toBe(9_500);
expect(segment.max).toBe(10_000);
expect(root.textContent).toContain(quotaText);

const details = root.querySelector<HTMLDetailsElement>(
  'details[data-verification-run-details]',
)!;
expect(details.open).toBe(false);
expect(details.querySelector('[data-verification-run-requests]')?.textContent)
  .toContain("427");
expect(details.querySelector('[data-verification-run-queue]')?.textContent)
  .toContain("8");
  });

  it("clamps invalid coverage without rendering fake numbers", () => {
    const base = progressModel("en");
    const root = render({
      ...base,
      active: { ...base.active, pdfCount: 0, coveredCandidatePdfCount: 99 },
    });
    const progress = root.querySelector<HTMLProgressElement>(
      '[data-verification-overall-progress]',
    )!;
    expect(progress.value).toBe(0);
    expect(progress.value).toBeLessThanOrEqual(progress.max);
    expect(root.textContent).not.toMatch(/NaN|Infinity|-\d/u);
  });
});
```

In `tests/ui/verification-page.test.ts`, import `LargeCatalogBatchSummary` and add an action-state case using the existing `active` and `model` helpers:

```ts
it("shows only pause while the automatic chain is running and resume after its limit", () => {
  const runningBatch: LargeCatalogBatchSummary = {
    batchId: "batch-actions",
    status: "scanning",
    stopReason: null,
    resumeAvailable: false,
    runOrdinal: 2,
    selectedGroupCount: 1,
    completedGroupCount: 0,
    remainingGroupCount: 1,
    currentGroupIndex: 0,
    currentGroupKey: GROUP_KEY,
    pdfCount: 200,
    directoryCount: 2,
    ignoredFileCount: 0,
    listRequestCount: 1,
    cumulativeListRequestCount: 428,
    committedPdfCount: 12_070,
    committedPageCount: 15,
    completedDirectoryCount: 113,
    pendingDirectoryCount: 7,
    autoResumeState: "running",
    autoSegmentIndex: 2,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  };
  const root = testRoot();
  renderVerificationPage(root, model({ status: "scanning", active, batch: runningBatch }));
  expect(root.querySelector('[data-action="resume-verification"]')).toBeNull();
  expect(root.querySelector('[data-action="cancel-verification"]')?.textContent)
    .toBe("暂停核验");

  renderVerificationPage(root, model({
    status: "paused",
    active,
    batch: {
      ...runningBatch,
      status: "paused",
      stopReason: "pdf-limit",
      resumeAvailable: true,
      autoResumeState: "stopped-limit",
      autoSegmentIndex: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
    },
  }));
  expect(root.querySelector('[data-action="resume-verification"]')).not.toBeNull();
  expect(root.textContent).toContain("已达到 12 段自动续跑安全上限");
});
```

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
npx vitest run tests/ui/verification-progress.test.ts tests/ui/verification-page.test.ts
```

Expected: FAIL because the renderer and data attributes do not exist.

- [ ] **Step 3: Implement the focused renderer**

Create `src/ui/verification-progress.ts` with one exported function:

```ts
import {
  LARGE_CATALOG_RUN_BUDGET,
} from "../catalog/hybrid-catalog-types";
import type {
  HybridCatalogActiveSummary,
  LargeCatalogBatchSummary,
} from "../catalog/hybrid-catalog-runtime";
import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";
import { presentCatalogStopReason } from "./catalog-stop-reason-presenter";

const boundedCount = (value: number): number => Number.isFinite(value)
  ? Math.max(0, value)
  : 0;

export interface VerificationProgressModel {
  readonly active: HybridCatalogActiveSummary;
  readonly batch: LargeCatalogBatchSummary;
  readonly busy: boolean;
  readonly currentGroupLabel: string | null;
  readonly detailsOpen: boolean;
  readonly i18n: WorkbenchI18n;
}

export const renderVerificationProgress = (
  doc: Document,
  model: VerificationProgressModel,
): HTMLElement => {
  const section = doc.createElement("section");
  section.className = "knowledge-workbench__verification-progress";

  const overall = doc.createElement("progress");
  overall.dataset.verificationOverallProgress = "true";
  const overallTotal = boundedCount(model.active.pdfCount);
  overall.max = Math.max(1, overallTotal);
  overall.value = Math.min(overallTotal, boundedCount(model.active.coveredCandidatePdfCount));

  const current = doc.createElement("div");
  current.dataset.verificationCurrentProgress = "true";
  current.setAttribute("role", "progressbar");
  current.setAttribute("aria-label", model.i18n.t("verification.progress.current.aria"));

  const segment = doc.createElement("progress");
  segment.dataset.verificationSegmentBudget = "true";
  segment.max = LARGE_CATALOG_RUN_BUDGET.maxPdfCount;
  segment.value = Math.min(segment.max, boundedCount(model.batch.pdfCount));

  const details = doc.createElement("details");
  details.dataset.verificationRunDetails = "true";
  details.open = model.detailsOpen;
  const summary = doc.createElement("summary");
  summary.dataset.focusKey = "verification-run-details";
  summary.textContent = model.i18n.t("verification.details.title");
  details.append(summary, renderRunMetrics(doc, model));

  section.append(
    renderOverallCard(doc, model, overall),
    renderCurrentCard(doc, model, current),
    renderSegmentCard(doc, model, segment),
    renderAutoState(doc, model),
    details,
  );
  return section;
};
```

Implement the helpers in the same file with these exact responsibilities:

```ts
const progressCard = (
  doc: Document,
  titleText: string,
  valueText: string,
  progress: HTMLElement,
  hintText?: string,
): HTMLElement => {
  const card = doc.createElement("article");
  card.className = "knowledge-workbench__verification-progress-card";
  const row = doc.createElement("div");
  row.className = "knowledge-workbench__verification-progress-heading";
  const title = doc.createElement("h3");
  title.textContent = titleText;
  const value = doc.createElement("span");
  value.textContent = valueText;
  row.append(title, value);
  card.append(row, progress);
  if (hintText !== undefined) {
    const hint = doc.createElement("p");
    hint.className = "knowledge-workbench__verification-progress-hint";
    hint.textContent = hintText;
    card.append(hint);
  }
  return card;
};

const renderOverallCard = (
  doc: Document,
  model: VerificationProgressModel,
  progress: HTMLProgressElement,
): HTMLElement => {
  const total = boundedCount(model.active.pdfCount);
  const covered = Math.min(total, boundedCount(model.active.coveredCandidatePdfCount));
  const percent = total === 0 ? 0 : Math.min(100, Math.round((covered / total) * 1_000) / 10);
  const title = model.i18n.t("verification.progress.overall.title");
  progress.setAttribute("aria-label", title);
  return progressCard(doc, title, model.i18n.t("verification.progress.overall.value", {
    percent: model.i18n.number(percent),
    covered: model.i18n.number(covered),
    total: model.i18n.number(total),
    completed: model.i18n.number(model.active.verifiedGroupCount),
    groups: model.i18n.number(model.active.groupCount),
  }), progress);
};

const renderCurrentCard = (
  doc: Document,
  model: VerificationProgressModel,
  progress: HTMLElement,
): HTMLElement => {
  progress.className = "knowledge-workbench__verification-current-indicator";
  progress.classList.toggle("is-running", model.busy);
  const label = model.currentGroupLabel ?? model.i18n.t("progress.empty");
  return progressCard(doc,
    model.i18n.t("verification.progress.current.title", {
      label,
      segment: model.i18n.number(model.batch.runOrdinal),
    }),
    model.i18n.t(BATCH_STATUS_KEYS[model.batch.status]),
    progress,
    model.i18n.t("verification.progress.current.unknown"),
  );
};

const BATCH_STATUS_KEYS: Readonly<Record<LargeCatalogBatchSummary["status"], WorkbenchMessageKey>> = {
  scanning: "settings.status.scanning",
  paused: "settings.status.paused",
  partial: "settings.status.partial",
  complete: "settings.status.complete",
};

const renderSegmentCard = (
  doc: Document,
  model: VerificationProgressModel,
  progress: HTMLProgressElement,
): HTMLElement => {
  const title = model.i18n.t("verification.progress.segment.title");
  progress.setAttribute("aria-label", title);
  return progressCard(doc, title, model.i18n.t("verification.progress.segment.value", {
    current: model.i18n.number(progress.value),
    maximum: model.i18n.number(progress.max),
  }), progress);
};

const AUTO_STATE_KEYS = {
  inactive: "verification.auto.inactive",
  running: "verification.auto.running",
  "starting-next-segment": "verification.auto.next",
  "stopped-no-progress": "verification.auto.noProgress",
  "stopped-limit": "verification.auto.limit",
} as const;

const renderAutoState = (doc: Document, model: VerificationProgressModel): HTMLElement => {
  const state = doc.createElement("p");
  state.className = "knowledge-workbench__verification-auto-state";
  state.setAttribute("role", "status");
  state.textContent = model.i18n.t(AUTO_STATE_KEYS[model.batch.autoResumeState], {
    current: model.i18n.number(model.batch.autoSegmentIndex),
    maximum: model.i18n.number(model.batch.autoSegmentLimit),
  });
  return state;
};

const appendMetric = (
  doc: Document,
  list: HTMLDListElement,
  label: string,
  value: string,
  dataKey?: "requests" | "queue" | "stop",
): void => {
  const term = doc.createElement("dt");
  term.textContent = label;
  const description = doc.createElement("dd");
  description.textContent = value;
  if (dataKey === "requests") description.dataset.verificationRunRequests = "true";
  if (dataKey === "queue") description.dataset.verificationRunQueue = "true";
  if (dataKey === "stop") description.dataset.verificationRunStop = "true";
  list.append(term, description);
};

const renderRunMetrics = (doc: Document, model: VerificationProgressModel): HTMLElement => {
  const list = doc.createElement("dl");
  appendMetric(doc, list, model.i18n.t("verification.details.segment"), model.i18n.t("verification.details.segmentValue", {
    current: model.i18n.number(model.batch.autoSegmentIndex),
    maximum: model.i18n.number(model.batch.autoSegmentLimit),
  }));
  appendMetric(doc, list, model.i18n.t("verification.details.requests"), model.i18n.t("verification.details.requestsValue", {
    current: model.i18n.number(model.batch.listRequestCount),
    maximum: model.i18n.number(LARGE_CATALOG_RUN_BUDGET.maxListRequestCount),
    cumulative: model.i18n.number(model.batch.cumulativeListRequestCount),
  }), "requests");
  appendMetric(doc, list, model.i18n.t("verification.details.segmentPdfs"), model.i18n.number(model.batch.pdfCount));
  appendMetric(doc, list, model.i18n.t("verification.details.segmentDirectories"), model.i18n.t("verification.details.segmentDirectoriesValue", {
    current: model.i18n.number(model.batch.directoryCount),
    maximum: model.i18n.number(LARGE_CATALOG_RUN_BUDGET.maxDirectoryCount),
  }));
  appendMetric(doc, list, model.i18n.t("verification.details.timeBudget"), model.i18n.t("verification.details.timeBudgetValue", {
    minutes: model.i18n.number(LARGE_CATALOG_RUN_BUDGET.maxDurationMs / 60_000),
  }));
  appendMetric(doc, list, model.i18n.t("verification.details.ignored"), model.i18n.number(model.batch.ignoredFileCount));
  appendMetric(doc, list, model.i18n.t("verification.details.committedPdfs"), model.i18n.number(model.batch.committedPdfCount));
  appendMetric(doc, list, model.i18n.t("verification.details.pages"), model.i18n.number(model.batch.committedPageCount));
  appendMetric(doc, list, model.i18n.t("verification.details.directories"), model.i18n.number(model.batch.completedDirectoryCount));
  appendMetric(doc, list, model.i18n.t("verification.details.queue"), model.i18n.number(model.batch.pendingDirectoryCount), "queue");
  appendMetric(doc, list, model.i18n.t("verification.details.groups"), `${model.i18n.number(model.batch.completedGroupCount)} / ${model.i18n.number(model.batch.selectedGroupCount)}`);
  appendMetric(doc, list, model.i18n.t("verification.details.stop"), model.batch.stopReason === null
    ? model.i18n.t("progress.empty")
    : presentCatalogStopReason(model.batch.stopReason, model.i18n), "stop");
  appendMetric(doc, list, model.i18n.t("verification.details.checkpoint"), model.i18n.t("verification.details.checkpointSaved"));
  return list;
};
```

The helpers accept only the typed model, use `textContent`, and never receive paths or raw errors.

- [ ] **Step 4: Add exact Chinese and English keys before page integration**

Add these exact entries to `en` and the matching `zhCN` record:

```ts
// en
"verification.progress.overall.title": "Whole-library verification coverage",
"verification.progress.overall.value": "{percent}% · {covered} / {total} candidates · {completed} / {groups} categories",
"verification.progress.current.title": "Verifying {label} · segment {segment}",
"verification.progress.current.unknown": "Cloud total is unknown while directories are still being discovered.",
"verification.progress.current.aria": "Current category verification activity; cloud total unknown",
"verification.progress.segment.title": "This segment's safety quota",
"verification.progress.segment.value": "{current} / {maximum} PDFs; this is a safety quota, not completion.",
"verification.auto.inactive": "Automatic continuation is not active.",
"verification.auto.running": "Automatic continuation is running · segment {current} / {maximum}",
"verification.auto.next": "Checkpoint saved; starting the next segment.",
"verification.auto.noProgress": "Automatic continuation stopped because no durable progress was made.",
"verification.auto.limit": "Automatic continuation stopped at the {maximum}-segment safety limit.",
"verification.details.title": "Run details",
"verification.details.segment": "Automatic segment",
"verification.details.segmentValue": "{current} / {maximum}",
"verification.details.requests": "List requests",
"verification.details.requestsValue": "{current} / {maximum} this segment · {cumulative} cumulative",
"verification.details.segmentPdfs": "PDFs in this segment",
"verification.details.segmentDirectories": "Directories discovered in this segment",
"verification.details.segmentDirectoriesValue": "{current} / {maximum}",
"verification.details.timeBudget": "Time budget",
"verification.details.timeBudgetValue": "{minutes} minutes per segment",
"verification.details.ignored": "Ignored files in this segment",
"verification.details.committedPdfs": "Committed PDFs in this batch",
"verification.details.pages": "Committed pages",
"verification.details.directories": "Completed directories",
"verification.details.queue": "Pending directory queue",
"verification.details.groups": "Completed / selected categories",
"verification.details.stop": "Stop reason",
"verification.details.checkpoint": "Checkpoint state",
"verification.details.checkpointSaved": "Saved",
"verification.action.pause": "Pause verification",
"settings.surface.batchQueue": "Pending directory queue: {count}",
"settings.surface.batchStop": "Stop reason: {reason}",

// zhCN
"verification.progress.overall.title": "全库核验覆盖率",
"verification.progress.overall.value": "{percent}% · {covered} / {total} 个候选项 · {completed} / {groups} 个分类",
"verification.progress.current.title": "正在核验：{label} · 第 {segment} 段",
"verification.progress.current.unknown": "云端总量尚未知，正在递归发现目录",
"verification.progress.current.aria": "当前分类核验活动；云端总量未知",
"verification.progress.segment.title": "本段安全配额",
"verification.progress.segment.value": "{current} / {maximum} 个 PDF；这是安全配额，不是完成度。",
"verification.auto.inactive": "当前未自动续跑。",
"verification.auto.running": "正在自动续跑 · 第 {current} / {maximum} 段",
"verification.auto.next": "检查点已保存，正在开始下一段。",
"verification.auto.noProgress": "因没有持久进展，已停止自动续跑。",
"verification.auto.limit": "已达到 {maximum} 段自动续跑安全上限。",
"verification.details.title": "运行详情",
"verification.details.segment": "自动片段",
"verification.details.segmentValue": "{current} / {maximum}",
"verification.details.requests": "列表请求",
"verification.details.requestsValue": "本段 {current} / {maximum} · 累计 {cumulative}",
"verification.details.segmentPdfs": "本段 PDF",
"verification.details.segmentDirectories": "本段发现目录",
"verification.details.segmentDirectoriesValue": "{current} / {maximum}",
"verification.details.timeBudget": "时间预算",
"verification.details.timeBudgetValue": "每段 {minutes} 分钟",
"verification.details.ignored": "本段忽略文件",
"verification.details.committedPdfs": "批次累计已提交 PDF",
"verification.details.pages": "已提交页面",
"verification.details.directories": "已完成目录",
"verification.details.queue": "待处理目录队列",
"verification.details.groups": "已完成 / 已选择分类",
"verification.details.stop": "停止原因",
"verification.details.checkpoint": "检查点状态",
"verification.details.checkpointSaved": "已保存",
"verification.action.pause": "暂停核验",
"settings.surface.batchQueue": "待处理目录队列：{count}",
"settings.surface.batchStop": "停止原因：{reason}",
```

Add a paired-key assertion for every new key in `tests/unit/i18n/workbench-i18n.test.ts`; do not fall back to English in the Chinese dictionary.

- [ ] **Step 5: Replace the old flat batch paragraphs in `verification-page.ts`**

Add `readonly runDetailsOpen?: boolean` to `VerificationPageModel`. Remove the old `verification.batch.counts`/`verification.batch.requests` block. When both `active` and `batch` exist, derive the label by group key and append the focused renderer:

```ts
const currentGroupLabel = active.groups.find(
  (group) => group.groupKey === batch.currentGroupKey,
)?.label ?? null;
root.append(renderVerificationProgress(doc, {
  active,
  batch,
  busy,
  currentGroupLabel,
  detailsOpen: model.runDetailsOpen ?? false,
  i18n,
}));
```

Change the running action label with `cancel.textContent = i18n.t("verification.action.pause")`. Budget auto-continuation states must not show a manual resume button while `busy` is true. Preserve existing start/root/category validation and fixed error messages.

- [ ] **Step 6: Add theme-aware and reduced-motion styles**

Append these theme-aware rules to `styles.css`; keep the cards single-column under 760px and avoid fixed colors:

```css
.knowledge-workbench__verification-progress {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--size-4-3);
  margin-block: var(--size-4-4);
}

.knowledge-workbench__verification-progress-card,
.knowledge-workbench__verification-auto-state,
.knowledge-workbench__verification-progress details {
  padding: var(--size-4-3);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}

.knowledge-workbench__verification-progress-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--size-4-2);
}

.knowledge-workbench__verification-progress-heading h3,
.knowledge-workbench__verification-progress-heading span,
.knowledge-workbench__verification-progress-hint,
.knowledge-workbench__verification-auto-state {
  margin: 0;
}

.knowledge-workbench__verification-progress-heading span,
.knowledge-workbench__verification-progress-hint {
  color: var(--text-muted);
}

.knowledge-workbench__verification-progress progress,
.knowledge-workbench__verification-current-indicator {
  width: 100%;
  height: var(--size-4-2);
  margin-block-start: var(--size-4-2);
  overflow: hidden;
  border: 0;
  border-radius: var(--radius-s);
  background: var(--background-modifier-border);
}

.knowledge-workbench__verification-progress progress::-webkit-progress-bar {
  background: var(--background-modifier-border);
}

.knowledge-workbench__verification-progress progress::-webkit-progress-value,
.knowledge-workbench__verification-progress progress::-moz-progress-bar {
  background: var(--interactive-accent);
}

.knowledge-workbench__verification-current-indicator {
  position: relative;
}

.knowledge-workbench__verification-current-indicator.is-running::after {
  position: absolute;
  inset-block: 0;
  width: 34%;
  border-radius: inherit;
  background: var(--interactive-accent);
  content: "";
  animation: knowledge-workbench-verification-activity 1.4s ease-in-out infinite;
}

.knowledge-workbench__verification-auto-state {
  grid-column: 1 / -1;
  border-inline-start: var(--size-4-1) solid var(--text-success);
}

.knowledge-workbench__verification-progress details {
  grid-column: 1 / -1;
}

.knowledge-workbench__verification-progress details > summary {
  cursor: pointer;
  font-weight: var(--font-semibold);
}

.knowledge-workbench__verification-progress dl {
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) minmax(0, 1fr);
  gap: var(--size-4-1) var(--size-4-3);
  margin-block-end: 0;
}

.knowledge-workbench__verification-progress dt {
  color: var(--text-muted);
}

.knowledge-workbench__verification-progress dd {
  margin: 0;
  text-align: end;
}

@keyframes knowledge-workbench-verification-activity {
  from { transform: translateX(-110%); }
  to { transform: translateX(300%); }
}

@media (max-width: 760px) {
  .knowledge-workbench__verification-progress {
    grid-template-columns: minmax(0, 1fr);
  }

  .knowledge-workbench__verification-progress-card,
  .knowledge-workbench__verification-auto-state,
  .knowledge-workbench__verification-progress details {
    grid-column: 1;
  }

  .knowledge-workbench__verification-progress dl {
    grid-template-columns: minmax(0, 1fr);
  }

  .knowledge-workbench__verification-progress dd {
    text-align: start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .knowledge-workbench__verification-current-indicator::after {
    animation: none;
    transform: none;
  }
}
```

- [ ] **Step 7: Run focused UI and i18n tests**

Run:

```bash
npx vitest run tests/ui/verification-progress.test.ts tests/ui/verification-page.test.ts tests/unit/i18n/workbench-i18n.test.ts
```

Expected: PASS in both locales; the current activity has no numeric ARIA value and the segment quota does.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/ui/verification-progress.ts tests/ui/verification-progress.test.ts \
  src/ui/verification-page.ts tests/ui/verification-page.test.ts \
  src/i18n/workbench-i18n.ts tests/unit/i18n/workbench-i18n.test.ts styles.css
git commit -m "feat(界面): 展示三层核验进度"
```

### Task 7: Preserve details/focus and simplify Settings

**Files:**

- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `src/ui/settings-sections.ts`
- Modify: `tests/ui/settings-sections.test.ts`

- [ ] **Step 1: Write failing workbench re-render tests**

Add this complete re-render case to `tests/ui/workbench-view.test.ts` (import `LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS` and `LargeCatalogBatchSummary`):

```ts
it("preserves verification details and focus while a new segment resets its quota", () => {
  const root = createTestDiv();
  document.body.append(root);
  const groupKey = `group:${"7".repeat(64)}`;
  const active = {
    importedAt: 1,
    pdfCount: 68_959,
    coveredCandidatePdfCount: 11_870,
    unverifiedCount: 57_089,
    verifiedCount: 10_000,
    differenceCount: 1_870,
    cloudMissingCount: 0,
    groupCount: 24,
    verifiedGroupCount: 7,
    groups: [{
      groupKey,
      label: "Literature",
      pdfCount: 252,
      mode: "recursive" as const,
      verificationStatus: "unverified" as const,
    }],
  };
  const batch = (
    overrides: Partial<LargeCatalogBatchSummary> = {},
  ): LargeCatalogBatchSummary => ({
    batchId: "batch-rerender",
    status: "scanning",
    stopReason: null,
    resumeAvailable: false,
    runOrdinal: 1,
    selectedGroupCount: 1,
    completedGroupCount: 0,
    remainingGroupCount: 1,
    currentGroupIndex: 0,
    currentGroupKey: groupKey,
    pdfCount: 9_500,
    directoryCount: 120,
    ignoredFileCount: 3,
    listRequestCount: 27,
    cumulativeListRequestCount: 427,
    committedPdfCount: 11_870,
    committedPageCount: 14,
    completedDirectoryCount: 112,
    pendingDirectoryCount: 8,
    autoResumeState: "running",
    autoSegmentIndex: 1,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
    ...overrides,
  });
  const firstModel = {
    ...populatedWorkbenchModel(),
    activeTab: "verification" as const,
    verificationRoot: "/Synthetic",
    selectedVerificationGroupKeys: [groupKey],
    catalogConnection: { status: "authorized" as const },
    hybridCatalog: { status: "scanning" as const, active, batch: batch() },
  };
  renderWorkbench(root, firstModel, noOpWorkbenchActions());
  const details = root.querySelector<HTMLDetailsElement>('[data-verification-run-details]')!;
  details.open = true;
  const summary = details.querySelector<HTMLElement>("summary")!;
  summary.focus();

  const nextSegmentModel = {
    ...firstModel,
    hybridCatalog: {
      status: "scanning" as const,
      active,
      batch: batch({
        runOrdinal: 2,
        pdfCount: 200,
        directoryCount: 2,
        ignoredFileCount: 0,
        listRequestCount: 1,
        cumulativeListRequestCount: 428,
        committedPdfCount: 12_070,
        committedPageCount: 15,
        completedDirectoryCount: 113,
        pendingDirectoryCount: 7,
        autoSegmentIndex: 2,
      }),
    },
  };
  renderWorkbench(root, nextSegmentModel, noOpWorkbenchActions());

  const rerendered = root.querySelector<HTMLDetailsElement>('[data-verification-run-details]')!;
  expect(rerendered.open).toBe(true);
  expect(document.activeElement).toBe(rerendered.querySelector("summary"));
  expect(rerendered.querySelector('[data-verification-run-requests]')?.textContent)
    .toContain("428");
  expect(root.querySelector<HTMLProgressElement>('[data-verification-segment-budget]')?.value)
    .toBe(200);
  expect(root.querySelector<HTMLProgressElement>('[data-verification-overall-progress]')?.value)
    .toBe(11_870);
  root.remove();
});
```

Add this settings test (the auto-chain limit import already exists after Task 4):

```ts
it("keeps status visible and folds verification counters", () => {
  const groupKey = `group:${"7".repeat(64)}`;
  const controller = connectedControllerFixture({
    hybridCatalog: () => ({
      status: "paused",
      active: {
        importedAt: 1,
        pdfCount: 68_959,
        coveredCandidatePdfCount: 11_870,
        unverifiedCount: 57_089,
        verifiedCount: 10_000,
        differenceCount: 1_870,
        cloudMissingCount: 0,
        groupCount: 24,
        verifiedGroupCount: 7,
        groups: [{
          groupKey,
          label: "Literature",
          pdfCount: 252,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
      batch: {
        batchId: "batch-settings-details",
        status: "paused",
        stopReason: "pdf-limit",
        resumeAvailable: true,
        runOrdinal: 2,
        selectedGroupCount: 1,
        completedGroupCount: 0,
        remainingGroupCount: 1,
        currentGroupIndex: 0,
        currentGroupKey: groupKey,
        pdfCount: 9_500,
        directoryCount: 120,
        ignoredFileCount: 3,
        listRequestCount: 27,
        cumulativeListRequestCount: 427,
        committedPdfCount: 11_870,
        committedPageCount: 14,
        completedDirectoryCount: 112,
        pendingDirectoryCount: 8,
        autoResumeState: "inactive",
        autoSegmentIndex: 0,
        autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
      },
    }),
  });
  const root = createTestDiv();
  createSettingsSectionsSurface({
    app: {} as App,
    controller,
    policy: NORMAL_RUNTIME_POLICY,
  }).render(root, "zh-CN");

expect(root.querySelector('[data-catalog-hybrid-batch-summary="true"]')?.textContent)
  .toContain("已暂停");
const details = root.querySelector<HTMLDetailsElement>(
  'details[data-settings-verification-details="true"]',
)!;
expect(details.open).toBe(false);
expect(details.querySelector('[data-catalog-hybrid-batch-requests="true"]')?.textContent)
  .toContain("427");
expect(details.querySelector('[data-catalog-hybrid-batch-queue="true"]')?.textContent)
  .toContain("8");
expect(details.querySelector('[data-catalog-hybrid-batch-stop="true"]')?.textContent)
  .toContain("达到 PDF 上限");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/ui/workbench-view.test.ts tests/ui/settings-sections.test.ts
```

Expected: FAIL because details state is lost on `replaceChildren` and settings counters are flat.

- [ ] **Step 3: Capture details state before workbench replacement**

At the top of `renderWorkbench`, before `disposeVerificationPage(root)`:

```ts
const verificationRunDetailsOpen = root.querySelector<HTMLDetailsElement>(
  "details[data-verification-run-details]",
)?.open ?? false;
```

Pass it as `runDetailsOpen` to `renderVerificationPage`. The existing `data-focus-key` capture and restore then restores the focused details summary after re-render.

- [ ] **Step 4: Fold settings technical counters**

Keep `batchSummary` visible. Create the queue/stop nodes next to the existing request/guidance nodes, then place all technical content in one details element:

```ts
const batchQueue = doc.createElement("p");
batchQueue.dataset.catalogHybridBatchQueue = "true";
const batchStop = doc.createElement("p");
batchStop.dataset.catalogHybridBatchStop = "true";
const verificationDetails = doc.createElement("details");
verificationDetails.dataset.settingsVerificationDetails = "true";
const verificationDetailsTitle = doc.createElement("summary");
verificationDetailsTitle.textContent = i18n.t("verification.details.title");
verificationDetails.append(
  verificationDetailsTitle,
  batchRequests,
  batchQueue,
  batchStop,
  batchGuidance,
);
```

In `renderHybrid`, update the new nodes from the current batch without rebuilding the details element:

```ts
batchQueue.textContent = i18n.t("settings.surface.batchQueue", {
  count: i18n.number(current?.batch?.pendingDirectoryCount ?? 0),
});
batchStop.textContent = i18n.t("settings.surface.batchStop", {
  reason: localizedStopReason(current?.batch?.stopReason),
});
```

Append `verificationDetails` where `batchRequests` and `batchGuidance` were previously appended directly. Keep it closed by default; because subscriptions update only its child text, user expansion state remains stable.

- [ ] **Step 5: Run workbench, settings, and controller regressions**

Run:

```bash
npx vitest run tests/ui/workbench-view.test.ts tests/ui/settings-sections.test.ts tests/ui/workbench-controller.test.ts
```

Expected: PASS. Runtime re-renders preserve current-page details/focus; switching away and back starts closed; settings actions and root gating remain unchanged.

- [ ] **Step 6: Commit Task 7**

```bash
git add src/ui/workbench-view.ts tests/ui/workbench-view.test.ts src/ui/settings-sections.ts tests/ui/settings-sections.test.ts
git commit -m "style(核验): 收拢运行详情并保留焦点"
```

### Task 8: Run full gates and close documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-08-26-category-verification-progress-auto-resume-design.md`

- [ ] **Step 1: Run every focused feature test together**

```bash
npx vitest run \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/large-catalog-verification-service.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/unit/catalog/local-hybrid-catalog-adapter.test.ts \
  tests/unit/catalog/unified-catalog-search-service.test.ts \
  tests/unit/catalog/large-catalog-batch-contracts.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/verification-progress.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/workbench-controller.test.ts
```

Expected: PASS with no real network, real TXT source, or real Vault fixture.

- [ ] **Step 2: Run static and full regression gates**

Run separately so failures are attributable:

```bash
npm run lint
npm test
npm run build
npm run build:acceptance
```

Expected: all commands exit 0. The acceptance bundle remains unable to construct OAuth, SecretStorage, Baidu list, cloud locator, or external catalog write capabilities.

- [ ] **Step 3: Inspect privacy, checkpoint, and bundle boundaries**

Run:

```bash
! rg -n "AppKey|SecretKey|authorization code|access_token|refresh_token|科学文库|医药卫生" \
  src/catalog/large-catalog-verification-progress.ts \
  src/ui/verification-progress.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/ui/verification-progress.test.ts

git diff --check
git status --short
```

Expected: no credential/token or real path leakage; only intended implementation files plus the 11 pre-existing untracked research files appear.

- [ ] **Step 4: Mark the design implemented only after the recorded gates pass**

Change the design status line to:

```markdown
- 状态：已实现；自动化回归、normal build 与 acceptance build 已通过；真实百度核验待单独授权
```

Do not claim a real Baidu scan, real Vault install, performance result, or live Obsidian proof.

- [ ] **Step 5: Commit Task 8**

```bash
git add docs/superpowers/specs/2026-08-26-category-verification-progress-auto-resume-design.md
git commit -m "docs(核验): 记录自动续跑验证结果"
```

- [ ] **Step 6: Inspect the final branch without installing it**

```bash
git log --oneline --decorate -10
git status --short
```

Expected: task commits are present; tracked worktree changes are clean; the unrelated research files remain untracked. Do not install into the real plugin directory or enable the plugin without a separate action-time authorization.

## Implementation completion boundary

This plan ends with a tested normal build and acceptance build in the repository. It does not install the normal artifact into a real Obsidian Vault, enable the plugin, run real OAuth, resume the existing real checkpoint, or issue a real Baidu list request. Those actions require a separate current-state review and explicit authorization.
