import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const deviceStatInjection = vi.hoisted(() => ({ path: "" }));
const lstatSchedule = vi.hoisted(() => ({
  path: "",
  seen: 0,
  triggerAt: 0,
  action: null as null | (() => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const pathModule = await import("node:path");
  const actualLstat = actual.lstat.bind(actual);
  return {
    ...actual,
    lstat: async (...args: unknown[]) => {
      if (String(args[0]) === deviceStatInjection.path) {
        const parentStat = await actual.lstat(pathModule.dirname(deviceStatInjection.path));
        return new Proxy(parentStat, {
          get(target, property, receiver) {
            if (property === "isBlockDevice") return () => true;
            if (
              property === "isFile"
              || property === "isDirectory"
              || property === "isSymbolicLink"
              || property === "isCharacterDevice"
              || property === "isFIFO"
              || property === "isSocket"
            ) return () => false;
            const value: unknown = Reflect.get(target, property, receiver);
            return value;
          },
        });
      }
      const result: unknown = await Reflect.apply(actualLstat, undefined, args);
      if (String(args[0]) === lstatSchedule.path) {
        lstatSchedule.seen += 1;
        if (lstatSchedule.seen === lstatSchedule.triggerAt && lstatSchedule.action !== null) {
          const action = lstatSchedule.action;
          lstatSchedule.action = null;
          await action();
        }
      }
      return result;
    },
  };
});

function scheduleAfterLstat(path: string, triggerAt: number, action: () => Promise<void>): void {
  lstatSchedule.path = path;
  lstatSchedule.seen = 0;
  lstatSchedule.triggerAt = triggerAt;
  lstatSchedule.action = action;
}

function resetLstatSchedule(): void {
  lstatSchedule.path = "";
  lstatSchedule.seen = 0;
  lstatSchedule.triggerAt = 0;
  lstatSchedule.action = null;
}

interface InstallerModule {
  readonly TEST_VAULT_MARKER: Readonly<{ schemaVersion: 1; purpose: string; contentPolicy: string }>;
  readonly TEST_VAULT_MARKER_FILE: string;
  readonly OBSIDIAN_CONFIG_DIRECTORY: string;
  formatInstallSuccess(result: Readonly<{ target: string }>): string;
  installDevelopmentBuild(options?: Readonly<{
    repoRoot?: string;
    vaultPath?: string;
    afterSourceValidation?: () => void | Promise<void>;
    beforeRename?: (artifact: string) => void | Promise<void>;
  }>): Promise<Readonly<{
    target: string;
    artifacts: readonly string[];
    communityPluginsModified: false;
  }>>;
}
// @ts-expect-error The runtime installer is intentionally plain ESM without a declaration file.
const installer = await import("../../scripts/install-dev.mjs") as unknown as InstallerModule;
const { OBSIDIAN_CONFIG_DIRECTORY, TEST_VAULT_MARKER, TEST_VAULT_MARKER_FILE } = installer;
const installDevelopmentBuild: InstallerModule["installDevelopmentBuild"] = (options) => installer.installDevelopmentBuild(options);

const roots: string[] = [];
afterEach(async () => {
  deviceStatInjection.path = "";
  resetLstatSchedule();
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(temporaryDirectory = tmpdir(), prefix = "knowledge-workbench-install-") {
  const repoRoot = await mkdtemp(join(temporaryDirectory, prefix));
  roots.push(repoRoot);
  const devRoot = join(repoRoot, ".dev-vault");
  const vaultPath = join(devRoot, "synthetic-vault");
  await mkdir(join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY), { recursive: true });
  await writeFile(join(vaultPath, TEST_VAULT_MARKER_FILE), `${JSON.stringify(TEST_VAULT_MARKER, null, 2)}\n`, "utf8");
  await writeFile(
    join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json"),
    `${JSON.stringify(["other-plugin"], null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(repoRoot, "main.js"), "main-build", "utf8");
  await writeFile(
    join(repoRoot, "manifest.json"),
    JSON.stringify({ id: "knowledge-workbench", name: "Knowledge Workbench", version: "0.1.0" }),
    "utf8",
  );
  await writeFile(join(repoRoot, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
  await writeFile(join(repoRoot, "styles.css"), "styles-build", "utf8");
  return { repoRoot, devRoot, vaultPath };
}

async function seedDestinationSentinels(value: Awaited<ReturnType<typeof fixture>>) {
  const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
  await mkdir(target, { recursive: true });
  const sentinels = new Map([
    ["main.js", "NORMAL-MAIN-SENTINEL"],
    ["manifest.json", "NORMAL-MANIFEST-SENTINEL"],
    ["styles.css", "NORMAL-STYLES-SENTINEL"],
    ["data.json", "PRIVATE-DATA-SENTINEL"],
  ]);
  for (const [name, content] of sentinels) await writeFile(join(target, name), content, "utf8");
  return { target, sentinels };
}

async function expectDestinationSentinels(
  target: string,
  sentinels: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [name, content] of sentinels) {
    await expect(readFile(join(target, name), "utf8")).resolves.toBe(content);
  }
}

async function captureDestinationEvidence(
  target: string,
  sentinels: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, Readonly<{ bytes: string; dev: bigint; ino: bigint }>>> {
  const evidence = new Map<string, Readonly<{ bytes: string; dev: bigint; ino: bigint }>>();
  for (const name of sentinels.keys()) {
    const path = join(target, name);
    const stat = await lstat(path, { bigint: true });
    evidence.set(name, Object.freeze({
      bytes: await readFile(path, "utf8"),
      dev: stat.dev,
      ino: stat.ino,
    }));
  }
  return evidence;
}

async function makeFifo(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("mkfifo", [path], (error) => {
      if (error === null) resolvePromise();
      else reject(new Error(`Unable to create FIFO fixture: ${error.message}`));
    });
  });
}

describe("guarded development installer", () => {
  it("rejects missing, relative, dev-root, and external vault paths", async () => {
    const value = await fixture();
    const external = await mkdtemp(join(tmpdir(), "knowledge-workbench-external-"));
    roots.push(external);
    await expect(installDevelopmentBuild({ repoRoot: value.repoRoot })).rejects.toThrow("OBSIDIAN_DEV_VAULT");
    await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: ".dev-vault/synthetic-vault" })).rejects.toThrow("absolute");
    await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.devRoot })).rejects.toThrow("dedicated vault below");
    await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: external })).rejects.toThrow("inside .dev-vault");
  });

  it("requires the exact marker and an existing non-symlink configuration directory", async () => {
    const missingMarker = await fixture();
    const { rm } = await import("node:fs/promises");
    await rm(join(missingMarker.vaultPath, TEST_VAULT_MARKER_FILE));
    await expect(installDevelopmentBuild({ repoRoot: missingMarker.repoRoot, vaultPath: missingMarker.vaultPath })).rejects.toThrow("marker");

    const missingObsidian = await fixture();
    await rm(join(missingObsidian.vaultPath, OBSIDIAN_CONFIG_DIRECTORY), { recursive: true });
    await expect(installDevelopmentBuild({ repoRoot: missingObsidian.repoRoot, vaultPath: missingObsidian.vaultPath })).rejects.toThrow(OBSIDIAN_CONFIG_DIRECTORY);

    for (const marker of [
      "{",
      JSON.stringify({ ...TEST_VAULT_MARKER, extra: true }),
      JSON.stringify({ ...TEST_VAULT_MARKER, purpose: "ordinary-vault" }),
    ]) {
      const invalid = await fixture();
      await writeFile(join(invalid.vaultPath, TEST_VAULT_MARKER_FILE), marker, "utf8");
      await expect(installDevelopmentBuild({ repoRoot: invalid.repoRoot, vaultPath: invalid.vaultPath })).rejects.toThrow("marker");
    }
  });

  it("rejects source, containment, target, and destination-artifact symlinks", async () => {
    const source = await fixture();
    const { rm } = await import("node:fs/promises");
    await rm(join(source.repoRoot, "main.js"));
    await symlink(join(source.repoRoot, "styles.css"), join(source.repoRoot, "main.js"));
    await expect(installDevelopmentBuild({ repoRoot: source.repoRoot, vaultPath: source.vaultPath })).rejects.toThrow("regular non-symlink");

    const containment = await fixture();
    const outside = join(containment.repoRoot, "outside");
    await mkdir(outside);
    await rm(join(containment.vaultPath, OBSIDIAN_CONFIG_DIRECTORY), { recursive: true });
    await symlink(outside, join(containment.vaultPath, OBSIDIAN_CONFIG_DIRECTORY));
    await expect(installDevelopmentBuild({ repoRoot: containment.repoRoot, vaultPath: containment.vaultPath })).rejects.toThrow("symlink");

    const plugins = await fixture();
    const pluginsOutside = join(plugins.repoRoot, "plugins-outside");
    await mkdir(pluginsOutside);
    await symlink(pluginsOutside, join(plugins.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins"));
    await expect(installDevelopmentBuild({ repoRoot: plugins.repoRoot, vaultPath: plugins.vaultPath })).rejects.toThrow("symlink");

    const targetLink = await fixture();
    const targetOutside = join(targetLink.repoRoot, "target-outside");
    await mkdir(targetOutside);
    await mkdir(join(targetLink.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins"));
    await symlink(targetOutside, join(targetLink.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench"));
    await expect(installDevelopmentBuild({ repoRoot: targetLink.repoRoot, vaultPath: targetLink.vaultPath })).rejects.toThrow("symlink");

    const destination = await fixture();
    const target = join(destination.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    await symlink(join(destination.repoRoot, "styles.css"), join(target, "main.js"));
    await expect(installDevelopmentBuild({ repoRoot: destination.repoRoot, vaultPath: destination.vaultPath })).rejects.toThrow("destination artifact symlink");
  });

  it("rejects multiply linked normal source and destination artifacts", async () => {
    for (const source of ["main.js", "manifest.json", "package.json", "styles.css"]) {
      const value = await fixture();
      await link(join(value.repoRoot, source), join(value.repoRoot, `hard-link-${source}`));

      await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath }))
        .rejects.toThrow(/single link|hard link|nlink/iu);
    }

    for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
      const value = await fixture();
      const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
      await mkdir(target, { recursive: true });
      const destination = join(target, artifact);
      await writeFile(destination, `old-${artifact}`, "utf8");
      await link(destination, join(value.repoRoot, `destination-hard-link-${artifact}`));

      await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath }))
        .rejects.toThrow(/single link|hard link|nlink/iu);
      await expect(readFile(destination, "utf8")).resolves.toBe(`old-${artifact}`);
    }
  });

  it("rejects the dedicated vault itself or an upper vault component when symlinked", async () => {
    const vaultLink = await fixture();
    const { rm } = await import("node:fs/promises");
    const externalVault = join(vaultLink.repoRoot, "external-vault");
    await mkdir(externalVault);
    await rm(vaultLink.vaultPath, { recursive: true });
    await symlink(externalVault, vaultLink.vaultPath);
    await expect(installDevelopmentBuild({ repoRoot: vaultLink.repoRoot, vaultPath: vaultLink.vaultPath })).rejects.toThrow("symlink");

    const upperLink = await fixture();
    const nestedVault = join(upperLink.devRoot, "nested", "vault");
    const externalParent = join(upperLink.repoRoot, "external-parent");
    await mkdir(join(externalParent, "vault"), { recursive: true });
    await symlink(externalParent, join(upperLink.devRoot, "nested"));
    await expect(installDevelopmentBuild({ repoRoot: upperLink.repoRoot, vaultPath: nestedVault })).rejects.toThrow("symlink");
  });

  it("preflights all source and destination artifacts before replacing any file", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "main.js"), "old-main", "utf8");
    await writeFile(join(value.repoRoot, "manifest.json"), JSON.stringify({ id: "other-plugin" }), "utf8");
    await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath })).rejects.toThrow("manifest id");
    await expect(readFile(join(target, "main.js"), "utf8")).resolves.toBe("old-main");
  });

  it("requires the exact normal identity and a matching bounded package version before creating a target", async () => {
    const invalidIdentities = [
      {
        manifest: { id: "other-plugin", name: "Knowledge Workbench", version: "0.1.0" },
        packageJson: { version: "0.1.0" },
      },
      {
        manifest: { id: "knowledge-workbench", name: "Knowledge Workbench (Read-only acceptance)", version: "0.1.0" },
        packageJson: { version: "0.1.0" },
      },
      {
        manifest: { id: "knowledge-workbench", name: "Knowledge Workbench", version: "1000.0.0" },
        packageJson: { version: "1000.0.0" },
      },
      {
        manifest: { id: "knowledge-workbench", name: "Knowledge Workbench", version: "0.1.0-alpha..1" },
        packageJson: { version: "0.1.0-alpha..1" },
      },
      {
        manifest: { id: "knowledge-workbench", name: "Knowledge Workbench", version: "0.1.0" },
        packageJson: { version: "0.1.1" },
      },
    ];

    for (const invalid of invalidIdentities) {
      const value = await fixture();
      await writeFile(join(value.repoRoot, "manifest.json"), JSON.stringify(invalid.manifest), "utf8");
      await writeFile(join(value.repoRoot, "package.json"), JSON.stringify(invalid.packageJson), "utf8");

      await expect(installDevelopmentBuild({
        repoRoot: value.repoRoot,
        vaultPath: value.vaultPath,
      })).rejects.toThrow(/manifest|package|version|identity/u);
      await expect(readdir(join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("rejects source replacement after validation before mutating the destination", async () => {
    const value = await fixture();
    const target = join(
      value.vaultPath,
      OBSIDIAN_CONFIG_DIRECTORY,
      "plugins",
      "knowledge-workbench",
    );

    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      afterSourceValidation: async () => {
        await writeFile(
          join(value.repoRoot, "manifest.json"),
          JSON.stringify({
            id: "knowledge-workbench",
            name: "Knowledge Workbench (Read-only acceptance)",
            version: "0.1.0",
          }),
          "utf8",
        );
      },
    })).rejects.toThrow(/source artifact manifest\.json.*changed|changed after validation/ui);

    await expect(readdir(join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(target, "manifest.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("detects same-inode same-size source mutation after validation", async () => {
    const value = await fixture();
    const source = join(value.repoRoot, "main.js");

    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      afterSourceValidation: async () => {
        await writeFile(source, "evil-build", "utf8");
      },
    })).rejects.toThrow(/source artifact main\.js.*changed|changed after validation/ui);

    await expect(readdir(join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a root acceptance metadata path of any filesystem shape before creating a target", async () => {
    for (const shape of ["file", "directory", "symlink"] as const) {
      const value = await fixture();
      const metadataPath = join(value.repoRoot, "acceptance-build.json");
      if (shape === "file") await writeFile(metadataPath, "{}\n", "utf8");
      if (shape === "directory") await mkdir(metadataPath);
      if (shape === "symlink") await symlink(join(value.repoRoot, "main.js"), metadataPath);

      await expect(installDevelopmentBuild({
        repoRoot: value.repoRoot,
        vaultPath: value.vaultPath,
      })).rejects.toThrow("acceptance-build.json");
      await expect(readdir(join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("rejects destination acceptance metadata of every filesystem shape before mutation", async () => {
    for (const shape of ["file", "directory", "symlink"] as const) {
      const value = await fixture();
      const { target, sentinels } = await seedDestinationSentinels(value);
      const metadata = join(target, "acceptance-build.json");
      if (shape === "file") await writeFile(metadata, "{}\n", "utf8");
      if (shape === "directory") await mkdir(metadata);
      if (shape === "symlink") await symlink(join(value.repoRoot, "styles.css"), metadata);

      await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath }))
        .rejects.toThrow("acceptance-build.json");
      await expectDestinationSentinels(target, sentinels);
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects FIFO destination acceptance metadata before mutation",
    async () => {
      const value = await fixture();
      const { target, sentinels } = await seedDestinationSentinels(value);
      await makeFifo(join(target, "acceptance-build.json"));

      await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath }))
        .rejects.toThrow("acceptance-build.json");
      await expectDestinationSentinels(target, sentinels);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects Unix-socket destination acceptance metadata before mutation",
    async () => {
      const value = await fixture("/tmp", "k-");
      const { target, sentinels } = await seedDestinationSentinels(value);
      const metadata = join(target, "acceptance-build.json");
      const server = createServer();
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(metadata, () => {
          server.off("error", onError);
          resolvePromise();
        });
      });

      try {
        await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath }))
          .rejects.toThrow("acceptance-build.json");
        await expectDestinationSentinels(target, sentinels);
      } finally {
        await new Promise<void>((resolvePromise, reject) => {
          server.close((error) => {
            if (error === undefined) resolvePromise();
            else reject(error);
          });
        });
      }
    },
  );

  it("rejects injected device-shaped destination acceptance metadata before mutation", async () => {
    const value = await fixture();
    const { target, sentinels } = await seedDestinationSentinels(value);
    deviceStatInjection.path = join(await realpath(target), "acceptance-build.json");

    try {
      await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath }))
        .rejects.toThrow("acceptance-build.json");
      await expectDestinationSentinels(target, sentinels);
    } finally {
      deviceStatInjection.path = "";
    }
  });

  it("stops on concurrent destination acceptance metadata and restores managed bytes", async () => {
    for (const insertionPoint of ["main.js", "manifest.json", "styles.css"] as const) {
      const value = await fixture();
      const { target, sentinels } = await seedDestinationSentinels(value);

      await expect(installDevelopmentBuild({
        repoRoot: value.repoRoot,
        vaultPath: value.vaultPath,
        beforeRename: async (artifact: string) => {
          if (artifact === insertionPoint) {
            await writeFile(join(target, "acceptance-build.json"), "{}\n", "utf8");
          }
        },
      })).rejects.toThrow("acceptance-build.json");
      await expectDestinationSentinels(target, sentinels);
    }
  });

  it("rechecks destination acceptance metadata after awaited safety validation before publication", async () => {
    const value = await fixture();
    const { target, sentinels } = await seedDestinationSentinels(value);
    const before = await captureDestinationEvidence(target, sentinels);
    const metadata = join(await realpath(target), "acceptance-build.json");
    const communityPlugins = await realpath(join(
      value.vaultPath,
      OBSIDIAN_CONFIG_DIRECTORY,
      "community-plugins.json",
    ));
    let scheduled = false;

    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: (artifact: string) => {
        if (artifact !== "main.js" || scheduled) return;
        scheduled = true;
        scheduleAfterLstat(communityPlugins, 1, async () => {
          await writeFile(metadata, "{}\n", "utf8");
        });
      },
    })).rejects.toThrow("acceptance-build.json");

    await expect(readFile(metadata, "utf8")).resolves.toBe("{}\n");
    expect(await captureDestinationEvidence(target, sentinels)).toEqual(before);
  });

  it("rejects a missing community plugin manifest", async () => {
    const value = await fixture();
    const { rm } = await import("node:fs/promises");
    const community = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json");
    await rm(community);

    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
    })).rejects.toThrow(/community-plugins\.json.*existing|community-plugins\.json.*required/u);
  });

  it("rejects malformed or already-enabled community plugin state without modifying it", async () => {
    for (const content of ["{", JSON.stringify({ enabled: [] }), JSON.stringify(["knowledge-workbench"])]) {
      const value = await fixture();
      const community = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json");
      await writeFile(community, content, "utf8");
      await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath })).rejects.toThrow(/community-plugins|already enabled/u);
      await expect(readFile(community, "utf8")).resolves.toBe(content);
    }
  });

  it("copies exactly three build artifacts while preserving data and the community plugin manifest", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    // Installation must not normalize or adopt an upgraded catalog's local authority.
    const legacyData = `${JSON.stringify({ settings: {
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
      cloudVerificationGeneration: 0,
      boundCloudLibrary: null,
      recentCloudDirectories: { schemaVersion: 1, items: [{
        path: "/Synthetic Library", filename: "Synthetic Library", lastUsedAt: "2026-09-06T00:00:00.000Z",
      }] },
    }, syntheticSearchSentinel: "unchanged" }, null, 2)}\n`;
    await writeFile(join(target, "data.json"), legacyData, "utf8");
    const dataBefore = await lstat(join(target, "data.json"), { bigint: true });
    const community = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json");
    const originalCommunityPlugins = `[\n  "other-plugin"\n]\n`;
    await writeFile(community, originalCommunityPlugins, "utf8");

    const result = await installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath });

    expect(result.target).toBe(await realpath(resolve(target)));
    expect(result.communityPluginsModified).toBe(false);
    expect(installer.formatInstallSuccess(result)).toBe(
      `Installed development build at ${result.target}. Installer did not modify community-plugins.json.\n`,
    );
    expect(installer.formatInstallSuccess(result)).not.toContain("disabled");
    expect((await readdir(target)).sort()).toEqual(["data.json", "main.js", "manifest.json", "styles.css"]);
    await expect(readFile(join(target, "data.json"), "utf8")).resolves.toBe(legacyData);
    const dataAfter = await lstat(join(target, "data.json"), { bigint: true });
    expect({ ino: dataAfter.ino, mtimeNs: dataAfter.mtimeNs, size: dataAfter.size })
      .toEqual({ ino: dataBefore.ino, mtimeNs: dataBefore.mtimeNs, size: dataBefore.size });
    await expect(readFile(community, "utf8")).resolves.toBe(originalCommunityPlugins);
  });

  it("ignores an isolated acceptance build and installs only the three normal root artifacts", async () => {
    const value = await fixture();
    const acceptance = join(value.repoRoot, "dist", "read-only-acceptance");
    await mkdir(acceptance, { recursive: true });
    await writeFile(join(acceptance, "main.js"), "ACCEPTANCE-MAIN", "utf8");
    await writeFile(
      join(acceptance, "manifest.json"),
      JSON.stringify({
        id: "knowledge-workbench",
        name: "Knowledge Workbench (Read-only acceptance)",
        version: "0.1.0",
      }),
      "utf8",
    );
    await writeFile(join(acceptance, "styles.css"), "ACCEPTANCE-STYLES", "utf8");
    await writeFile(join(acceptance, "acceptance-build.json"), "ACCEPTANCE-METADATA", "utf8");

    const result = await installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath });

    expect(result.artifacts).toEqual(["main.js", "manifest.json", "styles.css"]);
    expect((await readdir(result.target)).sort()).toEqual(["main.js", "manifest.json", "styles.css"]);
    await expect(readFile(join(result.target, "main.js"), "utf8")).resolves.toBe("main-build");
    await expect(readFile(join(result.target, "styles.css"), "utf8")).resolves.toBe("styles-build");
    const rootManifest = JSON.parse(await readFile(join(value.repoRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
    const installedManifest = JSON.parse(await readFile(join(result.target, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(installedManifest).toEqual(rootManifest);
    expect(installedManifest.name).toBe("Knowledge Workbench");
  });

  it("cleans temporary artifacts after an injected copy failure", async () => {
    const value = await fixture();
    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: (artifact: string) => {
        if (artifact === "styles.css") throw new Error("injected installer failure");
      },
    })).rejects.toThrow("injected installer failure");
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    expect(await readdir(target)).toEqual([]);
  });

  it("rolls all three artifacts back when a later replacement fails", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
      await writeFile(join(target, artifact), `old-${artifact}`, "utf8");
    }
    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: (artifact: string) => {
        if (artifact === "styles.css") throw new Error("injected late failure");
      },
    })).rejects.toThrow("injected late failure");
    for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
      await expect(readFile(join(target, artifact), "utf8")).resolves.toBe(`old-${artifact}`);
    }
    expect((await readdir(target)).filter((name) => name.includes(".tmp-") || name.includes(".backup-"))).toEqual([]);
  });

  it("rechecks disabled community state before replacement and leaves no plugin artifacts", async () => {
    const value = await fixture();
    const community = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json");
    await writeFile(community, "[]", "utf8");
    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: async (artifact: string) => {
        if (artifact === "main.js") await writeFile(community, JSON.stringify(["knowledge-workbench"]), "utf8");
      },
    })).rejects.toThrow("already enabled");
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    expect(await readdir(target)).toEqual([]);
  });

  it("never recursively deletes an unexpected object that replaces a newly installed artifact", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    const { rm } = await import("node:fs/promises");
    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: async (artifact: string) => {
        if (artifact !== "manifest.json") return;
        await rm(join(target, "main.js"));
        await mkdir(join(target, "main.js"));
        await writeFile(join(target, "main.js", "sentinel"), "preserve", "utf8");
        throw new Error("artifact interference");
      },
    })).rejects.toThrow("rollback was incomplete");
    await expect(readFile(join(target, "main.js", "sentinel"), "utf8")).resolves.toBe("preserve");
  });

  it("retains the old backup when an unexpected object prevents restoration", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "main.js"), "old-main", "utf8");
    const { rm } = await import("node:fs/promises");
    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: async (artifact: string) => {
        if (artifact !== "manifest.json") return;
        await rm(join(target, "main.js"));
        await mkdir(join(target, "main.js"));
        await writeFile(join(target, "main.js", "sentinel"), "preserve", "utf8");
        throw new Error("restore interference");
      },
    })).rejects.toThrow("backup retained");
    await expect(readFile(join(target, "main.js", "sentinel"), "utf8")).resolves.toBe("preserve");
    const backup = (await readdir(target)).find((name) => name.includes(".main.js.backup-"));
    expect(backup).toBeTypeOf("string");
    if (backup === undefined) throw new Error("expected a retained main.js backup");
    await expect(readFile(join(target, backup), "utf8")).resolves.toBe("old-main");
  });

  it("does not restore a backup file whose identity changed after staging", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "main.js"), "old-main", "utf8");
    const { rm } = await import("node:fs/promises");

    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: async (artifact: string) => {
        if (artifact !== "manifest.json") return;
        const backup = (await readdir(target)).find((name) => name.includes(".main.js.backup-"));
        if (backup === undefined) throw new Error("expected staged main.js backup");
        const backupPath = join(target, backup);
        await rm(backupPath);
        await writeFile(backupPath, "untrusted-replacement", "utf8");
        throw new Error("backup identity interference");
      },
    })).rejects.toThrow("rollback was incomplete");

    await expect(readFile(join(target, "main.js"), "utf8")).resolves.toBe("main-build");
    const retained = (await readdir(target)).find((name) => name.includes(".main.js.backup-"));
    if (retained === undefined) throw new Error("expected the untrusted replacement to remain untouched");
    await expect(readFile(join(target, retained), "utf8")).resolves.toBe("untrusted-replacement");
  });

  it("preserves the rollback diagnosis when owned temporary cleanup is denied", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "main.js"), "old-main", "utf8");
    const { rm } = await import("node:fs/promises");
    let failure: unknown;

    try {
      await installDevelopmentBuild({
        repoRoot: value.repoRoot,
        vaultPath: value.vaultPath,
        beforeRename: async (artifact: string) => {
          if (artifact !== "manifest.json") return;
          await rm(join(target, "main.js"));
          await mkdir(join(target, "main.js"));
          await writeFile(join(target, "main.js", "sentinel"), "preserve", "utf8");
          await chmod(target, 0o555);
          throw new Error("cleanup permission interference");
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      await chmod(target, 0o755);
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain("rollback was incomplete; backup retained for manual recovery");
    await expect(readFile(join(target, "main.js", "sentinel"), "utf8")).resolves.toBe("preserve");
    const backup = (await readdir(target)).find((name) => name.includes(".main.js.backup-"));
    if (backup === undefined) throw new Error("expected a retained main.js backup");
    await expect(readFile(join(target, backup), "utf8")).resolves.toBe("old-main");
  });

  it("does not follow a replaced target directory during rollback or cleanup", async () => {
    const value = await fixture();
    const target = join(value.vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins", "knowledge-workbench");
    const moved = join(value.repoRoot, "moved-plugin-target");
    const outside = join(value.repoRoot, "outside-rollback");
    await mkdir(outside);
    await writeFile(join(outside, "main.js"), "outside-sentinel", "utf8");
    await expect(installDevelopmentBuild({
      repoRoot: value.repoRoot,
      vaultPath: value.vaultPath,
      beforeRename: async (artifact: string) => {
        if (artifact !== "manifest.json") return;
        await rename(target, moved);
        await symlink(outside, target);
        throw new Error("target interference");
      },
    })).rejects.toThrow("rollback was incomplete");
    await expect(readFile(join(outside, "main.js"), "utf8")).resolves.toBe("outside-sentinel");
  });
});
