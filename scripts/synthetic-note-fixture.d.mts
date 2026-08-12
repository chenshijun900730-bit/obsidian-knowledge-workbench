export const SYNTHETIC_ACCEPTANCE_NOTE_COUNT: 5000;
export const SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES: 78643200;
export const SYNTHETIC_ACCEPTANCE_SEED: 13;
export const SYNTHETIC_CONTENT_DIRECTORY: "Generated";

export interface SyntheticFixtureNote {
  readonly path: string;
  readonly basename: string;
  readonly mtime: number;
  readonly size: number;
  readonly content: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly headings: readonly string[];
  readonly outgoingLinks: readonly string[];
}

export interface OwnedTreeEntry {
  readonly type: "directory" | "file";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly sha256?: string;
}

export interface OwnedTreeSnapshot {
  readonly root: Readonly<{ path: string; dev: bigint; ino: bigint }>;
  readonly entries: ReadonlyMap<string, Readonly<OwnedTreeEntry>>;
}

export interface CorpusAttestation {
  readonly syntheticNoteCount: 5000;
  readonly syntheticTotalBytes: 78643200;
  readonly corpusDigest: string;
  readonly tree: OwnedTreeSnapshot;
}

export interface AttestationInput {
  readonly vaultPath: string;
  readonly phase: "prepared" | "post-host";
  readonly expected?: Readonly<{
    syntheticNoteCount: 5000;
    syntheticTotalBytes: 78643200;
    corpusDigest: string;
  }>;
}

export function generateSyntheticFixture(input: Readonly<{
  notes: number;
  minimumBytes: number;
  seed?: number;
}>): Readonly<{
  notes: readonly SyntheticFixtureNote[];
  noteCount: number;
  totalBytes: number;
}>;

export function generateAcceptanceFixture(): ReturnType<typeof generateSyntheticFixture>;
export function computeSyntheticCorpusDigest(notes: readonly SyntheticFixtureNote[]): string;
