# Deferred Projection Hotfix Design

## Context

The dedicated Obsidian 1.12.7 acceptance vault contains 5,000 generated Markdown notes and no real-vault content. In that host, one persisted incremental update takes about 117 ms at `Plugin.saveData()`, but `IncrementalIndexQueue.flushForTest()` takes about 3.35 seconds. Profiling shows that `IndexService.emit()` synchronously invokes `WorkbenchController.rebuildProjection()`, which recomputes classification, confirmed relations, suggestions, Today, search results, and defensive clones before the already-persisted queue call can return.

This hotfix is deliberately narrower than dependency-aware incremental projection. It separates durable indexing from derived UI work and coalesces bursts. It does not claim to remove the cost or main-thread blocking of one full 5,000-record projection.

## Chosen approach

Use a conservative full-projection dirty/revision model with a macrotask scheduler, explicit freshness barriers, and atomic projection commits.

Rejected alternatives:

- A per-record suggestion cache is unsafe in this task because duplicate groups, path collisions, confirmed-topic anchors, relation candidates, and stable global arbitration make suggestion output depend on more than the changed record.
- A Worker or chunked projector would improve responsiveness but requires a larger data-transfer and cancellation design. It belongs after Task 13.

## Scheduler contract

`WorkbenchDependencies` gains an optional projection scheduler with `now()`, `schedule(callback, delayMs)`, and `cancel(handle)`. The default uses `Date.now()`, `setTimeout`, and `clearTimeout`; Promise jobs and `queueMicrotask` are forbidden because they can run before the queue's `await applyEvents()` continuation.

An index notification performs only bounded work:

1. Increment `projectionRevision` and leave `projectedRevision` behind.
2. Immediately invalidate the AI selection generation.
3. Abort the current map calculation and advance its generation so stale results cannot publish.
4. If a view listener or selected map center exists, reset a 50 ms quiet timer and retain one 500 ms maximum-wait timer. Otherwise remain dirty without scheduling expensive work.

The timers coalesce bursts but guarantee eventual delivery while a consumer exists. Scheduler exceptions are isolated from the index subscriber and never turn a successful persisted index update into a queue failure.

## Projection consistency

`snapshot()` and `emit()` never materialize a dirty projection. A snapshot is always the last fully committed, internally coherent model, even when it is stale. `subscribe()` schedules pending work but does not compute synchronously.

Projection computation reads the target revision, computes records, classifications, suggestions, Today, and search results into local values, then replaces all projection fields and the view model together. A failure preserves the previous committed projection, keeps the revision dirty and retryable, and reports the fixed message `Workbench projection refresh failed` without leaking host errors.

If a synchronous re-entrant index publication occurs during computation, the captured revision is committed and the freshness barrier repeats until it reaches the latest revision. A scheduled callback detects a newer revision and leaves another coalesced refresh pending. Disposal cancels both timers, advances lifecycle ownership, and makes late callbacks no-ops.

## Freshness barriers

Commands that read records, classifications, or suggestions must materialize the latest projection before the read:

- `selectCenter`, `searchMap`, `previewSuggestionIds`, `folderRuleProposals`, `dismiss`, `recordFileOpen`, and the shared AI action entry.
- `refreshSuggestions` first marks a full refresh, then materializes it.
- A completed transaction, applied folder rules, an exclusion-policy reconcile, and the terminal initial-scan path materialize before reporting success so their existing completion semantics remain true.

`previewSuggestionIds` performs its recovery-lock and transaction-busy fast failures before the barrier. AI disabled/configuration/busy fast failures remain cheap, but any selection validation or target-suggestion lookup happens only after the barrier. Pin/open/settings-only UI state does not force an unrelated full projection unless it needs an updated Today model.

Old suggestions may remain visible during the short dirty window, but an old DOM action cannot execute them because preview and AI paths cross the barrier and reselect from the latest suggestion list. Transaction preconditions continue to provide the final write-time stale-state check.

## Map and AI fencing

Index dirtiness invalidates map and AI work immediately, rather than waiting for projection recomputation. The existing `AbortController` plus generation ownership prevents old map promises from publishing. AI ownership includes the projection revision (or an equivalent immediately incremented selection generation), so a preview, note read, or network response that spans an index change resolves to the local `action-invalidated` fallback and cannot update the UI.

After a scheduled projection commit, a selected center is refocused once against the latest records. Without a center, listeners receive one coalesced notification.

## Tests and evidence

TDD coverage must prove:

- A real `IndexService` + `IncrementalIndexQueue` flush resolves before a manually controlled projection scheduler drains.
- No listener and no center means no scheduled full projection; a freshness-barrier command still obtains current records.
- Many index notifications coalesce, a max-wait prevents starvation, re-entrant updates are not lost, and a scheduler exception does not reject indexing.
- Snapshots are old-but-coherent before drain and current after drain; projection failure is atomic and retryable.
- Stale suggestion preview, map work, and pending AI work cannot publish or execute after dirtiness.
- Disposal cancels timers and late callbacks have no effect.

Performance output must separate these measurements:

- persisted queue-return p95 for 100 sequential updates;
- projection-settled latency and maximum synchronous projection compute time;
- number of coalesced projection rebuilds.

The release report must say plainly that the hotfix decouples and coalesces full projection. A later dependency-aware projector or Worker/chunking pass is still required to eliminate the remaining single-projection main-thread pause.

## Safety and scope

Production changes are limited to `src/ui/workbench-controller.ts`. Test support and performance evidence may change the Task 13 fixture and benchmark files. No indexing, storage, transaction, suggestion, AI-client, installer, credential, or real-vault code is changed. All host verification remains inside the ignored, generated `.dev-vault/acceptance-vault`; no real endpoint or credential is used.
