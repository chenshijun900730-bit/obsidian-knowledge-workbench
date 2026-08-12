import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const gitRace = vi.hoisted(() => ({
  firstHeadSeen: 0,
  afterFirstHead: null as null | (() => Promise<void> | void),
  calls: [] as Array<Readonly<{
    file: unknown;
    args: unknown;
    options: unknown;
    argumentCount: number;
    hasCallback: boolean;
  }>>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...rawArguments: unknown[]) => {
      const callback = rawArguments.at(-1);
      const hasCallback = typeof callback === "function";
      const callArguments = hasCallback ? rawArguments.slice(0, -1) : rawArguments;
      const file = callArguments[0];
      const args = callArguments[1];
      const options = callArguments[2];
      gitRace.calls.push(Object.freeze({
        file,
        args: Array.isArray(args)
          ? Object.freeze(Array.from(args, (value: unknown): unknown => value))
          : args,
        options: (
          typeof options === "object"
          && options !== null
          && !Array.isArray(options)
        ) ? Object.freeze({ ...options }) : options,
        argumentCount: rawArguments.length,
        hasCallback,
      }));
      if (typeof callback !== "function") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Vitest must preserve Node's overloaded execFile return.
        return Reflect.apply(actual.execFile, actual, rawArguments);
      }
      const wrappedCallback = (error: unknown, stdout: unknown, stderr: unknown): void => {
        const isHead = file === "/usr/bin/git"
          && Array.isArray(args)
          && args[0] === "rev-parse"
          && args[1] === "HEAD";
        if (!isHead) {
          Reflect.apply(callback, undefined, [error, stdout, stderr]);
          return;
        }
        gitRace.firstHeadSeen += 1;
        if (gitRace.firstHeadSeen !== 1 || gitRace.afterFirstHead === null) {
          Reflect.apply(callback, undefined, [error, stdout, stderr]);
          return;
        }
        const action = gitRace.afterFirstHead;
        gitRace.afterFirstHead = null;
        void Promise.resolve()
          .then(action)
          .then(
            () => { Reflect.apply(callback, undefined, [error, stdout, stderr]); },
            (raceError) => { Reflect.apply(callback, undefined, [raceError, stdout, stderr]); },
          );
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Vitest must preserve Node's overloaded execFile return.
      return Reflect.apply(actual.execFile, actual, [...callArguments, wrappedCallback]);
    },
  };
});

// @ts-expect-error The production helper is intentionally plain ESM without a declaration file.
import * as gitStateModule from "../../scripts/git-worktree-state.mjs";
// @ts-expect-error The production contract is intentionally plain ESM without a declaration file.
import * as runContractModule from "../../scripts/acceptance-run-contract.mjs";

interface GitStateModule {
  captureCleanGitState(repoRoot: string): Promise<Readonly<{ commit: string }>>;
  assertCleanGitState(repoRoot: string, expectedCommit: string): Promise<void>;
  captureTrackedGitState(repoRoot: string): Promise<Readonly<{ commit: string }>>;
  assertTrackedGitState(repoRoot: string, expectedCommit: string): Promise<void>;
  assertTrackedBuildInputs(repoRoot: string, paths: readonly string[]): Promise<void>;
}

interface PreparationState {
  readonly schemaVersion: 1;
  readonly scope: "dedicated-synthetic-vault";
  readonly contentPolicy: "deterministic-synthetic-notes-only";
  readonly runId: string;
  readonly commit: string;
  readonly syntheticNoteCount: 5000;
  readonly syntheticTotalBytes: 78643200;
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

interface RunContractModule {
  readonly PREPARATION_STATE_RELATIVE_PATH: string;
  readonly INSTALLATION_RECEIPT_RELATIVE_PATH: string;
  readonly ACCEPTANCE_REPORT_RELATIVE_PATH: string;
  readonly SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH: string;
  createPreparationState(input: Readonly<{
    runId: string;
    commit: string;
    attestation: Readonly<{
      syntheticNoteCount: number;
      syntheticTotalBytes: number;
      corpusDigest: string;
      tree: Readonly<Record<string, unknown>>;
    }>;
  }>): PreparationState;
  encodePreparationState(state: PreparationState): Buffer;
  decodePreparationState(bytes: Uint8Array): PreparationState;
  createInstallationReceipt(input: Readonly<{
    state: PreparationState;
    stateBytes: Buffer;
    pluginVersion: string;
    artifactBinding: string;
    artifactSetDigest: string;
    seedBytes: Buffer;
  }>): InstallationReceipt;
  encodeInstallationReceipt(receipt: InstallationReceipt): Buffer;
  decodeInstallationReceipt(bytes: Uint8Array): InstallationReceipt;
}

const gitState = gitStateModule as unknown as GitStateModule;
const contract = runContractModule as unknown as RunContractModule;
const temporaryPaths: string[] = [];
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_RUN_ID = "123e4567-e89b-42d3-b456-426614174001";
const COMMIT = "a".repeat(40);
const CORPUS_DIGEST = `sha256:${"c".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"d".repeat(64)}`;
const PLUGIN_VERSION = "0.1.0";
const ARTIFACT_BINDING = `knowledge-workbench@${PLUGIN_VERSION}:read-only-acceptance`;
const FIXED_GIT_ENVIRONMENT = Object.freeze({
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});

function runGit(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository(objectFormat: "sha1" | "sha256" = "sha1"): Promise<Readonly<{
  root: string;
  commit: string;
}>> {
  const createdRoot = await mkdtemp(join(tmpdir(), "kwb-run-contract-"));
  const root = await realpath(createdRoot);
  temporaryPaths.push(root);
  const initArguments = objectFormat === "sha256"
    ? ["init", "--quiet", "--object-format=sha256"]
    : ["init", "--quiet"];
  runGit(root, initArguments);
  runGit(root, ["config", "user.email", "acceptance@example.invalid"]);
  runGit(root, ["config", "user.name", "Acceptance Test"]);
  await writeFile(join(root, ".gitignore"), ".dev-vault/\n", "utf8");
  await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
  runGit(root, ["add", ".gitignore", "tracked.txt"]);
  runGit(root, ["commit", "--quiet", "-m", "initial"]);
  return Object.freeze({ root, commit: runGit(root, ["rev-parse", "HEAD"]) });
}

function validAttestation(): Readonly<{
  syntheticNoteCount: number;
  syntheticTotalBytes: number;
  corpusDigest: string;
  tree: Readonly<Record<string, unknown>>;
}> {
  return Object.freeze({
    syntheticNoteCount: 5_000,
    syntheticTotalBytes: 75 * 1024 * 1024,
    corpusDigest: CORPUS_DIGEST,
    tree: Object.freeze({}),
  });
}

function createState(runId = RUN_ID, commit = COMMIT): PreparationState {
  return contract.createPreparationState({ runId, commit, attestation: validAttestation() });
}

function createReceipt(state = createState(), seedBytes = Buffer.from("seed\n")): InstallationReceipt {
  return contract.createInstallationReceipt({
    state,
    stateBytes: contract.encodePreparationState(state),
    pluginVersion: PLUGIN_VERSION,
    artifactBinding: ARTIFACT_BINDING,
    artifactSetDigest: ARTIFACT_DIGEST,
    seedBytes,
  });
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function withChangedKeyOrder<T extends object>(value: T): T {
  const entries = Object.entries(value);
  return Object.fromEntries([entries.at(-1)!, ...entries.slice(0, -1)]) as T;
}

afterEach(async () => {
  gitRace.firstHeadSeen = 0;
  gitRace.afterFirstHead = null;
  gitRace.calls.length = 0;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("clean Git worktree state", () => {
  it("uses the exact shell-free Git command sequence and bounded options", async () => {
    const repo = await createRepository();

    await expect(gitState.captureCleanGitState(repo.root)).resolves.toEqual({ commit: repo.commit });

    expect(gitRace.calls).toEqual([
      {
        file: "/usr/bin/git",
        args: ["rev-parse", "--show-toplevel"],
        argumentCount: 4,
        hasCallback: true,
        options: {
          cwd: repo.root,
          encoding: "buffer",
          env: FIXED_GIT_ENVIRONMENT,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
        },
      },
      {
        file: "/usr/bin/git",
        args: ["rev-parse", "HEAD"],
        argumentCount: 4,
        hasCallback: true,
        options: {
          cwd: repo.root,
          encoding: "buffer",
          env: FIXED_GIT_ENVIRONMENT,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
        },
      },
      {
        file: "/usr/bin/git",
        args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        argumentCount: 4,
        hasCallback: true,
        options: {
          cwd: repo.root,
          encoding: "buffer",
          env: FIXED_GIT_ENVIRONMENT,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
        },
      },
      {
        file: "/usr/bin/git",
        args: ["rev-parse", "HEAD"],
        argumentCount: 4,
        hasCallback: true,
        options: {
          cwd: repo.root,
          encoding: "buffer",
          env: FIXED_GIT_ENVIRONMENT,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
        },
      },
    ]);
  });

  it("ignores inherited Git repository and configuration overrides", async () => {
    const repo = await createRepository();
    const redirected = await createRepository();
    await writeFile(join(redirected.root, "tracked.txt"), "redirected\n", "utf8");
    runGit(redirected.root, ["add", "tracked.txt"]);
    runGit(redirected.root, ["commit", "--quiet", "-m", "redirected"]);
    const originalGitDir = process.env.GIT_DIR;
    const originalGitWorkTree = process.env.GIT_WORK_TREE;
    const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_DIR = join(redirected.root, ".git");
    process.env.GIT_WORK_TREE = repo.root;
    process.env.GIT_CONFIG_GLOBAL = join(redirected.root, "attacker.gitconfig");

    try {
      await expect(gitState.captureCleanGitState(repo.root))
        .resolves.toEqual({ commit: repo.commit });
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
      if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = originalGitWorkTree;
      if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    }
  });

  it.each(["sha1", "sha256"] as const)("captures and reasserts a clean %s commit", async (format) => {
    const repo = await createRepository(format);
    const captured = await gitState.captureCleanGitState(repo.root);

    expect(captured).toEqual({ commit: repo.commit });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(repo.commit).toMatch(format === "sha1" ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u);
    await expect(gitState.assertCleanGitState(repo.root, repo.commit)).resolves.toBeUndefined();
  });

  it("rejects staged, tracked, and non-ignored untracked changes", async () => {
    const repo = await createRepository();

    await writeFile(join(repo.root, "tracked.txt"), "staged\n", "utf8");
    runGit(repo.root, ["add", "tracked.txt"]);
    await expect(gitState.captureCleanGitState(repo.root)).rejects.toThrow(/clean|status|staged|worktree/iu);

    runGit(repo.root, ["reset", "--hard", "--quiet", "HEAD"]);
    await writeFile(join(repo.root, "tracked.txt"), "unstaged\n", "utf8");
    await expect(gitState.captureCleanGitState(repo.root)).rejects.toThrow(/clean|status|tracked|worktree/iu);

    runGit(repo.root, ["reset", "--hard", "--quiet", "HEAD"]);
    await writeFile(join(repo.root, "untracked.txt"), "untracked\n", "utf8");
    await expect(gitState.captureCleanGitState(repo.root)).rejects.toThrow(/clean|status|untracked|worktree/iu);
  });

  it("tolerates only content hidden by the repository ignore contract", async () => {
    const repo = await createRepository();
    await mkdir(join(repo.root, ".dev-vault"));
    await writeFile(join(repo.root, ".dev-vault", "local-state.json"), "{}\n", "utf8");

    await expect(gitState.captureCleanGitState(repo.root)).resolves.toEqual({ commit: repo.commit });
  });

  it("rejects a HEAD switch between the two revision reads", async () => {
    const repo = await createRepository();
    gitRace.afterFirstHead = () => {
      writeFileSyncForRace(join(repo.root, "tracked.txt"), "second commit\n");
      runGit(repo.root, ["add", "tracked.txt"]);
      runGit(repo.root, ["commit", "--quiet", "-m", "race"]);
    };

    await expect(gitState.captureCleanGitState(repo.root)).rejects.toThrow(/HEAD|commit|changed|race/iu);
    expect(gitRace.firstHeadSeen).toBeGreaterThanOrEqual(2);
  });

  it("rejects symlinked and lexically noncanonical repository roots", async () => {
    const repo = await createRepository();
    const linkRoot = join(dirname(repo.root), `${basename(repo.root)}-link`);
    temporaryPaths.push(linkRoot);
    await symlink(repo.root, linkRoot, "dir");
    const noncanonical = `${repo.root}/../${basename(repo.root)}`;

    await expect(gitState.captureCleanGitState(linkRoot)).rejects.toThrow(/canonical|symbolic|root|path/iu);
    await expect(gitState.captureCleanGitState(noncanonical)).rejects.toThrow(/canonical|root|path/iu);
    await expect(gitState.captureCleanGitState("relative/repo")).rejects.toThrow(/absolute|root|path/iu);
  });

  it("validates the supplied expected commit before reasserting", async () => {
    const repo = await createRepository();
    await expect(gitState.assertCleanGitState(repo.root, repo.commit.toUpperCase()))
      .rejects.toThrow(/commit|lowercase|object/iu);
    await expect(gitState.assertCleanGitState(repo.root, "a".repeat(39)))
      .rejects.toThrow(/commit|40|64|object/iu);
    await expect(gitState.assertCleanGitState(repo.root, "a".repeat(64)))
      .rejects.toThrow(/commit|HEAD|expected|match/iu);
  });

  it("allows unrelated untracked files while rejecting tracked drift", async () => {
    const repo = await createRepository();
    await writeFile(join(repo.root, "untracked.txt"), "untracked\n", "utf8");

    const captured = await gitState.captureTrackedGitState(repo.root);
    expect(captured).toEqual({ commit: repo.commit });
    await expect(gitState.assertTrackedGitState(repo.root, repo.commit)).resolves.toBeUndefined();

    await writeFile(join(repo.root, "tracked.txt"), "changed\n", "utf8");
    await expect(gitState.captureTrackedGitState(repo.root))
      .rejects.toThrow(/tracked|clean|worktree/iu);
  });

  it("requires every declared build input to be tracked exactly once", async () => {
    const repo = await createRepository();
    await writeFile(join(repo.root, "second-tracked.txt"), "second\n", "utf8");
    runGit(repo.root, ["add", "--", "second-tracked.txt"]);
    runGit(repo.root, ["commit", "--quiet", "-m", "add second tracked input"]);
    await writeFile(join(repo.root, "untracked.txt"), "untracked\n", "utf8");

    await expect(gitState.assertTrackedBuildInputs(
      repo.root,
      ["second-tracked.txt", "tracked.txt"],
    ))
      .resolves.toBeUndefined();
    await expect(gitState.assertTrackedBuildInputs(repo.root, ["untracked.txt"]))
      .rejects.toThrow(/tracked|input|resolution/iu);
    await expect(gitState.assertTrackedBuildInputs(repo.root, ["tracked.txt", "tracked.txt"]))
      .rejects.toThrow(/duplicate/iu);
    await expect(gitState.assertTrackedBuildInputs(repo.root, ["../tracked.txt"]))
      .rejects.toThrow(/relative|normalized|path/iu);
  });
});

describe("preparation state codec", () => {
  it("creates the exact frozen state and canonical final-newline bytes", () => {
    const state = createState();
    const expected = {
      schemaVersion: 1,
      scope: "dedicated-synthetic-vault",
      contentPolicy: "deterministic-synthetic-notes-only",
      runId: RUN_ID,
      commit: COMMIT,
      syntheticNoteCount: 5_000,
      syntheticTotalBytes: 78_643_200,
      corpusDigest: CORPUS_DIGEST,
    };

    expect(state).toEqual(expected);
    expect(Object.keys(state)).toEqual(Object.keys(expected));
    expect(Object.isFrozen(state)).toBe(true);
    expect(contract.encodePreparationState(state))
      .toEqual(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, "utf8"));
    expect(createState(RUN_ID, "b".repeat(64)).commit).toBe("b".repeat(64));
  });

  it("round-trips exact bytes and respects Uint8Array offsets", () => {
    const state = createState();
    const bytes = contract.encodePreparationState(state);
    const framed = Buffer.concat([Buffer.from([0xff]), bytes, Buffer.from([0xfe])]);
    const decoded = contract.decodePreparationState(framed.subarray(1, -1));

    expect(decoded).toEqual(state);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(contract.encodePreparationState(decoded)).toEqual(bytes);
  });

  it.each([
    ["uppercase UUID", RUN_ID.toUpperCase(), COMMIT, validAttestation()],
    ["nil UUID", "00000000-0000-0000-0000-000000000000", COMMIT, validAttestation()],
    ["non-v4 UUID", "123e4567-e89b-32d3-a456-426614174000", COMMIT, validAttestation()],
    ["bad UUID variant", "123e4567-e89b-42d3-7456-426614174000", COMMIT, validAttestation()],
    ["uppercase commit", RUN_ID, COMMIT.toUpperCase(), validAttestation()],
    ["short commit", RUN_ID, "a".repeat(39), validAttestation()],
    ["wrong count", RUN_ID, COMMIT, { ...validAttestation(), syntheticNoteCount: 4_999 }],
    ["unsafe bytes", RUN_ID, COMMIT, { ...validAttestation(), syntheticTotalBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ["bad corpus digest", RUN_ID, COMMIT, { ...validAttestation(), corpusDigest: "sha256:ABC" }],
  ])("rejects %s", (_label, runId, commit, attestation) => {
    expect(() => contract.createPreparationState({ runId, commit, attestation }))
      .toThrow(/state|run|UUID|commit|count|bytes|digest|corpus/iu);
  });

  it("rejects non-plain, extra-key, symbol-key, and reordered state objects", () => {
    const state = createState();
    const inherited = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      state,
    );
    const extra = { ...state, path: "/private/vault" };
    const symbol = Object.assign({ ...state }, { [Symbol("hidden")]: true });
    const reordered = withChangedKeyOrder(state);

    for (const candidate of [inherited, extra, symbol, reordered]) {
      expect(() => contract.encodePreparationState(candidate))
        .toThrow(/state|plain|keys|order|exact/iu);
    }
  });

  it("rejects every noncanonical preparation-state byte representation", () => {
    const state = createState();
    const bytes = contract.encodePreparationState(state);
    const values = [
      Buffer.from(JSON.stringify(state), "utf8"),
      bytes.subarray(0, -1),
      Buffer.concat([bytes, Buffer.from("\n")]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.from(`${JSON.stringify(withChangedKeyOrder(state), null, 2)}\n`, "utf8"),
      Buffer.from(`${JSON.stringify({ ...state, localPath: "/tmp/vault" }, null, 2)}\n`, "utf8"),
      Buffer.from(`${JSON.stringify({ ...state, corpusDigest: undefined }, null, 2)}\n`, "utf8"),
      Buffer.from(`{\n  "schemaVersion": 1,\n  "schemaVersion": 1,\n  "scope": "dedicated-synthetic-vault"\n}\n`, "utf8"),
    ];

    for (const candidate of values) {
      expect(() => contract.decodePreparationState(candidate)).toThrow(/state|canonical|keys|bytes|JSON|newline/iu);
    }
    expect(() => contract.decodePreparationState("not bytes" as unknown as Uint8Array))
      .toThrow(/bytes|Uint8Array/iu);
    expect(() => contract.createPreparationState({
      runId: RUN_ID,
      commit: COMMIT,
      attestation: { ...validAttestation(), tree: null } as unknown as ReturnType<typeof validAttestation>,
    })).toThrow(/attestation|tree|snapshot/iu);
  });
});

describe("installation receipt codec", () => {
  it("binds the exact state bytes, seed bytes, run, commit, version, and artifact claim", () => {
    const state = createState();
    const stateBytes = contract.encodePreparationState(state);
    const seedBytes = Buffer.from("canonical seed\n", "utf8");
    const receipt = contract.createInstallationReceipt({
      state,
      stateBytes,
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      artifactSetDigest: ARTIFACT_DIGEST,
      seedBytes,
    });

    expect(receipt).toEqual({
      schemaVersion: 1,
      runId: RUN_ID,
      commit: COMMIT,
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      artifactSetDigest: ARTIFACT_DIGEST,
      fixtureStateDigest: sha256(stateBytes),
      seedDataDigest: sha256(seedBytes),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("round-trips canonical receipt bytes and respects Uint8Array offsets", () => {
    const receipt = createReceipt();
    const bytes = contract.encodeInstallationReceipt(receipt);
    const framed = Buffer.concat([Buffer.from([1, 2]), bytes, Buffer.from([3, 4])]);
    const decoded = contract.decodeInstallationReceipt(framed.subarray(2, -2));

    expect(decoded).toEqual(receipt);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(contract.encodeInstallationReceipt(decoded)).toEqual(bytes);
    expect(bytes.at(-1)).toBe(0x0a);
  });

  it("rejects state bytes from another run and noncanonical state bytes", () => {
    const state = createState();
    const other = createState(OTHER_RUN_ID);
    const input = {
      state,
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      artifactSetDigest: ARTIFACT_DIGEST,
      seedBytes: Buffer.from("seed\n"),
    };

    expect(() => contract.createInstallationReceipt({
      ...input,
      stateBytes: contract.encodePreparationState(other),
    })).toThrow(/state|run|match|bytes|receipt/iu);
    expect(() => contract.createInstallationReceipt({
      ...input,
      stateBytes: contract.encodePreparationState(state).subarray(0, -1),
    })).toThrow(/state|canonical|newline|bytes/iu);
  });

  it.each([
    ["invalid SemVer", "01.0.0", ARTIFACT_BINDING, ARTIFACT_DIGEST],
    ["unbounded SemVer", "1000.0.0", ARTIFACT_BINDING, ARTIFACT_DIGEST],
    ["mismatched binding", PLUGIN_VERSION, "knowledge-workbench@0.2.0:read-only-acceptance", ARTIFACT_DIGEST],
    ["wrong mode", PLUGIN_VERSION, "knowledge-workbench@0.1.0:normal", ARTIFACT_DIGEST],
    ["uppercase digest", PLUGIN_VERSION, ARTIFACT_BINDING, `sha256:${"A".repeat(64)}`],
    ["short digest", PLUGIN_VERSION, ARTIFACT_BINDING, `sha256:${"a".repeat(63)}`],
  ])("rejects %s", (_label, pluginVersion, artifactBinding, artifactSetDigest) => {
    const state = createState();
    expect(() => contract.createInstallationReceipt({
      state,
      stateBytes: contract.encodePreparationState(state),
      pluginVersion,
      artifactBinding,
      artifactSetDigest,
      seedBytes: Buffer.from("seed\n"),
    })).toThrow(/receipt|version|SemVer|binding|digest|artifact/iu);
  });

  it("hashes only the supplied seed view and changes claims for altered seed or artifact evidence", () => {
    const state = createState();
    const stateBytes = contract.encodePreparationState(state);
    const framedSeed = Buffer.from("xseed\ny", "utf8");
    const seedView = framedSeed.subarray(1, -1);
    const base = contract.createInstallationReceipt({
      state,
      stateBytes,
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      artifactSetDigest: ARTIFACT_DIGEST,
      seedBytes: seedView,
    });
    const alteredSeed = contract.createInstallationReceipt({
      state,
      stateBytes,
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      artifactSetDigest: ARTIFACT_DIGEST,
      seedBytes: Buffer.from("changed seed\n"),
    });
    const alteredArtifact = contract.createInstallationReceipt({
      state,
      stateBytes,
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      artifactSetDigest: `sha256:${"e".repeat(64)}`,
      seedBytes: seedView,
    });

    expect(base.seedDataDigest).toBe(sha256(seedView));
    expect(alteredSeed.seedDataDigest).not.toBe(base.seedDataDigest);
    expect(alteredArtifact.artifactSetDigest).not.toBe(base.artifactSetDigest);
  });

  it("rejects non-plain, extra-key, symbol-key, reordered, and noncanonical receipts", () => {
    const receipt = createReceipt();
    const invalidObjects = [
      Object.assign(Object.create({ inherited: true }), receipt),
      { ...receipt, vaultPath: "/private/vault" },
      Object.assign({ ...receipt }, { [Symbol("hidden")]: true }),
      withChangedKeyOrder(receipt),
    ];
    for (const candidate of invalidObjects) {
      expect(() => contract.encodeInstallationReceipt(candidate as InstallationReceipt))
        .toThrow(/receipt|plain|keys|order|exact/iu);
    }

    const bytes = contract.encodeInstallationReceipt(receipt);
    for (const candidate of [
      Buffer.from(JSON.stringify(receipt), "utf8"),
      bytes.subarray(0, -1),
      Buffer.concat([bytes, Buffer.from(" ")]),
      Buffer.from(`${JSON.stringify(withChangedKeyOrder(receipt), null, 2)}\n`, "utf8"),
      Buffer.from(`${JSON.stringify({ ...receipt, artifactPath: "/tmp/main.js" }, null, 2)}\n`, "utf8"),
      Buffer.from(`${JSON.stringify({ ...receipt, seedDataDigest: undefined }, null, 2)}\n`, "utf8"),
    ]) {
      expect(() => contract.decodeInstallationReceipt(candidate))
        .toThrow(/receipt|canonical|keys|bytes|newline/iu);
    }
    expect(() => contract.decodeInstallationReceipt("not bytes" as unknown as Uint8Array))
      .toThrow(/bytes|Uint8Array/iu);
    const state = createState();
    expect(() => contract.createInstallationReceipt({
      state,
      stateBytes: contract.encodePreparationState(state),
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      artifactSetDigest: ARTIFACT_DIGEST,
      seedBytes: "not bytes" as unknown as Buffer,
    })).toThrow(/seed|bytes|Uint8Array/iu);
  });
});

describe("fixed local acceptance paths", () => {
  it("exports only the four fixed repo-relative locations", () => {
    expect({
      state: contract.PREPARATION_STATE_RELATIVE_PATH,
      receipt: contract.INSTALLATION_RECEIPT_RELATIVE_PATH,
      report: contract.ACCEPTANCE_REPORT_RELATIVE_PATH,
      vault: contract.SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH,
    }).toEqual({
      state: ".dev-vault/read-only-acceptance-state.json",
      receipt: ".dev-vault/read-only-acceptance-receipt.json",
      report: ".dev-vault/read-only-acceptance-report.json",
      vault: ".dev-vault/read-only-acceptance-vault",
    });
  });
});

function writeFileSyncForRace(path: string, content: string): void {
  execFileSync(process.execPath, ["-e", [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[1], process.argv[2]);",
  ].join(""), path, content], { stdio: "ignore" });
}
