import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  assertFrozenRegularFile,
  readFrozenRegularFile,
} from "./safe-fs-core.mjs";

export const TEST_VAULT_MARKER_FILE = ".knowledge-workbench-test-vault.json";
export const OBSIDIAN_CONFIG_DIRECTORY = ".obsidian";
export const TEST_VAULT_MARKER = Object.freeze({
  schemaVersion: 1,
  purpose: "knowledge-workbench-dedicated-test-vault",
  contentPolicy: "synthetic-notes-only",
});

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

function hasErrorCode(error, code) {
  let current = error;
  while (current !== null && typeof current === "object") {
    if (current.code === code) return true;
    current = current.cause;
  }
  return false;
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

function decodeExactMarker(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Dedicated test-vault marker is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Dedicated test-vault marker does not match the exact required value");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(TEST_VAULT_MARKER).sort();
  if (
    keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
    || value.schemaVersion !== TEST_VAULT_MARKER.schemaVersion
    || value.purpose !== TEST_VAULT_MARKER.purpose
    || value.contentPolicy !== TEST_VAULT_MARKER.contentPolicy
  ) {
    throw new Error("Dedicated test-vault marker does not match the exact required value");
  }
}

function decodeDisabledCommunityPlugins(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("community-plugins.json is malformed");
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("community-plugins.json must contain an array of plugin IDs");
  }
  if (value.includes("knowledge-workbench")) {
    throw new Error("knowledge-workbench is already enabled; refusing replacement");
  }
}

async function readCommunityPlugins(path) {
  try {
    return await readFrozenRegularFile(path, "community-plugins.json");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error("community-plugins.json must be an existing regular non-symlink file", { cause: error });
    }
    throw error;
  }
}

export async function resolveCanonicalWorktree(repoRoot) {
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot)) {
    throw new Error("Repository root must be absolute");
  }
  const requestedRepoRoot = resolve(repoRoot);
  const requestedRepoSnapshot = await snapshotDirectory(requestedRepoRoot, "Repository root");
  const canonicalRepoRoot = await realpath(requestedRepoRoot);
  const canonicalRepoSnapshot = await snapshotDirectory(canonicalRepoRoot, "Canonical repository root");
  if (!sameIdentity(requestedRepoSnapshot, canonicalRepoSnapshot)) {
    throw new Error("Repository root identity changed during canonical resolution");
  }

  const requestedDevRoot = join(canonicalRepoRoot, ".dev-vault");
  const requestedDevRootSnapshot = await snapshotDirectory(requestedDevRoot, ".dev-vault");
  const canonicalDevRoot = await realpath(requestedDevRoot);
  if (canonicalDevRoot !== requestedDevRoot) {
    throw new Error(".dev-vault must be a canonical non-symlink directory");
  }
  const devRootSnapshot = await snapshotDirectory(canonicalDevRoot, "Canonical .dev-vault");
  if (!sameIdentity(requestedDevRootSnapshot, devRootSnapshot)) {
    throw new Error(".dev-vault identity changed during canonical resolution");
  }

  return Object.freeze({
    repoRoot: canonicalRepoRoot,
    devRoot: canonicalDevRoot,
    devRootSnapshot,
  });
}

export async function validateSyntheticVaultMarker(vault) {
  const marker = await readFrozenRegularFile(
    join(vault, TEST_VAULT_MARKER_FILE),
    "Dedicated test-vault marker",
  );
  decodeExactMarker(marker.bytes);
  return marker;
}

export async function freezeDisabledCommunityPlugins(obsidian) {
  const snapshot = await readCommunityPlugins(join(obsidian, "community-plugins.json"));
  decodeDisabledCommunityPlugins(snapshot.bytes);
  return snapshot;
}

export async function assertDisabledCommunityPlugins(snapshot) {
  const current = await readCommunityPlugins(snapshot.path);
  decodeDisabledCommunityPlugins(current.bytes);
  await assertFrozenRegularFile(snapshot, "community-plugins.json");
}
