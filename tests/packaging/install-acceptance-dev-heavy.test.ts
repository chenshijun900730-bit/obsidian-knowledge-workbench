import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

// This file is deliberately free of vi.mock calls. It is the small, real
// 5,000-note/75-MiB and real-esbuild evidence set for the installer workflow.

interface PreparationState {
  readonly schemaVersion: 1;
  readonly scope: "dedicated-synthetic-vault";
  readonly contentPolicy: "deterministic-synthetic-notes-only";
  readonly runId: string;
  readonly commit: string;
  readonly syntheticNoteCount: number;
  readonly syntheticTotalBytes: number;
  readonly corpusDigest: string;
}

interface InstallationReceipt {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly commit: string;
  readonly pluginVersion: string;
  readonly artifactBinding: string;
  readonly artifactSetDigest: string;
  readonly fixtureStateDigest: string;
  readonly seedDataDigest: string;
}

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

interface AcceptanceArtifactSnapshot {
  readonly directory: Readonly<{ path: string; dev: bigint; ino: bigint }>;
  readonly names: readonly string[];
  readonly files: ReadonlyMap<string, FrozenFile>;
}

type AcceptanceInstallHook =
  | "afterArtifactLock"
  | "afterBuild"
  | "afterSourceFreeze"
  | "afterDestinationLock"
  | "afterStageCreated"
  | "afterStageValidated"
  | "afterTargetPublished"
  | "beforeSeed"
  | "afterSeed"
  | "beforeReceiptPublish"
  | "afterReceiptPublish";

interface AcceptanceInstallHookContext {
  readonly repoRoot: string;
  readonly artifactLockPath: string;
  readonly sourcePath: string;
  readonly destinationLockPath: string | null;
  readonly pluginsParentPath: string;
  readonly stagePath: string | null;
  readonly targetPath: string;
  readonly seedPath: string;
  readonly statePath: string;
  readonly receiptStagePath: string | null;
  readonly receiptPath: string;
  readonly reportPath: string;
  readonly runId: string | null;
  readonly commit: string | null;
}

interface AcceptanceInstallResult {
  readonly runId: string;
  readonly pluginVersion: string;
  readonly artifactBinding: string;
}

interface InstallerModule {
  readonly installAcceptanceDevelopment: (options: Readonly<{
    repoRoot: string;
    hooks?: Partial<Record<AcceptanceInstallHook, (
      context: Readonly<AcceptanceInstallHookContext>,
    ) => void | Promise<void>>>;
  }>) => Promise<Readonly<AcceptanceInstallResult>>;
}

interface PreparationModule {
  readonly prepareSyntheticAcceptance: (options: Readonly<{
    repoRoot: string;
  }>) => Promise<Readonly<{
    runId: string;
    commit: string;
    syntheticNoteCount: number;
    syntheticTotalBytes: number;
  }>>;
}

interface BuilderModule {
  readonly buildAcceptanceArtifact: (options: Readonly<{
    repoRoot: string;
  }>) => Promise<Readonly<{ target: string; artifacts: readonly string[] }>>;
}

interface ArtifactContractModule {
  readonly ACCEPTANCE_FILES: readonly [
    "acceptance-build.json",
    "main.js",
    "manifest.json",
    "styles.css",
  ];
  readonly computeAcceptanceArtifactSetDigest: (snapshot: AcceptanceArtifactSnapshot) => string;
  readonly validateAcceptanceArtifactSnapshot: (
    snapshot: AcceptanceArtifactSnapshot,
  ) => Readonly<{ pluginVersion: string; artifactBinding: string }>;
}

interface RunContractModule {
  readonly ACCEPTANCE_REPORT_RELATIVE_PATH: string;
  readonly INSTALLATION_RECEIPT_RELATIVE_PATH: string;
  readonly PREPARATION_STATE_RELATIVE_PATH: string;
  readonly SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH: string;
  readonly createInstallationReceipt: (input: Readonly<{
    state: PreparationState;
    stateBytes: Uint8Array;
    pluginVersion: string;
    artifactBinding: string;
    artifactSetDigest: string;
    seedBytes: Uint8Array;
  }>) => InstallationReceipt;
  readonly decodeInstallationReceipt: (bytes: Uint8Array) => InstallationReceipt;
  readonly decodePreparationState: (bytes: Uint8Array) => PreparationState;
  readonly encodeInstallationReceipt: (receipt: InstallationReceipt) => Buffer;
}

interface SyntheticDataModule {
  readonly createSyntheticPluginDataSeed: () => Readonly<Record<string, unknown>>;
  readonly decodeSyntheticPluginDataSeed: (
    bytes: Uint8Array,
  ) => Readonly<Record<string, unknown>>;
  readonly encodeSyntheticPluginDataSeed: () => Buffer;
}

interface VaultCoreModule {
  readonly OBSIDIAN_CONFIG_DIRECTORY: string;
}

// @ts-expect-error Task 8 production is intentionally plain ESM without a declaration file.
const installer = await import("../../scripts/install-acceptance-dev.mjs") as unknown as InstallerModule;
// @ts-expect-error Task 7 production is intentionally plain ESM without a declaration file.
const preparation = await import("../../scripts/prepare-acceptance-synthetic.mjs") as unknown as PreparationModule;
// @ts-expect-error The acceptance builder is intentionally plain ESM without a declaration file.
const builder = await import("../../scripts/acceptance-build.mjs") as unknown as BuilderModule;
// @ts-expect-error The artifact contract is intentionally plain ESM without a declaration file.
const artifactContract = await import("../../scripts/acceptance-artifact-contract.mjs") as unknown as ArtifactContractModule;
// @ts-expect-error The run contract is intentionally plain ESM without a declaration file.
const runContract = await import("../../scripts/acceptance-run-contract.mjs") as unknown as RunContractModule;
const syntheticData = await import("../../scripts/synthetic-acceptance-data.mjs") as unknown as SyntheticDataModule;
// @ts-expect-error The vault core is intentionally plain ESM without a declaration file.
const vaultCore = await import("../../scripts/synthetic-vault-install-core.mjs") as unknown as VaultCoreModule;

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const HEAVY_TIMEOUT_MS = 600_000;
const REAL_SYNTHETIC_NOTE_COUNT = 5_000;
const REAL_SYNTHETIC_TOTAL_BYTES = 75 * 1024 * 1024;
const DESTINATION_LOCK_NAME = ".knowledge-workbench-read-only-acceptance.lock";
const TARGET_STAGE_PREFIX = ".knowledge-workbench-read-only-acceptance.stage-";
const RECEIPT_STAGE_PREFIX = ".read-only-acceptance-receipt.stage-";
const FIXED_NOTE = "Generated/00000/note-00000-3db92208.md";
const CONFIG_DIRECTORY = vaultCore.OBSIDIAN_CONFIG_DIRECTORY;
const HOOKS = Object.freeze([
  "afterArtifactLock",
  "afterBuild",
  "afterSourceFreeze",
  "afterDestinationLock",
  "afterStageCreated",
  "afterStageValidated",
  "afterTargetPublished",
  "beforeSeed",
  "afterSeed",
  "beforeReceiptPublish",
  "afterReceiptPublish",
] satisfies AcceptanceInstallHook[]);
const CONTEXT_KEYS = Object.freeze([
  "artifactLockPath",
  "commit",
  "destinationLockPath",
  "pluginsParentPath",
  "receiptPath",
  "receiptStagePath",
  "repoRoot",
  "reportPath",
  "runId",
  "seedPath",
  "sourcePath",
  "stagePath",
  "statePath",
  "targetPath",
]);

interface RepositoryFixture {
  readonly repoRoot: string;
  readonly devRoot: string;
  readonly vaultPath: string;
  readonly statePath: string;
  readonly receiptPath: string;
  readonly reportPath: string;
  readonly pluginsParentPath: string;
  readonly targetPath: string;
  readonly seedPath: string;
  readonly sourcePath: string;
  readonly artifactLockPath: string;
  readonly destinationLockPath: string;
  readonly legacyPath: string;
  readonly ignoredPath: string;
}

const caseRoots: string[] = [];
let templateContainer = "";
let templateRoot = "";

function runGit(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function pathsFor(repoRoot: string): RepositoryFixture {
  const devRoot = join(repoRoot, ".dev-vault");
  const vaultPath = join(repoRoot, runContract.SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH);
  const pluginsParentPath = join(vaultPath, CONFIG_DIRECTORY, "plugins");
  const targetPath = join(pluginsParentPath, "knowledge-workbench");
  return Object.freeze({
    repoRoot,
    devRoot,
    vaultPath,
    statePath: join(repoRoot, runContract.PREPARATION_STATE_RELATIVE_PATH),
    receiptPath: join(repoRoot, runContract.INSTALLATION_RECEIPT_RELATIVE_PATH),
    reportPath: join(repoRoot, runContract.ACCEPTANCE_REPORT_RELATIVE_PATH),
    pluginsParentPath,
    targetPath,
    seedPath: join(targetPath, "data.json"),
    sourcePath: join(repoRoot, "dist", "read-only-acceptance"),
    artifactLockPath: join(repoRoot, "dist", ".read-only-acceptance.lock"),
    destinationLockPath: join(pluginsParentPath, DESTINATION_LOCK_NAME),
    legacyPath: join(devRoot, "acceptance.json"),
    ignoredPath: join(devRoot, "unrelated-sentinel"),
  });
}

async function expectAbsent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function namesOrEmpty(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function createTemplate(): Promise<void> {
  templateContainer = await realpath(await mkdtemp(join(tmpdir(), "kwb-install-heavy-template-")));
  templateRoot = templateContainer;
  runGit(templateRoot, ["init", "--quiet"]);
  runGit(templateRoot, ["config", "user.email", "acceptance@example.invalid"]);
  runGit(templateRoot, ["config", "user.name", "Acceptance Heavy Test"]);
  await cp(join(projectRoot, "src"), join(templateRoot, "src"), { recursive: true });
  for (const name of ["esbuild.config.mjs", "manifest.json", "package.json", "styles.css"]) {
    await cp(join(projectRoot, name), join(templateRoot, name));
  }
  await writeFile(join(templateRoot, ".gitignore"), ".dev-vault/\ndist/\n", "utf8");
  await writeFile(join(templateRoot, "tracked.txt"), "tracked\n", "utf8");
  runGit(templateRoot, ["add", "."]);
  runGit(templateRoot, ["commit", "--quiet", "-m", "prepared acceptance source"]);

  const paths = pathsFor(templateRoot);
  await mkdir(paths.devRoot, { mode: 0o700 });
  await chmod(paths.devRoot, 0o700);
  await writeFile(paths.legacyPath, "LEGACY-ACCEPTANCE-SENTINEL\n", "utf8");
  await writeFile(paths.ignoredPath, "UNRELATED-IGNORED-SENTINEL\n", "utf8");
  const prepared = await preparation.prepareSyntheticAcceptance({ repoRoot: templateRoot });
  expect(prepared.syntheticNoteCount).toBe(REAL_SYNTHETIC_NOTE_COUNT);
  expect(prepared.syntheticTotalBytes).toBe(REAL_SYNTHETIC_TOTAL_BYTES);
}

async function clonePreparedRepository(): Promise<RepositoryFixture> {
  const container = await realpath(await mkdtemp(join(tmpdir(), "kwb-install-heavy-case-")));
  caseRoots.push(container);
  const repoRoot = join(container, "repo");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", templateRoot, repoRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await cp(join(templateRoot, ".dev-vault"), join(repoRoot, ".dev-vault"), { recursive: true });
  const canonical = await realpath(repoRoot);
  expect(runGit(canonical, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  return pathsFor(canonical);
}

async function snapshotArtifact(path: string): Promise<AcceptanceArtifactSnapshot> {
  const root = await lstat(path, { bigint: true });
  const files = new Map<string, FrozenFile>();
  for (const name of artifactContract.ACCEPTANCE_FILES) {
    const filePath = join(path, name);
    const [stat, bytes] = await Promise.all([
      lstat(filePath, { bigint: true }),
      readFile(filePath),
    ]);
    files.set(name, Object.freeze({
      path: filePath,
      bytes,
      evidence: Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        size: stat.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    }));
  }
  return Object.freeze({
    directory: Object.freeze({ path, dev: root.dev, ino: root.ino }),
    names: artifactContract.ACCEPTANCE_FILES,
    files,
  });
}

async function assertPreparedEvidence(repo: RepositoryFixture): Promise<PreparationState> {
  await expect(readFile(repo.legacyPath, "utf8")).resolves.toBe("LEGACY-ACCEPTANCE-SENTINEL\n");
  await expect(readFile(repo.ignoredPath, "utf8")).resolves.toBe("UNRELATED-IGNORED-SENTINEL\n");
  const state = runContract.decodePreparationState(await readFile(repo.statePath));
  expect(state.commit).toBe(runGit(repo.repoRoot, ["rev-parse", "HEAD"]));
  expect(state.syntheticNoteCount).toBe(REAL_SYNTHETIC_NOTE_COUNT);
  expect(state.syntheticTotalBytes).toBe(REAL_SYNTHETIC_TOTAL_BYTES);
  await expect(lstat(repo.vaultPath)).resolves.toMatchObject({});
  await expectAbsent(repo.reportPath);
  return state;
}

async function assertNoInstallerResidue(
  repo: RepositoryFixture,
  expected: Readonly<{ target: boolean; receipt: boolean }>,
): Promise<void> {
  expect(await namesOrEmpty(repo.pluginsParentPath)).toEqual(expected.target ? ["knowledge-workbench"] : []);
  const distNames = await namesOrEmpty(join(repo.repoRoot, "dist"));
  expect(distNames.every((name) => name === "read-only-acceptance")).toBe(true);
  const devNames = await namesOrEmpty(repo.devRoot);
  expect(devNames.some((name) => name.startsWith(RECEIPT_STAGE_PREFIX))).toBe(false);
  expect(devNames.some((name) => name.startsWith(".read-only-acceptance-prepare"))).toBe(false);
  if (expected.receipt) await expect(lstat(repo.receiptPath)).resolves.toMatchObject({});
  else await expectAbsent(repo.receiptPath);
  await expectAbsent(repo.artifactLockPath);
  await expectAbsent(repo.destinationLockPath);
  await expectAbsent(repo.reportPath);
}

beforeAll(async () => {
  await createTemplate();
}, HEAVY_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(caseRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}, HEAVY_TIMEOUT_MS);

afterAll(async () => {
  if (templateContainer !== "") await rm(templateContainer, { force: true, recursive: true });
}, HEAVY_TIMEOUT_MS);

describe("real-corpus transactional acceptance installation", () => {
  it("runs all eleven hook boundaries and publishes the exact bound target and receipt", async () => {
    const repo = await clonePreparedRepository();
    const stateBytes = await readFile(repo.statePath);
    const state = runContract.decodePreparationState(stateBytes);
    expect(state.syntheticNoteCount).toBe(REAL_SYNTHETIC_NOTE_COUNT);
    expect(state.syntheticTotalBytes).toBe(REAL_SYNTHETIC_TOTAL_BYTES);

    const seen: AcceptanceInstallHook[] = [];
    const sourceSnapshots = new Map<"frozen", AcceptanceArtifactSnapshot>();
    const sourceBytes = new Map<string, Buffer>();
    const hooks = Object.fromEntries(HOOKS.map((hook) => [hook, async (
      context: Readonly<AcceptanceInstallHookContext>,
    ) => {
      seen.push(hook);
      expect(Object.isFrozen(context), hook).toBe(true);
      expect(Reflect.ownKeys(context).sort(), hook).toEqual(CONTEXT_KEYS);
      expect(context.repoRoot, hook).toBe(repo.repoRoot);
      expect(context.artifactLockPath, hook).toBe(repo.artifactLockPath);
      await expect(lstat(context.artifactLockPath), `${hook}:artifact-lock`).resolves.toMatchObject({});

      const hookIndex = HOOKS.indexOf(hook);
      if (hook === "afterArtifactLock") {
        expect(context.runId).toBeNull();
        expect(context.commit).toBeNull();
      } else {
        expect(context.runId).toBe(state.runId);
        expect(context.commit).toBe(state.commit);
      }

      if (hookIndex < HOOKS.indexOf("afterDestinationLock")) {
        expect(context.destinationLockPath, hook).toBeNull();
      } else {
        expect(context.destinationLockPath, hook).toBe(repo.destinationLockPath);
        await expect(lstat(repo.destinationLockPath), `${hook}:destination-lock`).resolves.toMatchObject({});
      }

      if (hookIndex < HOOKS.indexOf("afterStageCreated")) {
        expect(context.stagePath, hook).toBeNull();
      } else {
        expect(context.stagePath, hook).toContain(TARGET_STAGE_PREFIX);
        if (hookIndex < HOOKS.indexOf("afterTargetPublished")) {
          await expect(lstat(context.stagePath!), `${hook}:stage`).resolves.toMatchObject({});
        } else {
          await expectAbsent(context.stagePath!);
        }
      }

      if (hookIndex < HOOKS.indexOf("beforeReceiptPublish")) {
        expect(context.receiptStagePath, hook).toBeNull();
      } else {
        expect(context.receiptStagePath, hook).toContain(RECEIPT_STAGE_PREFIX);
        if (hook === "beforeReceiptPublish") {
          await expect(lstat(context.receiptStagePath!), `${hook}:receipt-stage`).resolves.toMatchObject({});
        } else {
          await expectAbsent(context.receiptStagePath!);
        }
      }

      if (hook === "afterSourceFreeze") {
        const sourceSnapshot = await snapshotArtifact(context.sourcePath);
        sourceSnapshots.set("frozen", sourceSnapshot);
        artifactContract.validateAcceptanceArtifactSnapshot(sourceSnapshot);
        for (const [name, file] of sourceSnapshot.files) sourceBytes.set(name, Buffer.from(file.bytes));
      }
    }])) as Partial<Record<AcceptanceInstallHook, (
      context: Readonly<AcceptanceInstallHookContext>,
    ) => Promise<void>>>;

    const result = await installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot, hooks });

    expect(seen).toEqual(HOOKS);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual({
      runId: state.runId,
      pluginVersion: "0.1.0",
      artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    });
    expect((await readdir(repo.targetPath)).sort()).toEqual([
      "acceptance-build.json",
      "data.json",
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    for (const name of artifactContract.ACCEPTANCE_FILES) {
      await expect(readFile(join(repo.targetPath, name)), name).resolves.toEqual(sourceBytes.get(name));
    }
    const targetMode = await lstat(repo.targetPath, { bigint: true });
    expect(targetMode.mode & 0o777n).toBe(0o700n);

    const seedBytes = await readFile(repo.seedPath);
    expect(syntheticData.decodeSyntheticPluginDataSeed(seedBytes))
      .toEqual(syntheticData.createSyntheticPluginDataSeed());
    expect(seedBytes).toEqual(syntheticData.encodeSyntheticPluginDataSeed());

    const sourceSnapshot = sourceSnapshots.get("frozen");
    if (sourceSnapshot === undefined) throw new Error("afterSourceFreeze did not capture the source snapshot");
    const compiledMain = sourceSnapshot.files.get("main.js");
    if (compiledMain === undefined) throw new Error("real acceptance compiler did not emit main.js");
    expect(compiledMain.bytes.toString("utf8"))
      .toContain("Generated by esbuild from the Knowledge Workbench TypeScript source");
    const artifactSetDigest = artifactContract.computeAcceptanceArtifactSetDigest(sourceSnapshot);
    const receiptBytes = await readFile(repo.receiptPath);
    const expectedReceipt = runContract.createInstallationReceipt({
      state,
      stateBytes,
      pluginVersion: result.pluginVersion,
      artifactBinding: result.artifactBinding,
      artifactSetDigest,
      seedBytes,
    });
    expect(runContract.decodeInstallationReceipt(receiptBytes)).toEqual(expectedReceipt);
    expect(receiptBytes).toEqual(runContract.encodeInstallationReceipt(expectedReceipt));
    expect(await readFile(repo.statePath)).toEqual(stateBytes);
    await assertPreparedEvidence(repo);
    await assertNoInstallerResidue(repo, { target: true, receipt: true });
  }, HEAVY_TIMEOUT_MS);

  it("holds the real artifact and destination locks continuously during publication", async () => {
    const repo = await clonePreparedRepository();
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterDestinationLock: async ({ artifactLockPath, destinationLockPath }) => {
          expect(artifactLockPath).toBe(repo.artifactLockPath);
          expect(destinationLockPath).toBe(repo.destinationLockPath);
          await expect(lstat(artifactLockPath)).resolves.toMatchObject({});
          await expect(lstat(destinationLockPath!)).resolves.toMatchObject({});
          markEntered();
          await gate;
        },
      },
    });

    await entered;
    try {
      await expect(builder.buildAcceptanceArtifact({ repoRoot: repo.repoRoot }))
        .rejects.toThrow(/already exists|concurrent|lock/iu);
      await expect(open(repo.destinationLockPath, "wx", 0o600))
        .rejects.toMatchObject({ code: "EEXIST" });
      await expect(installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }))
        .rejects.toMatchObject({ category: "concurrent-operation" });
    } finally {
      release();
    }

    await expect(first).resolves.toMatchObject({
      pluginVersion: "0.1.0",
      artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    });
    await assertNoInstallerResidue(repo, { target: true, receipt: true });
  }, HEAVY_TIMEOUT_MS);

  it("detects a real-build same-inode same-size source drift before destination publication", async () => {
    const repo = await clonePreparedRepository();
    let sourcePath = "";
    let mutated = Buffer.alloc(0);

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterSourceFreeze: async ({ sourcePath: frozenSource }) => {
          sourcePath = join(frozenSource, "main.js");
          const before = await lstat(sourcePath, { bigint: true });
          mutated = await readFile(sourcePath);
          mutated[0] = (mutated[0] ?? 0) ^ 0xff;
          await writeFile(sourcePath, mutated);
          const after = await lstat(sourcePath, { bigint: true });
          expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
            dev: before.dev,
            ino: before.ino,
            size: before.size,
          });
        },
      },
    })).rejects.toMatchObject({ category: "artifact-changed" });

    expect(sourcePath).not.toBe("");
    expect(await readFile(sourcePath)).toEqual(mutated);
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("detects a real-corpus same-inode same-size fixture drift before seed", async () => {
    const repo = await clonePreparedRepository();
    const notePath = join(repo.vaultPath, FIXED_NOTE);
    let mutated = Buffer.alloc(0);

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        beforeSeed: async () => {
          const before = await lstat(notePath, { bigint: true });
          mutated = await readFile(notePath);
          mutated[0] = (mutated[0] ?? 0) ^ 0xff;
          await writeFile(notePath, mutated);
          const after = await lstat(notePath, { bigint: true });
          expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
            dev: before.dev,
            ino: before.ino,
            size: before.size,
          });
        },
      },
    })).rejects.toMatchObject({ category: "fixture-changed" });

    expect(await readFile(notePath)).toEqual(mutated);
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("detects real-vault community plugin enablement before seed and retains it", async () => {
    const repo = await clonePreparedRepository();
    const communityPath = join(repo.vaultPath, CONFIG_DIRECTORY, "community-plugins.json");
    const enabledBytes = Buffer.from("[\"knowledge-workbench\"]\n", "utf8");

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        beforeSeed: async () => {
          await writeFile(communityPath, enabledBytes);
        },
      },
    })).rejects.toMatchObject({ category: "plugin-enabled" });

    expect(await readFile(communityPath)).toEqual(enabledBytes);
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("cleanly rolls back a real published receipt and exact target after a final hook fault", async () => {
    const repo = await clonePreparedRepository();

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterReceiptPublish: () => {
          throw new Error("clean-real-post-receipt-fault");
        },
      },
    })).rejects.toMatchObject({ category: "artifact-invalid" });

    await assertNoInstallerResidue(repo, { target: false, receipt: false });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("retains a real published receipt and target when final target tampering blocks rollback", async () => {
    const repo = await clonePreparedRepository();
    const unknownPath = join(repo.targetPath, "unknown.txt");
    let receiptBefore = Buffer.alloc(0);

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterReceiptPublish: async () => {
          receiptBefore = await readFile(repo.receiptPath);
          await writeFile(unknownPath, "TAMPERED-PUBLISHED-TARGET\n", "utf8");
          throw Object.assign(new Error("tampered-real-post-receipt-fault"), {
            category: "cleanup-incomplete",
          });
        },
      },
    })).rejects.toMatchObject({ category: "rollback-incomplete" });

    expect(await readFile(repo.receiptPath)).toEqual(receiptBefore);
    runContract.decodeInstallationReceipt(receiptBefore);
    expect((await readdir(repo.targetPath)).sort()).toEqual([
      "acceptance-build.json",
      "data.json",
      "main.js",
      "manifest.json",
      "styles.css",
      "unknown.txt",
    ]);
    await expect(readFile(unknownPath, "utf8")).resolves.toBe("TAMPERED-PUBLISHED-TARGET\n");
    await assertNoInstallerResidue(repo, { target: true, receipt: true });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);
});
