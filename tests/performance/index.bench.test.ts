import { describe, expect, it } from "vitest";
import { generateSyntheticFixture } from "../../scripts/synthetic-note-fixture.mjs";
import { generateFixture } from "./generate-fixture";
import { benchmarkIndex, percentile95 } from "./index-benchmark";
import { JsonFilePluginDataPort } from "./json-file-plugin-data-port";

interface DeferredProjectionBenchmarkEvidence {
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
}

describe("deterministic performance support", () => {
  it("generates identical rich note metadata for the same seed", async () => {
    const first = generateFixture({ notes: 120, minimumBytes: 1024 * 1024, seed: 17 });
    const second = generateFixture({ notes: 120, minimumBytes: 1024 * 1024, seed: 17 });
    const firstFiles = await first.vault.listMarkdownFiles();
    const secondFiles = await second.vault.listMarkdownFiles();
    const firstNotes = await Promise.all(firstFiles.map((file) => first.vault.readNote(file.path)));
    const secondNotes = await Promise.all(secondFiles.map((file) => second.vault.readNote(file.path)));
    const shared = generateSyntheticFixture({ notes: 120, minimumBytes: 1024 * 1024, seed: 17 });

    expect(first.noteCount).toBe(120);
    expect(first.totalBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(first.totalBytes).toBe(second.totalBytes);
    expect(first.totalBytes).toBe(shared.totalBytes);
    expect(firstFiles).toEqual(secondFiles);
    expect(firstNotes).toEqual(secondNotes);
    expect(firstNotes).toEqual(shared.notes);
    expect(new Set(firstFiles.map((file) => file.path)).size).toBe(120);
    expect(firstNotes[0]?.headings[0]).toMatch(/\p{Script=Han}/u);
    expect(firstNotes[1]?.headings[0]).toMatch(/[A-Za-z]/u);
    expect(firstNotes[0]?.basename).toBe(firstNotes[19]?.basename);
    expect(firstNotes[24]?.outgoingLinks).toHaveLength(1);
    expect(firstNotes[99]?.content.startsWith("---\n")).toBe(true);
    expect(firstNotes[99]?.content.slice(4)).not.toContain("\n---\n");
  });

  it("calculates nearest-rank p95 and rejects an empty sample", () => {
    expect(percentile95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
    expect(() => percentile95([])).toThrow("Cannot calculate p95 of an empty sample");
  });

  it("keeps the prior JSON atomically visible when pre-rename injection fails", async () => {
    const port = await JsonFilePluginDataPort.create();
    try {
      await port.save({ version: 1 });
      port.failBeforeRenameOnce(new Error("injected pre-rename failure"));
      await expect(port.save({ version: 2 })).rejects.toThrow("injected pre-rename failure");
      await expect(port.load()).resolves.toEqual({ version: 1 });
      await expect(port.temporaryArtifactCount()).resolves.toBe(0);
      expect(port.saveCount).toBe(1);
    } finally {
      await port.dispose();
    }
  });

  it("reports the real queue-to-controller projection boundary from the completed index", async () => {
    const result = await benchmarkIndex(generateFixture({ notes: 20, minimumBytes: 256 * 1024, seed: 3 }));
    const evidence = result as typeof result & DeferredProjectionBenchmarkEvidence;

    expect(result).toMatchObject({ noteCount: 20, scanProgressCount: 20, activeRecordCount: 20 });
    expect.soft(evidence.incrementalQueueReturnTimesMs?.length).toBe(100);
    expect.soft(evidence.incrementalPersistenceTimesMs?.length).toBe(100);
    expect.soft(evidence.incrementalSaveCount).toBe(100);
    expect.soft((evidence.projectionPendingTaskCountBeforeDrain ?? 0) > 0).toBe(true);
    expect.soft(Number.isInteger(evidence.projectionRebuildCountBeforeUpdates)).toBe(true);
    expect.soft(evidence.projectionRebuildCountBeforeDrain).toBe(evidence.projectionRebuildCountBeforeUpdates);
    expect.soft(evidence.projectionRebuildCountAfterDrain - evidence.projectionRebuildCountBeforeDrain).toBe(1);
    expect.soft(evidence.coalescedProjectionRebuildCount).toBe(1);
    expect.soft(evidence.projectedRecordCount).toBe(20);
    expect.soft(result.mapScoreCallCount).toBeGreaterThan(0);
    expect.soft(result.mapProgressCallbackCount).toBe(Math.floor(result.mapScoreCallCount / 500));
    expect.soft(result.mapNodeCount).toBeLessThanOrEqual(20);
    expect.soft(result.mapEdgeCount).toBeLessThanOrEqual(190);
    expect.soft(Number.isFinite(result.mapFocusElapsedMs)).toBe(true);
    expect.soft(Number.isFinite(evidence.projectionDrainElapsedMs)).toBe(true);
    expect.soft(evidence).not.toHaveProperty("projectionSettleElapsedMs");
    expect.soft((evidence.projectionCallbackTimesMs?.length ?? 0) > 0).toBe(true);
    expect.soft(evidence.projectionCallbackTimesMs?.every((sample) => Number.isFinite(sample))).toBe(true);
    expect.soft(Number.isFinite(evidence.projectionMaxSynchronousCallbackMs)).toBe(true);
  });
});

describe("release performance evidence", () => {
  it("meets the 5000-note scan and incremental product gates", async () => {
    const fixture = generateFixture({ notes: 5_000, minimumBytes: 75 * 1024 * 1024, seed: 13 });
    const result = await benchmarkIndex(fixture);
    const report = {
      ...result,
      scanPersistenceP95Ms: percentile95(result.persistenceTimesMs),
      incrementalQueueReturnP95Ms: percentile95(result.incrementalQueueReturnTimesMs),
      incrementalPersistenceP95Ms: percentile95(result.incrementalPersistenceTimesMs),
      scanPersistenceSampleCount: result.persistenceTimesMs.length,
      incrementalQueueReturnSampleCount: result.incrementalQueueReturnTimesMs.length,
      incrementalPersistenceSampleCount: result.incrementalPersistenceTimesMs.length,
      automatedPersistenceScope: "PluginDataStore through a temporary JSON file with atomic rename; not Obsidian Plugin.saveData host timing",
      projectionScope: "scheduler.drain callback/compute elapsed; excludes the configured 50 ms quiet delay; report-only, not an eliminated main-thread cost",
      // Compatibility aliases retained for existing report consumers.
      persistenceP95Ms: percentile95(result.persistenceTimesMs),
      updateP95Ms: percentile95(result.updateTimesMs),
      persistenceSampleCount: result.persistenceTimesMs.length,
      updateSampleCount: result.updateTimesMs.length,
    };
    process.stdout.write(`[knowledge-workbench performance]\n${JSON.stringify(report, null, 2)}\n`);

    expect(result.noteCount).toBe(5_000);
    expect(result).toMatchObject({ scanProgressCount: 5_000, activeRecordCount: 5_000 });
    expect(result.mapScoreCallCount).toBeGreaterThan(0);
    expect(result.mapScoreCallCount).toBeLessThanOrEqual(250_000);
    expect(result.mapProgressCallbackCount).toBe(Math.floor(result.mapScoreCallCount / 500));
    expect(result.mapProgressCallbackCount).toBeLessThanOrEqual(500);
    expect(result.mapNodeCount).toBeLessThanOrEqual(50);
    expect(result.mapEdgeCount).toBeLessThanOrEqual(1_225);
    expect(Number.isFinite(result.mapFocusElapsedMs)).toBe(true);
    expect(result.totalBytes).toBeGreaterThanOrEqual(75 * 1024 * 1024);
    expect(result.elapsedMs).toBeLessThanOrEqual(30_000);
    expect(result.scanSaveCount).toBeLessThanOrEqual(22);
    expect(result.updateTimesMs).toHaveLength(100);
    expect(percentile95(result.updateTimesMs)).toBeLessThanOrEqual(1_000);
    expect(result.coalescedSaveCount).toBe(1);
    expect(result.peakHeapBytes).toBeGreaterThan(0);
    expect(result.persistenceTimesMs.length).toBeGreaterThan(0);
  }, 180_000);
});
