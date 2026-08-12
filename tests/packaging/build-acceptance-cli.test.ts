import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<{ repoRoot: string; resultPath: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "knowledge-workbench-acceptance-cli-"));
  roots.push(repoRoot);
  const scripts = join(repoRoot, "scripts");
  await mkdir(scripts);
  const wrapper = await readFile(join(projectRoot, "scripts", "build-acceptance.mjs"), "utf8").catch(() => "");
  await writeFile(join(scripts, "build-acceptance.mjs"), wrapper, "utf8");
  await writeFile(
    join(scripts, "acceptance-build.mjs"),
    [
      'import { writeFile } from "node:fs/promises";',
      "export async function buildAcceptanceArtifact(options) {",
      '  await writeFile(process.env.KNOWLEDGE_WORKBENCH_CLI_RESULT, JSON.stringify(options), "utf8");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return { repoRoot, resultPath: join(repoRoot, "result.json") };
}

async function runWrapper(
  repoRoot: string,
  resultPath: string,
  args: readonly string[],
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [join(repoRoot, "scripts", "build-acceptance.mjs"), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, KNOWLEDGE_WORKBENCH_CLI_RESULT: resultPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  return { code, stderr };
}

describe("acceptance build CLI wiring", () => {
  it("invokes the acceptance builder for the wrapper repository root", async () => {
    const value = await fixture();

    const result = await runWrapper(value.repoRoot, value.resultPath, []);

    expect(result).toEqual({ code: 0, stderr: "" });
    const invocation = await readFile(value.resultPath, "utf8").catch(() => "null");
    expect(JSON.parse(invocation)).toEqual({ repoRoot: resolve(await realpath(value.repoRoot)) });
  });

  it("rejects every positional, output, lease, mode, or artifact-path argument without invoking the builder", async () => {
    for (const args of [
      ["elsewhere"],
      ["--output", "elsewhere"],
      ["--lease", "forged"],
      ["--mode", "read-only-acceptance"],
      ["--artifact-path", "elsewhere"],
    ]) {
      const value = await fixture();

      const result = await runWrapper(value.repoRoot, value.resultPath, args);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("does not accept arguments");
      await expect(readFile(value.resultPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps normal scripts separate and adds the exact build, preparation, and installation acceptance commands", async () => {
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts).toMatchObject({
      dev: "node esbuild.config.mjs development normal",
      build: "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production normal",
      "build:acceptance": "tsc -noEmit -skipLibCheck && node scripts/build-acceptance.mjs",
      "install:dev": "npm run build && node scripts/install-dev.mjs",
      "prepare:acceptance:synthetic": "node scripts/prepare-acceptance-synthetic-cli.mjs",
      "install:acceptance:dev": "node scripts/install-acceptance-dev-cli.mjs",
    });
    expect(packageJson.scripts?.["install:dev"]).not.toContain("acceptance");
    expect(packageJson.scripts?.["install:acceptance:dev"]).not.toContain("install-dev.mjs");
    const eslintConfig = await readFile(join(projectRoot, "eslint.config.mts"), "utf8");
    expect(eslintConfig).toContain('"dist/**"');
  });
});
