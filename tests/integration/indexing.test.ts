import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../fakes/fake-vault";
import { MemoryPluginDataPort } from "../fakes/memory-plugin-data-port";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import { IndexService } from "../../src/indexing/index-service";
import { indexedFixture } from "./helpers/indexed-fixture";

beforeAll(() => {
  vi.stubGlobal("window", { clearTimeout: nodeClearTimeout, setTimeout: nodeSetTimeout });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IndexService", () => {
  it("promotes only a completed initial scan", async () => {
    const vault = FakeVault.withNotes(["a.md", "b.md", "c.md"]);
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const service = new IndexService(vault, store, { now: () => 100 }, 2);
    await service.buildInitial(new AbortController().signal, () => undefined);
    expect(service.activeRecords().map((record) => record.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("keeps the prior active index when cancellation interrupts a rebuild", async () => {
    const vault = FakeVault.withNotes(["old.md"]);
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const service = new IndexService(vault, store, { now: () => 100 }, 1);
    await service.buildInitial(new AbortController().signal, () => undefined);
    vault.replaceWithNotes(["new-1.md", "new-2.md"]);
    const controller = new AbortController();
    await expect(service.buildInitial(controller.signal, ({ completed }) => completed === 1 && controller.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(service.activeRecords().map((record) => record.path)).toEqual(["old.md"]);
  });

  it("reads each note once with bounded concurrency", async () => {
    const vault = FakeVault.withNotes(["a.md", "b.md", "c.md", "d.md"]);
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    await new IndexService(vault, store, { now: () => 100 }, 2).buildInitial(new AbortController().signal, () => undefined);
    expect([...vault.readCounts.values()]).toEqual([1, 1, 1, 1]);
    expect(vault.maxConcurrentReads).toBeGreaterThan(1);
    expect(vault.maxConcurrentReads).toBeLessThanOrEqual(2);
  });

  it("does not promote when canceled from the final-batch progress callback", async () => {
    const vault = FakeVault.withNotes(["only.md"]);
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const controller = new AbortController();
    const service = new IndexService(vault, store, { now: () => 100 }, 1);
    await expect(service.buildInitial(controller.signal, () => controller.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(store.activeIndex()).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid concurrency %s", async (concurrency) => {
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    expect(() => new IndexService(FakeVault.withNotes([]), store, { now: () => 100 }, concurrency)).toThrow(/positive integer/u);
  });

  it("checkpoints at most 250 newly completed paths", async () => {
    const paths = Array.from({ length: 251 }, (_, index) => `note-${String(index).padStart(3, "0")}.md`);
    const port = new MemoryPluginDataPort();
    const store = new PluginDataStore(port);
    await store.load();
    await new IndexService(FakeVault.withNotes(paths), store, { now: () => 100 }, 300)
      .buildInitial(new AbortController().signal, () => undefined);
    const checkpointSizes = port.saveCalls.flatMap((call) => {
      const staging = (call as { readonly staging?: { readonly completedPaths?: unknown } }).staging;
      return Array.isArray(staging?.completedPaths) ? [staging.completedPaths.length] : [];
    });
    expect(checkpointSizes).toEqual([0, 250, 251]);
  });

  it("resumes a matching checkpoint without rereading completed paths", async () => {
    const paths = Array.from({ length: 251 }, (_, index) => `resume-${String(index).padStart(3, "0")}.md`);
    const vault = FakeVault.withNotes(paths);
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const service = new IndexService(vault, store, { now: () => 100 }, 1);
    const controller = new AbortController();

    await expect(service.buildInitial(controller.signal, ({ completed }) => {
      if (completed === 251) controller.abort();
    })).rejects.toMatchObject({ name: "AbortError" });
    await service.buildInitial(new AbortController().signal, () => undefined);

    expect(vault.readCounts.get(paths[0] ?? "")).toBe(1);
    expect(vault.readCounts.get(paths[249] ?? "")).toBe(1);
    expect(vault.readCounts.get(paths[250] ?? "")).toBe(2);
  });

  it("keeps the prior active index when a progress callback throws", async () => {
    const vault = FakeVault.withNotes(["old.md"]);
    const store = new PluginDataStore(new MemoryPluginDataPort());
    await store.load();
    const service = new IndexService(vault, store, { now: () => 100 }, 1);
    await service.buildInitial(new AbortController().signal, () => undefined);
    vault.replaceWithNotes(["new.md"]);

    await expect(service.buildInitial(new AbortController().signal, () => {
      throw new Error("progress failed");
    })).rejects.toThrow("progress failed");
    expect(service.activeRecords().map((record) => record.path)).toEqual(["old.md"]);
  });

  it.each([
    ["create", "new.md", ["a.md", "new.md"]],
    ["modify", "a.md", ["a.md"]],
    ["delete", "a.md", []],
  ] as const)("applies %s incrementally", async (kind, path, expected) => {
    const fixture = await indexedFixture(["a.md"]);
    fixture.vault.applyEvent(kind, path);
    fixture.queue.enqueue({ kind, path });
    await fixture.queue.flushForTest();
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(expected);
  });

  it("coalesces repeated modifies and treats rename as delete plus index", async () => {
    const fixture = await indexedFixture(["a.md"]);
    fixture.vault.rename("a.md", "b.md");
    fixture.queue.enqueue({ kind: "modify", path: "a.md" });
    fixture.queue.enqueue({ kind: "rename", path: "b.md", oldPath: "a.md" });
    await fixture.queue.flushForTest();
    expect(fixture.vault.readCounts.get("b.md")).toBe(1);
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["b.md"]);
  });

  it("defensively applies a raw rename as delete plus index", async () => {
    const fixture = await indexedFixture(["a.md"]);
    fixture.vault.rename("a.md", "b.md");
    await fixture.index.applyEvents([{ kind: "rename", path: "b.md", oldPath: "a.md" }]);
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["b.md"]);
  });

  it("keeps both paths when a renamed source is recreated in the same batch", async () => {
    const fixture = await indexedFixture(["a.md"]);
    fixture.vault.rename("a.md", "b.md");
    fixture.vault.applyEvent("create", "a.md");

    await fixture.queue.flushForTest();

    expect(await fixture.vault.listMarkdownPaths()).toEqual(["a.md", "b.md"]);
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "b.md"]);
  });

  it("keeps a newer recreated source when a rename flush fails and retries", async () => {
    const fixture = await indexedFixture(["a.md"], { pauseNextSave: true });
    fixture.vault.rename("a.md", "b.md");
    const firstFlush = fixture.queue.flushForTest();
    await fixture.port.waitUntilSavePaused();
    fixture.vault.applyEvent("create", "a.md");
    fixture.port.failNextSave();
    fixture.port.resumeSaves();

    await expect(firstFlush).rejects.toThrow("Injected save failure");
    await fixture.queue.flushForTest();

    expect(await fixture.vault.listMarkdownPaths()).toEqual(["a.md", "b.md"]);
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "b.md"]);
  });

  it("buffers events during the initial scan and replays them after promotion", async () => {
    const fixture = await indexedFixture(["a.md"], { initiallyIndexed: false, pauseReadAt: "a.md" });
    const scan = fixture.coordinator.start();
    await fixture.vault.waitUntilReadPaused();
    fixture.vault.applyEvent("create", "during-scan.md");
    fixture.queue.enqueue({ kind: "create", path: "during-scan.md" });
    fixture.vault.resumeReads();
    await scan;
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "during-scan.md"]);
  });

  it("keeps buffered events paused after first-scan cancellation and includes them on retry", async () => {
    const fixture = await indexedFixture(["a.md"], { initiallyIndexed: false, pauseReadAt: "a.md" });
    const first = fixture.coordinator.start();
    await fixture.vault.waitUntilReadPaused();
    fixture.vault.applyEvent("create", "buffered.md");
    fixture.queue.enqueue({ kind: "create", path: "buffered.md" });
    fixture.coordinator.cancel();
    fixture.vault.resumeReads();
    await expect(first).resolves.toEqual({ status: "canceled" });
    expect(fixture.store.activeIndex()).toBeNull();
    await fixture.coordinator.start();
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "buffered.md"]);
  });

  it("replays buffered events against a prior active index after rebuild cancellation", async () => {
    const fixture = await indexedFixture(["old.md"], { pauseReadAt: "new.md" });
    fixture.vault.replaceWithNotes(["new.md"]);
    const rebuild = fixture.coordinator.start();
    await fixture.vault.waitUntilReadPaused();
    fixture.vault.applyEvent("create", "during-cancel.md");
    fixture.coordinator.cancel();
    fixture.vault.resumeReads();

    await expect(rebuild).resolves.toEqual({ status: "canceled" });
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["during-cancel.md", "old.md"]);
  });

  it("replays buffered events against a prior active index after rebuild failure", async () => {
    const fixture = await indexedFixture(["old.md"], { pauseReadAt: "new.md" });
    fixture.vault.replaceWithNotes(["new.md"]);
    const rebuild = fixture.coordinator.start();
    await fixture.vault.waitUntilReadPaused();
    fixture.vault.applyEvent("create", "during-failure.md");
    fixture.port.failNextSave();
    fixture.vault.resumeReads();

    await expect(rebuild).rejects.toThrow("Injected save failure");
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["during-failure.md", "old.md"]);
  });

  it("keeps a first-scan failure buffered and paused until retry", async () => {
    const fixture = await indexedFixture(["a.md"], { initiallyIndexed: false, pauseReadAt: "a.md" });
    const first = fixture.coordinator.start();
    await fixture.vault.waitUntilReadPaused();
    fixture.vault.applyEvent("create", "buffered-failure.md");
    fixture.port.failNextSave();
    fixture.vault.resumeReads();

    await expect(first).rejects.toThrow("Injected save failure");
    expect(fixture.store.activeIndex()).toBeNull();
    await fixture.coordinator.start();
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "buffered-failure.md"]);
  });

  it("waits for an in-flight incremental flush before starting a scan epoch", async () => {
    const fixture = await indexedFixture(["a.md"], { pauseNextSave: true });
    fixture.vault.applyEvent("create", "b.md");
    const flush = fixture.queue.flushForTest();
    await fixture.port.waitUntilSavePaused();
    const listFiles = vi.spyOn(fixture.vault, "listMarkdownFiles");
    const scan = fixture.coordinator.start();

    await Promise.resolve();
    const listCallsWhileFlushPaused = listFiles.mock.calls.length;
    fixture.port.resumeSaves();
    await Promise.all([flush, scan]);

    expect(listCallsWhileFlushPaused).toBe(0);
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(fixture.store.activeIndex()?.records.map((record) => record.path)).toEqual(["a.md", "b.md"]);
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "b.md"]);
  });

  it.each(["vault listing", "note read", "progress callback", "storage save"] as const)(
    "propagates an unrequested AbortError from %s",
    async (source) => {
      const fixture = await indexedFixture(["a.md"], { initiallyIndexed: false });
      const error = new DOMException(`Injected ${source} abort`, "AbortError");
      let onProgress = (): void => undefined;
      if (source === "vault listing") vi.spyOn(fixture.vault, "listMarkdownFiles").mockRejectedValueOnce(error);
      else if (source === "note read") vi.spyOn(fixture.vault, "readNote").mockRejectedValueOnce(error);
      else if (source === "storage save") vi.spyOn(fixture.port, "save").mockRejectedValueOnce(error);
      else onProgress = () => {
        throw error;
      };

      await expect(fixture.coordinator.start(onProgress)).rejects.toBe(error);
      expect(fixture.store.activeIndex()).toBeNull();
    },
  );

  it("does not expose an incremental update whose save fails", async () => {
    const fixture = await indexedFixture(["a.md"]);
    fixture.port.failNextSave();
    fixture.vault.applyEvent("create", "b.md");
    await expect(fixture.index.applyEvents([{ kind: "create", path: "b.md" }])).rejects.toThrow("Injected save failure");
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md"]);
  });

  it("persists a 50-event batch once and never drops an event enqueued during flush", async () => {
    const fixture = await indexedFixture(["a.md"], { pauseNextSave: true });
    for (let index = 0; index < 50; index += 1) {
      const path = `batch-${index}.md`;
      fixture.vault.applyEvent("create", path);
      fixture.queue.enqueue({ kind: "create", path });
    }
    const savesBefore = fixture.port.saveCalls.length;
    const firstFlush = fixture.queue.flushForTest();
    await fixture.port.waitUntilSavePaused();
    fixture.vault.applyEvent("create", "late.md");
    fixture.queue.enqueue({ kind: "create", path: "late.md" });
    const secondFlush = fixture.queue.flushForTest();
    fixture.port.resumeSaves();
    await Promise.all([firstFlush, secondFlush]);
    expect(fixture.port.saveCalls.length - savesBefore).toBe(2);
    expect(fixture.port.maxConcurrentSaves).toBe(1);
    expect(new Set(fixture.index.activeRecords().map((record) => record.path))).toEqual(new Set([
      "a.md",
      "late.md",
      ...Array.from({ length: 50 }, (_, index) => `batch-${index}.md`),
    ]));
  });

  it("emits once for an incremental batch", async () => {
    const fixture = await indexedFixture(["a.md"]);
    let emissions = 0;
    fixture.index.subscribe(() => {
      emissions += 1;
    });
    fixture.vault.applyEvent("create", "b.md");
    fixture.vault.applyEvent("create", "c.md");
    await fixture.queue.flushForTest();
    expect(emissions).toBe(1);
  });

  it("retains a failed queue flush and succeeds on retry", async () => {
    const fixture = await indexedFixture(["a.md"]);
    fixture.vault.applyEvent("create", "b.md");
    fixture.port.failNextSave();
    await expect(fixture.queue.flushForTest()).rejects.toThrow("Injected save failure");
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md"]);
    await fixture.queue.flushForTest();
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "b.md"]);
  });

  it("lets newer same-path events win when a failed flush is merged back", async () => {
    const fixture = await indexedFixture(["a.md"], { pauseNextSave: true });
    fixture.vault.applyEvent("create", "transient.md");
    const flush = fixture.queue.flushForTest();
    await fixture.port.waitUntilSavePaused();
    fixture.vault.applyEvent("delete", "transient.md");
    fixture.port.failNextSave();
    fixture.port.resumeSaves();

    await expect(flush).rejects.toThrow("Injected save failure");
    await fixture.queue.flushForTest();
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md"]);
  });

  it("does not persist an empty flush", async () => {
    const fixture = await indexedFixture(["a.md"]);
    const savesBefore = fixture.port.saveCalls.length;
    await fixture.queue.flushForTest();
    expect(fixture.port.saveCalls).toHaveLength(savesBefore);
  });

  it("retains events after an automatic timer flush fails", async () => {
    const fixture = await indexedFixture(["a.md"]);
    fixture.port.failNextSave();
    fixture.vault.applyEvent("create", "timer-retry.md");
    await delay(300);
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md"]);
    await fixture.queue.flushForTest();
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "timer-retry.md"]);
  });

  it("reconciles create modify and delete changes made while the plugin was offline", async () => {
    const fixture = await indexedFixture(["a.md", "delete.md"]);
    fixture.vault.replaceWithNotes(["a.md", "new.md"]);
    fixture.vault.modifyExternally("a.md");
    await fixture.index.reconcileInventory();
    expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["a.md", "new.md"]);
    expect(fixture.index.activeRecords().find((record) => record.path === "a.md")?.mtime).toBe(fixture.vault.mtimeOf("a.md"));
  });
});
