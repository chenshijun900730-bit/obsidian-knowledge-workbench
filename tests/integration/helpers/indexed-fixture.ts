import type { VaultPath } from "../../../src/core/types";
import { IncrementalIndexQueue } from "../../../src/indexing/incremental-index-queue";
import { IndexService, type ScanProgress } from "../../../src/indexing/index-service";
import { PluginDataStore } from "../../../src/storage/plugin-data-store";
import { FakeVault } from "../../fakes/fake-vault";
import { MemoryPluginDataPort } from "../../fakes/memory-plugin-data-port";

export interface IndexedFixtureOptions {
  readonly initiallyIndexed?: boolean;
  readonly pauseReadAt?: VaultPath;
  readonly pauseNextSave?: boolean;
}

export type ScanResult = Readonly<{ status: "completed" | "canceled" }>;

const isAbortError = (error: unknown): boolean => typeof error === "object"
  && error !== null
  && "name" in error
  && error.name === "AbortError";

class IndexedCoordinator {
  private controller: AbortController | null = null;

  constructor(
    private readonly store: PluginDataStore,
    private readonly index: IndexService,
    private readonly queue: IncrementalIndexQueue,
  ) {}

  async start(onProgress: (progress: ScanProgress) => void = () => undefined): Promise<ScanResult> {
    if (this.controller !== null) throw new Error("Index scan already running");
    const controller = new AbortController();
    this.controller = controller;
    const hadActiveIndex = this.store.activeIndex() !== null;
    await this.queue.pauseAutoFlush();
    try {
      await this.index.buildInitial(controller.signal, onProgress);
      await this.queue.resumeAndFlush();
      return { status: "completed" };
    } catch (error) {
      if (hadActiveIndex) await this.queue.resumeAndFlush();
      if (controller.signal.aborted && isAbortError(error)) return { status: "canceled" };
      throw error;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
  }
}

export interface IndexedFixture {
  readonly vault: FakeVault;
  readonly port: MemoryPluginDataPort;
  readonly store: PluginDataStore;
  readonly index: IndexService;
  readonly queue: IncrementalIndexQueue;
  readonly coordinator: IndexedCoordinator;
}

export async function indexedFixture(
  paths: readonly VaultPath[],
  { initiallyIndexed = true, pauseReadAt, pauseNextSave = false }: IndexedFixtureOptions = {},
): Promise<IndexedFixture> {
  const vault = FakeVault.withNotes(paths);
  const port = new MemoryPluginDataPort();
  const store = new PluginDataStore(port);
  await store.load();
  const index = new IndexService(vault, store, { now: () => 100 }, 2);
  const queue = new IncrementalIndexQueue(index);
  await queue.pauseAutoFlush();
  vault.subscribe((event) => queue.enqueue(event));
  const coordinator = new IndexedCoordinator(store, index, queue);

  if (initiallyIndexed) await coordinator.start();
  if (pauseReadAt !== undefined) vault.pauseReadAt(pauseReadAt);
  if (pauseNextSave) port.pauseNextSave();

  return { vault, port, store, index, queue, coordinator };
}
