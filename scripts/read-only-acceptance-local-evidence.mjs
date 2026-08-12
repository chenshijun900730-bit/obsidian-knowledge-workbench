import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ACCEPTANCE_FILES,
  FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT,
  computeAcceptanceArtifactSetDigest,
  validateAcceptanceArtifactSnapshot,
} from "./acceptance-artifact-contract.mjs";
import {
  INSTALLATION_RECEIPT_RELATIVE_PATH,
  PREPARATION_STATE_RELATIVE_PATH,
  SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH,
  decodeInstallationReceipt,
  decodePreparationState,
} from "./acceptance-run-contract.mjs";
import { assertCleanGitState, captureCleanGitState } from "./git-worktree-state.mjs";
import {
  assertExactDirectory,
  assertFrozenRegularFile,
  assertOwnedTree,
  readFrozenRegularFile,
  snapshotExactDirectory,
  snapshotOwnedTree,
} from "./safe-fs-core.mjs";
import {
  computeReportStatus,
  deriveFailureCategories,
  encodeReadOnlyAcceptanceReport,
} from "./read-only-acceptance-report.mjs";
import {
  encodeSyntheticPluginDataSeed,
  inspectPostHostPluginData,
} from "./synthetic-acceptance-data.mjs";
import {
  SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
  SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
  SYNTHETIC_CONTENT_DIRECTORY,
  computeSyntheticCorpusDigest,
  generateAcceptanceFixture,
} from "./synthetic-note-fixture.mjs";
import {
  OBSIDIAN_CONFIG_DIRECTORY,
  TEST_VAULT_MARKER,
  TEST_VAULT_MARKER_FILE,
  resolveCanonicalWorktree,
} from "./synthetic-vault-install-core.mjs";

const PLUGIN_ID = "knowledge-workbench";
const COMMUNITY_PLUGINS_FILE = "community-plugins.json";
const LEGACY_ACCEPTANCE_REPORT_FILE = "acceptance.json";
const TARGET_FILES = Object.freeze([...ACCEPTANCE_FILES, "data.json"].sort());
const POST_HOST_CONFIGURATION_FILES = Object.freeze([
  "app.json",
  "appearance.json",
  COMMUNITY_PLUGINS_FILE,
  "core-plugins.json",
  "core-plugins-migration.json",
  "graph.json",
  "hotkeys.json",
  "types.json",
  "workspace.json",
  "workspace-mobile.json",
]);
const POST_HOST_CONFIGURATION_NAMES = new Set([
  ...POST_HOST_CONFIGURATION_FILES,
  "plugins",
]);
const LOCAL_ONLY_GATES = Object.freeze([
  "artifactIdentity",
  "fixtureIdentity",
  "automatedSafety",
  "contentUnchanged",
]);
const LOCAL_COMPOSITE_GATES = Object.freeze([
  "hostIsolation",
  "historySensitiveActionsBlocked",
  "networkBoundary",
  "recoveryAbsent",
  "finalHostStopped",
]);
const STATUS_RANK = Object.freeze({ passed: 0, inconclusive: 1, failed: 2 });
const MAX_TIMING_MS = 3_600_000;
const ACCEPTANCE_TIMING_MS = 30_000;
const MARKER_BYTES = Buffer.from(`${JSON.stringify(TEST_VAULT_MARKER, null, 2)}\n`, "utf8");
const EMPTY_COMMUNITY_BYTES = Object.freeze([
  Buffer.from("[]", "utf8"),
  Buffer.from("[]\n", "utf8"),
]);
const SEED_BYTES = encodeSyntheticPluginDataSeed();
const CORPUS_DOMAIN = Buffer.from("knowledge-workbench-synthetic-corpus-v1\0", "ascii");

export const AUTOMATED_SAFETY_TESTS = Object.freeze([
  "tests/unit/runtime/artifact-binding.test.ts",
  "tests/integration/plugin-startup-gate.test.ts",
  "tests/integration/read-only-acceptance.test.ts",
  "tests/integration/read-only-acceptance-automated-safety.test.ts",
  "tests/packaging/composition-roots.test.ts",
  "tests/packaging/read-only-acceptance-build.test.ts",
  "tests/ui/read-only-acceptance-surfaces.test.ts",
]);

class DefiniteEvidenceMismatch extends Error {
  constructor(label, options = undefined) {
    super(`${label} does not match the fixed acceptance contract`, options);
    this.name = "DefiniteEvidenceMismatch";
  }
}

class IndeterminateEvidence extends Error {
  constructor(label, options = undefined) {
    super(`${label} could not be attributed safely`, options);
    this.name = "IndeterminateEvidence";
  }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasErrorCode(error, codes, seen = new Set()) {
  if (error === null || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  try {
    if (typeof error.code === "string" && codes.has(error.code)) return true;
  } catch {
    return false;
  }
  const nested = [];
  try {
    if ("cause" in error) nested.push(error.cause);
    if (error instanceof AggregateError) nested.push(...error.errors);
  } catch {
    return false;
  }
  return nested.some((value) => hasErrorCode(value, codes, seen));
}

const DEFINITE_ABSENCE_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

async function isStableAbsent(path) {
  try {
    const parent = resolve(path, "..");
    const before = await lstat(parent, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) return false;
    const names = (await readdir(parent)).sort();
    const after = await lstat(parent, { bigint: true });
    const finalNames = (await readdir(parent)).sort();
    return sameIdentity(before, after)
      && before.ctimeNs === after.ctimeNs
      && isDeepStrictEqual(names, finalNames)
      && !names.includes(path.slice(parent.length + 1));
  } catch {
    return false;
  }
}

async function classifyFilesystemFailure(
  error,
  label,
  path = undefined,
  confirmStableAbsence = false,
) {
  if (error instanceof DefiniteEvidenceMismatch || error instanceof IndeterminateEvidence) {
    return error;
  }
  if (
    confirmStableAbsence
    && typeof path === "string"
    && hasErrorCode(error, DEFINITE_ABSENCE_CODES)
    && await isStableAbsent(path)
  ) {
    return new DefiniteEvidenceMismatch(label);
  }
  return new IndeterminateEvidence(label, { cause: error });
}

async function captureGate(callback) {
  try {
    return Object.freeze({ status: "passed", value: await callback() });
  } catch (error) {
    return Object.freeze({
      status: error instanceof DefiniteEvidenceMismatch ? "failed" : "inconclusive",
      value: null,
    });
  }
}

function worstStatus(...statuses) {
  let worst = "passed";
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

function timingFloor(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
    || value < 0 || value > MAX_TIMING_MS) {
    throw new Error("Saved acceptance timing is outside the fixed safety bound");
  }
  if (value === 0) return "inconclusive";
  return value > ACCEPTANCE_TIMING_MS ? "failed" : "passed";
}

function startupFloor(evidence) {
  if (evidence === "normalized-safe") return "passed";
  if (evidence === "unsafe") return "failed";
  return "inconclusive";
}

function requireCanonicalRepoRoot(repoRoot, canonical) {
  if (
    typeof repoRoot !== "string"
    || !isAbsolute(repoRoot)
    || resolve(repoRoot) !== repoRoot
    || repoRoot !== canonical
  ) {
    throw new Error("Repository root must be the exact canonical worktree path");
  }
}

async function readRequiredFrozenFile(path, label) {
  try {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
      throw new DefiniteEvidenceMismatch(label);
    }
    return await readFrozenRegularFile(path, label);
  } catch (error) {
    if (error instanceof DefiniteEvidenceMismatch) throw error;
    throw new IndeterminateEvidence(label, { cause: error });
  }
}

async function captureStableDirectory(path, label) {
  try {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new DefiniteEvidenceMismatch(label);
    }
    if (await realpath(path) !== path) throw new DefiniteEvidenceMismatch(label);
    const names = (await readdir(path)).sort();
    const after = await lstat(path, { bigint: true });
    const finalNames = (await readdir(path)).sort();
    if (
      !sameIdentity(before, after)
      || before.ctimeNs !== after.ctimeNs
      || !isDeepStrictEqual(names, finalNames)
    ) {
      throw new IndeterminateEvidence(label);
    }
    return Object.freeze({ path, dev: after.dev, ino: after.ino, ctimeNs: after.ctimeNs, names });
  } catch (error) {
    throw await classifyFilesystemFailure(error, label, path, true);
  }
}

async function assertStableDirectory(snapshot, label) {
  const current = await captureStableDirectory(snapshot.path, label);
  if (
    !sameIdentity(snapshot, current)
    || snapshot.ctimeNs !== current.ctimeNs
    || !isDeepStrictEqual(snapshot.names, current.names)
  ) {
    throw new IndeterminateEvidence(label);
  }
}

function requireExactNames(snapshot, expected, label) {
  const names = [...expected].sort();
  if (!isDeepStrictEqual(snapshot.names, names)) throw new DefiniteEvidenceMismatch(label);
}

function requireAllowedNames(snapshot, required, allowed, label) {
  if (
    required.some((name) => !snapshot.names.includes(name))
    || snapshot.names.some((name) => !allowed.has(name))
  ) {
    throw new DefiniteEvidenceMismatch(label);
  }
}

async function captureExactFileDirectory(path, names, label) {
  const directory = await captureStableDirectory(path, label);
  requireExactNames(directory, names, label);
  for (const name of names) {
    try {
      const stat = await lstat(join(path, name), { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
        throw new DefiniteEvidenceMismatch(`${label} file ${name}`);
      }
    } catch (error) {
      if (error instanceof DefiniteEvidenceMismatch) throw error;
      throw new IndeterminateEvidence(`${label} file ${name}`, { cause: error });
    }
  }
  try {
    const snapshot = await snapshotExactDirectory(path, names, label);
    return Object.freeze({ directory, snapshot });
  } catch (error) {
    throw new IndeterminateEvidence(label, { cause: error });
  }
}

async function captureExactFileShapeDirectory(path, names, label) {
  const directory = await captureStableDirectory(path, label);
  requireExactNames(directory, names, label);
  for (const name of names) {
    try {
      const stat = await lstat(join(path, name), { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
        throw new DefiniteEvidenceMismatch(`${label} file ${name}`);
      }
    } catch (error) {
      if (error instanceof DefiniteEvidenceMismatch) throw error;
      throw new IndeterminateEvidence(`${label} file ${name}`, { cause: error });
    }
  }
  await assertStableDirectory(directory, label);
  return Object.freeze({ directory, names: Object.freeze([...names].sort()) });
}

async function assertExactFileShapeDirectory(evidence, label) {
  const current = await captureExactFileShapeDirectory(
    evidence.directory.path,
    evidence.names,
    label,
  );
  if (!sameIdentity(evidence.directory, current.directory)) {
    throw new IndeterminateEvidence(label);
  }
}

async function captureManagedArtifactDirectory(path, label) {
  const directory = await captureStableDirectory(path, label);
  if (ACCEPTANCE_FILES.some((name) => !directory.names.includes(name))) {
    throw new DefiniteEvidenceMismatch(label);
  }
  const files = new Map();
  for (const name of ACCEPTANCE_FILES) {
    files.set(name, await readRequiredFrozenFile(join(path, name), `${label} file ${name}`));
  }
  await assertStableDirectory(directory, label);
  return Object.freeze({
    directory,
    snapshot: Object.freeze({
      path,
      dev: directory.dev,
      ino: directory.ino,
      names: ACCEPTANCE_FILES,
      files,
    }),
  });
}

async function assertManagedArtifactDirectory(evidence, label) {
  await assertStableDirectory(evidence.directory, label);
  await Promise.all(ACCEPTANCE_FILES.map((name) => (
    assertFrozenRegularFile(evidence.snapshot.files.get(name), `${label} file ${name}`)
  )));
}

function artifactView(snapshot) {
  return Object.freeze({
    directory: Object.freeze({ path: snapshot.path, dev: snapshot.dev, ino: snapshot.ino }),
    names: ACCEPTANCE_FILES,
    files: new Map(ACCEPTANCE_FILES.map((name) => [name, snapshot.files.get(name)])),
  });
}

function requireSameArtifactBytes(left, right) {
  for (const name of ACCEPTANCE_FILES) {
    const leftFile = left.files.get(name);
    const rightFile = right.files.get(name);
    if (leftFile === undefined || rightFile === undefined || !leftFile.bytes.equals(rightFile.bytes)) {
      throw new DefiniteEvidenceMismatch("Installed acceptance artifact");
    }
  }
}

async function captureArtifactEvidence(repoRoot, vaultPath, receipt) {
  const source = await captureExactFileDirectory(
    join(repoRoot, "dist", "read-only-acceptance"),
    ACCEPTANCE_FILES,
    "Current acceptance artifact",
  );
  const target = await captureManagedArtifactDirectory(
    join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", PLUGIN_ID),
    "Installed acceptance target",
  );
  const sourceView = artifactView(source.snapshot);
  const targetView = artifactView(target.snapshot);
  let sourceIdentity;
  let targetIdentity;
  let sourceDigest;
  let targetDigest;
  try {
    sourceIdentity = validateAcceptanceArtifactSnapshot(sourceView);
    targetIdentity = validateAcceptanceArtifactSnapshot(targetView);
    sourceDigest = computeAcceptanceArtifactSetDigest(sourceView);
    targetDigest = computeAcceptanceArtifactSetDigest(targetView);
  } catch (error) {
    throw new DefiniteEvidenceMismatch("Acceptance artifact", { cause: error });
  }
  if (
    sourceIdentity.pluginVersion !== receipt.pluginVersion
    || targetIdentity.pluginVersion !== receipt.pluginVersion
    || sourceIdentity.artifactBinding !== receipt.artifactBinding
    || targetIdentity.artifactBinding !== receipt.artifactBinding
    || sourceDigest !== receipt.artifactSetDigest
    || targetDigest !== receipt.artifactSetDigest
  ) {
    throw new DefiniteEvidenceMismatch("Acceptance artifact identity");
  }
  requireSameArtifactBytes(source.snapshot, target.snapshot);
  return Object.freeze({ source, target, targetView });
}

async function captureBoundaryEvidence(vaultPath) {
  const vault = await captureStableDirectory(vaultPath, "Synthetic acceptance vault");
  requireExactNames(
    vault,
    [TEST_VAULT_MARKER_FILE, OBSIDIAN_CONFIG_DIRECTORY, SYNTHETIC_CONTENT_DIRECTORY],
    "Synthetic acceptance vault top level",
  );
  const generated = await captureStableDirectory(
    join(vaultPath, SYNTHETIC_CONTENT_DIRECTORY),
    "Synthetic content directory",
  );
  const obsidian = await captureStableDirectory(
    join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY),
    "Synthetic acceptance configuration directory",
  );
  requireAllowedNames(
    obsidian,
    [COMMUNITY_PLUGINS_FILE, "plugins"],
    POST_HOST_CONFIGURATION_NAMES,
    "Synthetic acceptance configuration boundary",
  );
  const plugins = await captureStableDirectory(
    join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins"),
    "Synthetic acceptance plugins directory",
  );
  requireExactNames(plugins, [PLUGIN_ID], "Synthetic acceptance plugins boundary");
  const marker = await readRequiredFrozenFile(
    join(vaultPath, TEST_VAULT_MARKER_FILE),
    "Dedicated test-vault marker",
  );
  if (!marker.bytes.equals(MARKER_BYTES)) throw new DefiniteEvidenceMismatch("Dedicated test-vault marker");
  const communityPlugins = await readRequiredFrozenFile(
    join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, COMMUNITY_PLUGINS_FILE),
    "community-plugins.json",
  );
  if (!EMPTY_COMMUNITY_BYTES.some((expected) => communityPlugins.bytes.equals(expected))) {
    throw new DefiniteEvidenceMismatch("Empty community-plugin boundary");
  }
  const optionalConfigurations = [];
  for (const name of obsidian.names) {
    if (name === COMMUNITY_PLUGINS_FILE || name === "plugins") continue;
    optionalConfigurations.push(await readRequiredFrozenFile(
      join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, name),
      `Post-host configuration ${name}`,
    ));
  }
  const target = await captureExactFileShapeDirectory(
    join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", PLUGIN_ID),
    TARGET_FILES,
    "Installed acceptance target shape",
  );
  return Object.freeze({
    vault,
    generated,
    obsidian,
    plugins,
    marker,
    communityPlugins,
    optionalConfigurations: Object.freeze(optionalConfigurations),
    target,
  });
}

async function assertBoundaryEvidence(evidence) {
  await assertStableDirectory(evidence.vault, "Synthetic acceptance vault");
  await assertStableDirectory(evidence.generated, "Synthetic content directory");
  await assertStableDirectory(evidence.obsidian, "Synthetic acceptance configuration directory");
  await assertStableDirectory(evidence.plugins, "Synthetic acceptance plugins directory");
  await assertFrozenRegularFile(evidence.marker, "Dedicated test-vault marker");
  await assertFrozenRegularFile(evidence.communityPlugins, "community-plugins.json");
  await Promise.all(evidence.optionalConfigurations.map((snapshot) => (
    assertFrozenRegularFile(snapshot, "Post-host configuration")
  )));
  await assertExactFileShapeDirectory(evidence.target, "Installed acceptance target shape");
}

async function captureLegacySentinel(devRoot) {
  const directory = await captureStableDirectory(devRoot, "Acceptance evidence directory");
  const file = directory.names.includes(LEGACY_ACCEPTANCE_REPORT_FILE)
    ? await readRequiredFrozenFile(
      join(devRoot, LEGACY_ACCEPTANCE_REPORT_FILE),
      "Legacy normal-mode acceptance sentinel",
    )
    : null;
  await assertStableDirectory(directory, "Acceptance evidence directory");
  return Object.freeze({ directory, file });
}

async function assertLegacySentinel(evidence) {
  await assertStableDirectory(evidence.directory, "Acceptance evidence directory");
  if (evidence.file !== null) {
    await assertFrozenRegularFile(evidence.file, "Legacy normal-mode acceptance sentinel");
  }
}

async function walkOwnedPaths(root) {
  const paths = [];
  async function visit(directory) {
    const snapshot = await captureStableDirectory(directory, "Synthetic content tree");
    for (const name of snapshot.names) {
      const path = join(directory, name);
      let stat;
      try {
        stat = await lstat(path, { bigint: true });
      } catch (error) {
        throw new IndeterminateEvidence("Synthetic content tree", { cause: error });
      }
      if (
        stat.isSymbolicLink()
        || (!stat.isDirectory() && !stat.isFile())
        || (stat.isFile() && stat.nlink !== 1n)
      ) {
        throw new DefiniteEvidenceMismatch("Synthetic content tree entry type");
      }
      const relativePath = relative(root, path);
      if (
        relativePath.length === 0
        || relativePath === ".."
        || relativePath.startsWith(`..${sep}`)
      ) {
        throw new DefiniteEvidenceMismatch("Synthetic content tree path");
      }
      paths.push(relativePath);
      if (stat.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return Object.freeze(paths.sort());
}

function uint64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function digestCurrentCorpus(files) {
  const hash = createHash("sha256");
  hash.update(CORPUS_DOMAIN);
  const entries = files.map((file) => Object.freeze({
    pathBytes: Buffer.from(`${SYNTHETIC_CONTENT_DIRECTORY}/${file.path}`, "utf8"),
    contentBytes: file.snapshot.bytes,
  })).sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  for (const entry of entries) {
    hash.update(uint64(entry.pathBytes.byteLength));
    hash.update(entry.pathBytes);
    hash.update(uint64(entry.contentBytes.byteLength));
    hash.update(entry.contentBytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function sameTreeFile(treeEntry, snapshot) {
  return treeEntry?.type === "file"
    && treeEntry.dev === snapshot.evidence.dev
    && treeEntry.ino === snapshot.evidence.ino
    && treeEntry.nlink === snapshot.evidence.nlink
    && treeEntry.size === snapshot.evidence.size
    && treeEntry.sha256 === snapshot.evidence.sha256;
}

async function captureContentEvidence(vaultPath, state) {
  const root = join(vaultPath, SYNTHETIC_CONTENT_DIRECTORY);
  const discovered = await walkOwnedPaths(root);
  let tree;
  try {
    tree = await snapshotOwnedTree(root, discovered, "Synthetic acceptance content");
  } catch (error) {
    throw new IndeterminateEvidence("Synthetic acceptance content", { cause: error });
  }

  const filePaths = discovered.filter((path) => tree.entries.get(path)?.type === "file");
  const directoryPaths = discovered.filter((path) => tree.entries.get(path)?.type === "directory");
  const requiredDirectories = new Set();
  for (const path of filePaths) {
    if (!path.endsWith(".md")) throw new DefiniteEvidenceMismatch("Synthetic content file type");
    const components = path.split(sep);
    for (let index = 1; index < components.length; index += 1) {
      requiredDirectories.add(components.slice(0, index).join(sep));
    }
  }
  if (!isDeepStrictEqual(directoryPaths, [...requiredDirectories].sort())) {
    throw new DefiniteEvidenceMismatch("Synthetic content directory paths");
  }

  const files = [];
  const batchSize = 24;
  for (let offset = 0; offset < filePaths.length; offset += batchSize) {
    const batch = filePaths.slice(offset, offset + batchSize);
    const snapshots = await Promise.all(batch.map(async (path) => Object.freeze({
      path,
      snapshot: await readRequiredFrozenFile(
        join(root, path),
        `Synthetic content file ${path}`,
      ),
    })));
    for (const file of snapshots) {
      if (!sameTreeFile(tree.entries.get(file.path), file.snapshot)) {
        throw new IndeterminateEvidence("Synthetic content file continuity");
      }
      files.push(file);
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + Number(file.snapshot.evidence.size), 0);
  if (
    files.length !== state.syntheticNoteCount
    || totalBytes !== state.syntheticTotalBytes
    || digestCurrentCorpus(files) !== state.corpusDigest
  ) {
    throw new DefiniteEvidenceMismatch("Synthetic content aggregate");
  }
  return tree;
}

function fixtureContractEvidence(state) {
  let fixture;
  try {
    fixture = generateAcceptanceFixture();
  } catch (error) {
    throw new DefiniteEvidenceMismatch("Synthetic fixture generator", { cause: error });
  }
  const corpusDigest = computeSyntheticCorpusDigest(fixture.notes);
  if (
    fixture.noteCount !== SYNTHETIC_ACCEPTANCE_NOTE_COUNT
    || fixture.totalBytes !== SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES
    || state.syntheticNoteCount !== SYNTHETIC_ACCEPTANCE_NOTE_COUNT
    || state.syntheticTotalBytes !== SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES
    || state.corpusDigest !== corpusDigest
  ) {
    throw new DefiniteEvidenceMismatch("Synthetic fixture identity");
  }
  return true;
}

function requireCanonicalSeedReceipt(receipt) {
  if (receipt.seedDataDigest !== sha256(SEED_BYTES)) {
    throw new DefiniteEvidenceMismatch("Synthetic plugin-data seed receipt");
  }
  return true;
}

async function captureInstalledData(vaultPath) {
  const targetPath = join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", PLUGIN_ID);
  const directory = await captureStableDirectory(targetPath, "Installed plugin-data boundary");
  if (!directory.names.includes("data.json")) {
    throw new DefiniteEvidenceMismatch("Installed plugin data");
  }
  const file = await readRequiredFrozenFile(join(targetPath, "data.json"), "Installed plugin data");
  await assertStableDirectory(directory, "Installed plugin-data boundary");
  return Object.freeze({ directory, file });
}

async function assertInstalledData(evidence) {
  await assertStableDirectory(evidence.directory, "Installed plugin-data boundary");
  await assertFrozenRegularFile(evidence.file, "Installed plugin data");
}

function inspectDataEvidence(captured, seedReceiptStatus) {
  if (captured.status === "inconclusive") {
    return Object.freeze({
      startupNormalizationEvidence: "indeterminate",
      historySensitiveActionsBlocked: "inconclusive",
      recoveryAbsent: "inconclusive",
    });
  }
  if (captured.status === "failed" || captured.value === null) {
    return Object.freeze({
      startupNormalizationEvidence: "unsafe",
      historySensitiveActionsBlocked: "failed",
      recoveryAbsent: "inconclusive",
    });
  }
  let inspected;
  try {
    inspected = inspectPostHostPluginData(captured.value.file.bytes);
  } catch {
    return Object.freeze({
      startupNormalizationEvidence: "unsafe",
      historySensitiveActionsBlocked: "failed",
      recoveryAbsent: "inconclusive",
    });
  }
  const seededProvenance = seedReceiptStatus === "passed";
  return Object.freeze({
    startupNormalizationEvidence: seededProvenance
      ? inspected.startupNormalizationEvidence
      : "indeterminate",
    historySensitiveActionsBlocked: seededProvenance
      ? (inspected.seededJournalPresent ? "passed" : "failed")
      : "inconclusive",
    recoveryAbsent: inspected.recoveryAbsent ? "passed" : "failed",
  });
}

function networkEvidence(...snapshots) {
  let observed = false;
  for (const snapshot of snapshots) {
    const bundle = snapshot?.files.get("main.js")?.bytes;
    if (!Buffer.isBuffer(bundle)) continue;
    observed = true;
    const text = bundle.toString("utf8");
    if (FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT.some((forbidden) => text.includes(forbidden))) {
      return "failed";
    }
  }
  return observed ? "passed" : "inconclusive";
}

function isCompletedAssertionFailure(error, stdout, stderr) {
  if (
    typeof error.code !== "number"
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
  });
}

async function captureRunAnchor(repoRoot) {
  const worktree = await resolveCanonicalWorktree(repoRoot);
  requireCanonicalRepoRoot(repoRoot, worktree.repoRoot);
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
    throw new Error("Read-only acceptance state and receipt do not form a current run anchor");
  }
  await assertFrozenRegularFile(stateFile, "Read-only acceptance preparation state");
  await assertFrozenRegularFile(receiptFile, "Read-only acceptance installation receipt");
  await assertCleanGitState(worktree.repoRoot, git.commit);
  return Object.freeze({ worktree, git, stateFile, receiptFile, state, receipt });
}

async function assertRunAnchor(anchor) {
  await assertFrozenRegularFile(anchor.stateFile, "Read-only acceptance preparation state");
  await assertFrozenRegularFile(anchor.receiptFile, "Read-only acceptance installation receipt");
  await assertCleanGitState(anchor.worktree.repoRoot, anchor.git.commit);
}

export async function gatherLocalAcceptanceEvidence(repoRoot) {
  const anchor = await captureRunAnchor(repoRoot);
  const vaultPath = join(anchor.worktree.repoRoot, SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH);

  const fixtureContract = await captureGate(async () => fixtureContractEvidence(anchor.state));
  const seedReceipt = await captureGate(async () => requireCanonicalSeedReceipt(anchor.receipt));
  const boundary = await captureGate(async () => captureBoundaryEvidence(vaultPath));
  const legacySentinel = await captureGate(async () => captureLegacySentinel(anchor.worktree.devRoot));
  const artifact = await captureGate(async () => captureArtifactEvidence(
    anchor.worktree.repoRoot,
    vaultPath,
    anchor.receipt,
  ));
  const capturedData = await captureGate(async () => captureInstalledData(vaultPath));
  const content = await captureGate(async () => captureContentEvidence(vaultPath, anchor.state));
  const automatedSafety = await runAutomatedSafety(anchor.worktree.repoRoot);

  let boundaryContinuity = "passed";
  if (boundary.value !== null) {
    try {
      await assertBoundaryEvidence(boundary.value);
    } catch {
      boundaryContinuity = "inconclusive";
    }
  }
  let artifactContinuity = "passed";
  if (artifact.value !== null) {
    try {
      await assertExactDirectory(artifact.value.source.snapshot, "Current acceptance artifact");
      await assertManagedArtifactDirectory(artifact.value.target, "Installed acceptance target");
    } catch {
      artifactContinuity = "inconclusive";
    }
  }
  let dataContinuity = "passed";
  if (capturedData.value !== null) {
    try {
      await assertInstalledData(capturedData.value);
    } catch {
      dataContinuity = "inconclusive";
    }
  }
  let contentContinuity = "passed";
  if (content.value !== null) {
    try {
      await assertOwnedTree(content.value, "Synthetic acceptance content");
    } catch {
      contentContinuity = "inconclusive";
    }
  }
  let legacyContinuity = "passed";
  if (legacySentinel.value !== null) {
    try {
      await assertLegacySentinel(legacySentinel.value);
    } catch {
      legacyContinuity = "inconclusive";
    }
  }
  await assertRunAnchor(anchor);

  const artifactIdentity = worstStatus(artifact.status, artifactContinuity);
  const fixtureIdentity = worstStatus(
    fixtureContract.status,
    seedReceipt.status,
    boundary.status,
    boundaryContinuity,
    legacySentinel.status,
    legacyContinuity,
  );
  const contentUnchanged = worstStatus(content.status, contentContinuity);
  const data = dataContinuity === "passed"
    ? inspectDataEvidence(capturedData, seedReceipt.status)
    : Object.freeze({
      startupNormalizationEvidence: "indeterminate",
      historySensitiveActionsBlocked: "inconclusive",
      recoveryAbsent: "inconclusive",
    });
  const settingsFloor = startupFloor(data.startupNormalizationEvidence);
  const hostIsolation = worstStatus(
    boundary.status,
    boundaryContinuity,
    data.startupNormalizationEvidence === "seed-unchanged" ? "inconclusive" : "passed",
  );
  const networkBoundary = worstStatus(
    networkEvidence(
      artifact.value?.source.snapshot,
      artifact.value?.target.snapshot,
    ),
    artifactContinuity,
  );
  const finalHostStopped = worstStatus(
    artifactIdentity,
    fixtureIdentity,
    contentUnchanged,
    settingsFloor,
    boundary.status,
    boundaryContinuity,
  );

  return Object.freeze({
    runId: anchor.state.runId,
    commit: anchor.state.commit,
    pluginVersion: anchor.receipt.pluginVersion,
    artifactBinding: anchor.receipt.artifactBinding,
    syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
    artifactIdentity,
    fixtureIdentity,
    automatedSafety,
    contentUnchanged,
    startupNormalizationEvidence: data.startupNormalizationEvidence,
    hostIsolation,
    historySensitiveActionsBlocked: data.historySensitiveActionsBlocked,
    networkBoundary,
    recoveryAbsent: data.recoveryAbsent,
    finalHostStopped,
  });
}

function requireSavedNoBetter(saved, floor, label) {
  if (STATUS_RANK[saved] < STATUS_RANK[floor]) {
    throw new Error(`Saved report ${label} is better than current local evidence`);
  }
}

export async function validateReportAgainstCurrentEvidence(repoRoot, report) {
  encodeReadOnlyAcceptanceReport(report);
  const current = await gatherLocalAcceptanceEvidence(repoRoot);
  if (
    report.runId !== current.runId
    || report.commit !== current.commit
    || report.pluginVersion !== current.pluginVersion
    || report.artifactBinding !== current.artifactBinding
    || report.syntheticNoteCount !== current.syntheticNoteCount
  ) {
    throw new Error("Saved report identity does not match current acceptance evidence");
  }
  for (const gate of LOCAL_ONLY_GATES) {
    if (report[gate] !== current[gate]) {
      throw new Error(`Saved report ${gate} does not equal current local evidence`);
    }
  }
  for (const gate of LOCAL_COMPOSITE_GATES) {
    requireSavedNoBetter(report[gate], current[gate], gate);
  }
  requireSavedNoBetter(
    report.startupNormalization,
    startupFloor(current.startupNormalizationEvidence),
    "startupNormalization",
  );
  requireSavedNoBetter(report.readSurfaces, timingFloor(report.scanElapsedMs), "readSurfaces");
  requireSavedNoBetter(
    report.restartRestore,
    timingFloor(report.restartRestoreElapsedMs),
    "restartRestore",
  );
  if (report.status !== computeReportStatus(report)) {
    throw new Error("Saved report status does not match its final gates");
  }
  const categories = deriveFailureCategories(report);
  if (!isDeepStrictEqual(report.failureCategories, categories)) {
    throw new Error("Saved report failure categories do not match its final gates");
  }
}
