export type StartupNormalizationEvidence = "seed-unchanged" | "normalized-safe" | "unsafe";

export interface PostHostPluginDataInspection {
  readonly startupNormalizationEvidence: StartupNormalizationEvidence;
  readonly seededJournalPresent: boolean;
  readonly recoveryAbsent: boolean;
}

export function createSyntheticPluginDataSeed(): Readonly<Record<string, unknown>>;
export function encodeSyntheticPluginDataSeed(): Buffer;
export function decodeSyntheticPluginDataSeed(bytes: Uint8Array): Readonly<Record<string, unknown>>;
export function inspectPostHostPluginData(bytes: Uint8Array): Readonly<PostHostPluginDataInspection>;
