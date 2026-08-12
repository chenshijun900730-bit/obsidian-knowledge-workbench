import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function nestedTemporaryRoot(prefix: string): Promise<string> {
  const container = await temporaryRoot(prefix);
  const root = join(container, "root");
  await mkdir(root);
  return root;
}

export async function regularFileFixture(bytes = "SAFE-BYTES"): Promise<Readonly<{
  root: string;
  path: string;
  hardLink: string;
}>> {
  const root = await temporaryRoot("knowledge-workbench-safe-file-");
  const path = join(root, "value.txt");
  await writeFile(path, bytes, "utf8");
  return Object.freeze({ root, path, hardLink: join(root, "value-hard-link.txt") });
}

export async function exactDirectoryFixture(): Promise<Readonly<{
  root: string;
  names: readonly string[];
}>> {
  const root = await temporaryRoot("knowledge-workbench-exact-directory-");
  await writeFile(join(root, "alpha.txt"), "ALPHA", "utf8");
  await writeFile(join(root, "beta.txt"), "BETA", "utf8");
  return Object.freeze({ root, names: Object.freeze(["alpha.txt", "beta.txt"]) });
}

export async function ownedTreeFixture(): Promise<Readonly<{
  root: string;
  allowlist: readonly string[];
}>> {
  const root = await nestedTemporaryRoot("knowledge-workbench-owned-tree-");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "value.txt"), "NESTED", "utf8");
  await writeFile(join(root, "top.txt"), "TOP", "utf8");
  return Object.freeze({
    root,
    allowlist: Object.freeze(["nested", "nested/value.txt", "top.txt"]),
  });
}

export async function emptyDirectoryFixture(): Promise<string> {
  return nestedTemporaryRoot("knowledge-workbench-empty-directory-");
}

export async function cleanupAcceptanceFsFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}
