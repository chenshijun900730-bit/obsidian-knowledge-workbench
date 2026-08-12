import { generateSyntheticFixture } from "../../scripts/synthetic-note-fixture.mjs";
import { FakeVault } from "../fakes/fake-vault";

export interface GeneratedFixture {
  readonly vault: FakeVault;
  readonly noteCount: number;
  readonly totalBytes: number;
}

export function generateFixture(input: { notes: number; minimumBytes: number; seed?: number }): GeneratedFixture {
  const fixture = generateSyntheticFixture(input);
  return {
    vault: new FakeVault().withGeneratedNotes(fixture.notes),
    noteCount: fixture.noteCount,
    totalBytes: fixture.totalBytes,
  };
}
