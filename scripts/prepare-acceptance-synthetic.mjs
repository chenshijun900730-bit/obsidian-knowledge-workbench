import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  ACCEPTANCE_REPORT_RELATIVE_PATH,
  INSTALLATION_RECEIPT_RELATIVE_PATH,
  PREPARATION_STATE_RELATIVE_PATH,
  SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH,
  createPreparationState,
  decodePreparationState,
  encodePreparationState,
} from "./acceptance-run-contract.mjs";
import {
  assertCleanGitState,
  captureCleanGitState,
} from "./git-worktree-state.mjs";
import {
  assertFrozenRegularFile,
  assertOwnedTree,
  readFrozenRegularFile,
  removeOwnedTreeBottomUp,
  snapshotOwnedTree,
  withExclusiveIdentityLock,
  writeExclusiveRegularFile,
} from "./safe-fs-core.mjs";
import { attestSyntheticAcceptanceVault } from "./synthetic-acceptance-vault.mjs";
import {
  SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
  SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
  generateAcceptanceFixture,
} from "./synthetic-note-fixture.mjs";
import {
  OBSIDIAN_CONFIG_DIRECTORY,
  TEST_VAULT_MARKER,
  TEST_VAULT_MARKER_FILE,
  resolveCanonicalWorktree,
} from "./synthetic-vault-install-core.mjs";

const PREPARATION_LOCK = ".read-only-acceptance-prepare.lock";
const VAULT_STAGE_PREFIX = ".read-only-acceptance-prepare-vault.stage-";
const STATE_STAGE_PREFIX = ".read-only-acceptance-prepare-state.stage-";
const RESERVED_PREFIXES = Object.freeze([
  "read-only-acceptance-",
  ".read-only-acceptance-",
]);
const BUILDER_LOCK = ".read-only-acceptance.lock";
const BUILDER_RESIDUE_PREFIXES = Object.freeze([
  ".read-only-acceptance.tmp-",
  ".read-only-acceptance.backup-",
  ".read-only-acceptance.quarantine-",
]);
const HOOK_NAMES = Object.freeze([
  "afterLockAcquired",
  "afterStageCreated",
  "afterStagePopulated",
  "afterStateStaged",
  "beforeVaultPublish",
  "afterVaultPublish",
  "beforeStatePublish",
  "afterStatePublish",
]);
const FAILURE_CATEGORIES = new Set([
  "invalid-invocation",
  "target-exists",
  "concurrent-operation",
  "fixture-invalid",
  "fixture-changed",
  "cleanup-incomplete",
]);
const POPULATION_BATCH_SIZE = 24;

class PreparationFailure extends Error {
  constructor(category, message, options = undefined) {
    super(`${category}: ${message}`, options);
    this.name = "PreparationFailure";
    this.category = category;
  }
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown preparation failure";
}

function nestedErrors(error) {
  if (error === null || typeof error !== "object") return [];
  const nested = [];
  if ("cause" in error) nested.push(error.cause);
  if (error instanceof AggregateError) nested.push(...error.errors);
  return nested;
}

function hasErrorCode(error, code, seen = new Set()) {
  if (error === null || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  try {
    if (error.code === code) return true;
  } catch {
    return false;
  }
  return nestedErrors(error).some((nested) => hasErrorCode(nested, code, seen));
}

function retainedCategory(error, seen = new Set()) {
  if (error === null || typeof error !== "object" || seen.has(error)) return null;
  seen.add(error);
  let category = error instanceof PreparationFailure && FAILURE_CATEGORIES.has(error.category)
    ? error.category
    : null;
  if (category === "cleanup-incomplete") return category;
  for (const nested of nestedErrors(error)) {
    const nestedCategory = retainedCategory(nested, seen);
    if (nestedCategory === "cleanup-incomplete") return nestedCategory;
    category ??= nestedCategory;
  }
  return category;
}

function normalizeFailure(error, fallbackCategory) {
  const retained = retainedCategory(error);
  if (retained !== null && error instanceof PreparationFailure) return error;
  return new PreparationFailure(retained ?? fallbackCategory, errorMessage(error), { cause: error });
}

function fail(category, error) {
  throw normalizeFailure(error, category);
}

function validateOptions(options) {
  try {
    if (
      typeof options !== "object"
      || options === null
      || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype
    ) {
      throw new PreparationFailure("invalid-invocation", "options must be a plain data object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(descriptors);
    if (
      !keys.includes("repoRoot")
      || keys.some((key) => typeof key !== "string" || (key !== "repoRoot" && key !== "hooks"))
    ) {
      throw new PreparationFailure("invalid-invocation", "options must contain only own repoRoot and hooks fields");
    }
    const repoRootDescriptor = descriptors.repoRoot;
    if (!("value" in repoRootDescriptor) || typeof repoRootDescriptor.value !== "string") {
      throw new PreparationFailure("invalid-invocation", "repoRoot must be an own string data property");
    }
    const hooksDescriptor = descriptors.hooks;
    const sourceHooks = hooksDescriptor === undefined ? {} : hooksDescriptor.value;
    if (
      hooksDescriptor !== undefined
      && (!("value" in hooksDescriptor)
        || typeof sourceHooks !== "object"
        || sourceHooks === null
        || Array.isArray(sourceHooks)
        || Object.getPrototypeOf(sourceHooks) !== Object.prototype)
    ) {
      throw new PreparationFailure("invalid-invocation", "hooks must be an own plain data object");
    }
    const hookDescriptors = Object.getOwnPropertyDescriptors(sourceHooks);
    const hooks = {};
    for (const key of Reflect.ownKeys(hookDescriptors)) {
      const descriptor = hookDescriptors[key];
      if (
        typeof key !== "string"
        || !HOOK_NAMES.includes(key)
        || !("value" in descriptor)
        || typeof descriptor.value !== "function"
      ) {
        throw new PreparationFailure("invalid-invocation", "hooks contain an unknown or invalid data property");
      }
      hooks[key] = descriptor.value;
    }
    return Object.freeze({ repoRoot: repoRootDescriptor.value, hooks: Object.freeze(hooks) });
  } catch (error) {
    if (error instanceof PreparationFailure) throw error;
    throw new PreparationFailure("invalid-invocation", "options could not be inspected safely", { cause: error });
  }
}

async function directorySnapshot(path, label) {
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
  const current = await directorySnapshot(snapshot.path, label);
  if (!sameIdentity(current, snapshot)) throw new Error(`${label} identity changed`);
}

async function assertAbsent(path, label) {
  try {
    await lstat(path, { bigint: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return;
    throw new Error(`${label} absence could not be proved`, { cause: error });
  }
  throw new Error(`${label} already exists`);
}

async function assertStateFile(snapshot, expectedBytes, expectedState, label) {
  await assertFrozenRegularFile(snapshot, label);
  if (!snapshot.bytes.equals(expectedBytes)) throw new Error(`${label} bytes changed`);
  const decoded = decodePreparationState(snapshot.bytes);
  if (
    decoded.runId !== expectedState.runId
    || decoded.commit !== expectedState.commit
    || decoded.syntheticNoteCount !== expectedState.syntheticNoteCount
    || decoded.syntheticTotalBytes !== expectedState.syntheticTotalBytes
    || decoded.corpusDigest !== expectedState.corpusDigest
  ) {
    throw new Error(`${label} does not match the exact preparation state`);
  }
}

async function guardedUnlink(snapshot, expectedBytes, expectedState, label) {
  await assertStateFile(snapshot, expectedBytes, expectedState, label);
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

function isReservedName(name) {
  return RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function assertDevNamespace(devRoot, allowedNames, initial) {
  const names = await readdir(devRoot);
  const fixedNames = new Set([
    basename(SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH),
    basename(PREPARATION_STATE_RELATIVE_PATH),
    basename(INSTALLATION_RECEIPT_RELATIVE_PATH),
    basename(ACCEPTANCE_REPORT_RELATIVE_PATH),
  ]);
  for (const name of names) {
    if (allowedNames.has(name)) continue;
    if (fixedNames.has(name)) {
      if (initial) {
        throw new PreparationFailure("target-exists", "a fixed acceptance run object already exists");
      }
      throw new Error("an unexpected fixed acceptance run object appeared");
    }
    if (isReservedName(name)) {
      if (initial) {
        throw new PreparationFailure("concurrent-operation", "reserved acceptance residue already exists");
      }
      throw new Error("reserved acceptance residue appeared during preparation");
    }
  }
}

async function assertBuilderNamespace(repoRoot, initial) {
  const distPath = join(repoRoot, "dist");
  let stat;
  try {
    stat = await lstat(distPath, { bigint: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    if (initial) {
      throw new PreparationFailure("concurrent-operation", "artifact directory is not a regular directory");
    }
    throw new Error("artifact directory changed during preparation");
  }
  for (const name of await readdir(distPath)) {
    if (name === BUILDER_LOCK || BUILDER_RESIDUE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      if (initial) {
        throw new PreparationFailure("concurrent-operation", "artifact builder residue already exists");
      }
      throw new Error("artifact builder residue appeared during preparation");
    }
  }
}

async function createOwnedDirectory(path, relativePath, transaction) {
  await mkdir(path, { mode: 0o700 });
  const snapshot = await directorySnapshot(path, `Synthetic fixture directory ${relativePath}`);
  if (snapshot.dev !== transaction.devRootSnapshot.dev) {
    throw new Error("Synthetic fixture directory must stay on the repository device");
  }
  transaction.createdEntries.set(relativePath, Object.freeze({
    type: "directory",
    dev: snapshot.dev,
    ino: snapshot.ino,
  }));
}

function retainCreatedFile(transaction, relativePath, snapshot) {
  transaction.createdEntries.set(relativePath, Object.freeze({
    type: "file",
    path: snapshot.path,
    evidence: snapshot.evidence,
  }));
}

function sameFileEvidence(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.sha256 === right.sha256;
}

async function populateFixture(transaction, fixture) {
  const stage = transaction.vaultStagePath;
  if (stage === null) throw new Error("Synthetic fixture stage is unavailable");
  transaction.vaultStageTree = null;

  const marker = Buffer.from(`${JSON.stringify(TEST_VAULT_MARKER, null, 2)}\n`, "utf8");
  const markerSnapshot = await writeExclusiveRegularFile(
    join(stage, TEST_VAULT_MARKER_FILE),
    marker,
    "Dedicated test-vault marker",
  );
  retainCreatedFile(transaction, TEST_VAULT_MARKER_FILE, markerSnapshot);

  const pluginsPath = join(OBSIDIAN_CONFIG_DIRECTORY, "plugins");
  const communityPluginsPath = join(OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json");
  await createOwnedDirectory(
    join(stage, OBSIDIAN_CONFIG_DIRECTORY),
    OBSIDIAN_CONFIG_DIRECTORY,
    transaction,
  );
  await createOwnedDirectory(join(stage, pluginsPath), pluginsPath, transaction);
  const communityPluginsSnapshot = await writeExclusiveRegularFile(
    join(stage, communityPluginsPath),
    Buffer.from("[]\n", "utf8"),
    "Prepared community-plugins.json",
  );
  retainCreatedFile(transaction, communityPluginsPath, communityPluginsSnapshot);
  await createOwnedDirectory(join(stage, "Generated"), "Generated", transaction);

  for (let offset = 0; offset < fixture.notes.length; offset += POPULATION_BATCH_SIZE) {
    const batch = fixture.notes.slice(offset, offset + POPULATION_BATCH_SIZE);
    const settlements = await Promise.allSettled(batch.map(async (note) => {
      const relativeDirectory = dirname(note.path);
      await createOwnedDirectory(join(stage, relativeDirectory), relativeDirectory, transaction);
      const noteSnapshot = await writeExclusiveRegularFile(
        join(stage, note.path),
        Buffer.from(note.content, "utf8"),
        `Synthetic note ${note.path}`,
      );
      retainCreatedFile(transaction, note.path, noteSnapshot);
    }));
    const failures = settlements
      .filter((settlement) => settlement.status === "rejected")
      .map((settlement) => settlement.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Synthetic fixture population batch failed");
    }
  }
}

function hookContext(transaction) {
  return Object.freeze({
    repoRoot: transaction.repoRoot,
    devRoot: transaction.devRoot,
    lockPath: transaction.lockPath,
    vaultStagePath: transaction.vaultStagePath,
    stateStagePath: transaction.stateStagePath,
    vaultPath: transaction.vaultPath,
    statePath: transaction.statePath,
    runId: transaction.runId,
    commit: transaction.commit,
  });
}

function allowedDevNames(transaction) {
  const names = new Set([PREPARATION_LOCK]);
  if (transaction.vaultStagePath !== null) names.add(basename(transaction.vaultStagePath));
  if (transaction.stateStagePath !== null) names.add(basename(transaction.stateStagePath));
  if (transaction.vaultPublished) names.add(basename(transaction.vaultPath));
  if (transaction.statePublished) names.add(basename(transaction.statePath));
  return names;
}

async function assertCurrentTransaction(transaction) {
  await assertLockBoundary(transaction);
  if (transaction.commit !== null) {
    await assertCleanGitState(transaction.repoRoot, transaction.commit);
  }
  await assertDevNamespace(transaction.devRoot, allowedDevNames(transaction), false);
  await assertBuilderNamespace(transaction.repoRoot, false);
  await assertAbsent(transaction.receiptPath, "Installation receipt");
  await assertAbsent(transaction.reportPath, "Acceptance report");

  if (transaction.vaultPublished) {
    if (transaction.publishedVaultTree === null) throw new Error("Published vault proof is unavailable");
    await assertOwnedTree(transaction.publishedVaultTree, "Published synthetic acceptance vault");
    if (transaction.retiredVaultStagePath !== null) {
      await assertAbsent(transaction.retiredVaultStagePath, "Retired vault stage");
    }
  } else {
    await assertAbsent(transaction.vaultPath, "Fixed synthetic acceptance vault");
    if (transaction.vaultStagePath !== null && transaction.vaultStageTree !== null) {
      await assertOwnedTree(transaction.vaultStageTree, "Synthetic acceptance vault stage");
    }
  }

  if (transaction.statePublished) {
    if (transaction.publishedStateSnapshot === null) throw new Error("Published state proof is unavailable");
    await assertStateFile(
      transaction.publishedStateSnapshot,
      transaction.stateBytes,
      transaction.state,
      "Published preparation state",
    );
    if (transaction.retiredStateStagePath !== null) {
      await assertAbsent(transaction.retiredStateStagePath, "Retired state stage");
    }
  } else {
    await assertAbsent(transaction.statePath, "Fixed preparation state");
    if (transaction.stateStageSnapshot !== null) {
      await assertStateFile(
        transaction.stateStageSnapshot,
        transaction.stateBytes,
        transaction.state,
        "Preparation state stage",
      );
    }
  }
}

async function assertLockBoundary(transaction) {
  await assertDirectorySnapshot(transaction.repoRootSnapshot, "Repository root");
  await assertDirectorySnapshot(transaction.devRootSnapshot, ".dev-vault");
  await assertFrozenRegularFile(transaction.lockSnapshot, "Synthetic acceptance preparation lock");
}

async function invokeHook(transaction, name) {
  const hook = transaction.hooks[name];
  if (hook === undefined) return;
  await hook(hookContext(transaction));
  await assertCurrentTransaction(transaction);
}

async function partialStageTree(transaction) {
  if (transaction.vaultStagePath === null) return null;
  if (transaction.vaultStageRoot === null) {
    throw new Error("Synthetic acceptance vault stage ownership proof is unavailable");
  }
  await assertDirectorySnapshot(transaction.vaultStageRoot, "Synthetic acceptance vault stage root");
  const tree = await snapshotOwnedTree(
    transaction.vaultStagePath,
    [...transaction.createdEntries.keys()],
    "Partial synthetic acceptance vault stage",
  );
  for (const [relativePath, retained] of transaction.createdEntries) {
    const current = tree.entries.get(relativePath);
    if (retained.type === "directory") {
      if (
        current?.type !== "directory"
        || current.dev !== retained.dev
        || current.ino !== retained.ino
      ) {
        throw new Error(`Partial synthetic acceptance directory ${relativePath} identity changed`);
      }
      continue;
    }
    await assertFrozenRegularFile(retained, `Partial synthetic acceptance file ${relativePath}`);
    if (current?.type !== "file" || !sameFileEvidence(current, retained.evidence)) {
      throw new Error(`Partial synthetic acceptance file ${relativePath} identity changed`);
    }
  }
  return tree;
}

async function provePublishedVault(transaction) {
  if (transaction.publishedVaultTree !== null) {
    await assertOwnedTree(transaction.publishedVaultTree, "Published synthetic acceptance vault");
    return transaction.publishedVaultTree;
  }
  throw new Error("Published vault ownership continuity was not proved");
}

async function provePublishedState(transaction) {
  let snapshot = transaction.publishedStateSnapshot;
  if (snapshot === null) throw new Error("Published state ownership continuity was not proved");
  await assertStateFile(snapshot, transaction.stateBytes, transaction.state, "Published preparation state");
  return snapshot;
}

async function rollbackTransaction(transaction) {
  await assertDirectorySnapshot(transaction.repoRootSnapshot, "Repository root during cleanup");
  await assertDirectorySnapshot(transaction.devRootSnapshot, ".dev-vault during cleanup");
  await assertFrozenRegularFile(transaction.lockSnapshot, "Synthetic acceptance preparation lock");

  let stateSnapshot = null;
  let stateLabel = null;
  if (transaction.statePublished) {
    stateSnapshot = await provePublishedState(transaction);
    stateLabel = "Published preparation state";
  } else if (transaction.stateStagePath !== null) {
    if (transaction.stateStageSnapshot === null) throw new Error("Preparation state stage proof is unavailable");
    await assertStateFile(
      transaction.stateStageSnapshot,
      transaction.stateBytes,
      transaction.state,
      "Preparation state stage",
    );
    stateSnapshot = transaction.stateStageSnapshot;
    stateLabel = "Preparation state stage";
  }

  let vaultTree = null;
  let vaultLabel = null;
  if (transaction.vaultPublished) {
    vaultTree = await provePublishedVault(transaction);
    vaultLabel = "Published synthetic acceptance vault";
  } else if (transaction.vaultStagePath !== null) {
    if (transaction.vaultStageTree !== null) {
      await assertOwnedTree(transaction.vaultStageTree, "Synthetic acceptance vault stage");
      vaultTree = transaction.vaultStageTree;
    } else {
      vaultTree = await partialStageTree(transaction);
    }
    vaultLabel = "Synthetic acceptance vault stage";
  }

  if (stateSnapshot !== null) {
    await guardedUnlink(
      stateSnapshot,
      transaction.stateBytes,
      transaction.state,
      stateLabel,
    );
    transaction.statePublished = false;
    transaction.stateStagePath = null;
    transaction.stateStageSnapshot = null;
  }
  if (vaultTree !== null) {
    await removeOwnedTreeBottomUp(vaultTree, vaultLabel);
    transaction.vaultPublished = false;
    transaction.vaultStagePath = null;
    transaction.vaultStageTree = null;
  }
}

async function executeLockedPreparation(transaction) {
  let failure = null;
  try {
    const afterLockAcquired = transaction.hooks.afterLockAcquired;
    if (afterLockAcquired !== undefined) await afterLockAcquired(hookContext(transaction));
    await assertLockBoundary(transaction);
    await assertDevNamespace(transaction.devRoot, new Set([PREPARATION_LOCK]), true);
    await assertBuilderNamespace(transaction.repoRoot, true);

    let gitState;
    try {
      gitState = await captureCleanGitState(transaction.repoRoot);
    } catch (error) {
      fail("concurrent-operation", error);
    }
    transaction.commit = gitState.commit;
    transaction.runId = randomUUID().toLowerCase();

    const fixture = generateAcceptanceFixture();
    if (
      fixture.noteCount !== SYNTHETIC_ACCEPTANCE_NOTE_COUNT
      || fixture.totalBytes !== SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES
    ) {
      throw new PreparationFailure("fixture-invalid", "fixed fixture aggregate contract changed");
    }

    transaction.vaultStagePath = await mkdtemp(join(transaction.devRoot, VAULT_STAGE_PREFIX));
    transaction.vaultStageRoot = await directorySnapshot(
      transaction.vaultStagePath,
      "Synthetic acceptance vault stage",
    );
    await chmod(transaction.vaultStagePath, 0o700);
    await assertDirectorySnapshot(transaction.vaultStageRoot, "Synthetic acceptance vault stage");
    if (transaction.vaultStageRoot.dev !== transaction.devRootSnapshot.dev) {
      throw new Error("Synthetic acceptance vault stage must stay on the repository device");
    }
    transaction.vaultStageTree = await snapshotOwnedTree(
      transaction.vaultStagePath,
      [],
      "Empty synthetic acceptance vault stage",
    );
    await invokeHook(transaction, "afterStageCreated");

    await populateFixture(transaction, fixture);
    let stagedAttestation;
    try {
      stagedAttestation = await attestSyntheticAcceptanceVault({
        vaultPath: transaction.vaultStagePath,
        phase: "prepared",
      });
    } catch (error) {
      fail("fixture-invalid", error);
    }
    transaction.vaultStageTree = stagedAttestation.tree;
    await invokeHook(transaction, "afterStagePopulated");

    transaction.state = createPreparationState({
      runId: transaction.runId,
      commit: transaction.commit,
      attestation: stagedAttestation,
    });
    transaction.stateBytes = encodePreparationState(transaction.state);
    transaction.stateStagePath = join(
      transaction.devRoot,
      `${STATE_STAGE_PREFIX}${process.pid}-${randomUUID()}`,
    );
    transaction.stateStageSnapshot = await writeExclusiveRegularFile(
      transaction.stateStagePath,
      transaction.stateBytes,
      "Preparation state stage",
    );
    if (transaction.stateStageSnapshot.evidence.dev !== transaction.devRootSnapshot.dev) {
      throw new Error("Preparation state stage must stay on the repository device");
    }
    await assertStateFile(
      transaction.stateStageSnapshot,
      transaction.stateBytes,
      transaction.state,
      "Preparation state stage",
    );
    await invokeHook(transaction, "afterStateStaged");

    await invokeHook(transaction, "beforeVaultPublish");
    await assertCurrentTransaction(transaction);
    const vaultStagePath = transaction.vaultStagePath;
    if (vaultStagePath === null) throw new Error("Synthetic acceptance vault stage disappeared");
    await rename(vaultStagePath, transaction.vaultPath);
    transaction.retiredVaultStagePath = vaultStagePath;
    transaction.vaultStagePath = null;
    transaction.vaultStageTree = null;
    transaction.vaultPublished = true;
    const publishedAttestation = await attestSyntheticAcceptanceVault({
      vaultPath: transaction.vaultPath,
      phase: "prepared",
      expected: stagedAttestation,
    });
    if (!sameIdentity(publishedAttestation.tree.root, stagedAttestation.tree.root)) {
      throw new Error("Published vault root identity does not match the renamed stage");
    }
    transaction.publishedVaultTree = publishedAttestation.tree;
    await invokeHook(transaction, "afterVaultPublish");

    await invokeHook(transaction, "beforeStatePublish");
    await assertCurrentTransaction(transaction);
    const stateStagePath = transaction.stateStagePath;
    if (stateStagePath === null) throw new Error("Preparation state stage disappeared");
    const stateStageSnapshot = transaction.stateStageSnapshot;
    if (stateStageSnapshot === null) throw new Error("Preparation state stage proof disappeared");
    await rename(stateStagePath, transaction.statePath);
    transaction.retiredStateStagePath = stateStagePath;
    transaction.stateStagePath = null;
    transaction.stateStageSnapshot = null;
    transaction.statePublished = true;
    const publishedStateSnapshot = await readFrozenRegularFile(
      transaction.statePath,
      "Published preparation state",
    );
    if (!sameFileEvidence(publishedStateSnapshot.evidence, stateStageSnapshot.evidence)) {
      throw new Error("Published state identity does not match the renamed stage");
    }
    transaction.publishedStateSnapshot = publishedStateSnapshot;
    await assertStateFile(
      transaction.publishedStateSnapshot,
      transaction.stateBytes,
      transaction.state,
      "Published preparation state",
    );
    await invokeHook(transaction, "afterStatePublish");
    await assertCurrentTransaction(transaction);

    return Object.freeze({
      runId: transaction.runId,
      commit: transaction.commit,
      syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
      syntheticTotalBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    });
  } catch (error) {
    failure = error;
  }

  try {
    await rollbackTransaction(transaction);
  } catch (cleanupError) {
    throw new PreparationFailure(
      "cleanup-incomplete",
      `cleanup-incomplete: ${errorMessage(cleanupError)}`,
      { cause: new AggregateError([failure, cleanupError], "Preparation cleanup was incomplete") },
    );
  }
  throw normalizeFailure(failure, "fixture-changed");
}

export async function prepareSyntheticAcceptance(options) {
  const checked = validateOptions(options);
  let resolved;
  try {
    resolved = await resolveCanonicalWorktree(checked.repoRoot);
  } catch (error) {
    throw normalizeFailure(error, "fixture-invalid");
  }
  const repoRootSnapshot = await directorySnapshot(resolved.repoRoot, "Repository root");
  if (repoRootSnapshot.dev !== resolved.devRootSnapshot.dev) {
    throw new PreparationFailure("fixture-invalid", "repository root and .dev-vault must share one device");
  }

  const lockPath = join(resolved.devRoot, PREPARATION_LOCK);
  let result;
  let lockCallbackEntered = false;
  try {
    result = await withExclusiveIdentityLock(
      {
        parent: resolved.devRootSnapshot,
        name: PREPARATION_LOCK,
        label: "Synthetic acceptance preparation lock",
      },
      async () => {
        lockCallbackEntered = true;
        const lockSnapshot = await readFrozenRegularFile(
          lockPath,
          "Synthetic acceptance preparation lock",
        );
        const transaction = {
          hooks: checked.hooks,
          repoRoot: resolved.repoRoot,
          devRoot: resolved.devRoot,
          repoRootSnapshot,
          devRootSnapshot: resolved.devRootSnapshot,
          lockPath,
          lockSnapshot,
          vaultPath: join(resolved.repoRoot, SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH),
          statePath: join(resolved.repoRoot, PREPARATION_STATE_RELATIVE_PATH),
          receiptPath: join(resolved.repoRoot, INSTALLATION_RECEIPT_RELATIVE_PATH),
          reportPath: join(resolved.repoRoot, ACCEPTANCE_REPORT_RELATIVE_PATH),
          runId: null,
          commit: null,
          vaultStagePath: null,
          vaultStageRoot: null,
          vaultStageTree: null,
          retiredVaultStagePath: null,
          createdEntries: new Map(),
          vaultPublished: false,
          publishedVaultTree: null,
          state: null,
          stateBytes: null,
          stateStagePath: null,
          stateStageSnapshot: null,
          retiredStateStagePath: null,
          statePublished: false,
          publishedStateSnapshot: null,
        };
        return executeLockedPreparation(transaction);
      },
    );
  } catch (error) {
    if (!lockCallbackEntered && hasErrorCode(error, "EEXIST")) {
      throw normalizeFailure(error, "concurrent-operation");
    }
    try {
      await assertDirectorySnapshot(resolved.devRootSnapshot, ".dev-vault after lock failure");
      await assertAbsent(lockPath, "Synthetic acceptance preparation lock after failure");
    } catch (lockCleanupError) {
      throw new PreparationFailure(
        "cleanup-incomplete",
        `preparation lock cleanup could not be proved: ${errorMessage(lockCleanupError)}`,
        { cause: new AggregateError([error, lockCleanupError], "Preparation lock cleanup was incomplete") },
      );
    }
    throw normalizeFailure(error, "fixture-changed");
  }
  try {
    await assertDirectorySnapshot(repoRootSnapshot, "Repository root after preparation");
    await assertDirectorySnapshot(resolved.devRootSnapshot, ".dev-vault after preparation");
    await assertAbsent(lockPath, "Synthetic acceptance preparation lock");
  } catch (error) {
    throw normalizeFailure(error, "cleanup-incomplete");
  }
  return result;
}
