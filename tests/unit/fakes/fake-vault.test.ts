import { describe, expect, it } from "vitest";
import type { VaultEvent } from "../../../src/core/ports";
import type { FieldState, OwnedField } from "../../../src/core/types";
import { FakeVault } from "../../fakes/fake-vault";

const TOPICS_FIELD: OwnedField = "knowledge-workbench-topics";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item): item is string => typeof item === "string");

describe("FakeVault", () => {
  it("isolates stored frontmatter arrays from input and returned-note mutation", async () => {
    const topics = ["AI"];
    const vault = FakeVault.withNotes(["note.md"]);
    vault.setOwnedFieldExternally("note.md", TOPICS_FIELD, topics);
    topics.push("mutated-input");

    const first = await vault.readNote("note.md");
    if (first === null) throw new Error("expected note.md");
    const returnedTopics = first.frontmatter[TOPICS_FIELD];
    if (!isStringArray(returnedTopics)) throw new Error("expected string-array topics");
    returnedTopics.push("mutated-output");

    expect((await vault.readNote("note.md"))?.frontmatter[TOPICS_FIELD]).toEqual(["AI"]);
  });

  it("records rename bookkeeping, events, and write calls", async () => {
    const vault = FakeVault.withNotes(["source.md", "target.md"])
      .setInboundLinks("target.md", ["source.md"]);
    const events: VaultEvent[] = [];
    const unsubscribe = vault.subscribe((event) => events.push(event));

    await vault.renameFile(
      "source.md",
      "renamed.md",
      await vault.snapshot("source.md"),
      await vault.snapshot("renamed.md"),
    );

    expect(await vault.listMarkdownPaths()).toEqual(["renamed.md", "target.md"]);
    expect(await vault.inboundLinks("target.md")).toEqual(["renamed.md"]);
    expect(events).toEqual([{ kind: "rename", path: "renamed.md", oldPath: "source.md" }]);
    expect(vault.renameFileCalls).toEqual([{ sourcePath: "source.md", targetPath: "renamed.md" }]);
    expect(vault.writeCalls).toEqual([{ kind: "rename-file", sourcePath: "source.md", targetPath: "renamed.md" }]);

    unsubscribe();
    vault.modifyExternally("renamed.md");
    expect(events).toHaveLength(1);
  });

  it("removes a deleted source from every inbound-link list", async () => {
    const vault = FakeVault.withNotes(["linked.md", "source.md"])
      .setInboundLinks("source.md", ["linked.md"]);

    vault.applyEvent("delete", "linked.md");

    expect(await vault.inboundLinks("source.md")).toEqual([]);
  });

  it("returns null for a present owned field with an invalid raw value", async () => {
    const vault = FakeVault.withNotes(["note.md"]);
    vault.setOwnedFieldExternally("note.md", TOPICS_FIELD, [42]);

    expect(await vault.readOwnedField("note.md", TOPICS_FIELD)).toBeNull();
  });

  it("does not let an invalid present field pass an absent-state CAS", async () => {
    const vault = FakeVault.withNotes(["note.md"]);
    vault.setOwnedFieldExternally("note.md", TOPICS_FIELD, [42]);

    await expect(vault.setOwnedField(
      "note.md",
      TOPICS_FIELD,
      { present: false },
      { present: true, value: ["safe"] },
    )).rejects.toThrow();
    expect(await vault.readOwnedField("note.md", TOPICS_FIELD)).toBeNull();
  });

  it("records failed CAS write attempts without mutating the field", async () => {
    const vault = FakeVault.withNotes(["note.md"]);
    vault.setOwnedFieldExternally("note.md", TOPICS_FIELD, "existing");
    const expected: FieldState = { present: false };
    const next: FieldState = { present: true, value: ["AI"] };

    await expect(vault.setOwnedField("note.md", TOPICS_FIELD, expected, next))
      .rejects.toThrow("field-precondition-failed:note.md:knowledge-workbench-topics");

    expect(vault.setOwnedFieldCalls).toEqual([{ path: "note.md", field: TOPICS_FIELD, expected, next }]);
    expect(vault.writeCalls).toEqual([{ kind: "set-owned-field", path: "note.md", field: TOPICS_FIELD, expected, next }]);
    expect(await vault.readOwnedField("note.md", TOPICS_FIELD)).toEqual({ present: true, value: "existing" });
  });

  it("allows only one concurrent owned-field CAS with the same expected state", async () => {
    const vault = FakeVault.withNotes(["note.md"]);
    const expected: FieldState = { present: false };

    const results = await Promise.allSettled([
      vault.setOwnedField("note.md", TOPICS_FIELD, expected, { present: true, value: ["first"] }),
      vault.setOwnedField("note.md", TOPICS_FIELD, expected, { present: true, value: ["second"] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await vault.readOwnedField("note.md", TOPICS_FIELD)).toEqual(expect.objectContaining({ present: true }));
  });

  it("rejects rename when the source no longer matches its expected snapshot", async () => {
    const vault = FakeVault.withNotes(["source.md"]);
    const expectedSource = await vault.snapshot("source.md");
    const expectedTarget = await vault.snapshot("renamed.md");
    vault.modifyExternally("source.md");

    await expect(vault.renameFile("source.md", "renamed.md", expectedSource, expectedTarget))
      .rejects.toThrow(/precondition|source|changed/iu);

    expect(await vault.listMarkdownPaths()).toEqual(["source.md"]);
  });
});
