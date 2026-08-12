import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCatalogTxtSourceAdapter } from "../../../src/adapters/local-catalog-txt-source-adapter";
import { HybridCatalogError } from "../../../src/catalog/hybrid-catalog-types";

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-txt-")));
  roots.push(root);
  return root;
};

const collect = async (source: Awaited<ReturnType<LocalCatalogTxtSourceAdapter["open"]>>): Promise<Uint8Array> => {
  const chunks: number[] = [];
  for await (const chunk of source.chunks()) chunks.push(...chunk);
  return Uint8Array.from(chunks);
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalCatalogTxtSourceAdapter", () => {
  it("opens one regular file as a one-shot byte source", async () => {
    const root = await temporaryRoot();
    const path = join(root, "inventory.txt");
    const content = new TextEncoder().encode("├── A.pdf\n");
    await writeFile(path, content);
    const source = await new LocalCatalogTxtSourceAdapter().open(path);

    expect(source.byteSize).toBe(content.byteLength);
    expect(await collect(source)).toEqual(content);
    await expect(collect(source)).rejects.toEqual(
      new HybridCatalogError("txt-source-unavailable"),
    );
  });

  it("rejects a missing file, directory, symlink, and empty path with one safe code", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "directory");
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await mkdir(directory);
    await writeFile(target, "safe\n", "utf8");
    await symlink(target, link);

    for (const path of [join(root, "missing.txt"), directory, link, ""]) {
      await expect(new LocalCatalogTxtSourceAdapter().open(path)).rejects.toEqual(
        new HybridCatalogError("txt-source-unavailable"),
      );
      try {
        await new LocalCatalogTxtSourceAdapter().open(path);
      } catch (error) {
        expect((error as Error).message).toBe("txt-source-unavailable");
        if (path.length > 0) expect((error as Error).message).not.toContain(path);
      }
    }
  });

  it("fails closed if a regular file becomes a symlink before streaming", async () => {
    const root = await temporaryRoot();
    const path = join(root, "inventory.txt");
    const target = join(root, "target.txt");
    await writeFile(path, "├── A.pdf\n", "utf8");
    await writeFile(target, "├── B.pdf\n", "utf8");
    const source = await new LocalCatalogTxtSourceAdapter().open(path);
    await rm(path);
    await symlink(target, path);

    await expect(collect(source)).rejects.toEqual(
      new HybridCatalogError("txt-source-unavailable"),
    );
  });

  it("detects a file change between the first chunk and EOF", async () => {
    const root = await temporaryRoot();
    const path = join(root, "inventory.txt");
    await writeFile(path, "A".repeat(131_072), "utf8");
    const source = await new LocalCatalogTxtSourceAdapter().open(path);
    const iterator = source.chunks()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await writeFile(path, "B".repeat(131_073), "utf8");

    await expect(iterator.next()).rejects.toEqual(
      new HybridCatalogError("txt-source-unavailable"),
    );
  });
});
