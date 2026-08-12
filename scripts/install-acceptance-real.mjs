import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildAcceptanceArtifactUnderLease,
  loadAcceptanceArtifactSource,
  withAcceptanceArtifactLock,
} from "./acceptance-build.mjs";
import {
  ACCEPTANCE_FILES,
  computeAcceptanceArtifactSetDigest,
  validateAcceptanceArtifactSnapshot,
} from "./acceptance-artifact-contract.mjs";
import {
  assertExactDirectory,
  assertFrozenRegularFile,
  assertFrozenRegularFileInOwnedTree,
  assertOwnedTree,
  readFrozenRegularFile,
  removeOwnedTreeBottomUp,
  snapshotExactDirectory,
  snapshotOwnedTree,
  withExclusiveIdentityLock,
  writeExclusiveRegularFile,
} from "./safe-fs-core.mjs";
import {
  assertCleanGitState,
  captureCleanGitState,
} from "./git-worktree-state.mjs";
import { buildFrozenNormalArtifact } from "./normal-real-artifact.mjs";

const AUTHORIZED_ACTION = "INSTALL_READ_ONLY_ACCEPTANCE_IN_THIS_VAULT";
const NORMAL_AUTHORIZED_ACTION = "INSTALL_NORMAL_BUILD_IN_THIS_VAULT";
const PLUGIN_ID = "knowledge-workbench";
const DESTINATION_LOCK = ".knowledge-workbench-read-only-install.lock";
const TRANSACTION_DIRECTORY = ".knowledge-workbench-read-only-install.transaction";
const NORMAL_TARGET_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);
const DATA_FILE = "data.json";
const FAILURE_TOKEN = Object.freeze({});
const trustedCategories = new WeakMap();
const artifactCallbackFailures = new WeakMap();
const artifactCleanupFailures = new WeakMap();
const destinationCallbackFailures = new WeakMap();
const destinationCleanupFailures = new WeakMap();

const isMissing = (error) => (
  typeof error === "object" && error !== null && error.code === "ENOENT"
);
const isExisting = (error) => (
  typeof error === "object" && error !== null && error.code === "EEXIST"
);

class RealVaultInstallFailure extends Error {
  constructor(token, category, message, options = undefined) {
    super(message, options);
    if (token !== FAILURE_TOKEN) throw new TypeError("untrusted installer failure");
    this.name = "RealVaultInstallFailure";
    trustedCategories.set(this, category);
    Object.freeze(this);
  }
}

function fail(category, message, cause = undefined) {
  throw new RealVaultInstallFailure(
    FAILURE_TOKEN,
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
          "Real-vault installer artifact callback failed",
        );
      }
    });
  } catch (error) {
    if (artifactCallbackFailures.has(error)) throw artifactCallbackFailures.get(error);
    if (error instanceof AggregateError) {
      throw brandHelperFailure(
        artifactCleanupFailures,
        error,
        "Real-vault installer artifact-lock cleanup failed",
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
          "Real-vault installer destination callback failed",
        );
      }
    });
  } catch (error) {
    if (destinationCallbackFailures.has(error)) throw destinationCallbackFailures.get(error);
    if (error instanceof AggregateError) {
      throw brandHelperFailure(
        destinationCleanupFailures,
        error,
        "Real-vault installer destination-lock cleanup failed",
      );
    }
    throw error;
  }
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameFileEvidence = (left, right) => (
  sameIdentity(left, right)
  && left.nlink === right.nlink
  && left.size === right.size
  && left.sha256 === right.sha256
);

async function optionalStat(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertAbsent(path, category, label) {
  try {
    if (await optionalStat(path) !== null) fail(category, `${label} must remain absent`);
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail(category, `${label} absence could not be proven`, error);
  }
}

function artifactView(snapshot, names = ACCEPTANCE_FILES) {
  const files = new Map();
  for (const name of names) files.set(name, snapshot.files.get(name));
  return Object.freeze({
    directory: Object.freeze({ path: snapshot.path, dev: snapshot.dev, ino: snapshot.ino }),
    names,
    files,
  });
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

function sameArtifactSnapshot(left, right) {
  if (
    !sameIdentity(left.directory, right.directory)
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

async function freezeBuiltArtifact(lease, target) {
  try {
    const diskSnapshot = await snapshotExactDirectory(
      target,
      ACCEPTANCE_FILES,
      "Built real-vault acceptance artifact",
    );
    const source = await loadAcceptanceArtifactSource({ lease });
    const contract = validateAcceptanceArtifactSnapshot(source);
    if (!sourceMatchesDiskSnapshot(source, diskSnapshot)) {
      fail("artifact-invalid", "acceptance source was not bound to its exact disk snapshot");
    }
    await assertExactDirectory(diskSnapshot, "Built real-vault acceptance artifact");
    return Object.freeze({ contract, diskSnapshot, source });
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("artifact-invalid", "read-only acceptance artifact is invalid", error);
  }
}

async function assertFrozenArtifact(lease, frozen) {
  try {
    const before = await snapshotExactDirectory(
      frozen.diskSnapshot.path,
      ACCEPTANCE_FILES,
      "Frozen real-vault acceptance artifact before lease read",
    );
    await assertExactDirectory(
      frozen.diskSnapshot,
      "Frozen real-vault acceptance artifact baseline",
    );
    const current = await loadAcceptanceArtifactSource({ lease });
    validateAcceptanceArtifactSnapshot(current);
    if (
      !sameArtifactSnapshot(current, frozen.source)
      || !sourceMatchesDiskSnapshot(current, before)
    ) fail("artifact-changed", "frozen acceptance artifact changed");
    const after = await snapshotExactDirectory(
      frozen.diskSnapshot.path,
      ACCEPTANCE_FILES,
      "Frozen real-vault acceptance artifact after lease read",
    );
    if (
      !sourceMatchesDiskSnapshot(current, after)
      || !sameArtifactSnapshot(artifactView(before), artifactView(after))
    ) fail("artifact-changed", "frozen acceptance artifact changed during validation");
    await assertExactDirectory(before, "Frozen real-vault acceptance artifact sandwich");
    await assertExactDirectory(
      frozen.diskSnapshot,
      "Frozen real-vault acceptance artifact baseline",
    );
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("artifact-changed", "frozen acceptance artifact changed", error);
  }
}

async function captureFrozenGitState(repoRoot) {
  try {
    return await captureCleanGitState(repoRoot);
  } catch (error) {
    fail("artifact-invalid", "repository must be one clean canonical Git worktree", error);
  }
}

async function assertFrozenGitState(repoRoot, frozen) {
  try {
    await assertCleanGitState(repoRoot, frozen.commit);
  } catch (error) {
    fail("artifact-changed", "repository clean state or Git HEAD changed", error);
  }
}

function assertArtifactBytes(snapshot, artifact, label) {
  artifact.validateSnapshot(artifactView(snapshot, artifact.names));
  for (const name of artifact.names) {
    const actual = snapshot.files.get(name);
    const expected = artifact.source.files.get(name);
    if (actual === undefined || expected === undefined || !actual.bytes.equals(expected.bytes)) {
      throw new Error(`${label} file bytes do not match the frozen source`);
    }
  }
}

function sameExactSnapshot(left, right) {
  if (
    !sameIdentity(left, right)
    || !isDeepStrictEqual([...left.names], [...right.names])
  ) return false;
  for (const name of left.names) {
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

function sameOwnedEntryEvidence(left, right) {
  return left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.sha256 === right.sha256;
}

async function removeClaimedOwnedTree(tree, label) {
  const claimPath = `${tree.root.path}.cleanup-${randomUUID()}`;
  await assertAbsent(claimPath, "cleanup-incomplete", `${label} cleanup claim`);
  await assertOwnedTree(tree, label);
  await rename(tree.root.path, claimPath);

  let claimed;
  try {
    claimed = await snapshotOwnedTree(
      claimPath,
      [...tree.entries.keys()],
      `${label} claimed cleanup tree`,
    );
    if (
      !sameIdentity(claimed.root, tree.root)
      || claimed.entries.size !== tree.entries.size
    ) throw new Error(`${label} cleanup claim root changed`);
    for (const [relativePath, expected] of tree.entries) {
      const current = claimed.entries.get(relativePath);
      if (current === undefined || !sameOwnedEntryEvidence(current, expected)) {
        throw new Error(`${label} cleanup claim entry ${relativePath} changed`);
      }
    }
    await assertOwnedTree(claimed, `${label} claimed cleanup tree`);
  } catch (error) {
    throw new Error(`${label} cleanup claim could not be proven`, { cause: error });
  }

  await removeOwnedTreeBottomUp(claimed, `${label} claimed cleanup tree`);
}

async function captureBoundExactTree(path, names, expectedSnapshot, expectedRoot, label) {
  const current = await snapshotExactDirectory(path, names, label);
  if (!sameExactSnapshot(current, expectedSnapshot)) {
    throw new Error(`${label} is not the exact previously proven directory`);
  }
  const tree = await snapshotOwnedTree(path, names, label);
  if (
    !sameIdentity(tree.root, current)
    || !sameIdentity(tree.root, expectedRoot)
  ) throw new Error(`${label} root identity changed`);
  for (const name of names) {
    const file = current.files.get(name);
    if (file === undefined) throw new Error(`${label} lost file ${name}`);
    assertFrozenRegularFileInOwnedTree(tree, name, file, `${label} file ${name}`);
  }
  await assertOwnedTree(tree, label);
  return Object.freeze({ snapshot: current, tree });
}

async function refreshStageTree(transaction, label) {
  if (transaction.stageRoot === null) throw new Error(`${label} root proof is unavailable`);
  const tree = await snapshotOwnedTree(transaction.stagePath, transaction.writtenNames, label);
  if (!sameIdentity(tree.root, transaction.stageRoot)) {
    throw new Error(`${label} root identity changed`);
  }
  for (const name of transaction.writtenNames) {
    const written = transaction.writtenFiles.get(name);
    if (written === undefined) throw new Error(`${label} lost exclusive-write proof for ${name}`);
    await assertFrozenRegularFile(written, `${label} file ${name}`);
    assertFrozenRegularFileInOwnedTree(tree, name, written, `${label} file ${name}`);
  }
  await assertOwnedTree(tree, label);
  transaction.stageTree = tree;
  return tree;
}

async function removeEmptyTransactionRoot(transaction, label) {
  if (transaction.transactionRoot === null) {
    if (
      transaction.transactionRootCreated
      && await optionalStat(transaction.transactionPath) !== null
    ) throw new Error(`${label} ownership proof is unavailable`);
    return;
  }
  const tree = await snapshotOwnedTree(transaction.transactionPath, [], label);
  if (!sameIdentity(tree.root, transaction.transactionRoot)) {
    throw new Error(`${label} root identity changed`);
  }
  await assertOwnedTree(tree, label);
  await removeOwnedTreeBottomUp(tree, label);
  transaction.transactionRoot = null;
  transaction.transactionRootCreated = false;
}

function validateNormalTarget(snapshot) {
  let manifest;
  try {
    const file = snapshot.files.get("manifest.json");
    if (file === undefined) throw new Error("normal target manifest is missing");
    manifest = JSON.parse(file.bytes.toString("utf8"));
  } catch (error) {
    fail("target-invalid", "existing target manifest is invalid", error);
  }
  if (
    typeof manifest !== "object"
    || manifest === null
    || Array.isArray(manifest)
    || manifest.id !== PLUGIN_ID
    || typeof manifest.version !== "string"
  ) fail("target-invalid", "existing target is not Knowledge Workbench");
}

async function captureTargetState(targetPath) {
  let stat;
  try {
    stat = await optionalStat(targetPath);
  } catch (error) {
    fail("target-invalid", "existing plugin target could not be inspected", error);
  }
  if (stat === null) return Object.freeze({ kind: "absent", targetPath });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("target-invalid", "existing plugin target must be a non-symlink directory");
  }
  let names;
  try {
    names = (await readdir(targetPath)).sort();
  } catch (error) {
    fail("target-invalid", "existing plugin target could not be enumerated", error);
  }
  const normal = [...NORMAL_TARGET_FILES];
  const acceptance = [...ACCEPTANCE_FILES];
  const normalWithData = [...NORMAL_TARGET_FILES, DATA_FILE].sort();
  const acceptanceWithData = [...ACCEPTANCE_FILES, DATA_FILE].sort();
  const isNormal = isDeepStrictEqual(names, normal) || isDeepStrictEqual(names, normalWithData);
  const isAcceptance = isDeepStrictEqual(names, acceptance)
    || isDeepStrictEqual(names, acceptanceWithData);
  if (!isNormal && !isAcceptance) {
    fail("target-invalid", "existing plugin target is not one bounded managed file set");
  }
  try {
    const snapshot = await snapshotExactDirectory(
      targetPath,
      names,
      "Existing bounded Knowledge Workbench target",
    );
    if (isAcceptance) validateAcceptanceArtifactSnapshot(artifactView(snapshot));
    else validateNormalTarget(snapshot);
    const tree = await snapshotOwnedTree(
      targetPath,
      names,
      "Existing bounded Knowledge Workbench target",
    );
    return Object.freeze({
      data: snapshot.files.get(DATA_FILE) ?? null,
      kind: "existing",
      names: Object.freeze(names),
      snapshot,
      targetPath,
      tree,
    });
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("target-invalid", "existing plugin target is invalid", error);
  }
}

async function assertTargetState(state, category) {
  if (state.kind === "absent") {
    await assertAbsent(state.targetPath, category, "plugin target");
    return;
  }
  try {
    await assertExactDirectory(state.snapshot, "Existing Knowledge Workbench target");
    const current = await snapshotExactDirectory(
      state.targetPath,
      state.names,
      "Existing Knowledge Workbench target",
    );
    if (!sameExactSnapshot(current, state.snapshot)) fail(category, "existing target changed");
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail(category, "existing target changed", error);
  }
}

function validateOptions(options, authorizedAction) {
  if (
    typeof options !== "object"
    || options === null
    || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
  ) fail("invalid-invocation", "options must be one plain object");
  const keys = Reflect.ownKeys(options).sort();
  if (
    keys.length !== 3
    || keys[0] !== "action"
    || keys[1] !== "repoRoot"
    || keys[2] !== "vaultPath"
  ) fail("invalid-invocation", "options must contain only action, repoRoot, and vaultPath");
  if (
    options.action !== authorizedAction
    || typeof options.repoRoot !== "string"
    || !isAbsolute(options.repoRoot)
    || typeof options.vaultPath !== "string"
    || !isAbsolute(options.vaultPath)
    || options.vaultPath.includes("\0")
  ) fail("invalid-invocation", "installer authorization or path is invalid");
  return Object.freeze({
    action: options.action,
    repoRoot: resolve(options.repoRoot),
    vaultPath: resolve(options.vaultPath),
  });
}

async function requireCanonicalDirectory(path, label) {
  let stat;
  try {
    stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("vault-invalid", `${label} is not a canonical directory`);
    }
    if (await realpath(path) !== path) {
      fail("vault-invalid", `${label} path is not canonical`);
    }
    return Object.freeze({ path, dev: stat.dev, ino: stat.ino });
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("vault-invalid", `${label} is unavailable`, error);
  }
}

async function assertCanonicalDirectory(snapshot, category, label) {
  try {
    const stat = await lstat(snapshot.path, { bigint: true });
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || !sameIdentity(stat, snapshot)
      || await realpath(snapshot.path) !== snapshot.path
    ) fail(category, `${label} changed`);
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail(category, `${label} changed`, error);
  }
}

async function readCommunityPluginState(vaultPath) {
  let snapshot;
  try {
    snapshot = await readFrozenRegularFile(
      join(vaultPath, ".obsidian", "community-plugins.json"),
      "community plugin state",
    );
    const ids = JSON.parse(snapshot.bytes.toString("utf8"));
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      fail("vault-invalid", "community plugin state must be an array of strings");
    }
    if (ids.includes(PLUGIN_ID)) {
      fail("plugin-enabled", "Knowledge Workbench must be disabled before installation");
    }
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("vault-invalid", "community plugin state is unavailable", error);
  }
  return snapshot;
}

async function assertCommunityPluginState(snapshot) {
  try {
    await assertFrozenRegularFile(snapshot, "community plugin state");
    const ids = JSON.parse(snapshot.bytes.toString("utf8"));
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      fail("plugin-state-changed", "community plugin state became invalid");
    }
    if (ids.includes(PLUGIN_ID)) {
      fail("plugin-state-changed", "Knowledge Workbench became enabled during installation");
    }
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("plugin-state-changed", "community plugin state changed", error);
  }
}

async function assertObsidianStopped() {
  let result;
  try {
    result = await new Promise((resolveResult) => {
      execFile(
        "/usr/bin/pgrep",
        ["-x", "Obsidian"],
        { encoding: "utf8", maxBuffer: 4096 },
        (error, stdout, stderr) => {
          resolveResult(Object.freeze({ error, stderr, stdout }));
        },
      );
    });
  } catch (error) {
    fail("host-state-unknown", "Obsidian process state could not be inspected", error);
  }
  if (result.error === null) {
    if (result.stderr !== "" || !/^\d+(?:\n\d+)*\n?$/.test(result.stdout)) {
      fail("host-state-unknown", "Obsidian process probe returned an unexpected result");
    }
    fail("host-running", "Obsidian must be fully stopped before installation");
  }
  if (
    typeof result.error === "object"
    && result.error !== null
    && result.error.code === 1
    && result.stdout === ""
    && result.stderr === ""
  ) return;
  fail("host-state-unknown", "Obsidian process state could not be proven stopped");
}

async function createSecureDirectory(path, expectedDevice, label, onCreated) {
  try {
    await mkdir(path, { mode: 0o700 });
    onCreated();
  } catch (error) {
    if (isExisting(error)) fail("concurrent-operation", `${label} already exists`, error);
    fail("target-changed", `${label} could not be created`, error);
  }
  try {
    const stat = await lstat(path, { bigint: true });
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || stat.dev !== expectedDevice
      || (stat.mode & 0o777n) !== 0o700n
      || await realpath(path) !== path
    ) fail("target-changed", `${label} is not a private canonical directory`);
    return Object.freeze({ path, dev: stat.dev, ino: stat.ino });
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("target-changed", `${label} could not be validated`, error);
  }
}

async function cleanupUnpublishedTransaction(transaction) {
  if (transaction.stageTree !== null) {
    await assertOwnedTree(
      transaction.stageTree,
      "Unpublished real-vault acceptance stage",
    );
    await removeClaimedOwnedTree(
      transaction.stageTree,
      "Unpublished real-vault acceptance stage",
    );
    transaction.stageTree = null;
    transaction.stageRoot = null;
    transaction.stageRootCreated = false;
  } else if (
    (transaction.stageRoot !== null || transaction.stageRootCreated)
    && await optionalStat(transaction.stagePath) !== null
  ) {
    throw new Error("unpublished stage ownership proof is unavailable");
  }
  await removeEmptyTransactionRoot(
    transaction,
    "Empty real-vault acceptance transaction",
  );
}

async function assertReboundTarget(path, state, label) {
  if (state.kind !== "existing") throw new Error(`${label} has no original target snapshot`);
  const current = await snapshotExactDirectory(path, state.names, label);
  if (!sameExactSnapshot(current, state.snapshot)) {
    throw new Error(`${label} was not rebound to the exact original directory`);
  }
  return current;
}

async function assertRollbackNamespace(transaction) {
  await assertCanonicalDirectory(
    transaction.obsidian,
    "rollback-incomplete",
    "rollback vault configuration",
  );
  await assertCanonicalDirectory(
    transaction.plugins,
    "rollback-incomplete",
    "rollback community plugin directory",
  );
}

async function rollbackPublication(transaction) {
  const quarantinePath = join(transaction.transactionPath, "quarantine");
  await assertRollbackNamespace(transaction);
  if (transaction.published) {
    if (transaction.stageSnapshot === null) {
      throw new Error("published stage ownership proof is unavailable");
    }
    const published = await captureBoundExactTree(
      transaction.targetPath,
      transaction.stageNames,
      transaction.stageSnapshot,
      transaction.stageSnapshot,
      "Published real-vault acceptance target before rollback",
    );
    await assertRollbackNamespace(transaction);
    await assertAbsent(quarantinePath, "rollback-incomplete", "rollback quarantine");
    await assertOwnedTree(published.tree, "Published real-vault acceptance target before rollback");
    await assertRollbackNamespace(transaction);
    await rename(transaction.targetPath, quarantinePath);
    await assertRollbackNamespace(transaction);
    await assertAbsent(transaction.targetPath, "rollback-incomplete", "published plugin target");
    const quarantined = await captureBoundExactTree(
      quarantinePath,
      transaction.stageNames,
      transaction.stageSnapshot,
      transaction.stageSnapshot,
      "Quarantined real-vault acceptance target",
    );
    transaction.quarantineTree = quarantined.tree;
    transaction.published = false;
  }
  if (transaction.backedUp) {
    if (transaction.targetState.kind !== "existing") {
      throw new Error("original target backup has no ownership proof");
    }
    const backup = await captureBoundExactTree(
      transaction.backupPath,
      transaction.targetState.names,
      transaction.targetState.snapshot,
      transaction.targetState.tree.root,
      "Transaction backup before restore",
    );
    await assertRollbackNamespace(transaction);
    await assertAbsent(transaction.targetPath, "rollback-incomplete", "restore target");
    await assertOwnedTree(backup.tree, "Transaction backup before restore");
    await assertRollbackNamespace(transaction);
    await rename(transaction.backupPath, transaction.targetPath);
    await assertRollbackNamespace(transaction);
    await captureBoundExactTree(
      transaction.targetPath,
      transaction.targetState.names,
      transaction.targetState.snapshot,
      transaction.targetState.tree.root,
      "Restored Knowledge Workbench target",
    );
    transaction.backedUp = false;
    transaction.restorationProven = true;
  } else if (transaction.targetState.kind === "absent") {
    await assertRollbackNamespace(transaction);
    await assertAbsent(transaction.targetPath, "rollback-incomplete", "restored absent target");
    await assertRollbackNamespace(transaction);
    transaction.restorationProven = true;
  } else {
    throw new Error("original target backup is unavailable for rollback");
  }
  if (transaction.quarantineTree !== null) {
    await assertOwnedTree(
      transaction.quarantineTree,
      "Quarantined real-vault acceptance target",
    );
    await removeClaimedOwnedTree(
      transaction.quarantineTree,
      "Quarantined real-vault acceptance target",
    );
    transaction.quarantineTree = null;
    transaction.stageTree = null;
    transaction.stageRoot = null;
    transaction.stageRootCreated = false;
  }
  await cleanupUnpublishedTransaction(transaction);
}

async function publishTarget(input) {
  const transaction = {
    backedUp: false,
    backupPath: null,
    committed: false,
    obsidian: input.obsidian,
    plugins: input.plugins,
    quarantineTree: null,
    restorationProven: false,
    transactionPath: join(input.obsidian.path, TRANSACTION_DIRECTORY),
    transactionRoot: null,
    transactionRootCreated: false,
    stagePath: null,
    stageNames: null,
    stageRoot: null,
    stageRootCreated: false,
    stageSnapshot: null,
    stageTree: null,
    targetPath: join(input.plugins.path, PLUGIN_ID),
    targetState: null,
    writtenFiles: new Map(),
    writtenNames: [],
    published: false,
  };
  transaction.stagePath = join(transaction.transactionPath, "stage");
  transaction.backupPath = join(transaction.transactionPath, "backup");
  let failure = null;
  try {
    transaction.targetState = await captureTargetState(transaction.targetPath);
    transaction.stageNames = Object.freeze([
      ...input.artifact.names,
      ...(transaction.targetState.kind === "existing" && transaction.targetState.data !== null
        ? [DATA_FILE]
        : []),
    ].sort());
    transaction.transactionRoot = await createSecureDirectory(
      transaction.transactionPath,
      input.obsidian.dev,
      "real-vault acceptance transaction",
      () => {
        transaction.transactionRootCreated = true;
      },
    );
    transaction.stageRoot = await createSecureDirectory(
      transaction.stagePath,
      input.obsidian.dev,
      "real-vault acceptance stage",
      () => {
        transaction.stageRootCreated = true;
      },
    );
    const emptyStage = await snapshotOwnedTree(
      transaction.stagePath,
      [],
      "Empty real-vault acceptance stage",
    );
    if (!sameIdentity(emptyStage.root, transaction.stageRoot)) {
      throw new Error("empty real-vault acceptance stage root identity changed");
    }
    transaction.stageTree = emptyStage;
    for (const name of input.artifact.names) {
      const sourceFile = input.artifact.source.files.get(name);
      if (sourceFile === undefined) fail("artifact-changed", "frozen source lost an artifact file");
      const written = await writeExclusiveRegularFile(
        join(transaction.stagePath, name),
        sourceFile.bytes,
        `Real-vault acceptance stage file ${name}`,
      );
      transaction.writtenFiles.set(name, written);
      transaction.writtenNames.push(name);
      transaction.writtenNames.sort();
      await refreshStageTree(transaction, "Partial real-vault acceptance stage");
    }
    if (transaction.targetState.kind === "existing" && transaction.targetState.data !== null) {
      const written = await writeExclusiveRegularFile(
        join(transaction.stagePath, DATA_FILE),
        transaction.targetState.data.bytes,
        "Real-vault acceptance opaque plugin data",
      );
      transaction.writtenFiles.set(DATA_FILE, written);
      transaction.writtenNames.push(DATA_FILE);
      transaction.writtenNames.sort();
      await refreshStageTree(transaction, "Partial real-vault acceptance stage");
    }
    const stage = await snapshotExactDirectory(
      transaction.stagePath,
      transaction.stageNames,
      "Complete real-vault acceptance stage",
    );
    assertArtifactBytes(stage, input.artifact, "Complete real-vault plugin stage");
    if (
      transaction.targetState.kind === "existing"
      && transaction.targetState.data !== null
      && !stage.files.get(DATA_FILE)?.bytes.equals(transaction.targetState.data.bytes)
    ) fail("target-changed", "opaque plugin data changed while staging");
    await snapshotOwnedTree(
      transaction.stagePath,
      transaction.stageNames,
      "Owned real-vault acceptance stage",
    );
    transaction.stageTree = await refreshStageTree(
      transaction,
      "Complete owned real-vault acceptance stage",
    );
    transaction.stageSnapshot = stage;

    await input.artifact.assertCurrent();
    await assertCanonicalDirectory(input.obsidian, "vault-changed", "vault configuration");
    await assertCanonicalDirectory(input.plugins, "vault-changed", "community plugin directory");
    await assertCommunityPluginState(input.community);
    await assertObsidianStopped();
    await assertTargetState(transaction.targetState, "target-changed");
    await assertAbsent(transaction.backupPath, "concurrent-operation", "transaction backup");
    await assertCanonicalDirectory(input.obsidian, "vault-changed", "vault configuration");
    await assertCanonicalDirectory(input.plugins, "vault-changed", "community plugin directory");
    if (transaction.targetState.kind === "existing") {
      try {
        await rename(transaction.targetPath, transaction.backupPath);
      } catch (error) {
        fail("target-changed", "existing plugin target could not be backed up", error);
      }
      transaction.backedUp = true;
      await assertCanonicalDirectory(input.obsidian, "vault-changed", "vault configuration");
      await assertCanonicalDirectory(input.plugins, "vault-changed", "community plugin directory");
      await assertReboundTarget(
        transaction.backupPath,
        transaction.targetState,
        "Transaction backup",
      );
    }
    await assertAbsent(transaction.targetPath, "target-changed", "publication target");
    await assertCanonicalDirectory(input.obsidian, "vault-changed", "vault configuration");
    await assertCanonicalDirectory(input.plugins, "vault-changed", "community plugin directory");
    try {
      await rename(transaction.stagePath, transaction.targetPath);
    } catch (error) {
      fail("target-changed", "complete acceptance stage could not be published", error);
    }
    transaction.published = true;
    await assertCanonicalDirectory(input.obsidian, "vault-changed", "vault configuration");
    await assertCanonicalDirectory(input.plugins, "vault-changed", "community plugin directory");

    const target = await snapshotExactDirectory(
      transaction.targetPath,
      transaction.stageNames,
      "Published real-vault acceptance target",
    );
    assertArtifactBytes(target, input.artifact, "Published real-vault plugin target");
    if (!sameExactSnapshot(stage, target)) {
      fail("target-changed", "published target was not the complete staged directory");
    }
    if (
      transaction.targetState.kind === "existing"
      && transaction.targetState.data !== null
      && !target.files.get(DATA_FILE)?.bytes.equals(transaction.targetState.data.bytes)
    ) fail("target-changed", "published opaque plugin data changed");
    await input.artifact.assertCurrent();
    await assertCommunityPluginState(input.community);

    transaction.stageTree = null;
    transaction.stageRoot = null;
    transaction.stageRootCreated = false;
    transaction.committed = true;

    if (transaction.backedUp) {
      try {
        const backup = await captureBoundExactTree(
          transaction.backupPath,
          transaction.targetState.names,
          transaction.targetState.snapshot,
          transaction.targetState.tree.root,
          "Final transaction backup",
        );
        await removeClaimedOwnedTree(backup.tree, "Final transaction backup");
        transaction.backedUp = false;
      } catch (error) {
        fail("cleanup-incomplete", "obsolete target backup cleanup was incomplete", error);
      }
    }

    try {
      await removeEmptyTransactionRoot(
        transaction,
        "Completed real-vault acceptance transaction",
      );
    } catch (error) {
      fail(
        "cleanup-incomplete",
        "completed real-vault acceptance transaction cleanup was incomplete",
        error,
      );
    }

    await assertCanonicalDirectory(input.obsidian, "vault-changed", "vault configuration");
    await assertCanonicalDirectory(input.plugins, "vault-changed", "community plugin directory");

    return Object.freeze({
      artifactBinding: input.artifact.artifactBinding,
      artifactSetDigest: input.artifact.artifactSetDigest,
      backupRetained: false,
      pluginVersion: input.artifact.pluginVersion,
      priorTarget: transaction.targetState.kind === "absent" ? "absent" : "replaced",
    });
  } catch (error) {
    failure = error;
  }

  if (transaction.committed) throw failure;
  const rollbackWasRequired = transaction.published || transaction.backedUp;
  try {
    if (rollbackWasRequired) await rollbackPublication(transaction);
    else await cleanupUnpublishedTransaction(transaction);
  } catch (cleanupError) {
    if (rollbackWasRequired && !transaction.restorationProven) {
      fail("rollback-incomplete", "published target could not be safely rolled back", cleanupError);
    }
    fail("cleanup-incomplete", "transaction cleanup was incomplete", cleanupError);
  }
  throw failure;
}

async function installRealVault(options, mode) {
  const checked = validateOptions(options, mode.authorizedAction);
  const vault = await requireCanonicalDirectory(checked.vaultPath, "authorized vault");
  const obsidian = await requireCanonicalDirectory(
    join(checked.vaultPath, ".obsidian"),
    "vault configuration",
  );
  const plugins = await requireCanonicalDirectory(
    join(checked.vaultPath, ".obsidian", "plugins"),
    "community plugin directory",
  );
  if (vault.dev !== obsidian.dev || obsidian.dev !== plugins.dev) {
    fail("vault-invalid", "authorized vault configuration must remain on one device");
  }
  const community = await readCommunityPluginState(checked.vaultPath);
  await assertObsidianStopped();
  let modeState;
  try {
    modeState = await mode.preflight?.(checked.repoRoot);
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    fail("artifact-invalid", "plugin artifact preflight failed", error);
  }
  try {
    return await withBrandedArtifactLock(checked.repoRoot, async (lease) => {
      let artifact;
      try {
        artifact = await mode.buildArtifact({ lease, modeState, repoRoot: checked.repoRoot });
      } catch (error) {
        if (trustedCategories.has(error)) throw error;
        fail("artifact-invalid", "authorized plugin artifact could not be built", error);
      }
      await artifact.assertCurrent();
      await assertCanonicalDirectory(obsidian, "vault-changed", "vault configuration");
      await assertCanonicalDirectory(plugins, "vault-changed", "community plugin directory");
      await assertCommunityPluginState(community);
      await assertObsidianStopped();
      await artifact.assertCurrent();

      try {
        return await withBrandedDestinationLock(
          {
            parent: obsidian,
            name: DESTINATION_LOCK,
            label: "Real-vault plugin installation lock",
          },
          async () => publishTarget({
            artifact,
            community,
            obsidian,
            plugins,
          }),
        );
      } catch (error) {
        if (trustedCategories.has(error)) throw error;
        if (destinationCleanupFailures.has(error)) {
          fail("cleanup-incomplete", "destination lock cleanup was incomplete", error);
        }
        if (isExisting(error) || (error instanceof Error && error.message.includes("already exists"))) {
          fail("concurrent-operation", "another destination operation is present", error);
        }
        fail("vault-changed", "destination lock could not be established", error);
      }
    });
  } catch (error) {
    if (trustedCategories.has(error)) throw error;
    if (artifactCleanupFailures.has(error) || destinationCleanupFailures.has(error)) {
      fail("cleanup-incomplete", "installer lock cleanup was incomplete", error);
    }
    fail("artifact-invalid", "plugin artifact lease failed", error);
  }
}

const acceptanceMode = Object.freeze({
  authorizedAction: AUTHORIZED_ACTION,
  async preflight(repoRoot) {
    return captureFrozenGitState(repoRoot);
  },
  async buildArtifact({ lease, modeState: git, repoRoot }) {
    await assertFrozenGitState(repoRoot, git);
    const built = await buildAcceptanceArtifactUnderLease({ lease });
    const frozen = await freezeBuiltArtifact(lease, built.target);
    const assertCurrent = async () => {
      await assertFrozenArtifact(lease, frozen);
      await assertFrozenGitState(repoRoot, git);
    };
    return Object.freeze({
      artifactBinding: frozen.contract.artifactBinding,
      artifactSetDigest: computeAcceptanceArtifactSetDigest(frozen.source),
      assertCurrent,
      names: ACCEPTANCE_FILES,
      pluginVersion: frozen.contract.pluginVersion,
      source: frozen.source,
      validateSnapshot: validateAcceptanceArtifactSnapshot,
    });
  },
});

const normalMode = Object.freeze({
  authorizedAction: NORMAL_AUTHORIZED_ACTION,
  async buildArtifact({ repoRoot }) {
    return buildFrozenNormalArtifact({ repoRoot });
  },
});

export async function installRealVaultAcceptance(options) {
  return installRealVault(options, acceptanceMode);
}

export async function installRealVaultNormal(options) {
  return installRealVault(options, normalMode);
}

Object.defineProperty(installRealVaultAcceptance, "extractFailureCategory", {
  configurable: false,
  enumerable: false,
  value(error) {
    return trustedCategories.get(error) ?? null;
  },
  writable: false,
});

Object.freeze(installRealVaultAcceptance);

Object.defineProperty(installRealVaultNormal, "extractFailureCategory", {
  configurable: false,
  enumerable: false,
  value(error) {
    return trustedCategories.get(error) ?? null;
  },
  writable: false,
});

Object.freeze(installRealVaultNormal);
