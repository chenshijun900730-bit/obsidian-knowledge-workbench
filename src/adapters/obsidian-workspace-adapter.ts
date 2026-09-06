import type { App, TFile } from "obsidian";
import { VIEW_TYPE } from "../constants";
import type { WorkspacePort } from "../core/ports";

const isFile = (value: unknown): value is TFile => typeof value === "object"
  && value !== null
  && "extension" in value
  && typeof (value as { extension?: unknown }).extension === "string";

export class ObsidianWorkspaceAdapter implements WorkspacePort {
  constructor(private readonly app: App) {}

  async openNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!isFile(file) || file.extension.toLocaleLowerCase("en-US") !== "md") return;
    await this.app.workspace.getLeaf(false).openFile(file);
  }
}

export class LifecycleEpoch {
  private epoch = 0;
  private active = false;

  begin(): number {
    this.active = true;
    this.epoch += 1;
    return this.epoch;
  }

  invalidate(): void {
    this.active = false;
    this.epoch += 1;
  }

  owns(epoch: number): boolean {
    return this.active && this.epoch === epoch;
  }
}

export class RetryableAsyncGate {
  private complete = false;
  private inFlight: Promise<void> | null = null;
  private generation = 0;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.complete) return Promise.resolve();
    if (this.inFlight !== null) return this.inFlight;
    const generation = this.generation;
    const pending = Promise.resolve().then(operation);
    const tracked = pending.then(() => {
      if (this.generation === generation) this.complete = true;
    }).finally(() => {
      if (this.generation === generation && this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  isComplete(): boolean {
    return this.complete;
  }

  reset(): void {
    this.generation += 1;
    this.complete = false;
    this.inFlight = null;
  }
}

export interface LayoutIndexOperations {
  hasActiveIndex(): boolean;
  startInitialScan(): Promise<void>;
  reconcileInventory(): Promise<void>;
  resumeAndFlush(): Promise<void>;
}

export interface RecoveredLayoutOperations {
  auditRecovery(): Promise<void>;
  refreshHistory(): Promise<void>;
  initializeIndex(): Promise<void>;
  reportReady(): void;
}

export async function initializeRecoveredLayout(
  operations: RecoveredLayoutOperations,
  isCurrent: () => boolean,
): Promise<void> {
  await operations.auditRecovery();
  if (!isCurrent()) return;
  await operations.refreshHistory();
  if (!isCurrent()) return;
  await operations.initializeIndex();
  if (!isCurrent()) return;
  operations.reportReady();
}

export async function initializeIndexForLayout(
  operations: LayoutIndexOperations,
  isCurrent: () => boolean,
): Promise<void> {
  if (!operations.hasActiveIndex()) {
    await operations.startInitialScan();
    return;
  }
  let resumeAttempted = false;
  try {
    await operations.reconcileInventory();
    if (!isCurrent()) return;
    resumeAttempted = true;
    await operations.resumeAndFlush();
  } catch (error) {
    if (!isCurrent()) return;
    if (!resumeAttempted) {
      await operations.resumeAndFlush();
      if (!isCurrent()) return;
    }
    throw error;
  }
}

export async function activateWorkbench(app: App): Promise<void> {
  let leaf = app.workspace.getLeavesOfType(VIEW_TYPE)[0];
  if (leaf === undefined) {
    leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
  }
  await app.workspace.revealLeaf(leaf);
  app.workspace.setActiveLeaf?.(leaf, { focus: true });
}

/** Narrow feature check for Obsidian's undocumented Settings close capability. */
export function closeObsidianSettingsIfSupported(app: App): boolean {
  const host = app as unknown as Readonly<{
    setting?: Readonly<{ close?: unknown }>;
  }>;
  const close = host.setting?.close;
  if (typeof close !== "function") return false;
  close.call(host.setting);
  return true;
}

/** Host-only Settings handoff; callers supply localized, visible feedback. */
export async function handoffFromObsidianSettings(input: Readonly<{
  app: App;
  isExpectedView: (view: unknown) => boolean;
  reportUnavailable: (message: string) => void;
  notify: (message: "handoff-failed" | "close-guidance") => void;
}>): Promise<void> {
  let settingsClosed = false;
  try {
    settingsClosed = closeObsidianSettingsIfSupported(input.app);
  } catch {
    input.notify("handoff-failed");
  }
  if (!settingsClosed) input.notify("close-guidance");
  try {
    await requireActivatedWorkbench(
      input.app,
      input.isExpectedView,
      input.reportUnavailable,
    );
  } catch (error) {
    input.notify("handoff-failed");
    throw error;
  }
}

export async function activateWorkbenchWithRetry(
  app: App,
  isExpectedView: (view: unknown) => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await activateWorkbench(app);
    const view = app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view !== undefined && isExpectedView(view)) return true;
    await Promise.resolve();
  }
  return false;
}

export class WorkbenchViewActivationError extends Error {
  constructor() {
    super("Workbench view did not finish loading. Use Open workbench to retry.");
    this.name = "WorkbenchViewActivationError";
  }
}

export class SurfacedHostError extends Error {
  readonly originalError: unknown;

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "SurfacedHostError";
    this.originalError = error;
  }
}

export async function requireActivatedWorkbench(
  app: App,
  isExpectedView: (view: unknown) => boolean,
  reportUnavailable: (message: string) => void,
): Promise<void> {
  if (await activateWorkbenchWithRetry(app, isExpectedView)) return;
  const error = new WorkbenchViewActivationError();
  reportUnavailable(error.message);
  throw error;
}

export function runVisibleHostAction(
  operation: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  try {
    void operation().catch(onError);
  } catch (error) {
    onError(error);
  }
}

export function surfaceVisibleHostError(
  context: string,
  error: unknown,
  isCurrent: () => boolean,
  reportStatus: (message: string) => void,
  notify: (message: string) => void,
): void {
  if (!isCurrent()) return;
  const detail = error instanceof Error ? error.message : String(error);
  const message = `${context}: ${detail}`;
  reportStatus(message);
  notify(message);
}
