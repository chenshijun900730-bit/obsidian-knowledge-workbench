import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  INSTALLATION_RECEIPT_RELATIVE_PATH,
  PREPARATION_STATE_RELATIVE_PATH,
  SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH,
  decodeInstallationReceipt,
  decodePreparationState,
} from "./acceptance-run-contract.mjs";
import { assertCleanGitState, captureCleanGitState } from "./git-worktree-state.mjs";
import {
  AUTOMATED_SAFETY_TESTS,
  gatherLocalAcceptanceEvidence,
  validateReportAgainstCurrentEvidence,
} from "./read-only-acceptance-local-evidence.mjs";
import {
  composeReadOnlyAcceptanceReport,
  decodeHostObservation,
  decodeReadOnlyAcceptanceReport,
  encodeReadOnlyAcceptanceReport,
} from "./read-only-acceptance-report.mjs";
import {
  assertExactDirectory,
  assertFrozenRegularFile,
  assertOwnedTree,
  readFrozenRegularFile,
  snapshotExactDirectory,
  snapshotOwnedTree,
  withExclusiveIdentityLock,
  writeExclusiveRegularFile,
} from "./safe-fs-core.mjs";
import { resolveCanonicalWorktree } from "./synthetic-vault-install-core.mjs";

const REPORT_LOCK_NAME = ".read-only-acceptance-report.lock";
const REPORT_STAGE_PREFIX = ".read-only-acceptance-report.stage-";
const REPORT_NAME = "read-only-acceptance-report.json";
const ARTIFACT_RELATIVE_PATH = "dist/read-only-acceptance";
const ARTIFACT_FILES = Object.freeze([
  "acceptance-build.json",
  "main.js",
  "manifest.json",
  "styles.css",
]);
const STATUS_RANK = Object.freeze({ passed: 0, inconclusive: 1, failed: 2 });
const MAX_STDIN_BYTES = 8_192;
const FAILURE_PREFIX = "Read-only acceptance recording failed";
const SUCCESS_MESSAGE = "Recorded the terminal read-only acceptance report.\n";
const FORBIDDEN_OVERRIDE = /^KNOWLEDGE_WORKBENCH_.*(?:ROOT|PATH|VAULT|FIXTURE|ARTIFACT|MODE|LEASE|OUTPUT|RECEIPT|SEED|REPORT|LOCK|STAGE|OBSERVATION|INPUT)$/u;
const HOOK_NAMES = Object.freeze([
  "afterRunAnchor",
  "afterAutomatedSafety",
  "afterFinalEvidence",
  "afterReportStaged",
  "beforeReportPublish",
]);
const ALLOWED_FAILURE_CATEGORIES = new Set([
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
  "report-invalid",
]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const trustedFailureCategories = new WeakMap();

class RecorderFailure extends Error {
  constructor(category, cause = undefined) {
    super("Read-only acceptance recording failed", cause === undefined ? undefined : { cause });
    this.name = "RecorderFailure";
    trustedFailureCategories.set(this, category);
    Object.freeze(this);
  }
}

function failure(category, cause = undefined) {
  return new RecorderFailure(category, cause);
}

function hasErrorCode(error, code, seen = new Set()) {
  if (error === null || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  try {
    if (error.code === code) return true;
    if ("cause" in error && hasErrorCode(error.cause, code, seen)) return true;
    return error instanceof AggregateError
      && error.errors.some((nested) => hasErrorCode(nested, code, seen));
  } catch {
    return false;
  }
}

function decodeOptions(options) {
  try {
    if (
      typeof options !== "object"
      || options === null
      || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype
    ) {
      throw new Error("Recorder options must be a plain object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length < 2
      || keys.length > 3
      || keys[0] !== "repoRoot"
      || keys[1] !== "observation"
      || (keys.length === 3 && keys[2] !== "hooks")
    ) {
      throw new Error("Recorder options must use the exact data keys");
    }
    const repoRoot = descriptors.repoRoot;
    const observation = descriptors.observation;
    const hooks = descriptors.hooks;
    if (!("value" in repoRoot) || typeof repoRoot.value !== "string") {
      throw new Error("repoRoot must be an own string data property");
    }
    if (!("value" in observation)) throw new Error("observation must be an own data property");
    let sourceHooks = {};
    if (hooks !== undefined) {
      if (!("value" in hooks)) throw new Error("hooks must be an own data property");
      sourceHooks = hooks.value;
    }
    if (
      typeof sourceHooks !== "object"
      || sourceHooks === null
      || Array.isArray(sourceHooks)
      || Object.getPrototypeOf(sourceHooks) !== Object.prototype
    ) {
      throw new Error("hooks must be a plain object");
    }
    const hookDescriptors = Object.getOwnPropertyDescriptors(sourceHooks);
    const hookKeys = Reflect.ownKeys(hookDescriptors);
    const checkedHooks = {};
    let previousHookPosition = -1;
    for (const key of hookKeys) {
      const position = typeof key === "string" ? HOOK_NAMES.indexOf(key) : -1;
      const descriptor = hookDescriptors[key];
      if (
        position <= previousHookPosition
        || !("value" in descriptor)
        || typeof descriptor.value !== "function"
      ) {
        throw new Error("hooks must use canonical function-valued data properties");
      }
      checkedHooks[key] = descriptor.value;
      previousHookPosition = position;
    }
    return Object.freeze({
      repoRoot: repoRoot.value,
      observation: decodeHostObservation(observation.value),
      hooks: Object.freeze(checkedHooks),
    });
  } catch (error) {
    throw failure("invalid-invocation", error);
  }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isCompletedAssertionFailure(error, stdout, stderr) {
  if (
    typeof error.code !== "number"
    || error.code === 0
    || error.killed === true
    || (error.signal !== null && error.signal !== undefined)
  ) {
    return false;
  }
  const output = Buffer.concat([
    Buffer.isBuffer(stdout) ? stdout : Buffer.from(typeof stdout === "string" ? stdout : ""),
    Buffer.isBuffer(stderr) ? stderr : Buffer.from(typeof stderr === "string" ? stderr : ""),
  ]).toString("utf8");
  return /(?:^|\n)\s*Tests\s+[^\n]*\b[1-9]\d* failed\b/u.test(output);
}

function runAutomatedSafety(repoRoot) {
  const vitestPath = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  return new Promise((resolvePromise) => {
    try {
      execFile(
        process.execPath,
        [
          vitestPath,
          "run",
          ...AUTOMATED_SAFETY_TESTS,
          "--no-file-parallelism",
          "--maxWorkers=1",
        ],
        {
          cwd: repoRoot,
          timeout: 600_000,
          maxBuffer: 1_048_576,
          shell: false,
          env: {
            PATH: process.env.PATH ?? "",
            NODE_ENV: "test",
            CI: "1",
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolvePromise("passed");
            return;
          }
          resolvePromise(
            isCompletedAssertionFailure(error, stdout, stderr) ? "failed" : "inconclusive",
          );
        },
      );
    } catch {
      resolvePromise("inconclusive");
    }
  });
}

async function captureRunAnchor(worktree) {
  const git = await captureCleanGitState(worktree.repoRoot);
  const stateFile = await readFrozenRegularFile(
    join(worktree.repoRoot, PREPARATION_STATE_RELATIVE_PATH),
    "Read-only acceptance preparation state",
  );
  const receiptFile = await readFrozenRegularFile(
    join(worktree.repoRoot, INSTALLATION_RECEIPT_RELATIVE_PATH),
    "Read-only acceptance installation receipt",
  );
  const state = decodePreparationState(stateFile.bytes);
  const receipt = decodeInstallationReceipt(receiptFile.bytes);
  if (
    state.runId !== receipt.runId
    || state.commit !== receipt.commit
    || state.commit !== git.commit
    || receipt.fixtureStateDigest !== sha256(stateFile.bytes)
  ) {
    throw new Error("Current state and receipt do not form one run anchor");
  }
  await assertFrozenRegularFile(stateFile, "Read-only acceptance preparation state");
  await assertFrozenRegularFile(receiptFile, "Read-only acceptance installation receipt");
  await assertCleanGitState(worktree.repoRoot, git.commit);
  return Object.freeze({ git, receipt, receiptFile, state, stateFile });
}

async function assertInitialReportNamespace(devRoot) {
  const names = await readdir(devRoot);
  if (names.includes(REPORT_NAME)) throw failure("target-exists");
  if (names.some((name) => name.startsWith(REPORT_STAGE_PREFIX))) {
    throw failure("cleanup-incomplete");
  }
}

function hookContext(worktree, anchor, reportStagePath = null) {
  return Object.freeze({
    repoRoot: worktree.repoRoot,
    lockPath: join(worktree.devRoot, REPORT_LOCK_NAME),
    reportStagePath,
    reportPath: join(worktree.devRoot, REPORT_NAME),
    statePath: join(worktree.repoRoot, PREPARATION_STATE_RELATIVE_PATH),
    receiptPath: join(worktree.repoRoot, INSTALLATION_RECEIPT_RELATIVE_PATH),
    targetPath: join(
      worktree.repoRoot,
      SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH,
      [".", "obsidian"].join(""),
      "plugins",
      "knowledge-workbench",
    ),
    runId: anchor.state.runId,
    commit: anchor.git.commit,
  });
}

function worstStatus(left, right) {
  if (!Object.hasOwn(STATUS_RANK, left) || !Object.hasOwn(STATUS_RANK, right)) {
    throw new Error("Automated safety status must be terminal");
  }
  return STATUS_RANK[left] >= STATUS_RANK[right] ? left : right;
}

function combineAutomatedSafety(local, automatedSafety) {
  return Object.freeze({
    runId: local.runId,
    commit: local.commit,
    pluginVersion: local.pluginVersion,
    artifactBinding: local.artifactBinding,
    syntheticNoteCount: local.syntheticNoteCount,
    artifactIdentity: local.artifactIdentity,
    fixtureIdentity: local.fixtureIdentity,
    automatedSafety: worstStatus(automatedSafety, local.automatedSafety),
    contentUnchanged: local.contentUnchanged,
    startupNormalizationEvidence: local.startupNormalizationEvidence,
    hostIsolation: local.hostIsolation,
    historySensitiveActionsBlocked: local.historySensitiveActionsBlocked,
    networkBoundary: local.networkBoundary,
    recoveryAbsent: local.recoveryAbsent,
    finalHostStopped: local.finalHostStopped,
  });
}

async function collectOwnedTreePaths(root, relativeRoot = "") {
  const paths = [];
  for (const name of (await readdir(join(root, relativeRoot))).sort()) {
    const relativePath = relativeRoot.length === 0 ? name : join(relativeRoot, name);
    const stat = await lstat(join(root, relativePath), { bigint: true });
    if (stat.isSymbolicLink()) throw new Error("Final evidence must not contain symbolic links");
    if (stat.isDirectory()) {
      paths.push(relativePath, ...await collectOwnedTreePaths(root, relativePath));
      continue;
    }
    if (!stat.isFile()) throw new Error("Final evidence must contain only files and directories");
    paths.push(relativePath);
  }
  return paths;
}

async function optionalFrozenRegularFile(path, label) {
  try {
    return await readFrozenRegularFile(path, label);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function assertAbsent(path, label) {
  try {
    await lstat(path, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw new Error(`${label} absence could not be confirmed`, { cause: error });
  }
  throw new Error(`${label} must remain absent`);
}

async function assertDevRootIdentity(worktree) {
  const current = await lstat(worktree.devRoot, { bigint: true });
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== worktree.devRootSnapshot.dev
    || current.ino !== worktree.devRootSnapshot.ino
  ) {
    throw new Error("Acceptance namespace root identity changed");
  }
}

async function assertExpectedReportNamespace(worktree, reportStagePath) {
  await assertDevRootIdentity(worktree);
  const names = await readdir(worktree.devRoot);
  if (names.includes(REPORT_NAME)) throw new Error("Acceptance report appeared before publication");
  const stages = names.filter((name) => name.startsWith(REPORT_STAGE_PREFIX));
  if (reportStagePath === null) {
    if (stages.length !== 0) throw new Error("Unexpected acceptance report stage appeared");
    return;
  }
  if (stages.length !== 1 || stages[0] !== basename(reportStagePath)) {
    throw new Error("Acceptance report stage namespace changed");
  }
}

async function captureFinalWitness(worktree, anchor) {
  await assertFrozenRegularFile(anchor.stateFile, "Read-only acceptance preparation state");
  await assertFrozenRegularFile(anchor.receiptFile, "Read-only acceptance installation receipt");
  await assertCleanGitState(worktree.repoRoot, anchor.git.commit);
  await assertExpectedReportNamespace(worktree, null);

  const lock = await readFrozenRegularFile(
    join(worktree.devRoot, REPORT_LOCK_NAME),
    "Read-only acceptance report lock",
  );
  const artifact = await snapshotExactDirectory(
    join(worktree.repoRoot, ARTIFACT_RELATIVE_PATH),
    [...ARTIFACT_FILES],
    "Read-only acceptance artifact",
  );
  const vaultPath = join(worktree.repoRoot, SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH);
  const vault = await snapshotOwnedTree(
    vaultPath,
    await collectOwnedTreePaths(vaultPath),
    "Read-only acceptance synthetic vault",
  );
  const legacy = await optionalFrozenRegularFile(
    join(worktree.devRoot, "acceptance.json"),
    "Legacy acceptance sentinel",
  );

  const witness = Object.freeze({ artifact, legacy, lock, vault });
  await assertFrozenRegularFile(lock, "Read-only acceptance report lock");
  await assertExactDirectory(artifact, "Read-only acceptance artifact");
  await assertOwnedTree(vault, "Read-only acceptance synthetic vault");
  if (legacy !== null) await assertFrozenRegularFile(legacy, "Legacy acceptance sentinel");
  await assertFrozenRegularFile(anchor.stateFile, "Read-only acceptance preparation state");
  await assertFrozenRegularFile(anchor.receiptFile, "Read-only acceptance installation receipt");
  await assertCleanGitState(worktree.repoRoot, anchor.git.commit);
  return witness;
}

async function assertFinalWitness(worktree, anchor, witness) {
  await assertDevRootIdentity(worktree);
  await assertFrozenRegularFile(witness.lock, "Read-only acceptance report lock");
  await assertFrozenRegularFile(anchor.stateFile, "Read-only acceptance preparation state");
  await assertFrozenRegularFile(anchor.receiptFile, "Read-only acceptance installation receipt");
  await assertExactDirectory(witness.artifact, "Read-only acceptance artifact");
  await assertOwnedTree(witness.vault, "Read-only acceptance synthetic vault");
  if (witness.legacy === null) {
    await assertAbsent(join(worktree.devRoot, "acceptance.json"), "Legacy acceptance sentinel");
  } else {
    await assertFrozenRegularFile(witness.legacy, "Legacy acceptance sentinel");
  }
  await assertCleanGitState(worktree.repoRoot, anchor.git.commit);
}

function sameExplicitFileEvidence(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.sha256 === right.sha256;
}

async function assertPublishedFile(reportPath, stage, expected = null) {
  const report = expected ?? await readFrozenRegularFile(
    reportPath,
    "Read-only acceptance report",
  );
  if (expected !== null) {
    await assertFrozenRegularFile(expected, "Read-only acceptance report");
  }
  const stat = await lstat(reportPath, { bigint: true });
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.nlink !== 1n
    || stat.dev !== report.evidence.dev
    || stat.ino !== report.evidence.ino
    || stat.size !== report.evidence.size
    || !sameExplicitFileEvidence(report.evidence, stage.evidence)
    || !report.bytes.equals(stage.bytes)
    || (stat.mode & 0o777n) !== 0o600n
  ) {
    throw new Error("Published acceptance report is not the exact staged file");
  }
  await assertFrozenRegularFile(report, "Read-only acceptance report");
  return report;
}

async function finalizeNoReplacePublication(reportPath, stage) {
  const reportStat = await lstat(reportPath, { bigint: true });
  const stageStat = await lstat(stage.path, { bigint: true });
  if (
    stageStat.isSymbolicLink()
    || reportStat.isSymbolicLink()
    || !stageStat.isFile()
    || !reportStat.isFile()
    || stageStat.nlink !== 2n
    || reportStat.nlink !== 2n
    || stageStat.dev !== stage.evidence.dev
    || stageStat.ino !== stage.evidence.ino
    || reportStat.dev !== stage.evidence.dev
    || reportStat.ino !== stage.evidence.ino
    || stageStat.size !== stage.evidence.size
    || reportStat.size !== stage.evidence.size
  ) {
    throw new Error("Atomic acceptance report link is not the exact staged file");
  }
  await unlink(stage.path);
  await assertAbsent(stage.path, "Read-only acceptance report stage");
  return await assertPublishedFile(reportPath, stage);
}

async function removeExactStage(stage) {
  await assertFrozenRegularFile(stage, "Read-only acceptance report stage");
  const immediate = await lstat(stage.path, { bigint: true });
  if (
    immediate.isSymbolicLink()
    || !immediate.isFile()
    || immediate.nlink !== 1n
    || immediate.dev !== stage.evidence.dev
    || immediate.ino !== stage.evidence.ino
    || immediate.size !== stage.evidence.size
  ) {
    throw new Error("Read-only acceptance report stage changed before cleanup");
  }
  await unlink(stage.path);
  await assertAbsent(stage.path, "Read-only acceptance report stage");
}

async function removeExactPublishedReport(reportPath, stage, reportFile = null) {
  await assertPublishedFile(reportPath, stage, reportFile);
  const immediate = await lstat(reportPath, { bigint: true });
  if (
    immediate.isSymbolicLink()
    || !immediate.isFile()
    || immediate.nlink !== 1n
    || immediate.dev !== stage.evidence.dev
    || immediate.ino !== stage.evidence.ino
    || immediate.size !== stage.evidence.size
  ) {
    throw new Error("Published acceptance report changed before rollback");
  }
  await unlink(reportPath);
  await assertAbsent(reportPath, "Read-only acceptance report");
}

async function assertPublishedContinuity(worktree, witness, stage, reportFile) {
  await assertDevRootIdentity(worktree);
  const names = await readdir(worktree.devRoot);
  if (
    !names.includes(REPORT_NAME)
    || names.some((name) => name.startsWith(REPORT_STAGE_PREFIX))
  ) {
    throw new Error("Published acceptance report namespace changed");
  }
  await assertFrozenRegularFile(witness.lock, "Read-only acceptance report lock");
  await assertPublishedFile(join(worktree.devRoot, REPORT_NAME), stage, reportFile);
}

function containsTrustedCategory(error, category, seen = new Set()) {
  if (
    error === null
    || (typeof error !== "object" && typeof error !== "function")
    || seen.has(error)
  ) {
    return false;
  }
  seen.add(error);
  if (trustedFailureCategories.get(error) === category) return true;
  try {
    if ("cause" in error && containsTrustedCategory(error.cause, category, seen)) return true;
    return error instanceof AggregateError
      && error.errors.some((nested) => containsTrustedCategory(nested, category, seen));
  } catch {
    return false;
  }
}

function normalizeHookFailure(error) {
  const trustedCategory = (
    error !== null && (typeof error === "object" || typeof error === "function")
  ) ? trustedFailureCategories.get(error) : undefined;
  if (trustedCategory === "report-invalid" || trustedCategory === "concurrent-operation") {
    return error;
  }
  return failure("report-invalid", error);
}

async function invokeHook(hooks, name, context) {
  const hook = hooks[name];
  if (hook === undefined) return;
  try {
    await hook(context);
  } catch (error) {
    throw normalizeHookFailure(error);
  }
}

async function assertTransactionContinuity(
  worktree,
  anchor,
  witness,
  stage = null,
) {
  try {
    await assertFinalWitness(worktree, anchor, witness);
    await assertExpectedReportNamespace(worktree, stage?.path ?? null);
    if (stage !== null) {
      await assertFrozenRegularFile(stage, "Read-only acceptance report stage");
    }
    await assertAbsent(
      join(worktree.devRoot, REPORT_NAME),
      "Read-only acceptance report",
    );
  } catch (error) {
    throw failure("concurrent-operation", error);
  }
}

async function publishReport({
  anchor,
  hooks,
  publicationState,
  report,
  reportBytes,
  witness,
  worktree,
}) {
  const reportPath = join(worktree.devRoot, REPORT_NAME);
  const stagePath = join(worktree.devRoot, `${REPORT_STAGE_PREFIX}${randomUUID()}`);
  let stage = null;
  let published = false;
  try {
    await assertTransactionContinuity(worktree, anchor, witness);
    try {
      stage = await writeExclusiveRegularFile(
        stagePath,
        reportBytes,
        "Read-only acceptance report stage",
      );
      publicationState.stage = stage;
    } catch (error) {
      try {
        await assertAbsent(stagePath, "Read-only acceptance report stage");
      } catch (residueError) {
        throw failure(
          "cleanup-incomplete",
          new AggregateError([error, residueError]),
        );
      }
      throw failure("concurrent-operation", error);
    }

    const context = hookContext(worktree, anchor, stage.path);
    await invokeHook(hooks, "afterReportStaged", context);
    await assertTransactionContinuity(worktree, anchor, witness, stage);
    await invokeHook(hooks, "beforeReportPublish", context);
    await assertTransactionContinuity(worktree, anchor, witness, stage);

    try {
      await link(stage.path, reportPath);
      published = true;
      publicationState.published = true;
      publicationState.reportFile = await finalizeNoReplacePublication(reportPath, stage);
    } catch (error) {
      throw failure("concurrent-operation", error);
    }
    try {
      const publishedReport = decodeReadOnlyAcceptanceReport(
        publicationState.reportFile.bytes,
      );
      await validateReportAgainstCurrentEvidence(worktree.repoRoot, publishedReport);
    } catch (error) {
      throw failure("report-invalid", error);
    }
    try {
      await assertFinalWitness(worktree, anchor, witness);
      await assertPublishedContinuity(
        worktree,
        witness,
        stage,
        publicationState.reportFile,
      );
    } catch (error) {
      throw failure("concurrent-operation", error);
    }
    return report;
  } catch (error) {
    let ownershipCleanupFailure = null;
    if (stage !== null) {
      try {
        if (published) {
          await removeExactPublishedReport(
            reportPath,
            stage,
            publicationState.reportFile,
          );
          publicationState.published = false;
          publicationState.reportFile = null;
        } else {
          await removeExactStage(stage);
        }
        publicationState.stage = null;
      } catch (cleanupError) {
        ownershipCleanupFailure = cleanupError;
      }
    }
    if (ownershipCleanupFailure !== null) {
      throw failure(
        published ? "rollback-incomplete" : "cleanup-incomplete",
        new AggregateError([error, ownershipCleanupFailure]),
      );
    }
    throw error;
  }
}

export async function recordReadOnlyAcceptance(options) {
  const checked = decodeOptions(options);
  let worktree;
  try {
    worktree = await resolveCanonicalWorktree(checked.repoRoot);
  } catch (error) {
    throw failure("fixture-invalid", error);
  }

  let callbackEntered = false;
  let publicationCompleted = false;
  const lockPath = join(worktree.devRoot, REPORT_LOCK_NAME);
  const publicationState = { published: false, reportFile: null, stage: null };
  try {
    return await withExclusiveIdentityLock(
      {
        parent: worktree.devRootSnapshot,
        name: REPORT_LOCK_NAME,
        label: "Read-only acceptance report lock",
      },
      async () => {
        callbackEntered = true;
        await assertInitialReportNamespace(worktree.devRoot);
        let anchor;
        try {
          anchor = await captureRunAnchor(worktree);
        } catch (error) {
          throw failure("fixture-invalid", error);
        }
        const context = hookContext(worktree, anchor);
        await invokeHook(checked.hooks, "afterRunAnchor", context);
        const automatedSafety = await runAutomatedSafety(worktree.repoRoot);
        await invokeHook(checked.hooks, "afterAutomatedSafety", context);
        let localEvidence;
        try {
          localEvidence = await gatherLocalAcceptanceEvidence(worktree.repoRoot);
        } catch (error) {
          throw failure("fixture-changed", error);
        }
        let report;
        let reportBytes;
        try {
          const combined = combineAutomatedSafety(localEvidence, automatedSafety);
          if (combined.runId !== anchor.state.runId || combined.commit !== anchor.git.commit) {
            throw new Error("Final evidence does not match the captured run anchor");
          }
          report = composeReadOnlyAcceptanceReport(combined, checked.observation);
          reportBytes = encodeReadOnlyAcceptanceReport(report);
        } catch (error) {
          throw failure("report-invalid", error);
        }
        let witness = null;
        let witnessFailure = null;
        try {
          witness = await captureFinalWitness(worktree, anchor);
        } catch (error) {
          witnessFailure = error;
        }
        await invokeHook(checked.hooks, "afterFinalEvidence", context);
        if (witnessFailure !== null || witness === null) {
          throw failure("fixture-changed", witnessFailure);
        }
        await assertTransactionContinuity(worktree, anchor, witness);
        const terminalReport = await publishReport({
          anchor,
          hooks: checked.hooks,
          publicationState,
          report,
          reportBytes,
          witness,
          worktree,
        });
        publicationCompleted = true;
        return terminalReport;
      },
    );
  } catch (error) {
    if (
      publicationCompleted
      && publicationState.published
      && publicationState.stage !== null
    ) {
      try {
        await removeExactPublishedReport(
          join(worktree.devRoot, REPORT_NAME),
          publicationState.stage,
          publicationState.reportFile,
        );
        publicationState.published = false;
        publicationState.reportFile = null;
        publicationState.stage = null;
      } catch (rollbackError) {
        throw failure("rollback-incomplete", new AggregateError([error, rollbackError]));
      }
    }
    if (!callbackEntered && hasErrorCode(error, "EEXIST")) {
      throw failure("concurrent-operation", error);
    }
    if (!callbackEntered) {
      try {
        await assertAbsent(lockPath, "Read-only acceptance report lock");
      } catch (residueError) {
        throw failure(
          "cleanup-incomplete",
          new AggregateError([error, residueError]),
        );
      }
    }
    if (trustedFailureCategories.has(error)) throw error;
    if (containsTrustedCategory(error, "rollback-incomplete")) {
      throw failure("rollback-incomplete", error);
    }
    if (error instanceof AggregateError) throw failure("cleanup-incomplete", error);
    throw failure("fixture-invalid", error);
  }
}

function hasForbiddenEnvironmentOverride() {
  return Object.keys(process.env).some((name) => (
    name === "OBSIDIAN_DEV_VAULT" || FORBIDDEN_OVERRIDE.test(name)
  ));
}

async function readBoundedStdin() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_STDIN_BYTES) throw failure("invalid-invocation");
    chunks.push(bytes);
  }
  try {
    return UTF8.decode(Buffer.concat(chunks, byteLength));
  } catch (error) {
    throw failure("invalid-invocation", error);
  }
}

function cliCategory(error) {
  const category = trustedFailureCategories.get(error);
  return category !== undefined && ALLOWED_FAILURE_CATEGORIES.has(category)
    ? category
    : "fixture-invalid";
}

async function main() {
  if (process.argv.length !== 2 || hasForbiddenEnvironmentOverride()) {
    process.stderr.write(`${FAILURE_PREFIX}: invalid-invocation.\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const input = await readBoundedStdin();
    let value;
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw failure("invalid-invocation", error);
    }
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    await recordReadOnlyAcceptance({ repoRoot, observation: value });
    process.stdout.write(SUCCESS_MESSAGE);
  } catch (error) {
    process.stderr.write(`${FAILURE_PREFIX}: ${cliCategory(error)}.\n`);
    process.exitCode = 1;
  }
}

function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) await main();
