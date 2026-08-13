import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fastSyntheticContract = vi.hoisted(() => Object.freeze({
  minimumBytes: 4 * 1024,
  notes: 5,
  seed: 13,
}));

vi.mock("../../scripts/synthetic-note-fixture.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/synthetic-note-fixture.mjs")>();
  return {
    ...actual,
    SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES: fastSyntheticContract.minimumBytes,
    SYNTHETIC_ACCEPTANCE_NOTE_COUNT: fastSyntheticContract.notes,
    generateAcceptanceFixture: () => actual.generateSyntheticFixture({
      minimumBytes: fastSyntheticContract.minimumBytes,
      notes: fastSyntheticContract.notes,
      seed: fastSyntheticContract.seed,
    }),
  };
});

interface FastBundleOptions {
  readonly entryPoint: string;
  readonly outfile: string;
  readonly mode: string;
  readonly pluginVersion: string;
  readonly manifestName: string;
  readonly artifactBinding: string;
  readonly production: boolean;
  readonly metafile: boolean;
  readonly write: boolean;
}

interface EsbuildConfigModule {
  readonly ACCEPTANCE_PLUGIN_NAME: string;
  readonly NORMAL_PLUGIN_NAME: string;
  readonly PLUGIN_ID: string;
  readonly isBoundedSemver: (value: unknown) => boolean;
  readonly buildBundle: (options: FastBundleOptions) => Promise<unknown>;
}

// These are the only two performance seams in this suite. The installer, Git,
// filesystem, artifact transaction, contracts, publication, receipt, and
// rollback all remain real; the separate heavy suite proves the full corpus and
// real compiler path.
vi.mock("../../esbuild.config.mjs", async (importOriginal): Promise<EsbuildConfigModule> => {
  const actual = await importOriginal<EsbuildConfigModule>();
  return {
    ...actual,
    buildBundle: async (options: FastBundleOptions) => {
      if (
        options.mode !== "read-only-acceptance"
        || options.manifestName !== actual.ACCEPTANCE_PLUGIN_NAME
        || options.artifactBinding !== `${actual.PLUGIN_ID}@${options.pluginVersion}:read-only-acceptance`
        || options.metafile !== true
        || options.write !== false
        || typeof options.production !== "boolean"
      ) {
        throw new Error("Fast compiler received a noncanonical acceptance request");
      }
      const contents = Buffer.from(`${JSON.stringify({
        mode: options.mode,
        pluginVersion: options.pluginVersion,
        manifestName: options.manifestName,
        artifactBinding: options.artifactBinding,
      })}\n`, "utf8");
      return {
        outputFiles: [{ path: options.outfile, contents }],
        metafile: {
          inputs: { [options.entryPoint]: { bytes: 1, imports: [] } },
          outputs: {},
        },
      };
    },
  };
});

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
  prepareSyntheticAcceptance(options: Readonly<{
    repoRoot: string;
  }>): Promise<Readonly<{
    runId: string;
    commit: string;
    syntheticNoteCount: number;
    syntheticTotalBytes: number;
  }>>;
}

interface BuilderModule {
  readonly ACCEPTANCE_FILES: readonly [
    "acceptance-build.json",
    "main.js",
    "manifest.json",
    "styles.css",
  ];
  buildAcceptanceArtifact(options: Readonly<{
    repoRoot: string;
  }>): Promise<Readonly<{ target: string; artifacts: readonly string[] }>>;
}

interface ArtifactContractModule {
  readonly ACCEPTANCE_FILES: BuilderModule["ACCEPTANCE_FILES"];
  validateAcceptanceArtifactSnapshot(snapshot: AcceptanceArtifactSnapshot): Readonly<{
    pluginVersion: string;
    artifactBinding: string;
  }>;
  computeAcceptanceArtifactSetDigest(snapshot: AcceptanceArtifactSnapshot): string;
}

interface RunContractModule {
  readonly ACCEPTANCE_REPORT_RELATIVE_PATH: string;
  readonly INSTALLATION_RECEIPT_RELATIVE_PATH: string;
  readonly PREPARATION_STATE_RELATIVE_PATH: string;
  readonly SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH: string;
  createInstallationReceipt(input: Readonly<{
    state: PreparationState;
    stateBytes: Uint8Array;
    pluginVersion: string;
    artifactBinding: string;
    artifactSetDigest: string;
    seedBytes: Uint8Array;
  }>): InstallationReceipt;
  decodeInstallationReceipt(bytes: Uint8Array): InstallationReceipt;
  decodePreparationState(bytes: Uint8Array): PreparationState;
  encodeInstallationReceipt(receipt: InstallationReceipt): Buffer;
}

interface SyntheticDataModule {
  createSyntheticPluginDataSeed(): Readonly<Record<string, unknown>>;
  decodeSyntheticPluginDataSeed(bytes: Uint8Array): Readonly<Record<string, unknown>>;
  encodeSyntheticPluginDataSeed(): Buffer;
}

interface AcceptanceVaultModule {
  attestSyntheticAcceptanceVault(input: Readonly<{
    vaultPath: string;
    phase: "prepared" | "post-host";
  }>): Promise<Readonly<{
    syntheticNoteCount: number;
    syntheticTotalBytes: number;
    corpusDigest: string;
  }>>;
}

interface VaultCoreModule {
  readonly OBSIDIAN_CONFIG_DIRECTORY: string;
}

const removalProbe = vi.hoisted(() => ({
  active: false,
  repoRoot: "",
  events: [] as string[],
}));

const receiptCreationProbe = vi.hoisted(() => ({
  failAfterCreate: false,
  path: "",
}));

const immediateDirectoryRace = vi.hoisted(() => ({
  active: false,
  path: "",
  injectedPath: "",
  injected: false,
}));

const postReleaseLockProbe = vi.hoisted(() => ({
  active: false,
  path: "",
  bytes: "",
  injected: false,
  identity: null as null | Readonly<{ dev: bigint; ino: bigint }>,
}));

const initialArtifactLockReleaseProbe = vi.hoisted(() => ({
  active: false,
  path: "",
  injected: false,
}));

const writeWindowProbe = vi.hoisted((): {
  active: boolean;
  phase: "" | "stage" | "seed";
  triggerFile: string;
  rootPath: string;
  filePath: string;
  fileLstats: number;
  injected: boolean;
  events: string[];
  action: null | ((rootPath: string, filePath: string) => Promise<void>);
} => ({
  active: false,
  phase: "",
  triggerFile: "",
  rootPath: "",
  filePath: "",
  fileLstats: 0,
  injected: false,
  events: [] as string[],
  action: null as null | ((rootPath: string, filePath: string) => Promise<void>),
}));

const emptyStageProbe = vi.hoisted(() => ({
  active: false,
  rootPath: "",
  rootLstats: 0,
  injected: false,
  action: null as null | ((rootPath: string) => Promise<void>),
}));

const externalAccessProbe = vi.hoisted(() => ({
  active: false,
  aliases: [] as string[],
  decoyRoot: "",
  forbiddenEvents: [] as string[],
  allowedSymlinkLstats: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const record = (value: unknown): void => {
    if (!removalProbe.active) return;
    const path = String(value);
    if (path === removalProbe.repoRoot || path.startsWith(`${removalProbe.repoRoot}${sep}`)) {
      removalProbe.events.push(path);
    }
  };
  const recordExternalAccess = (operation: string, value: unknown): void => {
    if (!externalAccessProbe.active) return;
    const path = String(value);
    for (const alias of externalAccessProbe.aliases) {
      if (operation === "lstat" && path === alias) {
        externalAccessProbe.allowedSymlinkLstats.push(`${operation}:${path}`);
        return;
      }
      if (path === alias || path.startsWith(`${alias}${sep}`)) {
        externalAccessProbe.forbiddenEvents.push(`${operation}:${path}`);
        return;
      }
    }
    if (
      path === externalAccessProbe.decoyRoot
      || path.startsWith(`${externalAccessProbe.decoyRoot}${sep}`)
    ) {
      externalAccessProbe.forbiddenEvents.push(`${operation}:${path}`);
    }
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      recordExternalAccess("open", path);
      if (writeWindowProbe.active && writeWindowProbe.rootPath === "") {
        const isStageWrite = writeWindowProbe.phase === "stage"
          && path.includes(`${sep}.knowledge-workbench-read-only-acceptance.stage-`)
          && path.endsWith(`${sep}${writeWindowProbe.triggerFile}`);
        const isSeedWrite = writeWindowProbe.phase === "seed"
          && path.endsWith(`${sep}knowledge-workbench${sep}data.json`);
        if (isStageWrite || isSeedWrite) {
          writeWindowProbe.filePath = path;
          writeWindowProbe.rootPath = dirname(path);
          writeWindowProbe.events.push(`open:${path}`);
        }
      }
      if (receiptCreationProbe.failAfterCreate && path.includes(RECEIPT_STAGE_PREFIX)) {
        const handle = await actual.open(...args);
        receiptCreationProbe.path = path;
        await handle.close();
        throw Object.assign(new Error("injected receipt stage proof failure"), { code: "EIO" });
      }
      try {
        return await actual.open(...args);
      } catch (error) {
        if (
          initialArtifactLockReleaseProbe.active
          && path === initialArtifactLockReleaseProbe.path
          && typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "EEXIST"
        ) {
          initialArtifactLockReleaseProbe.active = false;
          await actual.unlink(path);
          initialArtifactLockReleaseProbe.injected = true;
        }
        throw error;
      }
    },
    lstat: async (...args: unknown[]) => {
      recordExternalAccess("lstat", args[0]);
      const path = String(args[0]);
      if (
        emptyStageProbe.active
        && basename(path).startsWith(TARGET_STAGE_PREFIX)
      ) {
        if (emptyStageProbe.rootPath === "") emptyStageProbe.rootPath = path;
        if (path === emptyStageProbe.rootPath) {
          emptyStageProbe.rootLstats += 1;
          if (emptyStageProbe.rootLstats === 3 && emptyStageProbe.action !== null) {
            const action = emptyStageProbe.action;
            emptyStageProbe.active = false;
            emptyStageProbe.action = null;
            await action(path);
            emptyStageProbe.injected = true;
          }
        }
      }
      if (writeWindowProbe.active && path === writeWindowProbe.filePath) {
        writeWindowProbe.fileLstats += 1;
        writeWindowProbe.events.push(`file-lstat:${writeWindowProbe.fileLstats}:${path}`);
      }
      if (
        writeWindowProbe.active
        && writeWindowProbe.rootPath !== ""
        && path === writeWindowProbe.rootPath
        && writeWindowProbe.fileLstats >= 2
        && writeWindowProbe.action !== null
      ) {
        const action = writeWindowProbe.action;
        writeWindowProbe.active = false;
        writeWindowProbe.action = null;
        writeWindowProbe.events.push(`inject-before-root-lstat:${path}`);
        await action(writeWindowProbe.rootPath, writeWindowProbe.filePath);
        writeWindowProbe.injected = true;
      }
      return Reflect.apply(actual.lstat, actual, args) as Awaited<ReturnType<typeof actual.lstat>>;
    },
    readFile: async (...args: unknown[]) => {
      recordExternalAccess("readFile", args[0]);
      return Reflect.apply(actual.readFile, actual, args) as ReturnType<typeof actual.readFile>;
    },
    readdir: async (...args: unknown[]) => {
      recordExternalAccess("readdir", args[0]);
      const result: unknown = await Reflect.apply(actual.readdir, actual, args);
      if (immediateDirectoryRace.active && String(args[0]) === immediateDirectoryRace.path) {
        immediateDirectoryRace.active = false;
        await actual.writeFile(
          immediateDirectoryRace.injectedPath,
          "LATE-IGNORED-SIBLING-EVIDENCE\n",
          { flag: "wx" },
        );
        immediateDirectoryRace.injected = true;
      }
      return result;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      record(args[0]);
      if (postReleaseLockProbe.active && String(args[0]) === postReleaseLockProbe.path) {
        postReleaseLockProbe.active = false;
        await actual.unlink(...args);
        await actual.writeFile(
          postReleaseLockProbe.path,
          postReleaseLockProbe.bytes,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        const replacement = await actual.lstat(postReleaseLockProbe.path, { bigint: true });
        postReleaseLockProbe.injected = true;
        postReleaseLockProbe.identity = Object.freeze({
          dev: replacement.dev,
          ino: replacement.ino,
        });
        return;
      }
      return actual.unlink(...args);
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      record(args[0]);
      return actual.rmdir(...args);
    },
  };
});

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
// @ts-expect-error The vault attester is intentionally plain ESM without a declaration file.
const acceptanceVault = await import("../../scripts/synthetic-acceptance-vault.mjs") as unknown as AcceptanceVaultModule;
// @ts-expect-error The vault core is intentionally plain ESM without a declaration file.
const vaultCore = await import("../../scripts/synthetic-vault-install-core.mjs") as unknown as VaultCoreModule;

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const HEAVY_TIMEOUT_MS = 600_000;
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
const TARGET_STAGE_PREFIX = ".knowledge-workbench-read-only-acceptance.stage-";
const RECEIPT_STAGE_PREFIX = ".read-only-acceptance-receipt.stage-";
const DESTINATION_LOCK_NAME = ".knowledge-workbench-read-only-acceptance.lock";
const POST_RELEASE_EXTERNAL_LOCK_BYTES = `${JSON.stringify({
  schemaVersion: 1,
  pid: process.pid,
  token: "00000000-0000-4000-8000-0000000000aa",
})}\n`;
const FIXED_NOTE = "Generated/00000/note-00000-3db92208.md";
const CONFIG_DIRECTORY = vaultCore.OBSIDIAN_CONFIG_DIRECTORY;
const caseRoots: string[] = [];
let templateRoot = "";
let templateContainer = "";

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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function expectAbsent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function namesOrEmpty(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function createTemplate(): Promise<void> {
  templateContainer = await realpath(await mkdtemp(join(tmpdir(), "kwb-install-template-")));
  templateRoot = templateContainer;
  runGit(templateRoot, ["init", "--quiet"]);
  runGit(templateRoot, ["config", "user.email", "acceptance@example.invalid"]);
  runGit(templateRoot, ["config", "user.name", "Acceptance Test"]);
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
  await preparation.prepareSyntheticAcceptance({ repoRoot: templateRoot });
}

async function clonePreparedRepository(): Promise<RepositoryFixture> {
  const container = await realpath(await mkdtemp(join(tmpdir(), "kwb-install-case-")));
  caseRoots.push(container);
  const repoRoot = join(container, "repo");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", templateRoot, repoRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await cp(join(templateRoot, ".dev-vault"), join(repoRoot, ".dev-vault"), { recursive: true });
  const canonical = await realpath(repoRoot);
  runGit(canonical, ["config", "user.email", "acceptance@example.invalid"]);
  runGit(canonical, ["config", "user.name", "Acceptance Test"]);
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
  if (expected.receipt) {
    await expect(lstat(repo.receiptPath)).resolves.toMatchObject({});
  } else {
    await expectAbsent(repo.receiptPath);
  }
  await expectAbsent(repo.artifactLockPath);
  await expectAbsent(repo.destinationLockPath);
  await expectAbsent(repo.reportPath);
}

function hookRecord(
  hook: AcceptanceInstallHook,
  callback: (context: Readonly<AcceptanceInstallHookContext>) => void | Promise<void>,
): Partial<Record<AcceptanceInstallHook, (
  context: Readonly<AcceptanceInstallHookContext>,
) => void | Promise<void>>> {
  return { [hook]: callback };
}

async function expectInstallFailure(
  repo: RepositoryFixture,
  hook: AcceptanceInstallHook,
  callback: (context: Readonly<AcceptanceInstallHookContext>) => void | Promise<void>,
  category: string,
): Promise<void> {
  await expect(installer.installAcceptanceDevelopment({
    repoRoot: repo.repoRoot,
    hooks: hookRecord(hook, callback),
  })).rejects.toMatchObject({ category });
}

async function assertNoSuccessfulReceipt(repo: RepositoryFixture): Promise<void> {
  await expectAbsent(repo.receiptPath);
  await expectAbsent(repo.reportPath);
}

async function replaceRegularFileWithBytes(path: string, bytes: Uint8Array): Promise<Readonly<{
  before: Readonly<{ dev: bigint; ino: bigint }>;
  after: Readonly<{ dev: bigint; ino: bigint }>;
}>> {
  const beforeStat = await lstat(path, { bigint: true });
  const replacementPath = `${path}.replacement-${randomUUID()}`;
  await writeFile(replacementPath, bytes, { flag: "wx" });
  await rename(replacementPath, path);
  const afterStat = await lstat(path, { bigint: true });
  const before = Object.freeze({ dev: beforeStat.dev, ino: beforeStat.ino });
  const after = Object.freeze({ dev: afterStat.dev, ino: afterStat.ino });
  expect(after).not.toEqual(before);
  return Object.freeze({ before, after });
}

async function assertIdentity(path: string, expected: Readonly<{ dev: bigint; ino: bigint }>): Promise<void> {
  const current = await lstat(path, { bigint: true });
  expect({ dev: current.dev, ino: current.ino }).toEqual(expected);
}

beforeAll(async () => {
  await createTemplate();
}, HEAVY_TIMEOUT_MS);

afterEach(async () => {
  removalProbe.active = false;
  removalProbe.repoRoot = "";
  removalProbe.events = [];
  receiptCreationProbe.failAfterCreate = false;
  receiptCreationProbe.path = "";
  immediateDirectoryRace.active = false;
  immediateDirectoryRace.path = "";
  immediateDirectoryRace.injectedPath = "";
  immediateDirectoryRace.injected = false;
  postReleaseLockProbe.active = false;
  postReleaseLockProbe.path = "";
  postReleaseLockProbe.bytes = "";
  postReleaseLockProbe.injected = false;
  postReleaseLockProbe.identity = null;
  initialArtifactLockReleaseProbe.active = false;
  initialArtifactLockReleaseProbe.path = "";
  initialArtifactLockReleaseProbe.injected = false;
  writeWindowProbe.active = false;
  writeWindowProbe.phase = "";
  writeWindowProbe.triggerFile = "";
  writeWindowProbe.rootPath = "";
  writeWindowProbe.filePath = "";
  writeWindowProbe.fileLstats = 0;
  writeWindowProbe.injected = false;
  writeWindowProbe.events = [];
  writeWindowProbe.action = null;
  emptyStageProbe.active = false;
  emptyStageProbe.rootPath = "";
  emptyStageProbe.rootLstats = 0;
  emptyStageProbe.injected = false;
  emptyStageProbe.action = null;
  externalAccessProbe.active = false;
  externalAccessProbe.aliases = [];
  externalAccessProbe.decoyRoot = "";
  externalAccessProbe.forbiddenEvents = [];
  externalAccessProbe.allowedSymlinkLstats = [];
  await Promise.all(caseRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}, HEAVY_TIMEOUT_MS);

afterAll(async () => {
  if (templateContainer !== "") await rm(templateContainer, { force: true, recursive: true });
}, HEAVY_TIMEOUT_MS);

describe("transactional synthetic acceptance installation", () => {
  it("publishes the exact five-file target, canonical seed, and run-bound receipt across all hook states", async () => {
    const repo = await clonePreparedRepository();
    const stateBytesBefore = await readFile(repo.statePath);
    const state = runContract.decodePreparationState(stateBytesBefore);
    expect(state.syntheticNoteCount).toBe(fastSyntheticContract.notes);
    expect(state.syntheticTotalBytes).toBe(fastSyntheticContract.minimumBytes);
    const seen: AcceptanceInstallHook[] = [];
    const contexts = new Map<AcceptanceInstallHook, Readonly<AcceptanceInstallHookContext>>();
    let sourceSnapshot: AcceptanceArtifactSnapshot | null = null;
    const sourceBytes = new Map<string, Buffer>();
    const hooks = Object.fromEntries(HOOKS.map((hook) => [hook, async (
      context: Readonly<AcceptanceInstallHookContext>,
    ) => {
      seen.push(hook);
      contexts.set(hook, context);
      expect(Object.isFrozen(context), hook).toBe(true);
      expect(Reflect.ownKeys(context).filter((key): key is string => typeof key === "string").sort(), hook)
        .toEqual(CONTEXT_KEYS);
      expect(Reflect.ownKeys(context).some((key) => typeof key === "symbol"), hook).toBe(false);
      expect(context.repoRoot, hook).toBe(repo.repoRoot);
      expect(context.artifactLockPath, hook).toBe(repo.artifactLockPath);
      expect(context.sourcePath, hook).toBe(repo.sourcePath);
      expect(context.pluginsParentPath, hook).toBe(repo.pluginsParentPath);
      expect(context.targetPath, hook).toBe(repo.targetPath);
      expect(context.seedPath, hook).toBe(repo.seedPath);
      expect(context.statePath, hook).toBe(repo.statePath);
      expect(context.receiptPath, hook).toBe(repo.receiptPath);
      expect(context.reportPath, hook).toBe(repo.reportPath);
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
        sourceSnapshot = await snapshotArtifact(context.sourcePath);
        artifactContract.validateAcceptanceArtifactSnapshot(sourceSnapshot);
        for (const [name, file] of sourceSnapshot.files) sourceBytes.set(name, Buffer.from(file.bytes));
      }
    }])) as Partial<Record<AcceptanceInstallHook, (
      context: Readonly<AcceptanceInstallHookContext>,
    ) => Promise<void>>>;

    const result = await installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot, hooks });

    expect(seen).toEqual(HOOKS);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.ownKeys(result).sort()).toEqual(["artifactBinding", "pluginVersion", "runId"]);
    expect(result).toEqual({
      runId: state.runId,
      pluginVersion: "0.1.0",
      artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    });
    expect(contexts.get("afterReceiptPublish")?.runId).toBe(result.runId);
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
    const seedBytes = await readFile(repo.seedPath);
    expect(syntheticData.decodeSyntheticPluginDataSeed(seedBytes))
      .toEqual(syntheticData.createSyntheticPluginDataSeed());
    expect(seedBytes).toEqual(syntheticData.encodeSyntheticPluginDataSeed());
    await expect(readFile(join(repo.vaultPath, CONFIG_DIRECTORY, "community-plugins.json"), "utf8"))
      .resolves.toBe("[]\n");

    if (sourceSnapshot === null) throw new Error("afterSourceFreeze did not capture the source snapshot");
    const artifactSetDigest = artifactContract.computeAcceptanceArtifactSetDigest(sourceSnapshot);
    const receiptBytes = await readFile(repo.receiptPath);
    const receipt = runContract.decodeInstallationReceipt(receiptBytes);
    const expectedReceipt = runContract.createInstallationReceipt({
      state,
      stateBytes: stateBytesBefore,
      pluginVersion: result.pluginVersion,
      artifactBinding: result.artifactBinding,
      artifactSetDigest,
      seedBytes,
    });
    expect(receipt).toEqual(expectedReceipt);
    expect(receiptBytes).toEqual(runContract.encodeInstallationReceipt(expectedReceipt));
    expect(await readFile(repo.statePath)).toEqual(stateBytesBefore);
    await assertPreparedEvidence(repo);
    await assertNoInstallerResidue(repo, { target: true, receipt: true });
  }, HEAVY_TIMEOUT_MS);

  it("holds one continuous artifact lease, makes the destination lock exclusive, and releases it first", async () => {
    const sourcePaused = await clonePreparedRepository();
    let enterSource!: () => void;
    let releaseSource!: () => void;
    const sourceEntered = new Promise<void>((resolveEntered) => { enterSource = resolveEntered; });
    const sourceGate = new Promise<void>((resolveRelease) => { releaseSource = resolveRelease; });
    const first = installer.installAcceptanceDevelopment({
      repoRoot: sourcePaused.repoRoot,
      hooks: {
        afterSourceFreeze: async () => {
          enterSource();
          await sourceGate;
        },
      },
    });
    await sourceEntered;
    await expect(builder.buildAcceptanceArtifact({ repoRoot: sourcePaused.repoRoot }))
      .rejects.toThrow(/already exists|concurrent|lock/iu);
    await expect(installer.installAcceptanceDevelopment({ repoRoot: sourcePaused.repoRoot }))
      .rejects.toMatchObject({ category: "concurrent-operation" });
    releaseSource();
    const firstResult = await first;
    expect(firstResult.runId).toMatch(/^[0-9a-f-]+$/u);

    const destinationPaused = await clonePreparedRepository();
    let enterDestination!: () => void;
    let releaseDestination!: () => void;
    const destinationEntered = new Promise<void>((resolveEntered) => { enterDestination = resolveEntered; });
    const destinationGate = new Promise<void>((resolveRelease) => { releaseDestination = resolveRelease; });
    removalProbe.active = true;
    removalProbe.repoRoot = destinationPaused.repoRoot;
    const second = installer.installAcceptanceDevelopment({
      repoRoot: destinationPaused.repoRoot,
      hooks: {
        afterDestinationLock: async ({ destinationLockPath }) => {
          expect(destinationLockPath).toBe(destinationPaused.destinationLockPath);
          enterDestination();
          await destinationGate;
        },
      },
    });
    await destinationEntered;
    await expect(open(destinationPaused.destinationLockPath, "wx", 0o600))
      .rejects.toMatchObject({ code: "EEXIST" });
    await expect(installer.installAcceptanceDevelopment({ repoRoot: destinationPaused.repoRoot }))
      .rejects.toMatchObject({ category: "concurrent-operation" });
    releaseDestination();
    const secondResult = await second;
    expect(secondResult.runId).toMatch(/^[0-9a-f-]+$/u);
    removalProbe.active = false;

    const destinationRelease = removalProbe.events.indexOf(destinationPaused.destinationLockPath);
    const artifactRelease = removalProbe.events.indexOf(destinationPaused.artifactLockPath);
    expect(destinationRelease).toBeGreaterThanOrEqual(0);
    expect(artifactRelease).toBeGreaterThan(destinationRelease);
    await assertNoInstallerResidue(destinationPaused, { target: true, receipt: true });
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer post-release lock reacquisition", () => {
  it.each([
    {
      label: "destination",
      lockPath: (repo: RepositoryFixture) => repo.destinationLockPath,
    },
    {
      label: "artifact",
      lockPath: (repo: RepositoryFixture) => repo.artifactLockPath,
    },
  ])(
    "does not mistake a newly acquired $label lock for failure of the completed transaction",
    async ({ lockPath: selectLockPath }) => {
      const repo = await clonePreparedRepository();
      const lockPath = selectLockPath(repo);
      const outcome = await installer.installAcceptanceDevelopment({
        repoRoot: repo.repoRoot,
        hooks: {
          afterReceiptPublish: () => {
            postReleaseLockProbe.active = true;
            postReleaseLockProbe.path = lockPath;
            postReleaseLockProbe.bytes = POST_RELEASE_EXTERNAL_LOCK_BYTES;
          },
        },
      }).then(
        (value) => Object.freeze({ status: "fulfilled" as const, value }),
        (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
      );
      postReleaseLockProbe.active = false;

      const injectedIdentity = postReleaseLockProbe.identity;
      if (injectedIdentity === null) {
        throw new Error(`post-release ${lockPath} reacquisition was not injected`);
      }
      expect(postReleaseLockProbe.injected).toBe(true);
      expect(await readFile(lockPath, "utf8")).toBe(POST_RELEASE_EXTERNAL_LOCK_BYTES);
      await assertIdentity(lockPath, injectedIdentity);
      const lockStat = await lstat(lockPath, { bigint: true });
      expect(lockStat.isFile()).toBe(true);
      expect(lockStat.isSymbolicLink()).toBe(false);
      expect(lockStat.nlink).toBe(1n);

      expect(await namesOrEmpty(repo.targetPath)).toEqual([
        "acceptance-build.json",
        "data.json",
        "main.js",
        "manifest.json",
        "styles.css",
      ]);
      await expect(lstat(repo.receiptPath)).resolves.toMatchObject({});
      await expectAbsent(repo.reportPath);
      expect(outcome.status).toBe("fulfilled");

      const current = await lstat(lockPath, { bigint: true });
      if (current.dev !== injectedIdentity.dev || current.ino !== injectedIdentity.ino) {
        throw new Error(`post-release ${lockPath} lock evidence changed; refusing cleanup`);
      }
      await unlink(lockPath);
      await expectAbsent(lockPath);
    },
    HEAVY_TIMEOUT_MS,
  );
});

describe("acceptance installer artifact-lock acquisition classification", () => {
  it("keeps EEXIST concurrent when the competing holder releases before classification", async () => {
    const repo = await clonePreparedRepository();
    await mkdir(dirname(repo.artifactLockPath), { recursive: true });
    await writeFile(repo.artifactLockPath, "COMPETING-ARTIFACT-LOCK\n", { flag: "wx" });
    initialArtifactLockReleaseProbe.active = true;
    initialArtifactLockReleaseProbe.path = repo.artifactLockPath;

    await expect(installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }))
      .rejects.toMatchObject({ category: "concurrent-operation" });

    expect(initialArtifactLockReleaseProbe.injected).toBe(true);
    await expectAbsent(repo.artifactLockPath);
    await expectAbsent(repo.sourcePath);
    await assertNoSuccessfulReceipt(repo);
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer unhooked write-to-snapshot continuity", () => {
  it("stops and retains a replaced empty stage before adopting its first owned tree", async () => {
    const repo = await clonePreparedRepository();
    const retainedRoot = join(dirname(repo.repoRoot), "retained-empty-stage-root-evidence");
    const retainedSentinel = join(retainedRoot, "external-empty-stage-root-sentinel.txt");
    let originalRoot: Readonly<{ dev: bigint; ino: bigint }> | null = null;
    let replacementRoot: Readonly<{ dev: bigint; ino: bigint }> | null = null;

    emptyStageProbe.active = true;
    emptyStageProbe.action = async (stagePath) => {
      const before = await lstat(stagePath, { bigint: true });
      originalRoot = Object.freeze({ dev: before.dev, ino: before.ino });
      await rename(stagePath, retainedRoot);
      await mkdir(stagePath, { mode: 0o700 });
      await writeFile(retainedSentinel, "RETAINED-ORIGINAL-EMPTY-STAGE\n", { flag: "wx" });
      const after = await lstat(stagePath, { bigint: true });
      replacementRoot = Object.freeze({ dev: after.dev, ino: after.ino });
    };

    const outcome = await installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterStageCreated: () => { throw new Error("stop after empty-stage adoption"); },
      },
    }).then(
      (value) => Object.freeze({ status: "fulfilled" as const, value }),
      (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
    );

    if (originalRoot === null || replacementRoot === null) {
      throw new Error("empty-stage replacement evidence was not captured");
    }
    expect(emptyStageProbe.injected).toBe(true);
    expect(emptyStageProbe.rootLstats).toBe(3);
    expect(replacementRoot).not.toEqual(originalRoot);
    expect(outcome).toMatchObject({
      status: "rejected",
      error: { category: "cleanup-incomplete" },
    });
    await assertIdentity(emptyStageProbe.rootPath, replacementRoot);
    await assertIdentity(retainedRoot, originalRoot);
    await expect(readFile(retainedSentinel, "utf8"))
      .resolves.toBe("RETAINED-ORIGINAL-EMPTY-STAGE\n");
    await expectAbsent(repo.targetPath);
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);

  it.each([
    { label: "replacement", mutation: "replace" },
    { label: "mode change", mutation: "chmod" },
  ] as const)(
    "stops and retains a stage-root $label between exclusive file write and the fresh tree snapshot",
    async ({ mutation }) => {
      const repo = await clonePreparedRepository();
      let originalRoot: Readonly<{ dev: bigint; ino: bigint }> | null = null;
      let mutatedRoot: Readonly<{ dev: bigint; ino: bigint }> | null = null;
      let retainedRoot = "";
      let retainedSentinel = "";

      writeWindowProbe.active = true;
      writeWindowProbe.phase = "stage";
      writeWindowProbe.triggerFile = "main.js";
      writeWindowProbe.action = async (stagePath) => {
        const before = await lstat(stagePath, { bigint: true });
        originalRoot = Object.freeze({ dev: before.dev, ino: before.ino });
        if (mutation === "replace") {
          retainedRoot = join(dirname(repo.repoRoot), "retained-stage-root-evidence");
          retainedSentinel = join(retainedRoot, "external-stage-root-sentinel.txt");
          await rename(stagePath, retainedRoot);
          await mkdir(stagePath, { mode: 0o700 });
          for (const name of await readdir(retainedRoot)) {
            await rename(join(retainedRoot, name), join(stagePath, name));
          }
          await writeFile(retainedSentinel, "RETAINED-ORIGINAL-STAGE-ROOT\n", { flag: "wx" });
        } else {
          await chmod(stagePath, 0o755);
        }
        const after = await lstat(stagePath, { bigint: true });
        mutatedRoot = Object.freeze({ dev: after.dev, ino: after.ino });
      };

      const outcome = await installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }).then(
        (value) => Object.freeze({ status: "fulfilled" as const, value }),
        (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
      );
      writeWindowProbe.active = false;

      if (originalRoot === null || mutatedRoot === null) {
        throw new Error("stage write-window mutation evidence was not captured");
      }
      expect(writeWindowProbe.injected).toBe(true);
      expect(writeWindowProbe.fileLstats).toBe(2);
      expect(writeWindowProbe.events.at(-1)).toBe(
        `inject-before-root-lstat:${writeWindowProbe.rootPath}`,
      );
      expect(outcome).toMatchObject({
        status: "rejected",
        error: { category: "cleanup-incomplete" },
      });
      const liveMutatedRoot = await lstat(writeWindowProbe.rootPath, { bigint: true });
      expect({ dev: liveMutatedRoot.dev, ino: liveMutatedRoot.ino }).toEqual(mutatedRoot);
      if (mutation === "replace") {
        expect(mutatedRoot).not.toEqual(originalRoot);
        const retained = await lstat(retainedRoot, { bigint: true });
        expect({ dev: retained.dev, ino: retained.ino }).toEqual(originalRoot);
        await expect(readFile(retainedSentinel, "utf8"))
          .resolves.toBe("RETAINED-ORIGINAL-STAGE-ROOT\n");
      } else {
        expect(mutatedRoot).toEqual(originalRoot);
        expect(liveMutatedRoot.mode & 0o777n).toBe(0o755n);
      }

      await expectAbsent(repo.targetPath);
      await assertNoSuccessfulReceipt(repo);
      await expectAbsent(repo.destinationLockPath);
      await expectAbsent(repo.artifactLockPath);
    },
    HEAVY_TIMEOUT_MS,
  );

  it.each([
    { label: "root replacement", mutation: "replace-root" },
    { label: "root mode change", mutation: "chmod-root" },
    { label: "four original artifact replacements", mutation: "replace-files" },
  ] as const)(
    "stops and retains a target $label between seed write and the five-file snapshot",
    async ({ mutation }) => {
      const repo = await clonePreparedRepository();
      let originalRoot: Readonly<{ dev: bigint; ino: bigint }> | null = null;
      let mutatedRoot: Readonly<{ dev: bigint; ino: bigint }> | null = null;
      let retainedRoot = "";
      let retainedSentinel = "";
      const originalFiles = new Map<string, Readonly<{ dev: bigint; ino: bigint; bytes: Buffer }>>();
      const replacementFiles = new Map<string, Readonly<{ dev: bigint; ino: bigint }>>();

      writeWindowProbe.active = true;
      writeWindowProbe.phase = "seed";
      writeWindowProbe.action = async (targetPath) => {
        const before = await lstat(targetPath, { bigint: true });
        originalRoot = Object.freeze({ dev: before.dev, ino: before.ino });
        if (mutation === "replace-root") {
          retainedRoot = join(dirname(repo.repoRoot), "retained-target-root-evidence");
          retainedSentinel = join(retainedRoot, "external-target-root-sentinel.txt");
          await rename(targetPath, retainedRoot);
          await mkdir(targetPath, { mode: 0o700 });
          for (const name of await readdir(retainedRoot)) {
            await rename(join(retainedRoot, name), join(targetPath, name));
          }
          await writeFile(retainedSentinel, "RETAINED-ORIGINAL-TARGET-ROOT\n", { flag: "wx" });
        } else if (mutation === "chmod-root") {
          await chmod(targetPath, 0o755);
        } else {
          retainedRoot = join(dirname(repo.repoRoot), "retained-target-file-evidence");
          await mkdir(retainedRoot, { mode: 0o700 });
          for (const name of artifactContract.ACCEPTANCE_FILES) {
            const path = join(targetPath, name);
            const [stat, bytes] = await Promise.all([
              lstat(path, { bigint: true }),
              readFile(path),
            ]);
            originalFiles.set(name, Object.freeze({
              dev: stat.dev,
              ino: stat.ino,
              bytes: Buffer.from(bytes),
            }));
            await rename(path, join(retainedRoot, name));
            await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
            const replacement = await lstat(path, { bigint: true });
            replacementFiles.set(name, Object.freeze({
              dev: replacement.dev,
              ino: replacement.ino,
            }));
          }
        }
        const after = await lstat(targetPath, { bigint: true });
        mutatedRoot = Object.freeze({ dev: after.dev, ino: after.ino });
      };

      const outcome = await installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }).then(
        (value) => Object.freeze({ status: "fulfilled" as const, value }),
        (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
      );
      writeWindowProbe.active = false;

      if (originalRoot === null || mutatedRoot === null) {
        throw new Error("target seed-window mutation evidence was not captured");
      }
      expect(writeWindowProbe.injected).toBe(true);
      expect(writeWindowProbe.fileLstats).toBe(2);
      expect(writeWindowProbe.events.at(-1)).toBe(
        `inject-before-root-lstat:${writeWindowProbe.rootPath}`,
      );
      const targetAfter = await lstat(repo.targetPath, { bigint: true });
      expect({ dev: targetAfter.dev, ino: targetAfter.ino }).toEqual(mutatedRoot);
      if (mutation === "replace-root") {
        expect(mutatedRoot).not.toEqual(originalRoot);
        const retained = await lstat(retainedRoot, { bigint: true });
        expect({ dev: retained.dev, ino: retained.ino }).toEqual(originalRoot);
        await expect(readFile(retainedSentinel, "utf8"))
          .resolves.toBe("RETAINED-ORIGINAL-TARGET-ROOT\n");
      } else if (mutation === "chmod-root") {
        expect(mutatedRoot).toEqual(originalRoot);
        expect(targetAfter.mode & 0o777n).toBe(0o755n);
      } else {
        expect([...originalFiles.keys()].sort()).toEqual([...artifactContract.ACCEPTANCE_FILES]);
        for (const name of artifactContract.ACCEPTANCE_FILES) {
          const original = originalFiles.get(name);
          const replacement = replacementFiles.get(name);
          if (original === undefined || replacement === undefined) {
            throw new Error(`target replacement evidence missing for ${name}`);
          }
          const retained = await lstat(join(retainedRoot, name), { bigint: true });
          expect({ dev: retained.dev, ino: retained.ino }).toEqual({
            dev: original.dev,
            ino: original.ino,
          });
          expect(await readFile(join(retainedRoot, name))).toEqual(original.bytes);
          expect(replacement).not.toEqual({ dev: original.dev, ino: original.ino });
          expect(await readFile(join(repo.targetPath, name))).toEqual(original.bytes);
        }
      }

      expect(outcome).toMatchObject({
        status: "rejected",
        error: { category: "rollback-incomplete" },
      });
      await assertNoSuccessfulReceipt(repo);
      await expectAbsent(repo.destinationLockPath);
      await expectAbsent(repo.artifactLockPath);
    },
    HEAVY_TIMEOUT_MS,
  );
});

describe("acceptance installer Git drift rotation", () => {
  it.each([
    {
      label: "HEAD changes after the artifact lock",
      hook: "afterArtifactLock",
      mutate: async (repo: RepositoryFixture) => {
        const before = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);
        await writeFile(join(repo.repoRoot, "tracked.txt"), "head-drift\n", "utf8");
        runGit(repo.repoRoot, ["add", "tracked.txt"]);
        runGit(repo.repoRoot, ["commit", "--quiet", "-m", "hostile head drift"]);
        return Object.freeze({ before, after: runGit(repo.repoRoot, ["rev-parse", "HEAD"]) });
      },
      assertEvidence: async (repo: RepositoryFixture, evidence: Readonly<{ before: string; after: string }>) => {
        expect(evidence.after).not.toBe(evidence.before);
        expect(runGit(repo.repoRoot, ["rev-parse", "HEAD"])).toBe(evidence.after);
      },
    },
    {
      label: "the index becomes dirty after the build",
      hook: "afterBuild",
      mutate: async (repo: RepositoryFixture) => {
        await writeFile(join(repo.repoRoot, "tracked.txt"), "staged-index-drift\n", "utf8");
        runGit(repo.repoRoot, ["add", "tracked.txt"]);
        return "tracked.txt";
      },
      assertEvidence: async (repo: RepositoryFixture, evidence: string) => {
        expect(runGit(repo.repoRoot, ["diff", "--cached", "--name-only"])).toBe(evidence);
      },
    },
    {
      label: "a tracked file changes after the source freeze",
      hook: "afterSourceFreeze",
      mutate: async (repo: RepositoryFixture) => {
        const bytes = Buffer.from("tracked-worktree-drift\n", "utf8");
        await writeFile(join(repo.repoRoot, "tracked.txt"), bytes);
        return bytes;
      },
      assertEvidence: async (repo: RepositoryFixture, evidence: Buffer) => {
        expect(await readFile(join(repo.repoRoot, "tracked.txt"))).toEqual(evidence);
        expect(runGit(repo.repoRoot, ["diff", "--name-only"])).toBe("tracked.txt");
      },
    },
    {
      label: "a non-ignored untracked file appears after the seed",
      hook: "afterSeed",
      mutate: async (repo: RepositoryFixture) => {
        const path = join(repo.repoRoot, "untracked-drift.txt");
        await writeFile(path, "non-ignored-untracked-drift\n", "utf8");
        return path;
      },
      assertEvidence: async (repo: RepositoryFixture, evidence: string) => {
        await expect(readFile(evidence, "utf8")).resolves.toBe("non-ignored-untracked-drift\n");
        expect(runGit(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]))
          .toContain("?? untracked-drift.txt");
      },
    },
  ] satisfies ReadonlyArray<Readonly<{
    label: string;
    hook: AcceptanceInstallHook;
    mutate: (repo: RepositoryFixture) => Promise<unknown>;
    assertEvidence: (repo: RepositoryFixture, evidence: never) => Promise<void>;
  }>>)('$label is rejected as concurrent-operation and retained', async ({ hook, mutate, assertEvidence }) => {
    const repo = await clonePreparedRepository();
    const evidence = await (async () => {
      let value: unknown;
      await expectInstallFailure(repo, hook, async () => {
        value = await mutate(repo);
      }, "concurrent-operation");
      return value;
    })();

    await assertEvidence(repo, evidence as never);
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.targetPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer frozen-boundary identity rotation", () => {
  it.each([
    {
      label: "preparation state same-inode mutation and same-bytes replacement",
      run: async () => {
        for (const mode of ["same-inode", "replacement"] as const) {
          const repo = await clonePreparedRepository();
          const originalBytes = await readFile(repo.statePath);
          const originalStat = await lstat(repo.statePath, { bigint: true });
          let expectedBytes = Buffer.from(originalBytes);
          let expectedIdentity = Object.freeze({ dev: originalStat.dev, ino: originalStat.ino });

          await expectInstallFailure(repo, "afterBuild", async () => {
            if (mode === "same-inode") {
              expectedBytes[0] = (expectedBytes[0] ?? 0) ^ 0x01;
              await writeFile(repo.statePath, expectedBytes);
              const changed = await lstat(repo.statePath, { bigint: true });
              expect({ dev: changed.dev, ino: changed.ino, size: changed.size }).toEqual({
                dev: originalStat.dev,
                ino: originalStat.ino,
                size: originalStat.size,
              });
            } else {
              const replacement = await replaceRegularFileWithBytes(repo.statePath, originalBytes);
              expectedIdentity = replacement.after;
            }
          }, "fixture-changed");

          expect(await readFile(repo.statePath)).toEqual(expectedBytes);
          await assertIdentity(repo.statePath, expectedIdentity);
          await assertNoSuccessfulReceipt(repo);
          await expectAbsent(repo.targetPath);
          await expectAbsent(repo.artifactLockPath);
        }
      },
    },
    {
      label: "source-directory and artifact-lock replacements",
      run: async () => {
        const sourceRepo = await clonePreparedRepository();
        const retainedSource = `${sourceRepo.sourcePath}.retained-evidence`;
        await expectInstallFailure(sourceRepo, "afterSourceFreeze", async () => {
          await rename(sourceRepo.sourcePath, retainedSource);
          await mkdir(sourceRepo.sourcePath);
        }, "artifact-changed");
        await expect(lstat(retainedSource)).resolves.toMatchObject({});
        await expect(lstat(sourceRepo.sourcePath)).resolves.toMatchObject({});
        await assertNoSuccessfulReceipt(sourceRepo);
        await expectAbsent(sourceRepo.targetPath);
        await expectAbsent(sourceRepo.artifactLockPath);

        const lockRepo = await clonePreparedRepository();
        let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
        let replacementBytes = Buffer.alloc(0);
        await expectInstallFailure(lockRepo, "afterBuild", async () => {
          replacementBytes = await readFile(lockRepo.artifactLockPath);
          replacementIdentity = (await replaceRegularFileWithBytes(
            lockRepo.artifactLockPath,
            replacementBytes,
          )).after;
        }, "cleanup-incomplete");
        if (replacementIdentity === null) throw new Error("artifact lock replacement was not installed");
        await assertIdentity(lockRepo.artifactLockPath, replacementIdentity);
        expect(await readFile(lockRepo.artifactLockPath)).toEqual(replacementBytes);
        await assertNoSuccessfulReceipt(lockRepo);
        await expectAbsent(lockRepo.targetPath);
        await expectAbsent(lockRepo.destinationLockPath);
      },
    },
    {
      label: "community manifest same-bytes replacement after target publication",
      run: async () => {
        const repo = await clonePreparedRepository();
        const communityPath = join(repo.vaultPath, CONFIG_DIRECTORY, "community-plugins.json");
        const originalBytes = await readFile(communityPath);
        let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

        await expectInstallFailure(repo, "afterTargetPublished", async () => {
          replacementIdentity = (await replaceRegularFileWithBytes(communityPath, originalBytes)).after;
        }, "fixture-changed");

        if (replacementIdentity === null) throw new Error("community replacement was not installed");
        await assertIdentity(communityPath, replacementIdentity);
        expect(await readFile(communityPath)).toEqual(originalBytes);
        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.targetPath);
        await expectAbsent(repo.destinationLockPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
    {
      label: "target and receipt expectation racers",
      run: async () => {
        const targetRepo = await clonePreparedRepository();
        const targetSentinel = join(targetRepo.targetPath, "racer.txt");
        await expectInstallFailure(targetRepo, "afterStageValidated", async () => {
          await mkdir(targetRepo.targetPath);
          await writeFile(targetSentinel, "TARGET-RACER-EVIDENCE\n", "utf8");
        }, "fixture-changed");
        await expect(readFile(targetSentinel, "utf8")).resolves.toBe("TARGET-RACER-EVIDENCE\n");
        await assertNoSuccessfulReceipt(targetRepo);
        await expectAbsent(targetRepo.artifactLockPath);
        await expectAbsent(targetRepo.destinationLockPath);

        const receiptRepo = await clonePreparedRepository();
        const receiptEvidence = Buffer.from("RECEIPT-RACER-EVIDENCE\n", "utf8");
        await expectInstallFailure(receiptRepo, "afterSeed", async () => {
          await writeFile(receiptRepo.receiptPath, receiptEvidence, { flag: "wx" });
        }, "target-exists");
        expect(await readFile(receiptRepo.receiptPath)).toEqual(receiptEvidence);
        await expectAbsent(receiptRepo.targetPath);
        await expectAbsent(receiptRepo.reportPath);
        await expectAbsent(receiptRepo.artifactLockPath);
        await expectAbsent(receiptRepo.destinationLockPath);
      },
    },
  ])('$label is detected without consuming the prepared run', async ({ run }) => {
    await run();
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer ABA and missing-lock cleanup dominance", () => {
  it.each([
    {
      name: "source same-inode same-size mutate-then-restore ABA",
      run: async () => {
        const repo = await clonePreparedRepository();
        const mainPath = join(repo.sourcePath, "main.js");
        let originalBytes = Buffer.alloc(0);
        let originalIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

        await expectInstallFailure(repo, "afterSourceFreeze", async () => {
          originalBytes = await readFile(mainPath);
          const before = await lstat(mainPath, { bigint: true });
          originalIdentity = Object.freeze({ dev: before.dev, ino: before.ino });
          const mutated = Buffer.from(originalBytes);
          mutated[0] = (mutated[0] ?? 0) ^ 0xff;
          await writeFile(mainPath, mutated);
          await writeFile(mainPath, originalBytes);
          const after = await lstat(mainPath, { bigint: true });
          expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
            dev: before.dev,
            ino: before.ino,
            size: before.size,
          });
        }, "artifact-changed");

        if (originalIdentity === null) throw new Error("source ABA identity was not captured");
        await assertIdentity(mainPath, originalIdentity);
        expect(await readFile(mainPath)).toEqual(originalBytes);
        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.targetPath);
        await expectAbsent(repo.destinationLockPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
    {
      name: "missing destination lock after acquisition",
      run: async () => {
        const repo = await clonePreparedRepository();
        await expectInstallFailure(repo, "afterDestinationLock", async ({ destinationLockPath }) => {
          if (destinationLockPath === null) throw new Error("destination lock path missing");
          await unlink(destinationLockPath);
          throw new Error("failure after deleting destination lock");
        }, "cleanup-incomplete");

        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.targetPath);
        await expectAbsent(repo.destinationLockPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
    {
      name: "missing artifact lock after acquisition",
      run: async () => {
        const repo = await clonePreparedRepository();
        await expectInstallFailure(repo, "afterBuild", async ({ artifactLockPath }) => {
          await unlink(artifactLockPath);
          throw new Error("failure after deleting artifact lock");
        }, "cleanup-incomplete");

        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.targetPath);
        await expectAbsent(repo.destinationLockPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
  ])('rejects $name without claiming cleanup success', async ({ run }) => {
    await run();
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer invocation and initial hard stops", () => {
  it("rejects non-plain, inherited, accessor, symbol, extra, and malformed hook options without invoking getters", async () => {
    let getterCalls = 0;
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "repoRoot", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "/tmp/not-used";
      },
    });
    const accessorHooks = {};
    Object.defineProperty(accessorHooks, "afterBuild", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return () => undefined;
      },
    });
    const symbolOptions = { repoRoot: "/tmp/not-used" } as Record<PropertyKey, unknown>;
    symbolOptions[Symbol("hidden")] = true;
    const symbolHooks = {} as Record<PropertyKey, unknown>;
    symbolHooks[Symbol("hidden-hook")] = () => undefined;
    const throwingProxy = new Proxy({}, {
      ownKeys: () => { throw new Error("untrusted ownKeys trap"); },
    });
    const inheritedOptions = Object.create({ repoRoot: "/tmp/not-used" }) as object;
    const inheritedHooks = Object.create({ afterBuild: () => undefined }) as object;
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["array", []],
      ["date", new Date(0)],
      ["null prototype", Object.assign(Object.create(null) as object, { repoRoot: "/tmp/not-used" })],
      ["inherited options", inheritedOptions],
      ["missing repoRoot", {}],
      ["non-string repoRoot", { repoRoot: 1 }],
      ["repoRoot accessor", accessorOptions],
      ["symbol option", symbolOptions],
      ["extra option", { repoRoot: "/tmp/not-used", lease: Object.freeze({}) }],
      ["unknown path override", { repoRoot: "/tmp/not-used", vaultPath: "/tmp/other" }],
      ["hooks array", { repoRoot: "/tmp/not-used", hooks: [] }],
      ["hooks null", { repoRoot: "/tmp/not-used", hooks: null }],
      ["inherited hooks", { repoRoot: "/tmp/not-used", hooks: inheritedHooks }],
      ["hook accessor", { repoRoot: "/tmp/not-used", hooks: accessorHooks }],
      ["symbol hook", { repoRoot: "/tmp/not-used", hooks: symbolHooks }],
      ["unknown hook", { repoRoot: "/tmp/not-used", hooks: { beforeLaunch: () => undefined } }],
      ["non-function hook", { repoRoot: "/tmp/not-used", hooks: { afterBuild: true } }],
      ["hostile proxy", throwingProxy],
    ];

    for (const [label, value] of cases) {
      await expect(installer.installAcceptanceDevelopment(
        value as Readonly<{ repoRoot: string }>,
      ), label).rejects.toMatchObject({ category: "invalid-invocation" });
    }
    expect(getterCalls).toBe(0);
  }, HEAVY_TIMEOUT_MS);

  it("never replays a branded failure thrown back through an invalid-invocation proxy", async () => {
    const extractorDescriptor = Object.getOwnPropertyDescriptor(
      installer.installAcceptanceDevelopment,
      "extractFailureCategory",
    );
    const rawExtractor: unknown = extractorDescriptor?.value;
    if (
      extractorDescriptor === undefined
      || !("value" in extractorDescriptor)
      || typeof rawExtractor !== "function"
    ) {
      throw new Error("installer failure-category extractor is unavailable");
    }
    const extractFailureCategory = (error: unknown): string | null => (
      Reflect.apply(rawExtractor, undefined, [error]) as string | null
    );

    let firstFailure: Error | undefined;
    try {
      await installer.installAcceptanceDevelopment(
        undefined as unknown as Readonly<{ repoRoot: string }>,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw new Error("invalid invocation threw a non-Error value");
      firstFailure = error;
    }
    if (firstFailure === undefined) throw new Error("invalid invocation unexpectedly succeeded");
    expect(extractFailureCategory(firstFailure)).toBe("invalid-invocation");

    const leakedConstructor: unknown = Reflect.get(firstFailure, "constructor");
    if (typeof leakedConstructor !== "function") {
      throw new Error("failure constructor is not callable");
    }
    expect(Object.isFrozen(leakedConstructor)).toBe(true);
    expect(Object.isFrozen(leakedConstructor.prototype)).toBe(true);
    expect(Reflect.defineProperty(leakedConstructor, Symbol.hasInstance, {
      configurable: true,
      value: (_candidate: unknown): boolean => true,
    })).toBe(false);
    expect(() => {
      Reflect.construct(leakedConstructor, [
        undefined,
        "rollback-incomplete",
        "forged",
      ]);
    }).toThrow(TypeError);

    const categoryDescriptor = Object.getOwnPropertyDescriptor(firstFailure, "category");
    if (
      categoryDescriptor !== undefined
      && "value" in categoryDescriptor
      && categoryDescriptor.writable
    ) {
      expect(Reflect.set(firstFailure as object, "category", "rollback-incomplete")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(firstFailure, "category"))
        .toMatchObject({ value: "rollback-incomplete" });
    }

    const replayOptions = new Proxy({}, {
      getPrototypeOf: () => { throw firstFailure; },
    });
    let secondFailure: unknown;
    try {
      await installer.installAcceptanceDevelopment(
        replayOptions as Readonly<{ repoRoot: string }>,
      );
    } catch (error) {
      secondFailure = error;
    }
    if (secondFailure === undefined) throw new Error("proxy replay unexpectedly succeeded");

    expect(secondFailure).not.toBe(firstFailure);
    expect(extractFailureCategory(firstFailure)).toBe("invalid-invocation");
    expect(extractFailureCategory(secondFailure)).toBe("invalid-invocation");
    expect(Object.getOwnPropertyDescriptor(secondFailure, "category"))
      .toMatchObject({ value: "invalid-invocation" });
  }, HEAVY_TIMEOUT_MS);

  it("uses only the private failure registry for internal category passthrough", async () => {
    const source = await readFile(join(projectRoot, "scripts", "install-acceptance-dev.mjs"), "utf8");
    expect(source).not.toContain("instanceof AcceptanceInstallFailure");
  }, HEAVY_TIMEOUT_MS);

  it.each([
    {
      label: "partial fixed target",
      category: "target-exists",
      install: async (repo: RepositoryFixture) => {
        await mkdir(repo.targetPath);
        const path = join(repo.targetPath, "main.js");
        await writeFile(path, "NORMAL-OR-PARTIAL-TARGET\n", "utf8");
        return path;
      },
    },
    {
      label: "existing receipt",
      category: "target-exists",
      install: async (repo: RepositoryFixture) => {
        await writeFile(repo.receiptPath, "CROSS-RUN-RECEIPT\n", "utf8");
        return repo.receiptPath;
      },
    },
    {
      label: "existing report",
      category: "target-exists",
      install: async (repo: RepositoryFixture) => {
        await writeFile(repo.reportPath, "CROSS-RUN-REPORT\n", "utf8");
        return repo.reportPath;
      },
    },
    {
      label: "destination lock",
      category: "concurrent-operation",
      install: async (repo: RepositoryFixture) => {
        await writeFile(repo.destinationLockPath, "STALE-DESTINATION-LOCK\n", "utf8");
        return repo.destinationLockPath;
      },
    },
    {
      label: "target stage residue",
      category: "concurrent-operation",
      install: async (repo: RepositoryFixture) => {
        const path = join(repo.pluginsParentPath, `${TARGET_STAGE_PREFIX}retained`);
        await mkdir(path);
        await writeFile(join(path, "sentinel"), "RETAINED-STAGE\n", "utf8");
        return join(path, "sentinel");
      },
    },
    {
      label: "target backup residue",
      category: "concurrent-operation",
      install: async (repo: RepositoryFixture) => {
        const path = join(
          repo.pluginsParentPath,
          ".knowledge-workbench-read-only-acceptance.backup-retained",
        );
        await writeFile(path, "RETAINED-BACKUP\n", "utf8");
        return path;
      },
    },
    {
      label: "target quarantine residue",
      category: "concurrent-operation",
      install: async (repo: RepositoryFixture) => {
        const path = join(
          repo.pluginsParentPath,
          ".knowledge-workbench-read-only-acceptance.quarantine-retained",
        );
        await writeFile(path, "RETAINED-QUARANTINE\n", "utf8");
        return path;
      },
    },
    {
      label: "receipt stage residue",
      category: "concurrent-operation",
      install: async (repo: RepositoryFixture) => {
        const path = join(repo.devRoot, `${RECEIPT_STAGE_PREFIX}retained`);
        await writeFile(path, "RETAINED-RECEIPT-STAGE\n", "utf8");
        return path;
      },
    },
    {
      label: "unknown plugins-parent child",
      category: "concurrent-operation",
      install: async (repo: RepositoryFixture) => {
        const path = join(repo.pluginsParentPath, "unknown-plugin");
        await writeFile(path, "UNKNOWN-PLUGIN-CHILD\n", "utf8");
        return path;
      },
    },
    {
      label: "enabled community plugin",
      category: "plugin-enabled",
      install: async (repo: RepositoryFixture) => {
        const path = join(repo.vaultPath, CONFIG_DIRECTORY, "community-plugins.json");
        await writeFile(path, "[\"knowledge-workbench\"]\n", "utf8");
        return path;
      },
    },
  ])("rejects and preserves $label", async ({ category, install }) => {
    const repo = await clonePreparedRepository();
    const sentinelPath = await install(repo);
    const before = await readFile(sentinelPath);
    const beforeStat = await lstat(sentinelPath, { bigint: true });

    await expect(installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }))
      .rejects.toMatchObject({ category });

    expect(await readFile(sentinelPath)).toEqual(before);
    const afterStat = await lstat(sentinelPath, { bigint: true });
    expect({ dev: afterStat.dev, ino: afterStat.ino }).toEqual({ dev: beforeStat.dev, ino: beforeStat.ino });
    await expect(readFile(repo.legacyPath, "utf8")).resolves.toBe("LEGACY-ACCEPTANCE-SENTINEL\n");
    await expectAbsent(repo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer destination-lock sentinel shapes", () => {
  it.each([
    { label: "file, directory, symbolic link, and FIFO" },
  ])('preserves every pre-existing $label lock shape', async () => {
    for (const shape of ["file", "directory", "symlink", "fifo"] as const) {
      const repo = await clonePreparedRepository();
      const directorySentinel = join(repo.destinationLockPath, "sentinel.txt");
      if (shape === "file") {
        await writeFile(repo.destinationLockPath, "LOCK-FILE-EVIDENCE\n", "utf8");
      } else if (shape === "directory") {
        await mkdir(repo.destinationLockPath);
        await writeFile(directorySentinel, "LOCK-DIRECTORY-EVIDENCE\n", "utf8");
      } else if (shape === "symlink") {
        await symlink("missing-destination-lock-target", repo.destinationLockPath);
      } else {
        execFileSync("mkfifo", [repo.destinationLockPath]);
      }
      const before = await lstat(repo.destinationLockPath, { bigint: true });
      const identity = Object.freeze({ dev: before.dev, ino: before.ino });

      await expect(installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }))
        .rejects.toMatchObject({ category: "concurrent-operation" });

      await assertIdentity(repo.destinationLockPath, identity);
      const after = await lstat(repo.destinationLockPath, { bigint: true });
      expect({
        file: after.isFile(),
        directory: after.isDirectory(),
        symlink: after.isSymbolicLink(),
        fifo: after.isFIFO(),
      }).toEqual({
        file: shape === "file",
        directory: shape === "directory",
        symlink: shape === "symlink",
        fifo: shape === "fifo",
      });
      if (shape === "file") {
        await expect(readFile(repo.destinationLockPath, "utf8")).resolves.toBe("LOCK-FILE-EVIDENCE\n");
      }
      if (shape === "directory") {
        await expect(readFile(directorySentinel, "utf8")).resolves.toBe("LOCK-DIRECTORY-EVIDENCE\n");
      }
      if (shape === "symlink") {
        await expect(readlink(repo.destinationLockPath)).resolves.toBe("missing-destination-lock-target");
      }
      await assertNoSuccessfulReceipt(repo);
      await expectAbsent(repo.targetPath);
      await expectAbsent(repo.artifactLockPath);
    }
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer TOCTOU revalidation", () => {
  it("detects a same-inode same-size frozen source mutation and never starts destination publication", async () => {
    const repo = await clonePreparedRepository();
    let sourcePath = "";
    let mutated = Buffer.alloc(0);

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterSourceFreeze: async ({ sourcePath: frozenSource }) => {
          sourcePath = join(frozenSource, "main.js");
          const beforeStat = await lstat(sourcePath, { bigint: true });
          mutated = await readFile(sourcePath);
          mutated[0] = (mutated[0] ?? 0) ^ 0xff;
          await writeFile(sourcePath, mutated);
          const afterStat = await lstat(sourcePath, { bigint: true });
          expect({ dev: afterStat.dev, ino: afterStat.ino, size: afterStat.size }).toEqual({
            dev: beforeStat.dev,
            ino: beforeStat.ino,
            size: beforeStat.size,
          });
        },
      },
    })).rejects.toMatchObject({ category: "artifact-changed" });

    expect(sourcePath).not.toBe("");
    expect(await readFile(sourcePath)).toEqual(mutated);
    await acceptanceVault.attestSyntheticAcceptanceVault({ vaultPath: repo.vaultPath, phase: "prepared" });
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("detects same-inode same-size fixture drift before seed and rolls back the exact four-file target", async () => {
    const repo = await clonePreparedRepository();
    const notePath = join(repo.vaultPath, FIXED_NOTE);
    let mutated = Buffer.alloc(0);

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        beforeSeed: async () => {
          const beforeStat = await lstat(notePath, { bigint: true });
          mutated = await readFile(notePath);
          mutated[0] = (mutated[0] ?? 0) ^ 0xff;
          await writeFile(notePath, mutated);
          const afterStat = await lstat(notePath, { bigint: true });
          expect({ dev: afterStat.dev, ino: afterStat.ino, size: afterStat.size }).toEqual({
            dev: beforeStat.dev,
            ino: beforeStat.ino,
            size: beforeStat.size,
          });
        },
      },
    })).rejects.toMatchObject({ category: "fixture-changed" });

    expect(await readFile(notePath)).toEqual(mutated);
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("detects plugin enablement before seed, retains that external evidence, and removes only its target", async () => {
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

  it("rejects a fifth artifact introduced after the real build and preserves changed source evidence", async () => {
    const repo = await clonePreparedRepository();
    const extraPath = join(repo.sourcePath, "extra.js");

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterBuild: async () => {
          await writeFile(extraPath, "EXTRA-ARTIFACT\n", "utf8");
        },
      },
    })).rejects.toMatchObject({ category: "artifact-invalid" });

    await expect(readFile(extraPath, "utf8")).resolves.toBe("EXTRA-ARTIFACT\n");
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer post-build artifact rejection matrix", () => {
  it.each([
    {
      label: "missing, symbolic-link, hard-link, and FIFO artifact shapes",
      run: async () => {
        for (const shape of ["missing", "symlink", "hardlink", "fifo"] as const) {
          const repo = await clonePreparedRepository();
          const mainPath = join(repo.sourcePath, "main.js");
          const stylesPath = join(repo.sourcePath, "styles.css");

          await expectInstallFailure(repo, "afterBuild", async () => {
            await unlink(mainPath);
            if (shape === "symlink") await symlink("styles.css", mainPath);
            if (shape === "hardlink") await link(stylesPath, mainPath);
            if (shape === "fifo") execFileSync("mkfifo", [mainPath]);
          }, "artifact-invalid");

          if (shape === "missing") {
            await expectAbsent(mainPath);
          } else {
            const evidence = await lstat(mainPath, { bigint: true });
            if (shape === "symlink") {
              expect(evidence.isSymbolicLink()).toBe(true);
              await expect(readlink(mainPath)).resolves.toBe("styles.css");
            }
            if (shape === "hardlink") {
              expect(evidence.isFile()).toBe(true);
              expect(evidence.nlink).toBeGreaterThan(1n);
              await expect(lstat(stylesPath, { bigint: true })).resolves.toMatchObject({ nlink: evidence.nlink });
            }
            if (shape === "fifo") expect(evidence.isFIFO()).toBe(true);
          }
          await assertNoSuccessfulReceipt(repo);
          await expectAbsent(repo.targetPath);
          await expectAbsent(repo.artifactLockPath);
        }
      },
    },
    {
      label: "normal manifest, extra metadata key, and forbidden bundle token",
      run: async () => {
        for (const mutation of ["normal-manifest", "bad-metadata", "forbidden-token"] as const) {
          const repo = await clonePreparedRepository();
          let evidencePath = "";
          let evidenceBytes = Buffer.alloc(0);

          await expectInstallFailure(repo, "afterBuild", async ({ sourcePath }) => {
            if (mutation === "normal-manifest") {
              evidencePath = join(sourcePath, "manifest.json");
              evidenceBytes = await readFile(join(repo.repoRoot, "manifest.json"));
            } else if (mutation === "bad-metadata") {
              evidencePath = join(sourcePath, "acceptance-build.json");
              const metadata = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
              metadata.unexpectedBindingProof = "forged";
              evidenceBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
            } else {
              evidencePath = join(sourcePath, "main.js");
              evidenceBytes = Buffer.concat([
                await readFile(evidencePath),
                Buffer.from("\nfetch(\n", "utf8"),
              ]);
            }
            await writeFile(evidencePath, evidenceBytes);
          }, "artifact-invalid");

          expect(await readFile(evidencePath)).toEqual(evidenceBytes);
          await assertNoSuccessfulReceipt(repo);
          await expectAbsent(repo.targetPath);
          await expectAbsent(repo.artifactLockPath);
        }
      },
    },
    {
      label: "valid-looking same-version stylesheet drift",
      run: async () => {
        const repo = await clonePreparedRepository();
        const stylesPath = join(repo.sourcePath, "styles.css");
        let driftBytes = Buffer.alloc(0);

        await expectInstallFailure(repo, "afterBuild", async () => {
          driftBytes = Buffer.from("/* stale same-version acceptance stylesheet */\n", "utf8");
          await writeFile(stylesPath, driftBytes);
        }, "artifact-invalid");

        expect(await readFile(stylesPath)).toEqual(driftBytes);
        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.targetPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
  ])('rejects $label and retains the changed source evidence', async ({ run }) => {
    await run();
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer post-build reserved builder residue", () => {
  it.each([
    { prefix: ".read-only-acceptance.tmp-", shape: "directory" },
    { prefix: ".read-only-acceptance.backup-", shape: "file" },
    { prefix: ".read-only-acceptance.quarantine-", shape: "symlink" },
  ] as const)('rejects and preserves a $shape sibling with reserved prefix $prefix', async ({ prefix, shape }) => {
    const repo = await clonePreparedRepository();
    const residuePath = join(repo.repoRoot, "dist", `${prefix}retained-evidence`);
    const directorySentinel = join(residuePath, "sentinel.txt");
    let identity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

    await expectInstallFailure(repo, "afterBuild", async () => {
      if (shape === "directory") {
        await mkdir(residuePath);
        await writeFile(directorySentinel, "BUILDER-STAGE-RESIDUE\n", "utf8");
      } else if (shape === "file") {
        await writeFile(residuePath, "BUILDER-BACKUP-RESIDUE\n", "utf8");
      } else {
        await symlink("missing-builder-quarantine-target", residuePath);
      }
      const stat = await lstat(residuePath, { bigint: true });
      identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
    }, "concurrent-operation");

    if (identity === null) throw new Error("reserved builder residue identity was not captured");
    await assertIdentity(residuePath, identity);
    if (shape === "directory") {
      await expect(readFile(directorySentinel, "utf8")).resolves.toBe("BUILDER-STAGE-RESIDUE\n");
    } else if (shape === "file") {
      await expect(readFile(residuePath, "utf8")).resolves.toBe("BUILDER-BACKUP-RESIDUE\n");
    } else {
      await expect(readlink(residuePath)).resolves.toBe("missing-builder-quarantine-target");
    }
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.targetPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer foreign-failure and fixture-identity regressions", () => {
  it("ignores a foreign AggregateError cleanup category when both fixed locks cleanly unwind", async () => {
    const repo = await clonePreparedRepository();
    const aggregate = new AggregateError([
      Object.assign(new Error("foreign nested cleanup spoof"), { category: "cleanup-incomplete" }),
      Object.assign(new Error("foreign nested rollback spoof"), { category: "rollback-incomplete" }),
    ], "foreign aggregate hook failure");
    Object.defineProperty(aggregate, "category", {
      configurable: true,
      enumerable: true,
      value: "cleanup-incomplete",
      writable: true,
    });

    await expectInstallFailure(repo, "afterBuild", () => { throw aggregate; }, "artifact-invalid");

    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.targetPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("detects a fixed synthetic note replaced by a same-bytes new inode after the destination lock", async () => {
    const repo = await clonePreparedRepository();
    const notePath = join(repo.vaultPath, FIXED_NOTE);
    const originalBytes = await readFile(notePath);
    let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

    await expectInstallFailure(repo, "afterDestinationLock", async () => {
      replacementIdentity = (await replaceRegularFileWithBytes(notePath, originalBytes)).after;
    }, "fixture-changed");

    if (replacementIdentity === null) throw new Error("synthetic note replacement identity was not captured");
    await assertIdentity(notePath, replacementIdentity);
    expect(await readFile(notePath)).toEqual(originalBytes);
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.targetPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("detects a fixed synthetic note changed and restored on the same inode after the destination lock", async () => {
    const repo = await clonePreparedRepository();
    const notePath = join(repo.vaultPath, FIXED_NOTE);
    const originalBytes = await readFile(notePath);
    const originalStat = await lstat(notePath, { bigint: true });

    await expectInstallFailure(repo, "afterDestinationLock", async () => {
      const mutated = Buffer.from(originalBytes);
      mutated[0] = (mutated[0] ?? 0) ^ 0xff;
      await writeFile(notePath, mutated);
      await writeFile(notePath, originalBytes);
      const restored = await lstat(notePath, { bigint: true });
      expect({ dev: restored.dev, ino: restored.ino, size: restored.size }).toEqual({
        dev: originalStat.dev,
        ino: originalStat.ino,
        size: originalStat.size,
      });
      expect(await readFile(notePath)).toEqual(originalBytes);
    }, "fixture-changed");

    const retained = await lstat(notePath, { bigint: true });
    expect({ dev: retained.dev, ino: retained.ino, size: retained.size }).toEqual({
      dev: originalStat.dev,
      ino: originalStat.ino,
      size: originalStat.size,
    });
    expect(await readFile(notePath)).toEqual(originalBytes);
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.targetPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it("detects an ignored dev-root sibling injected after the final readdir result", async () => {
    const repo = await clonePreparedRepository();
    const injectedPath = join(repo.devRoot, "late-ignored-sibling");

    await expectInstallFailure(repo, "afterReceiptPublish", () => {
      immediateDirectoryRace.active = true;
      immediateDirectoryRace.path = repo.devRoot;
      immediateDirectoryRace.injectedPath = injectedPath;
      immediateDirectoryRace.injected = false;
    }, "fixture-changed");

    expect(immediateDirectoryRace.injected).toBe(true);
    await expect(readFile(injectedPath, "utf8"))
      .resolves.toBe("LATE-IGNORED-SIBLING-EVIDENCE\n");
    await expectAbsent(repo.targetPath);
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer final canonical and mutation-class safety matrix", () => {
  it("rejects fixed-vault and fixed configuration-directory symlinks before any decoy content access", async () => {
    for (const boundary of ["vault", "obsidian"] as const) {
      const repo = await clonePreparedRepository();
      const container = dirname(repo.repoRoot);
      const decoyRoot = join(container, `external-${boundary}-decoy`);
      const retainedOriginal = join(container, `retained-original-${boundary}`);
      const sentinelPath = join(decoyRoot, "DO-NOT-READ.txt");
      const sentinelBytes = Buffer.from(`EXTERNAL-${boundary.toUpperCase()}-SENTINEL\n`, "utf8");
      await mkdir(decoyRoot, { mode: 0o700 });
      await writeFile(sentinelPath, sentinelBytes, { flag: "wx" });
      const sentinelBefore = await lstat(sentinelPath, { bigint: true });
      const alias = boundary === "vault"
        ? repo.vaultPath
        : join(repo.vaultPath, CONFIG_DIRECTORY);
      await rename(alias, retainedOriginal);
      await symlink(decoyRoot, alias);

      externalAccessProbe.active = true;
      externalAccessProbe.aliases = [alias];
      externalAccessProbe.decoyRoot = decoyRoot;
      externalAccessProbe.forbiddenEvents = [];
      externalAccessProbe.allowedSymlinkLstats = [];
      try {
        await expect(installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }))
          .rejects.toMatchObject({ category: "fixture-invalid" });
      } finally {
        externalAccessProbe.active = false;
      }

      expect(externalAccessProbe.forbiddenEvents).toEqual([]);
      const aliasStat = await lstat(alias, { bigint: true });
      expect(aliasStat.isSymbolicLink()).toBe(true);
      await expect(lstat(retainedOriginal)).resolves.toMatchObject({});
      expect(await readFile(sentinelPath)).toEqual(sentinelBytes);
      const sentinelAfter = await lstat(sentinelPath, { bigint: true });
      expect({ dev: sentinelAfter.dev, ino: sentinelAfter.ino, size: sentinelAfter.size }).toEqual({
        dev: sentinelBefore.dev,
        ino: sentinelBefore.ino,
        size: sentinelBefore.size,
      });
      await assertNoSuccessfulReceipt(repo);
      await expectAbsent(repo.targetPath);
      await expectAbsent(repo.destinationLockPath);
      await expectAbsent(repo.artifactLockPath);
    }
  }, HEAVY_TIMEOUT_MS);

  it("detects plugins-parent replacement and an after-seed ignored dev-root sibling while retaining external evidence", async () => {
    const parentRepo = await clonePreparedRepository();
    const retainedParent = join(
      dirname(parentRepo.pluginsParentPath),
      "plugins.retained-evidence",
    );
    let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
    let retainedIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
    await expectInstallFailure(parentRepo, "afterBuild", async () => {
      const original = await lstat(parentRepo.pluginsParentPath, { bigint: true });
      retainedIdentity = Object.freeze({ dev: original.dev, ino: original.ino });
      await rename(parentRepo.pluginsParentPath, retainedParent);
      await mkdir(parentRepo.pluginsParentPath);
      const replacement = await lstat(parentRepo.pluginsParentPath, { bigint: true });
      replacementIdentity = Object.freeze({ dev: replacement.dev, ino: replacement.ino });
    }, "fixture-changed");
    if (replacementIdentity === null || retainedIdentity === null) {
      throw new Error("plugins-parent replacement evidence was not captured");
    }
    await assertIdentity(parentRepo.pluginsParentPath, replacementIdentity);
    await assertIdentity(retainedParent, retainedIdentity);
    await expect(readdir(parentRepo.pluginsParentPath)).resolves.toEqual([]);
    await expect(readdir(retainedParent)).resolves.toEqual([]);
    await assertNoSuccessfulReceipt(parentRepo);
    await expectAbsent(parentRepo.targetPath);
    await expectAbsent(parentRepo.destinationLockPath);
    await expectAbsent(parentRepo.artifactLockPath);

    const devRepo = await clonePreparedRepository();
    const ignoredEvidence = join(devRepo.devRoot, "after-seed-ignored-evidence.txt");
    await expectInstallFailure(devRepo, "afterSeed", async () => {
      await writeFile(ignoredEvidence, "AFTER-SEED-IGNORED-EVIDENCE\n", { flag: "wx" });
    }, "fixture-changed");
    await expect(readFile(ignoredEvidence, "utf8"))
      .resolves.toBe("AFTER-SEED-IGNORED-EVIDENCE\n");
    await assertNoSuccessfulReceipt(devRepo);
    await expectAbsent(devRepo.targetPath);
    await expectAbsent(devRepo.destinationLockPath);
    await expectAbsent(devRepo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);

  it("rejects wrong acceptance metadata values and artifact bindings while retaining source evidence", async () => {
    for (const mode of ["wrong-value", "wrong-binding"] as const) {
      const repo = await clonePreparedRepository();
      const metadataPath = join(repo.sourcePath, "acceptance-build.json");
      let changedBytes = Buffer.alloc(0);

      await expectInstallFailure(repo, "afterBuild", async () => {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
        if (mode === "wrong-value") metadata.network = "allowed";
        else metadata.artifactBinding = "knowledge-workbench@0.1.0:normal";
        changedBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        await writeFile(metadataPath, changedBytes);
      }, "artifact-invalid");

      expect(await readFile(metadataPath)).toEqual(changedBytes);
      await assertNoSuccessfulReceipt(repo);
      await expectAbsent(repo.targetPath);
      await expectAbsent(repo.destinationLockPath);
      await expectAbsent(repo.artifactLockPath);
    }
  }, HEAVY_TIMEOUT_MS);

  it.each([
    {
      mutation: "FIFO added to an empty target stage",
      run: async () => {
        const repo = await clonePreparedRepository();
        let stagePath = "";
        let fifoPath = "";
        await expectInstallFailure(repo, "afterStageCreated", async ({ stagePath: currentStage }) => {
          if (currentStage === null) throw new Error("stage path missing");
          stagePath = currentStage;
          fifoPath = join(stagePath, "unknown.fifo");
          execFileSync("mkfifo", [fifoPath]);
          const fifo = await lstat(fifoPath, { bigint: true });
          expect(fifo.isFIFO()).toBe(true);
        }, "cleanup-incomplete");
        const retainedFifo = await lstat(fifoPath, { bigint: true });
        expect(retainedFifo.isFIFO()).toBe(true);
        await expect(lstat(stagePath)).resolves.toMatchObject({});
        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.targetPath);
        await expectAbsent(repo.destinationLockPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
    {
      mutation: "seed data replaced by a symbolic link",
      run: async () => {
        const repo = await clonePreparedRepository();
        await expectInstallFailure(repo, "afterSeed", async () => {
          await unlink(repo.seedPath);
          await symlink("main.js", repo.seedPath);
        }, "rollback-incomplete");
        await expect(readlink(repo.seedPath)).resolves.toBe("main.js");
        await expect(lstat(repo.targetPath)).resolves.toMatchObject({});
        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.destinationLockPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
    {
      mutation: "receipt stage changed into a hard link",
      run: async () => {
        const repo = await clonePreparedRepository();
        let receiptStagePath = "";
        let retainedLink = "";
        await expectInstallFailure(repo, "beforeReceiptPublish", async ({ receiptStagePath: currentStage }) => {
          if (currentStage === null) throw new Error("receipt stage path missing");
          receiptStagePath = currentStage;
          retainedLink = `${currentStage}.retained-hard-link`;
          await link(currentStage, retainedLink);
          const linked = await lstat(currentStage, { bigint: true });
          expect(linked.nlink).toBe(2n);
        }, "rollback-incomplete");
        const [stage, retained] = await Promise.all([
          lstat(receiptStagePath, { bigint: true }),
          lstat(retainedLink, { bigint: true }),
        ]);
        expect({ dev: retained.dev, ino: retained.ino, nlink: retained.nlink }).toEqual({
          dev: stage.dev,
          ino: stage.ino,
          nlink: 2n,
        });
        await expect(lstat(repo.targetPath)).resolves.toMatchObject({});
        await assertNoSuccessfulReceipt(repo);
        await expectAbsent(repo.destinationLockPath);
        await expectAbsent(repo.artifactLockPath);
      },
    },
  ])('retains unknown evidence for $mutation', async ({ run }) => {
    await run();
  }, HEAVY_TIMEOUT_MS);
});

describe("acceptance installer hook faults", () => {
  it.each(HOOKS)("normalizes an untrusted %s error and safely unwinds every exact owned object", async (hook) => {
    const repo = await clonePreparedRepository();
    const stateBefore = await readFile(repo.statePath);
    const spoofed = Object.assign(new Error(`fault:${hook}`), { category: "rollback-incomplete" });

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: hookRecord(hook, () => { throw spoofed; }),
    })).rejects.toMatchObject({ category: "artifact-invalid" });

    expect(await readFile(repo.statePath)).toEqual(stateBefore);
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);
});

describe("identity-safe installer rollback", () => {
  it("retains a target stage whose mode changes from 0700 to 0755 and reports cleanup-incomplete", async () => {
    const repo = await clonePreparedRepository();
    let stagePath = "";
    let stageIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

    await expectInstallFailure(repo, "afterStageCreated", async ({ stagePath: currentStage }) => {
      if (currentStage === null) throw new Error("stage path missing from afterStageCreated");
      stagePath = currentStage;
      const before = await lstat(stagePath, { bigint: true });
      stageIdentity = Object.freeze({ dev: before.dev, ino: before.ino });
      expect(before.mode & 0o777n).toBe(0o700n);
      await chmod(stagePath, 0o755);
      const after = await lstat(stagePath, { bigint: true });
      expect(after.mode & 0o777n).toBe(0o755n);
    }, "cleanup-incomplete");

    if (stageIdentity === null) throw new Error("stage identity was not captured");
    await assertIdentity(stagePath, stageIdentity);
    const retained = await lstat(stagePath, { bigint: true });
    expect(retained.mode & 0o777n).toBe(0o755n);
    await expect(readdir(stagePath)).resolves.toEqual([]);
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.targetPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it.each([
    { shape: "missing" },
    { shape: "replacement" },
    { shape: "symlink" },
    { shape: "unknown-entry" },
  ] as const)('reports cleanup-incomplete for a $shape pre-target stage without deleting unknown evidence', async ({ shape }) => {
    const repo = await clonePreparedRepository();
    let stagePath = "";
    let retainedPath = "";
    let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterStageCreated: async ({ stagePath: currentStage }) => {
          if (currentStage === null) throw new Error("stage path missing from afterStageCreated");
          stagePath = currentStage;
          if (shape === "missing") {
            await rmdir(stagePath);
          } else if (shape === "replacement") {
            retainedPath = `${stagePath}.retained-evidence`;
            await rename(stagePath, retainedPath);
            await mkdir(stagePath);
            const replacement = await lstat(stagePath, { bigint: true });
            replacementIdentity = Object.freeze({ dev: replacement.dev, ino: replacement.ino });
          } else if (shape === "symlink") {
            await rmdir(stagePath);
            await symlink("missing-stage-target", stagePath);
          } else {
            await writeFile(join(stagePath, "unknown.txt"), "UNTRUSTED-STAGE-ENTRY\n", "utf8");
          }
        },
      },
    })).rejects.toMatchObject({ category: "cleanup-incomplete" });

    if (shape === "missing") await expectAbsent(stagePath);
    if (shape === "replacement") {
      if (replacementIdentity === null) throw new Error("stage replacement identity was not captured");
      await assertIdentity(stagePath, replacementIdentity);
      await expect(lstat(retainedPath)).resolves.toMatchObject({});
    }
    if (shape === "symlink") {
      await expect(readlink(stagePath)).resolves.toBe("missing-stage-target");
    }
    if (shape === "unknown-entry") {
      await expect(readFile(join(stagePath, "unknown.txt"), "utf8"))
        .resolves.toBe("UNTRUSTED-STAGE-ENTRY\n");
    }
    await expectAbsent(repo.targetPath);
    await assertNoSuccessfulReceipt(repo);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);

  it.each([
    {
      surface: "published target",
      run: async () => {
        for (const mutation of ["missing", "replacement"] as const) {
          const repo = await clonePreparedRepository();
          const retainedTarget = `${repo.targetPath}.retained-evidence`;
          let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;

          await expectInstallFailure(repo, "afterSeed", async () => {
            if (mutation === "missing") {
              await rm(repo.targetPath, { recursive: true });
            } else {
              await rename(repo.targetPath, retainedTarget);
              await cp(retainedTarget, repo.targetPath, { recursive: true });
              const replacement = await lstat(repo.targetPath, { bigint: true });
              replacementIdentity = Object.freeze({ dev: replacement.dev, ino: replacement.ino });
            }
          }, "rollback-incomplete");

          await assertNoSuccessfulReceipt(repo);
          if (mutation === "missing") {
            await expectAbsent(repo.targetPath);
          } else {
            if (replacementIdentity === null) throw new Error("target replacement identity was not captured");
            await assertIdentity(repo.targetPath, replacementIdentity);
            await expect(lstat(retainedTarget)).resolves.toMatchObject({});
            await expect(readFile(repo.seedPath)).resolves.toEqual(syntheticData.encodeSyntheticPluginDataSeed());
          }
          await expectAbsent(repo.destinationLockPath);
          await expectAbsent(repo.artifactLockPath);
        }
      },
    },
    {
      surface: "receipt stage",
      run: async () => {
        for (const mutation of ["missing", "replacement"] as const) {
          const repo = await clonePreparedRepository();
          let stagePath = "";
          let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
          let targetIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
          let receiptBytes = Buffer.alloc(0);

          await expectInstallFailure(repo, "beforeReceiptPublish", async ({ receiptStagePath }) => {
            if (receiptStagePath === null) throw new Error("receipt stage path missing");
            stagePath = receiptStagePath;
            receiptBytes = await readFile(stagePath);
            const target = await lstat(repo.targetPath, { bigint: true });
            targetIdentity = Object.freeze({ dev: target.dev, ino: target.ino });
            if (mutation === "missing") {
              await unlink(stagePath);
            } else {
              replacementIdentity = (await replaceRegularFileWithBytes(stagePath, receiptBytes)).after;
            }
          }, "rollback-incomplete");

          if (targetIdentity === null) throw new Error("target identity was not captured");
          await assertIdentity(repo.targetPath, targetIdentity);
          await expect(readFile(repo.seedPath)).resolves.toEqual(syntheticData.encodeSyntheticPluginDataSeed());
          await expectAbsent(repo.receiptPath);
          if (mutation === "missing") {
            await expectAbsent(stagePath);
          } else {
            if (replacementIdentity === null) throw new Error("receipt-stage replacement was not captured");
            await assertIdentity(stagePath, replacementIdentity);
            expect(await readFile(stagePath)).toEqual(receiptBytes);
          }
          await expectAbsent(repo.destinationLockPath);
          await expectAbsent(repo.artifactLockPath);
        }
      },
    },
    {
      surface: "published receipt",
      run: async () => {
        for (const mutation of ["missing", "replacement"] as const) {
          const repo = await clonePreparedRepository();
          let replacementIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
          let targetIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
          let receiptBytes = Buffer.alloc(0);

          await expectInstallFailure(repo, "afterReceiptPublish", async () => {
            receiptBytes = await readFile(repo.receiptPath);
            const target = await lstat(repo.targetPath, { bigint: true });
            targetIdentity = Object.freeze({ dev: target.dev, ino: target.ino });
            if (mutation === "missing") {
              await unlink(repo.receiptPath);
            } else {
              replacementIdentity = (await replaceRegularFileWithBytes(
                repo.receiptPath,
                receiptBytes,
              )).after;
            }
          }, "rollback-incomplete");

          if (targetIdentity === null) throw new Error("target identity was not captured");
          await assertIdentity(repo.targetPath, targetIdentity);
          await expect(readFile(repo.seedPath)).resolves.toEqual(syntheticData.encodeSyntheticPluginDataSeed());
          if (mutation === "missing") {
            await expectAbsent(repo.receiptPath);
          } else {
            if (replacementIdentity === null) throw new Error("receipt replacement identity was not captured");
            await assertIdentity(repo.receiptPath, replacementIdentity);
            expect(await readFile(repo.receiptPath)).toEqual(receiptBytes);
            runContract.decodeInstallationReceipt(receiptBytes);
          }
          await expectAbsent(repo.destinationLockPath);
          await expectAbsent(repo.artifactLockPath);
        }
      },
    },
  ])('retains jointly validated evidence when the $surface is missing or replaced', async ({ run }) => {
    await run();
  }, HEAVY_TIMEOUT_MS);

  it("deletes a staged receipt before the exact target when beforeReceiptPublish fails cleanly", async () => {
    const repo = await clonePreparedRepository();
    let receiptStagePath = "";
    removalProbe.active = true;
    removalProbe.repoRoot = repo.repoRoot;

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        beforeReceiptPublish: ({ receiptStagePath: currentStage }) => {
          if (currentStage === null) throw new Error("receipt stage path missing");
          receiptStagePath = currentStage;
          throw new Error("clean-before-receipt-fault");
        },
      },
    })).rejects.toMatchObject({ category: "artifact-invalid" });
    removalProbe.active = false;

    const receiptRemoval = removalProbe.events.indexOf(receiptStagePath);
    const targetRemoval = removalProbe.events.findIndex((path) => (
      path === repo.targetPath || path.startsWith(`${repo.targetPath}${sep}`)
    ));
    expect(receiptRemoval).toBeGreaterThanOrEqual(0);
    expect(targetRemoval).toBeGreaterThan(receiptRemoval);
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
  }, HEAVY_TIMEOUT_MS);

  it("retains both receipt stage and target when their joint rollback prevalidation sees target tampering", async () => {
    const repo = await clonePreparedRepository();
    let receiptStagePath = "";
    const unknownPath = join(repo.targetPath, "unknown.txt");

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        beforeReceiptPublish: async ({ receiptStagePath: currentStage }) => {
          if (currentStage === null) throw new Error("receipt stage path missing");
          receiptStagePath = currentStage;
          await writeFile(unknownPath, "TAMPERED-TARGET\n", "utf8");
          throw new Error("tampered-before-receipt-fault");
        },
      },
    })).rejects.toMatchObject({ category: "rollback-incomplete" });

    await expect(lstat(receiptStagePath)).resolves.toMatchObject({});
    await expect(readFile(unknownPath, "utf8")).resolves.toBe("TAMPERED-TARGET\n");
    await expectAbsent(repo.receiptPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);

  it("retains an unproved receipt stage and target when exclusive creation fails after the path appears", async () => {
    const repo = await clonePreparedRepository();
    receiptCreationProbe.failAfterCreate = true;

    await expect(installer.installAcceptanceDevelopment({ repoRoot: repo.repoRoot }))
      .rejects.toMatchObject({ category: "rollback-incomplete" });

    expect(receiptCreationProbe.path).toContain(RECEIPT_STAGE_PREFIX);
    await expect(readFile(receiptCreationProbe.path)).resolves.toEqual(Buffer.alloc(0));
    expect((await readdir(repo.targetPath)).sort()).toEqual([
      "acceptance-build.json",
      "data.json",
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    await expectAbsent(repo.receiptPath);
    await expectAbsent(repo.destinationLockPath);
    await expectAbsent(repo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);

  it("keeps rollback-incomplete dominant when a changed destination lock blocks target deletion", async () => {
    const repo = await clonePreparedRepository();
    let replacement = Buffer.alloc(0);

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterTargetPublished: async ({ destinationLockPath }) => {
          if (destinationLockPath === null) throw new Error("destination lock path missing");
          replacement = await readFile(destinationLockPath);
          replacement[0] = (replacement[0] ?? 0) ^ 0xff;
          await writeFile(destinationLockPath, replacement);
        },
      },
    })).rejects.toMatchObject({ category: "rollback-incomplete" });

    expect(await readFile(repo.destinationLockPath)).toEqual(replacement);
    expect((await readdir(repo.targetPath)).sort()).toEqual([
      "acceptance-build.json",
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    await expectAbsent(repo.receiptPath);
    await expectAbsent(repo.artifactLockPath);
  }, HEAVY_TIMEOUT_MS);

  it("deletes a published receipt before the exact target after an afterReceiptPublish fault", async () => {
    const repo = await clonePreparedRepository();
    removalProbe.active = true;
    removalProbe.repoRoot = repo.repoRoot;

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterReceiptPublish: () => { throw new Error("clean-post-receipt-fault"); },
      },
    })).rejects.toMatchObject({ category: "artifact-invalid" });
    removalProbe.active = false;

    const receiptRemoval = removalProbe.events.indexOf(repo.receiptPath);
    const targetRemoval = removalProbe.events.findIndex((path) => (
      path === repo.targetPath || path.startsWith(`${repo.targetPath}${sep}`)
    ));
    expect(receiptRemoval).toBeGreaterThanOrEqual(0);
    expect(targetRemoval).toBeGreaterThan(receiptRemoval);
    await assertNoInstallerResidue(repo, { target: false, receipt: false });
  }, HEAVY_TIMEOUT_MS);

  it("retains a published receipt and target when target tampering makes joint rollback unsafe", async () => {
    const repo = await clonePreparedRepository();
    const unknownPath = join(repo.targetPath, "unknown.txt");
    let receiptBefore = Buffer.alloc(0);
    removalProbe.active = true;
    removalProbe.repoRoot = repo.repoRoot;

    await expect(installer.installAcceptanceDevelopment({
      repoRoot: repo.repoRoot,
      hooks: {
        afterReceiptPublish: async () => {
          receiptBefore = await readFile(repo.receiptPath);
          await writeFile(unknownPath, "TAMPERED-PUBLISHED-TARGET\n", "utf8");
          throw Object.assign(new Error("tampered-post-receipt-fault"), {
            category: "cleanup-incomplete",
          });
        },
      },
    })).rejects.toMatchObject({ category: "rollback-incomplete" });
    removalProbe.active = false;

    expect(await readFile(repo.receiptPath)).toEqual(receiptBefore);
    await expect(readFile(unknownPath, "utf8")).resolves.toBe("TAMPERED-PUBLISHED-TARGET\n");
    expect(removalProbe.events).not.toContain(repo.receiptPath);
    expect(removalProbe.events.some((path) => (
      path === repo.targetPath || path.startsWith(`${repo.targetPath}${sep}`)
    ))).toBe(false);
    runContract.decodeInstallationReceipt(receiptBefore);
    await assertNoInstallerResidue(repo, { target: true, receipt: true });
    await assertPreparedEvidence(repo);
  }, HEAVY_TIMEOUT_MS);
});
