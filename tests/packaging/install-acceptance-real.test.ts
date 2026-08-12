import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface HostProbeState {
  calls: number;
  mode: "stopped" | "running" | "unknown";
  runningAtCall: number | null;
}

const hostProbe = vi.hoisted<HostProbeState>(() => ({
  calls: 0,
  mode: "stopped",
  runningAtCall: null,
}));

const gitProbe = vi.hoisted(() => ({
  assertCalls: 0,
  captureCalls: 0,
  commit: "a".repeat(40),
  failAssertAtCall: null as number | null,
  failCapture: false,
}));

const fileSystemFault = vi.hoisted(() => ({
  beforeRunningProbe: null as null | (() => Promise<void>),
  communityPath: null as string | null,
  displacedPluginsPath: null as string | null,
  displacedTargetPath: null as string | null,
  enablePluginOnPublish: false,
  failBackupRestore: false,
  failRmdirIncludes: null as string | null,
  failRmdirSuffix: null as string | null,
  failStagePublish: false,
  forbiddenContentPath: null as string | null,
  forbiddenContentReads: 0,
  foreignPluginsPath: null as string | null,
  injected: false,
  pluginsPath: null as string | null,
  publishedTargetPath: null as string | null,
  replaceCleanupSourceAfterClaim: false,
  replacePluginsParentOnPublish: false,
  replacePublishedTargetOnRead: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...rawArguments: unknown[]) => {
      const [file] = rawArguments;
      if (file !== "/usr/bin/pgrep") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- preserve Node overloads.
        return Reflect.apply(actual.execFile, actual, rawArguments);
      }
      const callback = rawArguments.at(-1);
      if (typeof callback !== "function") throw new Error("test expected callback-style pgrep");
      hostProbe.calls += 1;
      if (
        hostProbe.mode === "running"
        || (hostProbe.runningAtCall !== null && hostProbe.calls >= hostProbe.runningAtCall)
      ) {
        if (fileSystemFault.beforeRunningProbe !== null) {
          const action = fileSystemFault.beforeRunningProbe;
          fileSystemFault.beforeRunningProbe = null;
          void action().then(
            () => { Reflect.apply(callback, undefined, [null, "123\n", ""]); },
            (error: unknown) => { Reflect.apply(callback, undefined, [error, "", ""]); },
          );
          return undefined;
        }
        Reflect.apply(callback, undefined, [null, "123\n", ""]);
        return undefined;
      }
      const error = Object.assign(new Error("sanitized test pgrep failure"), {
        code: hostProbe.mode === "stopped" ? 1 : 2,
      });
      Reflect.apply(callback, undefined, [error, "", ""]);
      return undefined;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const path = String(args[0]);
      if (fileSystemFault.forbiddenContentPath === path) {
        fileSystemFault.forbiddenContentReads += 1;
        throw Object.assign(new Error("private vault content must not be traversed"), {
          code: "EACCES",
        });
      }
      if (
        !fileSystemFault.injected
        && fileSystemFault.replacePublishedTargetOnRead
        && fileSystemFault.publishedTargetPath === path
      ) {
        fileSystemFault.injected = true;
        const displacedPath = `${path}-owned-moved`;
        fileSystemFault.displacedTargetPath = displacedPath;
        await actual.rename(path, displacedPath);
        await actual.mkdir(path, { mode: 0o700 });
        await actual.writeFile(join(path, "acceptance-build.json"), "FOREIGN acceptance\n");
        await actual.writeFile(join(path, "main.js"), "FOREIGN main\n");
        await actual.writeFile(join(path, "manifest.json"), "FOREIGN manifest\n");
        await actual.writeFile(join(path, "styles.css"), "FOREIGN styles\n");
        throw Object.assign(new Error("private injected published-target replacement"), {
          code: "EIO",
        });
      }
      return actual.readdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const source = String(args[0]);
      const destination = String(args[1]);
      const publishesAcceptance = (
        source.endsWith("/.knowledge-workbench-read-only-install.transaction/stage")
        && destination.endsWith("/plugins/knowledge-workbench")
      );
      if (
        !fileSystemFault.injected
        && fileSystemFault.enablePluginOnPublish
        && publishesAcceptance
        && fileSystemFault.communityPath !== null
      ) {
        fileSystemFault.injected = true;
        await actual.writeFile(
          fileSystemFault.communityPath,
          `${JSON.stringify(["knowledge-workbench"])}\n`,
          "utf8",
        );
      }
      if (
        !fileSystemFault.injected
        && fileSystemFault.replacePluginsParentOnPublish
        && publishesAcceptance
        && fileSystemFault.pluginsPath !== null
        && fileSystemFault.displacedPluginsPath !== null
        && fileSystemFault.foreignPluginsPath !== null
      ) {
        fileSystemFault.injected = true;
        await actual.rename(fileSystemFault.pluginsPath, fileSystemFault.displacedPluginsPath);
        await actual.mkdir(fileSystemFault.foreignPluginsPath, { mode: 0o700 });
        await actual.symlink(fileSystemFault.foreignPluginsPath, fileSystemFault.pluginsPath);
      }
      if (
        !fileSystemFault.injected
        && fileSystemFault.failStagePublish
        && publishesAcceptance
      ) {
        fileSystemFault.injected = true;
        throw Object.assign(new Error("private injected stage publication failure"), {
          code: "EIO",
        });
      }
      if (
        !fileSystemFault.injected
        && fileSystemFault.failBackupRestore
        && source.endsWith("/.knowledge-workbench-read-only-install.transaction/backup")
        && destination.endsWith("/plugins/knowledge-workbench")
      ) {
        fileSystemFault.injected = true;
        throw Object.assign(new Error("private injected backup restore failure"), {
          code: "EIO",
        });
      }
      const result = await actual.rename(...args);
      if (
        !fileSystemFault.injected
        && fileSystemFault.replaceCleanupSourceAfterClaim
        && source.endsWith("/.knowledge-workbench-read-only-install.transaction/backup")
        && destination.includes("/backup.cleanup-")
      ) {
        fileSystemFault.injected = true;
        await actual.mkdir(source, { mode: 0o700 });
        await actual.writeFile(join(source, "foreign.txt"), "FOREIGN backup name\n");
      }
      if (
        fileSystemFault.replacePublishedTargetOnRead
        && publishesAcceptance
      ) fileSystemFault.publishedTargetPath = destination;
      return result;
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      const path = String(args[0]);
      if (
        !fileSystemFault.injected
        && (
          (fileSystemFault.failRmdirSuffix !== null
            && path.endsWith(fileSystemFault.failRmdirSuffix))
          || (fileSystemFault.failRmdirIncludes !== null
            && path.includes(fileSystemFault.failRmdirIncludes))
        )
      ) {
        fileSystemFault.injected = true;
        throw Object.assign(new Error("private injected transaction cleanup failure"), {
          code: "EIO",
        });
      }
      return actual.rmdir(...args);
    },
  };
});

vi.mock("../../scripts/git-worktree-state.mjs", () => ({
  assertCleanGitState: async (_repoRoot: string, expectedCommit: string) => {
    gitProbe.assertCalls += 1;
    if (
      expectedCommit !== gitProbe.commit
      || gitProbe.failAssertAtCall === gitProbe.assertCalls
    ) throw new Error("sanitized test Git state changed");
  },
  captureCleanGitState: async (_repoRoot: string) => {
    gitProbe.captureCalls += 1;
    if (gitProbe.failCapture) throw new Error("sanitized test Git state unavailable");
    return Object.freeze({ commit: gitProbe.commit });
  },
  assertTrackedBuildInputs: async (_repoRoot: string, _paths: readonly string[]) => undefined,
  assertTrackedGitState: async (_repoRoot: string, expectedCommit: string) => {
    gitProbe.assertCalls += 1;
    if (
      expectedCommit !== gitProbe.commit
      || gitProbe.failAssertAtCall === gitProbe.assertCalls
    ) throw new Error("sanitized test Git state changed");
  },
  captureTrackedGitState: async (_repoRoot: string) => {
    gitProbe.captureCalls += 1;
    if (gitProbe.failCapture) throw new Error("sanitized test Git state unavailable");
    return Object.freeze({ commit: gitProbe.commit });
  },
}));

// @ts-expect-error The installer is intentionally plain ESM without a declaration file.
import * as realInstallerModule from "../../scripts/install-acceptance-real.mjs";
// @ts-expect-error The shared path contract is intentionally plain ESM without declarations.
import * as vaultCoreModule from "../../scripts/synthetic-vault-install-core.mjs";

interface RealVaultInstallResult {
  readonly artifactBinding: string;
  readonly artifactSetDigest: string;
  readonly backupRetained: boolean;
  readonly pluginVersion: string;
  readonly priorTarget: "absent" | "replaced";
}

interface RealInstallerModule {
  readonly installRealVaultAcceptance: (input: Readonly<{
    action: string;
    repoRoot: string;
    vaultPath: string;
  }>) => Promise<Readonly<RealVaultInstallResult>>;
  readonly installRealVaultNormal: (input: Readonly<{
    action: string;
    repoRoot: string;
    vaultPath: string;
  }>) => Promise<Readonly<RealVaultInstallResult>>;
}

const installer = realInstallerModule as unknown as RealInstallerModule;
const { installRealVaultAcceptance, installRealVaultNormal } = installer;
const { OBSIDIAN_CONFIG_DIRECTORY } = vaultCoreModule as unknown as {
  readonly OBSIDIAN_CONFIG_DIRECTORY: string;
};

const CLI_PATH = resolve("scripts/install-acceptance-real-cli.mjs");
const NORMAL_CLI_PATH = resolve("scripts/install-normal-real-cli.mjs");
const AUTHORIZED_ACTION = "INSTALL_READ_ONLY_ACCEPTANCE_IN_THIS_VAULT";
const NORMAL_AUTHORIZED_ACTION = "INSTALL_NORMAL_BUILD_IN_THIS_VAULT";
const extractorDescriptor = Object.getOwnPropertyDescriptor(
  installRealVaultAcceptance,
  "extractFailureCategory",
);
const rawExtractor: unknown = extractorDescriptor?.value;
if (typeof rawExtractor !== "function") {
  throw new Error("real-vault installer failure-category extractor is unavailable");
}
const extractFailureCategory = (error: unknown): string | null => {
  const value: unknown = Reflect.apply(rawExtractor, undefined, [error]);
  return typeof value === "string" ? value : null;
};

beforeEach(() => {
  fileSystemFault.beforeRunningProbe = null;
  fileSystemFault.communityPath = null;
  fileSystemFault.displacedPluginsPath = null;
  fileSystemFault.displacedTargetPath = null;
  fileSystemFault.enablePluginOnPublish = false;
  fileSystemFault.failBackupRestore = false;
  fileSystemFault.failRmdirIncludes = null;
  fileSystemFault.failRmdirSuffix = null;
  fileSystemFault.failStagePublish = false;
  fileSystemFault.forbiddenContentPath = null;
  fileSystemFault.forbiddenContentReads = 0;
  fileSystemFault.foreignPluginsPath = null;
  fileSystemFault.injected = false;
  fileSystemFault.pluginsPath = null;
  fileSystemFault.publishedTargetPath = null;
  fileSystemFault.replaceCleanupSourceAfterClaim = false;
  fileSystemFault.replacePluginsParentOnPublish = false;
  fileSystemFault.replacePublishedTargetOnRead = false;
  hostProbe.calls = 0;
  hostProbe.mode = "stopped";
  hostProbe.runningAtCall = null;
  gitProbe.assertCalls = 0;
  gitProbe.captureCalls = 0;
  gitProbe.failAssertAtCall = null;
  gitProbe.failCapture = false;
});

function runCli(input: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env,
    input,
  });
}

function runNormalCli(input: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [NORMAL_CLI_PATH, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env,
    input,
  });
}

describe("real-vault normal installer public entry point", () => {
  it("exposes one dedicated private-stdin CLI script", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["install:normal:real"])
      .toBe("node scripts/install-normal-real-cli.mjs");
    expect(existsSync(NORMAL_CLI_PATH)).toBe(true);
    const runbook = readFileSync(
      resolve("docs/runbooks/real-vault-normal-catalog.md"),
      "utf8",
    );
    expect(runbook).toContain("INSTALL_NORMAL_BUILD_IN_THIS_VAULT");
    expect(runbook).toContain("does not read Markdown or attachments");
    expect(runbook).not.toContain("/Users/");
  });

  it("fails closed on an invalid private stdin request", () => {
    const result = runNormalCli("{}\n");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault normal installation failed: invalid-invocation.\n",
    );
  });

  it("classifies an unavailable target without echoing private input", () => {
    const privatePath = "/tmp/private-normal-real-vault-do-not-echo";
    const result = runNormalCli(`${JSON.stringify({
      action: NORMAL_AUTHORIZED_ACTION,
      vaultPath: privatePath,
    })}\n`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault normal installation failed: vault-invalid.\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(privatePath);
    expect(`${result.stdout}${result.stderr}`).not.toContain("do-not-echo");
  });

  it("rejects path-bearing arguments and environment overrides", () => {
    const privatePath = "/tmp/private-normal-override-do-not-echo";
    const input = `${JSON.stringify({
      action: NORMAL_AUTHORIZED_ACTION,
      vaultPath: privatePath,
    })}\n`;
    const argumentResult = runNormalCli(input, [privatePath]);
    const environmentResult = runNormalCli(input, [], {
      ...process.env,
      KNOWLEDGE_WORKBENCH_REAL_VAULT: privatePath,
    });

    for (const result of [argumentResult, environmentResult]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Real-vault normal installation failed: invalid-invocation.\n",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(privatePath);
    }
  });

  it("publishes exactly the normal artifact and preserves opaque data", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-normal-install-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY);
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const opaqueData = Buffer.from("OPAQUE plugin data\n", "utf8");
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    await writeFile(join(targetPath, "data.json"), opaqueData);

    try {
      const result = await installRealVaultNormal({
        action: NORMAL_AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      });

      expect(result.artifactBinding).toBe("knowledge-workbench@0.1.0:normal");
      expect(result.priorTarget).toBe("replaced");
      expect(await readdir(targetPath)).toEqual([
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readFile(join(targetPath, "data.json"))).toEqual(opaqueData);
      expect(await readFile(join(targetPath, "manifest.json"))).toEqual(
        await readFile(join(repoRoot, "manifest.json")),
      );
      expect(await readFile(join(targetPath, "styles.css"))).toEqual(
        await readFile(join(repoRoot, "styles.css")),
      );
      expect((await readFile(join(targetPath, "main.js"), "utf8")))
        .toContain("knowledge-workbench@0.1.0:normal");
      expect(JSON.parse(await readFile(join(obsidianPath, "community-plugins.json"), "utf8")))
        .toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops before building when Knowledge Workbench remains enabled", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-normal-enabled-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    await mkdir(join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "plugins"), { recursive: true });
    await writeFile(
      join(vaultPath, OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json"),
      `${JSON.stringify(["knowledge-workbench"])}\n`,
      "utf8",
    );

    try {
      await expect(installRealVaultNormal({
        action: NORMAL_AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "plugin-enabled",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("real-vault read-only acceptance installer public entry point", () => {
  it("exposes one dedicated no-argument CLI script", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["install:acceptance:real"])
      .toBe("node scripts/install-acceptance-real-cli.mjs");
    expect(existsSync(resolve("scripts/install-acceptance-real-cli.mjs"))).toBe(true);
  });

  it("fails closed on an invalid private stdin request", () => {
    const result = runCli("{}\n");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault acceptance installation failed: invalid-invocation.\n",
    );
  });

  it("classifies an unavailable explicit target without echoing private input", () => {
    const privatePath = "/tmp/private-real-vault-secret-do-not-echo";
    const result = runCli(`${JSON.stringify({
      action: AUTHORIZED_ACTION,
      vaultPath: privatePath,
    })}\n`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault acceptance installation failed: vault-invalid.\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(privatePath);
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-do-not-echo");
  });

  it("rejects every path-bearing command-line argument", () => {
    const privatePath = "/tmp/private-argv-vault-do-not-echo";
    const input = `${JSON.stringify({ action: AUTHORIZED_ACTION, vaultPath: privatePath })}\n`;
    const result = runCli(input, [privatePath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault acceptance installation failed: invalid-invocation.\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(privatePath);
  });

  it.each([
    "OBSIDIAN_DEV_VAULT",
    "KNOWLEDGE_WORKBENCH_REAL_VAULT",
    "KNOWLEDGE_WORKBENCH_CUSTOM_ARTIFACT_PATH",
  ])("rejects the path-bearing environment override %s", (name) => {
    const privatePath = "/tmp/private-env-vault-do-not-echo";
    const input = `${JSON.stringify({ action: AUTHORIZED_ACTION, vaultPath: privatePath })}\n`;
    const env = { ...process.env, [name]: privatePath };
    const result = runCli(input, [], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault acceptance installation failed: invalid-invocation.\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(privatePath);
  });

  it("rejects a private request with any extra key", () => {
    const privatePath = "/tmp/private-extra-key-vault";
    const result = runCli(`${JSON.stringify({
      action: AUTHORIZED_ACTION,
      guessedFromRecentVault: true,
      vaultPath: privatePath,
    })}\n`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault acceptance installation failed: invalid-invocation.\n",
    );
  });

  it("rejects a private stdin request larger than 16 KiB", () => {
    const oversizedPath = `/tmp/${"x".repeat(17 * 1024)}`;
    const result = runCli(`${JSON.stringify({
      action: AUTHORIZED_ACTION,
      vaultPath: oversizedPath,
    })}\n`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Real-vault acceptance installation failed: invalid-invocation.\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("x".repeat(128));
  });

  it("advances past a canonical disabled-plugin vault before rejecting a missing artifact", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-preflight-")));
    const repoRoot = join(root, "repo");
    const vaultPath = join(root, "vault");
    await mkdir(repoRoot);
    await mkdir(join(vaultPath, ".obsidian", "plugins"), { recursive: true });
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), "[]\n", "utf8");

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy((error: unknown) => extractFailureCategory?.(error) === "artifact-invalid");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops when Knowledge Workbench remains enabled", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-enabled-")));
    const repoRoot = join(root, "repo");
    const vaultPath = join(root, "vault");
    await mkdir(repoRoot);
    await mkdir(join(vaultPath, ".obsidian", "plugins"), { recursive: true });
    await writeFile(
      join(vaultPath, ".obsidian", "community-plugins.json"),
      `${JSON.stringify(["another-plugin", "knowledge-workbench"])}\n`,
      "utf8",
    );

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory?.(error) === "plugin-enabled",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops when the Obsidian process probe observes a running host", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-host-")));
    const repoRoot = join(root, "repo");
    const vaultPath = join(root, "vault");
    await mkdir(repoRoot);
    await mkdir(join(vaultPath, ".obsidian", "plugins"), { recursive: true });
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), "[]\n", "utf8");
    hostProbe.mode = "running";

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory?.(error) === "host-running",
      );
      expect(hostProbe.calls).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails closed when the Obsidian process state is unknown", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-host-unknown-")));
    const repoRoot = join(root, "repo");
    const vaultPath = join(root, "vault");
    await mkdir(repoRoot);
    await mkdir(join(vaultPath, ".obsidian", "plugins"), { recursive: true });
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), "[]\n", "utf8");
    hostProbe.mode = "unknown";

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "host-state-unknown",
      );
      expect(hostProbe.calls).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a symlink plugin target without following it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-target-link-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const pluginsPath = join(obsidianPath, "plugins");
    const foreignTarget = join(root, "foreign-target");
    await mkdir(pluginsPath, { recursive: true });
    await mkdir(foreignTarget);
    await writeFile(join(foreignTarget, "foreign.txt"), "DO NOT READ OR DELETE\n");
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    await symlink(
      foreignTarget,
      join(pluginsPath, "knowledge-workbench"),
    );

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "target-invalid",
      );
      expect(await readFile(join(foreignTarget, "foreign.txt"), "utf8"))
        .toBe("DO NOT READ OR DELETE\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a partial managed target instead of repairing it file by file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-target-partial-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    await writeFile(join(targetPath, "main.js"), "PARTIAL target\n");

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "target-invalid",
      );
      expect(await readdir(targetPath)).toEqual(["main.js"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("never traverses vault content outside the fixed Obsidian configuration chain", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-no-content-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const privateContentPath = join(vaultPath, "Private Notes");
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await mkdir(privateContentPath);
    await writeFile(join(privateContentPath, "secret.md"), "PRIVATE CONTENT\n");
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    fileSystemFault.forbiddenContentPath = privateContentPath;

    try {
      await installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      });
      expect(fileSystemFault.forbiddenContentReads).toBe(0);
      expect(await readFile(join(privateContentPath, "secret.md"), "utf8"))
        .toBe("PRIVATE CONTENT\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects reserved transaction residue as a concurrent operation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-residue-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const transactionPath = join(
      obsidianPath,
      ".knowledge-workbench-read-only-install.transaction",
    );
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await mkdir(transactionPath);
    await writeFile(join(transactionPath, "recovery.txt"), "RETAIN FOR RECOVERY\n");
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "concurrent-operation",
      );
      expect(await readFile(join(transactionPath, "recovery.txt"), "utf8"))
        .toBe("RETAIN FOR RECOVERY\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails closed when the repository clean state cannot be captured", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-git-capture-")));
    const repoRoot = join(root, "repo");
    const vaultPath = join(root, "vault");
    await mkdir(repoRoot);
    await mkdir(join(vaultPath, ".obsidian", "plugins"), { recursive: true });
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), "[]\n", "utf8");
    gitProbe.failCapture = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "artifact-invalid",
      );
      expect(gitProbe.captureCalls).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops before publication when the clean Git commit changes after build", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-git-race-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    gitProbe.failAssertAtCall = 3;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "artifact-changed",
      );
      expect(gitProbe.assertCalls).toBe(3);
      await expect(realpath(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cleans the unpublished stage if Obsidian starts before the final publication boundary", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-host-race-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    hostProbe.runningAtCall = 3;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory?.(error) === "host-running",
      );
      expect(hostProbe.calls).toBe(3);
      await expect(realpath(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(obsidianPath)).toEqual([
        "community-plugins.json",
        "plugins",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("retains a foreign replacement of the unpublished stage for manual recovery", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-stage-race-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const transactionPath = join(
      obsidianPath,
      ".knowledge-workbench-read-only-install.transaction",
    );
    const stagePath = join(transactionPath, "stage");
    const movedStagePath = join(transactionPath, "stage-owned-moved");
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    hostProbe.runningAtCall = 3;
    fileSystemFault.beforeRunningProbe = async () => {
      await rename(stagePath, movedStagePath);
      await mkdir(stagePath, { mode: 0o700 });
      await writeFile(join(stagePath, "acceptance-build.json"), "FOREIGN acceptance\n");
      await writeFile(join(stagePath, "main.js"), "FOREIGN main\n");
      await writeFile(join(stagePath, "manifest.json"), "FOREIGN manifest\n");
      await writeFile(join(stagePath, "styles.css"), "FOREIGN styles\n");
    };

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory?.(error) === "cleanup-incomplete",
      );
      await expect(realpath(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(stagePath, "main.js"), "utf8")).toBe("FOREIGN main\n");
      expect(await readdir(stagePath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readdir(movedStagePath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("publishes one complete read-only acceptance directory into an absent target", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-absent-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");

    try {
      const result = await installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      });

      expect(result).toMatchObject({
        artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
        backupRetained: false,
        pluginVersion: "0.1.0",
        priorTarget: "absent",
      });
      expect(await readdir(targetPath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readdir(obsidianPath)).toEqual([
        "community-plugins.json",
        "plugins",
      ]);
      expect(hostProbe.calls).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("never reports success if the plugins parent is replaced during publication", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-parent-race-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const pluginsPath = join(obsidianPath, "plugins");
    const displacedPluginsPath = join(obsidianPath, "plugins-owned-moved");
    const foreignPluginsPath = join(root, "foreign-plugins");
    const foreignTargetPath = join(foreignPluginsPath, "knowledge-workbench");
    await mkdir(pluginsPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    fileSystemFault.displacedPluginsPath = displacedPluginsPath;
    fileSystemFault.foreignPluginsPath = foreignPluginsPath;
    fileSystemFault.pluginsPath = pluginsPath;
    fileSystemFault.replacePluginsParentOnPublish = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "rollback-incomplete",
      );
      expect(fileSystemFault.injected).toBe(true);
      expect(await readdir(foreignTargetPath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readdir(displacedPluginsPath)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("never restores an existing target through a replaced plugins parent", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-parent-restore-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const pluginsPath = join(obsidianPath, "plugins");
    const targetPath = join(pluginsPath, "knowledge-workbench");
    const displacedPluginsPath = join(obsidianPath, "plugins-owned-moved");
    const foreignPluginsPath = join(root, "foreign-plugins");
    const foreignTargetPath = join(foreignPluginsPath, "knowledge-workbench");
    const backupPath = join(
      obsidianPath,
      ".knowledge-workbench-read-only-install.transaction",
      "backup",
    );
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    fileSystemFault.displacedPluginsPath = displacedPluginsPath;
    fileSystemFault.foreignPluginsPath = foreignPluginsPath;
    fileSystemFault.pluginsPath = pluginsPath;
    fileSystemFault.replacePluginsParentOnPublish = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "rollback-incomplete",
      );
      expect(fileSystemFault.injected).toBe(true);
      expect(await readdir(foreignTargetPath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readdir(displacedPluginsPath)).toEqual([]);
      expect(await readdir(backupPath)).toEqual([
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rolls back if the plugin becomes enabled during publication", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-plugin-race-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const communityPath = join(obsidianPath, "community-plugins.json");
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await writeFile(communityPath, "[]\n", "utf8");
    fileSystemFault.communityPath = communityPath;
    fileSystemFault.enablePluginOnPublish = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "plugin-state-changed",
      );
      expect(fileSystemFault.injected).toBe(true);
      await expect(realpath(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("replaces one bounded normal target while preserving opaque plugin data", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-existing-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const opaqueData = Buffer.from([0x00, 0xff, 0x7b, 0x6e, 0x6f, 0x74, 0x2d, 0x6a, 0x73, 0x6f, 0x6e]);
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    await writeFile(join(targetPath, "data.json"), opaqueData);

    try {
      const result = await installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      });

      expect(result).toMatchObject({
        backupRetained: false,
        priorTarget: "replaced",
      });
      expect(await readdir(targetPath)).toEqual([
        "acceptance-build.json",
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readFile(join(targetPath, "data.json"))).toEqual(opaqueData);
      expect(await readdir(obsidianPath)).toEqual([
        "community-plugins.json",
        "plugins",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restores the exact existing target if stage publication fails after backup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-publish-fail-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const opaqueData = Buffer.from([0x00, 0xff, 0x42, 0x41, 0x43, 0x4b, 0x55, 0x50]);
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    const originalMain = await readFile(join(targetPath, "main.js"));
    await writeFile(join(targetPath, "data.json"), opaqueData);
    fileSystemFault.failStagePublish = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "target-changed",
      );
      expect(fileSystemFault.injected).toBe(true);
      expect(await readdir(targetPath)).toEqual([
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readFile(join(targetPath, "main.js"))).toEqual(originalMain);
      expect(await readFile(join(targetPath, "data.json"))).toEqual(opaqueData);
      expect(await readdir(obsidianPath)).toEqual([
        "community-plugins.json",
        "plugins",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restores the exact existing target after a post-publication validation failure", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-postpublish-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const opaqueData = Buffer.from("ORIGINAL postpublication data\n", "utf8");
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    const originalMain = await readFile(join(targetPath, "main.js"));
    await writeFile(join(targetPath, "data.json"), opaqueData);
    gitProbe.failAssertAtCall = 5;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "artifact-changed",
      );
      expect(await readdir(targetPath)).toEqual([
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readFile(join(targetPath, "main.js"))).toEqual(originalMain);
      expect(await readFile(join(targetPath, "data.json"))).toEqual(opaqueData);
      expect(await readdir(obsidianPath)).toEqual([
        "community-plugins.json",
        "plugins",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("retains the exact backup when rollback cannot restore it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-restore-fail-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const transactionPath = join(
      obsidianPath,
      ".knowledge-workbench-read-only-install.transaction",
    );
    const backupPath = join(transactionPath, "backup");
    const quarantinePath = join(transactionPath, "quarantine");
    const opaqueData = Buffer.from("ORIGINAL rollback data\n", "utf8");
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    const originalMain = await readFile(join(targetPath, "main.js"));
    await writeFile(join(targetPath, "data.json"), opaqueData);
    gitProbe.failAssertAtCall = 5;
    fileSystemFault.failBackupRestore = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "rollback-incomplete",
      );
      expect(fileSystemFault.injected).toBe(true);
      await expect(realpath(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(backupPath)).toEqual([
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readFile(join(backupPath, "main.js"))).toEqual(originalMain);
      expect(await readFile(join(backupPath, "data.json"))).toEqual(opaqueData);
      expect(await readdir(quarantinePath)).toEqual([
        "acceptance-build.json",
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports post-commit transaction cleanup failure without undoing a complete publication", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-cleanup-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const transactionName = ".knowledge-workbench-read-only-install.transaction";
    await mkdir(join(obsidianPath, "plugins"), { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    fileSystemFault.failRmdirSuffix = transactionName;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory?.(error) === "cleanup-incomplete",
      );
      expect(fileSystemFault.injected).toBe(true);
      expect(await readdir(targetPath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readdir(join(obsidianPath, transactionName))).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("classifies a partially removed obsolete backup as cleanup incomplete", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-backup-cleanup-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    fileSystemFault.failRmdirIncludes = "backup.cleanup-";

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "cleanup-incomplete",
      );
      expect(fileSystemFault.injected).toBe(true);
      expect(await readdir(targetPath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("never deletes a foreign directory that reclaims the obsolete backup name", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-backup-race-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const backupPath = join(
      obsidianPath,
      ".knowledge-workbench-read-only-install.transaction",
      "backup",
    );
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    fileSystemFault.replaceCleanupSourceAfterClaim = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory(error) === "cleanup-incomplete",
      );
      expect(fileSystemFault.injected).toBe(true);
      expect(await readFile(join(backupPath, "foreign.txt"), "utf8"))
        .toBe("FOREIGN backup name\n");
      expect(await readdir(targetPath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("never quarantines or deletes a foreign directory that replaces the published target", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kwb-real-installer-foreign-")));
    const repoRoot = await realpath(resolve("."));
    const vaultPath = join(root, "vault");
    const obsidianPath = join(vaultPath, ".obsidian");
    const targetPath = join(obsidianPath, "plugins", "knowledge-workbench");
    const transactionPath = join(
      obsidianPath,
      ".knowledge-workbench-read-only-install.transaction",
    );
    const opaqueData = Buffer.from("ORIGINAL opaque data\n", "utf8");
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(obsidianPath, "community-plugins.json"), "[]\n", "utf8");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(repoRoot, name), join(targetPath, name));
    }
    await writeFile(join(targetPath, "data.json"), opaqueData);
    fileSystemFault.replacePublishedTargetOnRead = true;

    try {
      await expect(installRealVaultAcceptance({
        action: AUTHORIZED_ACTION,
        repoRoot,
        vaultPath,
      })).rejects.toSatisfy(
        (error: unknown) => extractFailureCategory?.(error) === "rollback-incomplete",
      );
      expect(fileSystemFault.injected).toBe(true);
      expect(await readFile(join(targetPath, "main.js"), "utf8")).toBe("FOREIGN main\n");
      expect(await readdir(targetPath)).toEqual([
        "acceptance-build.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(fileSystemFault.displacedTargetPath).not.toBeNull();
      expect(await readdir(fileSystemFault.displacedTargetPath!)).toEqual([
        "acceptance-build.json",
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      expect(await readdir(transactionPath)).toEqual(["backup"]);
      expect(await readFile(join(transactionPath, "backup", "data.json"))).toEqual(opaqueData);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
