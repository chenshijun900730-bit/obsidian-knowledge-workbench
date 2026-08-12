import { describe, expect, it } from "vitest";
import type { App, CachedMetadata, EventRef, TAbstractFile, TFile } from "obsidian";
import type { FieldState, OwnedField } from "../../src/core/types";
import { ObsidianVaultAdapter } from "../../src/adapters/obsidian-vault-adapter";

class HostFile {
  path: string;
  name: string;
  basename: string;
  extension = "md";
  stat = { ctime: 1, mtime: 1, size: 10 };
  vault = null;
  parent = null;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").at(-1) ?? path;
    this.basename = this.name.replace(/\.md$/u, "");
  }
}

type EventCallback = (...args: readonly unknown[]) => void;

const normalize = (path: string): string => path.normalize("NFC")
  .replaceAll("\\", "/")
  .replace(/\/{2,}/gu, "/")
  .replace(/^\/+|\/+$/gu, "");

const frontMatterInfo = (content: string) => {
  if (!content.startsWith("---\n")) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { exists: true, frontmatter: "MALFORMED", from: 4, to: content.length, contentStart: content.length };
  return {
    exists: true,
    frontmatter: content.slice(4, end),
    from: 4,
    to: end,
    contentStart: end + 5,
  };
};

const parseYaml = (yaml: string): Record<string, unknown> => {
  if (yaml === "MALFORMED" || yaml.includes("[broken")) throw new Error("malformed-yaml");
  const result: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 0) throw new Error("malformed-yaml");
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (raw.startsWith("[")) result[key] = JSON.parse(raw);
    else if (/^-?\d+(?:\.\d+)?$/u.test(raw)) result[key] = Number(raw);
    else result[key] = raw.replace(/^['"]|['"]$/gu, "");
  }
  return result;
};

const adapterFixture = (raw = "# A\n") => {
  const files = new Map<string, HostFile>();
  const contents = new Map<string, string>();
  const callbacks = new Map<string, EventCallback>();
  let afterNextRead: ((file: HostFile) => void) | null = null;
  let beforeNextFrontmatterCallback: ((file: HostFile) => void) | null = null;
  const resolvedLinks: Record<string, Record<string, number>> = {};
  const addFile = (path: string, content = `# ${path}\n`): HostFile => {
    const file = new HostFile(path);
    files.set(path, file);
    contents.set(path, content);
    resolvedLinks[path] = {};
    return file;
  };
  const source = addFile("a.md", raw);
  const vault = {
    readCalls: 0,
    getMarkdownFiles: (): TFile[] => [...files.values()] as unknown as TFile[],
    getAbstractFileByPath: (path: string): TAbstractFile | null => files.get(path) as unknown as TAbstractFile ?? null,
    cachedRead: async (file: HostFile): Promise<string> => contents.get(file.path) ?? "",
    read: async (file: HostFile): Promise<string> => {
      vault.readCalls += 1;
      const content = contents.get(file.path) ?? "";
      const hook = afterNextRead;
      afterNextRead = null;
      hook?.(file);
      return content;
    },
    on: (name: string, callback: EventCallback): EventRef => {
      callbacks.set(name, callback);
      return { name };
    },
  };
  const metadataCache = {
    resolvedLinks,
    unresolvedLinks: {},
    getFileCache: (_file: HostFile): CachedMetadata => ({}),
    getFirstLinkpathDest: (): null => null,
    on: (name: string, callback: EventCallback): EventRef => {
      callbacks.set(`metadata:${name}`, callback);
      return { name };
    },
    offref: (): void => undefined,
  };
  const fileManager = {
    renameCalls: [] as [HostFile, string][],
    processCalls: 0,
    frontmatter: {} as Record<string, unknown>,
    async renameFile(file: HostFile, target: string): Promise<void> {
      this.renameCalls.push([file, target]);
      files.delete(file.path);
      const content = contents.get(file.path) ?? "";
      contents.delete(file.path);
      file.path = target;
      files.set(target, file);
      contents.set(target, content);
    },
    async processFrontMatter(file: HostFile, change: (frontmatter: Record<string, unknown>) => void): Promise<void> {
      this.processCalls += 1;
      const info = frontMatterInfo(contents.get(file.path) ?? "");
      const frontmatter = info.exists ? parseYaml(info.frontmatter) : {};
      const hook = beforeNextFrontmatterCallback;
      beforeNextFrontmatterCallback = null;
      hook?.(file);
      change(frontmatter);
      this.frontmatter = structuredClone(frontmatter);
    },
  };
  const app = { vault, metadataCache, fileManager } as unknown as App;
  const host = {
    TFile: HostFile,
    normalizePath: normalize,
    getFrontMatterInfo: frontMatterInfo,
    parseYaml,
  };
  const adapter = new ObsidianVaultAdapter(app, () => undefined, (linktext) => ({ path: linktext, subpath: "" }), host);
  return {
    adapter,
    source,
    vault,
    fileManager,
    resolvedLinks,
    callbacks,
    files,
    contents,
    addFile,
    afterNextRead(hook: (file: HostFile) => void): void { afterNextRead = hook; },
    beforeNextFrontmatterCallback(hook: (file: HostFile) => void): void { beforeNextFrontmatterCallback = hook; },
  };
};

describe("ObsidianVaultAdapter write boundary", () => {
  it("reads the owned field from current raw file content instead of metadata cache", async () => {
    const fixture = adapterFixture("---\nknowledge-workbench-kind: reference\n---\n# A\n");

    await expect(fixture.adapter.readOwnedField("a.md", "knowledge-workbench-kind"))
      .resolves.toEqual({ present: true, value: "reference" });
    expect(fixture.vault.readCalls).toBe(1);
  });

  it.each([
    ["malformed yaml", "---\nknowledge-workbench-kind: [broken\n---\n# A\n"],
    ["unsupported value", "---\nknowledge-workbench-kind: 42\n---\n# A\n"],
  ])("returns null for %s", async (_name, raw) => {
    const fixture = adapterFixture(raw);
    await expect(fixture.adapter.readOwnedField("a.md", "knowledge-workbench-kind")).resolves.toBeNull();
  });

  it("enforces allowlist, value schema, and CAS inside processFrontMatter", async () => {
    const fixture = adapterFixture("---\nknowledge-workbench-kind: reference\n---\n# A\n");
    const absent: FieldState = { present: false };
    await expect(fixture.adapter.setOwnedField("a.md", "foreign" as OwnedField, absent, { present: true, value: "x" }))
      .rejects.toThrow(/owned|field|allow/iu);
    await expect(fixture.adapter.setOwnedField(
      "a.md",
      "knowledge-workbench-kind",
      { present: true, value: "note" },
      { present: true, value: 42 } as unknown as FieldState,
    )).rejects.toThrow(/schema|value|field|changed/iu);
    await expect(fixture.adapter.setOwnedField(
      "a.md",
      "knowledge-workbench-kind",
      { present: true, value: "note" },
      { present: false },
    )).rejects.toThrow(/changed/iu);
    expect(fixture.fileManager.processCalls).toBe(1);

    await fixture.adapter.setOwnedField(
      "a.md",
      "knowledge-workbench-kind",
      { present: true, value: "reference" },
      { present: true, value: "note" },
    );
    expect(fixture.fileManager.frontmatter).toMatchObject({ "knowledge-workbench-kind": "note" });
  });

  it("rejects a non-exact field state before public mutation", async () => {
    const fieldFixture = adapterFixture("---\nknowledge-workbench-kind: reference\n---\n# A\n");
    await expect(fieldFixture.adapter.setOwnedField(
      "a.md",
      "knowledge-workbench-kind",
      { present: true, value: "reference" },
      { present: true, value: "note", extra: true } as unknown as FieldState,
    )).rejects.toThrow(/schema|field/iu);
    expect(fieldFixture.fileManager.processCalls).toBe(0);
  });

  it("rejects a non-exact file precondition before public mutation", async () => {
    const renameFixture = adapterFixture();
    const expectedSource = await renameFixture.adapter.snapshot("a.md");
    const nonExactTarget = { path: "x.md", exists: false, mtime: 1, contentHash: "forbidden" } as const;
    await expect(renameFixture.adapter.renameFile(
      "a.md",
      "x.md",
      expectedSource,
      nonExactTarget,
    )).rejects.toThrow(/precondition|schema|target/iu);
    expect(renameFixture.fileManager.renameCalls).toEqual([]);
  });

  it("rejects when the resolved file path drifts before the frontmatter callback without changing data", async () => {
    const fixture = adapterFixture("---\nknowledge-workbench-kind: reference\n---\n# A\n");
    fixture.beforeNextFrontmatterCallback((file) => { file.path = "drifted.md"; });

    await expect(fixture.adapter.setOwnedField(
      "a.md",
      "knowledge-workbench-kind",
      { present: true, value: "reference" },
      { present: true, value: "note" },
    )).rejects.toThrow(/changed|path|identity/iu);

    expect(fixture.fileManager.frontmatter).toEqual({});
  });

  it.each(["bad?.md", "CON/note.md", "../escape.md"])(
    "rejects unsafe rename target %s inside the adapter with zero mutation",
    async (target) => {
      const fixture = adapterFixture();
      const expectedSource = await fixture.adapter.snapshot("a.md");

      await expect(fixture.adapter.renameFile("a.md", target, expectedSource, { path: target, exists: false }))
        .rejects.toThrow(/invalid|path|target/iu);
      expect(fixture.fileManager.renameCalls).toEqual([]);
    },
  );

  it.each(["../a.md", "CON/note.md", "bad?/note.md"])(
    "rejects unsafe resolvable rename source %s before the public rename call",
    async (sourcePath) => {
      const fixture = adapterFixture();
      fixture.addFile(sourcePath);
      const expectedSource = await fixture.adapter.snapshot(sourcePath);
      const expectedTarget = await fixture.adapter.snapshot("safe.md");

      await expect(fixture.adapter.renameFile(
        sourcePath,
        "safe.md",
        expectedSource,
        expectedTarget,
      )).rejects.toThrow(/invalid|path|source/iu);
      expect(fixture.fileManager.renameCalls).toEqual([]);
    },
  );

  it.each(["../a.md", "CON/note.md", "bad?/note.md"])(
    "rejects unsafe resolvable owned-field path %s before processFrontMatter",
    async (path) => {
      const fixture = adapterFixture();
      fixture.addFile(path, "---\nknowledge-workbench-kind: reference\n---\n# A\n");

      await expect(fixture.adapter.setOwnedField(
        path,
        "knowledge-workbench-kind",
        { present: true, value: "reference" },
        { present: true, value: "note" },
      )).rejects.toThrow(/invalid|path|source/iu);
      expect(fixture.fileManager.processCalls).toBe(0);
    },
  );

  it("rejects raw source drift that occurs while the final source read is awaiting", async () => {
    const fixture = adapterFixture();
    const expectedSource = await fixture.adapter.snapshot("a.md");
    const expectedTarget = await fixture.adapter.snapshot("x.md");
    fixture.afterNextRead((file) => { file.stat.mtime += 1; });

    await expect(fixture.adapter.renameFile("a.md", "x.md", expectedSource, expectedTarget)).rejects.toThrow(/changed/iu);
    expect(fixture.fileManager.renameCalls).toEqual([]);
  });

  it.each(["source", "case", "metadata", "inbound"] as const)(
    "blocks %s drift at the final rename boundary with zero public mutation",
    async (kind) => {
      const fixture = adapterFixture();
      const expectedSource = await fixture.adapter.snapshot("a.md");
      const expectedTarget = await fixture.adapter.snapshot("x.md");
      if (kind === "source") {
        fixture.source.stat.mtime += 1;
        fixture.contents.set("a.md", "changed\n");
      } else if (kind === "case") fixture.addFile("X.md");
      else if (kind === "metadata") {
        fixture.adapter.startMetadataTracking();
        fixture.callbacks.get("metadata:changed")?.(fixture.source);
      } else fixture.resolvedLinks["linker.md"] = { "a.md": 1 };

      await expect(fixture.adapter.renameFile("a.md", "x.md", expectedSource, expectedTarget)).rejects.toThrow();
      expect(fixture.fileManager.renameCalls).toEqual([]);
      expect(fixture.files.has("a.md")).toBe(true);
      expect(fixture.files.has("x.md")).toBe(false);
    },
  );

  it("renames through the public file manager only after every final check passes", async () => {
    const fixture = adapterFixture();
    const expectedSource = await fixture.adapter.snapshot("a.md");
    const expectedTarget = await fixture.adapter.snapshot("x.md");

    await fixture.adapter.renameFile("a.md", "x.md", expectedSource, expectedTarget);

    expect(fixture.fileManager.renameCalls).toHaveLength(1);
    expect(fixture.files.has("a.md")).toBe(false);
    expect(fixture.files.has("x.md")).toBe(true);
  });
});
