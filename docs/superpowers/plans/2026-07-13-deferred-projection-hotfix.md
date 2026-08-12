# Deferred Projection Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a successfully persisted incremental index update return without synchronously paying for the 5,000-record Workbench projection, while preserving safe, current action semantics.

**Architecture:** `WorkbenchController` owns a revisioned dirty projection and an injectable macrotask scheduler. Index publications invalidate stale map/AI work immediately, while a quiet/max-wait pair coalesces atomic full projections; action entry points use explicit freshness barriers, and passive snapshots remain the last coherent commit.

**Tech Stack:** TypeScript 5.8, Obsidian 1.12.7 API, Vitest/jsdom, existing `IndexService`, `IncrementalIndexQueue`, and performance fixtures.

---

### Task 1: Lock scheduler and coherence behavior with RED tests

**Files:**

- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/integration/offline.test.ts`

- [ ] **Step 1: Add a production-shaped manual macrotask scheduler to the fixture**

Add a scheduler whose `schedule()` records due time and insertion order, whose returned opaque handle is cancellable, whose `advanceBy()` executes due callbacks outside the scheduler's internal queue mutation, and whose `drain()` advances through all due work. Expose counters and `pendingCount`; do not add test-only APIs to `WorkbenchController`.

```ts
export interface ManualProjectionScheduler {
  readonly dependency: NonNullable<WorkbenchDependencies["projectionScheduler"]>;
  readonly pendingCount: number;
  readonly scheduleCalls: number;
  advanceBy(milliseconds: number): void;
  drain(): void;
}
```

Extend `controllerFixture()` with `projectionScheduler`, `deferInitialProjection`, and projection-service call counters. Unless `deferInitialProjection` is true, call the real public `refreshSuggestions()` once after construction so existing tests retain a materialized initial model.

- [ ] **Step 2: Write minimal failing controller tests**

Add focused tests proving each externally visible behavior:

```ts
it("keeps snapshots coherent and coalesces index publications on a macrotask", () => {
  const scheduler = manualProjectionScheduler();
  const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
  const before = fixture.controller.snapshot();
  const notified = vi.fn();
  fixture.controller.subscribe(notified);
  fixture.index.publish([{ ...RECORDS[0]!, path: "Notes/Latest.md" }]);
  fixture.index.publish([{ ...RECORDS[0]!, path: "Notes/Newest.md" }]);
  expect(fixture.controller.snapshot()).toEqual(before);
  expect(notified).not.toHaveBeenCalled();
  scheduler.drain();
  expect(notified).toHaveBeenCalledTimes(1);
});
```

Separate tests cover: zero scheduling without listeners/center; quiet debounce plus 500 ms max-wait; synchronous re-entrant publication; projection-service failure preserving the previous snapshot and succeeding on a later barrier; a throwing scheduler not escaping `index.publish`; and disposal canceling all queued callbacks.

- [ ] **Step 3: Write failing freshness/fencing tests**

Cover stale suggestion preview returning without `changePlans.preview`, pending map results never publishing, and an AI request paused at payload confirmation resolving to `action-invalidated` immediately after an index publication. Each test must assert real controller output or collaborator calls, not the existence of a mock.

- [ ] **Step 4: Run RED and record the expected failures**

Run:

```bash
npx vitest run tests/ui/workbench-view.test.ts tests/integration/offline.test.ts
```

Expected: the new tests fail because `WorkbenchDependencies` has no projection scheduler and index publications still rebuild and notify synchronously. Existing tests may fail only where the new fixture intentionally opts into deferred initialization.

### Task 2: Implement the minimal revisioned deferred projector

**Files:**

- Modify: `src/ui/workbench-controller.ts`
- Test: `tests/ui/workbench-view.test.ts`
- Test: `tests/integration/offline.test.ts`

- [ ] **Step 1: Add the scheduler dependency and revision state**

Define a small scheduler interface and default without changing `src/main.ts`:

```ts
export interface WorkbenchProjectionScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const defaultProjectionScheduler: WorkbenchProjectionScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
```

Track `projectionRevision`, `projectedRevision`, quiet/max handles, the first-dirty timestamp, and a projection lifecycle token. The constructor starts dirty and subscribes with `markProjectionDirty()`; it does not rebuild synchronously.

- [ ] **Step 2: Implement dirty scheduling and cancellation**

`markProjectionDirty()` increments the revision, calls `invalidateAiSelection()`, aborts/increments map ownership, and schedules only when `listeners.size > 0 || center !== null`. `scheduleProjection()` resets the 50 ms quiet timer, creates at most one 500 ms max timer, and catches scheduler errors. `cancelProjectionSchedule()` cancels both owned handles. `subscribe()` schedules existing dirty work; `dispose()` cancels timers before clearing listeners.

- [ ] **Step 3: Make projection computation atomic and retryable**

Replace mutating `rebuildProjection()` with a local-value computation. Only after every dependency succeeds should it assign `records`, `classifications`, `suggestions`, and the cloned `model`. Advance `projectedRevision` to the captured revision. `ensureProjectionCurrent()` cancels pending timers and repeats for any re-entrant later revision; on failure it keeps the old projection, leaves the revision dirty, sets the fixed safe status message, and returns `false`.

- [ ] **Step 4: Add freshness barriers without pulling work into passive emits**

Keep `snapshot()` and `emit()` passive. Place a successful `ensureProjectionCurrent()` before the first projection read in `selectCenter`, `searchMap`, `previewSuggestionIds`, `folderRuleProposals`, `dismiss`, `recordFileOpen`, and `startAiAction`. Make `refreshSuggestions()` increment the full revision and ensure immediately. Replace existing direct rebuilds after completed transactions, folder-rule application, exclusion reconciliation, and initial-scan completion with explicit mark-and-ensure paths. Remove expensive rebuilds from settings-only methods that do not alter records/suggestions/Today.

- [ ] **Step 5: Run GREEN, then the full controller surface**

Run:

```bash
npx vitest run tests/ui/workbench-view.test.ts tests/integration/offline.test.ts tests/integration/confirmed-plan-flow.test.ts tests/ui/history-tab.test.ts
```

Expected: all selected tests pass with no warning or unhandled rejection.

### Task 3: Add a real queue-to-controller performance regression

**Files:**

- Modify: `tests/performance/index-benchmark.ts`
- Modify: `tests/performance/index.bench.test.ts`
- Modify: `tests/performance/workbench-open.bench.test.ts`
- Modify: `README.md`
- Modify: `.superpowers/sdd/task-13-report.md`

- [ ] **Step 1: Write a failing real-stack benchmark assertion**

Build `IndexService`, `IncrementalIndexQueue`, and `WorkbenchController` over the 5,000-record fixture with a manual scheduler. Perform sequential `vault.modify()` plus `flushForTest()` samples without draining projection work. Assert 100 successful saves, p95 at most 1,000 ms, one pending coalesced projection, and current index records. Then drain once and report projection-settled latency, maximum synchronous compute time, rebuild count, and final 5,000-record projection.

- [ ] **Step 2: Run benchmark RED**

Run with the supported release runtime:

```bash
npm run test:performance
```

Expected before Task 2 implementation: the queue/controller p95 exceeds 1,000 ms or no deferred scheduler is observable.

- [ ] **Step 3: Make benchmark wiring use the new scheduler**

Do not change indexing, queue, persistence, or suggestion production code. Keep the existing cold-scan and DOM-open gates; correct the workbench-open wording so it says DOM render over an already materialized controller. Print persistence-return and projection-settled metrics as distinct fields.

- [ ] **Step 4: Run all automated release gates**

Run separately:

```bash
npm run lint
npm test
npm run test:coverage
npm run build
npm run test:performance
git diff --check
graphify hook status
```

Expected: 100% pass, coverage remains above statements/functions/lines 85% and branches 80%, persistence p95 is at most 1,000 ms, and all projection metrics are printed without being mislabeled as fixed.

### Task 4: Re-run dedicated host acceptance and finish Task 13

**Files:**

- Modify: `.dev-vault/acceptance.json` (ignored, generated evidence only)
- Modify: `.superpowers/sdd/task-13-report.md` (ignored workflow evidence)
- Modify: `.superpowers/sdd/progress.md` (ignored workflow state)

- [ ] **Step 1: Rebuild and reinstall only into the guarded generated vault**

Use `scripts/install-dev.mjs` with `OBSIDIAN_DEV_VAULT=<worktree>/.dev-vault/acceptance-vault`. Verify only `main.js`, `manifest.json`, and `styles.css` are installed and hashes match. Do not access or install into the user's real vault.

- [ ] **Step 2: Repeat the clean 100-update host measurement**

In the isolated Obsidian profile, use 100 new synthetic files and measure `vault.modify()` to `indexQueue.flushForTest()` completion plus actual `Plugin.saveData()` calls. Do not run concurrent CDP evaluations. Then invoke one explicit freshness-barrier action and record projection settle/compute time separately.

- [ ] **Step 3: Complete read-only and synthetic write acceptance**

Verify Workbench opening, Today/map tasks, a non-executing preview, the single synthetic rename candidate, restart persistence, and Undo only inside the generated acceptance vault. Validate the exact acceptance schema with `npm run validate:acceptance`.

- [ ] **Step 4: Restore the desktop environment**

Stop the isolated Obsidian process, close automation sessions, reopen the user's normal Obsidian profile without selecting or modifying a real vault, and move the proven run-created empty `~/Documents/Obsidian Vault` to Trash after confirming it still contains only the welcome artifact.

- [ ] **Step 5: Obtain fresh reviews and create the Task 13 commit**

Run independent spec and safety reviews, stage only the authorized Task 13 and hotfix files, and commit after all findings are resolved:

```bash
git commit -m "test: add release and acceptance gates"
```

Do not skip hooks. After the commit, rerun verification/status and update Graphify where required. Present a separate real-vault read-only runbook, but wait for fresh explicit authorization before any real-vault installation or acceptance pass.
