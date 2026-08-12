import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  NORMAL_PLUGIN_NAME,
  PLUGIN_ID,
  buildBundle,
} from "../esbuild.config.mjs";
import { isStrictBoundedSemver } from "../src/runtime/strict-semver.mjs";
import {
  assertFrozenRegularFile,
  readFrozenRegularFile,
} from "./safe-fs-core.mjs";
import {
  assertTrackedBuildInputs,
  assertTrackedGitState,
  captureTrackedGitState,
} from "./git-worktree-state.mjs";

export const NORMAL_ARTIFACT_FILES = Object.freeze([
  "main.js",
  "manifest.json",
  "styles.css",
]);

const ARTIFACT_SET_DOMAIN = Buffer.from(
  "knowledge-workbench-normal-real-artifact-set-v1\0",
  "ascii",
);

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

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

function requireBundleOutput(result, outfile) {
  if (!Array.isArray(result.outputFiles) || result.outputFiles.length !== 1) {
    throw new Error("Normal bundle must return one in-memory output file");
  }
  const [output] = result.outputFiles;
  if (
    output === undefined
    || typeof output.path !== "string"
    || resolve(output.path) !== resolve(outfile)
    || !(output.contents instanceof Uint8Array)
    || output.contents.byteLength === 0
  ) throw new Error("Normal bundle returned an unexpected in-memory output");
  return Buffer.from(output.contents);
}

async function requireCanonicalRepository(repoRoot) {
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot) || resolve(repoRoot) !== repoRoot) {
    throw new Error("Repository root must be one canonical absolute path");
  }
  const stat = await lstat(repoRoot, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(repoRoot) !== repoRoot) {
    throw new Error("Repository root must be one canonical non-symlink directory");
  }
  return Object.freeze({ path: repoRoot, dev: stat.dev, ino: stat.ino });
}

async function assertCanonicalRepository(snapshot) {
  const stat = await lstat(snapshot.path, { bigint: true });
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || !sameIdentity(stat, snapshot)
    || await realpath(snapshot.path) !== snapshot.path
  ) throw new Error("Repository root changed while normal artifact was frozen");
}

async function snapshotRequiredSources(repoRoot) {
  const paths = Object.freeze({
    buildConfig: join(repoRoot, "esbuild.config.mjs"),
    entry: join(repoRoot, "src", "main.ts"),
    manifest: join(repoRoot, "manifest.json"),
    packageJson: join(repoRoot, "package.json"),
    styles: join(repoRoot, "styles.css"),
  });
  const sources = new Map();
  for (const [name, path] of Object.entries(paths)) {
    sources.set(name, await readFrozenRegularFile(path, `Normal artifact source ${name}`));
  }
  const manifest = parseObject(sources.get("manifest").bytes, "Normal manifest");
  const packageJson = parseObject(sources.get("packageJson").bytes, "package.json");
  if (manifest.id !== PLUGIN_ID || manifest.name !== NORMAL_PLUGIN_NAME) {
    throw new Error("Normal manifest identity must be exact");
  }
  if (!isStrictBoundedSemver(manifest.version) || manifest.version !== packageJson.version) {
    throw new Error("Normal manifest and package versions must match a bounded semantic version");
  }
  return Object.freeze({ manifest, packageJson, paths, sources, version: manifest.version });
}

async function assertRequiredSources(preflight) {
  for (const [name, path] of Object.entries(preflight.paths)) {
    const snapshot = preflight.sources.get(name);
    if (snapshot === undefined) throw new Error(`Normal artifact lost source ${name}`);
    await assertFrozenRegularFile(Object.freeze({ ...snapshot, path }), `Normal artifact source ${name}`);
  }
}

async function buildOnce(repoRoot, preflight) {
  const outfile = join(repoRoot, "main.js");
  const result = await buildBundle({
    entryPoint: preflight.paths.entry,
    outfile,
    mode: "normal",
    pluginVersion: preflight.version,
    manifestName: NORMAL_PLUGIN_NAME,
    artifactBinding: `${PLUGIN_ID}@${preflight.version}:normal`,
    production: true,
    metafile: true,
    write: false,
  });
  return Object.freeze({ bundle: requireBundleOutput(result, outfile), metafile: result.metafile });
}

async function snapshotBuildInputs(repoRoot, metafile) {
  if (metafile === undefined || typeof metafile.inputs !== "object" || metafile.inputs === null) {
    throw new Error("Normal bundle must expose its metafile inputs");
  }
  const snapshots = new Map();
  const tracked = [];
  for (const input of Object.keys(metafile.inputs)) {
    const requested = isAbsolute(input) ? resolve(input) : resolve(repoRoot, input);
    const canonical = await realpath(requested);
    if (!inside(repoRoot, canonical)) throw new Error("Normal bundle input escaped the repository");
    const relativePath = relative(repoRoot, canonical).split(sep).join("/");
    if (snapshots.has(canonical)) throw new Error("Normal bundle contains a duplicate canonical input");
    snapshots.set(canonical, Object.freeze({
      ...(await readFrozenRegularFile(canonical, `Normal bundle input ${relativePath}`)),
      path: canonical,
      relativePath,
    }));
    if (!relativePath.startsWith("node_modules/")) tracked.push(relativePath);
  }
  if (snapshots.size === 0 || tracked.length === 0) {
    throw new Error("Normal bundle must contain tracked repository inputs");
  }
  tracked.sort();
  await assertTrackedBuildInputs(repoRoot, tracked);
  return Object.freeze({ snapshots, tracked: Object.freeze(tracked) });
}

async function assertBuildInputs(repoRoot, frozenInputs) {
  await assertTrackedBuildInputs(repoRoot, frozenInputs.tracked);
  for (const snapshot of frozenInputs.snapshots.values()) {
    await assertFrozenRegularFile(snapshot, `Normal bundle input ${snapshot.relativePath}`);
  }
}

function sameInputSet(left, right) {
  const leftPaths = [...left.snapshots.keys()].sort();
  const rightPaths = [...right.snapshots.keys()].sort();
  if (!isDeepStrictEqual(leftPaths, rightPaths)) return false;
  return leftPaths.every((path) => {
    const a = left.snapshots.get(path);
    const b = right.snapshots.get(path);
    return a !== undefined
      && b !== undefined
      && a.evidence.dev === b.evidence.dev
      && a.evidence.ino === b.evidence.ino
      && a.evidence.nlink === b.evidence.nlink
      && a.evidence.size === b.evidence.size
      && a.evidence.sha256 === b.evidence.sha256
      && a.bytes.equals(b.bytes);
  });
}

function validateCompileBinding(bundle, version) {
  const text = bundle.toString("utf8");
  for (const required of [
    "normal",
    version,
    NORMAL_PLUGIN_NAME,
    `${PLUGIN_ID}@${version}:normal`,
  ]) {
    if (!text.includes(required)) throw new Error(`Normal bundle is missing compile binding ${required}`);
  }
}

function requireArtifactView(snapshot, source, version) {
  if (
    typeof snapshot !== "object"
    || snapshot === null
    || !Array.isArray(snapshot.names)
    || !isDeepStrictEqual([...snapshot.names], NORMAL_ARTIFACT_FILES)
    || typeof snapshot.files?.get !== "function"
    || snapshot.files.size !== NORMAL_ARTIFACT_FILES.length
  ) throw new Error("Normal artifact must use the exact three-file contract");
  for (const name of NORMAL_ARTIFACT_FILES) {
    const actual = snapshot.files.get(name);
    const expected = source.files.get(name);
    if (
      actual === undefined
      || expected === undefined
      || !Buffer.isBuffer(actual.bytes)
      || actual.bytes.byteLength === 0
      || !actual.bytes.equals(expected.bytes)
    ) throw new Error(`Normal artifact file ${name} does not match its frozen source`);
  }
  const manifest = parseObject(snapshot.files.get("manifest.json").bytes, "Normal artifact manifest");
  if (
    manifest.id !== PLUGIN_ID
    || manifest.name !== NORMAL_PLUGIN_NAME
    || manifest.version !== version
  ) throw new Error("Normal artifact manifest identity is invalid");
  validateCompileBinding(snapshot.files.get("main.js").bytes, version);
}

function computeDigest(source) {
  const hash = createHash("sha256");
  hash.update(ARTIFACT_SET_DOMAIN);
  for (const name of NORMAL_ARTIFACT_FILES) {
    const nameBytes = Buffer.from(name, "utf8");
    const bytes = source.files.get(name).bytes;
    const nameLength = Buffer.alloc(8);
    nameLength.writeBigUInt64BE(BigInt(nameBytes.byteLength));
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(nameLength);
    hash.update(nameBytes);
    hash.update(contentLength);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function buildFrozenNormalArtifact({ repoRoot } = {}) {
  const root = await requireCanonicalRepository(repoRoot);
  const git = await captureTrackedGitState(repoRoot);
  const preflight = await snapshotRequiredSources(repoRoot);
  await assertTrackedBuildInputs(
    repoRoot,
    Object.values(preflight.paths).map((path) => relative(repoRoot, path).split(sep).join("/")),
  );
  const first = await buildOnce(repoRoot, preflight);
  const inputs = await snapshotBuildInputs(repoRoot, first.metafile);
  await assertRequiredSources(preflight);
  await assertBuildInputs(repoRoot, inputs);
  await assertTrackedGitState(repoRoot, git.commit);
  const second = await buildOnce(repoRoot, preflight);
  const secondInputs = await snapshotBuildInputs(repoRoot, second.metafile);
  if (!first.bundle.equals(second.bundle) || !sameInputSet(inputs, secondInputs)) {
    throw new Error("Normal artifact build was not deterministic under one frozen input set");
  }
  await assertRequiredSources(preflight);
  await assertBuildInputs(repoRoot, inputs);
  await assertTrackedGitState(repoRoot, git.commit);
  validateCompileBinding(second.bundle, preflight.version);

  const source = Object.freeze({
    files: new Map([
      ["main.js", Object.freeze({ bytes: Buffer.from(second.bundle) })],
      ["manifest.json", Object.freeze({ bytes: Buffer.from(preflight.sources.get("manifest").bytes) })],
      ["styles.css", Object.freeze({ bytes: Buffer.from(preflight.sources.get("styles").bytes) })],
    ]),
    names: NORMAL_ARTIFACT_FILES,
  });

  const assertCurrent = async () => {
    await assertCanonicalRepository(root);
    await assertRequiredSources(preflight);
    await assertBuildInputs(repoRoot, inputs);
    await assertTrackedGitState(repoRoot, git.commit);
  };
  const validateSnapshot = (snapshot) => requireArtifactView(snapshot, source, preflight.version);
  return Object.freeze({
    artifactBinding: `${PLUGIN_ID}@${preflight.version}:normal`,
    artifactSetDigest: computeDigest(source),
    assertCurrent,
    names: NORMAL_ARTIFACT_FILES,
    pluginVersion: preflight.version,
    source,
    validateSnapshot,
  });
}
