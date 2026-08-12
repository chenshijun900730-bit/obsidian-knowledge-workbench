import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const HEAVY_TIMEOUT_MS = 600_000;
const SUCCESS_MESSAGE = "Installed the bound read-only acceptance build into the fixed synthetic vault; Obsidian was not started.\n";
const FAILURE_PREFIX = "Synthetic acceptance installation failed";
const FORBIDDEN_PROJECT_OVERRIDE = /^KNOWLEDGE_WORKBENCH_.*(?:ROOT|PATH|VAULT|FIXTURE|ARTIFACT|MODE|LEASE|OUTPUT|RECEIPT|SEED)$/u;
const ALLOWED_FAILURE_CATEGORIES = Object.freeze([
  "invalid-invocation",
  "artifact-invalid",
  "artifact-changed",
  "fixture-invalid",
  "fixture-changed",
  "plugin-enabled",
  "target-exists",
  "concurrent-operation",
  "rollback-incomplete",
  "cleanup-incomplete",
] as const);
const roots: string[] = [];

interface CliFixture {
  readonly repoRoot: string;
  readonly resultPath: string;
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}, HEAVY_TIMEOUT_MS);

async function fixture(): Promise<CliFixture> {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "kwb-acceptance-install-cli-")));
  roots.push(repoRoot);
  const scriptsPath = join(repoRoot, "scripts");
  await mkdir(scriptsPath);
  await writeFile(
    join(scriptsPath, "install-acceptance-dev-cli.mjs"),
    await readFile(join(projectRoot, "scripts", "install-acceptance-dev-cli.mjs")),
  );
  await writeFile(join(scriptsPath, "install-acceptance-dev.mjs"), [
    'import { writeFile } from "node:fs/promises";',
    "const trustedFailures = new WeakSet();",
    "function extractFailureCategory(error) {",
    "  if (!trustedFailures.has(error)) return null;",
    "  const descriptor = Object.getOwnPropertyDescriptor(error, 'category');",
    "  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'",
    "    ? descriptor.value",
    "    : null;",
    "}",
    "export async function installAcceptanceDevelopment(options) {",
    "  const evidence = {",
    "    ownKeys: Reflect.ownKeys(options).map((key) => typeof key === 'symbol' ? `symbol:${String(key.description)}` : key),",
    "    options,",
    "  };",
    "  await writeFile(process.env.KNOWLEDGE_WORKBENCH_CLI_RESULT, JSON.stringify(evidence), 'utf8');",
    "  const failure = process.env.KNOWLEDGE_WORKBENCH_CLI_FAILURE;",
    "  if (failure === 'primitive') throw 'secret primitive /tmp/private';",
    "  if (failure) {",
    "    const nested = new Error('/tmp/private/Generated/00000/note-00000.md sha256:deadbeef endpoint model secret');",
    "    const error = new Error('raw {json} hook context lease /tmp/private', { cause: nested });",
    "    Object.defineProperty(error, 'privateEvidence', { value: { hookContext: '/tmp/hook', lease: 'forged' } });",
    "    if (failure === 'accessor') {",
    "      Object.defineProperty(error, 'category', { get() { throw new Error('category getter secret'); } });",
    "    } else if (failure === 'unknown') {",
    "      error.category = 'private-category';",
    "    } else if (failure === 'foreign-allowed') {",
    "      error.category = 'cleanup-incomplete';",
    "    } else {",
    "      error.category = failure;",
    "      trustedFailures.add(error);",
    "    }",
    "    throw error;",
    "  }",
    "  return Object.freeze({ runId: '123e4567-e89b-42d3-a456-426614174000', pluginVersion: '0.1.0', artifactBinding: 'a'.repeat(64) });",
    "}",
    "Object.defineProperty(installAcceptanceDevelopment, 'extractFailureCategory', {",
    "  configurable: false,",
    "  enumerable: false,",
    "  value: Object.freeze(extractFailureCategory),",
    "  writable: false,",
    "});",
    "Object.freeze(installAcceptanceDevelopment);",
    "",
  ].join("\n"), "utf8");
  return Object.freeze({ repoRoot, resultPath: join(repoRoot, "result.json") });
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    name !== "OBSIDIAN_DEV_VAULT" && !FORBIDDEN_PROJECT_OVERRIDE.test(name)
  )));
}

async function runCli(
  value: CliFixture,
  args: readonly string[] = [],
  overrides: Readonly<Record<string, string>> = {},
): Promise<Readonly<CliResult>> {
  const child = spawn(process.execPath, [
    join(value.repoRoot, "scripts", "install-acceptance-dev-cli.mjs"),
    ...args,
  ], {
    cwd: tmpdir(),
    env: {
      ...baseEnvironment(),
      KNOWLEDGE_WORKBENCH_CLI_RESULT: value.resultPath,
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  return Object.freeze({ code, stdout, stderr });
}

async function expectCoreNotInvoked(resultPath: string): Promise<void> {
  await expect(readFile(resultPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

describe("synthetic acceptance installation CLI", () => {
  it("derives the wrapper repository root, passes only repoRoot, and emits the exact success sentence", async () => {
    const value = await fixture();

    const result = await runCli(value, [], {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/tmp/kwb-cli-home",
      PWD: "/tmp/kwb-cli-pwd",
      TMPDIR: "/tmp",
    });

    expect(result).toEqual({ code: 0, stdout: SUCCESS_MESSAGE, stderr: "" });
    expect(JSON.parse(await readFile(value.resultPath, "utf8"))).toEqual({
      ownKeys: ["repoRoot"],
      options: { repoRoot: resolve(await realpath(value.repoRoot)) },
    });
  }, HEAVY_TIMEOUT_MS);

  it("rejects every argument without invoking the installer", async () => {
    for (const args of [
      ["elsewhere"],
      ["--repo-root", "elsewhere"],
      ["--vault", "elsewhere"],
      ["--fixture", "tiny"],
      ["--artifact", "elsewhere"],
      ["--mode", "read-only-acceptance"],
      ["--lease", "forged"],
      ["--output", "elsewhere"],
      ["--receipt", "elsewhere"],
      ["--seed", "elsewhere"],
    ]) {
      const value = await fixture();

      const result = await runCli(value, args);

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: `${FAILURE_PREFIX}: invalid-invocation.\n`,
      });
      await expectCoreNotInvoked(value.resultPath);
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects every vault, path, fixture, artifact, mode, lease, output, receipt, or seed environment override", async () => {
    for (const [name, override] of [
      ["OBSIDIAN_DEV_VAULT", "/tmp/other-vault"],
      ["KNOWLEDGE_WORKBENCH_REPO_ROOT", "/tmp/other-root"],
      ["KNOWLEDGE_WORKBENCH_TARGET_PATH", "/tmp/other-target"],
      ["KNOWLEDGE_WORKBENCH_TARGET_VAULT", "/tmp/other-vault"],
      ["KNOWLEDGE_WORKBENCH_FIXTURE", "tiny"],
      ["KNOWLEDGE_WORKBENCH_SOURCE_ARTIFACT", "/tmp/other-artifact"],
      ["KNOWLEDGE_WORKBENCH_INSTALL_MODE", "normal"],
      ["KNOWLEDGE_WORKBENCH_ARTIFACT_LEASE", "forged"],
      ["KNOWLEDGE_WORKBENCH_OUTPUT", "/tmp/output"],
      ["KNOWLEDGE_WORKBENCH_RECEIPT", "/tmp/receipt"],
      ["KNOWLEDGE_WORKBENCH_SEED", "/tmp/seed"],
    ] as const) {
      const value = await fixture();

      const result = await runCli(value, [], { [name]: override });

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: `${FAILURE_PREFIX}: invalid-invocation.\n`,
      });
      await expectCoreNotInvoked(value.resultPath);
    }
  }, HEAVY_TIMEOUT_MS);

  it("prints every trusted installer category exactly and exits nonzero", async () => {
    for (const category of ALLOWED_FAILURE_CATEGORIES) {
      const value = await fixture();

      const result = await runCli(value, [], { KNOWLEDGE_WORKBENCH_CLI_FAILURE: category });

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: `${FAILURE_PREFIX}: ${category}.\n`,
      });
    }
  }, HEAVY_TIMEOUT_MS);

  it("maps unknown, primitive, and hostile category accessors to artifact-invalid without leaking evidence", async () => {
    for (const failure of ["unknown", "primitive", "accessor"]) {
      const value = await fixture();

      const result = await runCli(value, [], { KNOWLEDGE_WORKBENCH_CLI_FAILURE: failure });

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: `${FAILURE_PREFIX}: artifact-invalid.\n`,
      });
      expect(result.stderr).not.toMatch(/\/tmp|Generated|\.md|sha256|deadbeef|\{|json|endpoint|model|secret|hook|context|lease|forged|private/iu);
    }
  }, HEAVY_TIMEOUT_MS);

  it("maps a plain foreign Error with an allowed own category to artifact-invalid", async () => {
    const value = await fixture();

    const result = await runCli(value, [], {
      KNOWLEDGE_WORKBENCH_CLI_FAILURE: "foreign-allowed",
    });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `${FAILURE_PREFIX}: artifact-invalid.\n`,
    });
    expect(result.stderr).not.toMatch(/\/tmp|Generated|\.md|sha256|deadbeef|\{|json|endpoint|model|secret|hook|context|lease|forged|private/iu);
  }, HEAVY_TIMEOUT_MS);
});
