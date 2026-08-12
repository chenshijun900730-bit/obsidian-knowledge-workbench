import type { FieldState, FilePrecondition, OwnedField } from "../../src/core/types";
import { FakeVault } from "./fake-vault";

export interface ScriptedFailureVaultOptions {
  readonly failOnWriteNumbers?: readonly number[];
  readonly corruptAfterWriteNumbers?: readonly number[];
  readonly unreadablePathsAfterWrite?: Readonly<Record<number, readonly string[]>>;
}

export class ScriptedFailureVault extends FakeVault {
  readonly calls: string[] = [];
  private writeNumber = 0;
  private readonly afterWrite = new Map<number, () => void>();
  private readonly onWriteAttemptCallbacks = new Map<number, () => void>();
  private readonly unreadablePaths = new Set<string>();
  private nextSnapshot: (() => void) | null = null;

  constructor(private readonly options: ScriptedFailureVaultOptions = {}) {
    super();
    this.withNotes(["a.md", "b.md", "target.md"]);
  }

  onAfterWrite(writeNumber: number, callback: () => void): void {
    this.afterWrite.set(writeNumber, callback);
  }

  onWriteAttempt(writeNumber: number, callback: () => void): void {
    this.onWriteAttemptCallbacks.set(writeNumber, callback);
  }

  deleteExternally(path: string): void {
    this.applyEvent("delete", path);
  }

  onNextSnapshot(callback: () => void): void {
    this.nextSnapshot = callback;
  }

  override async snapshot(path: string) {
    if (this.unreadablePaths.has(path)) throw new Error(`snapshot-unreadable:${path}`);
    const result = await super.snapshot(path);
    const callback = this.nextSnapshot;
    this.nextSnapshot = null;
    callback?.();
    return result;
  }

  override async renameFile(
    sourcePath: string,
    targetPath: string,
    expectedSource: FilePrecondition,
    expectedTarget: FilePrecondition,
  ): Promise<void> {
    this.calls.push(`rename:${sourcePath}->${targetPath}`);
    const writeNumber = this.nextWrite();
    this.applyAttemptFaults(writeNumber);
    if (this.options.failOnWriteNumbers?.includes(writeNumber) === true) throw new Error(`write-failed:${writeNumber}`);
    await super.renameFile(sourcePath, targetPath, expectedSource, expectedTarget);
    this.applySuccessFaults(writeNumber, targetPath);
  }

  override async setOwnedField(
    path: string,
    field: OwnedField,
    expected: FieldState,
    next: FieldState,
  ): Promise<void> {
    this.calls.push(`set:${path}`);
    const writeNumber = this.nextWrite();
    this.applyAttemptFaults(writeNumber);
    if (this.options.failOnWriteNumbers?.includes(writeNumber) === true) throw new Error(`write-failed:${writeNumber}`);
    await super.setOwnedField(path, field, expected, next);
    this.applySuccessFaults(writeNumber, path);
  }

  private nextWrite(): number {
    this.writeNumber += 1;
    return this.writeNumber;
  }

  private applyAttemptFaults(writeNumber: number): void {
    this.onWriteAttemptCallbacks.get(writeNumber)?.();
    for (const path of this.options.unreadablePathsAfterWrite?.[writeNumber] ?? []) this.unreadablePaths.add(path);
  }

  private applySuccessFaults(writeNumber: number, resultPath: string): void {
    if (this.options.corruptAfterWriteNumbers?.includes(writeNumber) === true) this.modifyExternally(resultPath);
    this.afterWrite.get(writeNumber)?.();
  }
}
