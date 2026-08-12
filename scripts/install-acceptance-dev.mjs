import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ACCEPTANCE_FILES,
  buildAcceptanceArtifactUnderLease,
  loadAcceptanceArtifactSource,
  withAcceptanceArtifactLock,
} from "./acceptance-build.mjs";
import {
  computeAcceptanceArtifactSetDigest,
  validateAcceptanceArtifactSnapshot,
} from "./acceptance-artifact-contract.mjs";
import {
  ACCEPTANCE_REPORT_RELATIVE_PATH,
  INSTALLATION_RECEIPT_RELATIVE_PATH,
  PREPARATION_STATE_RELATIVE_PATH,
  SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH,
  createInstallationReceipt,
  decodeInstallationReceipt,
  decodePreparationState,
  encodeInstallationReceipt,
} from "./acceptance-run-contract.mjs";
import {
  assertCleanGitState,
  captureCleanGitState,
} from "./git-worktree-state.mjs";
import {
  assertDirectoryInOwnedTree,
  assertExactDirectory,
  assertExactDirectoryInOwnedTree,
  assertFrozenRegularFile,
  assertFrozenRegularFileInOwnedTree,
  assertOwnedTree,
  assertOwnedTreeContinuity,
  readFrozenRegularFile,
  removeOwnedTreeBottomUp,
  snapshotExactDirectory,
  snapshotOwnedTree,
  withExclusiveIdentityLock,
  writeExclusiveRegularFile,
} from "./safe-fs-core.mjs";
import {
  decodeSyntheticPluginDataSeed,
  encodeSyntheticPluginDataSeed,
} from "./synthetic-acceptance-data.mjs";
import {
  attestSyntheticAcceptanceInstallState,
  attestSyntheticAcceptanceVault,
} from "./synthetic-acceptance-vault.mjs";
import {
  OBSIDIAN_CONFIG_DIRECTORY,
  resolveCanonicalWorktree,
} from "./synthetic-vault-install-core.mjs";

const PLUGIN_ID = "knowledge-workbench";
const ARTIFACT_LOCK_NAME = ".read-only-acceptance.lock";
const ARTIFACT_TARGET_NAME = "read-only-acceptance";
const DESTINATION_LOCK_NAME = ".knowledge-workbench-read-only-acceptance.lock";
const TARGET_STAGE_PREFIX = ".knowledge-workbench-read-only-acceptance.stage-";
const TARGET_BACKUP_PREFIX = ".knowledge-workbench-read-only-acceptance.backup-";
const TARGET_QUARANTINE_PREFIX = ".knowledge-workbench-read-only-acceptance.quarantine-";
const RECEIPT_STAGE_PREFIX = ".read-only-acceptance-receipt.stage-";
const TARGET_FILES_FOUR = ACCEPTANCE_FILES;
const TARGET_FILES_FIVE = Object.freeze([...ACCEPTANCE_FILES, "data.json"].sort());
const ARTIFACT_RESIDUE_PREFIXES = Object.freeze([
  ".read-only-acceptance.tmp-",
  ".read-only-acceptance.backup-",
  ".read-only-acceptance.quarantine-",
]);
const PLUGINS_RELATIVE_PATH = join(OBSIDIAN_CONFIG_DIRECTORY, "plugins");
const HOOK_NAMES = Object.freeze([
  "afterArtifactLock",
  "afterBuild",
  "afterSourceFreeze",
  "afterDestinationLock",
  "afterStageCreated",
  "afterStageValidated",
  "afterTargetPublished",
  "beforeSeed",
  "afterSeed",
  "beforeReceiptPublish",
  "afterReceiptPublish",
]);
const FAILURE_CATEGORIES = new Set([
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
]);
const NO_FAILURE = Symbol("no acceptance installer failure");
const artifactCallbackFailures = new WeakMap();
const artifactCleanupFailures = new WeakMap();
const destinationCallbackFailures = new WeakMap();
const destinationCleanupFailures = new WeakMap();
const trustedInstallFailureCategories = new WeakMap();
const ACCEPTANCE_INSTALL_FAILURE_TOKEN = Object.freeze({});

class AcceptanceInstallFailure extends Error {
  constructor(token, category, message, options = undefined) {
    super(`${category}: ${message}`, options);
    if (token !== ACCEPTANCE_INSTALL_FAILURE_TOKEN) {
      throw new TypeError("Acceptance install failures cannot be constructed externally");
    }
    this.name = "AcceptanceInstallFailure";
    Object.defineProperty(this, "category", {
      configurable: false,
      enumerable: true,
      value: category,
      writable: false,
    });
    trustedInstallFailureCategories.set(this, category);
    Object.freeze(this);
  }
}

Object.freeze(AcceptanceInstallFailure.prototype);
Object.freeze(AcceptanceInstallFailure);

const isTrustedInstallFailure = (error) => trustedInstallFailureCategories.has(error);

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameFileEvidence = (left, right) => sameIdentity(left, right)
  && left.nlink === right.nlink
  && left.size === right.size
  && left.sha256 === right.sha256;

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown acceptance installation failure";
}

function normalizeFailure(error, fallbackCategory) {
  const trustedCategory = trustedInstallFailureCategories.get(error);
  if (trustedCategory !== undefined && FAILURE_CATEGORIES.has(trustedCategory)) return error;
  return new AcceptanceInstallFailure(
    ACCEPTANCE_INSTALL_FAILURE_TOKEN,
    fallbackCategory,
    errorMessage(error),
    { cause: error },
  );
}

function forceFailure(category, message, error) {
  return new AcceptanceInstallFailure(
    ACCEPTANCE_INSTALL_FAILURE_TOKEN,
    category,
    message,
    { cause: error },
  );
}

function fail(category, message, cause = undefined) {
  throw new AcceptanceInstallFailure(
    ACCEPTANCE_INSTALL_FAILURE_TOKEN,
    category,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function brandHelperFailure(registry, cause, label) {
  const wrapper = new Error(label);
  registry.set(wrapper, cause);
  return wrapper;
}

async function withBrandedArtifactLock(repoRoot, callback) {
  try {
    return await withAcceptanceArtifactLock(repoRoot, async (lease) => {
      try {
        return await callback(lease);
      } catch (error) {
        throw brandHelperFailure(
          artifactCallbackFailures,
          error,
          "Acceptance installer artifact callback failed",
        );
      }
    });
  } catch (error) {
    if (artifactCallbackFailures.has(error)) throw artifactCallbackFailures.get(error);
    if (error instanceof AggregateError) {
      throw brandHelperFailure(
        artifactCleanupFailures,
        error,
        "Acceptance installer artifact-lock cleanup failed",
      );
    }
    throw error;
  }
}

async function withBrandedDestinationLock(input, callback) {
  try {
    return await withExclusiveIdentityLock(input, async (lease) => {
      try {
        return await callback(lease);
      } catch (error) {
        throw brandHelperFailure(
          destinationCallbackFailures,
          error,
          "Acceptance installer destination callback failed",
        );
      }
    });
  } catch (error) {
    if (destinationCallbackFailures.has(error)) throw destinationCallbackFailures.get(error);
    if (error instanceof AggregateError) {
      throw brandHelperFailure(
        destinationCleanupFailures,
        error,
        "Acceptance installer destination-lock cleanup failed",
      );
    }
    throw error;
  }
}

function validateOptions(options) {
  try {
    if (
      typeof options !== "object"
      || options === null
      || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype
    ) {
      fail("invalid-invocation", "options must be one plain data object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(descriptors);
    if (
      !keys.includes("repoRoot")
      || keys.some((key) => typeof key !== "string" || (key !== "repoRoot" && key !== "hooks"))
    ) {
      fail("invalid-invocation", "options must contain only own repoRoot and hooks fields");
    }
    const repoRootDescriptor = descriptors.repoRoot;
    if (!("value" in repoRootDescriptor) || typeof repoRootDescriptor.value !== "string") {
      fail("invalid-invocation", "repoRoot must be an own string data property");
    }
    const hooksDescriptor = descriptors.hooks;
    if (hooksDescriptor !== undefined && !("value" in hooksDescriptor)) {
      fail("invalid-invocation", "hooks must be an own data property");
    }
    const sourceHooks = hooksDescriptor === undefined ? {} : hooksDescriptor.value;
    if (
      typeof sourceHooks !== "object"
      || sourceHooks === null
      || Array.isArray(sourceHooks)
      || Object.getPrototypeOf(sourceHooks) !== Object.prototype
    ) {
      fail("invalid-invocation", "hooks must be one plain data object");
    }
    const hooks = {};
    const hookDescriptors = Object.getOwnPropertyDescriptors(sourceHooks);
    for (const key of Reflect.ownKeys(hookDescriptors)) {
      const descriptor = hookDescriptors[key];
      if (
        typeof key !== "string"
        || !HOOK_NAMES.includes(key)
        || !("value" in descriptor)
        || typeof descriptor.value !== "function"
      ) {
        fail("invalid-invocation", "hooks contain an unknown or invalid data property");
      }
      hooks[key] = descriptor.value;
    }
    return Object.freeze({ repoRoot: repoRootDescriptor.value, hooks: Object.freeze(hooks) });
  } catch (error) {
    throw forceFailure("invalid-invocation", "installer invocation is invalid", error);
  }
}

function hasErrorCode(error, code, seen = new Set()) {
  if (error === null || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  try {
    if (error.code === code) return true;
  } catch {
    return false;
  }
  const nested = [];
  if ("cause" in error) nested.push(error.cause);
  if (error instanceof AggregateError) nested.push(...error.errors);
  return nested.some((item) => hasErrorCode(item, code, seen));
}

async function optionalStat(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function assertAbsent(path, label) {
  if (await optionalStat(path) !== null) throw new Error(`${label} must remain absent`);
}

function retainedArtifactResidue(names) {
  return names.filter((name) => ARTIFACT_RESIDUE_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

async function captureArtifactDistNamespace(paths, category) {
  const distPath = join(paths.repoRoot, "dist");
  try {
    const before = await lstat(distPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory() || await realpath(distPath) !== distPath) {
      throw new Error("dist must remain one canonical non-symlink directory");
    }
    const names = (await readdir(distPath)).sort();
    if (retainedArtifactResidue(names).length !== 0) {
      fail("concurrent-operation", "reserved acceptance artifact residue appeared during the active lease");
    }
    const after = await lstat(distPath, { bigint: true });
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || !sameIdentity(before, after)
      || before.ctimeNs !== after.ctimeNs
      || !isDeepStrictEqual((await readdir(distPath)).sort(), names)
    ) {
      throw new Error("dist namespace changed while it was frozen");
    }
    return Object.freeze({
      path: distPath,
      dev: after.dev,
      ino: after.ino,
      ctimeNs: after.ctimeNs,
      names: Object.freeze(names),
    });
  } catch (error) {
    if (isTrustedInstallFailure(error)) throw error;
    fail(category, "acceptance artifact namespace is invalid or changed", error);
  }
}

async function assertArtifactDistBoundary(transaction) {
  const current = await captureArtifactDistNamespace(transaction.paths, "concurrent-operation");
  if (transaction.distNamespace === null) return;
  if (
    !sameIdentity(current, transaction.distNamespace)
    || current.ctimeNs !== transaction.distNamespace.ctimeNs
    || !isDeepStrictEqual(current.names, transaction.distNamespace.names)
  ) {
    fail("concurrent-operation", "acceptance artifact namespace changed during the active lease");
  }
}

async function snapshotDirectory(path, label) {
  let stat;
  try {
    stat = await lstat(path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} must be an existing non-symlink directory`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino });
}

async function assertDirectorySnapshot(snapshot, label) {
  const current = await snapshotDirectory(snapshot.path, label);
  if (!sameIdentity(current, snapshot) || await realpath(snapshot.path) !== snapshot.path) {
    throw new Error(`${label} identity or canonical path changed`);
  }
}

async function assertPrivateDirectoryMode(snapshot, label) {
  const current = await lstat(snapshot.path, { bigint: true });
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || !sameIdentity(current, snapshot)
    || (current.mode & 0o777n) !== 0o700n
  ) {
    throw new Error(`${label} must retain mode 0700`);
  }
}

async function snapshotImmediateDirectory(path, label) {
  const root = await snapshotDirectory(path, label);
  const names = (await readdir(path)).sort();
  const entries = new Map();
  for (const name of names) {
    const entryPath = join(path, name);
    const stat = await lstat(entryPath, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`${label} entry ${name} must not be a symbolic link`);
    if (stat.isFile()) {
      entries.set(name, Object.freeze({ type: "file", snapshot: await readFrozenRegularFile(
        entryPath,
        `${label} entry ${name}`,
      ) }));
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`${label} entry ${name} must be a regular file or directory`);
    entries.set(name, Object.freeze({
      type: "directory",
      snapshot: Object.freeze({ path: entryPath, dev: stat.dev, ino: stat.ino }),
    }));
  }
  await assertDirectorySnapshot(root, label);
  if (!isDeepStrictEqual((await readdir(path)).sort(), names)) {
    throw new Error(`${label} names changed while immediate entries were frozen`);
  }
  return Object.freeze({ root, names: Object.freeze(names), entries });
}

async function assertImmediateDirectory(snapshot, extraNames, label) {
  await assertDirectorySnapshot(snapshot.root, label);
  const expectedNames = [...snapshot.names, ...extraNames].sort();
  const currentNames = (await readdir(snapshot.root.path)).sort();
  if (!isDeepStrictEqual(currentNames, expectedNames)) {
    throw new Error(`${label} immediate names changed`);
  }
  for (const name of snapshot.names) {
    const entry = snapshot.entries.get(name);
    if (entry?.type === "file") {
      await assertFrozenRegularFile(entry.snapshot, `${label} entry ${name}`);
      continue;
    }
    if (entry?.type !== "directory") throw new Error(`${label} lost immediate entry ${name}`);
    await assertDirectorySnapshot(entry.snapshot, `${label} entry ${name}`);
  }
  await assertDirectorySnapshot(snapshot.root, label);
  if (!isDeepStrictEqual((await readdir(snapshot.root.path)).sort(), expectedNames)) {
    throw new Error(`${label} immediate names changed during validation`);
  }
}

function fixedPaths(repoRoot) {
  const devRoot = join(repoRoot, ".dev-vault");
  const vaultPath = join(repoRoot, SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH);
  const obsidianPath = join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY);
  const pluginsParentPath = join(obsidianPath, "plugins");
  const targetPath = join(pluginsParentPath, PLUGIN_ID);
  return Object.freeze({
    repoRoot,
    devRoot,
    vaultPath,
    obsidianPath,
    pluginsParentPath,
    targetPath,
    seedPath: join(targetPath, "data.json"),
    statePath: join(repoRoot, PREPARATION_STATE_RELATIVE_PATH),
    receiptPath: join(repoRoot, INSTALLATION_RECEIPT_RELATIVE_PATH),
    reportPath: join(repoRoot, ACCEPTANCE_REPORT_RELATIVE_PATH),
    sourcePath: join(repoRoot, "dist", ARTIFACT_TARGET_NAME),
    artifactLockPath: join(repoRoot, "dist", ARTIFACT_LOCK_NAME),
    destinationLockPath: join(pluginsParentPath, DESTINATION_LOCK_NAME),
  });
}

async function snapshotFixedVaultChain(paths) {
  const vault = await snapshotDirectory(paths.vaultPath, "Fixed synthetic acceptance vault");
  await assertDirectorySnapshot(vault, "Fixed synthetic acceptance vault");
  const obsidian = await snapshotDirectory(paths.obsidianPath, "Fixed synthetic configuration directory");
  await assertDirectorySnapshot(obsidian, "Fixed synthetic configuration directory");
  const pluginsParent = await snapshotDirectory(
    paths.pluginsParentPath,
    "Fixed synthetic plugins parent",
  );
  await assertDirectorySnapshot(pluginsParent, "Fixed synthetic plugins parent");
  return Object.freeze({ vault, obsidian, pluginsParent });
}

async function assertFixedVaultChain(transaction) {
  await assertDirectorySnapshot(
    transaction.vaultChain.vault,
    "Fixed synthetic acceptance vault",
  );
  await assertDirectorySnapshot(
    transaction.vaultChain.obsidian,
    "Fixed synthetic configuration directory",
  );
  await assertDirectorySnapshot(
    transaction.vaultChain.pluginsParent,
    "Fixed synthetic plugins parent",
  );
}

function initialDevNamespace(names, paths) {
  const vaultName = basename(paths.vaultPath);
  const stateName = basename(paths.statePath);
  const receiptName = basename(paths.receiptPath);
  const reportName = basename(paths.reportPath);
  if (names.includes(receiptName) || names.includes(reportName)) {
    fail("target-exists", "an installation receipt or acceptance report already exists");
  }
  for (const name of names) {
    if (name === vaultName || name === stateName) continue;
    if (name.startsWith("read-only-acceptance-") || name.startsWith(".read-only-acceptance-")) {
      fail("concurrent-operation", "reserved acceptance run residue already exists");
    }
  }
}

function initialPluginsNamespace(names) {
  if (names.includes(PLUGIN_ID)) fail("target-exists", "the fixed acceptance target already exists");
  if (names.some((name) => (
    name === DESTINATION_LOCK_NAME
    || name.startsWith(TARGET_STAGE_PREFIX)
    || name.startsWith(TARGET_BACKUP_PREFIX)
    || name.startsWith(TARGET_QUARANTINE_PREFIX)
  ))) {
    fail("concurrent-operation", "reserved acceptance installer residue already exists");
  }
  if (names.length !== 0) fail("concurrent-operation", "plugins parent contains existing or retained entries");
}

function decodeExactCommunity(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("fixture-invalid", "community-plugins.json must be valid JSON", error);
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    fail("fixture-invalid", "community-plugins.json must be an array of plugin IDs");
  }
  if (value.includes(PLUGIN_ID)) fail("plugin-enabled", "knowledge-workbench is already enabled");
  if (!bytes.equals(Buffer.from("[]\n", "utf8"))) {
    fail("fixture-invalid", "community-plugins.json must be the exact empty canonical array");
  }
}

async function freezeCommunity(paths) {
  let snapshot;
  try {
    snapshot = await readFrozenRegularFile(
      join(paths.obsidianPath, "community-plugins.json"),
      "community-plugins.json",
    );
  } catch (error) {
    fail("fixture-invalid", "community-plugins.json is unavailable", error);
  }
  decodeExactCommunity(snapshot.bytes);
  return snapshot;
}

async function assertCommunity(snapshot) {
  let current;
  try {
    current = await readFrozenRegularFile(snapshot.path, "community-plugins.json");
  } catch (error) {
    fail("fixture-changed", "community-plugins.json changed", error);
  }
  let value;
  try {
    value = JSON.parse(current.bytes.toString("utf8"));
  } catch (error) {
    fail("fixture-changed", "community-plugins.json became malformed", error);
  }
  if (Array.isArray(value) && value.includes(PLUGIN_ID)) {
    fail("plugin-enabled", "knowledge-workbench became enabled");
  }
  if (!current.bytes.equals(Buffer.from("[]\n", "utf8"))) {
    fail("fixture-changed", "community-plugins.json bytes changed");
  }
  try {
    await assertFrozenRegularFile(snapshot, "community-plugins.json");
  } catch (error) {
    fail("fixture-changed", "community-plugins.json identity changed", error);
  }
}

function copySourceSnapshot(source) {
  const files = new Map();
  for (const name of ACCEPTANCE_FILES) {
    const file = source.files.get(name);
    if (file === undefined) throw new Error(`Acceptance source lost ${name}`);
    files.set(name, Object.freeze({
      path: file.path,
      bytes: Buffer.from(file.bytes),
      evidence: Object.freeze({ ...file.evidence }),
    }));
  }
  return Object.freeze({
    directory: Object.freeze({ ...source.directory }),
    names: ACCEPTANCE_FILES,
    files,
  });
}

function sameArtifactSnapshot(current, expected) {
  if (
    !sameIdentity(current.directory, expected.directory)
    || !isDeepStrictEqual([...current.names], [...expected.names])
  ) return false;
  for (const name of ACCEPTANCE_FILES) {
    const currentFile = current.files.get(name);
    const expectedFile = expected.files.get(name);
    if (
      currentFile === undefined
      || expectedFile === undefined
      || !sameFileEvidence(currentFile.evidence, expectedFile.evidence)
      || !currentFile.bytes.equals(expectedFile.bytes)
    ) return false;
  }
  return true;
}

async function loadValidatedSource(lease, category) {
  try {
    const source = await loadAcceptanceArtifactSource({ lease });
    validateAcceptanceArtifactSnapshot(source);
    return source;
  } catch (error) {
    fail(category, "acceptance artifact source is invalid or changed", error);
  }
}

function sourceMatchesDiskSnapshot(source, diskSnapshot) {
  if (
    source.directory.path !== diskSnapshot.path
    || !sameIdentity(source.directory, diskSnapshot)
    || !isDeepStrictEqual([...source.names], [...diskSnapshot.names])
  ) return false;
  for (const name of ACCEPTANCE_FILES) {
    const sourceFile = source.files.get(name);
    const diskFile = diskSnapshot.files.get(name);
    if (
      sourceFile === undefined
      || diskFile === undefined
      || sourceFile.path !== diskFile.path
      || !sameFileEvidence(sourceFile.evidence, diskFile.evidence)
      || !sourceFile.bytes.equals(diskFile.bytes)
    ) return false;
  }
  return true;
}

function sameDiskArtifactSnapshot(left, right) {
  if (
    left.path !== right.path
    || !sameIdentity(left, right)
    || !isDeepStrictEqual([...left.names], [...right.names])
  ) return false;
  for (const name of ACCEPTANCE_FILES) {
    const leftFile = left.files.get(name);
    const rightFile = right.files.get(name);
    if (
      leftFile === undefined
      || rightFile === undefined
      || !sameFileEvidence(leftFile.evidence, rightFile.evidence)
      || !leftFile.bytes.equals(rightFile.bytes)
    ) return false;
  }
  return true;
}

async function freezeBuiltSource(transaction) {
  try {
    const diskSnapshot = await snapshotExactDirectory(
      transaction.paths.sourcePath,
      ACCEPTANCE_FILES,
      "Built acceptance artifact source",
    );
    const loaded = await loadValidatedSource(transaction.lease, "artifact-invalid");
    if (!sourceMatchesDiskSnapshot(loaded, diskSnapshot)) {
      fail("artifact-invalid", "built acceptance source was not bound to its exact disk snapshot");
    }
    await assertExactDirectory(diskSnapshot, "Built acceptance artifact source");
    transaction.sourceDiskSnapshot = diskSnapshot;
    transaction.source = copySourceSnapshot(loaded);
    transaction.sourceContract = validateAcceptanceArtifactSnapshot(transaction.source);
  } catch (error) {
    if (isTrustedInstallFailure(error)) throw error;
    fail("artifact-invalid", "built acceptance artifact source is invalid", error);
  }
}

async function assertFrozenSource(transaction, category = "artifact-changed") {
  try {
    if (transaction.source === null || transaction.sourceDiskSnapshot === null) {
      throw new Error("frozen acceptance source proof is unavailable");
    }
    const before = await snapshotExactDirectory(
      transaction.paths.sourcePath,
      ACCEPTANCE_FILES,
      "Frozen acceptance artifact source before lease read",
    );
    await assertExactDirectory(
      transaction.sourceDiskSnapshot,
      "Frozen acceptance artifact source baseline",
    );
    const current = await loadValidatedSource(transaction.lease, category);
    if (
      !sameArtifactSnapshot(current, transaction.source)
      || !sourceMatchesDiskSnapshot(current, before)
    ) {
      fail(category, "frozen acceptance artifact source changed");
    }
    const after = await snapshotExactDirectory(
      transaction.paths.sourcePath,
      ACCEPTANCE_FILES,
      "Frozen acceptance artifact source after lease read",
    );
    if (
      !sourceMatchesDiskSnapshot(current, after)
      || !sameDiskArtifactSnapshot(before, after)
    ) {
      fail(category, "frozen acceptance artifact source changed during validation");
    }
    await assertExactDirectory(before, "Frozen acceptance artifact source sandwich");
    await assertExactDirectory(
      transaction.sourceDiskSnapshot,
      "Frozen acceptance artifact source baseline",
    );
  } catch (error) {
    if (isTrustedInstallFailure(error)) throw error;
    fail(category, "frozen acceptance artifact source changed", error);
  }
}

function artifactView(snapshot) {
  const files = new Map();
  for (const name of ACCEPTANCE_FILES) files.set(name, snapshot.files.get(name));
  return Object.freeze({
    directory: Object.freeze({ path: snapshot.path, dev: snapshot.dev, ino: snapshot.ino }),
    names: ACCEPTANCE_FILES,
    files,
  });
}

function assertArtifactBytes(snapshot, source, label) {
  validateAcceptanceArtifactSnapshot(artifactView(snapshot));
  for (const name of ACCEPTANCE_FILES) {
    const file = snapshot.files.get(name);
    const sourceFile = source.files.get(name);
    if (file === undefined || sourceFile === undefined || !file.bytes.equals(sourceFile.bytes)) {
      throw new Error(`${label} file ${name} does not match frozen source bytes`);
    }
  }
}

async function snapshotArtifactDirectory(path, source, label) {
  const snapshot = await snapshotExactDirectory(path, TARGET_FILES_FOUR, label);
  assertArtifactBytes(snapshot, source, label);
  return snapshot;
}

async function snapshotSeededTarget(path, source, seedBytes, label) {
  const snapshot = await snapshotExactDirectory(path, TARGET_FILES_FIVE, label);
  assertArtifactBytes(snapshot, source, label);
  const seed = snapshot.files.get("data.json");
  if (seed === undefined || !seed.bytes.equals(seedBytes)) throw new Error(`${label} seed bytes changed`);
  decodeSyntheticPluginDataSeed(seed.bytes);
  return snapshot;
}

function exactTreeForDirectory(snapshot) {
  return snapshotOwnedTree(snapshot.path, [...snapshot.names], "Acceptance installer owned directory");
}

async function guardedUnlink(snapshot, expectedBytes, label) {
  await assertFrozenRegularFile(snapshot, label);
  if (!snapshot.bytes.equals(expectedBytes)) throw new Error(`${label} bytes changed`);
  const immediate = await lstat(snapshot.path, { bigint: true });
  if (
    immediate.isSymbolicLink()
    || !immediate.isFile()
    || immediate.nlink !== 1n
    || immediate.dev !== snapshot.evidence.dev
    || immediate.ino !== snapshot.evidence.ino
    || immediate.size !== snapshot.evidence.size
  ) {
    throw new Error(`${label} changed immediately before unlink`);
  }
  await unlink(snapshot.path);
  await assertAbsent(snapshot.path, `${label} cleanup`);
}

function sameDecodedReceipt(left, right) {
  return isDeepStrictEqual(left, right);
}

async function assertReceipt(snapshot, expectedBytes, expectedReceipt, label) {
  await assertFrozenRegularFile(snapshot, label);
  if (!snapshot.bytes.equals(expectedBytes)) throw new Error(`${label} bytes changed`);
  const decoded = decodeInstallationReceipt(snapshot.bytes);
  if (!sameDecodedReceipt(decoded, expectedReceipt)) throw new Error(`${label} run binding changed`);
  if (!encodeInstallationReceipt(decoded).equals(snapshot.bytes)) throw new Error(`${label} encoding changed`);
}

function hookContext(transaction) {
  return Object.freeze({
    repoRoot: transaction.paths.repoRoot,
    artifactLockPath: transaction.paths.artifactLockPath,
    sourcePath: transaction.paths.sourcePath,
    destinationLockPath: transaction.destinationLockSnapshot === null
      ? null
      : transaction.paths.destinationLockPath,
    pluginsParentPath: transaction.paths.pluginsParentPath,
    stagePath: transaction.stagePath,
    targetPath: transaction.paths.targetPath,
    seedPath: transaction.paths.seedPath,
    statePath: transaction.paths.statePath,
    receiptStagePath: transaction.receiptStagePath,
    receiptPath: transaction.paths.receiptPath,
    reportPath: transaction.paths.reportPath,
    runId: transaction.run?.state.runId ?? null,
    commit: transaction.run?.state.commit ?? null,
  });
}

async function invokeHook(transaction, name, revalidate) {
  let hookFailure = NO_FAILURE;
  try {
    await transaction.hooks[name]?.(hookContext(transaction));
  } catch (error) {
    hookFailure = error;
  }
  let validationFailure = NO_FAILURE;
  try {
    await revalidate();
  } catch (error) {
    validationFailure = error;
  }
  if (validationFailure !== NO_FAILURE) throw validationFailure;
  if (hookFailure !== NO_FAILURE) {
    throw new Error(`Acceptance install hook ${name} failed`, { cause: hookFailure });
  }
}

async function assertCanonicalBoundary(transaction) {
  try {
    await assertDirectorySnapshot(transaction.repoRootSnapshot, "Repository root");
    await assertDirectorySnapshot(transaction.devRootSnapshot, ".dev-vault");
    const current = await resolveCanonicalWorktree(transaction.paths.repoRoot);
    if (
      current.repoRoot !== transaction.paths.repoRoot
      || current.devRoot !== transaction.paths.devRoot
      || !sameIdentity(current.devRootSnapshot, transaction.devRootSnapshot)
    ) {
      throw new Error("canonical repository or .dev-vault identity changed");
    }
    await assertFixedVaultChain(transaction);
  } catch (error) {
    fail("fixture-changed", "canonical repository boundary changed", error);
  }
}

async function assertArtifactLock(transaction) {
  try {
    await assertFrozenRegularFile(transaction.artifactLockSnapshot, "Acceptance artifact lock");
  } catch (error) {
    fail("concurrent-operation", "acceptance artifact lock changed", error);
  }
}

async function assertDestinationLock(transaction) {
  if (transaction.destinationLockSnapshot === null) {
    throw new Error("destination lock proof is unavailable");
  }
  try {
    await assertFrozenRegularFile(transaction.destinationLockSnapshot, "Acceptance destination lock");
  } catch (error) {
    fail("concurrent-operation", "acceptance destination lock changed", error);
  }
}

async function assertGitBoundary(transaction) {
  try {
    await assertCleanGitState(transaction.paths.repoRoot, transaction.run.state.commit);
  } catch (error) {
    fail("concurrent-operation", "Git cleanliness or HEAD changed", error);
  }
}

async function assertStateBoundary(transaction) {
  const { stateSnapshot, stateBytes, state } = transaction.run;
  try {
    await assertFrozenRegularFile(stateSnapshot, "Preparation state");
    if (!stateSnapshot.bytes.equals(stateBytes)) throw new Error("Preparation state bytes changed");
    const current = decodePreparationState(stateSnapshot.bytes);
    if (!isDeepStrictEqual(current, state)) throw new Error("Preparation state fields changed");
  } catch (error) {
    fail("fixture-changed", "preparation state changed", error);
  }
}

function devExtraNames(transaction) {
  if (transaction.receiptPublished) return [basename(transaction.paths.receiptPath)];
  if (transaction.receiptStageSnapshot !== null) return [basename(transaction.receiptStagePath)];
  return [];
}

async function assertDevBoundary(transaction) {
  try {
    await assertImmediateDirectory(
      transaction.run.devNamespace,
      devExtraNames(transaction),
      ".dev-vault",
    );
  } catch (error) {
    fail("fixture-changed", ".dev-vault immediate state changed", error);
  }
}

async function assertFixedRunAbsence(transaction) {
  try {
    await assertAbsent(transaction.paths.reportPath, "Acceptance report");
    if (!transaction.receiptPublished) await assertAbsent(transaction.paths.receiptPath, "Installation receipt");
  } catch (error) {
    fail("target-exists", "a fixed acceptance output unexpectedly exists", error);
  }
}

async function assertPreparedFixture(transaction) {
  await assertCommunity(transaction.run.communitySnapshot);
  try {
    await assertOwnedTree(
      transaction.run.fixture.tree,
      "Initial prepared synthetic acceptance vault",
    );
  } catch (error) {
    fail("fixture-changed", "prepared synthetic fixture changed", error);
  }
}

async function assertPreRunBoundary(transaction) {
  await assertCanonicalBoundary(transaction);
  await assertArtifactLock(transaction);
  await assertArtifactDistBoundary(transaction);
}

async function assertPreparedRunBoundary(transaction) {
  await assertPreRunBoundary(transaction);
  await assertGitBoundary(transaction);
  await assertDevBoundary(transaction);
  await assertStateBoundary(transaction);
  await assertFixedRunAbsence(transaction);
  try {
    await assertDirectorySnapshot(transaction.run.pluginsParent, "Prepared plugins parent");
    initialPluginsNamespace((await readdir(transaction.paths.pluginsParentPath)).sort());
  } catch (error) {
    if (isTrustedInstallFailure(error)) throw error;
    fail("fixture-changed", "prepared plugins parent changed", error);
  }
  await assertPreparedFixture(transaction);
}

function installAttestationInput(transaction) {
  const input = {
    vaultPath: transaction.paths.vaultPath,
    expected: transaction.run.fixture,
    state: transaction.installState,
  };
  if (transaction.installState === "stage-empty" || transaction.installState === "stage-four") {
    input.stageName = basename(transaction.stagePath);
  }
  return input;
}

function bindAttestedInstallObjects(transaction, attestation) {
  const tree = attestation.tree;
  if (transaction.destinationLockSnapshot === null) {
    throw new Error("destination lock proof is unavailable for transient attestation");
  }
  assertFrozenRegularFileInOwnedTree(
    tree,
    join(PLUGINS_RELATIVE_PATH, DESTINATION_LOCK_NAME),
    transaction.destinationLockSnapshot,
    "Attested acceptance destination lock",
  );

  if (transaction.installState === "stage-empty") {
    if (transaction.stageTree === null || transaction.stagePath === null) {
      throw new Error("empty acceptance stage proof is unavailable");
    }
    assertDirectoryInOwnedTree(
      tree,
      join(PLUGINS_RELATIVE_PATH, basename(transaction.stagePath)),
      transaction.stageTree.root,
      "Attested empty acceptance target stage",
    );
  } else if (transaction.installState === "stage-four") {
    if (transaction.stageSnapshot === null || transaction.stagePath === null) {
      throw new Error("validated acceptance stage proof is unavailable");
    }
    assertExactDirectoryInOwnedTree(
      tree,
      join(PLUGINS_RELATIVE_PATH, basename(transaction.stagePath)),
      transaction.stageSnapshot,
      "Attested acceptance target stage",
    );
  } else if (transaction.installState === "target-four" || transaction.installState === "target-five") {
    if (transaction.targetSnapshot === null) {
      throw new Error("published acceptance target proof is unavailable");
    }
    assertExactDirectoryInOwnedTree(
      tree,
      join(PLUGINS_RELATIVE_PATH, PLUGIN_ID),
      transaction.targetSnapshot,
      "Attested published acceptance target",
    );
  }
}

async function assertOwnedInstallObjects(transaction) {
  if (transaction.targetTree !== null) {
    await assertOwnedTree(transaction.targetTree, "Published acceptance target");
    if (transaction.targetSnapshot === null) throw new Error("published target proof is incomplete");
    await assertExactDirectory(transaction.targetSnapshot, "Published acceptance target");
    if (transaction.installState === "target-five") {
      assertArtifactBytes(transaction.targetSnapshot, transaction.source, "Published acceptance target");
      const seed = transaction.targetSnapshot.files.get("data.json");
      if (seed === undefined || !seed.bytes.equals(transaction.seedBytes)) {
        throw new Error("Published acceptance seed changed");
      }
      decodeSyntheticPluginDataSeed(seed.bytes);
    } else {
      assertArtifactBytes(transaction.targetSnapshot, transaction.source, "Published acceptance target");
    }
    if (transaction.stagePath !== null) {
      await assertAbsent(transaction.stagePath, "Retired acceptance target stage");
    }
  } else if (transaction.stageTree !== null) {
    await assertOwnedTree(transaction.stageTree, "Acceptance target stage");
    if (transaction.stageSnapshot !== null) {
      await assertExactDirectory(transaction.stageSnapshot, "Acceptance target stage");
      assertArtifactBytes(transaction.stageSnapshot, transaction.source, "Acceptance target stage");
    }
    await assertAbsent(transaction.paths.targetPath, "Fixed acceptance target");
  } else {
    await assertAbsent(transaction.paths.targetPath, "Fixed acceptance target");
  }

  if (transaction.receiptPublished) {
    await assertReceipt(
      transaction.receiptSnapshot,
      transaction.receiptBytes,
      transaction.receipt,
      "Published installation receipt",
    );
    await assertAbsent(transaction.receiptStagePath, "Retired installation receipt stage");
  } else if (transaction.receiptStageSnapshot !== null) {
    await assertReceipt(
      transaction.receiptStageSnapshot,
      transaction.receiptBytes,
      transaction.receipt,
      "Installation receipt stage",
    );
    await assertAbsent(transaction.paths.receiptPath, "Installation receipt");
  } else {
    await assertAbsent(transaction.paths.receiptPath, "Installation receipt");
  }
}

async function assertInstallBoundary(transaction) {
  await assertCanonicalBoundary(transaction);
  await assertArtifactLock(transaction);
  await assertFrozenSource(transaction);
  await assertArtifactDistBoundary(transaction);
  await assertGitBoundary(transaction);
  await assertFixedRunAbsence(transaction);
  await assertDevBoundary(transaction);
  await assertStateBoundary(transaction);
  await assertCommunity(transaction.run.communitySnapshot);
  try {
    await assertDirectorySnapshot(transaction.run.pluginsParent, "Acceptance plugins parent");
    await assertDestinationLock(transaction);
    const attestation = await attestSyntheticAcceptanceInstallState(installAttestationInput(transaction));
    assertOwnedTreeContinuity(
      attestation.tree,
      transaction.run.fixture.tree,
      PLUGINS_RELATIVE_PATH,
      "Synthetic acceptance fixture continuity",
    );
    bindAttestedInstallObjects(transaction, attestation);
    await assertOwnedInstallObjects(transaction);
  } catch (error) {
    if (isTrustedInstallFailure(error)) throw error;
    fail("fixture-changed", "synthetic acceptance install state changed", error);
  }
}

async function loadAndValidatePreparationRun({ transaction, git }) {
  const paths = transaction.paths;
  try {
    await assertFixedVaultChain(transaction);
  } catch (error) {
    fail("fixture-invalid", "fixed synthetic vault directory chain is invalid", error);
  }
  if (await optionalStat(paths.receiptPath) !== null || await optionalStat(paths.reportPath) !== null) {
    fail("target-exists", "a prior acceptance receipt or report already exists");
  }
  if (await optionalStat(paths.targetPath) !== null) {
    fail("target-exists", "the fixed acceptance target already exists");
  }

  let stateSnapshot;
  let state;
  try {
    stateSnapshot = await readFrozenRegularFile(paths.statePath, "Preparation state");
    state = decodePreparationState(stateSnapshot.bytes);
  } catch (error) {
    fail("fixture-invalid", "preparation state is invalid", error);
  }
  if (state.commit !== git.commit) {
    fail("concurrent-operation", "Git HEAD does not match the preparation state");
  }

  let devNamespace;
  let pluginsParent;
  try {
    const devNames = (await readdir(paths.devRoot)).sort();
    initialDevNamespace(devNames, paths);
    devNamespace = await snapshotImmediateDirectory(paths.devRoot, ".dev-vault");
    pluginsParent = transaction.vaultChain.pluginsParent;
    await assertDirectorySnapshot(pluginsParent, "Prepared plugins parent");
    initialPluginsNamespace((await readdir(paths.pluginsParentPath)).sort());
  } catch (error) {
    if (isTrustedInstallFailure(error)) throw error;
    fail("fixture-invalid", "prepared destination namespace is invalid", error);
  }

  const communitySnapshot = await freezeCommunity(paths);
  let fixture;
  try {
    fixture = await attestSyntheticAcceptanceVault({
      vaultPath: paths.vaultPath,
      phase: "prepared",
      expected: state,
    });
  } catch (error) {
    fail("fixture-invalid", "fixed synthetic fixture is invalid", error);
  }
  if (
    fixture.syntheticNoteCount !== state.syntheticNoteCount
    || fixture.syntheticTotalBytes !== state.syntheticTotalBytes
    || fixture.corpusDigest !== state.corpusDigest
  ) {
    fail("fixture-invalid", "synthetic fixture does not match preparation state");
  }

  const run = Object.freeze({
    git,
    state,
    stateBytes: Buffer.from(stateSnapshot.bytes),
    stateSnapshot,
    fixture,
    devNamespace,
    communitySnapshot,
    pluginsParent,
  });
  transaction.run = run;
  await assertPreparedRunBoundary(transaction);
  return run;
}

async function createTransaction({ repoRoot, hooks, lease }) {
  const paths = fixedPaths(repoRoot);
  const worktree = await resolveCanonicalWorktree(repoRoot);
  if (worktree.repoRoot !== repoRoot || worktree.devRoot !== paths.devRoot) {
    fail("fixture-invalid", "repository or .dev-vault path is not canonical");
  }
  let vaultChain;
  try {
    vaultChain = await snapshotFixedVaultChain(paths);
  } catch (error) {
    fail("fixture-invalid", "fixed synthetic vault directory chain is invalid", error);
  }
  const repoRootSnapshot = await snapshotDirectory(repoRoot, "Repository root");
  const artifactLockSnapshot = await readFrozenRegularFile(paths.artifactLockPath, "Acceptance artifact lock");
  return {
    hooks,
    lease,
    paths,
    vaultChain,
    repoRootSnapshot,
    devRootSnapshot: worktree.devRootSnapshot,
    artifactLockSnapshot,
    distNamespace: null,
    run: null,
    source: null,
    sourceDiskSnapshot: null,
    sourceContract: null,
    destinationLockSnapshot: null,
    installState: null,
    stagePath: null,
    stageTree: null,
    stageSnapshot: null,
    targetTree: null,
    targetSnapshot: null,
    seedBytes: null,
    receiptStagePath: null,
    receiptStageSnapshot: null,
    receipt: null,
    receiptBytes: null,
    receiptPublished: false,
    receiptSnapshot: null,
    stageCreated: false,
    targetPublished: false,
    rollbackIncomplete: false,
  };
}

function provePublishedArtifactContinuity(stage, target, label) {
  if (!sameIdentity(stage, target)) throw new Error(`${label} directory identity changed across rename`);
  for (const name of ACCEPTANCE_FILES) {
    const staged = stage.files.get(name);
    const published = target.files.get(name);
    if (
      staged === undefined
      || published === undefined
      || !sameFileEvidence(staged.evidence, published.evidence)
      || !staged.bytes.equals(published.bytes)
    ) {
      throw new Error(`${label} file ${name} identity changed across rename`);
    }
  }
}

function reboundFrozenFile(snapshot, path) {
  return Object.freeze({
    path,
    bytes: snapshot.bytes,
    evidence: snapshot.evidence,
  });
}

async function assertPrivateDirectoryContinuity(snapshot, label) {
  await assertDirectorySnapshot(snapshot, label);
  await assertPrivateDirectoryMode(snapshot, label);
}

async function assertWrittenFilesInOwnedTree(tree, names, writtenSnapshots, label) {
  for (const name of names) {
    const expected = writtenSnapshots.get(name);
    if (expected === undefined) throw new Error(`${label} lost exclusive-write proof for ${name}`);
    await assertFrozenRegularFile(expected, `${label} file ${name}`);
    assertFrozenRegularFileInOwnedTree(
      tree,
      name,
      expected,
      `${label} file ${name}`,
    );
  }
}

async function refreshPartialStageTree(transaction, stageRoot, createdNames, writtenSnapshots) {
  await assertPrivateDirectoryContinuity(stageRoot, "Partial acceptance target stage");
  for (const name of createdNames) {
    const expected = writtenSnapshots.get(name);
    if (expected === undefined) {
      throw new Error(`Partial acceptance target stage lost exclusive-write proof for ${name}`);
    }
    await assertFrozenRegularFile(expected, `Partial acceptance target stage file ${name}`);
  }
  const tree = await snapshotOwnedTree(
    transaction.stagePath,
    createdNames,
    "Partial acceptance target stage",
  );
  if (!sameIdentity(tree.root, stageRoot)) {
    throw new Error("Partial acceptance target stage root identity changed");
  }
  await assertWrittenFilesInOwnedTree(
    tree,
    createdNames,
    writtenSnapshots,
    "Partial acceptance target stage",
  );
  await assertPrivateDirectoryContinuity(stageRoot, "Partial acceptance target stage");
  transaction.stageTree = tree;
}

async function createAndPopulateStage(transaction) {
  transaction.stagePath = join(
    transaction.paths.pluginsParentPath,
    `${TARGET_STAGE_PREFIX}${process.pid}-${randomUUID()}`,
  );
  await mkdir(transaction.stagePath, { mode: 0o700 });
  transaction.stageCreated = true;
  await chmod(transaction.stagePath, 0o700);
  const stageRoot = await snapshotDirectory(transaction.stagePath, "Acceptance target stage");
  if (stageRoot.dev !== transaction.run.pluginsParent.dev) {
    throw new Error("Acceptance target stage must remain on the plugins-parent device");
  }
  await assertPrivateDirectoryContinuity(stageRoot, "Acceptance target stage");
  const emptyStageTree = await snapshotOwnedTree(
    transaction.stagePath,
    [],
    "Empty acceptance target stage",
  );
  if (!sameIdentity(emptyStageTree.root, stageRoot)) {
    throw new Error("Empty acceptance target stage root identity changed");
  }
  await assertPrivateDirectoryContinuity(stageRoot, "Acceptance target stage");
  transaction.stageTree = emptyStageTree;
  transaction.installState = "stage-empty";
  await invokeHook(transaction, "afterStageCreated", () => assertInstallBoundary(transaction));

  const createdNames = [];
  const writtenSnapshots = new Map();
  for (const name of ACCEPTANCE_FILES) {
    const sourceFile = transaction.source.files.get(name);
    if (sourceFile === undefined) throw new Error(`Frozen acceptance source lost ${name}`);
    const written = await writeExclusiveRegularFile(
      join(transaction.stagePath, name),
      sourceFile.bytes,
      `Staged acceptance artifact ${name}`,
    );
    createdNames.push(name);
    writtenSnapshots.set(name, written);
    await refreshPartialStageTree(transaction, stageRoot, createdNames, writtenSnapshots);
  }

  await assertPrivateDirectoryContinuity(stageRoot, "Acceptance target stage");
  const stageSnapshot = await snapshotArtifactDirectory(
    transaction.stagePath,
    transaction.source,
    "Acceptance target stage",
  );
  if (!sameIdentity(stageSnapshot, stageRoot)) {
    throw new Error("Acceptance target stage root identity changed");
  }
  for (const name of ACCEPTANCE_FILES) {
    const written = writtenSnapshots.get(name);
    const staged = stageSnapshot.files.get(name);
    if (written === undefined || staged === undefined) {
      throw new Error(`Acceptance target stage lost exclusive-write proof for ${name}`);
    }
    await assertFrozenRegularFile(written, `Exclusively written acceptance stage file ${name}`);
    if (!sameFileEvidence(written.evidence, staged.evidence) || !written.bytes.equals(staged.bytes)) {
      throw new Error(`Acceptance target stage file ${name} changed after exclusive write`);
    }
  }
  const stageTree = await exactTreeForDirectory(stageSnapshot);
  if (!sameIdentity(stageTree.root, stageRoot)) {
    throw new Error("Acceptance target stage tree root identity changed");
  }
  await assertWrittenFilesInOwnedTree(
    stageTree,
    ACCEPTANCE_FILES,
    writtenSnapshots,
    "Acceptance target stage",
  );
  await assertPrivateDirectoryContinuity(stageRoot, "Acceptance target stage");
  transaction.stageSnapshot = stageSnapshot;
  transaction.stageTree = stageTree;
  transaction.installState = "stage-four";
  await assertInstallBoundary(transaction);
  await invokeHook(transaction, "afterStageValidated", () => assertInstallBoundary(transaction));
}

async function publishTarget(transaction) {
  await assertInstallBoundary(transaction);
  await assertAbsent(transaction.paths.targetPath, "Fixed acceptance target before publication");
  const stagedSnapshot = transaction.stageSnapshot;
  if (stagedSnapshot === null) throw new Error("validated acceptance stage proof is unavailable");
  await assertPrivateDirectoryContinuity(stagedSnapshot, "Acceptance target stage before publication");
  for (const name of ACCEPTANCE_FILES) {
    const staged = stagedSnapshot.files.get(name);
    if (staged === undefined) throw new Error(`Acceptance target stage lost ${name}`);
    await assertFrozenRegularFile(staged, `Acceptance target stage file ${name} before publication`);
  }
  await rename(transaction.stagePath, transaction.paths.targetPath);
  transaction.targetPublished = true;
  const targetRoot = Object.freeze({
    path: transaction.paths.targetPath,
    dev: stagedSnapshot.dev,
    ino: stagedSnapshot.ino,
  });
  const reboundFiles = new Map();
  for (const name of ACCEPTANCE_FILES) {
    const staged = stagedSnapshot.files.get(name);
    if (staged === undefined) throw new Error(`Acceptance target stage lost ${name}`);
    reboundFiles.set(
      name,
      reboundFrozenFile(staged, join(transaction.paths.targetPath, name)),
    );
  }
  await assertPrivateDirectoryContinuity(targetRoot, "Published acceptance target");
  for (const name of ACCEPTANCE_FILES) {
    await assertFrozenRegularFile(
      reboundFiles.get(name),
      `Published acceptance target file ${name}`,
    );
  }
  const targetSnapshot = await snapshotArtifactDirectory(
    transaction.paths.targetPath,
    transaction.source,
    "Published acceptance target",
  );
  provePublishedArtifactContinuity(stagedSnapshot, targetSnapshot, "Published acceptance target");
  const targetTree = await exactTreeForDirectory(targetSnapshot);
  if (!sameIdentity(targetTree.root, targetRoot)) {
    throw new Error("Published acceptance target tree root identity changed");
  }
  await assertWrittenFilesInOwnedTree(
    targetTree,
    ACCEPTANCE_FILES,
    reboundFiles,
    "Published acceptance target",
  );
  await assertPrivateDirectoryContinuity(targetRoot, "Published acceptance target");
  transaction.targetSnapshot = targetSnapshot;
  transaction.targetTree = targetTree;
  transaction.stageTree = null;
  transaction.stageSnapshot = null;
  transaction.installState = "target-four";
  await assertInstallBoundary(transaction);
  await invokeHook(transaction, "afterTargetPublished", () => assertInstallBoundary(transaction));
  await invokeHook(transaction, "beforeSeed", () => assertInstallBoundary(transaction));
}

async function publishSeed(transaction) {
  await assertInstallBoundary(transaction);
  const targetFour = transaction.targetSnapshot;
  if (targetFour === null || transaction.targetTree === null) {
    throw new Error("published four-file target proof is unavailable before seed");
  }
  const seedBytes = encodeSyntheticPluginDataSeed();
  const seedSnapshot = await writeExclusiveRegularFile(
    transaction.paths.seedPath,
    seedBytes,
    "Synthetic plugin-data seed",
  );
  decodeSyntheticPluginDataSeed(seedSnapshot.bytes);
  await assertPrivateDirectoryContinuity(targetFour, "Seeded acceptance target");
  for (const name of ACCEPTANCE_FILES) {
    const original = targetFour.files.get(name);
    if (original === undefined) throw new Error(`Published acceptance target lost ${name}`);
    await assertFrozenRegularFile(original, `Published acceptance target file ${name} before seed adoption`);
  }
  await assertFrozenRegularFile(seedSnapshot, "Exclusively written synthetic plugin-data seed");
  const seededSnapshot = await snapshotSeededTarget(
    transaction.paths.targetPath,
    transaction.source,
    seedBytes,
    "Seeded acceptance target",
  );
  if (!sameIdentity(seededSnapshot, targetFour)) {
    throw new Error("Seeded acceptance target root identity changed");
  }
  await assertPrivateDirectoryContinuity(targetFour, "Seeded acceptance target");
  for (const name of ACCEPTANCE_FILES) {
    const original = targetFour.files.get(name);
    const adopted = seededSnapshot.files.get(name);
    if (
      original === undefined
      || adopted === undefined
      || !sameFileEvidence(original.evidence, adopted.evidence)
      || !original.bytes.equals(adopted.bytes)
    ) {
      throw new Error(`Seeded acceptance target changed original file ${name}`);
    }
    await assertFrozenRegularFile(original, `Seeded acceptance target original file ${name}`);
  }
  const adoptedSeed = seededSnapshot.files.get("data.json");
  await assertFrozenRegularFile(seedSnapshot, "Exclusively written synthetic plugin-data seed");
  if (
    adoptedSeed === undefined
    || !sameFileEvidence(seedSnapshot.evidence, adoptedSeed.evidence)
    || !seedSnapshot.bytes.equals(adoptedSeed.bytes)
  ) {
    throw new Error("Synthetic plugin-data seed changed after exclusive write");
  }
  const seededTree = await exactTreeForDirectory(seededSnapshot);
  if (!sameIdentity(seededTree.root, targetFour)) {
    throw new Error("Seeded acceptance target tree root identity changed");
  }
  for (const name of ACCEPTANCE_FILES) {
    const original = targetFour.files.get(name);
    if (original === undefined) throw new Error(`Published acceptance target lost ${name}`);
    assertFrozenRegularFileInOwnedTree(
      seededTree,
      name,
      original,
      `Seeded acceptance target original file ${name}`,
    );
  }
  assertFrozenRegularFileInOwnedTree(
    seededTree,
    "data.json",
    seedSnapshot,
    "Seeded acceptance target data",
  );
  await assertPrivateDirectoryContinuity(targetFour, "Seeded acceptance target");
  for (const name of ACCEPTANCE_FILES) {
    const original = targetFour.files.get(name);
    if (original === undefined) throw new Error(`Published acceptance target lost ${name}`);
    await assertFrozenRegularFile(original, `Seeded acceptance target original file ${name}`);
  }
  await assertFrozenRegularFile(seedSnapshot, "Exclusively written synthetic plugin-data seed");
  transaction.seedBytes = seedBytes;
  transaction.targetSnapshot = seededSnapshot;
  transaction.targetTree = seededTree;
  transaction.installState = "target-five";
  await assertInstallBoundary(transaction);
  await invokeHook(transaction, "afterSeed", () => assertInstallBoundary(transaction));
}

async function createReceiptStage(transaction) {
  await assertInstallBoundary(transaction);
  const artifactSetDigest = computeAcceptanceArtifactSetDigest(transaction.source);
  transaction.receipt = createInstallationReceipt({
    state: transaction.run.state,
    stateBytes: transaction.run.stateBytes,
    pluginVersion: transaction.sourceContract.pluginVersion,
    artifactBinding: transaction.sourceContract.artifactBinding,
    artifactSetDigest,
    seedBytes: transaction.seedBytes,
  });
  transaction.receiptBytes = encodeInstallationReceipt(transaction.receipt);
  transaction.receiptStagePath = join(
    transaction.paths.devRoot,
    `${RECEIPT_STAGE_PREFIX}${process.pid}-${randomUUID()}`,
  );
  transaction.receiptStageSnapshot = await writeExclusiveRegularFile(
    transaction.receiptStagePath,
    transaction.receiptBytes,
    "Installation receipt stage",
  );
  if (transaction.receiptStageSnapshot.evidence.dev !== transaction.devRootSnapshot.dev) {
    throw new Error("Installation receipt stage must remain on the .dev-vault device");
  }
  await assertReceipt(
    transaction.receiptStageSnapshot,
    transaction.receiptBytes,
    transaction.receipt,
    "Installation receipt stage",
  );
  await assertInstallBoundary(transaction);
  await invokeHook(transaction, "beforeReceiptPublish", () => assertInstallBoundary(transaction));
}

async function publishReceipt(transaction) {
  await assertInstallBoundary(transaction);
  await assertAbsent(transaction.paths.receiptPath, "Installation receipt before publication");
  const stagedReceipt = transaction.receiptStageSnapshot;
  if (stagedReceipt === null) throw new Error("installation receipt stage proof is unavailable");
  await rename(transaction.receiptStagePath, transaction.paths.receiptPath);
  transaction.receiptPublished = true;
  const published = await readFrozenRegularFile(
    transaction.paths.receiptPath,
    "Published installation receipt",
  );
  if (
    !sameFileEvidence(published.evidence, stagedReceipt.evidence)
    || !published.bytes.equals(stagedReceipt.bytes)
  ) {
    throw new Error("published installation receipt identity changed across rename");
  }
  transaction.receiptSnapshot = published;
  await assertReceipt(
    published,
    transaction.receiptBytes,
    transaction.receipt,
    "Published installation receipt",
  );
  await assertInstallBoundary(transaction);
  await invokeHook(transaction, "afterReceiptPublish", () => assertInstallBoundary(transaction));
}

async function prevalidateTargetForRollback(transaction) {
  if (!transaction.targetPublished || transaction.targetTree === null || transaction.targetSnapshot === null) {
    throw new Error("published target ownership proof is unavailable");
  }
  await assertOwnedTree(transaction.targetTree, "Published acceptance target rollback");
  await assertExactDirectory(transaction.targetSnapshot, "Published acceptance target rollback");
  if (transaction.installState === "target-five") {
    assertArtifactBytes(transaction.targetSnapshot, transaction.source, "Published acceptance target rollback");
    const seed = transaction.targetSnapshot.files.get("data.json");
    if (seed === undefined || !seed.bytes.equals(transaction.seedBytes)) {
      throw new Error("published acceptance seed changed before rollback");
    }
    decodeSyntheticPluginDataSeed(seed.bytes);
  } else {
    assertArtifactBytes(transaction.targetSnapshot, transaction.source, "Published acceptance target rollback");
  }
}

async function assertRollbackBoundary(transaction) {
  await assertCanonicalBoundary(transaction);
  await assertArtifactLock(transaction);
  await assertDestinationLock(transaction);
  try {
    await assertDirectorySnapshot(transaction.run.pluginsParent, "Acceptance plugins parent during rollback");
  } catch (error) {
    throw new Error("acceptance rollback plugins parent changed", { cause: error });
  }
}

async function rollbackPublishedObjects(transaction) {
  await assertRollbackBoundary(transaction);
  if (
    transaction.receiptStagePath !== null
    && transaction.receiptStageSnapshot === null
    && await optionalStat(transaction.receiptStagePath) !== null
  ) {
    throw new Error("unproved installation receipt stage was retained");
  }
  if (transaction.receiptPublished) {
    if (transaction.receiptSnapshot === null) throw new Error("published receipt ownership proof is unavailable");
    await assertReceipt(
      transaction.receiptSnapshot,
      transaction.receiptBytes,
      transaction.receipt,
      "Published installation receipt rollback",
    );
    await prevalidateTargetForRollback(transaction);
    await guardedUnlink(
      transaction.receiptSnapshot,
      transaction.receiptBytes,
      "Published installation receipt rollback",
    );
    transaction.receiptPublished = false;
    transaction.receiptSnapshot = null;
    await removeOwnedTreeBottomUp(transaction.targetTree, "Published acceptance target rollback");
    transaction.targetPublished = false;
    transaction.targetTree = null;
    transaction.targetSnapshot = null;
    return;
  }

  if (transaction.receiptStageSnapshot !== null) {
    await assertReceipt(
      transaction.receiptStageSnapshot,
      transaction.receiptBytes,
      transaction.receipt,
      "Installation receipt stage rollback",
    );
    await prevalidateTargetForRollback(transaction);
    await guardedUnlink(
      transaction.receiptStageSnapshot,
      transaction.receiptBytes,
      "Installation receipt stage rollback",
    );
    transaction.receiptStageSnapshot = null;
    await removeOwnedTreeBottomUp(transaction.targetTree, "Published acceptance target rollback");
    transaction.targetPublished = false;
    transaction.targetTree = null;
    transaction.targetSnapshot = null;
    return;
  }

  if (transaction.targetPublished) {
    await prevalidateTargetForRollback(transaction);
    await removeOwnedTreeBottomUp(transaction.targetTree, "Published acceptance target rollback");
    transaction.targetPublished = false;
    transaction.targetTree = null;
    transaction.targetSnapshot = null;
    return;
  }

  if (transaction.stageCreated) {
    if (transaction.stageTree === null) throw new Error("acceptance target stage ownership proof is unavailable");
    await assertOwnedTree(transaction.stageTree, "Acceptance target stage rollback");
    await removeOwnedTreeBottomUp(transaction.stageTree, "Acceptance target stage rollback");
    transaction.stageCreated = false;
    transaction.stageTree = null;
    transaction.stageSnapshot = null;
  }
}

async function executeDestinationTransaction(transaction) {
  let failure = NO_FAILURE;
  try {
    await createAndPopulateStage(transaction);
    await publishTarget(transaction);
    await publishSeed(transaction);
    await createReceiptStage(transaction);
    await publishReceipt(transaction);
    return Object.freeze({
      runId: transaction.run.state.runId,
      pluginVersion: transaction.sourceContract.pluginVersion,
      artifactBinding: transaction.sourceContract.artifactBinding,
    });
  } catch (error) {
    failure = error;
  }

  const postTarget = transaction.targetPublished
    || transaction.receiptStageSnapshot !== null
    || transaction.receiptPublished;
  try {
    await rollbackPublishedObjects(transaction);
  } catch (rollbackError) {
    if (postTarget) {
      transaction.rollbackIncomplete = true;
      throw new AcceptanceInstallFailure(
        ACCEPTANCE_INSTALL_FAILURE_TOKEN,
        "rollback-incomplete",
        "published acceptance evidence was retained because rollback could not be proved safe",
        { cause: new AggregateError([failure, rollbackError], "Acceptance rollback was incomplete") },
      );
    }
    throw new AcceptanceInstallFailure(
      ACCEPTANCE_INSTALL_FAILURE_TOKEN,
      "cleanup-incomplete",
      "acceptance stage evidence was retained because cleanup could not be proved safe",
      { cause: new AggregateError([failure, rollbackError], "Acceptance cleanup was incomplete") },
    );
  }
  throw normalizeFailure(failure, "artifact-invalid");
}

async function publishSeedAndReceipt({ transaction }) {
  let lockCallbackEntered = false;
  let result;
  try {
    result = await withBrandedDestinationLock(
      {
        parent: transaction.run.pluginsParent,
        name: DESTINATION_LOCK_NAME,
        label: "Acceptance destination lock",
      },
      async () => {
        lockCallbackEntered = true;
        transaction.destinationLockSnapshot = await readFrozenRegularFile(
          transaction.paths.destinationLockPath,
          "Acceptance destination lock",
        );
        transaction.installState = "lock-held";
        await invokeHook(
          transaction,
          "afterDestinationLock",
          () => assertInstallBoundary(transaction),
        );
        return executeDestinationTransaction(transaction);
      },
    );
  } catch (error) {
    if (!lockCallbackEntered && hasErrorCode(error, "EEXIST")) {
      throw normalizeFailure(error, "concurrent-operation");
    }
    if (transaction.rollbackIncomplete) {
      throw forceFailure(
        "rollback-incomplete",
        "published acceptance evidence and destination cleanup were retained",
        error,
      );
    }
    if (destinationCleanupFailures.has(error)) {
      throw forceFailure(
        "cleanup-incomplete",
        "acceptance destination-lock cleanup was incomplete",
        destinationCleanupFailures.get(error),
      );
    }
    throw normalizeFailure(error, "artifact-invalid");
  }
  return result;
}

async function hasArtifactConcurrentResidue(paths) {
  const distPath = join(paths.repoRoot, "dist");
  const stat = await optionalStat(distPath);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  const names = await readdir(distPath);
  return names.includes(ARTIFACT_LOCK_NAME) || retainedArtifactResidue(names).length !== 0;
}

async function hasRetainedArtifactResidue(paths) {
  const distPath = join(paths.repoRoot, "dist");
  const stat = await optionalStat(distPath);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  return retainedArtifactResidue(await readdir(distPath)).length !== 0;
}

export async function installAcceptanceDevelopment(options) {
  const checked = validateOptions(options);
  const paths = fixedPaths(checked.repoRoot);
  let artifactCallbackEntered = false;
  let transaction = null;
  let result;
  try {
    result = await withBrandedArtifactLock(checked.repoRoot, async (lease) => {
      artifactCallbackEntered = true;
      transaction = await createTransaction({
        repoRoot: checked.repoRoot,
        hooks: checked.hooks,
        lease,
      });
      await invokeHook(transaction, "afterArtifactLock", () => assertPreRunBoundary(transaction));

      let git;
      try {
        git = await captureCleanGitState(checked.repoRoot);
      } catch (error) {
        fail("concurrent-operation", "Git index, worktree, or HEAD is not stable", error);
      }
      await loadAndValidatePreparationRun({ transaction, git });

      try {
        await buildAcceptanceArtifactUnderLease({ lease });
      } catch (error) {
        if (await hasRetainedArtifactResidue(paths)) {
          fail("cleanup-incomplete", "acceptance artifact builder retained reserved residue", error);
        }
        fail("artifact-invalid", "acceptance artifact build failed", error);
      }
      await freezeBuiltSource(transaction);
      transaction.distNamespace = await captureArtifactDistNamespace(paths, "concurrent-operation");
      await invokeHook(transaction, "afterBuild", async () => {
        await assertFrozenSource(transaction, "artifact-invalid");
        await assertPreparedRunBoundary(transaction);
      });

      await invokeHook(transaction, "afterSourceFreeze", async () => {
        await assertFrozenSource(transaction);
        await assertPreparedRunBoundary(transaction);
      });

      return publishSeedAndReceipt({ transaction });
    });
  } catch (error) {
    if (transaction?.rollbackIncomplete || transaction?.targetPublished || transaction?.receiptPublished) {
      throw forceFailure(
        "rollback-incomplete",
        "published acceptance evidence was retained",
        error,
      );
    }
    if (artifactCleanupFailures.has(error)) {
      throw forceFailure(
        "cleanup-incomplete",
        "acceptance artifact-lock cleanup was incomplete",
        artifactCleanupFailures.get(error),
      );
    }
    if (!artifactCallbackEntered && hasErrorCode(error, "EEXIST")) {
      throw normalizeFailure(error, "concurrent-operation");
    }
    if (!artifactCallbackEntered && await hasArtifactConcurrentResidue(paths)) {
      throw normalizeFailure(error, "concurrent-operation");
    }
    throw normalizeFailure(error, "artifact-invalid");
  }
  return result;
}

Object.defineProperty(installAcceptanceDevelopment, "extractFailureCategory", {
  configurable: false,
  enumerable: false,
  value(error) {
    const category = trustedInstallFailureCategories.get(error);
    return category !== undefined && FAILURE_CATEGORIES.has(category) ? category : null;
  },
  writable: false,
});
Object.freeze(installAcceptanceDevelopment);
