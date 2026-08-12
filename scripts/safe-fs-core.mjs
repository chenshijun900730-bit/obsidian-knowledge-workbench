import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;
const changeStamps = new WeakMap();

class ReadonlyMapView {
  #entries;

  constructor(entries) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size() { return this.#entries.size; }
  get(key) { return this.#entries.get(key); }
  has(key) { return this.#entries.has(key); }
  entries() { return this.#entries.entries(); }
  keys() { return this.#entries.keys(); }
  values() { return this.#entries.values(); }
  forEach(callback, thisArg) {
    this.#entries.forEach((value, key) => callback.call(thisArg, value, key, this));
  }
  [Symbol.iterator]() { return this.#entries[Symbol.iterator](); }
}
Object.freeze(ReadonlyMapView.prototype);

function freezeWithChangeStamp(value, source) {
  const stamp = typeof source === "bigint" ? source : source.ctimeNs;
  if (typeof stamp !== "bigint") throw new Error("Filesystem change stamp is unavailable");
  const frozen = Object.freeze(value);
  changeStamps.set(frozen, stamp);
  return frozen;
}

function freezeWithInheritedChangeStamp(value, source) {
  const stamp = changeStamps.get(source);
  if (stamp === undefined) throw new Error("Filesystem change stamp was not retained");
  return freezeWithChangeStamp(value, stamp);
}

function sameChangeStamp(left, right) {
  const leftStamp = changeStamps.get(left);
  const rightStamp = changeStamps.get(right);
  return leftStamp !== undefined && rightStamp !== undefined && leftStamp === rightStamp;
}

function sameRetainedChangeStamp(current, expected) {
  const expectedStamp = changeStamps.get(expected);
  return expectedStamp === undefined || changeStamps.get(current) === expectedStamp;
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameEvidence = (left, right) => sameIdentity(left, right)
  && left.nlink === right.nlink
  && left.size === right.size
  && left.sha256 === right.sha256
  && sameChangeStamp(left, right);

function hasErrorCode(error, code) {
  let current = error;
  while (current !== null && typeof current === "object") {
    if (current.code === code) return true;
    current = current.cause;
  }
  return false;
}

function directoryIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

async function requireDirectory(path, label) {
  let stat;
  try {
    stat = await lstat(path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} must be an existing non-symlink directory`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return stat;
}

function requireFixedBasename(name, label) {
  if (
    typeof name !== "string"
    || name.length === 0
    || name === "."
    || name === ".."
    || basename(name) !== name
  ) {
    throw new Error(`${label} name must be a fixed basename`);
  }
}

function exactNames(names, label) {
  if (!Array.isArray(names)) throw new Error(`${label} names must be an array`);
  const checked = [];
  for (const name of names) {
    requireFixedBasename(name, label);
    checked.push(name);
  }
  const sorted = checked.sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} names must be unique`);
  return Object.freeze(sorted);
}

function exactRelativePaths(paths, label) {
  if (!Array.isArray(paths)) throw new Error(`${label} allowlist must be an array`);
  const checked = [];
  for (const path of paths) {
    if (
      typeof path !== "string"
      || path.length === 0
      || isAbsolute(path)
      || normalize(path) !== path
      || path === "."
      || path === ".."
      || path.startsWith(`..${sep}`)
      || path.split(sep).some((component) => component.length === 0 || component === "." || component === "..")
    ) {
      throw new Error(`${label} allowlist entries must be normalized relative paths`);
    }
    checked.push(path);
  }
  const sorted = checked.sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} allowlist entries must be unique`);
  return Object.freeze(sorted);
}

export async function readFrozenRegularFile(path, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`${label} must be a singly linked regular file (nlink must equal 1)`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      !after.isFile()
      || after.nlink !== 1n
      || current.isSymbolicLink()
      || !current.isFile()
      || current.nlink !== 1n
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.ctimeNs !== after.ctimeNs
      || after.dev !== current.dev
      || after.ino !== current.ino
      || after.size !== current.size
      || after.ctimeNs !== current.ctimeNs
      || after.size !== BigInt(bytes.byteLength)
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    const evidence = freezeWithChangeStamp({
      dev: after.dev,
      ino: after.ino,
      nlink: after.nlink,
      size: after.size,
      sha256: digest,
    }, after);
    return Object.freeze({
      path,
      bytes: Buffer.from(bytes),
      evidence,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} must be a singly linked regular non-symlink file (nlink must equal 1)`, { cause: error });
  } finally {
    await handle?.close();
  }
}

export async function assertFrozenRegularFile(snapshot, label) {
  const current = await readFrozenRegularFile(snapshot.path, label);
  if (!sameEvidence(current.evidence, snapshot.evidence)) {
    throw new Error(`${label} snapshot changed`);
  }
}

async function captureExactDirectory(path, names, label) {
  const before = await requireDirectory(path, label);
  const actualNames = (await readdir(path)).sort();
  if (!isDeepStrictEqual(actualNames, names)) {
    throw new Error(`${label} must contain the exact expected files`);
  }
  const files = new Map();
  for (const name of names) {
    files.set(name, await readFrozenRegularFile(join(path, name), `${label} file ${name}`));
  }
  const after = await requireDirectory(path, label);
  const finalNames = (await readdir(path)).sort();
  if (
    !sameIdentity(before, after)
    || before.ctimeNs !== after.ctimeNs
    || !isDeepStrictEqual(finalNames, names)
  ) {
    throw new Error(`${label} changed while it was snapshotted`);
  }
  for (const [name, file] of files) {
    await assertFrozenRegularFile(file, `${label} file ${name}`);
  }
  return freezeWithChangeStamp({
    path,
    ...directoryIdentity(after),
    names,
    files: new ReadonlyMapView(files),
  }, after);
}

export async function snapshotExactDirectory(path, names, label) {
  return captureExactDirectory(path, exactNames(names, label), label);
}

export async function assertExactDirectory(snapshot, label) {
  const current = await captureExactDirectory(snapshot.path, exactNames(snapshot.names, label), label);
  if (
    !sameIdentity(current, snapshot)
    || !sameRetainedChangeStamp(current, snapshot)
    || current.files.size !== snapshot.files.size
  ) {
    throw new Error(`${label} directory snapshot changed`);
  }
  for (const name of current.names) {
    const expected = snapshot.files.get(name);
    const actual = current.files.get(name);
    if (expected === undefined || actual === undefined || !sameEvidence(actual.evidence, expected.evidence)) {
      throw new Error(`${label} file ${name} snapshot changed`);
    }
  }
}

async function captureOwnedDirectory(root, directoryPath, relativeDirectory, entries, label) {
  const before = await requireDirectory(directoryPath, label);
  const names = (await readdir(directoryPath)).sort();
  for (const name of names) {
    const path = join(directoryPath, name);
    const relativePath = relative(root, path);
    let stat;
    try {
      stat = await lstat(path, { bigint: true });
    } catch (error) {
      throw new Error(`${label} entry ${relativePath} changed while it was snapshotted`, { cause: error });
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} entry ${relativePath} must not be a symbolic link`);
    if (stat.isDirectory()) {
      entries.set(relativePath, freezeWithChangeStamp({
        type: "directory",
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        size: stat.size,
      }, stat));
      const captured = await captureOwnedDirectory(
        root,
        path,
        relativePath,
        entries,
        `${label} directory ${relativePath}`,
      );
      if (!sameIdentity(stat, captured) || stat.ctimeNs !== captured.ctimeNs) {
        throw new Error(`${label} directory ${relativePath} identity changed during recursive capture`);
      }
      continue;
    }
    if (!stat.isFile()) throw new Error(`${label} entry ${relativePath} must be a regular file or directory`);
    const file = await readFrozenRegularFile(path, `${label} file ${relativePath}`);
    entries.set(
      relativePath,
      freezeWithInheritedChangeStamp({ type: "file", ...file.evidence }, file.evidence),
    );
  }
  const after = await requireDirectory(directoryPath, label);
  const finalNames = (await readdir(directoryPath)).sort();
  if (
    !sameIdentity(before, after)
    || before.ctimeNs !== after.ctimeNs
    || !isDeepStrictEqual(names, finalNames)
  ) {
    const name = relativeDirectory.length === 0 ? "root" : relativeDirectory;
    throw new Error(`${label} ${name} changed while it was snapshotted`);
  }
  return after;
}

async function captureOwnedTree(root, allowlist, label) {
  const rootBefore = await requireDirectory(root, label);
  const entries = new Map();
  await captureOwnedDirectory(root, root, "", entries, label);
  const rootAfter = await requireDirectory(root, label);
  const actualPaths = [...entries.keys()].sort();
  if (
    !sameIdentity(rootBefore, rootAfter)
    || rootBefore.ctimeNs !== rootAfter.ctimeNs
    || !isDeepStrictEqual(actualPaths, allowlist)
  ) {
    throw new Error(`${label} contains an unknown, missing, or changed entry`);
  }
  return Object.freeze({
    root: freezeWithChangeStamp({ path: root, ...directoryIdentity(rootAfter) }, rootAfter),
    entries: new ReadonlyMapView(entries),
  });
}

export async function snapshotOwnedTree(root, completeAllowlist, label) {
  return captureOwnedTree(root, exactRelativePaths(completeAllowlist, label), label);
}

function sameOwnedEntry(left, right) {
  return left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.sha256 === right.sha256
    && sameRetainedChangeStamp(left, right);
}

export function assertOwnedTreeContinuity(
  current,
  expected,
  identityOnlyDirectory,
  label,
) {
  const [mutableDirectory] = exactRelativePaths([identityOnlyDirectory], label);
  if (
    current.root.path !== expected.root.path
    || !sameIdentity(current.root, expected.root)
    || !sameChangeStamp(current.root, expected.root)
  ) {
    throw new Error(`${label} root identity or change stamp changed`);
  }
  for (const [relativePath, expectedEntry] of expected.entries) {
    const currentEntry = current.entries.get(relativePath);
    if (relativePath === mutableDirectory) {
      if (
        currentEntry?.type !== "directory"
        || expectedEntry.type !== "directory"
        || !sameIdentity(currentEntry, expectedEntry)
      ) {
        throw new Error(`${label} mutable directory identity changed`);
      }
      continue;
    }
    if (currentEntry === undefined || !sameOwnedEntry(currentEntry, expectedEntry)) {
      throw new Error(`${label} immutable entry ${relativePath} changed`);
    }
  }
}

export async function assertOwnedTree(snapshot, label) {
  const allowlist = exactRelativePaths([...snapshot.entries.keys()], label);
  const current = await captureOwnedTree(snapshot.root.path, allowlist, label);
  if (
    !sameIdentity(current.root, snapshot.root)
    || !sameRetainedChangeStamp(current.root, snapshot.root)
    || current.entries.size !== snapshot.entries.size
  ) {
    throw new Error(`${label} root snapshot changed`);
  }
  for (const path of allowlist) {
    const expected = snapshot.entries.get(path);
    const actual = current.entries.get(path);
    if (expected === undefined || actual === undefined || !sameOwnedEntry(actual, expected)) {
      throw new Error(`${label} entry ${path} snapshot changed`);
    }
  }
}

function requireBoundPath(tree, relativePath, snapshot, label) {
  const [checked] = exactRelativePaths([relativePath], label);
  if (snapshot.path !== join(tree.root.path, checked)) {
    throw new Error(`${label} path is not bound to the owned tree`);
  }
  return checked;
}

export function assertFrozenRegularFileInOwnedTree(tree, relativePath, snapshot, label) {
  const checked = requireBoundPath(tree, relativePath, snapshot, label);
  const entry = tree.entries.get(checked);
  if (entry?.type !== "file" || !sameEvidence(entry, snapshot.evidence)) {
    throw new Error(`${label} file snapshot is not bound to the owned tree`);
  }
}

export function assertDirectoryInOwnedTree(tree, relativePath, snapshot, label) {
  const checked = requireBoundPath(tree, relativePath, snapshot, label);
  const entry = tree.entries.get(checked);
  if (
    entry?.type !== "directory"
    || !sameIdentity(entry, snapshot)
    || !sameChangeStamp(entry, snapshot)
  ) {
    throw new Error(`${label} directory snapshot is not bound to the owned tree`);
  }
}

export function assertExactDirectoryInOwnedTree(tree, relativePath, snapshot, label) {
  const checked = requireBoundPath(tree, relativePath, snapshot, label);
  assertDirectoryInOwnedTree(tree, checked, snapshot, label);
  for (const name of exactNames([...snapshot.names], label)) {
    const file = snapshot.files.get(name);
    if (file === undefined) throw new Error(`${label} lost file ${name}`);
    assertFrozenRegularFileInOwnedTree(tree, join(checked, name), file, `${label} file ${name}`);
  }
}

export async function writeExclusiveRegularFile(path, bytes, label) {
  const content = Buffer.from(bytes);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(content);
    const handleStat = await handle.stat({ bigint: true });
    const pathStat = await lstat(path, { bigint: true });
    if (
      !handleStat.isFile()
      || handleStat.nlink !== 1n
      || pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || pathStat.nlink !== 1n
      || !sameIdentity(handleStat, pathStat)
      || handleStat.size !== pathStat.size
      || handleStat.size !== BigInt(content.byteLength)
    ) {
      throw new Error(`${label} changed while it was created`);
    }
    const evidence = freezeWithChangeStamp({
      dev: handleStat.dev,
      ino: handleStat.ino,
      nlink: handleStat.nlink,
      size: handleStat.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    }, handleStat);
    const snapshot = Object.freeze({
      path,
      bytes: Buffer.from(content),
      evidence,
    });
    await assertFrozenRegularFile(snapshot, label);
    return snapshot;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} could not be written exclusively`, { cause: error });
  } finally {
    await handle?.close();
  }
}

async function assertDirectoryIdentity(snapshot, label) {
  const current = await requireDirectory(snapshot.path, label);
  if (!sameIdentity(current, snapshot)) throw new Error(`${label} identity changed`);
}

export async function withExclusiveIdentityLock(input, callback) {
  requireFixedBasename(input.name, input.label);
  await assertDirectoryIdentity(input.parent, `${input.label} parent`);
  const path = join(input.parent.path, input.name);
  let lock;
  try {
    lock = await writeExclusiveRegularFile(
      path,
      Buffer.from(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID() })}\n`),
      input.label,
    );
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(`${input.label} already exists; stale and concurrent locks are never stolen`, { cause: error });
    }
    throw error;
  }

  let validationFailure = null;
  try {
    await assertDirectoryIdentity(input.parent, `${input.label} parent`);
    await assertFrozenRegularFile(lock, input.label);
  } catch (error) {
    validationFailure = error;
  }

  let result;
  let callbackFailure = null;
  if (validationFailure === null) {
    try {
      result = await callback(Object.freeze({}));
    } catch (error) {
      callbackFailure = error;
    }
  }

  let cleanupFailure = null;
  try {
    await assertDirectoryIdentity(input.parent, `${input.label} parent`);
    await assertFrozenRegularFile(lock, input.label);
    await unlink(path);
  } catch (error) {
    cleanupFailure = error;
  }

  if (cleanupFailure !== null) {
    const failures = [validationFailure, callbackFailure, cleanupFailure]
      .filter((failure) => failure !== null);
    throw new AggregateError(failures, `${input.label} cleanup was incomplete; the lock path was retained`);
  }
  if (validationFailure !== null) throw validationFailure;
  if (callbackFailure !== null) throw callbackFailure;
  return result;
}

async function currentOwnedEntry(path, expected, label) {
  if (expected.type === "file") {
    const file = await readFrozenRegularFile(path, label);
    return freezeWithInheritedChangeStamp({ type: "file", ...file.evidence }, file.evidence);
  }
  const stat = await requireDirectory(path, label);
  return freezeWithChangeStamp({
    type: "directory",
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
  }, stat);
}

function pathDepth(path) {
  return path.split(sep).length;
}

export async function removeOwnedTreeBottomUp(snapshot, label) {
  await assertOwnedTree(snapshot, label);
  const paths = [...snapshot.entries.keys()].sort((left, right) => {
    const depthDifference = pathDepth(right) - pathDepth(left);
    if (depthDifference !== 0) return depthDifference;
    const leftEntry = snapshot.entries.get(left);
    const rightEntry = snapshot.entries.get(right);
    if (leftEntry?.type !== rightEntry?.type) return leftEntry?.type === "file" ? -1 : 1;
    return right.localeCompare(left);
  });

  for (const relativePath of paths) {
    const expected = snapshot.entries.get(relativePath);
    if (expected === undefined) throw new Error(`${label} cleanup snapshot lost ${relativePath}`);
    const path = join(snapshot.root.path, relativePath);
    const current = await currentOwnedEntry(path, expected, `${label} cleanup entry ${relativePath}`);
    if (expected.type === "file") {
      if (!sameOwnedEntry(current, expected)) throw new Error(`${label} cleanup entry ${relativePath} changed`);
      const immediate = await lstat(path, { bigint: true });
      if (
        immediate.isSymbolicLink()
        || !immediate.isFile()
        || immediate.nlink !== 1n
        || immediate.dev !== expected.dev
        || immediate.ino !== expected.ino
        || immediate.size !== expected.size
      ) {
        throw new Error(`${label} cleanup entry ${relativePath} changed immediately before unlink`);
      }
      await unlink(path);
      continue;
    }
    if (current.type !== "directory" || !sameIdentity(current, expected)) {
      throw new Error(`${label} cleanup directory ${relativePath} changed`);
    }
    if ((await readdir(path)).length !== 0) throw new Error(`${label} cleanup directory ${relativePath} is not empty`);
    const immediate = await lstat(path, { bigint: true });
    if (immediate.isSymbolicLink() || !immediate.isDirectory() || !sameIdentity(immediate, expected)) {
      throw new Error(`${label} cleanup directory ${relativePath} changed immediately before rmdir`);
    }
    await rmdir(path);
  }

  const root = await requireDirectory(snapshot.root.path, `${label} cleanup root`);
  if (!sameIdentity(root, snapshot.root) || (await readdir(snapshot.root.path)).length !== 0) {
    throw new Error(`${label} cleanup root changed or contains an unknown entry`);
  }
  const immediateRoot = await lstat(snapshot.root.path, { bigint: true });
  if (immediateRoot.isSymbolicLink() || !immediateRoot.isDirectory() || !sameIdentity(immediateRoot, snapshot.root)) {
    throw new Error(`${label} cleanup root changed immediately before rmdir`);
  }
  await rmdir(snapshot.root.path);
}
