import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCEPTANCE_REPORT_RELATIVE_PATH } from "./acceptance-run-contract.mjs";
import { validateReportAgainstCurrentEvidence } from "./read-only-acceptance-local-evidence.mjs";
import { decodeReadOnlyAcceptanceReport } from "./read-only-acceptance-report.mjs";
import {
  assertFrozenRegularFile,
  readFrozenRegularFile,
} from "./safe-fs-core.mjs";
import { resolveCanonicalWorktree } from "./synthetic-vault-install-core.mjs";

const REPORT_LOCK_NAME = ".read-only-acceptance-report.lock";
const REPORT_STAGE_PREFIX = ".read-only-acceptance-report.stage-";
const REPORT_NAME = "read-only-acceptance-report.json";
const FAILURE_PREFIX = "Read-only acceptance report validation failed";
const SUCCESS_PREFIX = "Read-only acceptance report is valid";
const PENDING_MESSAGE = "Read-only acceptance report is pending.\n";
const FORBIDDEN_OVERRIDE = /^KNOWLEDGE_WORKBENCH_.*(?:ROOT|PATH|VAULT|FIXTURE|ARTIFACT|MODE|LEASE|OUTPUT|RECEIPT|SEED|REPORT|LOCK|STAGE|OBSERVATION|INPUT)$/u;
const trustedFailureCategories = new WeakMap();

class ValidatorFailure extends Error {
  constructor(category, cause = undefined) {
    super("Read-only acceptance report validation failed", cause === undefined ? undefined : { cause });
    this.name = "ValidatorFailure";
    trustedFailureCategories.set(this, category);
    Object.freeze(this);
  }
}

function failure(category, cause = undefined) {
  return new ValidatorFailure(category, cause);
}

function hasForbiddenEnvironmentOverride() {
  return Object.keys(process.env).some((name) => (
    name === "OBSIDIAN_DEV_VAULT" || FORBIDDEN_OVERRIDE.test(name)
  ));
}

function assertNoResidue(names) {
  if (names.includes(REPORT_LOCK_NAME)) throw failure("concurrent-operation");
  if (names.some((name) => name.startsWith(REPORT_STAGE_PREFIX))) {
    throw failure("cleanup-incomplete");
  }
}

async function assertDevRootIdentity(worktree) {
  const current = await lstat(worktree.devRoot, { bigint: true });
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== worktree.devRootSnapshot.dev
    || current.ino !== worktree.devRootSnapshot.ino
  ) {
    throw failure("report-invalid");
  }
}

function cliCategory(error) {
  return trustedFailureCategories.get(error) ?? "report-invalid";
}

function fail(error) {
  process.stderr.write(`${FAILURE_PREFIX}: ${cliCategory(error)}.\n`);
  process.exitCode = 1;
}

async function main() {
  if (process.argv.length !== 2 || hasForbiddenEnvironmentOverride()) {
    fail(failure("invalid-invocation"));
    return;
  }
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const worktree = await resolveCanonicalWorktree(repoRoot);
    await assertDevRootIdentity(worktree);
    const initialNames = await readdir(worktree.devRoot);
    assertNoResidue(initialNames);
    if (!initialNames.includes(REPORT_NAME)) {
      process.stdout.write(PENDING_MESSAGE);
      process.exitCode = 1;
      return;
    }

    let reportFile;
    let report;
    try {
      reportFile = await readFrozenRegularFile(
        join(worktree.repoRoot, ACCEPTANCE_REPORT_RELATIVE_PATH),
        "Read-only acceptance report",
      );
      report = decodeReadOnlyAcceptanceReport(reportFile.bytes);
    } catch (error) {
      throw failure("report-invalid", error);
    }

    let validationFailure = null;
    try {
      await validateReportAgainstCurrentEvidence(worktree.repoRoot, report);
    } catch (error) {
      validationFailure = error;
    }

    await assertDevRootIdentity(worktree);
    const finalNames = await readdir(worktree.devRoot);
    assertNoResidue(finalNames);
    try {
      await assertFrozenRegularFile(reportFile, "Read-only acceptance report");
    } catch (error) {
      throw failure("report-invalid", error);
    }
    await assertDevRootIdentity(worktree);
    const successNames = await readdir(worktree.devRoot);
    assertNoResidue(successNames);
    if (validationFailure !== null) throw failure("report-invalid", validationFailure);

    process.stdout.write(`${SUCCESS_PREFIX}: ${report.status}.\n`);
  } catch (error) {
    fail(error);
  }
}

await main();
