# Scalable Focused Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the exact 50-node focused-map traversal while avoiding all-pairs scoring and excessive Workbench rerenders at 5,000 records.

**Architecture:** `MapService` scores only the selected-to-unselected frontier and reuses the existing deterministic crossing-edge comparator. The controller receives every cancellable 500-pair checkpoint but publishes only the first and each additional 50,000-pair milestone, then commits the latest count with the final map.

**Tech Stack:** TypeScript 5.8, Vitest, existing `RelationScorer`, `MapService`, `WorkbenchController`, and the synthetic performance fixture.

---

### Task 1: Lock exactness and bounded work with RED tests

**Files:**

- Modify: `tests/unit/map/map-service.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`

- [x] **Step 1: Add a counting scorer regression**

Create a production-shaped scorer wrapper and 500 deterministic connected records. Focus from one document and assert the existing output contract plus a score-call bound:

```ts
class CountingScorer extends RelationScorer {
  calls = 0;
  override score(left: DocumentRecord, right: DocumentRecord) {
    this.calls += 1;
    return super.score(left, right);
  }
}

expect(map.nodes).toHaveLength(50);
expect(scorer.calls).toBeLessThanOrEqual(50 * records.length);
```

- [x] **Step 2: Add exact-output comparisons**

Implement an exhaustive reference helper inside the test file only. Compare lazy production output to the reference for small fixtures covering a document center with an indirect best edge, a topic center, a kind filter, equal-score path ties, and disconnected records. Compare the complete `FocusedMap`, not only node count.

- [x] **Step 3: Add controller progress-publication RED**

Use the paused map fixture and two listeners. After map start, send progress 500, 1,000, 50,000, and 50,500 synchronously. Assert that only 500 and 50,500 publish, a throwing listener does not block the healthy listener, and final resolution stores `completed: 50_500`.

- [x] **Step 4: Run RED**

Run:

```bash
npx vitest run tests/unit/map/map-service.test.ts tests/ui/workbench-view.test.ts
```

Expected: counting scorer exceeds 25,000 calls and rapid progress emits more notifications than allowed. Existing map outputs remain the reference baseline.

### Task 2: Implement exact lazy frontier and throttled UI progress

**Files:**

- Modify: `src/map/map-service.ts`
- Modify: `src/ui/workbench-controller.ts`
- Test: `tests/unit/map/map-service.test.ts`
- Test: `tests/ui/workbench-view.test.ts`

- [x] **Step 1: Replace exhaustive pair scoring with frontier scoring**

Keep `selectedIds`, positive `candidates`, and `scoredPairs`. When a document is selected, loop over sorted eligible unselected records, score each pair once, append positive edges, and retain the existing 500-pair report/yield/abort checkpoint.

- [x] **Step 2: Preserve the exact candidate comparator**

Choose the next crossing candidate by the current descending score, target path, target ID, and `compareEdges()` ordering. Add the chosen record, score its new frontier, and repeat. Build `truncated`, final selected edges, and details with the same existing functions and sort order.

- [x] **Step 3: Throttle only controller publication**

Inside each owned `runMap`, track `latestCompleted` and `lastPublishedCompleted`. Publish the first checkpoint and later checkpoints only when the difference is at least 50,000. On success/cancel/error, retain the latest completed count in `mapProgress`; do not let stale generations publish.

- [x] **Step 4: Run focused and full GREEN**

Run:

```bash
npx vitest run tests/unit/map/map-service.test.ts tests/ui/workbench-view.test.ts
npm run verify
npm run test:coverage
```

Expected: all tests pass; coverage remains above statements/functions/lines 85% and branches 80%.

### Task 3: Add release and host evidence

**Files:**

- Modify: `tests/performance/index-benchmark.ts`
- Modify: `tests/performance/index.bench.test.ts`
- Modify: `README.md`
- Modify: `.superpowers/sdd/task-13-report.md`
- Modify: `.dev-vault/acceptance.json` (ignored evidence only)

- [x] **Step 1: Extend the existing single performance run**

Reuse the generated 5,000-record index; do not create another 75 MiB fixture. Focus a document with a counting scorer and no view listener. Report `mapFocusElapsedMs`, `mapScoreCallCount`, `mapProgressCallbackCount`, and node/edge counts. The automated fixture does not carry confirmed Workbench kinds/topics; keep topic plus note/reference evidence in the dedicated host acceptance only.

- [x] **Step 2: Run supported-Node gates once**

Run:

```bash
npm run test:performance
```

Assert 5,000 projected records, at most 250,000 score calls, at most 50 nodes, and finite elapsed time. Treat elapsed time as report-only in automation; the host task owns the 180-second product gate.

- [x] **Step 3: Reinstall and rerun isolated host topic discovery**

Use only `.dev-vault/acceptance-vault`. With the Workbench view open, search/select a synthetic record or confirmed topic, wait for map completion, and verify selected details include a confirmed topic and supporting note/reference relationship. Record end-to-end elapsed time and require at most 180,000 ms.

- [x] **Step 4: Finish reviews and Task 13 gates**

Run fresh spec and safety reviews, Node 24 verify/coverage/performance, acceptance schema validation, Graphify update/status, and `git diff --check`. Do not commit or claim acceptance until every finding is resolved and the real host result is recorded honestly.

## Final evidence

- Node v24.14.0: `npm run verify` passed 28 files / 673 tests; coverage passed at 90.11% statements, 82.05% branches, 87.85% functions, and 94.23% lines.
- Serial performance suite: 7 / 7 passed. The shared 5,000-record fixture recorded 2,489.54 ms scan, 87.57 ms modify-to-queue-return p95, 21.89 ms temporary-persistence p95, 27.50 ms projection drain, and 1.465 ms Workbench-open p95 over 20 samples. Map focus recorded 944.66 ms, 248,725 score calls, 497 progress callbacks, 50 nodes, 1,225 edges, and 562,630,696 bytes observed peak heap.
- Dedicated Obsidian 1.12.7 host acceptance used only 5,000 synthetic notes: 27,024.2 ms cold scan; 111.7 ms modify-to-flush p95 over 100 samples including real `Plugin.saveData()`; report-only `Plugin.saveData()` p95 34.3 ms; zero projections during the updates and one at the freshness barrier.
- Host task evidence: next action 617.9 ms; confirmed topic discovery 48,409.9 ms with 50 nodes, 1,225 edges, topic, note, reference, and confirmed relation evidence. Background Electron timer throttling produced slower wall-time observations, so the score-call bound remains the primary automated release gate; the host result still passed the 180-second product threshold.
- Read-only preview was canceled with data unchanged. The authorized single rename, restart, History preview, and Undo restored the exact content and note count; write enablement was reset to disabled. Strict acceptance validation passed with `status: "passed"`.
- Independent final map and safety reviews were Approved. No real vault, endpoint, or credential was touched; nothing was published or deployed. No commit was created.
