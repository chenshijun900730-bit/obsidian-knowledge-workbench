import type { DocumentRecord } from "../core/types";
import type { WorkbenchLocale } from "../i18n/workbench-i18n";
import type { LegacyVerificationAdoptionV1 } from "./legacy-verification-adoption";
import type { RecentCloudDirectoriesV1 } from "./recent-cloud-directories";
import type { VerificationBatchTombstonesV1 } from "./verification-batch-tombstones";

export interface FolderRule {
  readonly prefix: string;
  readonly kind: "note" | "reference";
}

export interface FolderRuleProposal {
  readonly prefix: string;
  readonly kind: "reference";
  readonly noteCount: number;
  readonly unclassifiedCount: number;
  readonly samplePaths: readonly string[];
}

export interface BoundCloudLibraryV1 {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly sourceImportSha256: string;
  readonly verificationGeneration: number;
}

export interface PluginSettings {
  readonly locale: WorkbenchLocale;
  readonly writeEnabled: boolean;
  readonly writePreviewAcknowledged: boolean;
  readonly openAtStartup: boolean;
  readonly folderRules: readonly FolderRule[];
  readonly excludedPrefixes: readonly string[];
  readonly aiEnabled: boolean;
  readonly aiEndpoint: string;
  readonly aiModel: string;
  readonly secretId: string;
  readonly recentCloudDirectories: RecentCloudDirectoriesV1;
  readonly boundCloudLibrary: BoundCloudLibraryV1 | null;
  readonly cloudVerificationGeneration: number;
  readonly verificationBatchTombstones: VerificationBatchTombstonesV1;
  readonly legacyVerificationAdoption: LegacyVerificationAdoptionV1;
}

export type CloudVerificationSettings = Pick<
  PluginSettings,
  | "boundCloudLibrary"
  | "cloudVerificationGeneration"
  | "verificationBatchTombstones"
  | "legacyVerificationAdoption"
>;

export type CloudVerificationTransitionIntent = Readonly<{
  kind: "library-binding" | "identity-replacement" | "txt-source-replacement";
  currentWorkflowBatchId: string | null;
}>;

export interface ActiveIndex {
  readonly builtAt: number;
  readonly records: readonly DocumentRecord[];
}

export interface ScanCheckpoint {
  readonly scanId: string;
  readonly completedPaths: readonly string[];
  readonly records: readonly DocumentRecord[];
}

export interface OperationalState {
  readonly pins: Readonly<Record<string, number>>;
  readonly dismissals: Readonly<Record<string, { readonly dismissedAt: number; readonly mtime: number }>>;
  readonly lastOpened: Readonly<Record<string, number>>;
  readonly journals: readonly unknown[];
}

export interface PluginData {
  readonly schemaVersion: 1;
  readonly settings: PluginSettings;
  readonly activeIndex: ActiveIndex | null;
  readonly staging: ScanCheckpoint | null;
  readonly operational: OperationalState;
}
