import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface FileEvidence {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly sha256: string;
}

interface FrozenFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly evidence: FileEvidence;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface CanonicalWorktree {
  readonly repoRoot: string;
  readonly devRoot: string;
  readonly devRootSnapshot: DirectorySnapshot;
}

interface SyntheticVaultInstallCoreModule {
  readonly TEST_VAULT_MARKER_FILE: ".knowledge-workbench-test-vault.json";
  readonly OBSIDIAN_CONFIG_DIRECTORY: ".obsidian";
  readonly TEST_VAULT_MARKER: Readonly<{
    schemaVersion: 1;
    purpose: "knowledge-workbench-dedicated-test-vault";
    contentPolicy: "synthetic-notes-only";
  }>;
  resolveCanonicalWorktree(repoRoot: string): Promise<CanonicalWorktree>;
  validateSyntheticVaultMarker(vault: string): Promise<FrozenFile>;
  freezeDisabledCommunityPlugins(obsidian: string): Promise<FrozenFile>;
  assertDisabledCommunityPlugins(snapshot: FrozenFile): Promise<void>;
}

// @ts-expect-error The shared synthetic-vault core is intentionally plain ESM without a declaration file.
const core = await import("../../scripts/synthetic-vault-install-core.mjs") as unknown as SyntheticVaultInstallCoreModule;

const roots: string[] = [];

async function fixture() {
  const container = await mkdtemp(join(tmpdir(), "knowledge-workbench-synthetic-core-"));
  roots.push(container);
  const repoRoot = join(container, "repo");
  const devRoot = join(repoRoot, ".dev-vault");
  const vault = join(devRoot, "synthetic-vault");
  const obsidian = join(vault, core.OBSIDIAN_CONFIG_DIRECTORY);
  await mkdir(obsidian, { recursive: true });
  const marker = join(vault, core.TEST_VAULT_MARKER_FILE);
  const communityPlugins = join(obsidian, "community-plugins.json");
  await writeFile(marker, `${JSON.stringify(core.TEST_VAULT_MARKER, null, 2)}\n`, "utf8");
  await writeFile(communityPlugins, `[\n  "other-plugin"\n]\n`, "utf8");
  return { container, repoRoot, devRoot, vault, obsidian, marker, communityPlugins };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("synthetic-vault install core", () => {
  it("exports the exact compatibility constants", () => {
    expect(core.TEST_VAULT_MARKER_FILE).toBe(".knowledge-workbench-test-vault.json");
    expect(core.OBSIDIAN_CONFIG_DIRECTORY).toBe(".obsidian");
    expect(core.TEST_VAULT_MARKER).toEqual({
      schemaVersion: 1,
      purpose: "knowledge-workbench-dedicated-test-vault",
      contentPolicy: "synthetic-notes-only",
    });
    expect(Object.isFrozen(core.TEST_VAULT_MARKER)).toBe(true);
  });

  it("resolves canonical worktree roots and snapshots the fixed development root", async () => {
    const value = await fixture();

    const worktree = await core.resolveCanonicalWorktree(value.repoRoot);

    expect(worktree.repoRoot).toBe(await realpath(value.repoRoot));
    expect(worktree.devRoot).toBe(await realpath(value.devRoot));
    expect(worktree.devRootSnapshot.path).toBe(worktree.devRoot);
    expect(typeof worktree.devRootSnapshot.dev).toBe("bigint");
    expect(typeof worktree.devRootSnapshot.ino).toBe("bigint");
    expect(Object.isFrozen(worktree)).toBe(true);
    expect(Object.isFrozen(worktree.devRootSnapshot)).toBe(true);
  });

  it("rejects relative roots and symlinked fixed path components", async () => {
    await expect(core.resolveCanonicalWorktree("relative/repo"))
      .rejects.toThrow(/absolute|canonical/iu);

    const repoLink = await fixture();
    const linkedRepo = join(repoLink.container, "repo-link");
    await symlink(repoLink.repoRoot, linkedRepo);
    await expect(core.resolveCanonicalWorktree(linkedRepo))
      .rejects.toThrow(/repository|worktree|symlink|canonical/iu);

    const devRootLink = await fixture();
    const externalDevRoot = join(devRootLink.container, "external-dev-root");
    await mkdir(externalDevRoot);
    await rm(devRootLink.devRoot, { recursive: true });
    await symlink(externalDevRoot, devRootLink.devRoot);
    await expect(core.resolveCanonicalWorktree(devRootLink.repoRoot))
      .rejects.toThrow(/\.dev-vault|symlink|canonical/iu);
  });

  it("freezes only the exact synthetic-vault marker", async () => {
    const value = await fixture();

    const marker = await core.validateSyntheticVaultMarker(value.vault);

    expect(marker.path).toBe(value.marker);
    expect(JSON.parse(marker.bytes.toString("utf8"))).toEqual(core.TEST_VAULT_MARKER);
    expect(marker.evidence.nlink).toBe(1n);
    expect(marker.evidence.size).toBe(BigInt(marker.bytes.byteLength));
  });

  it("rejects malformed markers and markers with missing, changed, or extra keys", async () => {
    const invalidMarkers: readonly string[] = [
      "{",
      JSON.stringify({
        schemaVersion: 1,
        purpose: "knowledge-workbench-dedicated-test-vault",
      }),
      JSON.stringify({
        ...core.TEST_VAULT_MARKER,
        purpose: "ordinary-vault",
      }),
      JSON.stringify({
        ...core.TEST_VAULT_MARKER,
        extra: true,
      }),
    ];

    for (const content of invalidMarkers) {
      const value = await fixture();
      await writeFile(value.marker, content, "utf8");
      await expect(core.validateSyntheticVaultMarker(value.vault))
        .rejects.toThrow(/marker|exact|malformed/iu);
    }
  });

  it("rejects a multiply linked synthetic-vault marker", async () => {
    const value = await fixture();
    await link(value.marker, join(value.repoRoot, "marker-hard-link.json"));

    await expect(core.validateSyntheticVaultMarker(value.vault))
      .rejects.toThrow(/single link|hard link|nlink/iu);
  });

  it("freezes exact JSON string arrays while allowing other disabled plugin IDs", async () => {
    for (const entries of [[], ["other-plugin"], ["plugin-a", "plugin-b"]] as const) {
      const value = await fixture();
      await writeFile(value.communityPlugins, `${JSON.stringify(entries, null, 2)}\n`, "utf8");

      const snapshot = await core.freezeDisabledCommunityPlugins(value.obsidian);

      expect(snapshot.path).toBe(value.communityPlugins);
      expect(JSON.parse(snapshot.bytes.toString("utf8"))).toEqual(entries);
      await expect(core.assertDisabledCommunityPlugins(snapshot)).resolves.toBeUndefined();
    }
  });

  it("rejects malformed community state, non-array entries, and the enabled plugin ID", async () => {
    const invalidCommunityState: readonly string[] = [
      "{",
      JSON.stringify({ enabled: [] }),
      JSON.stringify(["other-plugin", 7]),
      JSON.stringify(["knowledge-workbench"]),
    ];

    for (const content of invalidCommunityState) {
      const value = await fixture();
      await writeFile(value.communityPlugins, content, "utf8");
      await expect(core.freezeDisabledCommunityPlugins(value.obsidian))
        .rejects.toThrow(/community-plugins|array|plugin IDs|enabled|malformed/iu);
    }
  });

  it("rejects a multiply linked community plugin manifest", async () => {
    const value = await fixture();
    await link(value.communityPlugins, join(value.repoRoot, "community-plugins-hard-link.json"));

    await expect(core.freezeDisabledCommunityPlugins(value.obsidian))
      .rejects.toThrow(/single link|hard link|nlink/iu);
  });

  it("detects same-inode same-size community manifest mutation", async () => {
    const value = await fixture();
    await writeFile(value.communityPlugins, `["plugin-alpha"]`, "utf8");
    const snapshot = await core.freezeDisabledCommunityPlugins(value.obsidian);
    const before = await lstat(value.communityPlugins, { bigint: true });

    await writeFile(value.communityPlugins, `["plugin-bravo"]`, "utf8");
    const after = await lstat(value.communityPlugins, { bigint: true });

    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    await expect(core.assertDisabledCommunityPlugins(snapshot))
      .rejects.toThrow(/community-plugins|changed|snapshot/iu);
  });
});
