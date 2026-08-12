import type { FieldState, FilePrecondition, OwnedField, VaultNote, VaultPath } from "./types";

export type VaultEvent =
  | Readonly<{ kind: "create" | "modify" | "delete"; path: VaultPath }>
  | Readonly<{ kind: "rename"; path: VaultPath; oldPath: VaultPath }>;
export interface VaultFileRef { readonly path: VaultPath; readonly mtime: number; readonly size: number }
export interface VaultReadPort {
  listMarkdownFiles(): Promise<readonly VaultFileRef[]>;
  listMarkdownPaths(): Promise<readonly VaultPath[]>;
  readNote(path: VaultPath): Promise<VaultNote | null>;
  readOwnedField(path: VaultPath, field: OwnedField): Promise<FieldState | null>;
  snapshot(path: VaultPath): Promise<FilePrecondition>;
  inboundLinks(path: VaultPath): Promise<readonly VaultPath[] | null>;
  pathExists(path: VaultPath): Promise<boolean>;
  subscribe(listener: (event: VaultEvent) => void): () => void;
}
export interface VaultWritePort {
  renameFile(
    sourcePath: VaultPath,
    targetPath: VaultPath,
    expectedSource: FilePrecondition,
    expectedTarget: FilePrecondition,
  ): Promise<void>;
  setOwnedField(path: VaultPath, field: OwnedField, expected: FieldState, next: FieldState): Promise<void>;
}
export interface Clock { now(): number }
export interface PluginDataPort { load(): Promise<unknown>; save(data: unknown): Promise<void> }
export interface WorkspacePort {
  openNote(path: VaultPath): Promise<void>;
}
export interface QuickCapturePort { capture(): Promise<VaultPath | null> }

export type AiAction = "summarize" | "name-cluster" | "explain-relation" | "suggest-labels";
export interface AiNotePayload { readonly path: VaultPath; readonly content: string }
export interface AiCompletionInput {
  readonly action: AiAction;
  readonly notes: readonly AiNotePayload[];
}
export interface AiClientPort {
  complete(input: AiCompletionInput): Promise<Readonly<{ text: string }>>;
}
