import type { DocumentRecord } from "../../src/core/types";
import type { AiClientPort, AiCompletionInput, VaultReadPort } from "../../src/core/ports";
import { controllerFixture, type ControllerFixtureOptions } from "./ui-fixtures";

export const selectedNote = (path: string, content = "body") => ({ path, content });

export class DeferredAiClient implements AiClientPort {
  readonly calls: AiCompletionInput[] = [];
  private resolveCall: ((value: Readonly<{ text: string }>) => void) | null = null;
  private rejectCall: ((error: Error) => void) | null = null;

  complete(input: AiCompletionInput): Promise<Readonly<{ text: string }>> {
    this.calls.push(structuredClone(input));
    return new Promise((resolve, reject) => { this.resolveCall = resolve; this.rejectCall = reject; });
  }
  resolve(text: string): void { this.resolveCall?.({ text }); }
  reject(error: Error): void { this.rejectCall?.(error); }
}

export const aiRecord = (index: number, size = 10, overrides: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: `ai-${index}`,
  path: `AI/Note-${index}.md`,
  basename: `Note-${index}`,
  kind: "note",
  title: `Note ${index}`,
  aliases: [], headings: [], tags: [], ownedFields: {}, relationFields: {}, outgoingLinks: [], tokens: [],
  mtime: 1,
  size,
  contentHash: `hash-${index}`,
  ...overrides,
});

export function aiControllerFixture(options: ControllerFixtureOptions & Readonly<{
  recordCount?: number;
  recordSize?: number;
  records?: readonly DocumentRecord[];
}> = {}) {
  const fixture = controllerFixture({
    activeIndex: true,
    aiEnabled: true,
    aiEndpoint: "https://example.test/v1",
    aiModel: "fixture-model",
    aiSecretId: "fixture-secret",
    ...options,
  });
  if (options.records !== undefined || options.recordCount !== undefined || options.recordSize !== undefined) {
    const records = options.records ?? Array.from({ length: options.recordCount ?? 2 }, (_, index) => aiRecord(index, options.recordSize));
    fixture.vault.withNotes(records.map((record) => record.path));
    fixture.index.publishRecords(records);
  }
  return fixture;
}

export const mismatchReadPort = (base: VaultReadPort): VaultReadPort => ({
  ...base,
  listMarkdownFiles: () => base.listMarkdownFiles(),
  listMarkdownPaths: () => base.listMarkdownPaths(),
  readNote: async (path) => {
    const note = await base.readNote(path);
    return note === null ? null : { ...note, path: "Other.md" };
  },
  readOwnedField: (path, field) => base.readOwnedField(path, field),
  snapshot: (path) => base.snapshot(path),
  inboundLinks: (path) => base.inboundLinks(path),
  pathExists: (path) => base.pathExists(path),
  subscribe: (listener) => base.subscribe(listener),
});

export function settingsFixture() {
  return aiControllerFixture();
}

export function aiTodayFixture() {
  return aiControllerFixture();
}
