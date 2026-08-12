import { describe, expect, it } from "vitest";
import { validateTargetPath } from "../../../src/core/path-policy";

describe("validateTargetPath", () => {
  it("rejects an existing or case-colliding target", () => {
    const paths = new Set(["资料库/AI/Note.md"]);
    expect(validateTargetPath("inbox/a.md", "资料库/AI/Note.md", paths)).toEqual({ ok: false, code: "target-exists" });
    expect(validateTargetPath("inbox/a.md", "资料库/ai/note.md", paths)).toEqual({ ok: false, code: "case-collision" });
  });

  it.each(["bad?.md", "bad:name.md", "folder./name.md", "folder/name .md", "nul\u0000.md", "CON.md"])("rejects non-portable path %s", (target) => {
    expect(validateTargetPath("inbox/a.md", target, new Set())).toEqual({ ok: false, code: "invalid-path" });
  });

  it.each(["CON/fine.md", "safe/NUL.txt.md", "safe/COM1.log/item.md"])("rejects a reserved device basename in any segment: %s", (target) => {
    expect(validateTargetPath("inbox/a.md", target, new Set())).toEqual({ ok: false, code: "invalid-path" });
  });
});
