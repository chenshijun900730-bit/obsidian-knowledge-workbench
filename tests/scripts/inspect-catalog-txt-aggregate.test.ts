import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("inspect catalog TXT aggregate CLI", () => {
  it("prints only approved aggregate fields and never echoes the source path or filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-txt-aggregate-"));
    roots.push(root);
    const input = join(root, "do-not-echo-private-tree.txt");
    await writeFile(
      input,
      "├── PrivateCategory\n│   ├── PrivateAlpha.pdf\n│   └── PrivateBeta.pdf\n",
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/inspect-catalog-txt-aggregate.mjs", input],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const value = JSON.parse(stdout) as Record<string, unknown>;

    expect(Object.keys(value)).toEqual([
      "source_sha256",
      "byte_size",
      "nonempty_lines",
      "pdf_count",
      "directory_count",
      "ignored_leaf_count",
      "duplicate_pdf_paths",
      "max_depth",
      "within_70000_limit",
    ]);
    expect(value).toMatchObject({
      byte_size: Buffer.byteLength(
        "├── PrivateCategory\n│   ├── PrivateAlpha.pdf\n│   └── PrivateBeta.pdf\n",
      ),
      nonempty_lines: 3,
      pdf_count: 2,
      directory_count: 1,
      ignored_leaf_count: 0,
      duplicate_pdf_paths: 0,
      max_depth: 2,
      within_70000_limit: true,
    });
    expect(value.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(input);
    expect(stdout).not.toContain("PrivateCategory");
    expect(stdout).not.toContain("PrivateAlpha.pdf");
    expect(stdout).not.toContain("PrivateBeta.pdf");
  });
});
