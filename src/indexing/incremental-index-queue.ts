import type { VaultEvent } from "../core/ports";
import type { IndexService } from "./index-service";

const replaceEvent = (events: Map<string, VaultEvent>, event: VaultEvent): void => {
  events.delete(event.path);
  events.set(event.path, event);
};

export class IncrementalIndexQueue {
  private pending = new Map<string, VaultEvent>();
  private timer: number | null = null;
  private tail: Promise<void> = Promise.resolve();
  private paused = false;

  constructor(
    private readonly index: Pick<IndexService, "applyEvents">,
    private readonly debounceMs = 250,
  ) {}

  enqueue(event: VaultEvent): void {
    if (event.kind === "rename") {
      replaceEvent(this.pending, { kind: "delete", path: event.oldPath });
      replaceEvent(this.pending, { kind: "create", path: event.path });
    } else replaceEvent(this.pending, event);
    if (!this.paused) this.scheduleAutoFlush();
  }

  async pauseAutoFlush(): Promise<void> {
    this.paused = true;
    this.clearTimer();
    await this.tail.catch(() => undefined);
  }

  resumeAndFlush(): Promise<void> {
    this.paused = false;
    this.clearTimer();
    return this.serializeFlush();
  }

  flushForTest(): Promise<void> {
    this.clearTimer();
    return this.serializeFlush();
  }

  private scheduleAutoFlush(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.serializeFlush().catch(() => undefined);
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  private serializeFlush(): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(() => this.flushCaptured());
    this.tail = operation;
    return operation;
  }

  private async flushCaptured(): Promise<void> {
    if (this.pending.size === 0) return;
    const captured = this.pending;
    this.pending = new Map();
    try {
      await this.index.applyEvents([...captured.values()]);
    } catch (error) {
      const merged = new Map<string, VaultEvent>();
      for (const event of captured.values()) replaceEvent(merged, event);
      for (const event of this.pending.values()) replaceEvent(merged, event);
      this.pending = merged;
      throw error;
    }
  }
}
