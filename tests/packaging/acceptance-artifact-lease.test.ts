import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const unlinkRace = vi.hoisted(() => ({
  path: "",
  action: null as null | (() => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await actual.unlink(...args);
      if (String(args[0]) === unlinkRace.path && unlinkRace.action !== null) {
        const action = unlinkRace.action;
        unlinkRace.action = null;
        await action();
      }
    },
  };
});

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const currentManifest = JSON.parse(await readFile(join(projectRoot, "manifest.json"), "utf8")) as {
  readonly version: string;
};
const currentPluginVersion = currentManifest.version;
const currentAcceptanceBinding = `knowledge-workbench@${currentPluginVersion}:read-only-acceptance`;
const HEAVY_TIMEOUT_MS = 600_000;
const roots: string[] = [];

interface AcceptanceArtifactLease { readonly __opaque: unique symbol }

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
  readonly names: readonly ["acceptance-build.json", "main.js", "manifest.json", "styles.css"];
  readonly files: ReadonlyMap<string, FrozenFile>;
}

type HookName = "afterStageCreate" | "beforeBundle" | "afterStageValidation" | "afterBackup" | "afterPublish";
interface HookContext {
  readonly repoRoot: string;
  readonly dist: string;
  readonly target: string;
  readonly stage: string;
  readonly backup: string | null;
  readonly lock: string;
}
type AcceptanceBuildHooks = Partial<Record<HookName, (context: HookContext) => void | Promise<void>>>;
interface AcceptanceBuildResult {
  readonly target: string;
  readonly artifacts: readonly string[];
}

interface BuilderModule {
  readonly ACCEPTANCE_FILES: AcceptanceArtifactSnapshot["names"];
  withAcceptanceArtifactLock<T>(
    repoRoot: string,
    callback: (lease: AcceptanceArtifactLease) => Promise<T>,
  ): Promise<T>;
  buildAcceptanceArtifactUnderLease(options: Readonly<{
    lease: AcceptanceArtifactLease;
    hooks?: AcceptanceBuildHooks;
  }>): Promise<AcceptanceBuildResult>;
  loadAcceptanceArtifactSource(options: Readonly<{
    lease: AcceptanceArtifactLease;
  }>): Promise<AcceptanceArtifactSnapshot>;
  buildAcceptanceArtifact(options: Readonly<{
    repoRoot: string;
    hooks?: AcceptanceBuildHooks;
  }>): Promise<AcceptanceBuildResult>;
}

interface ContractModule {
  readonly ACCEPTANCE_FILES: AcceptanceArtifactSnapshot["names"];
  readonly FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT: readonly string[];
  validateAcceptanceArtifactSnapshot(
    snapshot: AcceptanceArtifactSnapshot,
  ): Readonly<{ pluginVersion: string; artifactBinding: string }>;
  computeAcceptanceArtifactSetDigest(snapshot: AcceptanceArtifactSnapshot): string;
}

// @ts-expect-error The filesystem builder is intentionally plain ESM without a declaration file.
const builder = await import("../../scripts/acceptance-build.mjs") as unknown as BuilderModule;
// @ts-expect-error The filesystem contract is intentionally plain ESM without a declaration file.
const contract = await import("../../scripts/acceptance-artifact-contract.mjs") as unknown as ContractModule;

afterEach(async () => {
  unlinkRace.path = "";
  unlinkRace.action = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}, HEAVY_TIMEOUT_MS);

function scheduleAfterUnlink(path: string, action: () => Promise<void>): void {
  unlinkRace.path = path;
  unlinkRace.action = action;
}

async function fixture(): Promise<string> {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-artifact-lease-")));
  roots.push(repoRoot);
  await cp(join(projectRoot, "src"), join(repoRoot, "src"), { recursive: true });
  for (const file of ["manifest.json", "package.json", "styles.css"]) {
    await cp(join(projectRoot, file), join(repoRoot, file));
  }
  return repoRoot;
}

function independentArtifactSetDigest(snapshot: AcceptanceArtifactSnapshot): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from("knowledge-workbench-acceptance-artifact-set-v1\0", "ascii"));
  const names = [...snapshot.names].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of names) {
    const file = snapshot.files.get(name);
    if (file === undefined) throw new Error(`missing test artifact ${name}`);
    const nameBytes = Buffer.from(name, "utf8");
    const nameLength = Buffer.alloc(8);
    nameLength.writeBigUInt64BE(BigInt(nameBytes.byteLength));
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(file.bytes.byteLength));
    hash.update(nameLength);
    hash.update(nameBytes);
    hash.update(contentLength);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

describe("acceptance artifact continuous lease", () => {
  it("builds and freezes the exact source set under one opaque active lease", async () => {
    const repoRoot = await fixture();

    await builder.withAcceptanceArtifactLock(repoRoot, async (lease) => {
      expect(Object.isFrozen(lease)).toBe(true);
      expect(Reflect.ownKeys(lease)).toEqual([]);

      await expect(builder.buildAcceptanceArtifactUnderLease({ lease })).resolves.toMatchObject({
        target: join(repoRoot, "dist", "read-only-acceptance"),
        artifacts: [...builder.ACCEPTANCE_FILES],
      });
      const source = await builder.loadAcceptanceArtifactSource({ lease });
      expect(source.names).toEqual(contract.ACCEPTANCE_FILES);
      expect([...source.files.keys()]).toEqual(contract.ACCEPTANCE_FILES);
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.directory)).toBe(true);
      expect(Object.isFrozen(source.names)).toBe(true);
      for (const file of source.files.values()) {
        expect(Object.isFrozen(file)).toBe(true);
        expect(Object.isFrozen(file.evidence)).toBe(true);
      }
      expect(contract.validateAcceptanceArtifactSnapshot(source)).toEqual({
        pluginVersion: currentPluginVersion,
        artifactBinding: currentAcceptanceBinding,
      });
      expect(contract.computeAcceptanceArtifactSetDigest(source)).toBe(independentArtifactSetDigest(source));

      const bundle = source.files.get("main.js");
      if (bundle === undefined) throw new Error("expected frozen main.js");
      const diskBytes = await readFile(bundle.path);
      bundle.bytes[0] = (bundle.bytes[0] ?? 0) ^ 0xff;
      const reloaded = await builder.loadAcceptanceArtifactSource({ lease });
      expect(reloaded.files.get("main.js")?.bytes).toEqual(diskBytes);
      return undefined;
    });
  }, HEAVY_TIMEOUT_MS);

  it("rejects a forged lease object for every leased operation", async () => {
    const forged = Object.freeze({}) as AcceptanceArtifactLease;
    for (const operation of [
      () => builder.buildAcceptanceArtifactUnderLease({ lease: forged }),
      () => builder.loadAcceptanceArtifactSource({ lease: forged }),
    ]) {
      await expect(operation()).rejects.toThrow(/active|forged|lease/iu);
    }
  }, HEAVY_TIMEOUT_MS);

  it("expires a retained lease before the callback lock cleanup", async () => {
    const repoRoot = await fixture();
    let retained!: AcceptanceArtifactLease;
    await builder.withAcceptanceArtifactLock(repoRoot, async (lease) => {
      retained = lease;
      return undefined;
    });

    for (const operation of [
      () => builder.buildAcceptanceArtifactUnderLease({ lease: retained }),
      () => builder.loadAcceptanceArtifactSource({ lease: retained }),
    ]) {
      await expect(operation()).rejects.toThrow(/active|expired|lease/iu);
    }
  }, HEAVY_TIMEOUT_MS);

  it("lets a new artifact lease acquire the lock immediately after the prior owned unlink", async () => {
    const repoRoot = await fixture();
    const lockPath = join(repoRoot, "dist", ".read-only-acceptance.lock");
    let secondEntered!: () => void;
    let releaseSecond!: () => void;
    const entered = new Promise<void>((resolve) => { secondEntered = resolve; });
    const holdSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let second: Promise<string> | null = null;

    scheduleAfterUnlink(lockPath, async () => {
      second = builder.withAcceptanceArtifactLock(repoRoot, async () => {
        secondEntered();
        await holdSecond;
        return "second";
      });
      await entered;
    });

    const firstOutcome = await builder.withAcceptanceArtifactLock(
      repoRoot,
      async () => "first",
    ).then(
      (value) => Object.freeze({ status: "fulfilled" as const, value }),
      (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
    );
    const activeSecond = second;
    if (activeSecond === null) throw new Error("the second artifact lease never acquired the released path");
    const secondLockBytes = await readFile(lockPath, "utf8");
    releaseSecond();
    await expect(activeSecond).resolves.toBe("second");

    expect(firstOutcome).toEqual({ status: "fulfilled", value: "first" });
    expect(secondLockBytes).toContain('"schemaVersion":1');
    await expect(readdir(join(repoRoot, "dist"))).resolves.toEqual([]);
  }, HEAVY_TIMEOUT_MS);

  it("rejects a null callback failure and still removes the owned lock", async () => {
    const repoRoot = await fixture();

    await expect(builder.withAcceptanceArtifactLock(repoRoot, async () => {
      // JavaScript permits arbitrary thrown values; the lease wrapper must preserve them.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise arbitrary thrown-value preservation.
      throw null;
    })).rejects.toBeNull();

    await expect(readdir(join(repoRoot, "dist"))).resolves.toEqual([]);
  }, HEAVY_TIMEOUT_MS);

  it("rejects repository-root replacement even when the original dist and lock keep their paths", async () => {
    const repoRoot = await fixture();
    const replacementRoot = await fixture();
    const movedOriginalRoot = `${repoRoot}-original`;
    roots.push(movedOriginalRoot);

    await builder.withAcceptanceArtifactLock(repoRoot, async (lease) => {
      const distBefore = await lstat(join(repoRoot, "dist"), { bigint: true });
      const lockBefore = await lstat(join(repoRoot, "dist", ".read-only-acceptance.lock"), { bigint: true });
      await rename(repoRoot, movedOriginalRoot);
      await rename(replacementRoot, repoRoot);
      await rename(join(movedOriginalRoot, "dist"), join(repoRoot, "dist"));
      const distAfter = await lstat(join(repoRoot, "dist"), { bigint: true });
      const lockAfter = await lstat(join(repoRoot, "dist", ".read-only-acceptance.lock"), { bigint: true });
      expect({ dev: distAfter.dev, ino: distAfter.ino }).toEqual({ dev: distBefore.dev, ino: distBefore.ino });
      expect({ dev: lockAfter.dev, ino: lockAfter.ino }).toEqual({ dev: lockBefore.dev, ino: lockBefore.ino });

      await expect(builder.buildAcceptanceArtifactUnderLease({ lease }))
        .rejects.toThrow(/Repository root identity changed/u);
      await expect(readFile(join(repoRoot, "dist", "read-only-acceptance", "main.js")))
        .rejects.toThrow(/ENOENT|no such file/iu);
      return undefined;
    });

    await expect(readdir(join(repoRoot, "dist"))).resolves.toEqual([]);
  }, HEAVY_TIMEOUT_MS);

  it("rejects a caller-supplied repository on an otherwise active lease", async () => {
    const first = await fixture();
    const second = await fixture();

    await builder.withAcceptanceArtifactLock(first, async (lease) => {
      await expect(builder.buildAcceptanceArtifactUnderLease({
        lease,
        repoRoot: second,
      } as unknown as { lease: AcceptanceArtifactLease })).rejects.toThrow(/option|repoRoot|repository|lease/iu);
      expect(await readFile(join(second, "manifest.json"), "utf8")).toContain("knowledge-workbench");
      return undefined;
    });
  }, HEAVY_TIMEOUT_MS);

  it("rejects nested or double acquisition for the same repository", async () => {
    const repoRoot = await fixture();

    await builder.withAcceptanceArtifactLock(repoRoot, async () => {
      await expect(builder.withAcceptanceArtifactLock(repoRoot, async () => undefined))
        .rejects.toThrow(/already exists|concurrent|lock/iu);
      return undefined;
    });
  }, HEAVY_TIMEOUT_MS);

  it("lets an installer-equivalent paused lease block the standalone builder", async () => {
    const repoRoot = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const installerEquivalent = builder.withAcceptanceArtifactLock(repoRoot, async () => {
      entered();
      await paused;
      return "released";
    });
    await acquired;

    try {
      await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/already exists|concurrent|lock/iu);
    } finally {
      release();
    }
    await expect(installerEquivalent).resolves.toBe("released");
  }, HEAVY_TIMEOUT_MS);

  it("allows only one of two concurrent standalone builders to hold the lease", async () => {
    const repoRoot = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const first = builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        beforeBundle: async () => {
          entered();
          await paused;
        },
      },
    });
    await acquired;

    try {
      await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/already exists|concurrent|lock/iu);
    } finally {
      release();
    }
    await expect(first).resolves.toMatchObject({ target: join(repoRoot, "dist", "read-only-acceptance") });
  }, HEAVY_TIMEOUT_MS);

  it("returns fresh bytes for every access to one file in the same source snapshot", async () => {
    const repoRoot = await fixture();

    await builder.withAcceptanceArtifactLock(repoRoot, async (lease) => {
      await builder.buildAcceptanceArtifactUnderLease({ lease });
      const source = await builder.loadAcceptanceArtifactSource({ lease });
      const bundle = source.files.get("main.js");
      if (bundle === undefined) throw new Error("expected frozen main.js");
      const expected = Buffer.from(bundle.bytes);
      const mutated = bundle.bytes;
      mutated[0] = (mutated[0] ?? 0) ^ 0xff;

      expect(bundle.bytes).not.toBe(mutated);
      expect(bundle.bytes).toEqual(expected);
      expect(contract.validateAcceptanceArtifactSnapshot(source)).toEqual({
        pluginVersion: currentPluginVersion,
        artifactBinding: currentAcceptanceBinding,
      });
      return undefined;
    });
  }, HEAVY_TIMEOUT_MS);
});
