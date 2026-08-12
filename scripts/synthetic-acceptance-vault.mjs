import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ACCEPTANCE_FILES,
  validateAcceptanceArtifactSnapshot,
} from "./acceptance-artifact-contract.mjs";
import {
  assertDirectoryInOwnedTree,
  assertExactDirectory,
  assertExactDirectoryInOwnedTree,
  assertFrozenRegularFile,
  assertFrozenRegularFileInOwnedTree,
  assertOwnedTree,
  readFrozenRegularFile,
  snapshotExactDirectory,
  snapshotOwnedTree,
} from "./safe-fs-core.mjs";
import {
  OBSIDIAN_CONFIG_DIRECTORY,
  TEST_VAULT_MARKER_FILE,
  assertDisabledCommunityPlugins,
  freezeDisabledCommunityPlugins,
  validateSyntheticVaultMarker,
} from "./synthetic-vault-install-core.mjs";
import {
  SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
  SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
  SYNTHETIC_CONTENT_DIRECTORY,
  computeSyntheticCorpusDigest,
  generateAcceptanceFixture,
} from "./synthetic-note-fixture.mjs";
import { decodeSyntheticPluginDataSeed } from "./synthetic-acceptance-data.mjs";

const PLUGIN_ID = "knowledge-workbench";
const COMMUNITY_PLUGINS_FILE = "community-plugins.json";
const INSTALL_DESTINATION_LOCK = ".knowledge-workbench-read-only-acceptance.lock";
const INSTALL_STAGE_PREFIX = ".knowledge-workbench-read-only-acceptance.stage-";
const INSTALL_STAGE_NAME_PATTERN = /^\.knowledge-workbench-read-only-acceptance\.stage-[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTALL_STATES = new Set([
  "lock-held",
  "stage-empty",
  "stage-four",
  "target-four",
  "target-five",
]);
const INSTALL_STAGE_STATES = new Set(["stage-empty", "stage-four"]);
const INSTALLED_TARGET_FILES = Object.freeze([
  ...ACCEPTANCE_FILES,
  "data.json",
].sort());
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

async function assertCanonicalDirectory(path, label) {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path) {
    throw new Error(`${label} must be a canonical non-symlink directory`);
  }
}

async function assertCanonicalVaultDirectoryChain(vaultPath) {
  await assertCanonicalDirectory(vaultPath, "Synthetic acceptance vault");
  const obsidian = join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY);
  await assertCanonicalDirectory(obsidian, "Synthetic acceptance configuration directory");
  await assertCanonicalDirectory(
    join(obsidian, "plugins"),
    "Synthetic acceptance plugins directory",
  );
}

function requireInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Synthetic acceptance attestation input must be an object");
  }
  if (typeof input.vaultPath !== "string" || !isAbsolute(input.vaultPath)) {
    throw new Error("Synthetic acceptance vault path must be absolute");
  }
  if (input.phase !== "prepared" && input.phase !== "post-host") {
    throw new Error("Synthetic acceptance phase must be prepared or post-host");
  }
}

function exactPlainDataValues(value, label, requiredKeys, optionalKeys = []) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only exact string keys`);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} must contain only the exact required own keys`);
  }
  const entries = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError(`${label} keys must be data properties; accessors are not allowed`);
    }
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function requireInstallExpected(value) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Synthetic install expected evidence must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const requiredKeys = ["syntheticNoteCount", "syntheticTotalBytes", "corpusDigest"];
  if (
    keys.some((key) => typeof key !== "string")
    || requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors[key], "value"))
  ) {
    throw new TypeError("Synthetic install expected evidence must use own data properties");
  }
  const expected = Object.freeze(Object.fromEntries(requiredKeys.map((key) => (
    [key, descriptors[key].value]
  ))));
  if (
    !Number.isSafeInteger(expected.syntheticNoteCount)
    || !Number.isSafeInteger(expected.syntheticTotalBytes)
    || typeof expected.corpusDigest !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(expected.corpusDigest)
  ) {
    throw new TypeError("Synthetic install expected evidence has invalid data values");
  }
  return expected;
}

function requireInstallInput(input) {
  const values = exactPlainDataValues(
    input,
    "Synthetic acceptance install-state attestation input",
    ["vaultPath", "state"],
    ["expected", "stageName"],
  );
  if (typeof values.vaultPath !== "string" || !isAbsolute(values.vaultPath)) {
    throw new TypeError("Synthetic acceptance install-state vault path must be absolute");
  }
  if (typeof values.state !== "string" || !INSTALL_STATES.has(values.state)) {
    throw new TypeError("Synthetic acceptance install state is unknown");
  }
  const hasStageName = Object.prototype.hasOwnProperty.call(values, "stageName");
  if (INSTALL_STAGE_STATES.has(values.state)) {
    if (
      !hasStageName
      || typeof values.stageName !== "string"
      || !values.stageName.startsWith(INSTALL_STAGE_PREFIX)
      || !INSTALL_STAGE_NAME_PATTERN.test(values.stageName)
    ) {
      throw new TypeError("Synthetic acceptance install stage name must use the exact fixed stage basename");
    }
  } else if (hasStageName) {
    throw new TypeError("Synthetic acceptance install stage name is accepted only for a stage state");
  }
  const hasExpected = Object.prototype.hasOwnProperty.call(values, "expected");
  return Object.freeze({
    vaultPath: values.vaultPath,
    state: values.state,
    ...(hasExpected ? { expected: requireInstallExpected(values.expected) } : {}),
    ...(hasStageName ? { stageName: values.stageName } : {}),
  });
}

async function discoverPostHostConfiguration(obsidian) {
  const stat = await lstat(obsidian, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Post-host configuration root must be a non-symlink directory");
  }
  const names = (await readdir(obsidian)).sort();
  if (!names.includes(COMMUNITY_PLUGINS_FILE) || !names.includes("plugins")) {
    throw new Error("Post-host configuration is missing community-plugins.json or plugins");
  }
  for (const name of names) {
    if (!POST_HOST_CONFIGURATION_NAMES.has(name)) {
      throw new Error(`Post-host configuration filename is outside the allowlist: ${name}`);
    }
  }
  return names;
}

function fixtureAllowlist(fixture, phase, configurationNames) {
  const paths = [
    TEST_VAULT_MARKER_FILE,
    OBSIDIAN_CONFIG_DIRECTORY,
    join(OBSIDIAN_CONFIG_DIRECTORY, COMMUNITY_PLUGINS_FILE),
    join(OBSIDIAN_CONFIG_DIRECTORY, "plugins"),
    SYNTHETIC_CONTENT_DIRECTORY,
  ];
  for (const note of fixture.notes) {
    paths.push(note.path.slice(0, note.path.lastIndexOf("/")));
    paths.push(note.path);
  }
  if (phase === "post-host") {
    for (const name of configurationNames) {
      if (name !== COMMUNITY_PLUGINS_FILE && name !== "plugins") {
        paths.push(join(OBSIDIAN_CONFIG_DIRECTORY, name));
      }
    }
    const target = join(OBSIDIAN_CONFIG_DIRECTORY, "plugins", PLUGIN_ID);
    paths.push(target);
    for (const name of INSTALLED_TARGET_FILES) paths.push(join(target, name));
  }
  return paths;
}

function installStateFixtureAllowlist(fixture, input) {
  const paths = fixtureAllowlist(
    fixture,
    "prepared",
    [COMMUNITY_PLUGINS_FILE, "plugins"],
  );
  const plugins = join(OBSIDIAN_CONFIG_DIRECTORY, "plugins");
  paths.push(join(plugins, INSTALL_DESTINATION_LOCK));
  if (input.state === "stage-empty" || input.state === "stage-four") {
    const stage = join(plugins, input.stageName);
    paths.push(stage);
    if (input.state === "stage-four") {
      for (const name of ACCEPTANCE_FILES) paths.push(join(stage, name));
    }
  }
  if (input.state === "target-four" || input.state === "target-five") {
    const target = join(plugins, PLUGIN_ID);
    paths.push(target);
    const names = input.state === "target-five" ? INSTALLED_TARGET_FILES : ACCEPTANCE_FILES;
    for (const name of names) paths.push(join(target, name));
  }
  return paths;
}

function validateExactEmptyCommunityPlugins(snapshot) {
  const entries = JSON.parse(snapshot.bytes.toString("utf8"));
  if (entries.length !== 0) {
    throw new Error("community-plugins.json must contain the exact empty array");
  }
}

function validateInstalledTargetSnapshot(snapshot) {
  const files = new Map();
  for (const name of ACCEPTANCE_FILES) files.set(name, snapshot.files.get(name));
  validateAcceptanceArtifactSnapshot(Object.freeze({
    directory: Object.freeze({ path: snapshot.path, dev: snapshot.dev, ino: snapshot.ino }),
    names: ACCEPTANCE_FILES,
    files,
  }));
}

async function snapshotInstalledTarget(vaultPath) {
  const target = join(
    vaultPath,
    OBSIDIAN_CONFIG_DIRECTORY,
    "plugins",
    PLUGIN_ID,
  );
  const snapshot = await snapshotExactDirectory(
    target,
    INSTALLED_TARGET_FILES,
    "Installed acceptance target",
  );
  validateInstalledTargetSnapshot(snapshot);
  return snapshot;
}

async function snapshotInstallStateObjects(input, marker) {
  const obsidian = join(input.vaultPath, OBSIDIAN_CONFIG_DIRECTORY);
  const plugins = join(obsidian, "plugins");
  const destinationLock = await readFrozenRegularFile(
    join(plugins, INSTALL_DESTINATION_LOCK),
    "Synthetic acceptance destination lock",
  );
  const communityPlugins = await freezeDisabledCommunityPlugins(obsidian);
  validateExactEmptyCommunityPlugins(communityPlugins);

  let emptyStage = null;
  let artifactDirectory = null;
  let artifactRelativePath = null;
  if (input.state === "stage-empty") {
    emptyStage = await snapshotOwnedTree(
      join(plugins, input.stageName),
      [],
      "Empty synthetic acceptance install stage",
    );
  } else if (input.state === "stage-four") {
    artifactRelativePath = join(OBSIDIAN_CONFIG_DIRECTORY, "plugins", input.stageName);
    artifactDirectory = await snapshotExactDirectory(
      join(plugins, input.stageName),
      ACCEPTANCE_FILES,
      "Synthetic acceptance install stage",
    );
    validateInstalledTargetSnapshot(artifactDirectory);
  } else if (input.state === "target-four" || input.state === "target-five") {
    artifactRelativePath = join(OBSIDIAN_CONFIG_DIRECTORY, "plugins", PLUGIN_ID);
    artifactDirectory = await snapshotExactDirectory(
      join(plugins, PLUGIN_ID),
      input.state === "target-five" ? INSTALLED_TARGET_FILES : ACCEPTANCE_FILES,
      "Synthetic acceptance install target",
    );
    validateInstalledTargetSnapshot(artifactDirectory);
    if (input.state === "target-five") {
      decodeSyntheticPluginDataSeed(artifactDirectory.files.get("data.json").bytes);
    }
  }

  return Object.freeze({
    marker,
    communityPlugins,
    destinationLock,
    emptyStage,
    emptyStageRelativePath: emptyStage === null
      ? null
      : join(OBSIDIAN_CONFIG_DIRECTORY, "plugins", input.stageName),
    artifactDirectory,
    artifactRelativePath,
  });
}

function bindInstallStateSnapshots(tree, snapshots) {
  assertFrozenRegularFileInOwnedTree(
    tree,
    TEST_VAULT_MARKER_FILE,
    snapshots.marker,
    "Dedicated test-vault marker",
  );
  assertFrozenRegularFileInOwnedTree(
    tree,
    join(OBSIDIAN_CONFIG_DIRECTORY, COMMUNITY_PLUGINS_FILE),
    snapshots.communityPlugins,
    "community-plugins.json",
  );
  assertFrozenRegularFileInOwnedTree(
    tree,
    join(OBSIDIAN_CONFIG_DIRECTORY, "plugins", INSTALL_DESTINATION_LOCK),
    snapshots.destinationLock,
    "Synthetic acceptance destination lock",
  );
  if (snapshots.emptyStage !== null) {
    assertDirectoryInOwnedTree(
      tree,
      snapshots.emptyStageRelativePath,
      snapshots.emptyStage.root,
      "Empty synthetic acceptance install stage",
    );
  }
  if (snapshots.artifactDirectory !== null) {
    assertExactDirectoryInOwnedTree(
      tree,
      snapshots.artifactRelativePath,
      snapshots.artifactDirectory,
      "Synthetic acceptance transient artifact directory",
    );
  }
}

async function assertInstallStateSnapshots(snapshots) {
  await assertFrozenRegularFile(snapshots.marker, "Dedicated test-vault marker");
  await assertDisabledCommunityPlugins(snapshots.communityPlugins);
  await assertFrozenRegularFile(
    snapshots.destinationLock,
    "Synthetic acceptance destination lock",
  );
  if (snapshots.emptyStage !== null) {
    await assertOwnedTree(snapshots.emptyStage, "Empty synthetic acceptance install stage");
  }
  if (snapshots.artifactDirectory !== null) {
    await assertExactDirectory(
      snapshots.artifactDirectory,
      "Synthetic acceptance transient artifact directory",
    );
    validateInstalledTargetSnapshot(snapshots.artifactDirectory);
    const seed = snapshots.artifactDirectory.files.get("data.json");
    if (seed !== undefined) decodeSyntheticPluginDataSeed(seed.bytes);
  }
}

function bindSemanticSnapshots(tree, snapshots) {
  assertFrozenRegularFileInOwnedTree(
    tree,
    TEST_VAULT_MARKER_FILE,
    snapshots.marker,
    "Dedicated test-vault marker",
  );
  assertFrozenRegularFileInOwnedTree(
    tree,
    join(OBSIDIAN_CONFIG_DIRECTORY, COMMUNITY_PLUGINS_FILE),
    snapshots.communityPlugins,
    "community-plugins.json",
  );
  for (const configuration of snapshots.optionalConfigurations) {
    assertFrozenRegularFileInOwnedTree(
      tree,
      join(OBSIDIAN_CONFIG_DIRECTORY, configuration.name),
      configuration.snapshot,
      `Post-host configuration file ${configuration.name}`,
    );
  }
  if (snapshots.preparedPlugins !== null) {
    assertDirectoryInOwnedTree(
      tree,
      join(OBSIDIAN_CONFIG_DIRECTORY, "plugins"),
      snapshots.preparedPlugins.root,
      "Prepared plugins directory",
    );
  }
  if (snapshots.installedTarget !== null) {
    assertExactDirectoryInOwnedTree(
      tree,
      join(OBSIDIAN_CONFIG_DIRECTORY, "plugins", PLUGIN_ID),
      snapshots.installedTarget,
      "Installed acceptance target",
    );
  }
}

async function assertSemanticSnapshots(snapshots) {
  await assertFrozenRegularFile(snapshots.marker, "Dedicated test-vault marker");
  await assertDisabledCommunityPlugins(snapshots.communityPlugins);
  for (const configuration of snapshots.optionalConfigurations) {
    await assertFrozenRegularFile(
      configuration.snapshot,
      `Post-host configuration file ${configuration.name}`,
    );
  }
  if (snapshots.preparedPlugins !== null) {
    await assertOwnedTree(snapshots.preparedPlugins, "Prepared plugins directory");
  }
  if (snapshots.installedTarget !== null) {
    await assertExactDirectory(snapshots.installedTarget, "Installed acceptance target");
    validateInstalledTargetSnapshot(snapshots.installedTarget);
  }
}

function evidenceForFixture(tree, fixture) {
  let noteCount = 0;
  let totalBytes = 0;
  for (const note of fixture.notes) {
    const entry = tree.entries.get(note.path);
    const expectedBytes = Buffer.from(note.content, "utf8");
    const expectedDigest = createHash("sha256").update(expectedBytes).digest("hex");
    if (
      entry?.type !== "file"
      || entry.size !== BigInt(expectedBytes.byteLength)
      || entry.sha256 !== expectedDigest
    ) {
      throw new Error("Synthetic note bytes do not match the fixed corpus");
    }
    noteCount += 1;
    totalBytes += Number(entry.size);
  }
  return Object.freeze({ noteCount, totalBytes });
}

function assertExpected(expected, evidence) {
  if (expected === undefined) return;
  if (
    expected.syntheticNoteCount !== evidence.syntheticNoteCount
    || expected.syntheticTotalBytes !== evidence.syntheticTotalBytes
    || expected.corpusDigest !== evidence.corpusDigest
  ) {
    throw new Error("Synthetic acceptance evidence does not match the expected corpus");
  }
}

export async function attestSyntheticAcceptanceVault(input) {
  requireInput(input);
  await assertCanonicalVaultDirectoryChain(input.vaultPath);
  const marker = await validateSyntheticVaultMarker(input.vaultPath);
  const fixture = generateAcceptanceFixture();
  const obsidian = join(input.vaultPath, OBSIDIAN_CONFIG_DIRECTORY);
  const configurationNames = input.phase === "post-host"
    ? await discoverPostHostConfiguration(obsidian)
    : [COMMUNITY_PLUGINS_FILE, "plugins"];
  const tree = await snapshotOwnedTree(
    input.vaultPath,
    fixtureAllowlist(fixture, input.phase, configurationNames),
    "Synthetic acceptance vault",
  );
  await assertFrozenRegularFile(marker, "Dedicated test-vault marker");
  const preparedPlugins = input.phase === "prepared"
    ? await snapshotOwnedTree(
      join(obsidian, "plugins"),
      [],
      "Prepared plugins directory",
    )
    : null;
  const optionalConfigurations = input.phase === "post-host"
    ? await Promise.all(configurationNames
      .filter((name) => name !== COMMUNITY_PLUGINS_FILE && name !== "plugins")
      .map(async (name) => Object.freeze({
        name,
        snapshot: await readFrozenRegularFile(
          join(obsidian, name),
          `Post-host configuration file ${name}`,
        ),
      })))
    : [];

  const communityPlugins = await freezeDisabledCommunityPlugins(obsidian);
  validateExactEmptyCommunityPlugins(communityPlugins);
  const installedTarget = input.phase === "post-host"
    ? await snapshotInstalledTarget(input.vaultPath)
    : null;
  const semanticSnapshots = Object.freeze({
    marker,
    communityPlugins,
    optionalConfigurations: Object.freeze(optionalConfigurations),
    preparedPlugins,
    installedTarget,
  });
  bindSemanticSnapshots(tree, semanticSnapshots);

  const corpus = evidenceForFixture(tree, fixture);
  if (
    corpus.noteCount !== SYNTHETIC_ACCEPTANCE_NOTE_COUNT
    || corpus.totalBytes !== SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES
  ) {
    throw new Error("Synthetic acceptance corpus does not match the fixed count and byte contract");
  }
  const evidence = Object.freeze({
    syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
    syntheticTotalBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    corpusDigest: computeSyntheticCorpusDigest(fixture.notes),
    tree,
  });
  assertExpected(input.expected, evidence);
  await assertSemanticSnapshots(semanticSnapshots);
  await assertOwnedTree(tree, "Synthetic acceptance vault");
  await assertOwnedTree(tree, "Synthetic acceptance vault");
  await assertSemanticSnapshots(semanticSnapshots);
  return evidence;
}

export async function attestSyntheticAcceptanceInstallState(input) {
  const checked = requireInstallInput(input);
  await assertCanonicalVaultDirectoryChain(checked.vaultPath);
  const marker = await validateSyntheticVaultMarker(checked.vaultPath);
  const fixture = generateAcceptanceFixture();
  const tree = await snapshotOwnedTree(
    checked.vaultPath,
    installStateFixtureAllowlist(fixture, checked),
    "Synthetic acceptance transient install vault",
  );
  const semanticSnapshots = await snapshotInstallStateObjects(checked, marker);
  bindInstallStateSnapshots(tree, semanticSnapshots);

  const corpus = evidenceForFixture(tree, fixture);
  if (
    corpus.noteCount !== SYNTHETIC_ACCEPTANCE_NOTE_COUNT
    || corpus.totalBytes !== SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES
  ) {
    throw new Error("Synthetic acceptance corpus does not match the fixed count and byte contract");
  }
  const evidence = Object.freeze({
    syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
    syntheticTotalBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    corpusDigest: computeSyntheticCorpusDigest(fixture.notes),
    tree,
  });
  assertExpected(checked.expected, evidence);
  await assertInstallStateSnapshots(semanticSnapshots);
  await assertOwnedTree(tree, "Synthetic acceptance transient install vault");
  await assertInstallStateSnapshots(semanticSnapshots);
  return evidence;
}
