import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
  SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
} from "../../scripts/synthetic-note-fixture.mjs";

interface PreparationState {
  readonly runId: string;
  readonly commit: string;
  readonly syntheticNoteCount: 5000;
  readonly syntheticTotalBytes: 78643200;
  readonly corpusDigest: string;
}

interface RunContractModule {
  readonly ACCEPTANCE_REPORT_RELATIVE_PATH: string;
  readonly INSTALLATION_RECEIPT_RELATIVE_PATH: string;
  readonly PREPARATION_STATE_RELATIVE_PATH: string;
  readonly SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH: string;
  readonly decodePreparationState: (bytes: Uint8Array) => PreparationState;
  readonly encodePreparationState: (state: PreparationState) => Buffer;
}

interface VaultCoreModule {
  readonly OBSIDIAN_CONFIG_DIRECTORY: string;
  readonly TEST_VAULT_MARKER: Readonly<Record<string, unknown>>;
}

type PreparationHook =
  | "afterLockAcquired"
  | "afterStageCreated"
  | "afterStagePopulated"
  | "afterStateStaged"
  | "beforeVaultPublish"
  | "afterVaultPublish"
  | "beforeStatePublish"
  | "afterStatePublish";

interface PreparationHookContext {
  readonly repoRoot: string;
  readonly devRoot: string;
  readonly lockPath: string;
  readonly vaultStagePath: string | null;
  readonly stateStagePath: string | null;
  readonly vaultPath: string;
  readonly statePath: string;
  readonly runId: string | null;
  readonly commit: string | null;
}

interface PreparationModule {
  prepareSyntheticAcceptance(options: Readonly<{
    repoRoot: string;
    hooks?: Partial<Record<PreparationHook, (
      context: Readonly<PreparationHookContext>,
    ) => void | Promise<void>>>;
  }>): Promise<Readonly<{
    runId: string;
    commit: string;
    syntheticNoteCount: 5000;
    syntheticTotalBytes: 78643200;
  }>>;
}

interface AcceptanceVaultModule {
  attestSyntheticAcceptanceVault(input: Readonly<{
    vaultPath: string;
    phase: "prepared";
  }>): Promise<Readonly<{
    syntheticNoteCount: 5000;
    syntheticTotalBytes: 78643200;
    corpusDigest: string;
  }>>;
}

const removalProbe = vi.hoisted(() => ({
  active: false,
  statePath: "",
  vaultPath: "",
  events: [] as string[],
}));

const populationProbe = vi.hoisted(() => ({
  mode: "",
  holdGate: null as Promise<void> | null,
  holdEntered: null as (() => void) | null,
  failureObserved: null as (() => void) | null,
  replacementPath: "",
}));

const publicationProbe = vi.hoisted(() => ({
  mode: "",
  replacementPath: "",
}));

const stageCreationProbe = vi.hoisted(() => ({
  failFirstIdentityRead: false,
  failed: false,
  stagePath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const record = (value: unknown): void => {
    if (!removalProbe.active) return;
    const path = String(value);
    if (path === removalProbe.statePath || path.startsWith(`${removalProbe.vaultPath}${sep}`)) {
      removalProbe.events.push(path);
    }
  };
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      if (
        stageCreationProbe.failFirstIdentityRead
        && !stageCreationProbe.failed
        && path.includes("/.read-only-acceptance-prepare-vault.stage-")
      ) {
        stageCreationProbe.failed = true;
        stageCreationProbe.stagePath = path;
        throw Object.assign(new Error("injected stage identity read failure"), { code: "EIO" });
      }
      return actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (populationProbe.mode === "drain-batch") {
        if (path.includes("/Generated/00001/")) {
          populationProbe.holdEntered?.();
          await populationProbe.holdGate;
        }
        if (path.includes("/Generated/00000/")) {
          populationProbe.failureObserved?.();
          throw Object.assign(new Error("injected population write failure"), { code: "EIO" });
        }
      }
      if (populationProbe.mode === "replace-partial-entry" && path.includes("/Generated/00023/")) {
        await delay(150);
        const stage = dirname(dirname(dirname(path)));
        const marker = join(stage, ".knowledge-workbench-test-vault.json");
        await actual.unlink(marker);
        await actual.writeFile(marker, "UNTRUSTED-PARTIAL-REPLACEMENT\n", "utf8");
        populationProbe.replacementPath = marker;
        throw Object.assign(new Error("injected population write failure"), { code: "EIO" });
      }
      return actual.open(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const source = String(args[0]);
      const destination = String(args[1]);
      await actual.rename(...args);
      if (
        publicationProbe.mode === "replace-vault-root"
        && source.includes(".read-only-acceptance-prepare-vault.stage-")
        && destination.endsWith("/read-only-acceptance-vault")
      ) {
        const originalRoot = join(dirname(destination), "original-vault-root-evidence");
        await actual.rename(destination, originalRoot);
        await actual.mkdir(destination, { mode: 0o700 });
        for (const name of await actual.readdir(originalRoot)) {
          await actual.rename(join(originalRoot, name), join(destination, name));
        }
        await actual.rmdir(originalRoot);
        publicationProbe.replacementPath = destination;
      }
      if (
        publicationProbe.mode === "replace-state-file"
        && source.includes(".read-only-acceptance-prepare-state.stage-")
        && destination.endsWith("/read-only-acceptance-state.json")
      ) {
        const bytes = await actual.readFile(destination);
        const originalState = join(dirname(destination), "original-state-evidence");
        await actual.rename(destination, originalState);
        await actual.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
        publicationProbe.replacementPath = destination;
      }
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      record(args[0]);
      return actual.unlink(...args);
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      record(args[0]);
      return actual.rmdir(...args);
    },
  };
});

// @ts-expect-error The run contract is intentionally plain ESM without a declaration file.
const runContract = await import("../../scripts/acceptance-run-contract.mjs") as unknown as RunContractModule;
// @ts-expect-error The vault core is intentionally plain ESM without a declaration file.
const vaultCore = await import("../../scripts/synthetic-vault-install-core.mjs") as unknown as VaultCoreModule;
const {
  ACCEPTANCE_REPORT_RELATIVE_PATH,
  INSTALLATION_RECEIPT_RELATIVE_PATH,
  PREPARATION_STATE_RELATIVE_PATH,
  SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH,
  decodePreparationState,
  encodePreparationState,
} = runContract;
const { OBSIDIAN_CONFIG_DIRECTORY, TEST_VAULT_MARKER } = vaultCore;

// @ts-expect-error Task 7 production is intentionally plain ESM without a declaration file.
const preparation = await import("../../scripts/prepare-acceptance-synthetic.mjs") as unknown as PreparationModule;
// @ts-expect-error The filesystem attestation helper is intentionally plain ESM without a declaration file.
const acceptanceVault = await import("../../scripts/synthetic-acceptance-vault.mjs") as unknown as AcceptanceVaultModule;

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const HEAVY_TIMEOUT_MS = 600_000;
const PREPARATION_LOCK = ".read-only-acceptance-prepare.lock";
const VAULT_STAGE_PREFIX = ".read-only-acceptance-prepare-vault.stage-";
const STATE_STAGE_PREFIX = ".read-only-acceptance-prepare-state.stage-";
const SOURCE_PATH = "Generated/00000/note-00000-3db92208.md";
const REQUIRED_PROJECT_FILES = Object.freeze([
  "esbuild.config.mjs",
  "package.json",
  "scripts/acceptance-artifact-contract.mjs",
  "scripts/acceptance-run-contract.mjs",
  "scripts/git-worktree-state.mjs",
  "scripts/safe-fs-core.mjs",
  "scripts/synthetic-acceptance-vault.mjs",
  "scripts/synthetic-note-fixture.d.mts",
  "scripts/synthetic-note-fixture.mjs",
  "scripts/synthetic-vault-install-core.mjs",
  "src/runtime/strict-semver.mjs",
]);
const roots: string[] = [];

interface RepositoryFixture {
  readonly repoRoot: string;
  readonly devRoot: string;
  readonly trackedPath: string;
  readonly legacyStatePath: string;
  readonly commit: string;
}

function runGit(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository(): Promise<RepositoryFixture> {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "kwb-prepare-acceptance-")));
  roots.push(repoRoot);
  runGit(repoRoot, ["init", "--quiet"]);
  runGit(repoRoot, ["config", "user.email", "acceptance@example.invalid"]);
  runGit(repoRoot, ["config", "user.name", "Acceptance Test"]);
  const trackedPath = join(repoRoot, "tracked.txt");
  await writeFile(join(repoRoot, ".gitignore"), ".dev-vault/\ndist/\n", "utf8");
  await writeFile(trackedPath, "tracked\n", "utf8");
  for (const relativePath of REQUIRED_PROJECT_FILES) {
    const destination = join(repoRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(projectRoot, relativePath), destination);
  }
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "--quiet", "-m", "initial"]);
  const devRoot = join(repoRoot, ".dev-vault");
  await mkdir(devRoot, { mode: 0o700 });
  await chmod(devRoot, 0o700);
  const legacyStatePath = join(devRoot, "acceptance.json");
  await writeFile(legacyStatePath, "LEGACY-ACCEPTANCE-SENTINEL\n", "utf8");
  return {
    repoRoot,
    devRoot,
    trackedPath,
    legacyStatePath,
    commit: runGit(repoRoot, ["rev-parse", "HEAD"]),
  };
}

function fixedPaths(repoRoot: string): Readonly<{
  vault: string;
  state: string;
  receipt: string;
  report: string;
}> {
  return Object.freeze({
    vault: join(repoRoot, SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH),
    state: join(repoRoot, PREPARATION_STATE_RELATIVE_PATH),
    receipt: join(repoRoot, INSTALLATION_RECEIPT_RELATIVE_PATH),
    report: join(repoRoot, ACCEPTANCE_REPORT_RELATIVE_PATH),
  });
}

async function expectAbsent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectNoPublishedRun(repoRoot: string): Promise<void> {
  const paths = fixedPaths(repoRoot);
  await expectAbsent(paths.vault);
  await expectAbsent(paths.state);
}

async function reservedNames(devRoot: string): Promise<string[]> {
  return (await readdir(devRoot)).filter((name) => (
    name.startsWith("read-only-acceptance-") || name.startsWith(".read-only-acceptance-")
  )).sort();
}

function hooksFor(
  hook: PreparationHook,
  callback: (context: Readonly<PreparationHookContext>) => void | Promise<void>,
): Partial<Record<PreparationHook, (context: Readonly<PreparationHookContext>) => void | Promise<void>>> {
  return { [hook]: callback };
}

async function createSentinel(path: string, directory = false): Promise<Readonly<{
  path: string;
  stat: Awaited<ReturnType<typeof lstat>>;
}>> {
  await mkdir(dirname(path), { recursive: true });
  if (directory) {
    await mkdir(path);
    await writeFile(join(path, "sentinel"), "DO-NOT-REMOVE\n", "utf8");
  } else {
    await writeFile(path, "DO-NOT-REMOVE\n", "utf8");
  }
  return Object.freeze({ path, stat: await lstat(path) });
}

async function assertSentinelUnchanged(sentinel: Readonly<{
  path: string;
  stat: Awaited<ReturnType<typeof lstat>>;
}>): Promise<void> {
  const current = await lstat(sentinel.path);
  expect(current.dev).toBe(sentinel.stat.dev);
  expect(current.ino).toBe(sentinel.stat.ino);
  if (current.isDirectory()) {
    await expect(readFile(join(sentinel.path, "sentinel"), "utf8")).resolves.toBe("DO-NOT-REMOVE\n");
  } else {
    await expect(readFile(sentinel.path, "utf8")).resolves.toBe("DO-NOT-REMOVE\n");
  }
}

async function closeServer(server: Server | null): Promise<void> {
  if (server === null) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

afterEach(async () => {
  removalProbe.active = false;
  removalProbe.statePath = "";
  removalProbe.vaultPath = "";
  removalProbe.events = [];
  populationProbe.mode = "";
  populationProbe.holdGate = null;
  populationProbe.holdEntered = null;
  populationProbe.failureObserved = null;
  populationProbe.replacementPath = "";
  publicationProbe.mode = "";
  publicationProbe.replacementPath = "";
  stageCreationProbe.failFirstIdentityRead = false;
  stageCreationProbe.failed = false;
  stageCreationProbe.stagePath = "";
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}, HEAVY_TIMEOUT_MS);

describe("synthetic acceptance preparation success", () => {
  it("publishes exactly one attested fixed vault and canonical state without residue", async () => {
    const repo = await createRepository();
    const seenHooks: PreparationHook[] = [];
    const ignoredSentinel = join(repo.devRoot, "ignored-sentinel");
    const hooks = Object.fromEntries(([
      "afterLockAcquired",
      "afterStageCreated",
      "afterStagePopulated",
      "afterStateStaged",
      "beforeVaultPublish",
      "afterVaultPublish",
      "beforeStatePublish",
      "afterStatePublish",
    ] satisfies PreparationHook[]).map((hook) => [hook, async (context: Readonly<PreparationHookContext>) => {
      seenHooks.push(hook);
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.repoRoot).toBe(repo.repoRoot);
      expect(context.devRoot).toBe(repo.devRoot);
      expect(context.vaultPath).toBe(fixedPaths(repo.repoRoot).vault);
      expect(context.statePath).toBe(fixedPaths(repo.repoRoot).state);
      if (hook === "afterLockAcquired") await writeFile(ignoredSentinel, "IGNORED\n", "utf8");
    }])) as Partial<Record<PreparationHook, (context: Readonly<PreparationHookContext>) => Promise<void>>>;

    const result = await preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot, hooks });
    const paths = fixedPaths(repo.repoRoot);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual([
      "runId",
      "commit",
      "syntheticNoteCount",
      "syntheticTotalBytes",
    ]);
    expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(result).toMatchObject({
      commit: repo.commit,
      syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
      syntheticTotalBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    });
    expect(runGit(repo.repoRoot, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n"))
      .toEqual(expect.arrayContaining([...REQUIRED_PROJECT_FILES]));
    expect(seenHooks).toEqual([
      "afterLockAcquired",
      "afterStageCreated",
      "afterStagePopulated",
      "afterStateStaged",
      "beforeVaultPublish",
      "afterVaultPublish",
      "beforeStatePublish",
      "afterStatePublish",
    ]);

    const stateBytes = await readFile(paths.state);
    const state = decodePreparationState(stateBytes);
    expect(encodePreparationState(state)).toEqual(stateBytes);
    expect(state).toMatchObject({
      runId: result.runId,
      commit: repo.commit,
      syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
      syntheticTotalBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    });
    const attestation = await acceptanceVault.attestSyntheticAcceptanceVault({
      vaultPath: paths.vault,
      phase: "prepared",
    });
    expect(attestation.syntheticNoteCount).toBe(SYNTHETIC_ACCEPTANCE_NOTE_COUNT);
    expect(attestation.syntheticTotalBytes).toBe(SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES);
    expect(attestation.corpusDigest).toBe(state.corpusDigest);

    expect((await readdir(paths.vault)).sort()).toEqual([
      ".knowledge-workbench-test-vault.json",
      OBSIDIAN_CONFIG_DIRECTORY,
      "Generated",
    ]);
    expect(await readFile(join(paths.vault, ".knowledge-workbench-test-vault.json"), "utf8"))
      .toBe(`${JSON.stringify(TEST_VAULT_MARKER, null, 2)}\n`);
    expect((await readdir(join(paths.vault, OBSIDIAN_CONFIG_DIRECTORY))).sort()).toEqual([
      "community-plugins.json",
      "plugins",
    ]);
    await expect(readFile(join(paths.vault, OBSIDIAN_CONFIG_DIRECTORY, "community-plugins.json"), "utf8"))
      .resolves.toBe("[]\n");
    await expect(readdir(join(paths.vault, OBSIDIAN_CONFIG_DIRECTORY, "plugins"))).resolves.toEqual([]);
    expect((await readdir(join(paths.vault, "Generated"))).length).toBe(5_000);
    expect((await lstat(paths.vault)).mode & 0o777).toBe(0o700);
    await expect(readFile(repo.legacyStatePath, "utf8")).resolves.toBe("LEGACY-ACCEPTANCE-SENTINEL\n");
    await expect(readFile(ignoredSentinel, "utf8")).resolves.toBe("IGNORED\n");
    await expectAbsent(paths.receipt);
    await expectAbsent(paths.report);
    expect(await reservedNames(repo.devRoot)).toEqual([
      "read-only-acceptance-state.json",
      "read-only-acceptance-vault",
    ]);
  }, HEAVY_TIMEOUT_MS);
});

describe("synthetic acceptance preparation preflight and locking", () => {
  it("rejects every fixed or reserved prior-run object in place while allowing unrelated ignored state", async () => {
    const cases: ReadonlyArray<readonly [string, (repo: RepositoryFixture) => Promise<Readonly<{
      path: string;
      stat: Awaited<ReturnType<typeof lstat>>;
    }>>]> = [
      ["fixed vault", async (repo) => createSentinel(fixedPaths(repo.repoRoot).vault, true)],
      ["fixed state", async (repo) => createSentinel(fixedPaths(repo.repoRoot).state)],
      ["fixed receipt", async (repo) => createSentinel(fixedPaths(repo.repoRoot).receipt)],
      ["fixed report", async (repo) => createSentinel(fixedPaths(repo.repoRoot).report)],
      ["preparation stage", async (repo) => createSentinel(join(repo.devRoot, `${VAULT_STAGE_PREFIX}retained`), true)],
      ["state stage", async (repo) => createSentinel(join(repo.devRoot, `${STATE_STAGE_PREFIX}retained`))],
      ["report lock", async (repo) => createSentinel(join(repo.devRoot, ".read-only-acceptance-report.lock"))],
      ["report stage", async (repo) => createSentinel(join(repo.devRoot, ".read-only-acceptance-report.stage-retained"))],
      ["builder lock", async (repo) => createSentinel(join(repo.repoRoot, "dist", ".read-only-acceptance.lock"))],
      ["builder stage", async (repo) => createSentinel(join(repo.repoRoot, "dist", ".read-only-acceptance.tmp-retained"), true)],
      ["builder backup", async (repo) => createSentinel(join(repo.repoRoot, "dist", ".read-only-acceptance.backup-retained"), true)],
      ["builder quarantine", async (repo) => createSentinel(join(repo.repoRoot, "dist", ".read-only-acceptance.quarantine-retained"), true)],
      ["nested installer residue", async (repo) => createSentinel(join(
        fixedPaths(repo.repoRoot).vault,
        OBSIDIAN_CONFIG_DIRECTORY,
        "plugins",
        ".knowledge-workbench-read-only-acceptance.stage-retained",
      ))],
    ];

    for (const [label, installSentinel] of cases) {
      const repo = await createRepository();
      const sentinel = await installSentinel(repo);

      await expect(preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot }), label)
        .rejects.toThrow(/target-exists|concurrent-operation|residue|prior|lock|already exists/iu);

      await assertSentinelUnchanged(sentinel);
      await expect(readFile(repo.legacyStatePath, "utf8")).resolves.toBe("LEGACY-ACCEPTANCE-SENTINEL\n");
    }
  }, HEAVY_TIMEOUT_MS);

  it("never age-steals a stale preparation lock", async () => {
    const repo = await createRepository();
    const lock = join(repo.devRoot, PREPARATION_LOCK);
    await writeFile(lock, "STALE-LOCK\n", "utf8");
    const old = new Date(1_000);
    await import("node:fs/promises").then(({ utimes }) => utimes(lock, old, old));

    await expect(preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot }))
      .rejects.toThrow(/lock|concurrent-operation|already exists/iu);
    await expect(readFile(lock, "utf8")).resolves.toBe("STALE-LOCK\n");
  }, HEAVY_TIMEOUT_MS);

  it("keeps initial target classification stable when afterLockAcquired is present", async () => {
    const repo = await createRepository();
    const sentinel = await createSentinel(fixedPaths(repo.repoRoot).vault, true);
    let hookCalled = false;

    await expect(preparation.prepareSyntheticAcceptance({
      repoRoot: repo.repoRoot,
      hooks: {
        afterLockAcquired: () => { hookCalled = true; },
      },
    })).rejects.toMatchObject({ category: "target-exists" });

    expect(hookCalled).toBe(true);
    await assertSentinelUnchanged(sentinel);
  }, HEAVY_TIMEOUT_MS);

  it("rejects inherited and accessor-based invocation objects without reading accessors", async () => {
    const repo = await createRepository();
    const inherited = Object.create({
      repoRoot: repo.repoRoot,
      hooks: { afterLockAcquired: () => { throw new Error("inherited-hook-ran"); } },
    }) as unknown as Parameters<PreparationModule["prepareSyntheticAcceptance"]>[0];
    await expect(preparation.prepareSyntheticAcceptance(inherited))
      .rejects.toMatchObject({ category: "invalid-invocation" });

    let repoRootReads = 0;
    const accessorOptions: Record<string, unknown> = {};
    Object.defineProperty(accessorOptions, "repoRoot", {
      enumerable: true,
      get: () => {
        repoRootReads += 1;
        return repo.repoRoot;
      },
    });
    Object.defineProperty(accessorOptions, "hooks", {
      enumerable: true,
      value: { afterLockAcquired: () => { throw new Error("accessor-hook-ran"); } },
    });
    await expect(preparation.prepareSyntheticAcceptance(
      accessorOptions as Parameters<PreparationModule["prepareSyntheticAcceptance"]>[0],
    )).rejects.toMatchObject({ category: "invalid-invocation" });
    expect(repoRootReads).toBe(0);
    await expectAbsent(join(repo.devRoot, PREPARATION_LOCK));
  }, HEAVY_TIMEOUT_MS);

  it("allows only one concurrent preparer to hold the fixed lock", async () => {
    const repo = await createRepository();
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let hookEntries = 0;
    const first = preparation.prepareSyntheticAcceptance({
      repoRoot: repo.repoRoot,
      hooks: {
        afterLockAcquired: async () => {
          hookEntries += 1;
          entered();
          await gate;
          throw new Error("stop-first-preparer");
        },
      },
    });
    await firstEntered;

    await expect(preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot }))
      .rejects.toThrow(/lock|concurrent-operation|already exists/iu);
    expect(hookEntries).toBe(1);
    release();
    await expect(first).rejects.toThrow(/stop-first-preparer|fixture-changed/iu);
    await expectAbsent(join(repo.devRoot, PREPARATION_LOCK));
  }, HEAVY_TIMEOUT_MS);

  it("retains replacement lock and dev-root evidence instead of deleting it", async () => {
    const lockRepo = await createRepository();
    let lockPath = "";
    await expect(preparation.prepareSyntheticAcceptance({
      repoRoot: lockRepo.repoRoot,
      hooks: {
        afterLockAcquired: async (context) => {
          lockPath = context.lockPath;
          await unlink(context.lockPath);
          await writeFile(context.lockPath, "UNTRUSTED-LOCK-REPLACEMENT\n", "utf8");
        },
      },
    })).rejects.toThrow(/cleanup-incomplete|lock|identity|changed/iu);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("UNTRUSTED-LOCK-REPLACEMENT\n");

    const parentRepo = await createRepository();
    const moved = `${parentRepo.devRoot}-moved`;
    await expect(preparation.prepareSyntheticAcceptance({
      repoRoot: parentRepo.repoRoot,
      hooks: {
        afterLockAcquired: async () => {
          await rename(parentRepo.devRoot, moved);
          await mkdir(parentRepo.devRoot, { mode: 0o700 });
          await writeFile(join(parentRepo.devRoot, "replacement-sentinel"), "UNTRUSTED-PARENT\n", "utf8");
        },
      },
    })).rejects.toThrow(/cleanup-incomplete|parent|identity|changed/iu);
    await expect(readFile(join(parentRepo.devRoot, "replacement-sentinel"), "utf8"))
      .resolves.toBe("UNTRUSTED-PARENT\n");
    await expect(lstat(join(moved, PREPARATION_LOCK))).resolves.toMatchObject({});
  }, HEAVY_TIMEOUT_MS);

  it("allows an existing exact artifact target and preserves it", async () => {
    const repo = await createRepository();
    const target = join(repo.repoRoot, "dist", "read-only-acceptance");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "sentinel"), "ARTIFACT-TARGET\n", "utf8");

    await expect(preparation.prepareSyntheticAcceptance({
      repoRoot: repo.repoRoot,
      hooks: {
        afterStageCreated: () => { throw new Error("stop-after-preflight"); },
      },
    })).rejects.toThrow(/stop-after-preflight|fixture-changed/iu);
    await expect(readFile(join(target, "sentinel"), "utf8")).resolves.toBe("ARTIFACT-TARGET\n");
  }, HEAVY_TIMEOUT_MS);
});

describe("synthetic acceptance preparation revalidation", () => {
  it("reports cleanup-incomplete when a created stage lacks root identity proof", async () => {
    const repo = await createRepository();
    stageCreationProbe.failFirstIdentityRead = true;

    await expect(preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot }))
      .rejects.toMatchObject({ category: "cleanup-incomplete" });
    expect(stageCreationProbe.stagePath).not.toBe("");
    await expect(lstat(stageCreationProbe.stagePath)).resolves.toMatchObject({});
    await expectNoPublishedRun(repo.repoRoot);
  }, HEAVY_TIMEOUT_MS);

  it("waits for every bounded population write to settle before rollback", async () => {
    const repo = await createRepository();
    let enterHold!: () => void;
    let observeFailure!: () => void;
    let releaseHold!: () => void;
    const holdEntered = new Promise<void>((resolveEntered) => { enterHold = resolveEntered; });
    const failureObserved = new Promise<void>((resolveFailure) => { observeFailure = resolveFailure; });
    populationProbe.mode = "drain-batch";
    populationProbe.holdEntered = enterHold;
    populationProbe.failureObserved = observeFailure;
    populationProbe.holdGate = new Promise<void>((resolveRelease) => { releaseHold = resolveRelease; });

    const operation = preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot });
    const settled = operation.then(() => true, () => true);
    await Promise.all([holdEntered, failureObserved]);
    const settledBeforeRelease = await Promise.race([
      settled,
      delay(1_000, false),
    ]);
    releaseHold();
    const failure = await operation.then(() => null, (error: unknown) => error);

    expect(settledBeforeRelease).toBe(false);
    expect(failure).toMatchObject({ category: "fixture-changed" });
    await expectNoPublishedRun(repo.repoRoot);
    expect(await reservedNames(repo.devRoot)).toEqual([]);
  }, HEAVY_TIMEOUT_MS);

  it("never reclaims a replaced known entry from a partial stage", async () => {
    const repo = await createRepository();
    populationProbe.mode = "replace-partial-entry";

    await expect(preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot }))
      .rejects.toMatchObject({ category: "cleanup-incomplete" });
    expect(populationProbe.replacementPath).not.toBe("");
    await expect(readFile(populationProbe.replacementPath, "utf8"))
      .resolves.toBe("UNTRUSTED-PARTIAL-REPLACEMENT\n");
    await expectNoPublishedRun(repo.repoRoot);
  }, HEAVY_TIMEOUT_MS);

  it("rechecks Git cleanliness and HEAD after every hook", async () => {
    const cases: ReadonlyArray<readonly [PreparationHook, "untracked" | "staged" | "tracked" | "head"]> = [
      ["afterLockAcquired", "untracked"],
      ["afterStageCreated", "staged"],
      ["afterStagePopulated", "head"],
      ["afterStateStaged", "tracked"],
      ["beforeVaultPublish", "untracked"],
      ["afterVaultPublish", "head"],
      ["beforeStatePublish", "staged"],
      ["afterStatePublish", "tracked"],
    ];

    for (const [hook, mutation] of cases) {
      const repo = await createRepository();
      const mutate = async (): Promise<void> => {
        if (mutation === "untracked") {
          await writeFile(join(repo.repoRoot, `untracked-${hook}.txt`), "dirty\n", "utf8");
          return;
        }
        await writeFile(repo.trackedPath, `${mutation}-${hook}\n`, "utf8");
        if (mutation === "staged" || mutation === "head") runGit(repo.repoRoot, ["add", "tracked.txt"]);
        if (mutation === "head") runGit(repo.repoRoot, ["commit", "--quiet", "-m", `switch-${hook}`]);
      };

      await expect(preparation.prepareSyntheticAcceptance({
        repoRoot: repo.repoRoot,
        hooks: hooksFor(hook, mutate),
      }), `${hook}:${mutation}`).rejects.toThrow(/Git|HEAD|clean|concurrent-operation|fixture-changed/iu);
      await expectNoPublishedRun(repo.repoRoot);
    }
  }, HEAVY_TIMEOUT_MS);

  it("retains every tampered full stage and never publishes it", async () => {
    const cases: ReadonlyArray<readonly [string, (
      context: Readonly<PreparationHookContext>,
      cleanup: { server: Server | null },
    ) => Promise<string>]> = [
      ["added note", async ({ vaultStagePath }) => {
        const path = join(vaultStagePath!, "Generated", "extra.md");
        await writeFile(path, "EXTRA\n", "utf8");
        return path;
      }],
      ["removed note", async ({ vaultStagePath }) => {
        await unlink(join(vaultStagePath!, SOURCE_PATH));
        return vaultStagePath!;
      }],
      ["renamed note", async ({ vaultStagePath }) => {
        const destination = join(vaultStagePath!, "Generated", "renamed.md");
        await rename(join(vaultStagePath!, SOURCE_PATH), destination);
        return destination;
      }],
      ["changed note", async ({ vaultStagePath }) => {
        const path = join(vaultStagePath!, SOURCE_PATH);
        const bytes = await readFile(path);
        bytes[0] = bytes[0] === 0x58 ? 0x59 : 0x58;
        await writeFile(path, bytes);
        return path;
      }],
      ["replaced stage", async ({ vaultStagePath }) => {
        const moved = `${vaultStagePath!}-moved`;
        await rename(vaultStagePath!, moved);
        await mkdir(vaultStagePath!, { mode: 0o700 });
        const sentinel = join(vaultStagePath!, "replacement-sentinel");
        await writeFile(sentinel, "REPLACEMENT\n", "utf8");
        return sentinel;
      }],
      ["symbolic link", async ({ vaultStagePath }) => {
        const path = join(vaultStagePath!, "Generated", "linked.md");
        await symlink(join(vaultStagePath!, SOURCE_PATH), path);
        return path;
      }],
      ["hard link", async ({ vaultStagePath }) => {
        const path = join(vaultStagePath!, "Generated", "hard-linked.md");
        await link(join(vaultStagePath!, SOURCE_PATH), path);
        return path;
      }],
      ["FIFO", async ({ vaultStagePath }) => {
        const path = join(vaultStagePath!, "Generated", "pipe");
        execFileSync("mkfifo", [path]);
        return path;
      }],
      ["socket", async ({ vaultStagePath }, cleanup) => {
        const path = join(vaultStagePath!, "Generated", "socket");
        const shortRoot = await mkdtemp("/tmp/kwb-acceptance-socket-");
        roots.push(shortRoot);
        const shortGenerated = join(shortRoot, "g");
        await symlink(join(vaultStagePath!, "Generated"), shortGenerated);
        cleanup.server = createServer();
        await new Promise<void>((resolveListen, rejectListen) => {
          cleanup.server!.once("error", rejectListen);
          cleanup.server!.listen(join(shortGenerated, "socket"), resolveListen);
        });
        return path;
      }],
      ["unknown top-level entry", async ({ vaultStagePath }) => {
        const path = join(vaultStagePath!, "unexpected.txt");
        await writeFile(path, "UNKNOWN\n", "utf8");
        return path;
      }],
    ];

    for (const [label, mutate] of cases) {
      const repo = await createRepository();
      const cleanup = { server: null as Server | null };
      let retainedPath = "";
      try {
        await expect(preparation.prepareSyntheticAcceptance({
          repoRoot: repo.repoRoot,
          hooks: {
            afterStagePopulated: async (context) => {
              retainedPath = await mutate(context, cleanup);
            },
          },
        }), label).rejects.toThrow(/fixture-changed|cleanup-incomplete|stage|snapshot|identity/iu);
        await expect(lstat(retainedPath), label).resolves.toMatchObject({});
        await expectNoPublishedRun(repo.repoRoot);
      } finally {
        await closeServer(cleanup.server);
      }
    }
  }, HEAVY_TIMEOUT_MS);
});

describe("synthetic acceptance preparation publication cleanup", () => {
  it("binds published vault and state identities to their exact pre-rename stages", async () => {
    for (const mode of ["replace-vault-root", "replace-state-file"] as const) {
      const repo = await createRepository();
      publicationProbe.mode = mode;

      await expect(preparation.prepareSyntheticAcceptance({ repoRoot: repo.repoRoot }), mode)
        .rejects.toMatchObject({ category: "cleanup-incomplete" });
      expect(publicationProbe.replacementPath, mode).not.toBe("");
      await expect(lstat(publicationProbe.replacementPath), mode).resolves.toMatchObject({});
    }
  }, HEAVY_TIMEOUT_MS);

  it("does not infer cleanup or concurrency categories from hook error text", async () => {
    for (const [message, spoofedCategory] of [
      ["retained test evidence", undefined],
      ["cleanup-incomplete is only text", undefined],
      ["lock already exists is only text", undefined],
      ["untrusted hook category", "cleanup-incomplete"],
    ] as const) {
      const repo = await createRepository();
      await expect(preparation.prepareSyntheticAcceptance({
        repoRoot: repo.repoRoot,
        hooks: {
          afterStageCreated: () => {
            throw Object.assign(new Error(message), { category: spoofedCategory });
          },
        },
      }), message).rejects.toMatchObject({ category: "fixture-changed" });
      expect(await reservedNames(repo.devRoot)).toEqual([]);
    }
  }, HEAVY_TIMEOUT_MS);

  it("cleans exact owned objects after faults at all eight hooks", async () => {
    const hooks: PreparationHook[] = [
      "afterLockAcquired",
      "afterStageCreated",
      "afterStagePopulated",
      "afterStateStaged",
      "beforeVaultPublish",
      "afterVaultPublish",
      "beforeStatePublish",
      "afterStatePublish",
    ];
    for (const hook of hooks) {
      const repo = await createRepository();
      await expect(preparation.prepareSyntheticAcceptance({
        repoRoot: repo.repoRoot,
        hooks: hooksFor(hook, () => { throw new Error(`fault:${hook}`); }),
      }), hook).rejects.toThrow(new RegExp(`fault:${hook}|fixture-changed`, "iu"));
      await expectNoPublishedRun(repo.repoRoot);
      expect(await reservedNames(repo.devRoot)).toEqual([]);
      await expect(readFile(repo.legacyStatePath, "utf8")).resolves.toBe("LEGACY-ACCEPTANCE-SENTINEL\n");
    }
  }, HEAVY_TIMEOUT_MS);

  it("deletes the exact state before any published vault entry", async () => {
    const repo = await createRepository();
    const paths = fixedPaths(repo.repoRoot);
    removalProbe.active = true;
    removalProbe.statePath = paths.state;
    removalProbe.vaultPath = paths.vault;

    await expect(preparation.prepareSyntheticAcceptance({
      repoRoot: repo.repoRoot,
      hooks: {
        afterStatePublish: () => { throw new Error("ordered-cleanup-fault"); },
      },
    })).rejects.toThrow(/ordered-cleanup-fault|fixture-changed/iu);
    removalProbe.active = false;

    expect(removalProbe.events.length).toBeGreaterThan(1);
    expect(removalProbe.events[0]).toBe(paths.state);
    expect(removalProbe.events.slice(1).some((path) => path.startsWith(`${paths.vault}${sep}`))).toBe(true);
    await expectNoPublishedRun(repo.repoRoot);
  }, HEAVY_TIMEOUT_MS);

  it("jointly prevalidates state and vault before deleting either and retains changed evidence", async () => {
    const cases: ReadonlyArray<readonly [string, (
      context: Readonly<PreparationHookContext>,
    ) => Promise<void>]> = [
      ["changed state", async ({ statePath }) => {
        const bytes = await readFile(statePath);
        bytes[0] = bytes[0] === 0x58 ? 0x59 : 0x58;
        await writeFile(statePath, bytes);
      }],
      ["linked state", async ({ statePath, devRoot }) => {
        await unlink(statePath);
        await symlink(join(devRoot, "acceptance.json"), statePath);
      }],
      ["missing owned note", async ({ vaultPath }) => {
        await unlink(join(vaultPath, SOURCE_PATH));
      }],
      ["unknown vault entry", async ({ vaultPath }) => {
        await writeFile(join(vaultPath, "unknown.txt"), "UNKNOWN\n", "utf8");
      }],
    ];

    for (const [label, mutate] of cases) {
      const repo = await createRepository();
      const paths = fixedPaths(repo.repoRoot);
      await expect(preparation.prepareSyntheticAcceptance({
        repoRoot: repo.repoRoot,
        hooks: {
          afterStatePublish: async (context) => {
            await mutate(context);
            throw new Error(`tamper:${label}`);
          },
        },
      }), label).rejects.toThrow(/cleanup-incomplete|changed|snapshot|identity|linked|missing|unknown/iu);
      await expect(lstat(paths.state), `${label}:state`).resolves.toMatchObject({});
      await expect(lstat(paths.vault), `${label}:vault`).resolves.toMatchObject({});
    }
  }, HEAVY_TIMEOUT_MS);

  it("retains a changed published vault before state publication", async () => {
    const repo = await createRepository();
    const paths = fixedPaths(repo.repoRoot);
    await expect(preparation.prepareSyntheticAcceptance({
      repoRoot: repo.repoRoot,
      hooks: {
        afterVaultPublish: async ({ vaultPath }) => {
          await writeFile(join(vaultPath, "unknown.txt"), "UNKNOWN\n", "utf8");
          throw new Error("tampered-published-vault");
        },
      },
    })).rejects.toThrow(/cleanup-incomplete|changed|unknown|snapshot/iu);
    await expect(lstat(paths.vault)).resolves.toMatchObject({});
    await expectAbsent(paths.state);
  }, HEAVY_TIMEOUT_MS);
});

describe("synthetic acceptance preparation CLI", () => {
  interface CliFixture {
    readonly repoRoot: string;
    readonly resultPath: string;
  }

  async function cliFixture(): Promise<CliFixture> {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "kwb-prepare-cli-")));
    roots.push(repoRoot);
    const scripts = join(repoRoot, "scripts");
    await mkdir(scripts);
    await writeFile(
      join(scripts, "prepare-acceptance-synthetic-cli.mjs"),
      await readFile(join(projectRoot, "scripts", "prepare-acceptance-synthetic-cli.mjs")),
    );
    await writeFile(join(scripts, "prepare-acceptance-synthetic.mjs"), [
      'import { writeFile } from "node:fs/promises";',
      "export async function prepareSyntheticAcceptance(options) {",
      "  await writeFile(process.env.KNOWLEDGE_WORKBENCH_CLI_RESULT, JSON.stringify(options), 'utf8');",
      "  if (process.env.KNOWLEDGE_WORKBENCH_CLI_FAILURE) {",
      "    const nested = new Error('/tmp/private/Generated/00000/note.md sha256:{raw-json} endpoint');",
      "    const error = new Error('internal path /tmp/private and raw {json}', { cause: nested });",
      "    error.category = process.env.KNOWLEDGE_WORKBENCH_CLI_FAILURE;",
      "    throw error;",
      "  }",
      "  return Object.freeze({ runId: '123e4567-e89b-42d3-a456-426614174000', commit: 'a'.repeat(40), syntheticNoteCount: 5000, syntheticTotalBytes: 78643200 });",
      "}",
      "",
    ].join("\n"), "utf8");
    return { repoRoot, resultPath: join(repoRoot, "result.json") };
  }

  async function runCli(
    fixture: CliFixture,
    args: readonly string[] = [],
    overrides: Readonly<Record<string, string>> = {},
  ): Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>> {
    const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
      key !== "OBSIDIAN_DEV_VAULT"
      && !(key.startsWith("KNOWLEDGE_WORKBENCH_") && /(?:ROOT|PATH|VAULT|FIXTURE)$/u.test(key))
    )));
    const child = spawn(process.execPath, [
      join(fixture.repoRoot, "scripts", "prepare-acceptance-synthetic-cli.mjs"),
      ...args,
    ], {
      cwd: tmpdir(),
      env: {
        ...baseEnvironment,
        KNOWLEDGE_WORKBENCH_CLI_RESULT: fixture.resultPath,
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
    return Object.freeze({ code, stdout, stderr });
  }

  it("derives the fixed repository root and emits only the fixed success sentence", async () => {
    const fixture = await cliFixture();
    const result = await runCli(fixture);

    expect(result).toEqual({
      code: 0,
      stdout: "Prepared the fixed synthetic acceptance vault; Obsidian was not started.\n",
      stderr: "",
    });
    expect(JSON.parse(await readFile(fixture.resultPath, "utf8"))).toEqual({
      repoRoot: resolve(await realpath(fixture.repoRoot)),
    });
  }, HEAVY_TIMEOUT_MS);

  it("rejects arguments and project path overrides without invoking preparation", async () => {
    const argumentsList = [
      ["elsewhere"],
      ["--repo-root", "elsewhere"],
      ["--vault", "elsewhere"],
      ["--state", "elsewhere"],
      ["--fixture-size", "1"],
      ["--mode", "normal"],
      ["--output", "elsewhere"],
    ];
    for (const args of argumentsList) {
      const fixture = await cliFixture();
      const result = await runCli(fixture, args);
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "Synthetic acceptance preparation failed: invalid-invocation.\n",
      });
      await expectAbsent(fixture.resultPath);
    }

    for (const [key, value] of [
      ["OBSIDIAN_DEV_VAULT", "/tmp/other-vault"],
      ["KNOWLEDGE_WORKBENCH_REPO_ROOT", "/tmp/other-root"],
      ["KNOWLEDGE_WORKBENCH_OUTPUT_PATH", "/tmp/output"],
      ["KNOWLEDGE_WORKBENCH_TARGET_VAULT", "/tmp/other-vault"],
      ["KNOWLEDGE_WORKBENCH_FIXTURE", "tiny"],
    ] as const) {
      const fixture = await cliFixture();
      const result = await runCli(fixture, [], { [key]: value });
      expect(result.stderr).toBe("Synthetic acceptance preparation failed: invalid-invocation.\n");
      expect(result.code).toBe(1);
      await expectAbsent(fixture.resultPath);
    }
  }, HEAVY_TIMEOUT_MS);

  it("maps nested internal failures to one fixed category without leaking evidence", async () => {
    const fixture = await cliFixture();
    const result = await runCli(fixture, [], { KNOWLEDGE_WORKBENCH_CLI_FAILURE: "fixture-changed" });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "Synthetic acceptance preparation failed: fixture-changed.\n",
    });
    expect(result.stderr).not.toMatch(/\/tmp|Generated|\.md|sha256|\{|endpoint|raw|nested/iu);
  }, HEAVY_TIMEOUT_MS);
});
