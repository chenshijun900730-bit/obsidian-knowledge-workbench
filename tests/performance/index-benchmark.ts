import { cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { ClassificationService } from "../../src/classification/classification-service";
import type { PluginDataPort } from "../../src/core/ports";
import type { DocumentRecord } from "../../src/core/types";
import { IncrementalIndexQueue } from "../../src/indexing/incremental-index-queue";
import { IndexService } from "../../src/indexing/index-service";
import { MapService } from "../../src/map/map-service";
import { RelationScorer } from "../../src/map/relation-scorer";
import { ChangePlanService } from "../../src/plans/change-plan-service";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import { SuggestionService } from "../../src/suggestions/suggestion-service";
import { TodayService } from "../../src/today/today-service";
import { WorkbenchController } from "../../src/ui/workbench-controller";
import { NORMAL_RUNTIME_POLICY } from "../../src/runtime/safety-policy";
import { createWorkbenchViewClass, type ItemViewConstructor } from "../../src/ui/workbench-view";
import { controllerFixture, manualProjectionScheduler } from "../helpers/ui-fixtures";
import type { WorkspaceLeaf } from "obsidian";
import type { GeneratedFixture } from "./generate-fixture";
import { JsonFilePluginDataPort } from "./json-file-plugin-data-port";

export interface BenchmarkResult {
  readonly noteCount: number;
  readonly totalBytes: number;
  readonly serializedPluginDataBytes: number;
  readonly elapsedMs: number;
  readonly persistenceTimesMs: readonly number[];
  readonly updateTimesMs: readonly number[];
  readonly peakHeapBytes: number;
  readonly scanSaveCount: number;
  readonly scanProgressCount: number;
  readonly activeRecordCount: number;
  readonly mapFocusElapsedMs: number;
  readonly mapScoreCallCount: number;
  readonly mapProgressCallbackCount: number;
  readonly mapNodeCount: number;
  readonly mapEdgeCount: number;
  readonly coalescedSaveCount: number;
  readonly incrementalQueueReturnTimesMs: readonly number[];
  readonly incrementalPersistenceTimesMs: readonly number[];
  readonly incrementalSaveCount: number;
  readonly projectionPendingTaskCountBeforeDrain: number;
  readonly projectionRebuildCountBeforeUpdates: number;
  readonly projectionRebuildCountBeforeDrain: number;
  readonly projectionRebuildCountAfterDrain: number;
  readonly coalescedProjectionRebuildCount: number;
  readonly projectedRecordCount: number;
  readonly projectionDrainElapsedMs: number;
  readonly projectionCallbackTimesMs: readonly number[];
  readonly projectionMaxSynchronousCallbackMs: number;
  readonly environment: { readonly node: string; readonly platform: string; readonly cpu: string };
}

export interface WorkbenchOpenResult {
  readonly recordCount: number;
  readonly openTimesMs: readonly number[];
}

export function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot calculate p95 of an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

class CountOnlyPluginDataPort implements PluginDataPort {
  saveCount = 0;
  load(): Promise<unknown> { return Promise.resolve(undefined); }
  save(_data: unknown): Promise<void> { this.saveCount += 1; return Promise.resolve(); }
}

class CompositePluginDataPort implements PluginDataPort {
  constructor(
    private readonly durable: JsonFilePluginDataPort,
    private readonly counter: CountOnlyPluginDataPort,
  ) {}
  load(): Promise<unknown> { return this.durable.load(); }
  async save(data: unknown): Promise<void> {
    await this.counter.save(data);
    await this.durable.save(data);
  }
}

class MeasuredSuggestionService extends SuggestionService {
  rebuildCount = 0;
  projectedRecordCount = 0;

  override generate(input: Parameters<SuggestionService["generate"]>[0]): ReturnType<SuggestionService["generate"]> {
    this.rebuildCount += 1;
    this.projectedRecordCount = input.records.length;
    return super.generate(input);
  }
}

class CountingRelationScorer extends RelationScorer {
  calls = 0;

  override score(left: DocumentRecord, right: DocumentRecord) {
    this.calls += 1;
    return super.score(left, right);
  }
}

const updateContent = (index: number, path: string): string => {
  const prefix = `# Sequential update ${index}\n\nSynthetic update for ${path}.\n`;
  const targetBytes = 64 * 1024;
  return `${prefix}${"u".repeat(Math.max(0, targetBytes - Buffer.byteLength(prefix)))}`;
};

export async function benchmarkIndex(fixture: GeneratedFixture): Promise<BenchmarkResult> {
  const durable = await JsonFilePluginDataPort.create();
  const counter = new CountOnlyPluginDataPort();
  let unsubscribeVault: (() => void) | null = null;
  let unsubscribeView: (() => void) | null = null;
  let controller: WorkbenchController | null = null;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  const sampleHeap = (): void => { peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed); };
  try {
    const store = new PluginDataStore(new CompositePluginDataPort(durable, counter));
    await store.load();
    let timestamp = 1;
    const index = new IndexService(fixture.vault, store, { now: () => timestamp++ });
    let progressed = 0;
    const startedAt = performance.now();
    await index.buildInitial(new AbortController().signal, () => {
      progressed += 1;
      if (progressed % 50 === 0) sampleHeap();
    });
    const elapsedMs = performance.now() - startedAt;
    sampleHeap();
    const activeRecords = index.activeRecords();
    const activeRecordCount = activeRecords.length;
    const mapCenter = activeRecords[0];
    if (mapCenter === undefined) throw new Error("Map benchmark requires at least one active record");
    const mapScorer = new CountingRelationScorer();
    let mapProgressCallbackCount = 0;
    const mapStartedAt = performance.now();
    const focusedMap = await new MapService(mapScorer, () => Promise.resolve()).focus({
      records: activeRecords,
      center: { kind: "document", id: mapCenter.id },
      filter: "all",
    }, new AbortController().signal, () => {
      mapProgressCallbackCount += 1;
    });
    const mapFocusElapsedMs = performance.now() - mapStartedAt;
    const mapScoreCallCount = mapScorer.calls;
    const mapNodeCount = focusedMap.nodes.length;
    const mapEdgeCount = focusedMap.edges.length;
    sampleHeap();
    const scanSaveCount = counter.saveCount;
    const persistenceTimesMs = [...durable.persistenceTimesMs];
    const serializedPluginDataBytes = durable.serializedPluginDataBytes;
    const files = await fixture.vault.listMarkdownFiles();
    const queue = new IncrementalIndexQueue(index);
    await queue.pauseAutoFlush();
    unsubscribeVault = fixture.vault.subscribe((event) => queue.enqueue(event));

    const scheduler = manualProjectionScheduler();
    const projectionCallbackTimesMs: number[] = [];
    const measuredScheduler = {
      now: () => scheduler.dependency.now(),
      schedule(callback: () => void, delayMs: number): unknown {
        return scheduler.dependency.schedule(() => {
          const callbackStartedAt = performance.now();
          try {
            callback();
          } finally {
            projectionCallbackTimesMs.push(performance.now() - callbackStartedAt);
          }
        }, delayMs);
      },
      cancel: (handle: unknown) => scheduler.dependency.cancel(handle),
    };
    const measuredSuggestions = new MeasuredSuggestionService();
    const clock = { now: () => timestamp++ };
    const changePlans = new ChangePlanService(fixture.vault, () => false);
    controller = new WorkbenchController({
      policy: NORMAL_RUNTIME_POLICY,
      reads: fixture.vault,
      index,
      indexQueue: queue,
      classification: new ClassificationService(),
      today: new TodayService(clock),
      map: new MapService(),
      suggestions: measuredSuggestions,
      changePlans,
      changePreview: {
        request: () => Promise.resolve(null),
        requestSample: () => Promise.resolve(false),
      },
      store,
      workspace: { openNote: () => Promise.resolve() },
      quickCapture: { capture: () => Promise.resolve(null) },
      transactions: {
        organizationWritesBlocked: () => false,
        execute: () => Promise.resolve({ status: "completed", journalId: "benchmark" }),
      },
      journal: {
        list: () => Promise.resolve([]),
        clearHistory: () => Promise.resolve(),
      },
      undo: { preview: () => Promise.reject(new Error("Undo is outside the performance benchmark")) },
      historyConfirmation: { request: () => Promise.resolve(false) },
      clock,
      projectionScheduler: measuredScheduler,
    });

    // Initial projection work and view subscription are setup, not incremental samples.
    controller.refreshSuggestions();
    unsubscribeView = controller.subscribe(() => undefined);
    const projectionRebuildCountBeforeUpdates = measuredSuggestions.rebuildCount;
    const incrementalPersistenceBaseline = durable.persistenceTimesMs.length;
    const incrementalSaveBaseline = durable.saveCount;
    const incrementalQueueReturnTimesMs: number[] = [];
    for (let update = 0; update < 100; update += 1) {
      const file = files[update % files.length]!;
      const started = performance.now();
      fixture.vault.modifyExternally(file.path, updateContent(update, file.path));
      await queue.flushForTest();
      incrementalQueueReturnTimesMs.push(performance.now() - started);
      sampleHeap();
    }

    const incrementalPersistenceTimesMs = durable.persistenceTimesMs.slice(incrementalPersistenceBaseline);
    const incrementalSaveCount = durable.saveCount - incrementalSaveBaseline;
    const projectionPendingTaskCountBeforeDrain = scheduler.pendingCount;
    const projectionRebuildCountBeforeDrain = measuredSuggestions.rebuildCount;
    // The manual drain runs pending callbacks immediately, so this excludes the
    // scheduler's configured quiet/max-wait delays and measures drain/compute only.
    const projectionDrainStartedAt = performance.now();
    scheduler.drain();
    const projectionDrainElapsedMs = performance.now() - projectionDrainStartedAt;
    const projectionRebuildCountAfterDrain = measuredSuggestions.rebuildCount;
    const coalescedProjectionRebuildCount = projectionRebuildCountAfterDrain - projectionRebuildCountBeforeDrain;
    const projectedRecordCount = measuredSuggestions.projectedRecordCount;
    const projectionMaxSynchronousCallbackMs = Math.max(0, ...projectionCallbackTimesMs);

    // The following save-coalescing segment intentionally has no view consumer.
    unsubscribeView();
    unsubscribeView = null;
    const coalescedBaseline = durable.saveCount;
    for (let update = 0; update < 50; update += 1) {
      const file = files[update % files.length]!;
      fixture.vault.modifyExternally(file.path, updateContent(update + 100, file.path));
    }
    await queue.flushForTest();
    const coalescedSaveCount = durable.saveCount - coalescedBaseline;
    sampleHeap();
    return {
      noteCount: activeRecordCount,
      totalBytes: fixture.totalBytes,
      serializedPluginDataBytes,
      elapsedMs,
      persistenceTimesMs,
      updateTimesMs: incrementalQueueReturnTimesMs,
      peakHeapBytes,
      scanSaveCount,
      scanProgressCount: progressed,
      activeRecordCount,
      mapFocusElapsedMs,
      mapScoreCallCount,
      mapProgressCallbackCount,
      mapNodeCount,
      mapEdgeCount,
      coalescedSaveCount,
      incrementalQueueReturnTimesMs,
      incrementalPersistenceTimesMs,
      incrementalSaveCount,
      projectionPendingTaskCountBeforeDrain,
      projectionRebuildCountBeforeUpdates,
      projectionRebuildCountBeforeDrain,
      projectionRebuildCountAfterDrain,
      coalescedProjectionRebuildCount,
      projectedRecordCount,
      projectionDrainElapsedMs,
      projectionCallbackTimesMs,
      projectionMaxSynchronousCallbackMs,
      environment: {
        node: process.version,
        platform: platform(),
        cpu: cpus()[0]?.model ?? "unknown",
      },
    };
  } finally {
    unsubscribeVault?.();
    unsubscribeView?.();
    controller?.dispose();
    await durable.dispose();
  }
}

export async function benchmarkWorkbenchOpen(
  records: readonly DocumentRecord[],
  samples = 20,
): Promise<WorkbenchOpenResult> {
  if (!Number.isInteger(samples) || samples <= 0) throw new RangeError("samples must be a positive integer");
  const fixture = controllerFixture({ activeIndex: true, records });
  class ItemViewSurface {
    readonly contentEl = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  }
  const WorkbenchView = createWorkbenchViewClass(
    ItemViewSurface as unknown as ItemViewConstructor,
    NORMAL_RUNTIME_POLICY,
  );
  const openOnce = async (): Promise<number> => {
    const startedAt = performance.now();
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();
    const elapsed = performance.now() - startedAt;
    await view.onClose();
    view.contentEl.remove();
    return elapsed;
  };
  try {
    await openOnce();
    const openTimesMs: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) openTimesMs.push(await openOnce());
    return { recordCount: fixture.index.activeRecords().length, openTimesMs };
  } finally {
    fixture.controller.dispose();
  }
}
