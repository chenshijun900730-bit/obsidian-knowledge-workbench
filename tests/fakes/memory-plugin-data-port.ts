import type { PluginDataPort } from "../../src/core/ports";

const clone = <T>(value: T): T => structuredClone(value);

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

export class MemoryPluginDataPort implements PluginDataPort {
  private data: unknown;
  private shouldFailNextSave = false;
  private shouldPauseNextSave = false;
  private savePaused: Deferred | null = null;
  private resumeSave: Deferred | null = null;

  readonly saveCalls: unknown[] = [];
  activeSaves = 0;
  maxConcurrentSaves = 0;

  constructor(initial: unknown = undefined) {
    this.data = clone(initial);
  }

  async load(): Promise<unknown> {
    return clone(this.data);
  }

  async save(data: unknown): Promise<void> {
    const snapshot = clone(data);
    this.saveCalls.push(clone(snapshot));
    this.activeSaves += 1;
    this.maxConcurrentSaves = Math.max(this.maxConcurrentSaves, this.activeSaves);
    try {
      if (this.shouldPauseNextSave && this.savePaused !== null && this.resumeSave !== null) {
        this.shouldPauseNextSave = false;
        this.savePaused.resolve();
        await this.resumeSave.promise;
        this.savePaused = null;
        this.resumeSave = null;
      }
      if (this.shouldFailNextSave) {
        this.shouldFailNextSave = false;
        throw new Error("Injected save failure");
      }
      this.data = snapshot;
    } finally {
      this.activeSaves -= 1;
    }
  }

  failNextSave(): void {
    this.shouldFailNextSave = true;
  }

  pauseNextSave(): void {
    if (this.resumeSave !== null) throw new Error("A plugin data save pause is already armed");
    this.shouldPauseNextSave = true;
    this.savePaused = deferred();
    this.resumeSave = deferred();
  }

  async waitUntilSavePaused(): Promise<void> {
    if (this.savePaused === null) throw new Error("No plugin data save pause is armed");
    await this.savePaused.promise;
  }

  resumeSaves(): void {
    if (this.resumeSave === null) throw new Error("No plugin data save pause is armed");
    this.resumeSave.resolve();
  }
}
