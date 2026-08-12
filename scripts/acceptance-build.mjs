import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ACCEPTANCE_PLUGIN_NAME,
  NORMAL_PLUGIN_NAME,
  PLUGIN_ID,
  buildBundle,
} from "../esbuild.config.mjs";
import { isStrictBoundedSemver } from "../src/runtime/strict-semver.mjs";
import {
  ACCEPTANCE_FILES,
  acceptanceMetadata,
  validateAcceptanceArtifactSnapshot,
} from "./acceptance-artifact-contract.mjs";
import {
  assertExactDirectory,
  assertFrozenRegularFile,
  readFrozenRegularFile,
  removeOwnedTreeBottomUp,
  snapshotExactDirectory,
  writeExclusiveRegularFile,
} from "./safe-fs-core.mjs";

export { ACCEPTANCE_FILES, acceptanceMetadata } from "./acceptance-artifact-contract.mjs";

const LOCK_FILE = ".read-only-acceptance.lock";
const TARGET_DIRECTORY = "read-only-acceptance";
const STAGE_PREFIX = ".read-only-acceptance.tmp-";
const BACKUP_PREFIX = ".read-only-acceptance.backup-";
const QUARANTINE_PREFIX = ".read-only-acceptance.quarantine-";
const ALLOWED_HOOKS = Object.freeze([
  "afterStageCreate",
  "beforeBundle",
  "afterStageValidation",
  "afterBackup",
  "afterPublish",
]);
const DENIED_INPUTS = new Set([
  "src/main.ts",
  "src/adapters/obsidian-quick-capture-adapter.ts",
  "src/ui/quick-capture-modal.ts",
  "src/adapters/obsidian-ai-client.ts",
  "src/ui/ai-payload-preview-modal.ts",
]);
const acceptanceArtifactLeases = new WeakMap();
const NO_FAILURE = Symbol("acceptance build no failure");
const isMissing = (error) => error !== null && typeof error === "object" && error.code === "ENOENT";
const isExisting = (error) => error !== null && typeof error === "object" && error.code === "EEXIST";
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

async function optionalStat(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function requireDirectory(path, label) {
  const stat = await optionalStat(path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return stat;
}

async function readRegularFile(path, label) {
  return readFrozenRegularFile(path, label);
}

async function assertFileSnapshot(path, snapshot, label) {
  await assertFrozenRegularFile(Object.freeze({ ...snapshot, path }), label);
}

async function writeExclusive(path, bytes, label) {
  return writeExclusiveRegularFile(path, Buffer.from(bytes), label);
}

async function snapshotDirectory(path, expectedFiles, label) {
  const snapshot = await snapshotExactDirectory(path, expectedFiles, label);
  for (const [name, file] of snapshot.files) {
    if (file.evidence.size === 0n) throw new Error(`${label} file ${name} must be nonempty`);
  }
  return {
    path: snapshot.path,
    directory: Object.freeze({ path: snapshot.path, dev: snapshot.dev, ino: snapshot.ino }),
    names: snapshot.names,
    files: snapshot.files,
  };
}

async function assertDirectorySnapshot(path, snapshot, label) {
  await assertExactDirectory(Object.freeze({
    path,
    dev: snapshot.directory.dev,
    ino: snapshot.directory.ino,
    names: snapshot.names,
    files: snapshot.files,
  }), label);
}

async function snapshotEmptyDirectory(path, label) {
  return snapshotDirectory(path, [], label);
}

async function assertDirectoryIdentity(path, expected, label) {
  const stat = await requireDirectory(path, label);
  if (!sameIdentity(identity(stat), expected)) throw new Error(`${label} identity changed`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must remain canonical`);
}

async function assertAbsent(path, label) {
  if (await optionalStat(path) !== null) throw new Error(`${label} must remain absent`);
}

function parseObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must decode to an object`);
  }
  return value;
}

function validateCurrentArtifactDocuments(snapshot, preflight) {
  const validated = validateAcceptanceArtifactSnapshot(snapshot);
  const manifestFile = snapshot.files.get("manifest.json");
  const expectedManifestBytes = Buffer.from(
    `${JSON.stringify({ ...preflight.manifest, name: ACCEPTANCE_PLUGIN_NAME }, null, 2)}\n`,
  );
  if (manifestFile === undefined || !manifestFile.bytes.equals(expectedManifestBytes)) {
    throw new Error("Acceptance manifest may differ from the normal manifest only by its display name");
  }
  if (validated.pluginVersion !== preflight.version) {
    throw new Error("Acceptance manifest and normal source versions must be coherent");
  }
  return validated;
}

function validateExistingArtifactDocuments(snapshot) {
  return validateAcceptanceArtifactSnapshot(snapshot);
}

async function snapshotCurrentArtifactDirectory(path, preflight, label, { requireCurrentStyles = false } = {}) {
  const snapshot = await snapshotDirectory(path, ACCEPTANCE_FILES, label);
  const decoded = validateCurrentArtifactDocuments(snapshot, preflight);
  const styles = snapshot.files.get("styles.css");
  const sourceStyles = preflight.sources.get("styles");
  if (requireCurrentStyles && (
    styles === undefined
    || sourceStyles === undefined
    || styles.evidence.size !== sourceStyles.evidence.size
    || styles.evidence.sha256 !== sourceStyles.evidence.sha256
  )) {
    throw new Error(`${label} styles must exactly match the normal root styles`);
  }
  return { ...snapshot, decoded };
}

async function snapshotExistingArtifactDirectory(path, label) {
  const snapshot = await snapshotDirectory(path, ACCEPTANCE_FILES, label);
  return { ...snapshot, decoded: validateExistingArtifactDocuments(snapshot) };
}

function requireBundleOutput(result, outfile, label) {
  if (!Array.isArray(result.outputFiles) || result.outputFiles.length !== 1) {
    throw new Error(`${label} must return exactly one in-memory output file`);
  }
  const [output] = result.outputFiles;
  if (
    output === undefined
    || typeof output.path !== "string"
    || resolve(output.path) !== resolve(outfile)
    || !(output.contents instanceof Uint8Array)
    || output.contents.byteLength === 0
  ) {
    throw new Error(`${label} returned an unexpected in-memory output`);
  }
  return Buffer.from(output.contents);
}

async function snapshotMetafileInputs(repoRoot, result) {
  if (result.metafile === undefined) throw new Error("Acceptance bundle must return an esbuild metafile");
  const snapshots = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = isAbsolute(input) ? resolve(input) : resolve(input);
    let canonical;
    try {
      canonical = await realpath(path);
    } catch (error) {
      throw new Error(`Acceptance metafile input is unavailable: ${input}`, { cause: error });
    }
    if (!inside(repoRoot, canonical)) throw new Error(`Acceptance metafile input escaped the repository: ${input}`);
    const relativeInput = relative(repoRoot, canonical).split(sep).join("/");
    if (DENIED_INPUTS.has(relativeInput)) throw new Error(`Acceptance metafile includes forbidden input ${relativeInput}`);
    if (snapshots.has(canonical)) throw new Error(`Acceptance metafile contains duplicate canonical input ${relativeInput}`);
    const snapshot = await readRegularFile(canonical, `Acceptance metafile input ${relativeInput}`);
    snapshots.set(canonical, { ...snapshot, path: canonical, relative: relativeInput });
  }
  if (snapshots.size === 0) throw new Error("Acceptance metafile must contain at least one input");
  return snapshots;
}

async function assertInputSnapshots(snapshots) {
  for (const snapshot of snapshots.values()) {
    await assertFileSnapshot(snapshot.path, snapshot, `Acceptance metafile input ${snapshot.relative}`);
  }
}

async function assertMetafileInputSet(repoRoot, result, snapshots) {
  const current = await snapshotMetafileInputs(repoRoot, result);
  const expectedPaths = [...snapshots.keys()].sort();
  const currentPaths = [...current.keys()].sort();
  if (!isDeepStrictEqual(currentPaths, expectedPaths)) {
    throw new Error("Acceptance metafile input set changed between discovery and bundle");
  }
  for (const path of expectedPaths) {
    const expected = snapshots.get(path);
    const actual = current.get(path);
    if (
      expected === undefined
      || actual === undefined
      || !sameIdentity(expected.evidence, actual.evidence)
      || expected.evidence.size !== actual.evidence.size
      || expected.evidence.sha256 !== actual.evidence.sha256
    ) {
      throw new Error(`Acceptance metafile input ${expected?.relative ?? path} snapshot changed`);
    }
  }
}

function validateHooks(hooks) {
  if (hooks === undefined) return Object.freeze({});
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("Acceptance build hooks must be an object");
  }
  for (const [name, hook] of Object.entries(hooks)) {
    if (!ALLOWED_HOOKS.includes(name) || typeof hook !== "function") {
      throw new Error(`Unknown acceptance build hook: ${name}`);
    }
  }
  return hooks;
}

async function runHook(name, hooks, context, revalidate) {
  let hookFailure = NO_FAILURE;
  try {
    await hooks[name]?.(Object.freeze({ ...context }));
  } catch (error) {
    hookFailure = error;
  }
  let validationFailure = NO_FAILURE;
  try {
    await revalidate();
  } catch (error) {
    validationFailure = error;
  }
  if (hookFailure !== NO_FAILURE && validationFailure !== NO_FAILURE) {
    throw new AggregateError(
      [hookFailure, validationFailure],
      `${name} hook failed: ${errorMessage(hookFailure)}; snapshot changed: ${errorMessage(validationFailure)}`,
    );
  }
  if (validationFailure !== NO_FAILURE) throw validationFailure;
  if (hookFailure !== NO_FAILURE) throw hookFailure;
}

async function preflightRepository(repoRoot) {
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot)) throw new Error("Repository root must be absolute");
  const root = resolve(repoRoot);
  if (root !== repoRoot) throw new Error("Repository root must be canonical");
  const rootStat = await requireDirectory(root, "Repository root");
  if (await realpath(root) !== root) throw new Error("Repository root must be canonical and not a symlink");
  const requiredPaths = {
    packageJson: join(root, "package.json"),
    manifest: join(root, "manifest.json"),
    styles: join(root, "styles.css"),
    entry: join(root, "src", "main-acceptance.ts"),
  };
  const sources = new Map();
  for (const [name, path] of Object.entries(requiredPaths)) {
    sources.set(name, await readRegularFile(path, `Required source ${path}`));
  }
  const manifest = parseObject(sources.get("manifest").bytes, "Normal manifest");
  const packageJson = parseObject(sources.get("packageJson").bytes, "package.json");
  if (manifest.id !== PLUGIN_ID || manifest.name !== NORMAL_PLUGIN_NAME) {
    throw new Error("Normal manifest identity must be exactly Knowledge Workbench");
  }
  if (!isStrictBoundedSemver(manifest.version)) throw new Error("Normal manifest version must be a bounded semantic version");
  if (packageJson.version !== manifest.version) throw new Error("Package and manifest versions must be coherent");
  return { root, rootIdentity: identity(rootStat), manifest, version: manifest.version, requiredPaths, sources };
}

async function assertSourceSnapshots(preflight) {
  await assertDirectoryIdentity(preflight.root, preflight.rootIdentity, "Repository root");
  for (const [name, path] of Object.entries(preflight.requiredPaths)) {
    await assertFileSnapshot(path, preflight.sources.get(name), `Required source ${path}`);
  }
}

async function prepareDist(preflight) {
  const path = join(preflight.root, "dist");
  let stat = await optionalStat(path);
  if (stat === null) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
    stat = await requireDirectory(path, "dist directory");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("dist must be a canonical non-symlink directory");
  if (await realpath(path) !== path) throw new Error("dist must be a canonical non-symlink directory");
  if (stat.dev !== preflight.rootIdentity.dev) throw new Error("dist must be on the same device as the repository");
  return { path, identity: identity(stat) };
}

async function acquireLock(dist) {
  const path = join(dist.path, LOCK_FILE);
  const token = randomUUID();
  let snapshot;
  try {
    snapshot = await writeExclusive(
      path,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`,
      "Acceptance build lock",
    );
  } catch (error) {
    if (isExisting(error.cause)) {
      throw new Error("Acceptance build lock already exists; stale and concurrent locks are never stolen", { cause: error });
    }
    throw error;
  }
  return { path, snapshot };
}

async function assertNoRetainedArtifactResidue(dist, lock) {
  await assertDistAndLock(dist, lock);
  const retained = (await readdir(dist.path)).filter((name) => (
    name.startsWith(STAGE_PREFIX)
    || name.startsWith(BACKUP_PREFIX)
    || name.startsWith(QUARANTINE_PREFIX)
  ));
  await assertDistAndLock(dist, lock);
  if (retained.length !== 0) {
    throw new Error("Acceptance artifact retained stage, backup, or quarantine residue is a hard stop");
  }
}

async function safeDeleteFile(path, snapshot, label) {
  const stat = await optionalStat(path);
  if (stat === null) return true;
  await assertFileSnapshot(path, snapshot, label);
  await unlink(path);
  return true;
}

async function safeDeleteDirectory(path, snapshot, label) {
  const stat = await optionalStat(path);
  if (stat === null) return true;
  const entries = new Map();
  for (const name of snapshot.names) {
    const file = snapshot.files.get(name);
    if (file === undefined) throw new Error(`${label} lost the owned snapshot for ${name}`);
    entries.set(name, Object.freeze({ type: "file", ...file.evidence }));
  }
  await removeOwnedTreeBottomUp(Object.freeze({
    root: Object.freeze({ ...snapshot.directory, path }),
    entries,
  }), label);
  if (await optionalStat(path) !== null) throw new Error(`${label} cleanup did not leave the directory absent`);
  return true;
}

async function assertDistAndLock(dist, lock) {
  await assertDirectoryIdentity(dist.path, dist.identity, "dist directory");
  await assertFileSnapshot(lock.path, lock.snapshot, "Acceptance build lock");
}

async function assertLeaseRecord(record) {
  if (!record.active) throw new Error("Acceptance artifact lease is expired or inactive");
  await assertDirectoryIdentity(
    record.lockSnapshot.root.path,
    record.lockSnapshot.root,
    "Repository root",
  );
  await assertDistAndLock(record.lockSnapshot.dist, record.lockSnapshot.lock);
}

async function requireActiveLease(lease) {
  if (typeof lease !== "object" || lease === null) {
    throw new Error("Acceptance artifact lease is forged or inactive");
  }
  const record = acceptanceArtifactLeases.get(lease);
  if (record === undefined || !record.active) {
    throw new Error("Acceptance artifact lease is forged, expired, or inactive");
  }
  await assertLeaseRecord(record);
  return record;
}

function exactOptions(options, allowed, label) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error(`${label} options must be an object`);
  }
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) throw new Error(`Unknown ${label} option: ${name}`);
  }
  return options;
}

function readonlyArtifactFiles(files) {
  const copied = new Map();
  for (const name of ACCEPTANCE_FILES) {
    const file = files.get(name);
    if (file === undefined) throw new Error(`Acceptance artifact snapshot lost ${name}`);
    const privateBytes = Buffer.from(file.bytes);
    copied.set(name, Object.freeze({
      path: file.path,
      get bytes() { return Buffer.from(privateBytes); },
      evidence: Object.freeze({ ...file.evidence }),
    }));
  }
  const readonly = {
    get size() { return copied.size; },
    get: (name) => copied.get(name),
    has: (name) => copied.has(name),
    entries: () => copied.entries(),
    keys: () => copied.keys(),
    values: () => copied.values(),
    forEach: (callback, thisArg) => copied.forEach((value, key) => callback.call(thisArg, value, key, readonly)),
    [Symbol.iterator]: () => copied[Symbol.iterator](),
  };
  return Object.freeze(readonly);
}

function copyOutArtifactSnapshot(snapshot) {
  return Object.freeze({
    directory: Object.freeze({ ...snapshot.directory }),
    names: ACCEPTANCE_FILES,
    files: readonlyArtifactFiles(snapshot.files),
  });
}

export async function withAcceptanceArtifactLock(repoRoot, callback) {
  if (typeof callback !== "function") throw new Error("Acceptance artifact lock callback must be a function");
  const preflight = await preflightRepository(repoRoot);
  const dist = await prepareDist(preflight);
  const lock = await acquireLock(dist);
  const lease = Object.freeze({});
  const record = {
    repoRoot: preflight.root,
    active: true,
    lockSnapshot: Object.freeze({
      root: Object.freeze({ path: preflight.root, ...preflight.rootIdentity }),
      dist,
      lock,
    }),
  };
  acceptanceArtifactLeases.set(lease, record);

  let result;
  let callbackFailure = NO_FAILURE;
  try {
    await assertLeaseRecord(record);
    await assertNoRetainedArtifactResidue(dist, lock);
    result = await callback(lease);
  } catch (error) {
    callbackFailure = error;
  }

  record.active = false;
  let cleanupFailure = NO_FAILURE;
  try {
    await assertDistAndLock(dist, lock);
    await safeDeleteFile(lock.path, lock.snapshot, "Acceptance build lock");
  } catch (error) {
    cleanupFailure = error;
  }
  if (cleanupFailure !== NO_FAILURE) {
    const failures = callbackFailure === NO_FAILURE
      ? [cleanupFailure]
      : [callbackFailure, cleanupFailure];
    throw new AggregateError(failures, "Acceptance artifact lease cleanup was incomplete; the lock path was retained");
  }
  if (callbackFailure !== NO_FAILURE) throw callbackFailure;
  return result;
}

export async function loadAcceptanceArtifactSource(options) {
  const checked = exactOptions(options, ["lease"], "acceptance artifact source");
  const record = await requireActiveLease(checked.lease);
  const target = join(record.repoRoot, "dist", TARGET_DIRECTORY);
  const snapshot = await snapshotDirectory(target, ACCEPTANCE_FILES, "Acceptance artifact source");
  validateAcceptanceArtifactSnapshot(snapshot);
  await requireActiveLease(checked.lease);
  await assertDirectorySnapshot(target, snapshot, "Acceptance artifact source");
  const copied = copyOutArtifactSnapshot(snapshot);
  validateAcceptanceArtifactSnapshot(copied);
  return copied;
}

async function writeOwnedStageFile(stage, snapshot, name, bytes, label) {
  await assertDirectorySnapshot(stage.path, snapshot, "Acceptance stage");
  const file = await writeExclusive(join(stage.path, name), bytes, label);
  const files = new Map(snapshot.files);
  files.set(name, file);
  const next = {
    directory: Object.freeze({ path: stage.path, ...stage.identity }),
    names: [...files.keys()].sort(),
    files,
  };
  await assertDirectorySnapshot(stage.path, next, "Acceptance stage");
  return next;
}

export async function buildAcceptanceArtifactUnderLease(options) {
  const checked = exactOptions(options, ["lease", "hooks"], "acceptance artifact build");
  const lease = checked.lease;
  const leaseRecord = await requireActiveLease(lease);
  const requestedHooks = checked.hooks;
  const hooks = validateHooks(requestedHooks);
  const preflight = await preflightRepository(leaseRecord.repoRoot);
  const dist = await prepareDist(preflight);
  const lock = leaseRecord.lockSnapshot.lock;
  await requireActiveLease(lease);
  if (
    dist.path !== leaseRecord.lockSnapshot.dist.path
    || !sameIdentity(dist.identity, leaseRecord.lockSnapshot.dist.identity)
  ) {
    throw new Error("Acceptance artifact lease belongs to another repository or dist directory");
  }
  const target = join(dist.path, TARGET_DIRECTORY);

  let stage = null;
  let stageSnapshot = null;
  let inputSnapshots = null;
  let oldTargetSnapshot = null;
  let backup = null;
  let backupAvailable = false;
  let published = false;
  let failure = NO_FAILURE;
  let cleanupIncomplete = false;
  let rollbackIncomplete = false;
  let backupRetained = false;
  const rollbackFailures = [];
  const cleanupFailures = [];
  try {
    await requireActiveLease(lease);
    const existingTarget = await optionalStat(target);
    if (existingTarget !== null && (!existingTarget.isDirectory() || existingTarget.isSymbolicLink())) {
      throw new Error("Acceptance target must be a non-symlink directory");
    }
    if (existingTarget !== null) {
      oldTargetSnapshot = await snapshotExistingArtifactDirectory(target, "Existing acceptance target");
      await assertSourceSnapshots(preflight);
      await assertDistAndLock(dist, lock);
    }
    const stagePath = join(dist.path, `${STAGE_PREFIX}${process.pid}-${randomUUID()}`);
    await mkdir(stagePath, { mode: 0o700 });
    stage = { path: stagePath, identity: null };
    const stageStat = await requireDirectory(stage.path, "Acceptance stage");
    stage.identity = identity(stageStat);
    const stageCreateContext = Object.freeze({
      repoRoot: preflight.root,
      dist: dist.path,
      target,
      stage: stage.path,
      backup: null,
      lock: lock.path,
    });
    let stageCreateHookFailure = NO_FAILURE;
    try {
      await hooks.afterStageCreate?.(stageCreateContext);
    } catch (error) {
      stageCreateHookFailure = error;
    }
    let stageCreateValidationFailure = NO_FAILURE;
    try {
      await requireActiveLease(lease);
      await assertDistAndLock(dist, lock);
      await assertSourceSnapshots(preflight);
      await assertDirectoryIdentity(stage.path, stage.identity, "Acceptance stage");
      if ((await readdir(stage.path)).length !== 0) throw new Error("Acceptance stage must initially be empty");
      if (oldTargetSnapshot === null) await assertAbsent(target, "Acceptance target");
      else await assertDirectorySnapshot(target, oldTargetSnapshot, "Existing acceptance target");
      stageSnapshot = await snapshotEmptyDirectory(stage.path, "Acceptance stage");
      if (!sameIdentity(stageSnapshot.directory, stage.identity)) {
        throw new Error("Acceptance stage identity changed during creation");
      }
    } catch (error) {
      stageCreateValidationFailure = error;
    }
    if (stageCreateHookFailure !== NO_FAILURE && stageCreateValidationFailure !== NO_FAILURE) {
      throw new AggregateError(
        [stageCreateHookFailure, stageCreateValidationFailure],
        `afterStageCreate hook failed: ${errorMessage(stageCreateHookFailure)}; snapshot changed: ${errorMessage(stageCreateValidationFailure)}`,
      );
    }
    if (stageCreateValidationFailure !== NO_FAILURE) throw stageCreateValidationFailure;
    if (stageCreateHookFailure !== NO_FAILURE) throw stageCreateHookFailure;
    const context = () => ({
      repoRoot: preflight.root,
      dist: dist.path,
      target,
      stage: stage.path,
      backup: backup?.path ?? null,
      lock: lock.path,
    });
    const assertOriginalTarget = async () => {
      if (oldTargetSnapshot === null) await assertAbsent(target, "Acceptance target");
      else await assertDirectorySnapshot(target, oldTargetSnapshot, "Existing acceptance target");
    };
    const assertBuildInputs = async () => {
      await assertSourceSnapshots(preflight);
      if (inputSnapshots !== null) await assertInputSnapshots(inputSnapshots);
    };
    const assertStage = async () => {
      await assertDirectorySnapshot(stage.path, stageSnapshot, "Acceptance stage");
      if (!sameIdentity(stageSnapshot.directory, stage.identity)) {
        throw new Error("Acceptance stage initial identity changed");
      }
    };
    await runHook("beforeBundle", hooks, context(), async () => {
      await requireActiveLease(lease);
      await assertDistAndLock(dist, lock);
      await assertBuildInputs();
      await assertStage();
      await assertOriginalTarget();
    });

    const binding = `${PLUGIN_ID}@${preflight.version}:read-only-acceptance`;
    const outfile = join(stage.path, "main.js");
    const bundleOptions = {
      entryPoint: preflight.requiredPaths.entry,
      outfile,
      mode: "read-only-acceptance",
      pluginVersion: preflight.version,
      manifestName: ACCEPTANCE_PLUGIN_NAME,
      artifactBinding: binding,
      production: true,
      metafile: true,
      write: false,
    };

    await assertDistAndLock(dist, lock);
    await assertBuildInputs();
    await assertStage();
    await assertOriginalTarget();
    const discoveryResult = await buildBundle(bundleOptions);
    requireBundleOutput(discoveryResult, outfile, "Acceptance dependency discovery bundle");
    await assertDistAndLock(dist, lock);
    await assertBuildInputs();
    await assertStage();
    await assertOriginalTarget();
    inputSnapshots = await snapshotMetafileInputs(preflight.root, discoveryResult);
    await assertInputSnapshots(inputSnapshots);

    await assertDistAndLock(dist, lock);
    await assertBuildInputs();
    await assertStage();
    await assertOriginalTarget();
    const result = await buildBundle(bundleOptions);
    const bundleBytes = requireBundleOutput(result, outfile, "Acceptance production bundle");
    await assertMetafileInputSet(preflight.root, result, inputSnapshots);
    await assertDistAndLock(dist, lock);
    await assertBuildInputs();
    await assertStage();
    await assertOriginalTarget();

    stageSnapshot = await writeOwnedStageFile(
      stage,
      stageSnapshot,
      "main.js",
      bundleBytes,
      "Acceptance bundle",
    );
    await assertBuildInputs();
    stageSnapshot = await writeOwnedStageFile(
      stage,
      stageSnapshot,
      "styles.css",
      preflight.sources.get("styles").bytes,
      "Acceptance styles",
    );
    await assertBuildInputs();
    stageSnapshot = await writeOwnedStageFile(
      stage,
      stageSnapshot,
      "manifest.json",
      `${JSON.stringify({ ...preflight.manifest, name: ACCEPTANCE_PLUGIN_NAME }, null, 2)}\n`,
      "Acceptance manifest",
    );
    await assertBuildInputs();
    stageSnapshot = await writeOwnedStageFile(
      stage,
      stageSnapshot,
      "acceptance-build.json",
      `${JSON.stringify(acceptanceMetadata(preflight.version), null, 2)}\n`,
      "Acceptance metadata",
    );
    await assertBuildInputs();
    const validatedStage = await snapshotCurrentArtifactDirectory(
      stage.path,
      preflight,
      "Acceptance stage",
      { requireCurrentStyles: true },
    );
    if (!sameIdentity(validatedStage.directory, stage.identity)) {
      throw new Error("Acceptance stage initial identity changed before validation");
    }
    await assertDirectorySnapshot(stage.path, stageSnapshot, "Acceptance stage");
    await assertMetafileInputSet(preflight.root, result, inputSnapshots);
    await assertBuildInputs();
    await runHook("afterStageValidation", hooks, context(), async () => {
      await requireActiveLease(lease);
      await assertDistAndLock(dist, lock);
      await assertBuildInputs();
      await assertStage();
      await assertOriginalTarget();
    });

    if (oldTargetSnapshot !== null) {
      await assertDistAndLock(dist, lock);
      await assertBuildInputs();
      await assertStage();
      await assertDirectorySnapshot(target, oldTargetSnapshot, "Existing acceptance target");
      const backupPath = join(dist.path, `${BACKUP_PREFIX}${process.pid}-${randomUUID()}`);
      await assertAbsent(backupPath, "Acceptance backup");
      await rename(target, backupPath);
      backup = { path: backupPath, snapshot: oldTargetSnapshot };
      backupAvailable = true;
      await assertDistAndLock(dist, lock);
      await assertAbsent(target, "Acceptance target after backup");
      await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
      await assertStage();
      await assertBuildInputs();
    }
    await runHook("afterBackup", hooks, context(), async () => {
      await requireActiveLease(lease);
      await assertDistAndLock(dist, lock);
      await assertBuildInputs();
      await assertStage();
      await assertAbsent(target, "Acceptance target");
      if (backupAvailable && backup !== null) {
        await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
      }
    });
    await assertDistAndLock(dist, lock);
    await assertBuildInputs();
    await assertStage();
    if (backupAvailable && backup !== null) {
      await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
    }
    // Directory rename gives cooperative builders no partial-directory publication. The
    // fixed target may be briefly absent. This intentionally makes neither a power-loss
    // durability claim nor a hostile-process no-clobber claim.
    await assertAbsent(target, "Acceptance target");
    await rename(stage.path, target);
    published = true;
    await assertAbsent(stage.path, "Acceptance stage path");
    await assertDistAndLock(dist, lock);
    await assertBuildInputs();
    await assertDirectorySnapshot(target, stageSnapshot, "Published acceptance target");
    if (backupAvailable && backup !== null) {
      await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
    }
    await runHook("afterPublish", hooks, context(), async () => {
      await requireActiveLease(lease);
      await assertDistAndLock(dist, lock);
      await assertBuildInputs();
      await assertDirectorySnapshot(target, stageSnapshot, "Published acceptance target");
      await assertAbsent(stage.path, "Acceptance stage path");
      if (backupAvailable && backup !== null) {
        await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
      }
    });
    if (backupAvailable && backup !== null) {
      await assertDistAndLock(dist, lock);
      await assertBuildInputs();
      await assertDirectorySnapshot(target, stageSnapshot, "Published acceptance target");
      await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
      await safeDeleteDirectory(backup.path, backup.snapshot, "Acceptance backup");
      backupAvailable = false;
      await assertAbsent(backup.path, "Acceptance backup path");
      await assertDirectorySnapshot(target, stageSnapshot, "Published acceptance target");
      await assertDistAndLock(dist, lock);
      await assertBuildInputs();
    }
    await assertDistAndLock(dist, lock);
    await assertBuildInputs();
    await assertDirectorySnapshot(target, stageSnapshot, "Published acceptance target");
  } catch (error) {
    failure = error;
  }

  if (failure !== NO_FAILURE && published && stageSnapshot !== null && lock !== null) {
    if (backupAvailable && backup !== null) {
      try {
        await assertDistAndLock(dist, lock);
        await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
        await assertDirectorySnapshot(target, stageSnapshot, "Published acceptance target");
        const quarantinePath = join(dist.path, `${QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`);
        await assertAbsent(quarantinePath, "Acceptance quarantine");
        await rename(target, quarantinePath);
        published = false;
        const quarantine = { path: quarantinePath, snapshot: stageSnapshot };
        await assertDistAndLock(dist, lock);
        await assertAbsent(target, "Acceptance target during rollback");
        await assertDirectorySnapshot(quarantine.path, quarantine.snapshot, "Acceptance quarantine");
        await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
        await assertAbsent(target, "Acceptance target immediately before restore");
        await rename(backup.path, target);
        backupAvailable = false;
        await assertDistAndLock(dist, lock);
        await assertAbsent(backup.path, "Acceptance backup path");
        await assertDirectorySnapshot(target, backup.snapshot, "Restored acceptance target");
        await assertDirectorySnapshot(quarantine.path, quarantine.snapshot, "Acceptance quarantine");
        await safeDeleteDirectory(quarantine.path, quarantine.snapshot, "Acceptance quarantine");
      } catch (error) {
        rollbackIncomplete = true;
        rollbackFailures.push(error);
        try {
          backupRetained = await optionalStat(backup.path) !== null;
        } catch (probeError) {
          rollbackFailures.push(probeError);
          backupRetained = true;
        }
      }
    } else {
      try {
        await assertDistAndLock(dist, lock);
        await assertDirectorySnapshot(target, stageSnapshot, "Published acceptance target");
        const quarantinePath = join(dist.path, `${QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`);
        await assertAbsent(quarantinePath, "Acceptance quarantine");
        await rename(target, quarantinePath);
        published = false;
        const quarantine = { path: quarantinePath, snapshot: stageSnapshot };
        await assertDistAndLock(dist, lock);
        await assertAbsent(target, "Acceptance target during rollback");
        await assertDirectorySnapshot(quarantine.path, quarantine.snapshot, "Acceptance quarantine");
        await safeDeleteDirectory(quarantine.path, quarantine.snapshot, "Acceptance quarantine");
      } catch (error) {
        rollbackIncomplete = true;
        rollbackFailures.push(error);
      }
    }
  } else if (failure !== NO_FAILURE && backupAvailable && backup !== null && lock !== null) {
    try {
      await assertDistAndLock(dist, lock);
      await assertDirectorySnapshot(backup.path, backup.snapshot, "Acceptance backup");
      await assertAbsent(target, "Acceptance target immediately before restore");
      await rename(backup.path, target);
      backupAvailable = false;
      await assertDistAndLock(dist, lock);
      await assertAbsent(backup.path, "Acceptance backup path");
      await assertDirectorySnapshot(target, backup.snapshot, "Restored acceptance target");
    } catch (error) {
      rollbackIncomplete = true;
      rollbackFailures.push(error);
      try {
        backupRetained = await optionalStat(backup.path) !== null;
      } catch (probeError) {
        rollbackFailures.push(probeError);
        backupRetained = true;
      }
    }
  }
  if (!published && stage !== null) {
    if (stage.identity === null || stageSnapshot === null) {
      try {
        if (await optionalStat(stage.path) !== null) {
          cleanupIncomplete = true;
          cleanupFailures.push(new Error("Acceptance stage cleanup ownership could not be proved"));
        }
      } catch (error) {
        cleanupIncomplete = true;
        cleanupFailures.push(error);
      }
    } else {
      try {
        await safeDeleteDirectory(stage.path, stageSnapshot, "Acceptance stage");
      } catch (error) {
        cleanupIncomplete = true;
        cleanupFailures.push(error);
      }
    }
  }
  if (failure !== NO_FAILURE) {
    if (backupAvailable && backup !== null) {
      try {
        if (await optionalStat(backup.path) !== null) backupRetained = true;
      } catch (error) {
        rollbackIncomplete = true;
        rollbackFailures.push(error);
        backupRetained = true;
      }
    }
    if (cleanupIncomplete) rollbackIncomplete = true;
    if (rollbackIncomplete || backupRetained) {
      const suffix = `${rollbackIncomplete ? "; rollback incomplete" : ""}${backupRetained ? "; backup retained" : ""}`;
      throw new AggregateError(
        [failure, ...rollbackFailures, ...cleanupFailures],
        `${errorMessage(failure)}${suffix}`,
      );
    }
    throw failure;
  }
  if (cleanupIncomplete) {
    throw new AggregateError(cleanupFailures, "Acceptance artifact built but owned cleanup was incomplete");
  }
  await requireActiveLease(lease);
  return { target, artifacts: [...ACCEPTANCE_FILES] };
}

export async function buildAcceptanceArtifact({ repoRoot, hooks } = {}) {
  return await withAcceptanceArtifactLock(repoRoot, async (lease) =>
    await buildAcceptanceArtifactUnderLease({ lease, hooks }));
}
