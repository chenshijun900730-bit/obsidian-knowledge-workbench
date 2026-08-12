# Scalable Focused Map Design

## Context

The dedicated 5,000-note Obsidian 1.12.7 acceptance vault exposed a focused-map bottleneck after the persistence hotfix passed. `MapService.focus()` first scores every eligible document pair, so 5,000 records require 12,497,500 relation-score calls even though the UI can display at most 50 nodes. It also reports every 500 scored pairs; `WorkbenchController` publishes every report, and the open view clones and rerenders the full model. A topic focus reached only 4,000 scored pairs before the acceptance run was canceled safely.

The original product contract remains binding: apply the kind filter before the cap, use an undirected positive-edge graph, expand by maximum crossing-edge score with stable path/ID tie-breaking, return every positive edge among selected nodes, expose confirmed/inferred reasons, cap at 50 nodes, and remain cancellable.

## Chosen approach: exact lazy frontier

Replace exhaustive graph construction with an exact lazy frontier.

1. Start with the selected document or topic in `selectedIds`.
2. Topic-member edges are known directly and enter the candidate set immediately.
3. Whenever a document first enters `selectedIds`, score it against every still-unselected eligible document. Do not score pairs whose endpoints are both unselected.
4. Select the best crossing candidate with the existing score, target path, target ID, and edge comparator.
5. Repeat until no crossing edge remains or the 50-node cap is reached.

This preserves the exhaustive traversal result. Before each selection, an edge can cross the selected boundary only if one endpoint is already selected. That edge was scored when its selected document endpoint entered the set, or it is a precomputed topic-member edge. Edges with two unselected endpoints cannot influence the current choice. Every document-document pair among the final selected nodes is also present because the earlier-selected endpoint scored the later-selected endpoint before it entered the set.

At 5,000 records and a 50-node cap, document-center scoring falls from 12,497,500 calls to at most `50 × N - 1,275`: 248,725 calls. A topic center can admit at most 49 documents, so its corresponding bound is 243,775 calls. The final selected document still scores its frontier so `truncated` remains exact. The candidate scan remains deterministic and bounded by the focus cap; a heap can replace it later if profiling shows a need.

## Cancellation and progress

`MapService` keeps its existing 500-pair checkpoint. At each checkpoint it reports the real number of relation-score calls, yields to the event loop, and then rechecks the abort signal. Existing cancellation semantics and tests remain valid.

`WorkbenchController` separates computation checkpoints from UI publication. It remembers the latest pair count for the owned map request, publishes the first checkpoint, then publishes only when at least 50,000 additional pairs have been scored. Completion always stores the latest observed count, even if the last checkpoint was not published. Stale map generations never publish progress or results.

This keeps the Cancel control responsive while avoiding hundreds of full snapshot/rerender cycles. It does not change map data, filters, relation reasons, or write permissions.

## Tests and evidence

TDD must prove:

- A 500-record high-connectivity fixture uses no more than 50 × 500 relation-score calls, while the old exhaustive implementation exceeds that bound.
- Lazy focus returns the same nodes, edges, details, truncation, and stable ordering as a small exhaustive reference across document centers, topic centers, filters, disconnected components, and tie cases.
- Existing 500-pair cancellation and asynchronous abort tests remain green.
- Controller progress emits at the first checkpoint and then at 50,000-pair deltas, suppresses intermediate view notifications, and commits the latest count on completion.
- A supported-Node 5,000-record performance test records score-call count, progress-callback count, elapsed time, 50-node cap, and cancellation ownership. The generic automated fixture has shared synthetic tags but no confirmed Workbench kind/topic fields, so note/reference/topic product evidence belongs only to the dedicated host fixture. Wall time is evidence; the deterministic score-call bound is the primary regression gate.
- The isolated Obsidian acceptance reruns a searchable document/topic focus with the Workbench view open and records the end-to-end topic-discovery task. It must complete within 180 seconds or remain failed/pending; no result is fabricated.

## Scope and safety

Production changes are limited to `src/map/map-service.ts` and the map-progress callback in `src/ui/workbench-controller.ts`. Tests may change `tests/unit/map/map-service.test.ts`, `tests/ui/workbench-view.test.ts`, and Task 13 performance support. No indexing, persistence, suggestion, transaction, installer, AI, credential, or real-vault path changes are allowed. Map work remains read-only and locally computed.
