import type { ClassificationResult } from "../../src/classification/classification-service";
import type { DocumentRecord } from "../../src/core/types";
import type { MapEdge } from "../../src/map/map-service";
import { SuggestionService, type SuggestionInput } from "../../src/suggestions/suggestion-service";

export const suggestionRecord = (
  id: string,
  path: string,
  overrides: Partial<DocumentRecord> = {},
): DocumentRecord => ({
  id,
  path,
  basename: path.split("/").at(-1)?.replace(/\.md$/iu, "") ?? id,
  kind: "unclassified",
  title: id,
  aliases: [],
  headings: [],
  tags: [],
  ownedFields: {},
  relationFields: {},
  outgoingLinks: [],
  tokens: [],
  mtime: 10,
  size: 20,
  contentHash: `hash-${id}`,
  ...overrides,
});

export function suggestionFixture(): Readonly<{
  service: SuggestionService;
  input: SuggestionInput;
}> {
  const records = [
    suggestionRecord("classified", "Notes/FolderKind.md", { title: "Folder Kind" }),
    suggestionRecord("move", "Inbox/Move.md", {
      kind: "reference",
      title: "Move",
      ownedFields: { "knowledge-workbench-kind": "reference" },
    }),
    suggestionRecord("rename", "Inbox/Untitled.md", { title: "Visible Title" }),
    suggestionRecord("related", "Notes/Related.md", { title: "Related" }),
    suggestionRecord("target", "Notes/Target.md", { kind: "note", title: "Target" }),
  ] satisfies readonly DocumentRecord[];
  const classifications: Readonly<Record<string, ClassificationResult>> = {
    classified: { kind: "note", reason: "folder-rule:Notes" },
    move: { kind: "reference", reason: "explicit-property" },
    rename: { kind: "unclassified", reason: "no-rule" },
    related: { kind: "unclassified", reason: "no-rule" },
    target: { kind: "note", reason: "explicit-property" },
  };
  const relations: readonly MapEdge[] = [{
    sourceId: "related",
    targetId: "target",
    score: 90,
    reasons: [{ code: "explicit-link", weight: 80 }],
    confirmed: true,
  }];
  return {
    service: new SuggestionService(),
    input: {
      records,
      classifications,
      folderRules: [{ prefix: "Notes", kind: "note" }, { prefix: "Library", kind: "reference" }],
      relations,
    },
  };
}
