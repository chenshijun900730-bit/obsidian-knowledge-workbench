export type TerminalStatus = "passed" | "failed" | "inconclusive";

export type StartupNormalizationEvidence =
  | "seed-unchanged"
  | "normalized-safe"
  | "unsafe"
  | "indeterminate";

export type FailureCategory =
  | "artifact"
  | "fixture"
  | "startup"
  | "host-isolation"
  | "ui-capability"
  | "content-drift"
  | "network"
  | "recovery"
  | "timing";

export interface ReadOnlyAcceptanceReport {
  readonly schemaVersion: 1;
  readonly scope: "dedicated-synthetic-vault";
  readonly contentPolicy: "deterministic-synthetic-notes-only";
  readonly buildMode: "read-only-acceptance";
  readonly status: TerminalStatus;
  readonly recordedAt: string;
  readonly runId: string;
  readonly commit: string;
  readonly pluginVersion: string;
  readonly obsidianVersion: string;
  readonly artifactBinding: string;
  readonly syntheticNoteCount: 5000;
  readonly scanElapsedMs: number;
  readonly restartRestoreElapsedMs: number;
  readonly artifactIdentity: TerminalStatus;
  readonly fixtureIdentity: TerminalStatus;
  readonly automatedSafety: TerminalStatus;
  readonly hostIsolation: TerminalStatus;
  readonly banner: TerminalStatus;
  readonly startupNormalization: TerminalStatus;
  readonly quickCaptureBlocked: TerminalStatus;
  readonly organizationWritesBlocked: TerminalStatus;
  readonly undoBlocked: TerminalStatus;
  readonly historySensitiveActionsBlocked: TerminalStatus;
  readonly aiBlocked: TerminalStatus;
  readonly readSurfaces: TerminalStatus;
  readonly restartRestore: TerminalStatus;
  readonly contentUnchanged: TerminalStatus;
  readonly networkBoundary: TerminalStatus;
  readonly recoveryAbsent: TerminalStatus;
  readonly finalHostStopped: TerminalStatus;
  readonly failureCategories: readonly FailureCategory[];
}

export interface HostObservation {
  readonly recordedAt: string;
  readonly obsidianVersion: string;
  readonly scanElapsedMs: number;
  readonly restartRestoreElapsedMs: number;
  readonly hostIsolation: TerminalStatus;
  readonly banner: TerminalStatus;
  readonly startupNormalization: TerminalStatus;
  readonly quickCaptureBlocked: TerminalStatus;
  readonly organizationWritesBlocked: TerminalStatus;
  readonly undoBlocked: TerminalStatus;
  readonly historySensitiveActionsBlocked: TerminalStatus;
  readonly aiBlocked: TerminalStatus;
  readonly readSurfaces: TerminalStatus;
  readonly restartRestore: TerminalStatus;
  readonly networkBoundary: TerminalStatus;
  readonly recoveryAbsent: TerminalStatus;
  readonly finalHostStopped: TerminalStatus;
}

export interface LocalAcceptanceEvidence {
  readonly runId: string;
  readonly commit: string;
  readonly pluginVersion: string;
  readonly artifactBinding: string;
  readonly syntheticNoteCount: 5000;
  readonly artifactIdentity: TerminalStatus;
  readonly fixtureIdentity: TerminalStatus;
  readonly automatedSafety: TerminalStatus;
  readonly contentUnchanged: TerminalStatus;
  readonly startupNormalizationEvidence: StartupNormalizationEvidence;
  readonly hostIsolation: TerminalStatus;
  readonly historySensitiveActionsBlocked: TerminalStatus;
  readonly networkBoundary: TerminalStatus;
  readonly recoveryAbsent: TerminalStatus;
  readonly finalHostStopped: TerminalStatus;
}

export declare function decodeHostObservation(value: unknown): HostObservation;
export declare function decodeReadOnlyAcceptanceReport(bytes: Uint8Array): ReadOnlyAcceptanceReport;
export declare function composeReadOnlyAcceptanceReport(
  local: LocalAcceptanceEvidence,
  host: HostObservation,
): ReadOnlyAcceptanceReport;
export declare function computeReportStatus(report: ReadOnlyAcceptanceReport): TerminalStatus;
export declare function deriveFailureCategories(
  report: ReadOnlyAcceptanceReport,
): readonly FailureCategory[];
export declare function encodeReadOnlyAcceptanceReport(report: ReadOnlyAcceptanceReport): Buffer;
