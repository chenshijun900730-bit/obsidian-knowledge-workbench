import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeReadOnlyAcceptanceReport,
  decodeHostObservation,
  decodeReadOnlyAcceptanceReport,
  encodeReadOnlyAcceptanceReport,
  type LocalAcceptanceEvidence,
  type ReadOnlyAcceptanceReport,
} from "../../scripts/read-only-acceptance-report.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const HEAVY_TIMEOUT_MS = 600_000;
const RECORD_SCRIPT = "scripts/record-read-only-acceptance.mjs";
const VALIDATE_SCRIPT = "scripts/validate-read-only-acceptance.mjs";
const REPORT_NAME = "read-only-acceptance-report.json";
const LOCK_NAME = ".read-only-acceptance-report.lock";
const STAGE_PREFIX = ".read-only-acceptance-report.stage-";
const RECORD_FAILURE_PREFIX = "Read-only acceptance recording failed";
const RECORD_SUCCESS = "Recorded the terminal read-only acceptance report.\n";
const VALIDATE_FAILURE_PREFIX = "Read-only acceptance report validation failed";
const VALIDATE_SUCCESS_PREFIX = "Read-only acceptance report is valid";
const PENDING_MESSAGE = "Read-only acceptance report is pending.\n";
const FORBIDDEN_OVERRIDE = /^KNOWLEDGE_WORKBENCH_.*(?:ROOT|PATH|VAULT|FIXTURE|ARTIFACT|MODE|LEASE|OUTPUT|RECEIPT|SEED|REPORT|LOCK|STAGE|OBSERVATION|INPUT)$/u;
const temporaryRoots: string[] = [];
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PRIVATE_SENTINEL = "/tmp/private/Generated/00000/note-00000.md sha256:deadbeef endpoint model secret";
const FOREIGN_REPORT_BYTES = Buffer.from("foreign report created at publication boundary\n", "utf8");
const POST_PUBLICATION_REPORT_BYTES = Buffer.from("post-publication report replacement\n", "utf8");
const POST_PUBLICATION_LOCK_BYTES = Buffer.from("post-publication lock replacement\n", "utf8");
const PARTIAL_LOCK_BYTES = Buffer.from("partial recorder lock residue\n", "utf8");
const FOREIGN_STAGE_BYTES = Buffer.from(
  `foreign finalize-stage replacement ${PRIVATE_SENTINEL}\n`,
  "utf8",
);
const VALIDATOR_FINAL_STAGE_NAME = `${STAGE_PREFIX}validator-final`;
const VALIDATOR_FINAL_STAGE_BYTES = Buffer.from("validator final-stage residue\n", "utf8");

const CONTEXT_KEYS = [
  "repoRoot",
  "lockPath",
  "reportStagePath",
  "reportPath",
  "statePath",
  "receiptPath",
  "targetPath",
  "runId",
  "commit",
] as const;

const AUTOMATED_SAFETY_TESTS = [
  "tests/unit/runtime/artifact-binding.test.ts",
  "tests/integration/plugin-startup-gate.test.ts",
  "tests/integration/read-only-acceptance.test.ts",
  "tests/integration/read-only-acceptance-automated-safety.test.ts",
  "tests/packaging/composition-roots.test.ts",
  "tests/packaging/read-only-acceptance-build.test.ts",
  "tests/ui/read-only-acceptance-surfaces.test.ts",
] as const;

const REPORT_KEYS = [
  "schemaVersion",
  "scope",
  "contentPolicy",
  "buildMode",
  "status",
  "recordedAt",
  "runId",
  "commit",
  "pluginVersion",
  "obsidianVersion",
  "artifactBinding",
  "syntheticNoteCount",
  "scanElapsedMs",
  "restartRestoreElapsedMs",
  "artifactIdentity",
  "fixtureIdentity",
  "automatedSafety",
  "hostIsolation",
  "banner",
  "startupNormalization",
  "quickCaptureBlocked",
  "organizationWritesBlocked",
  "undoBlocked",
  "historySensitiveActionsBlocked",
  "aiBlocked",
  "readSurfaces",
  "restartRestore",
  "contentUnchanged",
  "networkBoundary",
  "recoveryAbsent",
  "finalHostStopped",
  "failureCategories",
] as const;

interface HostObservation {
  readonly recordedAt: string;
  readonly obsidianVersion: string;
  readonly scanElapsedMs: number;
  readonly restartRestoreElapsedMs: number;
  readonly hostIsolation: "passed" | "failed" | "inconclusive";
  readonly banner: "passed" | "failed" | "inconclusive";
  readonly startupNormalization: "passed" | "failed" | "inconclusive";
  readonly quickCaptureBlocked: "passed" | "failed" | "inconclusive";
  readonly organizationWritesBlocked: "passed" | "failed" | "inconclusive";
  readonly undoBlocked: "passed" | "failed" | "inconclusive";
  readonly historySensitiveActionsBlocked: "passed" | "failed" | "inconclusive";
  readonly aiBlocked: "passed" | "failed" | "inconclusive";
  readonly readSurfaces: "passed" | "failed" | "inconclusive";
  readonly restartRestore: "passed" | "failed" | "inconclusive";
  readonly networkBoundary: "passed" | "failed" | "inconclusive";
  readonly recoveryAbsent: "passed" | "failed" | "inconclusive";
  readonly finalHostStopped: "passed" | "failed" | "inconclusive";
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type SentinelShape = "file" | "directory" | "symlink" | "fifo";
type EvidenceMode =
  | "passed"
  | "automated-failed"
  | "automated-inconclusive"
  | "failed"
  | "inconclusive"
  | "seed-unchanged"
  | "throw-private";

interface SentinelSnapshot {
  readonly shape: SentinelShape;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly payload: Buffer | string | null;
}

interface PublicationFixture {
  readonly repoRoot: string;
  readonly commit: string;
  readonly statePath: string;
  readonly receiptPath: string;
  readonly reportPath: string;
  readonly dataPath: string;
  readonly artifactPath: string;
  readonly legacyPath: string;
  readonly legacyBytes: Buffer;
  readonly controlPath: string;
  readonly evidenceModePath: string;
  readonly runnerObservationPath: string;
  readonly tracePath: string;
  readonly validatorModePath: string;
  readonly vitestPath: string;
  readonly finalizeStageRaceWitnessPath: string | null;
}

interface FinalizeStageRaceWitness {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly nlink: string;
  readonly bytesBase64: string;
}

type PostPublicationMutation = "report" | "report-and-lock";
type RecorderSafeFsFault = "stage-created-then-throw" | "lock-created-then-throw";

function validHost(
  overrides: Partial<HostObservation> = {},
): HostObservation {
  return {
    recordedAt: "2026-07-14T00:00:00.000Z",
    obsidianVersion: "1.12.7",
    scanElapsedMs: 1,
    restartRestoreElapsedMs: 1,
    hostIsolation: "passed",
    banner: "passed",
    startupNormalization: "passed",
    quickCaptureBlocked: "passed",
    organizationWritesBlocked: "passed",
    undoBlocked: "passed",
    historySensitiveActionsBlocked: "passed",
    aiBlocked: "passed",
    readSurfaces: "passed",
    restartRestore: "passed",
    networkBoundary: "passed",
    recoveryAbsent: "passed",
    finalHostStopped: "passed",
    ...overrides,
  };
}

function runGit(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeMinimalRunAnchor(repoRoot: string): Promise<Readonly<{
  commit: string;
  receiptPath: string;
  statePath: string;
}>> {
  const commit = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const state = {
    schemaVersion: 1,
    scope: "dedicated-synthetic-vault",
    contentPolicy: "deterministic-synthetic-notes-only",
    runId: RUN_ID,
    commit,
    syntheticNoteCount: 5_000,
    syntheticTotalBytes: 75 * 1024 * 1024,
    corpusDigest: `sha256:${"a".repeat(64)}`,
  };
  const stateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  const receipt = {
    schemaVersion: 1,
    runId: RUN_ID,
    commit,
    pluginVersion: "0.1.0",
    artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    artifactSetDigest: `sha256:${"b".repeat(64)}`,
    fixtureStateDigest: `sha256:${createHash("sha256").update(stateBytes).digest("hex")}`,
    seedDataDigest: `sha256:${"c".repeat(64)}`,
  };
  const statePath = join(repoRoot, ".dev-vault", "read-only-acceptance-state.json");
  const receiptPath = join(repoRoot, ".dev-vault", "read-only-acceptance-receipt.json");
  await writeFile(statePath, stateBytes, { mode: 0o600 });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return Object.freeze({ commit, receiptPath, statePath });
}

async function snapshotSentinel(path: string, shape: SentinelShape): Promise<SentinelSnapshot> {
  const stat = await lstat(path, { bigint: true });
  let payload: Buffer | string | null = null;
  if (shape === "file") payload = await readFile(path);
  if (shape === "directory") payload = await readFile(join(path, "private-marker"));
  if (shape === "symlink") payload = await readlink(path);
  expect({
    directory: stat.isDirectory(),
    fifo: stat.isFIFO(),
    file: stat.isFile(),
    symlink: stat.isSymbolicLink(),
  }).toEqual({
    directory: shape === "directory",
    fifo: shape === "fifo",
    file: shape === "file",
    symlink: shape === "symlink",
  });
  return Object.freeze({
    shape,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    payload,
  });
}

async function createSentinel(path: string, shape: SentinelShape): Promise<SentinelSnapshot> {
  if (shape === "file") {
    await writeFile(path, `${PRIVATE_SENTINEL}\n`, { mode: 0o600 });
  } else if (shape === "directory") {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "private-marker"), `${PRIVATE_SENTINEL}\n`, "utf8");
  } else if (shape === "symlink") {
    await symlink("private-sentinel-target", path);
  } else {
    execFileSync("mkfifo", [path], { stdio: ["ignore", "pipe", "pipe"] });
  }
  return await snapshotSentinel(path, shape);
}

async function expectSentinel(path: string, before: SentinelSnapshot): Promise<void> {
  expect(await snapshotSentinel(path, before.shape)).toEqual(before);
}

async function removeSentinel(path: string, shape: SentinelShape): Promise<void> {
  await rm(path, { force: true, recursive: shape === "directory" });
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await cp(source, destination, { recursive: true });
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function lightweightRepository(): Promise<string> {
  const created = await realpath(await mkdtemp(join(tmpdir(), "kwb-recorder-boundary-")));
  temporaryRoots.push(created);
  await copyIfPresent(join(projectRoot, "scripts"), join(created, "scripts"));
  await copyIfPresent(join(projectRoot, "src"), join(created, "src"));
  for (const name of ["esbuild.config.mjs", "manifest.json", "package.json", "styles.css"]) {
    await copyIfPresent(join(projectRoot, name), join(created, name));
  }
  await mkdir(join(created, "scripts"), { recursive: true });
  for (const relativePath of [RECORD_SCRIPT, VALIDATE_SCRIPT]) {
    const path = join(created, relativePath);
    try {
      await lstat(path);
    } catch {
      await writeFile(path, "", "utf8");
    }
  }
  await writeFile(
    join(created, "scripts", "read-only-acceptance-local-evidence.mjs"),
    [
      `export const AUTOMATED_SAFETY_TESTS = Object.freeze(${JSON.stringify(AUTOMATED_SAFETY_TESTS)});`,
      "export async function gatherLocalAcceptanceEvidence() {",
      '  throw new Error("Default lightweight evidence stub must not be called");',
      "}",
      "export async function validateReportAgainstCurrentEvidence() {}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(created, ".gitignore"), ".dev-vault/\ndist/\nnode_modules\n", "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: created });
  runGit(created, ["config", "user.email", "acceptance@example.invalid"]);
  runGit(created, ["config", "user.name", "Acceptance Recorder Test"]);
  runGit(created, ["config", "core.hooksPath", "/dev/null"]);
  runGit(created, ["add", "."]);
  runGit(created, ["commit", "--quiet", "-m", "recorder boundary fixture"]);
  await mkdir(join(created, ".dev-vault"), { mode: 0o700 });
  return created;
}

async function installRunnerEvidenceStubs(repoRoot: string): Promise<Readonly<{
  controlPath: string;
  evidenceModePath: string;
  runnerObservationPath: string;
  tracePath: string;
  validatorModePath: string;
  vitestPath: string;
}>> {
  const controlPath = join(repoRoot, ".dev-vault", "runner-mode");
  const evidenceModePath = join(repoRoot, ".dev-vault", "evidence-mode");
  const runnerObservationPath = join(repoRoot, ".dev-vault", "runner-observation.json");
  const tracePath = join(repoRoot, ".dev-vault", "gather-trace.jsonl");
  const validatorModePath = join(repoRoot, ".dev-vault", "validator-mode");
  const localEvidencePath = join(repoRoot, "scripts", "read-only-acceptance-local-evidence.mjs");
  await writeFile(localEvidencePath, [
    'import { execFileSync } from "node:child_process";',
    'import { appendFile, readFile, rename, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    `export const AUTOMATED_SAFETY_TESTS = Object.freeze(${JSON.stringify(AUTOMATED_SAFETY_TESTS)});`,
    "export async function gatherLocalAcceptanceEvidence(repoRoot) {",
    '  const control = (await readFile(join(repoRoot, ".dev-vault", "runner-mode"), "utf8")).trim();',
    '  const mode = (await readFile(join(repoRoot, ".dev-vault", "evidence-mode"), "utf8")).trim();',
    '  await appendFile(join(repoRoot, ".dev-vault", "gather-trace.jsonl"), `${JSON.stringify({ control })}\\n`, "utf8");',
    `  if (mode === "throw-private") throw new Error(${JSON.stringify(PRIVATE_SENTINEL)});`,
    '  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();',
    "  const base = {",
    `    runId: ${JSON.stringify(RUN_ID)},`,
    "    commit,",
    '    pluginVersion: "0.1.0",',
    '    artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",',
    "    syntheticNoteCount: 5000,",
    '    artifactIdentity: "passed",',
    '    fixtureIdentity: "passed",',
    '    automatedSafety: "passed",',
    '    contentUnchanged: "passed",',
    '    startupNormalizationEvidence: "normalized-safe",',
    '    hostIsolation: "passed",',
    '    historySensitiveActionsBlocked: "passed",',
    '    networkBoundary: "passed",',
    '    recoveryAbsent: "passed",',
    '    finalHostStopped: "passed",',
    "  };",
    '  if (mode === "passed") return Object.freeze(base);',
    '  if (mode === "automated-failed") return Object.freeze({ ...base, automatedSafety: "failed" });',
    '  if (mode === "automated-inconclusive") return Object.freeze({ ...base, automatedSafety: "inconclusive" });',
    '  if (mode === "failed") return Object.freeze({',
    "    ...base,",
    '    artifactIdentity: "failed",',
    '    fixtureIdentity: "failed",',
    '    contentUnchanged: "failed",',
    '    historySensitiveActionsBlocked: "failed",',
    '    networkBoundary: "failed",',
    '    recoveryAbsent: "failed",',
    "  });",
    '  if (mode === "inconclusive") return Object.freeze({',
    "    ...base,",
    '    artifactIdentity: "inconclusive",',
    '    fixtureIdentity: "inconclusive",',
    '    contentUnchanged: "inconclusive",',
    "  });",
    '  if (mode === "seed-unchanged") return Object.freeze({',
    "    ...base,",
    '    startupNormalizationEvidence: "seed-unchanged",',
    '    hostIsolation: "inconclusive",',
    '    finalHostStopped: "inconclusive",',
    "  });",
    '  throw new Error("Unknown evidence mode");',
    "}",
    "export async function validateReportAgainstCurrentEvidence(repoRoot) {",
    '  const devRoot = join(repoRoot, ".dev-vault");',
    '  const mode = (await readFile(join(devRoot, "validator-mode"), "utf8")).trim();',
    '  if (mode === "noop") return;',
    `  if (mode === "throw") throw new Error(${JSON.stringify(PRIVATE_SENTINEL)});`,
    '  if (mode === "create-lock") {',
    '    await writeFile(join(devRoot, ".read-only-acceptance-report.lock"), "validator-lock-replacement\\n", { flag: "wx", mode: 0o600 });',
    "    return;",
    "  }",
    '  if (mode === "create-stage") {',
    '    await writeFile(join(devRoot, ".read-only-acceptance-report.stage-validator"), "validator-stage-replacement\\n", { flag: "wx", mode: 0o600 });',
    "    return;",
    "  }",
    '  if (mode === "replace-report") {',
    '    const replacement = join(devRoot, ".validator-report-replacement");',
    '    await writeFile(replacement, "validator-report-replacement\\n", { flag: "wx", mode: 0o600 });',
    '    await rename(replacement, join(devRoot, "read-only-acceptance-report.json"));',
    "    return;",
    "  }",
    '  throw new Error("Unknown validator mode");',
    "}",
    "",
  ].join("\n"), "utf8");

  const vitestDirectory = join(repoRoot, "node_modules", "vitest");
  await mkdir(vitestDirectory, { recursive: true });
  const vitestPath = join(vitestDirectory, "vitest.mjs");
  await writeFile(vitestPath, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const devRoot = join(process.cwd(), ".dev-vault");',
    'const mode = readFileSync(join(devRoot, "runner-mode"), "utf8").trim();',
    "const envKeys = Object.keys(process.env).sort();",
    "const observation = {",
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  env: Object.fromEntries(envKeys.map((key) => [key, process.env[key]])),",
    "  mode,",
    "};",
    'writeFileSync(join(devRoot, "runner-observation.json"), JSON.stringify(observation), "utf8");',
    'if (mode === "assertion") {',
    '  process.stderr.write("Tests 1 failed\\n");',
    "  process.exitCode = 1;",
    '} else if (mode === "signal") {',
    '  process.kill(process.pid, "SIGTERM");',
    '} else if (mode === "overflow") {',
    '  process.stdout.write("x".repeat(1_100_000));',
    '} else if (mode !== "pass") {',
    "  process.exitCode = 2;",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(controlPath, "pass\n", "utf8");
  await writeFile(evidenceModePath, "passed\n", "utf8");
  await writeFile(validatorModePath, "noop\n", "utf8");

  runGit(repoRoot, ["add", "scripts/read-only-acceptance-local-evidence.mjs"]);
  runGit(repoRoot, ["commit", "--quiet", "-m", "test evidence runner stub"]);
  if (runGit(repoRoot, ["status", "--short", "--untracked-files=all"]) !== "") {
    throw new Error("Runner evidence fixture must remain clean");
  }
  return Object.freeze({
    controlPath,
    evidenceModePath,
    runnerObservationPath,
    tracePath,
    validatorModePath,
    vitestPath,
  });
}

async function installPublicationBoundaryFsShim(repoRoot: string): Promise<void> {
  const recorderPath = join(repoRoot, RECORD_SCRIPT);
  const source = await readFile(recorderPath, "utf8");
  const nodeFsImport = 'from "node:fs/promises";';
  if (!source.includes(nodeFsImport)) {
    throw new Error("Recorder must import its publication primitives from node:fs/promises");
  }
  const shimName = "publication-boundary-fs-shim.mjs";
  await writeFile(join(repoRoot, "scripts", shimName), [
    'import * as fs from "node:fs/promises";',
    'import { basename } from "node:path";',
    'export * from "node:fs/promises";',
    `const reportName = ${JSON.stringify(REPORT_NAME)};`,
    `const stagePrefix = ${JSON.stringify(STAGE_PREFIX)};`,
    `const foreignBytes = Buffer.from(${JSON.stringify(FOREIGN_REPORT_BYTES.toString("base64"))}, "base64");`,
    "async function injectForeignReport(source, destination) {",
    "  if (basename(source).startsWith(stagePrefix) && basename(destination) === reportName) {",
    '    await fs.writeFile(destination, foreignBytes, { flag: "wx", mode: 0o600 });',
    "  }",
    "}",
    "export async function rename(source, destination) {",
    "  await injectForeignReport(source, destination);",
    "  return await fs.rename(source, destination);",
    "}",
    "export async function link(source, destination) {",
    "  await injectForeignReport(source, destination);",
    "  return await fs.link(source, destination);",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    recorderPath,
    source.replace(nodeFsImport, `from "./${shimName}";`),
    "utf8",
  );
  runGit(repoRoot, ["add", RECORD_SCRIPT, `scripts/${shimName}`]);
  runGit(repoRoot, ["commit", "--quiet", "-m", "inject publication boundary race"]);
}

async function installFinalizeStageReplacementFsShim(repoRoot: string): Promise<string> {
  const recorderPath = join(repoRoot, RECORD_SCRIPT);
  const source = await readFile(recorderPath, "utf8");
  const nodeFsImport = 'from "node:fs/promises";';
  if (!source.includes(nodeFsImport)) {
    throw new Error("Recorder must import its publication primitives from node:fs/promises");
  }
  const witnessRoot = await realpath(await mkdtemp(join(tmpdir(), "kwb-finalize-race-")));
  temporaryRoots.push(witnessRoot);
  const witnessPath = join(witnessRoot, "foreign-stage-witness.json");
  const shimName = "finalize-stage-replacement-fs-shim.mjs";
  await writeFile(join(repoRoot, "scripts", shimName), [
    'import * as fs from "node:fs/promises";',
    'import { basename, dirname, join } from "node:path";',
    'export * from "node:fs/promises";',
    `const reportName = ${JSON.stringify(REPORT_NAME)};`,
    `const stagePrefix = ${JSON.stringify(STAGE_PREFIX)};`,
    `const foreignBytes = Buffer.from(${JSON.stringify(FOREIGN_STAGE_BYTES.toString("base64"))}, "base64");`,
    `const witnessPath = ${JSON.stringify(witnessPath)};`,
    "let injected = false;",
    "export async function lstat(path, options) {",
    "  const original = await fs.lstat(path, options);",
    "  if (!injected && basename(path) === reportName && original.nlink === 2n) {",
    "    const parent = dirname(path);",
    "    const stages = (await fs.readdir(parent)).filter((name) => name.startsWith(stagePrefix));",
    '    if (stages.length !== 1) throw new Error("Expected one publication stage");',
    "    const stagePath = join(parent, stages[0]);",
    "    await fs.unlink(stagePath);",
    '    await fs.writeFile(stagePath, foreignBytes, { flag: "wx", mode: 0o600 });',
    "    const foreign = await fs.lstat(stagePath, { bigint: true });",
    "    await fs.writeFile(witnessPath, `${JSON.stringify({",
    "      path: stagePath,",
    "      dev: String(foreign.dev),",
    "      ino: String(foreign.ino),",
    "      mode: Number(foreign.mode & 0o777n),",
    "      nlink: String(foreign.nlink),",
    '      bytesBase64: foreignBytes.toString("base64"),',
    "    })}\\n`, { flag: \"wx\", mode: 0o600 });",
    "    injected = true;",
    "  }",
    "  return original;",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    recorderPath,
    source.replace(nodeFsImport, `from "./${shimName}";`),
    "utf8",
  );
  runGit(repoRoot, ["add", RECORD_SCRIPT, `scripts/${shimName}`]);
  runGit(repoRoot, ["commit", "--quiet", "-m", "inject finalize stage replacement"]);
  return witnessPath;
}

async function installRecorderSafeFsFaultShim(
  repoRoot: string,
  fault: RecorderSafeFsFault,
): Promise<void> {
  const recorderPath = join(repoRoot, RECORD_SCRIPT);
  const source = await readFile(recorderPath, "utf8");
  const safeFsImport = 'from "./safe-fs-core.mjs";';
  if (!source.includes(safeFsImport)) {
    throw new Error("Recorder must import the shared safe filesystem core");
  }
  const shimName = "recorder-safe-fs-fault-shim.mjs";
  await writeFile(join(repoRoot, "scripts", shimName), [
    'import { join } from "node:path";',
    'import * as safeFs from "./safe-fs-core.mjs";',
    'export * from "./safe-fs-core.mjs";',
    `const fault = ${JSON.stringify(fault)};`,
    `const privateFailure = ${JSON.stringify(PRIVATE_SENTINEL)};`,
    `const partialLockBytes = Buffer.from(${JSON.stringify(PARTIAL_LOCK_BYTES.toString("base64"))}, "base64");`,
    "export async function writeExclusiveRegularFile(path, bytes, label) {",
    "  const created = await safeFs.writeExclusiveRegularFile(path, bytes, label);",
    '  if (fault === "stage-created-then-throw" && label === "Read-only acceptance report stage") {',
    "    throw new Error(privateFailure);",
    "  }",
    "  return created;",
    "}",
    "export async function withExclusiveIdentityLock(input, callback) {",
    '  if (fault === "lock-created-then-throw") {',
    "    await safeFs.writeExclusiveRegularFile(",
    "      join(input.parent.path, input.name),",
    "      partialLockBytes,",
    "      input.label,",
    "    );",
    "    throw new Error(privateFailure);",
    "  }",
    "  return await safeFs.withExclusiveIdentityLock(input, callback);",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    recorderPath,
    source.replace(safeFsImport, `from "./${shimName}";`),
    "utf8",
  );
  runGit(repoRoot, ["add", RECORD_SCRIPT, `scripts/${shimName}`]);
  runGit(repoRoot, ["commit", "--quiet", "-m", "inject recorder safe fs fault"]);
}

async function installValidatorFinalResidueShim(repoRoot: string): Promise<void> {
  const validatorPath = join(repoRoot, VALIDATE_SCRIPT);
  const source = await readFile(validatorPath, "utf8");
  const safeFsImport = 'from "./safe-fs-core.mjs";';
  if (!source.includes(safeFsImport)) {
    throw new Error("Validator must import the shared safe filesystem core");
  }
  const shimName = "validator-final-residue-safe-fs-shim.mjs";
  await writeFile(join(repoRoot, "scripts", shimName), [
    'import { writeFile } from "node:fs/promises";',
    'import { dirname, join } from "node:path";',
    'import * as safeFs from "./safe-fs-core.mjs";',
    'export * from "./safe-fs-core.mjs";',
    `const stageName = ${JSON.stringify(VALIDATOR_FINAL_STAGE_NAME)};`,
    `const stageBytes = Buffer.from(${JSON.stringify(VALIDATOR_FINAL_STAGE_BYTES.toString("base64"))}, "base64");`,
    "export async function assertFrozenRegularFile(snapshot, label) {",
    "  await safeFs.assertFrozenRegularFile(snapshot, label);",
    '  if (label === "Read-only acceptance report") {',
    "    await writeFile(join(dirname(snapshot.path), stageName), stageBytes, {",
    '      flag: "wx",',
    "      mode: 0o600,",
    "    });",
    "  }",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    validatorPath,
    source.replace(safeFsImport, `from "./${shimName}";`),
    "utf8",
  );
  runGit(repoRoot, ["add", VALIDATE_SCRIPT, `scripts/${shimName}`]);
  runGit(repoRoot, ["commit", "--quiet", "-m", "inject validator final residue"]);
}

async function installPostPublicationGitStateShim(
  repoRoot: string,
  mutation: PostPublicationMutation,
): Promise<void> {
  const recorderPath = join(repoRoot, RECORD_SCRIPT);
  const source = await readFile(recorderPath, "utf8");
  const gitStateImport = 'from "./git-worktree-state.mjs";';
  if (!source.includes(gitStateImport)) {
    throw new Error("Recorder must import the shared Git worktree state helper");
  }
  const shimName = "post-publication-git-worktree-state-shim.mjs";
  const reportPath = join(repoRoot, ".dev-vault", REPORT_NAME);
  const lockPath = join(repoRoot, ".dev-vault", LOCK_NAME);
  const markerPath = join(repoRoot, ".dev-vault", ".post-publication-mutation-complete");
  await writeFile(join(repoRoot, "scripts", shimName), [
    'import { lstat, rename, writeFile } from "node:fs/promises";',
    'import { assertCleanGitState as originalAssertCleanGitState } from "./git-worktree-state.mjs";',
    'export { captureCleanGitState } from "./git-worktree-state.mjs";',
    `const reportPath = ${JSON.stringify(reportPath)};`,
    `const lockPath = ${JSON.stringify(lockPath)};`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    "async function exists(path) {",
    "  try {",
    "    await lstat(path);",
    "    return true;",
    "  } catch (error) {",
    '    if (error !== null && typeof error === "object" && error.code === "ENOENT") return false;',
    "    throw error;",
    "  }",
    "}",
    "export async function assertCleanGitState(...args) {",
    "  if (await exists(reportPath) && !(await exists(markerPath))) {",
    '    await writeFile(`${reportPath}.replacement`, Buffer.from('
      + `${JSON.stringify(POST_PUBLICATION_REPORT_BYTES.toString("base64"))}, "base64"), `
      + '{ flag: "wx", mode: 0o600 });',
    '    await rename(`${reportPath}.replacement`, reportPath);',
    ...(mutation === "report-and-lock" ? [
      '    await writeFile(`${lockPath}.replacement`, Buffer.from('
        + `${JSON.stringify(POST_PUBLICATION_LOCK_BYTES.toString("base64"))}, "base64"), `
        + '{ flag: "wx", mode: 0o600 });',
      '    await rename(`${lockPath}.replacement`, lockPath);',
    ] : []),
    '    await writeFile(markerPath, "done\\n", { flag: "wx", mode: 0o600 });',
    "  }",
    "  return await originalAssertCleanGitState(...args);",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    recorderPath,
    source.replace(gitStateImport, `from "./${shimName}";`),
    "utf8",
  );
  runGit(repoRoot, ["add", RECORD_SCRIPT, `scripts/${shimName}`]);
  runGit(repoRoot, ["commit", "--quiet", "-m", "inject post-publication Git-state race"]);
}

function localEvidenceFor(mode: EvidenceMode, commit: string): LocalAcceptanceEvidence {
  const base: LocalAcceptanceEvidence = {
    runId: RUN_ID,
    commit,
    pluginVersion: "0.1.0",
    artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    syntheticNoteCount: 5_000,
    artifactIdentity: "passed",
    fixtureIdentity: "passed",
    automatedSafety: "passed",
    contentUnchanged: "passed",
    startupNormalizationEvidence: "normalized-safe",
    hostIsolation: "passed",
    historySensitiveActionsBlocked: "passed",
    networkBoundary: "passed",
    recoveryAbsent: "passed",
    finalHostStopped: "passed",
  };
  if (mode === "passed") return Object.freeze(base);
  if (mode === "automated-failed") {
    return Object.freeze({ ...base, automatedSafety: "failed" });
  }
  if (mode === "automated-inconclusive") {
    return Object.freeze({ ...base, automatedSafety: "inconclusive" });
  }
  if (mode === "failed") {
    return Object.freeze({
      ...base,
      artifactIdentity: "failed",
      fixtureIdentity: "failed",
      contentUnchanged: "failed",
      historySensitiveActionsBlocked: "failed",
      networkBoundary: "failed",
      recoveryAbsent: "failed",
    });
  }
  if (mode === "inconclusive") {
    return Object.freeze({
      ...base,
      artifactIdentity: "inconclusive",
      fixtureIdentity: "inconclusive",
      contentUnchanged: "inconclusive",
    });
  }
  if (mode === "seed-unchanged") {
    return Object.freeze({
      ...base,
      startupNormalizationEvidence: "seed-unchanged",
      hostIsolation: "inconclusive",
      finalHostStopped: "inconclusive",
    });
  }
  throw new Error("Private throwing evidence mode cannot form a report");
}

async function createPublicationFixture(options: Readonly<{
  finalizeStageReplacementFsShim?: boolean;
  legacy?: boolean;
  postPublicationMutation?: PostPublicationMutation;
  publicationBoundaryFsShim?: boolean;
  recorderSafeFsFault?: RecorderSafeFsFault;
  validatorFinalResidueShim?: boolean;
}> = {}): Promise<PublicationFixture> {
  const repoRoot = await lightweightRepository();
  const stubs = await installRunnerEvidenceStubs(repoRoot);
  let finalizeStageRaceWitnessPath: string | null = null;
  if (options.finalizeStageReplacementFsShim === true) {
    finalizeStageRaceWitnessPath = await installFinalizeStageReplacementFsShim(repoRoot);
  }
  if (options.publicationBoundaryFsShim === true) {
    await installPublicationBoundaryFsShim(repoRoot);
  }
  if (options.recorderSafeFsFault !== undefined) {
    await installRecorderSafeFsFaultShim(repoRoot, options.recorderSafeFsFault);
  }
  if (options.validatorFinalResidueShim === true) {
    await installValidatorFinalResidueShim(repoRoot);
  }
  if (options.postPublicationMutation !== undefined) {
    await installPostPublicationGitStateShim(repoRoot, options.postPublicationMutation);
  }
  const anchor = await writeMinimalRunAnchor(repoRoot);
  const vaultPath = join(repoRoot, ".dev-vault", "read-only-acceptance-vault");
  const configPath = join(vaultPath, [".", "obsidian"].join(""));
  const targetPath = join(configPath, "plugins", "knowledge-workbench");
  const generatedPath = join(vaultPath, "Generated", "00000");
  const artifactRoot = join(repoRoot, "dist", "read-only-acceptance");
  await Promise.all([
    mkdir(targetPath, { recursive: true }),
    mkdir(generatedPath, { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
  ]);

  const artifactFiles = new Map<string, Buffer>([
    ["main.js", Buffer.from("export default class KnowledgeWorkbench {}\n", "utf8")],
    ["manifest.json", Buffer.from(`${JSON.stringify({
      id: "knowledge-workbench",
      name: "Knowledge Workbench Acceptance",
      version: "0.1.0",
      minAppVersion: "1.12.0",
      description: "Synthetic read-only acceptance fixture",
      isDesktopOnly: true,
    }, null, 2)}\n`, "utf8")],
    ["styles.css", Buffer.from(".knowledge-workbench { display: block; }\n", "utf8")],
    ["acceptance-build.json", Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      mode: "read-only-acceptance",
      pluginVersion: "0.1.0",
      artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    }, null, 2)}\n`, "utf8")],
  ]);
  const regularPaths: string[] = [
    anchor.statePath,
    anchor.receiptPath,
    stubs.controlPath,
    stubs.evidenceModePath,
    stubs.validatorModePath,
    stubs.vitestPath,
  ];
  for (const [name, bytes] of artifactFiles) {
    const sourcePath = join(artifactRoot, name);
    const installedPath = join(targetPath, name);
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    await writeFile(installedPath, bytes, { mode: 0o600 });
    regularPaths.push(sourcePath, installedPath);
  }

  const dataPath = join(targetPath, "data.json");
  const communityPath = join(configPath, "community-plugins.json");
  const markerPath = join(vaultPath, ".knowledge-workbench-test-vault.json");
  const notePath = join(generatedPath, "note-00000-3db92208.md");
  const dataBytes = Buffer.from(`${JSON.stringify({
    settings: { writeEnabled: false },
    activeIndex: { builtAt: 1, records: [] },
    stagedIndex: null,
    journal: [],
  }, null, 2)}\n`, "utf8");
  await writeFile(dataPath, dataBytes, { mode: 0o600 });
  await writeFile(communityPath, "[]\n", { mode: 0o600 });
  await writeFile(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    purpose: "knowledge-workbench-dedicated-test-vault",
    contentPolicy: "synthetic-notes-only",
  })}\n`, { mode: 0o600 });
  await writeFile(notePath, "# Synthetic note 00000\n\nFixture-only content.\n", { mode: 0o600 });
  regularPaths.push(dataPath, communityPath, markerPath, notePath);

  const legacyPath = join(repoRoot, ".dev-vault", "acceptance.json");
  const legacyBytes = Buffer.from("legacy acceptance sentinel\n", "utf8");
  if (options.legacy !== false) {
    await writeFile(legacyPath, legacyBytes, { mode: 0o600 });
    regularPaths.push(legacyPath);
  }
  for (const path of regularPaths) {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error("Publication fixture requires singly-linked regular files");
    }
  }
  if (runGit(repoRoot, ["status", "--short", "--untracked-files=all"]) !== "") {
    throw new Error("Publication fixture must leave tracked Git state clean");
  }
  return Object.freeze({
    repoRoot,
    commit: anchor.commit,
    statePath: anchor.statePath,
    receiptPath: anchor.receiptPath,
    reportPath: join(repoRoot, ".dev-vault", REPORT_NAME),
    dataPath,
    artifactPath: join(artifactRoot, "main.js"),
    legacyPath,
    legacyBytes,
    finalizeStageRaceWitnessPath,
    ...stubs,
  });
}

function reportForFixture(
  fixture: PublicationFixture,
  mode: EvidenceMode,
  host: HostObservation = validHost(),
): ReadOnlyAcceptanceReport {
  return composeReadOnlyAcceptanceReport(
    localEvidenceFor(mode, fixture.commit),
    decodeHostObservation(host),
  );
}

async function writeCanonicalReport(
  fixture: PublicationFixture,
  report: ReadOnlyAcceptanceReport,
): Promise<Buffer> {
  const bytes = encodeReadOnlyAcceptanceReport(report);
  await writeFile(fixture.reportPath, bytes, { mode: 0o600, flag: "wx" });
  return bytes;
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    name !== "OBSIDIAN_DEV_VAULT" && !FORBIDDEN_OVERRIDE.test(name)
  )));
}

async function runCli(
  repoRoot: string,
  relativeScript: string,
  stdin: string | Uint8Array = "",
  args: readonly string[] = [],
  overrides: Readonly<Record<string, string>> = {},
): Promise<Readonly<CliResult>> {
  const child = spawn(process.execPath, [join(repoRoot, relativeScript), ...args], {
    cwd: tmpdir(),
    env: { ...baseEnvironment(), ...overrides },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  return Object.freeze({ code, stdout, stderr });
}

async function runRecorderProbe(
  repoRoot: string,
  statements: string,
): Promise<Readonly<CliResult>> {
  const recorderUrl = pathToFileURL(join(repoRoot, RECORD_SCRIPT)).href;
  const probe = [
    `const recorderUrl = ${JSON.stringify(recorderUrl)};`,
    `const repoRoot = ${JSON.stringify(repoRoot)};`,
    `const observation = ${JSON.stringify(validHost())};`,
    statements,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: tmpdir(),
    env: baseEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  return Object.freeze({ code, stdout, stderr });
}

function decodeProbe<T>(result: Readonly<CliResult>): T {
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

async function probeRecorderExports(repoRoot: string): Promise<Readonly<CliResult>> {
  const recorderUrl = pathToFileURL(join(repoRoot, RECORD_SCRIPT)).href;
  const probe = [
    `const namespace = await import(${JSON.stringify(recorderUrl)});`,
    "const exports = Object.keys(namespace).map((key) => [key, typeof namespace[key]]);",
    "process.stdout.write(JSON.stringify(exports));",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: tmpdir(),
    env: baseEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  return Object.freeze({ code, stdout, stderr });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
}, HEAVY_TIMEOUT_MS);

describe("read-only acceptance recorder fast RED boundaries", () => {
  it("exports only the exact imported recorder function", async () => {
    const repoRoot = await lightweightRepository();
    const result = await probeRecorderExports(repoRoot);

    expect(result).toEqual({
      code: 0,
      stdout: '[["recordReadOnlyAcceptance","function"]]',
      stderr: "",
    });
  }, HEAVY_TIMEOUT_MS);

  it("locks the private automated safety runner command and bounded process contract", async () => {
    const source = await readFile(join(projectRoot, RECORD_SCRIPT), "utf8");

    expect(source).toMatch(
      /import\s*\{[^}]*\bexecFile\b[^}]*\}\s*from\s*"node:child_process"/u,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*\bAUTOMATED_SAFETY_TESTS\b[^}]*\}\s*from\s*"\.\/read-only-acceptance-local-evidence\.mjs"/u,
    );
    expect(source).toMatch(
      /join\(repoRoot,\s*"node_modules",\s*"vitest",\s*"vitest\.mjs"\)/u,
    );
    expect(source).toMatch(
      /execFile\(\s*process\.execPath,\s*\[\s*vitestPath,\s*"run",\s*\.\.\.AUTOMATED_SAFETY_TESTS,\s*"--no-file-parallelism",\s*"--maxWorkers=1",\s*\],/u,
    );
    expect(source).toContain("cwd: repoRoot,");
    expect(source).toMatch(
      /env:\s*\{\s*PATH:\s*process\.env\.PATH\s*\?\?\s*"",\s*NODE_ENV:\s*"test",\s*CI:\s*"1",\s*NO_COLOR:\s*"1",\s*\},/u,
    );
    expect(source).toContain("timeout: 600_000,");
    expect(source).toContain("maxBuffer: 1_048_576,");
    expect(source).toContain("shell: false,");
    expect(source).not.toContain("...process.env");
  }, HEAVY_TIMEOUT_MS);

  it("runs safety before fresh evidence and invokes the first three hooks with exact contexts", async () => {
    const repoRoot = await lightweightRepository();
    const fixture = await installRunnerEvidenceStubs(repoRoot);
    const anchor = await writeMinimalRunAnchor(repoRoot);
    const result = await runRecorderProbe(repoRoot, `
      const { writeFile } = await import("node:fs/promises");
      const { recordReadOnlyAcceptance } = await import(recorderUrl);
      const controlPath = ${JSON.stringify(fixture.controlPath)};
      const order = [];
      const contexts = [];
      const capture = (name, context) => {
        order.push(name);
        contexts.push({
          name,
          keys: Reflect.ownKeys(context),
          frozen: Object.isFrozen(context),
          values: context,
        });
      };
      let rejected = false;
      try {
        await recordReadOnlyAcceptance({
          repoRoot,
          observation,
          hooks: {
            afterRunAnchor(context) {
              capture("afterRunAnchor", context);
            },
            async afterAutomatedSafety(context) {
              capture("afterAutomatedSafety", context);
              await writeFile(controlPath, "after-hook\\n", "utf8");
            },
            afterFinalEvidence(context) {
              capture("afterFinalEvidence", context);
              throw new Error("stop before report staging /tmp/private sha256:deadbeef");
            },
            afterReportStaged(context) {
              capture("afterReportStaged", context);
            },
            beforeReportPublish(context) {
              capture("beforeReportPublish", context);
            },
          },
        });
      } catch {
        rejected = true;
      }
      process.stdout.write(JSON.stringify({ contexts, order, rejected }));
    `);
    const decoded = decodeProbe<{
      contexts: Array<{
        frozen: boolean;
        keys: string[];
        name: string;
        values: Record<string, unknown>;
      }>;
      order: string[];
      rejected: boolean;
    }>(result);

    expect(decoded.rejected).toBe(true);
    expect(decoded.order).toEqual([
      "afterRunAnchor",
      "afterAutomatedSafety",
      "afterFinalEvidence",
    ]);
    const expectedContext = {
      repoRoot,
      lockPath: join(repoRoot, ".dev-vault", LOCK_NAME),
      reportStagePath: null,
      reportPath: join(repoRoot, ".dev-vault", REPORT_NAME),
      statePath: anchor.statePath,
      receiptPath: anchor.receiptPath,
      targetPath: join(
        repoRoot,
        ".dev-vault",
        "read-only-acceptance-vault",
        [".", "obsidian"].join(""),
        "plugins",
        "knowledge-workbench",
      ),
      runId: RUN_ID,
      commit: anchor.commit,
    };
    for (const context of decoded.contexts) {
      expect(context.keys, context.name).toEqual(CONTEXT_KEYS);
      expect(context.frozen, context.name).toBe(true);
      expect(context.values, context.name).toEqual(expectedContext);
    }

    const runnerObservation = JSON.parse(
      await readFile(fixture.runnerObservationPath, "utf8"),
    ) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      mode: string;
    };
    expect({
      argv: runnerObservation.argv,
      cwd: runnerObservation.cwd,
      mode: runnerObservation.mode,
    }).toEqual({
      argv: [
        "run",
        ...AUTOMATED_SAFETY_TESTS,
        "--no-file-parallelism",
        "--maxWorkers=1",
      ],
      cwd: repoRoot,
      mode: "pass",
    });
    expect(runnerObservation.env).toMatchObject({
      CI: "1",
      NODE_ENV: "test",
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "",
    });
    const runnerEnvironmentKeys = Object.keys(runnerObservation.env).sort();
    const allowedEnvironmentKeys = ["CI", "NODE_ENV", "NO_COLOR", "PATH"];
    if (Object.prototype.hasOwnProperty.call(
      runnerObservation.env,
      "__CF_USER_TEXT_ENCODING",
    )) {
      allowedEnvironmentKeys.push("__CF_USER_TEXT_ENCODING");
    }
    expect(runnerEnvironmentKeys).toEqual(allowedEnvironmentKeys.sort());
    expect(runnerEnvironmentKeys.filter((name) => (
      /proxy|token|key|secret|credential|^AWS(?:_|$)|^GITHUB(?:_|$)/iu.test(name)
    ))).toEqual([]);
    const trace = (await readFile(fixture.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(trace).toEqual([{ control: "after-hook" }]);
    expect(await readFile(fixture.controlPath, "utf8")).toBe("after-hook\n");
    const names = await readdir(join(repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names).not.toContain(REPORT_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it("accepts only exact plain-data imported options and hook descriptors", async () => {
    const repoRoot = await lightweightRepository();
    const result = await runRecorderProbe(repoRoot, `
      const { watch } = await import("node:fs");
      const { lstat } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { recordReadOnlyAcceptance } = await import(recorderUrl);
      const devRoot = join(repoRoot, ".dev-vault");
      async function attempt(options) {
        const before = await lstat(devRoot, { bigint: true });
        const events = [];
        const watcher = watch(devRoot, { persistent: false }, (_event, name) => {
          events.push(String(name));
        });
        await new Promise((resolve) => setImmediate(resolve));
        let rejected = false;
        try {
          await recordReadOnlyAcceptance(options);
        } catch {
          rejected = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        watcher.close();
        const after = await lstat(devRoot, { bigint: true });
        return {
          rejected,
          touched: events.some((name) => name.includes(".read-only-acceptance-report.lock"))
            || before.mtimeNs !== after.mtimeNs
            || before.ctimeNs !== after.ctimeNs,
        };
      }

      let optionAccessorCalls = 0;
      const accessorOptions = {};
      Object.defineProperty(accessorOptions, "repoRoot", {
        enumerable: true,
        get() { optionAccessorCalls += 1; return repoRoot; },
      });
      Object.defineProperty(accessorOptions, "observation", {
        enumerable: true,
        value: observation,
      });
      let hookAccessorCalls = 0;
      const accessorHooks = {};
      Object.defineProperty(accessorHooks, "afterRunAnchor", {
        enumerable: true,
        get() { hookAccessorCalls += 1; return () => undefined; },
      });

      const cases = {
        exactOptions: await attempt({ repoRoot, observation, hooks: {} }),
        exactHooks: await attempt({
          repoRoot,
          observation,
          hooks: { afterRunAnchor() {} },
        }),
        extraOption: await attempt({ repoRoot, observation, extra: true }),
        reorderedOptions: await attempt({ observation, repoRoot }),
        inheritedOptions: await attempt(Object.assign(
          Object.create({ inherited: true }),
          { repoRoot, observation },
        )),
        accessorOptions: await attempt(accessorOptions),
        unknownHook: await attempt({ repoRoot, observation, hooks: { unknownHook() {} } }),
        inheritedHooks: await attempt({
          repoRoot,
          observation,
          hooks: Object.assign(Object.create({ inherited: true }), { afterRunAnchor() {} }),
        }),
        accessorHooks: await attempt({ repoRoot, observation, hooks: accessorHooks }),
        nonFunctionHook: await attempt({
          repoRoot,
          observation,
          hooks: { afterRunAnchor: true },
        }),
        reorderedHooks: await attempt({
          repoRoot,
          observation,
          hooks: { beforeReportPublish() {}, afterRunAnchor() {} },
        }),
      };
      process.stdout.write(JSON.stringify({ cases, hookAccessorCalls, optionAccessorCalls }));
    `);
    const decoded = decodeProbe<{
      cases: Record<string, { rejected: boolean; touched: boolean }>;
      hookAccessorCalls: number;
      optionAccessorCalls: number;
    }>(result);

    expect(decoded.optionAccessorCalls).toBe(0);
    expect(decoded.hookAccessorCalls).toBe(0);
    expect(decoded.cases.exactOptions).toEqual({ rejected: true, touched: true });
    expect(decoded.cases.exactHooks).toEqual({ rejected: true, touched: true });
    for (const name of [
      "extraOption",
      "reorderedOptions",
      "inheritedOptions",
      "accessorOptions",
      "unknownHook",
      "inheritedHooks",
      "accessorHooks",
      "nonFunctionHook",
      "reorderedHooks",
    ]) {
      expect(decoded.cases[name], name).toEqual({ rejected: true, touched: false });
    }
  }, HEAVY_TIMEOUT_MS);

  it("calls afterRunAnchor with the exact frozen private context and never exposes it to the CLI", async () => {
    const repoRoot = await lightweightRepository();
    const anchor = await writeMinimalRunAnchor(repoRoot);
    const result = await runRecorderProbe(repoRoot, `
      const { recordReadOnlyAcceptance } = await import(recorderUrl);
      let called = 0;
      let captured = null;
      let rejected = false;
      try {
        await recordReadOnlyAcceptance({
          repoRoot,
          observation,
          hooks: {
            afterRunAnchor(context) {
              called += 1;
              let mutationRejected = false;
              try { context.runId = "changed"; } catch { mutationRejected = true; }
              captured = {
                keys: Reflect.ownKeys(context),
                frozen: Object.isFrozen(context),
                mutationRejected,
                values: context,
              };
              throw new Error("private hook context /tmp/private sha256:deadbeef");
            },
          },
        });
      } catch {
        rejected = true;
      }
      process.stdout.write(JSON.stringify({ called, captured, rejected }));
    `);
    const decoded = decodeProbe<{
      called: number;
      captured: null | {
        frozen: boolean;
        keys: string[];
        mutationRejected: boolean;
        values: Record<string, unknown>;
      };
      rejected: boolean;
    }>(result);

    expect(decoded.rejected).toBe(true);
    expect(decoded.called).toBe(1);
    expect(decoded.captured).not.toBeNull();
    expect(decoded.captured?.keys).toEqual(CONTEXT_KEYS);
    expect(decoded.captured).toMatchObject({ frozen: true, mutationRejected: true });
    expect(decoded.captured?.values).toEqual({
      repoRoot,
      lockPath: join(repoRoot, ".dev-vault", LOCK_NAME),
      reportStagePath: null,
      reportPath: join(repoRoot, ".dev-vault", REPORT_NAME),
      statePath: anchor.statePath,
      receiptPath: anchor.receiptPath,
      targetPath: join(
        repoRoot,
        ".dev-vault",
        "read-only-acceptance-vault",
        [".", "obsidian"].join(""),
        "plugins",
        "knowledge-workbench",
      ),
      runId: RUN_ID,
      commit: anchor.commit,
    });
    await expect(lstat(join(repoRoot, ".dev-vault", LOCK_NAME)))
      .rejects.toMatchObject({ code: "ENOENT" });

    const cli = await runCli(repoRoot, RECORD_SCRIPT, JSON.stringify(validHost()));
    const externalOutput = `${cli.stdout}${cli.stderr}`;
    expect(externalOutput === RECORD_SUCCESS || (
      cli.stdout === ""
      && new RegExp(`^${RECORD_FAILURE_PREFIX}: [a-z-]+\\.\\n$`, "u").test(cli.stderr)
    )).toBe(true);
    expect(externalOutput).not.toContain(repoRoot);
    expect(externalOutput).not.toContain(RUN_ID);
    expect(externalOutput).not.toMatch(
      /repoRoot|lockPath|reportStagePath|reportPath|statePath|receiptPath|targetPath|commit|hook|sha256|deadbeef/iu,
    );
  }, HEAVY_TIMEOUT_MS);

  it("bounds stdin, decodes only the exact host object, and never echoes private input", async () => {
    const repoRoot = await lightweightRepository();
    const canonical = JSON.stringify(validHost());
    const exactBound = `${" ".repeat(8192 - Buffer.byteLength(canonical))}${canonical}`;
    const overBound = ` ${exactBound}`;
    const reordered = Object.fromEntries([
      ["finalHostStopped", "passed"],
      ...Object.entries(validHost()).slice(0, -1),
    ]);
    const privateValue = "/tmp/private/Generated/00000/note-00000.md sha256:deadbeef https://acceptance.invalid/v1 secret";
    const invalidInputs: Array<string | Uint8Array> = [
      "",
      "   \n",
      "null",
      "[]",
      "{}",
      `${canonical}\n${canonical}`,
      JSON.stringify(reordered),
      JSON.stringify({ ...validHost(), status: "passed" }),
      JSON.stringify({ ...validHost(), runId: "123e4567-e89b-42d3-a456-426614174000" }),
      JSON.stringify({ ...validHost(), commit: "a".repeat(40) }),
      JSON.stringify({ ...validHost(), pluginVersion: "0.1.0" }),
      JSON.stringify({ ...validHost(), artifactBinding: "private-binding" }),
      JSON.stringify({ ...validHost(), syntheticNoteCount: 5_000 }),
      JSON.stringify({ ...validHost(), artifactIdentity: "passed" }),
      JSON.stringify({ ...validHost(), fixtureIdentity: "passed" }),
      JSON.stringify({ ...validHost(), automatedSafety: "passed" }),
      JSON.stringify({ ...validHost(), contentUnchanged: "passed" }),
      JSON.stringify({ ...validHost(), failureCategories: [] }),
      JSON.stringify({ ...validHost(), path: privateValue }),
      JSON.stringify({ ...validHost(), detail: privateValue }),
      Buffer.from([0xc3, 0x28]),
      overBound,
    ];

    for (const input of invalidInputs) {
      const result = await runCli(repoRoot, RECORD_SCRIPT, input);
      expect(result, typeof input === "string" ? input.slice(0, 48) : "invalid UTF-8").toEqual({
        code: 1,
        stdout: "",
        stderr: `${RECORD_FAILURE_PREFIX}: invalid-invocation.\n`,
      });
      expect(`${result.stdout}${result.stderr}`).not.toMatch(
        /\/tmp\/private|Generated|note-00000|sha256|deadbeef|acceptance\.invalid|secret|\{"recordedAt"/iu,
      );
    }

    const acceptedBound = await runCli(repoRoot, RECORD_SCRIPT, exactBound);
    expect(acceptedBound).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: fixture-invalid.\n`,
    });
  }, HEAVY_TIMEOUT_MS);

  it("rejects every CLI argument and repository, vault, report, lock, or stage override", async () => {
    const repoRoot = await lightweightRepository();
    const scripts = [
      [RECORD_SCRIPT, RECORD_FAILURE_PREFIX, JSON.stringify(validHost())],
      [VALIDATE_SCRIPT, VALIDATE_FAILURE_PREFIX, ""],
    ] as const;
    const argumentCases = [
      ["unexpected"],
      ["--repo-root", "/tmp/private-root"],
      ["--report", "/tmp/private-report"],
      ["--stage", "/tmp/private-stage"],
    ] as const;
    const environmentCases = [
      ["OBSIDIAN_DEV_VAULT", "/tmp/private-vault"],
      ["KNOWLEDGE_WORKBENCH_REPO_ROOT", "/tmp/private-root"],
      ["KNOWLEDGE_WORKBENCH_TARGET_PATH", "/tmp/private-target"],
      ["KNOWLEDGE_WORKBENCH_REPORT", "/tmp/private-report"],
      ["KNOWLEDGE_WORKBENCH_LOCK", "/tmp/private-lock"],
      ["KNOWLEDGE_WORKBENCH_STAGE", "/tmp/private-stage"],
    ] as const;

    for (const [script, prefix, stdin] of scripts) {
      for (const args of argumentCases) {
        const result = await runCli(repoRoot, script, stdin, args);
        expect(result, `${script}:${args.join(" ")}`).toEqual({
          code: 1,
          stdout: "",
          stderr: `${prefix}: invalid-invocation.\n`,
        });
      }
      for (const [name, value] of environmentCases) {
        const result = await runCli(repoRoot, script, stdin, [], { [name]: value });
        expect(result, `${script}:${name}`).toEqual({
          code: 1,
          stdout: "",
          stderr: `${prefix}: invalid-invocation.\n`,
        });
        expect(`${result.stdout}${result.stderr}`).not.toContain(value);
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("acquires the fixed lock before anchor work and never steals or changes it", async () => {
    const repoRoot = await lightweightRepository();
    const lockPath = join(repoRoot, ".dev-vault", LOCK_NAME);
    const sentinel = Buffer.from("stale lock /tmp/private sha256:deadbeef\n", "utf8");
    await writeFile(lockPath, sentinel, { mode: 0o600 });
    const before = await lstat(lockPath, { bigint: true });

    const result = await runCli(repoRoot, RECORD_SCRIPT, JSON.stringify(validHost()));

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: concurrent-operation.\n`,
    });
    expect(await readFile(lockPath)).toEqual(sentinel);
    const after = await lstat(lockPath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(result.stderr).not.toMatch(/\/tmp|sha256|deadbeef|stale/iu);
  }, HEAVY_TIMEOUT_MS);

  it("preserves every existing lock, report, and stage shape before reading an anchor", async () => {
    const shapes: readonly SentinelShape[] = ["file", "directory", "symlink", "fifo"];
    const namespaceCases = [
      [LOCK_NAME, "concurrent-operation"],
      [REPORT_NAME, "target-exists"],
      [`${STAGE_PREFIX}sentinel`, "cleanup-incomplete"],
    ] as const;

    for (const shape of shapes) {
      const repoRoot = await lightweightRepository();
      for (const [name, category] of namespaceCases) {
        const path = join(repoRoot, ".dev-vault", name);
        const before = await createSentinel(path, shape);

        const result = await runCli(repoRoot, RECORD_SCRIPT, JSON.stringify(validHost()));

        expect(result, `${name}:${shape}`).toEqual({
          code: 1,
          stdout: "",
          stderr: `${RECORD_FAILURE_PREFIX}: ${category}.\n`,
        });
        expect(`${result.stdout}${result.stderr}`).not.toMatch(
          /\/tmp\/private|Generated|note-00000|sha256|deadbeef|endpoint|model|secret/iu,
        );
        await expectSentinel(path, before);
        await removeSentinel(path, shape);
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("checks and preserves validator lock and stage residue before reporting pending", async () => {
    const shapes: readonly SentinelShape[] = ["file", "directory", "symlink", "fifo"];
    const residueCases = [
      [LOCK_NAME, "concurrent-operation"],
      [`${STAGE_PREFIX}sentinel`, "cleanup-incomplete"],
    ] as const;

    for (const shape of shapes) {
      const repoRoot = await lightweightRepository();
      for (const [name, category] of residueCases) {
        const path = join(repoRoot, ".dev-vault", name);
        const before = await createSentinel(path, shape);

        const result = await runCli(repoRoot, VALIDATE_SCRIPT);

        expect(result, `${name}:${shape}`).toEqual({
          code: 1,
          stdout: "",
          stderr: `${VALIDATE_FAILURE_PREFIX}: ${category}.\n`,
        });
        expect(result.stdout).not.toBe(PENDING_MESSAGE);
        await expectSentinel(path, before);
        await expect(lstat(join(repoRoot, ".dev-vault", REPORT_NAME)))
          .rejects.toMatchObject({ code: "ENOENT" });
        await removeSentinel(path, shape);
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("reports pending before current-evidence validation and mutates nothing", async () => {
    const repoRoot = await lightweightRepository();
    const before = (await readFile(join(repoRoot, ".gitignore"))).toString("utf8");

    const result = await runCli(repoRoot, VALIDATE_SCRIPT);

    expect(result).toEqual({ code: 1, stdout: PENDING_MESSAGE, stderr: "" });
    expect(await readFile(join(repoRoot, ".gitignore"), "utf8")).toBe(before);
    await expect(readFile(join(repoRoot, ".dev-vault", REPORT_NAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, HEAVY_TIMEOUT_MS);

  it("removes its exact owned namespace after a valid bounded input has no run anchor", async () => {
    const repoRoot = await lightweightRepository();

    const result = await runCli(repoRoot, RECORD_SCRIPT, JSON.stringify(validHost()));

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: fixture-invalid.\n`,
    });
    const names = await readdir(join(repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names).not.toContain(REPORT_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it("adds exactly the two package commands without changing the legacy validator", async () => {
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["record:read-only-acceptance"])
      .toBe("node scripts/record-read-only-acceptance.mjs");
    expect(packageJson.scripts?.["validate:read-only-acceptance"])
      .toBe("node scripts/validate-read-only-acceptance.mjs");
    expect(packageJson.scripts?.["validate:acceptance"])
      .toBe("node scripts/validate-acceptance.mjs");
  }, HEAVY_TIMEOUT_MS);
});

describe("read-only acceptance terminal publication RED boundaries", () => {
  it("publishes one canonical report through all five exact hook contexts", async () => {
    const fixture = await createPublicationFixture();
    const result = await runRecorderProbe(fixture.repoRoot, `
      const { lstat, readFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const { recordReadOnlyAcceptance } = await import(recorderUrl);
      const order = [];
      const contexts = [];
      let stageEvidence = null;
      const capture = (name, context) => {
        order.push(name);
        contexts.push({
          name,
          keys: Reflect.ownKeys(context),
          frozen: Object.isFrozen(context),
          values: context,
        });
      };
      let rejected = false;
      let report = null;
      let reportFrozen = false;
      try {
        report = await recordReadOnlyAcceptance({
          repoRoot,
          observation,
          hooks: {
            afterRunAnchor(context) { capture("afterRunAnchor", context); },
            afterAutomatedSafety(context) { capture("afterAutomatedSafety", context); },
            afterFinalEvidence(context) { capture("afterFinalEvidence", context); },
            async afterReportStaged(context) {
              capture("afterReportStaged", context);
              const stat = await lstat(context.reportStagePath, { bigint: true });
              stageEvidence = {
                isFile: stat.isFile(),
                isSymbolicLink: stat.isSymbolicLink(),
                mode: Number(stat.mode & 0o777n),
                nlink: Number(stat.nlink),
                sameDirectory: dirname(context.reportStagePath) === dirname(context.reportPath),
                text: await readFile(context.reportStagePath, "utf8"),
              };
            },
            beforeReportPublish(context) { capture("beforeReportPublish", context); },
          },
        });
        reportFrozen = Object.isFrozen(report);
      } catch {
        rejected = true;
      }
      process.stdout.write(JSON.stringify({
        contexts,
        order,
        rejected,
        report,
        reportFrozen,
        stageEvidence,
      }));
    `);
    const decoded = decodeProbe<{
      contexts: Array<{
        frozen: boolean;
        keys: string[];
        name: string;
        values: Record<string, unknown>;
      }>;
      order: string[];
      rejected: boolean;
      report: ReadOnlyAcceptanceReport | null;
      reportFrozen: boolean;
      stageEvidence: null | {
        isFile: boolean;
        isSymbolicLink: boolean;
        mode: number;
        nlink: number;
        sameDirectory: boolean;
        text: string;
      };
    }>(result);

    expect(decoded.rejected).toBe(false);
    expect(decoded.order).toEqual([
      "afterRunAnchor",
      "afterAutomatedSafety",
      "afterFinalEvidence",
      "afterReportStaged",
      "beforeReportPublish",
    ]);
    expect(decoded.reportFrozen).toBe(true);
    expect(decoded.report).not.toBeNull();
    expect(decoded.contexts).toHaveLength(5);
    const baseContext = {
      repoRoot: fixture.repoRoot,
      lockPath: join(fixture.repoRoot, ".dev-vault", LOCK_NAME),
      reportPath: fixture.reportPath,
      statePath: fixture.statePath,
      receiptPath: fixture.receiptPath,
      targetPath: join(
        fixture.repoRoot,
        ".dev-vault",
        "read-only-acceptance-vault",
        [".", "obsidian"].join(""),
        "plugins",
        "knowledge-workbench",
      ),
      runId: RUN_ID,
      commit: fixture.commit,
    };
    const stagePaths = decoded.contexts
      .map((context) => context.values.reportStagePath)
      .filter((path): path is string => typeof path === "string");
    expect(stagePaths).toHaveLength(2);
    expect(new Set(stagePaths).size).toBe(1);
    for (const [index, context] of decoded.contexts.entries()) {
      expect(context.keys, context.name).toEqual(CONTEXT_KEYS);
      expect(context.frozen, context.name).toBe(true);
      expect(context.values, context.name).toEqual({
        repoRoot: baseContext.repoRoot,
        lockPath: baseContext.lockPath,
        reportStagePath: index < 3 ? null : stagePaths[0],
        reportPath: baseContext.reportPath,
        statePath: baseContext.statePath,
        receiptPath: baseContext.receiptPath,
        targetPath: baseContext.targetPath,
        runId: baseContext.runId,
        commit: baseContext.commit,
      });
    }
    expect(decoded.stageEvidence).toMatchObject({
      isFile: true,
      isSymbolicLink: false,
      mode: 0o600,
      nlink: 1,
      sameDirectory: true,
    });

    const reportBytes = await readFile(fixture.reportPath);
    const report = decodeReadOnlyAcceptanceReport(reportBytes);
    expect(report).toEqual(decoded.report);
    expect(reportBytes).toEqual(encodeReadOnlyAcceptanceReport(report));
    expect(decoded.stageEvidence?.text).toBe(reportBytes.toString("utf8"));
    expect(Object.keys(report)).toEqual(REPORT_KEYS);
    expect(JSON.stringify(report)).not.toMatch(
      /artifactSetDigest|fixtureStateDigest|seedDataDigest|corpusDigest|lockPath|reportPath|statePath|receiptPath|targetPath|note-00000/iu,
    );
    const reportStat = await lstat(fixture.reportPath, { bigint: true });
    expect({
      file: reportStat.isFile(),
      mode: Number(reportStat.mode & 0o777n),
      nlink: reportStat.nlink,
      symlink: reportStat.isSymbolicLink(),
    }).toEqual({ file: true, mode: 0o600, nlink: 1n, symlink: false });
    expect(await readFile(fixture.legacyPath)).toEqual(fixture.legacyBytes);
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it("records through the CLI exactly once and never overwrites the fixed report", async () => {
    const fixture = await createPublicationFixture();

    const first = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    expect(first).toEqual({ code: 0, stdout: RECORD_SUCCESS, stderr: "" });
    const reportBytes = await readFile(fixture.reportPath);
    const before = await lstat(fixture.reportPath, { bigint: true });
    const second = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );
    expect(second).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: target-exists.\n`,
    });
    expect(await readFile(fixture.reportPath)).toEqual(reportBytes);
    const after = await lstat(fixture.reportPath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`).not.toMatch(
      /\/tmp\/private|Generated|note-00000|sha256|deadbeef|endpoint|model|secret|lockPath|reportPath/iu,
    );
  }, HEAVY_TIMEOUT_MS);

  it("rolls back publication when independent current-evidence validation fails", async () => {
    const fixture = await createPublicationFixture();
    await writeFile(fixture.validatorModePath, "throw\n", "utf8");
    const vaultRoot = join(
      fixture.repoRoot,
      ".dev-vault",
      "read-only-acceptance-vault",
    );
    const guardedPaths = [
      fixture.statePath,
      fixture.receiptPath,
      fixture.dataPath,
      fixture.artifactPath,
      fixture.legacyPath,
      join(vaultRoot, [".", "obsidian"].join(""), "community-plugins.json"),
      join(vaultRoot, ".knowledge-workbench-test-vault.json"),
      join(vaultRoot, "Generated", "00000", "note-00000-3db92208.md"),
    ];
    const guarded = await Promise.all(guardedPaths.map(async (path) => ({
      path,
      bytes: await readFile(path),
      stat: await lstat(path, { bigint: true }),
    })));

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    for (const before of guarded) {
      expect(await readFile(before.path), before.path).toEqual(before.bytes);
      const after = await lstat(before.path, { bigint: true });
      expect({ dev: after.dev, ino: after.ino }, before.path)
        .toEqual({ dev: before.stat.dev, ino: before.stat.ino });
    }
    expect(`${cli.stdout}${cli.stderr}`).not.toMatch(
      /\/tmp\/private|Generated|note-00000|sha256|deadbeef|endpoint|model|secret/iu,
    );
    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: report-invalid.\n`,
    });
    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);
});

describe("read-only acceptance terminal classification RED boundaries", () => {
  it("combines the private runner and fresh local evidence by worst terminal status", async () => {
    const cases: Array<{
      evidenceMode: EvidenceMode;
      expectedAutomated: "passed" | "failed" | "inconclusive";
      expectedCategories: string[];
      expectedStatus: "passed" | "failed" | "inconclusive";
      host: HostObservation;
      runnerMode: "pass" | "assertion" | "signal" | "overflow" | "unavailable";
    }> = [
      {
        runnerMode: "assertion",
        evidenceMode: "passed",
        host: validHost(),
        expectedAutomated: "failed",
        expectedStatus: "failed",
        expectedCategories: ["ui-capability"],
      },
      {
        runnerMode: "signal",
        evidenceMode: "passed",
        host: validHost(),
        expectedAutomated: "inconclusive",
        expectedStatus: "inconclusive",
        expectedCategories: ["ui-capability"],
      },
      {
        runnerMode: "overflow",
        evidenceMode: "passed",
        host: validHost(),
        expectedAutomated: "inconclusive",
        expectedStatus: "inconclusive",
        expectedCategories: ["ui-capability"],
      },
      {
        runnerMode: "unavailable",
        evidenceMode: "passed",
        host: validHost(),
        expectedAutomated: "inconclusive",
        expectedStatus: "inconclusive",
        expectedCategories: ["ui-capability"],
      },
      {
        runnerMode: "pass",
        evidenceMode: "automated-failed",
        host: validHost(),
        expectedAutomated: "failed",
        expectedStatus: "failed",
        expectedCategories: ["ui-capability"],
      },
      {
        runnerMode: "assertion",
        evidenceMode: "automated-inconclusive",
        host: validHost(),
        expectedAutomated: "failed",
        expectedStatus: "failed",
        expectedCategories: ["ui-capability"],
      },
      {
        runnerMode: "pass",
        evidenceMode: "failed",
        host: validHost(),
        expectedAutomated: "passed",
        expectedStatus: "failed",
        expectedCategories: [
          "artifact",
          "fixture",
          "ui-capability",
          "content-drift",
          "network",
          "recovery",
        ],
      },
      {
        runnerMode: "pass",
        evidenceMode: "passed",
        host: validHost({ scanElapsedMs: 30_001 }),
        expectedAutomated: "passed",
        expectedStatus: "failed",
        expectedCategories: ["ui-capability", "timing"],
      },
    ];

    for (const value of cases) {
      const fixture = await createPublicationFixture();
      await writeFile(fixture.evidenceModePath, `${value.evidenceMode}\n`, "utf8");
      if (value.runnerMode === "unavailable") {
        await rm(fixture.vitestPath, { force: true });
      } else {
        await writeFile(fixture.controlPath, `${value.runnerMode}\n`, "utf8");
      }

      const cli = await runCli(
        fixture.repoRoot,
        RECORD_SCRIPT,
        JSON.stringify(value.host),
      );

      expect(cli, `${value.runnerMode}:${value.evidenceMode}`).toEqual({
        code: 0,
        stdout: RECORD_SUCCESS,
        stderr: "",
      });
      const report = decodeReadOnlyAcceptanceReport(await readFile(fixture.reportPath));
      expect({
        automatedSafety: report.automatedSafety,
        failureCategories: report.failureCategories,
        status: report.status,
      }, `${value.runnerMode}:${value.evidenceMode}`).toEqual({
        automatedSafety: value.expectedAutomated,
        failureCategories: value.expectedCategories,
        status: value.expectedStatus,
      });
    }
  }, HEAVY_TIMEOUT_MS);

  it("persists the stopped-before-enable seed as inconclusive instead of failed", async () => {
    const fixture = await createPublicationFixture();
    await writeFile(fixture.evidenceModePath, "seed-unchanged\n", "utf8");
    const observation = validHost({
      hostIsolation: "inconclusive",
      startupNormalization: "inconclusive",
      finalHostStopped: "inconclusive",
    });

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(observation),
    );

    expect(cli).toEqual({ code: 0, stdout: RECORD_SUCCESS, stderr: "" });
    const report = decodeReadOnlyAcceptanceReport(await readFile(fixture.reportPath));
    expect(report).toMatchObject({
      status: "inconclusive",
      hostIsolation: "inconclusive",
      startupNormalization: "inconclusive",
      finalHostStopped: "inconclusive",
      failureCategories: ["startup", "host-isolation"],
    });
  }, HEAVY_TIMEOUT_MS);

  it("allows exactly one publisher when two imported recorders share the fixed lock", async () => {
    const fixture = await createPublicationFixture();
    const result = await runRecorderProbe(fixture.repoRoot, `
      const { recordReadOnlyAcceptance } = await import(recorderUrl);
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const barrier = new Promise((resolve) => { release = resolve; });
      const first = recordReadOnlyAcceptance({
        repoRoot,
        observation,
        hooks: {
          async afterRunAnchor() {
            enter();
            await barrier;
          },
        },
      });
      await entered;
      const second = recordReadOnlyAcceptance({ repoRoot, observation });
      const settledPromise = Promise.allSettled([first, second]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      release();
      const settled = await settledPromise;
      process.stdout.write(JSON.stringify({
        statuses: settled.map((entry) => entry.status),
        terminalStatuses: settled.map((entry) => (
          entry.status === "fulfilled" ? entry.value.status : null
        )),
      }));
    `);
    const decoded = decodeProbe<{
      statuses: Array<"fulfilled" | "rejected">;
      terminalStatuses: Array<null | "passed" | "failed" | "inconclusive">;
    }>(result);

    expect(decoded.statuses.sort()).toEqual(["fulfilled", "rejected"]);
    expect(decoded.terminalStatuses.filter((status) => status !== null)).toEqual(["passed"]);
    expect(decodeReadOnlyAcceptanceReport(await readFile(fixture.reportPath)).status).toBe("passed");
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it("normalizes private evidence failures without publishing or leaking details", async () => {
    const fixture = await createPublicationFixture();
    await writeFile(fixture.evidenceModePath, "throw-private\n", "utf8");

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: fixture-changed.\n`,
    });
    expect(`${cli.stdout}${cli.stderr}`).not.toMatch(
      /\/tmp\/private|Generated|note-00000|sha256|deadbeef|endpoint|model|secret/iu,
    );
    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, HEAVY_TIMEOUT_MS);
});

describe("read-only acceptance publication race RED boundaries", () => {
  it("rejects same-byte data and artifact identity replacements after final evidence", async () => {
    for (const selected of ["dataPath", "artifactPath"] as const) {
      const fixture = await createPublicationFixture();
      const targetPath = fixture[selected];
      const before = await lstat(targetPath, { bigint: true });
      const originalBytes = await readFile(targetPath);
      const result = await runRecorderProbe(fixture.repoRoot, `
        const { readFile, rename, writeFile } = await import("node:fs/promises");
        const { recordReadOnlyAcceptance } = await import(recorderUrl);
        const targetPath = ${JSON.stringify(targetPath)};
        let called = false;
        let rejected = false;
        try {
          await recordReadOnlyAcceptance({
            repoRoot,
            observation,
            hooks: {
              async afterFinalEvidence() {
                called = true;
                const bytes = await readFile(targetPath);
                const replacement = targetPath + ".replacement";
                await writeFile(replacement, bytes, { flag: "wx", mode: 0o600 });
                await rename(replacement, targetPath);
              },
            },
          });
        } catch {
          rejected = true;
        }
        process.stdout.write(JSON.stringify({ called, rejected }));
      `);
      const decoded = decodeProbe<{ called: boolean; rejected: boolean }>(result);

      expect(decoded, selected).toEqual({ called: true, rejected: true });
      expect(await readFile(targetPath)).toEqual(originalBytes);
      const after = await lstat(targetPath, { bigint: true });
      expect({ dev: after.dev, ino: after.ino }).not.toEqual({ dev: before.dev, ino: before.ino });
      await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
      const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
      expect(names).not.toContain(LOCK_NAME);
      expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
    }
  }, HEAVY_TIMEOUT_MS);

  it("retains a replacement stage and refuses publication after afterReportStaged", async () => {
    const fixture = await createPublicationFixture();
    const replacement = Buffer.from("replacement stage /tmp/private sha256:deadbeef\n", "utf8");
    const result = await runRecorderProbe(fixture.repoRoot, `
      const { rm, writeFile } = await import("node:fs/promises");
      const { recordReadOnlyAcceptance } = await import(recorderUrl);
      let called = false;
      let rejected = false;
      let stagePath = null;
      try {
        await recordReadOnlyAcceptance({
          repoRoot,
          observation,
          hooks: {
            async afterReportStaged(context) {
              called = true;
              stagePath = context.reportStagePath;
              await rm(stagePath);
              await writeFile(stagePath, ${JSON.stringify(replacement.toString("utf8"))}, {
                flag: "wx",
                mode: 0o600,
              });
            },
          },
        });
      } catch {
        rejected = true;
      }
      process.stdout.write(JSON.stringify({ called, rejected, stagePath }));
    `);
    const decoded = decodeProbe<{
      called: boolean;
      rejected: boolean;
      stagePath: string | null;
    }>(result);

    expect(decoded.called).toBe(true);
    expect(decoded.rejected).toBe(true);
    expect(decoded.stagePath).toMatch(new RegExp(`${STAGE_PREFIX}`, "u"));
    expect(await readFile(decoded.stagePath!)).toEqual(replacement);
    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(fixture.repoRoot, ".dev-vault", LOCK_NAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, HEAVY_TIMEOUT_MS);

  it("removes its exact stage when evidence changes immediately before publication", async () => {
    const fixture = await createPublicationFixture();
    const dataBytes = await readFile(fixture.dataPath);
    const before = await lstat(fixture.dataPath, { bigint: true });
    const result = await runRecorderProbe(fixture.repoRoot, `
      const { readFile, rename, writeFile } = await import("node:fs/promises");
      const { recordReadOnlyAcceptance } = await import(recorderUrl);
      const dataPath = ${JSON.stringify(fixture.dataPath)};
      let called = false;
      let rejected = false;
      try {
        await recordReadOnlyAcceptance({
          repoRoot,
          observation,
          hooks: {
            async beforeReportPublish() {
              called = true;
              const bytes = await readFile(dataPath);
              const replacement = dataPath + ".replacement";
              await writeFile(replacement, bytes, { flag: "wx", mode: 0o600 });
              await rename(replacement, dataPath);
            },
          },
        });
      } catch {
        rejected = true;
      }
      process.stdout.write(JSON.stringify({ called, rejected }));
    `);
    const decoded = decodeProbe<{ called: boolean; rejected: boolean }>(result);

    expect(decoded).toEqual({ called: true, rejected: true });
    expect(await readFile(fixture.dataPath)).toEqual(dataBytes);
    const after = await lstat(fixture.dataPath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino }).not.toEqual({ dev: before.dev, ino: before.ino });
    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it("never overwrites a foreign report created at the atomic publication boundary", async () => {
    const fixture = await createPublicationFixture({ publicationBoundaryFsShim: true });

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: concurrent-operation.\n`,
    });
    expect(await readFile(fixture.reportPath)).toEqual(FOREIGN_REPORT_BYTES);
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it("retains a foreign stage replacement injected during publication finalization", async () => {
    const fixture = await createPublicationFixture({
      finalizeStageReplacementFsShim: true,
    });

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );
    const witness = JSON.parse(await readFile(
      fixture.finalizeStageRaceWitnessPath!,
      "utf8",
    )) as FinalizeStageRaceWitness;

    expect(witness.path.startsWith(join(
      fixture.repoRoot,
      ".dev-vault",
      STAGE_PREFIX,
    ))).toBe(true);
    expect(witness.bytesBase64).toBe(FOREIGN_STAGE_BYTES.toString("base64"));
    expect({ mode: witness.mode, nlink: witness.nlink }).toEqual({ mode: 0o600, nlink: "1" });
    expect(`${cli.stdout}${cli.stderr}`).not.toMatch(
      /\/tmp\/private|Generated|note-00000|sha256|deadbeef|endpoint|model|secret/iu,
    );
    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: concurrent-operation.\n`,
    });

    expect(await readFile(witness.path)).toEqual(FOREIGN_STAGE_BYTES);
    const stage = await lstat(witness.path, { bigint: true });
    expect({
      dev: String(stage.dev),
      ino: String(stage.ino),
      mode: Number(stage.mode & 0o777n),
      nlink: String(stage.nlink),
      file: stage.isFile(),
    }).toEqual({
      dev: witness.dev,
      ino: witness.ino,
      mode: witness.mode,
      nlink: witness.nlink,
      file: true,
    });
    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(fixture.repoRoot, ".dev-vault", LOCK_NAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, HEAVY_TIMEOUT_MS);

  it("detects and retains a report replacement during the post-publication final witness", async () => {
    const fixture = await createPublicationFixture({ postPublicationMutation: "report" });

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: rollback-incomplete.\n`,
    });
    expect(await readFile(fixture.reportPath)).toEqual(POST_PUBLICATION_REPORT_BYTES);
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it("keeps rollback-incomplete dominant when report and lock replacements are both retained", async () => {
    const fixture = await createPublicationFixture({
      postPublicationMutation: "report-and-lock",
    });

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: rollback-incomplete.\n`,
    });
    expect(await readFile(fixture.reportPath)).toEqual(POST_PUBLICATION_REPORT_BYTES);
    expect(await readFile(join(fixture.repoRoot, ".dev-vault", LOCK_NAME)))
      .toEqual(POST_PUBLICATION_LOCK_BYTES);
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
  }, HEAVY_TIMEOUT_MS);
});

describe("read-only acceptance partial-create cleanup RED boundaries", () => {
  it("classifies a fully created but unreturned stage as cleanup-incomplete", async () => {
    const fixture = await createPublicationFixture({
      recorderSafeFsFault: "stage-created-then-throw",
    });
    const expectedStage = encodeReadOnlyAcceptanceReport(
      reportForFixture(fixture, "passed"),
    );

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names).not.toContain(LOCK_NAME);
    const stages = names.filter((name) => name.startsWith(STAGE_PREFIX));
    expect(stages).toHaveLength(1);
    const stagePath = join(fixture.repoRoot, ".dev-vault", stages[0]!);
    expect(await readFile(stagePath)).toEqual(expectedStage);
    const stageStat = await lstat(stagePath, { bigint: true });
    expect({ file: stageStat.isFile(), nlink: stageStat.nlink, mode: stageStat.mode & 0o777n })
      .toEqual({ file: true, nlink: 1n, mode: 0o600n });
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(PRIVATE_SENTINEL);
    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: cleanup-incomplete.\n`,
    });
  }, HEAVY_TIMEOUT_MS);

  it("classifies an unreturned fixed lock creation as cleanup-incomplete and retains it", async () => {
    const fixture = await createPublicationFixture({
      recorderSafeFsFault: "lock-created-then-throw",
    });
    const lockPath = join(fixture.repoRoot, ".dev-vault", LOCK_NAME);

    const cli = await runCli(
      fixture.repoRoot,
      RECORD_SCRIPT,
      JSON.stringify(validHost()),
    );

    expect(await readFile(lockPath)).toEqual(PARTIAL_LOCK_BYTES);
    const lockStat = await lstat(lockPath, { bigint: true });
    expect({ file: lockStat.isFile(), nlink: lockStat.nlink, mode: lockStat.mode & 0o777n })
      .toEqual({ file: true, nlink: 1n, mode: 0o600n });
    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
    expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(PRIVATE_SENTINEL);
    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${RECORD_FAILURE_PREFIX}: cleanup-incomplete.\n`,
    });
  }, HEAVY_TIMEOUT_MS);
});

describe("read-only acceptance independent validator RED boundaries", () => {
  it("accepts valid passed, failed, and inconclusive reports as terminal records", async () => {
    const cases: Array<{
      evidenceMode: EvidenceMode;
      status: "passed" | "failed" | "inconclusive";
    }> = [
      { evidenceMode: "passed", status: "passed" },
      { evidenceMode: "failed", status: "failed" },
      { evidenceMode: "inconclusive", status: "inconclusive" },
    ];

    for (const value of cases) {
      const fixture = await createPublicationFixture();
      await writeFile(fixture.evidenceModePath, `${value.evidenceMode}\n`, "utf8");
      const report = reportForFixture(fixture, value.evidenceMode);
      expect(report.status).toBe(value.status);
      const reportBytes = await writeCanonicalReport(fixture, report);
      const before = await lstat(fixture.reportPath, { bigint: true });

      const cli = await runCli(fixture.repoRoot, VALIDATE_SCRIPT);

      expect(cli, value.status).toEqual({
        code: 0,
        stdout: `${VALIDATE_SUCCESS_PREFIX}: ${value.status}.\n`,
        stderr: "",
      });
      expect(await readFile(fixture.reportPath)).toEqual(reportBytes);
      const after = await lstat(fixture.reportPath, { bigint: true });
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      const names = await readdir(join(fixture.repoRoot, ".dev-vault"));
      expect(names).not.toContain(LOCK_NAME);
      expect(names.some((name) => name.startsWith(STAGE_PREFIX))).toBe(false);
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects and preserves malformed, noncanonical, symlink, and hard-linked reports", async () => {
    for (const kind of ["malformed", "noncanonical", "symlink", "hardlink"] as const) {
      const fixture = await createPublicationFixture();
      const canonical = encodeReadOnlyAcceptanceReport(reportForFixture(fixture, "passed"));
      let expectedBytes: Buffer | null = null;
      let linkTarget: string | null = null;
      if (kind === "malformed") {
        expectedBytes = Buffer.from(`${PRIVATE_SENTINEL}\n`, "utf8");
        await writeFile(fixture.reportPath, expectedBytes, { mode: 0o600 });
      } else if (kind === "noncanonical") {
        expectedBytes = Buffer.from(JSON.stringify(JSON.parse(canonical.toString("utf8"))), "utf8");
        await writeFile(fixture.reportPath, expectedBytes, { mode: 0o600 });
      } else if (kind === "symlink") {
        linkTarget = join(fixture.repoRoot, ".dev-vault", "private-report-target");
        await writeFile(linkTarget, canonical, { mode: 0o600 });
        await symlink("private-report-target", fixture.reportPath);
      } else {
        linkTarget = join(fixture.repoRoot, ".dev-vault", "private-report-hardlink-source");
        await writeFile(linkTarget, canonical, { mode: 0o600 });
        await link(linkTarget, fixture.reportPath);
      }

      const cli = await runCli(fixture.repoRoot, VALIDATE_SCRIPT);

      expect(cli, kind).toEqual({
        code: 1,
        stdout: "",
        stderr: `${VALIDATE_FAILURE_PREFIX}: report-invalid.\n`,
      });
      expect(`${cli.stdout}${cli.stderr}`).not.toMatch(
        /\/tmp\/private|Generated|note-00000|sha256|deadbeef|endpoint|model|secret/iu,
      );
      if (expectedBytes !== null) {
        expect(await readFile(fixture.reportPath)).toEqual(expectedBytes);
      } else if (kind === "symlink") {
        expect(await readlink(fixture.reportPath)).toBe("private-report-target");
        expect(await readFile(linkTarget!)).toEqual(canonical);
      } else {
        const reportStat = await lstat(fixture.reportPath, { bigint: true });
        const targetStat = await lstat(linkTarget!, { bigint: true });
        expect({ ino: reportStat.ino, nlink: reportStat.nlink }).toEqual({
          ino: targetStat.ino,
          nlink: 2n,
        });
        expect(await readFile(fixture.reportPath)).toEqual(canonical);
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("detects current-evidence failure, report replacement, and post-validation residue", async () => {
    const cases = [
      {
        mode: "throw",
        expectedCategory: "report-invalid",
        retainedName: null,
      },
      {
        mode: "replace-report",
        expectedCategory: "report-invalid",
        retainedName: REPORT_NAME,
      },
      {
        mode: "create-lock",
        expectedCategory: "concurrent-operation",
        retainedName: LOCK_NAME,
      },
      {
        mode: "create-stage",
        expectedCategory: "cleanup-incomplete",
        retainedName: `${STAGE_PREFIX}validator`,
      },
    ] as const;

    for (const value of cases) {
      const fixture = await createPublicationFixture();
      const original = await writeCanonicalReport(
        fixture,
        reportForFixture(fixture, "passed"),
      );
      await writeFile(fixture.validatorModePath, `${value.mode}\n`, "utf8");

      const cli = await runCli(fixture.repoRoot, VALIDATE_SCRIPT);

      expect(cli, value.mode).toEqual({
        code: 1,
        stdout: "",
        stderr: `${VALIDATE_FAILURE_PREFIX}: ${value.expectedCategory}.\n`,
      });
      expect(`${cli.stdout}${cli.stderr}`).not.toMatch(
        /\/tmp\/private|Generated|note-00000|sha256|deadbeef|endpoint|model|secret/iu,
      );
      if (value.mode === "replace-report") {
        expect(await readFile(fixture.reportPath, "utf8"))
          .toBe("validator-report-replacement\n");
      } else {
        expect(await readFile(fixture.reportPath)).toEqual(original);
      }
      if (value.retainedName !== null && value.retainedName !== REPORT_NAME) {
        expect(await readFile(join(fixture.repoRoot, ".dev-vault", value.retainedName), "utf8"))
          .toContain("replacement");
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects residue created after the final report identity assertion", async () => {
    const fixture = await createPublicationFixture({ validatorFinalResidueShim: true });
    const original = await writeCanonicalReport(
      fixture,
      reportForFixture(fixture, "passed"),
    );
    const before = await lstat(fixture.reportPath, { bigint: true });

    const cli = await runCli(fixture.repoRoot, VALIDATE_SCRIPT);

    expect(await readFile(fixture.reportPath)).toEqual(original);
    const after = await lstat(fixture.reportPath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    const stagePath = join(fixture.repoRoot, ".dev-vault", VALIDATOR_FINAL_STAGE_NAME);
    expect(await readFile(stagePath)).toEqual(VALIDATOR_FINAL_STAGE_BYTES);
    const stageStat = await lstat(stagePath, { bigint: true });
    expect({ file: stageStat.isFile(), nlink: stageStat.nlink, mode: stageStat.mode & 0o777n })
      .toEqual({ file: true, nlink: 1n, mode: 0o600n });
    await expect(lstat(join(fixture.repoRoot, ".dev-vault", LOCK_NAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(PRIVATE_SENTINEL);
    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: `${VALIDATE_FAILURE_PREFIX}: cleanup-incomplete.\n`,
    });
  }, HEAVY_TIMEOUT_MS);
});
