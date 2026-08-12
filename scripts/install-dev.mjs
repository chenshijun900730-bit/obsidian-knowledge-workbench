import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isStrictBoundedSemver } from "../src/runtime/strict-semver.mjs";
import { assertFrozenRegularFile, readFrozenRegularFile } from "./safe-fs-core.mjs";
import {
  assertDisabledCommunityPlugins,
  freezeDisabledCommunityPlugins,
  OBSIDIAN_CONFIG_DIRECTORY,
  resolveCanonicalWorktree,
  validateSyntheticVaultMarker,
} from "./synthetic-vault-install-core.mjs";

export {
  OBSIDIAN_CONFIG_DIRECTORY,
  TEST_VAULT_MARKER,
  TEST_VAULT_MARKER_FILE,
} from "./synthetic-vault-install-core.mjs";
const ARTIFACTS = Object.freeze(["main.js", "manifest.json", "styles.css"]);
const PLUGIN_ID = "knowledge-workbench";
const NORMAL_PLUGIN_NAME = "Knowledge Workbench";

const isMissing = (error) => error !== null && typeof error === "object" && error.code === "ENOENT";
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
async function readSourceSnapshot(path, label) {
  return readFrozenRegularFile(path, label);
}

async function assertSourceSnapshot(snapshot, label) {
  await assertFrozenRegularFile(snapshot, label);
}

async function optionalStat(path) {
  try { return await lstat(path); } catch (error) { if (isMissing(error)) return null; throw error; }
}

async function requireDirectory(path, label) {
  const stat = await optionalStat(path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be an existing non-symlink directory`);
  return stat;
}

async function requireRegularFile(path, label) {
  const stat = await optionalStat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return stat;
}

async function hasExactRegularFileIdentity(path, expectedIdentity) {
  if (expectedIdentity === null) return false;
  const stat = await optionalStat(path);
  return stat !== null
    && stat.isFile()
    && !stat.isSymbolicLink()
    && stat.nlink === 1
    && sameIdentity(identity(stat), expectedIdentity);
}

async function rejectSymlinksBelow(base, target) {
  const relativePath = relative(base, target);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Development vault must be inside .dev-vault");
  }
  let current = base;
  for (const component of relativePath.split(sep)) {
    current = join(current, component);
    const stat = await optionalStat(current);
    if (stat === null) throw new Error(`Development vault component does not exist: ${component}`);
    if (stat.isSymbolicLink()) throw new Error(`Development vault component is a symlink: ${component}`);
  }
}

async function assertNormalMetadataAbsent(repo) {
  if (await optionalStat(join(repo, "acceptance-build.json")) !== null) {
    throw new Error("Repository root acceptance-build.json is forbidden for the normal development installer");
  }
}

function validateNormalIdentity(manifest, packageJson) {
  if (manifest?.id !== PLUGIN_ID || manifest?.name !== NORMAL_PLUGIN_NAME) {
    throw new Error("manifest identity must be exactly the normal Knowledge Workbench identity");
  }
  if (
    !isStrictBoundedSemver(manifest.version)
    || packageJson?.version !== manifest.version
  ) {
    throw new Error("manifest and package versions must match a bounded semantic version");
  }
}

async function validateSources(repo) {
  await assertNormalMetadataAbsent(repo);
  const sources = new Map();
  for (const artifact of ARTIFACTS) {
    const source = join(repo, artifact);
    sources.set(artifact, await readSourceSnapshot(source, `Source artifact ${artifact}`));
  }
  let manifest;
  let packageJson;
  const packagePath = join(repo, "package.json");
  const packageSnapshot = await readSourceSnapshot(packagePath, "Source package.json");
  try {
    manifest = JSON.parse(sources.get("manifest.json").bytes.toString("utf8"));
    packageJson = JSON.parse(packageSnapshot.bytes.toString("utf8"));
  } catch {
    throw new Error("manifest.json and package.json must be valid JSON");
  }
  validateNormalIdentity(manifest, packageJson);
  return Object.freeze({ artifacts: sources, packageSnapshot, manifest, packageJson });
}

async function assertSourceSnapshots(repo, sources) {
  await assertNormalMetadataAbsent(repo);
  for (const [artifact, snapshot] of sources.artifacts) {
    await assertSourceSnapshot(snapshot, `Source artifact ${artifact}`);
  }
  await assertSourceSnapshot(sources.packageSnapshot, "Source package.json");
}

async function preflightDestination(obsidian) {
  const plugins = join(obsidian, "plugins");
  const pluginsStat = await optionalStat(plugins);
  if (pluginsStat !== null && (!pluginsStat.isDirectory() || pluginsStat.isSymbolicLink())) {
    throw new Error("plugins destination must be a non-symlink directory");
  }
  const target = join(plugins, "knowledge-workbench");
  const targetStat = pluginsStat === null ? null : await optionalStat(target);
  if (targetStat !== null && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
    throw new Error("knowledge-workbench target must be a non-symlink directory");
  }
  await assertTargetAcceptanceMetadataAbsent(target);
  if (targetStat !== null) {
    for (const artifact of ARTIFACTS) {
      const destination = join(target, artifact);
      const stat = await optionalStat(destination);
      if (stat?.isSymbolicLink()) throw new Error(`destination artifact symlink: ${artifact}`);
      if (stat !== null && !stat.isFile()) throw new Error(`destination artifact must be a regular file: ${artifact}`);
      if (stat !== null) await readFrozenRegularFile(destination, `Destination artifact ${artifact}`);
    }
  }
  return { plugins, target, createPlugins: pluginsStat === null, createTarget: targetStat === null };
}

async function assertTargetAcceptanceMetadataAbsent(target) {
  if (await optionalStat(join(target, "acceptance-build.json")) !== null) {
    throw new Error("Destination acceptance-build.json is forbidden for the normal development installer");
  }
}

async function assertTargetIdentity(vault, target, expectedIdentity) {
  const stat = await requireDirectory(target, "knowledge-workbench target");
  if (!sameIdentity(identity(stat), expectedIdentity)) throw new Error("Plugin target identity changed during installation");
  const canonicalTarget = await realpath(target);
  if (!inside(vault, canonicalTarget)) throw new Error("Plugin target escaped the dedicated vault");
  return canonicalTarget;
}

async function assertMutationSafety(
  vault,
  obsidian,
  target,
  expectedIdentity,
  communityPlugins,
  installed = [],
) {
  await requireDirectory(obsidian, OBSIDIAN_CONFIG_DIRECTORY);
  await requireDirectory(dirname(target), "plugins destination");
  const canonicalTarget = await assertTargetIdentity(vault, target, expectedIdentity);
  await assertTargetAcceptanceMetadataAbsent(canonicalTarget);
  await assertDisabledCommunityPlugins(communityPlugins);
  for (const artifact of ARTIFACTS) {
    const artifactPath = join(canonicalTarget, artifact);
    const stat = await optionalStat(artifactPath);
    if (stat?.isSymbolicLink()) throw new Error(`destination artifact symlink: ${artifact}`);
    if (stat !== null && !stat.isFile()) throw new Error(`destination artifact must be a regular file: ${artifact}`);
    if (stat !== null) await readFrozenRegularFile(artifactPath, `Destination artifact ${artifact}`);
  }
  for (const entry of installed) {
    const artifactPath = join(canonicalTarget, entry.artifact);
    const stat = await optionalStat(artifactPath);
    if (stat === null || !stat.isFile() || stat.isSymbolicLink() || !sameIdentity(identity(stat), entry.identity)) {
      throw new Error("Installed artifact identity changed during installation");
    }
    await readFrozenRegularFile(artifactPath, `Installed artifact ${entry.artifact}`);
  }
  await assertTargetAcceptanceMetadataAbsent(canonicalTarget);
  return canonicalTarget;
}

export async function installDevelopmentBuild({
  repoRoot,
  vaultPath,
  afterSourceValidation,
  beforeRename,
} = {}) {
  if (typeof vaultPath !== "string" || vaultPath.length === 0) throw new Error("OBSIDIAN_DEV_VAULT is required");
  if (!isAbsolute(vaultPath)) throw new Error("OBSIDIAN_DEV_VAULT must be absolute");
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot)) throw new Error("Repository root must be absolute");
  const requestedRepo = resolve(repoRoot);
  const requestedDevRoot = join(requestedRepo, ".dev-vault");
  const requestedVault = resolve(vaultPath);
  if (requestedVault === requestedDevRoot) throw new Error("Choose a dedicated vault below .dev-vault, not the .dev-vault root");
  if (!inside(requestedDevRoot, requestedVault)) throw new Error("Development vault must be inside .dev-vault");
  const relativeVault = relative(requestedDevRoot, requestedVault);
  const worktree = await resolveCanonicalWorktree(requestedRepo);
  const repo = worktree.repoRoot;
  const devRoot = worktree.devRoot;
  const requested = join(devRoot, relativeVault);
  await rejectSymlinksBelow(devRoot, requested);
  await requireDirectory(requested, "Development vault");
  const vault = await realpath(requested);
  if (!inside(devRoot, vault)) throw new Error("Canonical development vault must remain inside .dev-vault");
  const obsidian = join(vault, OBSIDIAN_CONFIG_DIRECTORY);
  await requireDirectory(obsidian, OBSIDIAN_CONFIG_DIRECTORY);

  await validateSyntheticVaultMarker(vault);
  const communityPlugins = await freezeDisabledCommunityPlugins(obsidian);
  const sources = await validateSources(repo);
  await afterSourceValidation?.();
  await assertSourceSnapshots(repo, sources);
  const destination = await preflightDestination(obsidian);

  if (destination.createPlugins) await mkdir(destination.plugins);
  await requireDirectory(destination.plugins, "plugins destination");
  if (destination.createTarget) await mkdir(destination.target);
  const targetStat = await requireDirectory(destination.target, "knowledge-workbench target");
  const targetIdentity = identity(targetStat);
  const canonicalTarget = await assertMutationSafety(
    vault,
    obsidian,
    destination.target,
    targetIdentity,
    communityPlugins,
  );
  const staged = [];
  const backups = [];
  const replaced = [];
  let failure = null;
  let rollbackIncomplete = false;
  let backupRetained = false;
  try {
    for (const artifact of ARTIFACTS) {
      const temp = join(canonicalTarget, `.${artifact}.tmp-${process.pid}-${randomUUID()}`);
      const source = sources.artifacts.get(artifact);
      await writeFile(temp, source.bytes, { flag: "wx" });
      const stat = await requireRegularFile(temp, "Staged installer artifact");
      const snapshot = await readSourceSnapshot(temp, "Staged installer artifact");
      if (!snapshot.bytes.equals(source.bytes)) {
        throw new Error(`Staged installer artifact does not match validated source: ${artifact}`);
      }
      staged.push({ artifact, path: temp, identity: identity(stat), snapshot, source, retained: false });
    }
    await assertSourceSnapshots(repo, sources);
    for (const stage of staged) {
      await assertSourceSnapshot(stage.snapshot, `Staged installer artifact ${stage.artifact}`);
      if (!stage.snapshot.bytes.equals(stage.source.bytes)) {
        throw new Error(`Staged installer artifact does not match validated source: ${stage.artifact}`);
      }
    }
    let stagedManifest;
    try {
      stagedManifest = JSON.parse(staged.find((entry) => entry.artifact === "manifest.json").snapshot.bytes.toString("utf8"));
    } catch {
      throw new Error("Staged manifest.json must be valid JSON");
    }
    validateNormalIdentity(stagedManifest, sources.packageJson);
    for (const artifact of ARTIFACTS) {
      const current = join(canonicalTarget, artifact);
      const stat = await optionalStat(current);
      if (stat === null) {
        backups.push({ artifact, path: null, identity: null, retained: false });
      } else {
        const backup = join(canonicalTarget, `.${artifact}.backup-${process.pid}-${randomUUID()}`);
        await copyFile(current, backup, constants.COPYFILE_EXCL);
        const backupStat = await requireRegularFile(backup, "Installer rollback backup");
        backups.push({ artifact, path: backup, identity: identity(backupStat), retained: false });
      }
    }
    for (const stage of staged) {
      await beforeRename?.(stage.artifact);
      await assertSourceSnapshots(repo, sources);
      await assertSourceSnapshot(stage.snapshot, `Staged installer artifact ${stage.artifact}`);
      await assertMutationSafety(
        vault,
        obsidian,
        canonicalTarget,
        targetIdentity,
        communityPlugins,
        replaced,
      );
      await rename(stage.path, join(canonicalTarget, stage.artifact));
      replaced.push({ artifact: stage.artifact, identity: stage.identity });
    }
    await assertMutationSafety(
      vault,
      obsidian,
      canonicalTarget,
      targetIdentity,
      communityPlugins,
      replaced,
    );
  } catch (error) {
    failure = error;
    try {
      await assertTargetIdentity(vault, canonicalTarget, targetIdentity);
      for (const installed of [...replaced].reverse()) {
        const destinationPath = join(canonicalTarget, installed.artifact);
        const backup = backups.find((entry) => entry.artifact === installed.artifact);
        const current = await optionalStat(destinationPath);
        if (current !== null && (!current.isFile() || current.isSymbolicLink() || !sameIdentity(identity(current), installed.identity))) {
          rollbackIncomplete = true;
          if (backup?.path !== null && backup?.path !== undefined) {
            backup.retained = true;
            if (await hasExactRegularFileIdentity(backup.path, backup.identity)) backupRetained = true;
          }
          continue;
        }
        try {
          if (backup?.path === null || backup === undefined) {
            if (current !== null) await rm(destinationPath, { force: true });
          } else {
            if (!await hasExactRegularFileIdentity(backup.path, backup.identity)) {
              rollbackIncomplete = true;
              backup.retained = true;
              continue;
            }
            await rename(backup.path, destinationPath);
            backup.path = null;
            backup.identity = null;
          }
        } catch {
          rollbackIncomplete = true;
          if (backup?.path !== null && backup?.path !== undefined) {
            backup.retained = true;
            if (await hasExactRegularFileIdentity(backup.path, backup.identity)) backupRetained = true;
          }
        }
      }
    } catch {
      rollbackIncomplete = true;
      for (const entry of staged) entry.retained = true;
      for (const entry of backups) {
        if (entry.path !== null) {
          entry.retained = true;
        }
      }
    }
  }
  const cleanupIncomplete = await (async () => {
    try {
      await assertTargetIdentity(vault, canonicalTarget, targetIdentity);
    } catch {
      return true;
    }
    let incomplete = false;
    for (const entry of [...staged, ...backups]) {
      if (entry.path === null || entry.retained) continue;
      try {
        const current = await optionalStat(entry.path);
        if (current === null) continue;
        if (!current.isFile() || current.isSymbolicLink() || entry.identity === null || !sameIdentity(identity(current), entry.identity)) {
          incomplete = true;
          entry.retained = true;
          continue;
        }
        await rm(entry.path, { force: true });
      } catch {
        incomplete = true;
        entry.retained = true;
      }
    }
    return incomplete;
  })();
  if (failure !== null) {
    if (rollbackIncomplete || cleanupIncomplete) {
      const suffix = backupRetained ? "; backup retained for manual recovery" : "";
      throw new AggregateError([failure], `Installer failed and rollback was incomplete${suffix}`);
    }
    throw failure;
  }
  if (cleanupIncomplete) throw new Error("Installer completed but owned temporary cleanup was incomplete");
  return { target: canonicalTarget, artifacts: [...ARTIFACTS], communityPluginsModified: false };
}

export function formatInstallSuccess(result) {
  return `Installed development build at ${result.target}. Installer did not modify community-plugins.json.\n`;
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === modulePath) {
  const repoRoot = await realpath(dirname(dirname(modulePath)));
  try {
    const result = await installDevelopmentBuild({ repoRoot, vaultPath: process.env.OBSIDIAN_DEV_VAULT });
    process.stdout.write(formatInstallSuccess(result));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
