import type { DocumentRecord } from "../core/types";
import type { WorkbenchLocale } from "../i18n/workbench-i18n";
import type { RecentCloudDirectoriesV1 } from "./recent-cloud-directories";

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
}

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
