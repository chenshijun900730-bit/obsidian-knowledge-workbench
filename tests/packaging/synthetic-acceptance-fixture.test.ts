import { execFile } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { createServer } from "node:net";
import {
  chmod,
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
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeSyntheticPluginDataSeed } from "../../scripts/synthetic-acceptance-data.mjs";
import {
  SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
  SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
  SYNTHETIC_ACCEPTANCE_SEED,
  SYNTHETIC_CONTENT_DIRECTORY,
  computeSyntheticCorpusDigest,
  generateAcceptanceFixture,
  generateSyntheticFixture,
  type AttestationInput,
  type CorpusAttestation,
  type SyntheticFixtureNote,
} from "../../scripts/synthetic-note-fixture.mjs";

type SyntheticAcceptanceInstallState =
  | "lock-held"
  | "stage-empty"
  | "stage-four"
  | "target-four"
  | "target-five";

interface SyntheticAcceptanceInstallAttestationInput {
  readonly vaultPath: string;
  readonly expected?: AttestationInput["expected"];
  readonly state: SyntheticAcceptanceInstallState;
  readonly stageName?: string;
}

interface SyntheticAcceptanceVaultModule {
  readonly attestSyntheticAcceptanceVault: (input: AttestationInput) => Promise<CorpusAttestation>;
  readonly attestSyntheticAcceptanceInstallState: (
    input: SyntheticAcceptanceInstallAttestationInput,
  ) => Promise<CorpusAttestation>;
}

interface SyntheticVaultInstallCoreModule {
  readonly OBSIDIAN_CONFIG_DIRECTORY: string;
}

interface SafeFsCoreModule {
  readonly assertOwnedTree: (
    snapshot: CorpusAttestation["tree"],
    label: string,
  ) => Promise<void>;
}

// @ts-expect-error The filesystem attestation core is intentionally plain ESM without a declaration file.
const acceptanceVault = await import("../../scripts/synthetic-acceptance-vault.mjs") as unknown as SyntheticAcceptanceVaultModule;
const {
  attestSyntheticAcceptanceInstallState,
  attestSyntheticAcceptanceVault,
} = acceptanceVault;
// @ts-expect-error The shared synthetic-vault core is intentionally plain ESM without a declaration file.
const installCore = await import("../../scripts/synthetic-vault-install-core.mjs") as unknown as SyntheticVaultInstallCoreModule;
// @ts-expect-error The filesystem attestation core is intentionally plain ESM without a declaration file.
const safeFsCore = await import("../../scripts/safe-fs-core.mjs") as unknown as SafeFsCoreModule;

const statFault = vi.hoisted(() => ({
  devicePath: "",
  racePath: "",
  raceSeen: 0,
  raceTrigger: 0,
  raceAction: null as null | (() => Promise<void>),
}));

const canonicalAccessProbe = vi.hoisted(() => ({
  active: false,
  alias: "",
  decoyRoot: "",
  forbiddenEvents: [] as string[],
  allowedAliasLstats: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const recordCanonicalAccess = (operation: string, value: unknown): void => {
    if (!canonicalAccessProbe.active) return;
    const path = String(value);
    if (operation === "lstat" && path === canonicalAccessProbe.alias) {
      canonicalAccessProbe.allowedAliasLstats.push(`${operation}:${path}`);
      return;
    }
    if (
      path === canonicalAccessProbe.alias
      || path.startsWith(`${canonicalAccessProbe.alias}${sep}`)
      || path === canonicalAccessProbe.decoyRoot
      || path.startsWith(`${canonicalAccessProbe.decoyRoot}${sep}`)
    ) {
      canonicalAccessProbe.forbiddenEvents.push(`${operation}:${path}`);
    }
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      recordCanonicalAccess("open", args[0]);
      return actual.open(...args);
    },
    lstat: async (...args: unknown[]) => {
      recordCanonicalAccess("lstat", args[0]);
      const result: unknown = await Reflect.apply(actual.lstat, actual, args);
      const path = String(args[0]);
      if (path === statFault.racePath) {
        statFault.raceSeen += 1;
        if (statFault.raceSeen === statFault.raceTrigger && statFault.raceAction !== null) {
          const action = statFault.raceAction;
          statFault.raceAction = null;
          await action();
        }
      }
      if (path === statFault.devicePath && typeof result === "object" && result !== null) {
        const stat = result as BigIntStats;
        return {
          ...stat,
          isBlockDevice: () => false,
          isCharacterDevice: () => true,
          isDirectory: () => false,
          isFIFO: () => false,
          isFile: () => false,
          isSocket: () => false,
          isSymbolicLink: () => false,
        } satisfies BigIntStats;
      }
      return result;
    },
    readFile: async (...args: unknown[]) => {
      recordCanonicalAccess("readFile", args[0]);
      return Reflect.apply(actual.readFile, actual, args) as ReturnType<typeof actual.readFile>;
    },
    readdir: async (...args: unknown[]) => {
      recordCanonicalAccess("readdir", args[0]);
      return Reflect.apply(actual.readdir, actual, args) as ReturnType<typeof actual.readdir>;
    },
    realpath: async (...args: unknown[]) => {
      recordCanonicalAccess("realpath", args[0]);
      return Reflect.apply(actual.realpath, actual, args) as ReturnType<typeof actual.realpath>;
    },
  };
});

const HEAVY_TIMEOUT_MS = 600_000;
const execFileAsync = promisify(execFile);
const markerValue = Object.freeze({
  schemaVersion: 1,
  purpose: "knowledge-workbench-dedicated-test-vault",
  contentPolicy: "synthetic-notes-only",
});
const markerBytes = `${JSON.stringify(markerValue, null, 2)}\n`;
const emptyCommunityPlugins = "[]\n";
const optionalPostHostConfigFiles = Object.freeze([
  "app.json",
  "appearance.json",
  "core-plugins.json",
  "core-plugins-migration.json",
  "graph.json",
  "hotkeys.json",
  "types.json",
  "workspace.json",
  "workspace-mobile.json",
]);
const acceptanceVersion = "0.1.0";
const acceptanceMetadata = `${JSON.stringify({
  schemaVersion: 1,
  pluginVersion: acceptanceVersion,
  buildMode: "read-only-acceptance",
  artifactBinding: `knowledge-workbench@${acceptanceVersion}:read-only-acceptance`,
  contentWrites: "blocked",
  network: "blocked",
}, null, 2)}\n`;
const acceptanceManifest = `${JSON.stringify({
  id: "knowledge-workbench",
  name: "Knowledge Workbench (Read-only acceptance)",
  version: acceptanceVersion,
}, null, 2)}\n`;
const acceptanceBundle = [
  "read-only-acceptance",
  acceptanceVersion,
  "Knowledge Workbench (Read-only acceptance)",
  `knowledge-workbench@${acceptanceVersion}:read-only-acceptance`,
].join("\n");
const destinationLockName = ".knowledge-workbench-read-only-acceptance.lock";
const targetStagePrefix = ".knowledge-workbench-read-only-acceptance.stage-";
const transientStageName = `${targetStagePrefix}${process.pid}-00000000-0000-4000-8000-000000000000`;
const secondTransientStageName = `${targetStagePrefix}${process.pid}-00000000-0000-4000-8000-000000000001`;
const destinationLockBytes = `${JSON.stringify({
  schemaVersion: 1,
  pid: process.pid,
  token: "00000000-0000-4000-8000-000000000002",
})}\n`;
const normalManifest = `${JSON.stringify({
  id: "knowledge-workbench",
  name: "Knowledge Workbench",
  version: acceptanceVersion,
}, null, 2)}\n`;

function resetStatFault(): void {
  statFault.devicePath = "";
  statFault.racePath = "";
  statFault.raceSeen = 0;
  statFault.raceTrigger = 0;
  statFault.raceAction = null;
}

function resetCanonicalAccessProbe(): void {
  canonicalAccessProbe.active = false;
  canonicalAccessProbe.alias = "";
  canonicalAccessProbe.decoyRoot = "";
  canonicalAccessProbe.forbiddenEvents = [];
  canonicalAccessProbe.allowedAliasLstats = [];
}

function scheduleDirectoryReplacement(path: string, action: () => Promise<void>): void {
  scheduleStatRace(path, 1, action);
}

function scheduleStatRace(path: string, triggerAt: number, action: () => Promise<void>): void {
  statFault.racePath = path;
  statFault.raceSeen = 0;
  statFault.raceTrigger = triggerAt;
  statFault.raceAction = action;
}

async function rewriteAndRestoreWithChangedCtime(
  path: string,
  temporary: string,
  restored: string,
): Promise<boolean> {
  const before = await lstat(path, { bigint: true });
  await writeFile(path, temporary, "utf8");
  await writeFile(path, restored, "utf8");
  let after = await lstat(path, { bigint: true });
  if (after.ctimeNs === before.ctimeNs) {
    const originalMode = Number(before.mode & 0o7777n);
    const alternateMode = originalMode ^ 0o100;
    await chmod(path, alternateMode);
    await chmod(path, originalMode);
    after = await lstat(path, { bigint: true });
  }
  return after.ctimeNs !== before.ctimeNs;
}

function note(path: string, content: string, mtime = 1): SyntheticFixtureNote {
  const basename = path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path;
  return {
    path,
    basename,
    mtime,
    size: Buffer.byteLength(content, "utf8"),
    content,
    frontmatter: {},
    headings: [],
    outgoingLinks: [],
  };
}

describe("deterministic acceptance fixture", () => {
  it("keeps the fixed 5000-note seeded byte contract and rich metadata", () => {
    const first = generateAcceptanceFixture();
    const second = generateAcceptanceFixture();

    expect(SYNTHETIC_ACCEPTANCE_NOTE_COUNT).toBe(5_000);
    expect(SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES).toBe(75 * 1024 * 1024);
    expect(SYNTHETIC_ACCEPTANCE_SEED).toBe(13);
    expect(SYNTHETIC_CONTENT_DIRECTORY).toBe("Generated");
    expect(first.notes.slice(0, 2).map((entry) => entry.path)).toEqual([
      "Generated/00000/note-00000-3db92208.md",
      "Generated/00001/note-00001-752cddc7.md",
    ]);
    expect(first.noteCount).toBe(5_000);
    expect(first.totalBytes).toBe(75 * 1024 * 1024);
    expect(first.notes.reduce((sum, entry) => sum + entry.size, 0)).toBe(78_643_200);
    expect(second).toEqual(first);
    expect(second.notes.every((entry, index) => (
      Buffer.from(entry.content, "utf8").equals(Buffer.from(first.notes[index]!.content, "utf8"))
    ))).toBe(true);

    expect(first.notes[0]?.headings).toEqual(["知识条目 0"]);
    expect(first.notes[1]?.headings).toEqual(["Knowledge Note 1"]);
    const malformedIndexes = first.notes.flatMap((entry, index) => (
      Object.keys(entry.frontmatter).length === 0 ? [index] : []
    ));
    expect(malformedIndexes).toEqual(Array.from({ length: 50 }, (_, index) => ((index + 1) * 100) - 1));
    expect(first.notes[99]?.content.startsWith("---\ntitle: [unterminated\nseed: ")).toBe(true);
    expect(first.notes[99]?.content.slice(4)).not.toContain("\n---\n");

    const linkedIndexes = first.notes.flatMap((entry, index) => (
      entry.outgoingLinks.length > 0 ? [index] : []
    ));
    expect(linkedIndexes).toEqual(Array.from({ length: 200 }, (_, index) => ((index + 1) * 25) - 1));
    for (const index of linkedIndexes) {
      const target = first.notes[(index + 1) % first.notes.length]!.path;
      expect(first.notes[index]?.outgoingLinks).toEqual([target]);
      expect(first.notes[index]?.content).toContain(`[[${target.slice(0, -3)}]]`);
    }
  });

  it("retains the legacy input validation and exact padding semantics", () => {
    expect(() => generateSyntheticFixture({ notes: 0, minimumBytes: 0 })).toThrow(/positive integer/iu);
    expect(() => generateSyntheticFixture({ notes: 1, minimumBytes: -1 })).toThrow(/non-negative safe integer/iu);
    expect(() => generateSyntheticFixture({ notes: 1, minimumBytes: 0, seed: 1.5 })).toThrow(/seed.*integer/iu);
    const fixture = generateSyntheticFixture({ notes: 3, minimumBytes: 20_000, seed: 7 });
    expect(fixture.noteCount).toBe(3);
    expect(fixture.totalBytes).toBe(20_000);
  });
});

describe("canonical synthetic corpus digest", () => {
  it("ignores array order, mtimes, and non-Generated Markdown entries", () => {
    const alpha = note("Generated/alpha/a.md", "ALPHA", 1);
    const beta = note("Generated/beta/b.md", "BETA", 2);
    const ignored = note("Outside/ignored.md", "PRIVATE", 3);
    const ignoredExtension = note("Generated/beta/not-markdown.txt", "PRIVATE", 4);
    const expected = computeSyntheticCorpusDigest([alpha, beta]);

    expect(computeSyntheticCorpusDigest([
      { ...beta, mtime: 9_999 },
      ignored,
      ignoredExtension,
      { ...alpha, mtime: 8_888 },
    ])).toBe(expected);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("changes for one path byte or one content byte", () => {
    const original = note("Generated/a/note.md", "content-a");
    const digest = computeSyntheticCorpusDigest([original]);
    expect(computeSyntheticCorpusDigest([{ ...original, path: "Generated/a/notf.md" }])).not.toBe(digest);
    expect(computeSyntheticCorpusDigest([{ ...original, content: "content-b", size: original.size }])).not.toBe(digest);
  });

  it("frames path and content lengths so a/b plus c cannot collide with a plus b/c", () => {
    const left = note("Generated/a/b.md", "c");
    const right = note("Generated/a.md", "b.md/c");
    expect(computeSyntheticCorpusDigest([left])).not.toBe(computeSyntheticCorpusDigest([right]));
  });
});

describe("on-disk synthetic acceptance attestation", () => {
  let container = "";
  let vaultPath = "";
  let fixture: ReturnType<typeof generateAcceptanceFixture>;
  let corpusDigest = "";

  const markerPath = (): string => join(vaultPath, ".knowledge-workbench-test-vault.json");
  const obsidianPath = (): string => join(vaultPath, installCore.OBSIDIAN_CONFIG_DIRECTORY);
  const pluginsPath = (): string => join(obsidianPath(), "plugins");
  const communityPath = (): string => join(obsidianPath(), "community-plugins.json");
  const destinationLockPath = (): string => join(pluginsPath(), destinationLockName);
  const transientStagePath = (name = transientStageName): string => join(pluginsPath(), name);
  const installedTargetPath = (): string => join(pluginsPath(), "knowledge-workbench");
  const firstNotePath = (): string => join(vaultPath, ...fixture.notes[0]!.path.split("/"));
  const secondNotePath = (): string => join(vaultPath, ...fixture.notes[1]!.path.split("/"));

  async function writeInBatches(entries: readonly SyntheticFixtureNote[]): Promise<void> {
    const batchSize = 64;
    for (let start = 0; start < entries.length; start += batchSize) {
      await Promise.all(entries.slice(start, start + batchSize).map(async (entry) => {
        const path = join(vaultPath, ...entry.path.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, entry.content, "utf8");
      }));
    }
  }

  async function attestPrepared(): Promise<CorpusAttestation> {
    return attestSyntheticAcceptanceVault({
      vaultPath,
      phase: "prepared",
      expected: {
        syntheticNoteCount: 5_000,
        syntheticTotalBytes: 78_643_200,
        corpusDigest,
      },
    });
  }

  async function resetTransientPlugins(): Promise<void> {
    await rm(pluginsPath(), { recursive: true, force: true });
    await mkdir(pluginsPath());
  }

  async function writeDestinationLock(): Promise<void> {
    await writeFile(destinationLockPath(), destinationLockBytes, { encoding: "utf8", flag: "wx" });
  }

  async function writeAcceptanceFiles(directory: string): Promise<void> {
    await Promise.all([
      writeFile(join(directory, "acceptance-build.json"), acceptanceMetadata, "utf8"),
      writeFile(join(directory, "main.js"), acceptanceBundle, "utf8"),
      writeFile(join(directory, "manifest.json"), acceptanceManifest, "utf8"),
      writeFile(join(directory, "styles.css"), ".knowledge-workbench { display: block; }\n", "utf8"),
    ]);
  }

  async function attestInstallState(
    state: SyntheticAcceptanceInstallState,
    stageName?: string,
  ): Promise<CorpusAttestation> {
    return attestSyntheticAcceptanceInstallState({
      vaultPath,
      expected: {
        syntheticNoteCount: 5_000,
        syntheticTotalBytes: 78_643_200,
        corpusDigest,
      },
      state,
      ...(stageName === undefined ? {} : { stageName }),
    });
  }

  async function expectInstallStateRejected(input: Readonly<{
    name: string;
    state: SyntheticAcceptanceInstallState;
    stageName?: string;
    prepare: () => Promise<void>;
    cleanup?: () => Promise<void>;
  }>): Promise<void> {
    await resetTransientPlugins();
    await writeDestinationLock();
    try {
      await input.prepare();
      await expect(
        Promise.resolve().then(() => attestInstallState(input.state, input.stageName)),
        input.name,
      )
        .rejects.toThrow();
    } finally {
      await input.cleanup?.();
      await resetTransientPlugins();
    }
  }

  async function enterPostHost(): Promise<string> {
    await Promise.all(optionalPostHostConfigFiles.map((name) => (
      writeFile(join(obsidianPath(), name), "{}\n", "utf8")
    )));
    const target = join(pluginsPath(), "knowledge-workbench");
    await mkdir(target);
    await Promise.all([
      writeFile(join(target, "acceptance-build.json"), acceptanceMetadata, "utf8"),
      writeFile(join(target, "main.js"), acceptanceBundle, "utf8"),
      writeFile(join(target, "manifest.json"), acceptanceManifest, "utf8"),
      writeFile(join(target, "styles.css"), ".knowledge-workbench { display: block; }\n", "utf8"),
      writeFile(join(target, "data.json"), "{}\n", "utf8"),
    ]);
    return target;
  }

  async function leavePostHost(): Promise<void> {
    await rm(join(pluginsPath(), "knowledge-workbench"), { recursive: true, force: true });
    await Promise.all(optionalPostHostConfigFiles.map((name) => (
      rm(join(obsidianPath(), name), { recursive: true, force: true })
    )));
  }

  beforeAll(async () => {
    fixture = generateAcceptanceFixture();
    corpusDigest = computeSyntheticCorpusDigest(fixture.notes);
    container = await realpath(await mkdtemp(join(tmpdir(), "kwb-accept-")));
    vaultPath = join(container, "vault");
    await mkdir(pluginsPath(), { recursive: true });
    await writeFile(markerPath(), markerBytes, "utf8");
    await writeFile(communityPath(), emptyCommunityPlugins, "utf8");
    await writeInBatches(fixture.notes);
  }, HEAVY_TIMEOUT_MS);

  afterAll(async () => {
    resetStatFault();
    resetCanonicalAccessProbe();
    await rm(container, { recursive: true, force: true });
  }, HEAVY_TIMEOUT_MS);

  it("attests the exact prepared tree without persisting note evidence", async () => {
    const before = await readdir(vaultPath);
    const result = await attestPrepared();
    const after = await readdir(vaultPath);

    expect(result).toMatchObject({
      syntheticNoteCount: 5_000,
      syntheticTotalBytes: 78_643_200,
      corpusDigest,
    });
    expect(Object.keys(result).sort()).toEqual([
      "corpusDigest",
      "syntheticNoteCount",
      "syntheticTotalBytes",
      "tree",
    ]);
    const entries = result.tree.entries;
    const sentinel = "caller-injected-evidence";
    const existing = entries.values().next().value;
    let directMutationError: unknown;
    try {
      (entries as unknown as Map<string, typeof existing>).set(sentinel, existing);
    } catch (error) {
      directMutationError = error;
    }
    const directMutationSucceeded = entries.has(sentinel);
    if (directMutationSucceeded) {
      (entries as unknown as Map<string, typeof existing>).delete(sentinel);
    }

    let callbackView: ReadonlyMap<string, typeof existing> | undefined;
    entries.forEach((_value, _key, map) => { callbackView ??= map; });
    let callbackMutationError: unknown;
    try {
      (callbackView as unknown as Map<string, typeof existing>).set(sentinel, existing);
    } catch (error) {
      callbackMutationError = error;
    }
    const callbackMutationSucceeded = entries.has(sentinel);
    if (callbackMutationSucceeded) {
      (entries as unknown as Map<string, typeof existing>).delete(sentinel);
    }

    const prototype = Object.getPrototypeOf(entries) as object;
    const getDescriptor = Object.getOwnPropertyDescriptor(prototype, "get");
    const firstKey = entries.keys().next().value;
    const firstValue = entries.get(firstKey!);
    const prototypeMutationSucceeded = Reflect.set(prototype, "get", () => undefined);
    const prototypeMutationChangedBehavior = entries.get(firstKey!) !== firstValue;
    if (prototypeMutationSucceeded && getDescriptor !== undefined) {
      Object.defineProperty(prototype, "get", getDescriptor);
    }

    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(directMutationSucceeded).toBe(false);
    expect(directMutationError).toBeInstanceOf(TypeError);
    expect(callbackView).toBe(entries);
    expect(callbackMutationSucceeded).toBe(false);
    expect(callbackMutationError).toBeInstanceOf(TypeError);
    expect(prototypeMutationSucceeded).toBe(false);
    expect(prototypeMutationChangedBehavior).toBe(false);
    await expect(safeFsCore.assertOwnedTree(result.tree, "Returned acceptance tree"))
      .resolves.toBeUndefined();
    const persistable = JSON.stringify(result, (_key, value: unknown) => (
      typeof value === "bigint" ? value.toString() : value
    ));
    expect(persistable).not.toContain(fixture.notes[0]!.path);
    expect(persistable).not.toContain(fixture.notes[0]!.content.slice(0, 40));
    expect(after.sort()).toEqual(before.sort());
  }, HEAVY_TIMEOUT_MS);

  it("short-circuits both attesters at vault, configuration, and plugins symlink aliases", async () => {
    const levels = [
      { label: "vault", alias: () => vaultPath },
      { label: "configuration", alias: () => obsidianPath() },
      { label: "plugins", alias: () => pluginsPath() },
    ] as const;

    for (const level of levels) {
      await resetTransientPlugins();
      await writeDestinationLock();
      const alias = level.alias();
      const retained = join(container, `retained-${level.label}-canonical-evidence`);
      const decoyRoot = join(container, `decoy-${level.label}-canonical-evidence`);
      const decoySentinel = join(decoyRoot, "private", "sentinel.txt");
      const decoyBytes = Buffer.from(`DECOY-${level.label.toUpperCase()}-SENTINEL\n`, "utf8");
      await mkdir(dirname(decoySentinel), { recursive: true });
      await writeFile(decoySentinel, decoyBytes, { flag: "wx" });
      const decoyIdentity = await lstat(decoySentinel, { bigint: true });
      let retainedInstalled = false;
      let symlinkInstalled = false;

      try {
        await rename(alias, retained);
        retainedInstalled = true;
        await symlink(decoyRoot, alias);
        symlinkInstalled = true;

        const attesters = [
          { label: "prepared", run: () => attestPrepared() },
          { label: "transient", run: () => attestInstallState("lock-held") },
        ] as const;
        for (const attester of attesters) {
          canonicalAccessProbe.alias = alias;
          canonicalAccessProbe.decoyRoot = decoyRoot;
          canonicalAccessProbe.forbiddenEvents = [];
          canonicalAccessProbe.allowedAliasLstats = [];
          canonicalAccessProbe.active = true;
          let failure: unknown;
          try {
            await attester.run();
          } catch (error) {
            failure = error;
          } finally {
            canonicalAccessProbe.active = false;
          }

          const probeLabel = `${attester.label}:${level.label}`;
          expect(failure, probeLabel).toBeInstanceOf(Error);
          expect(String((failure as Error).message), probeLabel)
            .toMatch(/canonical|non-symlink|symbolic|symlink/iu);
          expect(
            canonicalAccessProbe.allowedAliasLstats,
            `${probeLabel}:${String((failure as Error).message)}`,
          )
            .toEqual([`lstat:${alias}`]);
          expect(canonicalAccessProbe.forbiddenEvents, probeLabel).toEqual([]);
          expect(
            canonicalAccessProbe.forbiddenEvents.filter((event) => (
              event === `realpath:${alias}`
              || event.includes(decoyRoot)
            )),
            probeLabel,
          ).toEqual([]);
        }

        expect(await readFile(decoySentinel)).toEqual(decoyBytes);
        const decoyAfter = await lstat(decoySentinel, { bigint: true });
        expect({ dev: decoyAfter.dev, ino: decoyAfter.ino }).toEqual({
          dev: decoyIdentity.dev,
          ino: decoyIdentity.ino,
        });
      } finally {
        resetCanonicalAccessProbe();
        if (symlinkInstalled) await unlink(alias);
        if (retainedInstalled) await rename(retained, alias);
        await rm(decoyRoot, { recursive: true, force: true });
        await resetTransientPlugins();
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("requires an exact plain transient input, fixed state, and state-bound stage name", async () => {
    expect(attestSyntheticAcceptanceInstallState).toBeTypeOf("function");

    const validLockInput = {
      vaultPath,
      state: "lock-held",
    } as const;
    const getter = vi.fn(() => vaultPath);
    const accessorInput: Record<PropertyKey, unknown> = { state: "lock-held" };
    Object.defineProperty(accessorInput, "vaultPath", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    const symbol = Symbol("unexpected-transient-option");
    const invalidInputs: readonly unknown[] = [
      null,
      [],
      Object.create(validLockInput),
      Object.assign(Object.create(null), validLockInput),
      { ...validLockInput, extra: true },
      { ...validLockInput, [symbol]: true },
      accessorInput,
      { ...validLockInput, state: "unknown" },
      { ...validLockInput, state: 1 },
      { ...validLockInput, stageName: transientStageName },
      { vaultPath, state: "stage-empty" },
      { vaultPath, state: "stage-empty", stageName: 1 },
      { vaultPath, state: "stage-four", stageName: "knowledge-workbench-stage" },
      { vaultPath, state: "stage-four", stageName: `${targetStagePrefix}../escape` },
      { vaultPath: "relative/vault", state: "lock-held" },
    ];

    for (const input of invalidInputs) {
      await expect(Promise.resolve().then(() => attestSyntheticAcceptanceInstallState(
        input as SyntheticAcceptanceInstallAttestationInput,
      ))).rejects.toThrow(/input|plain|own|key|accessor|symbol|state|stage|name|absolute|unexpected|required|data/iu);
    }
    expect(getter).not.toHaveBeenCalled();
  }, HEAVY_TIMEOUT_MS);

  it("attests only the five fixed installer transition states", async () => {
    const results: CorpusAttestation[] = [];
    await resetTransientPlugins();
    try {
      await writeDestinationLock();
      results.push(await attestInstallState("lock-held"));

      await mkdir(transientStagePath());
      results.push(await attestInstallState("stage-empty", transientStageName));

      await writeAcceptanceFiles(transientStagePath());
      results.push(await attestInstallState("stage-four", transientStageName));

      await rename(transientStagePath(), installedTargetPath());
      results.push(await attestInstallState("target-four"));

      await writeFile(
        join(installedTargetPath(), "data.json"),
        encodeSyntheticPluginDataSeed(),
        { flag: "wx" },
      );
      results.push(await attestInstallState("target-five"));
    } finally {
      await resetTransientPlugins();
    }

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result).toMatchObject({
        syntheticNoteCount: 5_000,
        syntheticTotalBytes: 78_643_200,
        corpusDigest,
      });
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects unknown, extra, linked, special, normal, or noncanonical transient artifacts", async () => {
    const symlinkExternal = join(container, "transient-symlink-main.js");
    const hardLinkExternal = join(container, "transient-hard-link-main.js");
    const wrongStageName = `.knowledge-workbench-read-only-acceptance.tmp-${process.pid}`;
    const scenarios = [
      {
        name: "unknown plugin child",
        state: "lock-held",
        prepare: async () => { await mkdir(join(pluginsPath(), "other-plugin")); },
      },
      {
        name: "extra stage",
        state: "stage-empty",
        stageName: transientStageName,
        prepare: async () => {
          await mkdir(transientStagePath());
          await mkdir(transientStagePath(secondTransientStageName));
        },
      },
      {
        name: "fifth stage artifact",
        state: "stage-four",
        stageName: transientStageName,
        prepare: async () => {
          await mkdir(transientStagePath());
          await writeAcceptanceFiles(transientStagePath());
          await writeFile(join(transientStagePath(), "private.json"), "{}\n", "utf8");
        },
      },
      {
        name: "symbolic-link stage artifact",
        state: "stage-four",
        stageName: transientStageName,
        prepare: async () => {
          await mkdir(transientStagePath());
          await writeAcceptanceFiles(transientStagePath());
          await writeFile(symlinkExternal, acceptanceBundle, "utf8");
          await unlink(join(transientStagePath(), "main.js"));
          await symlink(symlinkExternal, join(transientStagePath(), "main.js"));
        },
        cleanup: async () => { await rm(symlinkExternal, { force: true }); },
      },
      {
        name: "hard-link stage artifact",
        state: "stage-four",
        stageName: transientStageName,
        prepare: async () => {
          await mkdir(transientStagePath());
          await writeAcceptanceFiles(transientStagePath());
          await link(join(transientStagePath(), "main.js"), hardLinkExternal);
        },
        cleanup: async () => { await rm(hardLinkExternal, { force: true }); },
      },
      {
        name: "special stage artifact",
        state: "stage-four",
        stageName: transientStageName,
        prepare: async () => {
          await mkdir(transientStagePath());
          await writeAcceptanceFiles(transientStagePath());
          await unlink(join(transientStagePath(), "main.js"));
          await execFileAsync("mkfifo", [join(transientStagePath(), "main.js")]);
        },
      },
      {
        name: "normal-mode stage manifest",
        state: "stage-four",
        stageName: transientStageName,
        prepare: async () => {
          await mkdir(transientStagePath());
          await writeAcceptanceFiles(transientStagePath());
          await writeFile(join(transientStagePath(), "manifest.json"), normalManifest, "utf8");
        },
      },
      {
        name: "invalid target artifact contract",
        state: "target-four",
        prepare: async () => {
          await mkdir(installedTargetPath());
          await writeAcceptanceFiles(installedTargetPath());
          await writeFile(join(installedTargetPath(), "acceptance-build.json"), "{}\n", "utf8");
        },
      },
      {
        name: "noncanonical target seed",
        state: "target-five",
        prepare: async () => {
          await mkdir(installedTargetPath());
          await writeAcceptanceFiles(installedTargetPath());
          await writeFile(join(installedTargetPath(), "data.json"), "{}\n", "utf8");
        },
      },
      {
        name: "wrong stage prefix",
        state: "stage-empty",
        stageName: wrongStageName,
        prepare: async () => { await mkdir(transientStagePath(wrongStageName)); },
      },
    ] satisfies readonly Parameters<typeof expectInstallStateRejected>[0][];

    for (const scenario of scenarios) await expectInstallStateRejected(scenario);
  }, HEAVY_TIMEOUT_MS);

  it("requires the prepared plugins entry to be an empty directory", async () => {
    await rm(pluginsPath(), { recursive: true });
    await writeFile(pluginsPath(), "", "utf8");
    try {
      await expect(attestPrepared()).rejects.toThrow(/plugins|directory|configuration/iu);
    } finally {
      await rm(pluginsPath(), { force: true });
      await mkdir(pluginsPath());
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects an added note", async () => {
    const added = join(vaultPath, "Generated", "added.md");
    await writeFile(added, "# added\n", "utf8");
    try {
      await expect(attestPrepared()).rejects.toThrow(/unknown|unexpected|corpus|entry/iu);
    } finally {
      await rm(added, { force: true });
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a missing note", async () => {
    const original = firstNotePath();
    const held = join(container, "missing-note.md");
    await rename(original, held);
    try {
      await expect(attestPrepared()).rejects.toThrow(/missing|unknown|changed|entry/iu);
    } finally {
      await rename(held, original);
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a renamed note", async () => {
    const original = firstNotePath();
    const renamed = join(dirname(original), "renamed.md");
    await rename(original, renamed);
    try {
      await expect(attestPrepared()).rejects.toThrow(/missing|unknown|changed|entry/iu);
    } finally {
      await rename(renamed, original);
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a one-byte note change", async () => {
    const path = firstNotePath();
    const original = await readFile(path);
    const changed = Buffer.from(original);
    changed[changed.byteLength - 1] = changed[changed.byteLength - 1] === 0x78 ? 0x79 : 0x78;
    await writeFile(path, changed);
    try {
      await expect(attestPrepared()).rejects.toThrow(/byte|content|digest|corpus|match/iu);
    } finally {
      await writeFile(path, original);
    }
  }, HEAVY_TIMEOUT_MS);

  it("uses a second tree pass to catch an early note changed during the first pass", async () => {
    const firstPath = firstNotePath();
    const original = await readFile(firstPath);
    const changed = Buffer.from(original);
    changed[changed.byteLength - 1] = changed[changed.byteLength - 1] === 0x78 ? 0x79 : 0x78;
    let mutationInjected = false;
    scheduleStatRace(secondNotePath(), 3, async () => {
      mutationInjected = true;
      await writeFile(firstPath, changed);
    });
    try {
      await expect(attestPrepared()).rejects.toThrow(/changed|snapshot|tree/iu);
      expect(mutationInjected).toBe(true);
    } finally {
      resetStatFault();
      await writeFile(firstPath, original);
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects extra top-level content", async () => {
    const extra = join(vaultPath, "README.md");
    await writeFile(extra, "extra\n", "utf8");
    try {
      await expect(attestPrepared()).rejects.toThrow(/top-level|unknown|entry/iu);
    } finally {
      await rm(extra, { force: true });
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a symbolic link in generated content", async () => {
    const original = firstNotePath();
    const held = join(container, "symlink-original.md");
    const external = join(container, "symlink-target.md");
    await rename(original, held);
    await writeFile(external, fixture.notes[0]!.content, "utf8");
    await symlink(external, original);
    try {
      await expect(attestPrepared()).rejects.toThrow(/symbolic|symlink|regular/iu);
    } finally {
      await unlink(original);
      await rename(held, original);
      await rm(external, { force: true });
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a hard link in generated content", async () => {
    const original = firstNotePath();
    const held = join(container, "hard-link-original.md");
    await rename(original, held);
    await link(secondNotePath(), original);
    try {
      await expect(attestPrepared()).rejects.toThrow(/single link|hard link|nlink|regular/iu);
    } finally {
      await unlink(original);
      await rename(held, original);
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a real FIFO in generated content", async () => {
    const original = firstNotePath();
    const held = join(container, "fifo-original.md");
    await rename(original, held);
    await execFileAsync("mkfifo", [original]);
    try {
      await expect(attestPrepared()).rejects.toThrow(/regular|special|entry/iu);
    } finally {
      await rm(original, { force: true });
      await rename(held, original);
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a real Unix socket in the vault", async () => {
    const socketPath = join(vaultPath, "socket");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(attestPrepared()).rejects.toThrow(/regular|special|entry/iu);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error); });
      });
      await rm(socketPath, { force: true });
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects injected device-node stat evidence without privileged mknod", async () => {
    statFault.devicePath = firstNotePath();
    try {
      await expect(attestPrepared()).rejects.toThrow(/regular|special|entry/iu);
    } finally {
      resetStatFault();
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a directory component replaced during recursive capture", async () => {
    const directory = dirname(firstNotePath());
    const held = join(container, "replaced-directory");
    scheduleDirectoryReplacement(directory, async () => {
      await rename(directory, held);
      await mkdir(directory);
      await writeFile(firstNotePath(), fixture.notes[0]!.content, "utf8");
    });
    try {
      await expect(attestPrepared()).rejects.toThrow(/changed|identity|replacement|snapshot/iu);
    } finally {
      resetStatFault();
      await rm(directory, { recursive: true, force: true });
      await rename(held, directory);
    }
  }, HEAVY_TIMEOUT_MS);

  it.each([
    ["nonempty", ["other-plugin"]],
    ["enabled", ["knowledge-workbench"]],
  ])("rejects a %s community-plugin list", async (_label, entries) => {
    await writeFile(communityPath(), `${JSON.stringify(entries)}\n`, "utf8");
    try {
      await expect(attestPrepared()).rejects.toThrow(/community-plugins|empty|enabled/iu);
    } finally {
      await writeFile(communityPath(), emptyCommunityPlugins, "utf8");
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects a changed dedicated-vault marker", async () => {
    await writeFile(markerPath(), `${JSON.stringify({ ...markerValue, contentPolicy: "other" })}\n`, "utf8");
    scheduleDirectoryReplacement(join(vaultPath, "Generated"), async () => {
      throw new Error("generated corpus traversed before marker validation");
    });
    try {
      await expect(attestPrepared()).rejects.toThrow(/marker|exact/iu);
    } finally {
      resetStatFault();
      await writeFile(markerPath(), markerBytes, "utf8");
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects aggregate evidence that does not match the corpus", async () => {
    await expect(attestSyntheticAcceptanceVault({
      vaultPath,
      phase: "prepared",
      expected: {
        syntheticNoteCount: 5_000,
        syntheticTotalBytes: 78_643_200,
        corpusDigest: `sha256:${"0".repeat(64)}`,
      },
    })).rejects.toThrow(/expected|digest|corpus/iu);
  }, HEAVY_TIMEOUT_MS);

  it("accepts only the conservative post-host configuration and exact installed target", async () => {
    await enterPostHost();
    try {
      const result = await attestSyntheticAcceptanceVault({
        vaultPath,
        phase: "post-host",
        expected: {
          syntheticNoteCount: 5_000,
          syntheticTotalBytes: 78_643_200,
          corpusDigest,
        },
      });
      expect(result).toMatchObject({
        syntheticNoteCount: 5_000,
        syntheticTotalBytes: 78_643_200,
        corpusDigest,
      });
    } finally {
      await leavePostHost();
    }
  }, HEAVY_TIMEOUT_MS);

  it("binds installed-target semantics to the main tree across an ABA race", async () => {
    const target = await enterPostHost();
    const main = join(target, "main.js");
    let mutationInjected = false;
    let restorationInjected = false;
    scheduleStatRace(markerPath(), 4, async () => {
      mutationInjected = true;
      await writeFile(main, `${acceptanceBundle}\n// alternate valid bundle\n`, "utf8");
      scheduleStatRace(markerPath(), 1, async () => {
        restorationInjected = true;
        await writeFile(main, acceptanceBundle, "utf8");
      });
    });
    try {
      await expect(attestSyntheticAcceptanceVault({ vaultPath, phase: "post-host" }))
        .rejects.toThrow(/bound|changed|snapshot|tree/iu);
      expect(mutationInjected).toBe(true);
      expect(restorationInjected).toBe(false);
    } finally {
      resetStatFault();
      await writeFile(main, acceptanceBundle, "utf8");
      await leavePostHost();
    }
  }, HEAVY_TIMEOUT_MS);

  it("detects an early installed-target ABA rewrite during final tree traversal", async () => {
    const target = await enterPostHost();
    const main = join(target, "main.js");
    let mutationInjected = false;
    let ctimeChanged = false;
    scheduleStatRace(join(vaultPath, SYNTHETIC_CONTENT_DIRECTORY), 4, async () => {
      mutationInjected = true;
      ctimeChanged = await rewriteAndRestoreWithChangedCtime(
        main,
        `${acceptanceBundle}\n// transient rewrite\n`,
        acceptanceBundle,
      );
    });
    try {
      await expect(attestSyntheticAcceptanceVault({ vaultPath, phase: "post-host" }))
        .rejects.toThrow(/changed|snapshot|tree/iu);
      expect(mutationInjected).toBe(true);
      expect(ctimeChanged).toBe(true);
    } finally {
      resetStatFault();
      await writeFile(main, acceptanceBundle, "utf8");
      await leavePostHost();
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects an unknown post-host configuration filename", async () => {
    await enterPostHost();
    const unknown = join(obsidianPath(), "canvas.json");
    await writeFile(unknown, "{}\n", "utf8");
    try {
      await expect(attestSyntheticAcceptanceVault({ vaultPath, phase: "post-host" }))
        .rejects.toThrow(/configuration|allowlist|unknown|filename/iu);
    } finally {
      await rm(unknown, { force: true });
      await leavePostHost();
    }
  }, HEAVY_TIMEOUT_MS);

  it("requires optional post-host configuration entries to be regular files", async () => {
    await enterPostHost();
    const appConfig = join(obsidianPath(), "app.json");
    await rm(appConfig, { force: true });
    await mkdir(appConfig);
    try {
      await expect(attestSyntheticAcceptanceVault({ vaultPath, phase: "post-host" }))
        .rejects.toThrow(/configuration|regular|file|directory/iu);
    } finally {
      await leavePostHost();
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects an extra installed-target entry", async () => {
    const target = await enterPostHost();
    const extra = join(target, "private.json");
    await writeFile(extra, "{}\n", "utf8");
    try {
      await expect(attestSyntheticAcceptanceVault({ vaultPath, phase: "post-host" }))
        .rejects.toThrow(/installed|target|exact|unknown|entry/iu);
    } finally {
      await leavePostHost();
    }
  }, HEAVY_TIMEOUT_MS);

  it("rejects an installed artifact outside the shared acceptance contract", async () => {
    const target = await enterPostHost();
    await writeFile(join(target, "acceptance-build.json"), "{}\n", "utf8");
    try {
      await expect(attestSyntheticAcceptanceVault({ vaultPath, phase: "post-host" }))
        .rejects.toThrow(/acceptance|metadata|artifact|contract/iu);
    } finally {
      await leavePostHost();
    }
  }, HEAVY_TIMEOUT_MS);
});
