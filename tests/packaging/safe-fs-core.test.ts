import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAcceptanceFsFixtures,
  emptyDirectoryFixture,
  exactDirectoryFixture,
  ownedTreeFixture,
  regularFileFixture,
} from "./helpers/acceptance-fs-fixture";

const lstatRace = vi.hoisted(() => ({
  path: "",
  seen: 0,
  triggerAt: 0,
  action: null as null | (() => Promise<void>),
}));

const unlinkRace = vi.hoisted(() => ({
  path: "",
  action: null as null | (() => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: unknown[]) => {
      const result: unknown = await Reflect.apply(actual.lstat, actual, args);
      if (String(args[0]) === lstatRace.path) {
        lstatRace.seen += 1;
        if (lstatRace.seen === lstatRace.triggerAt && lstatRace.action !== null) {
          const action = lstatRace.action;
          lstatRace.action = null;
          await action();
        }
      }
      return result;
    },
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

function scheduleAfterLstat(path: string, triggerAt: number, action: () => Promise<void>): void {
  lstatRace.path = path;
  lstatRace.seen = 0;
  lstatRace.triggerAt = triggerAt;
  lstatRace.action = action;
}

function resetLstatRace(): void {
  lstatRace.path = "";
  lstatRace.seen = 0;
  lstatRace.triggerAt = 0;
  lstatRace.action = null;
}

function scheduleAfterUnlink(path: string, action: () => Promise<void>): void {
  unlinkRace.path = path;
  unlinkRace.action = action;
}

function resetUnlinkRace(): void {
  unlinkRace.path = "";
  unlinkRace.action = null;
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

interface DirectorySnapshot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ExactDirectorySnapshot extends DirectorySnapshot {
  readonly names: readonly string[];
  readonly files: ReadonlyMap<string, FrozenFile>;
}

interface OwnedTreeSnapshot {
  readonly root: DirectorySnapshot;
  readonly entries: ReadonlyMap<string, Readonly<{
    type: "directory" | "file";
    dev: bigint;
    ino: bigint;
    nlink: bigint;
    size: bigint;
    sha256?: string;
  }>>;
}

interface LockLease { readonly __opaque: unique symbol }

interface SafeFsCoreModule {
  readFrozenRegularFile(path: string, label: string): Promise<FrozenFile>;
  assertFrozenRegularFile(snapshot: FrozenFile, label: string): Promise<void>;
  snapshotExactDirectory(path: string, names: readonly string[], label: string): Promise<ExactDirectorySnapshot>;
  assertExactDirectory(snapshot: ExactDirectorySnapshot, label: string): Promise<void>;
  snapshotOwnedTree(root: string, completeAllowlist: readonly string[], label: string): Promise<OwnedTreeSnapshot>;
  assertOwnedTree(snapshot: OwnedTreeSnapshot, label: string): Promise<void>;
  writeExclusiveRegularFile(path: string, bytes: Uint8Array, label: string): Promise<FrozenFile>;
  withExclusiveIdentityLock<T>(input: Readonly<{
    parent: DirectorySnapshot;
    name: string;
    label: string;
  }>, callback: (lease: LockLease) => Promise<T>): Promise<T>;
  removeOwnedTreeBottomUp(snapshot: OwnedTreeSnapshot, label: string): Promise<void>;
}

// @ts-expect-error The filesystem core is intentionally plain ESM without a declaration file.
const core = await import("../../scripts/safe-fs-core.mjs") as unknown as SafeFsCoreModule;

afterEach(async () => {
  resetLstatRace();
  resetUnlinkRace();
  await cleanupAcceptanceFsFixtures();
});

describe("safe filesystem core", () => {
  it("freezes regular-file bytes and complete evidence", async () => {
    const value = await regularFileFixture("SAFE-BYTES");

    const frozen = await core.readFrozenRegularFile(value.path, "fixture");

    expect(frozen.path).toBe(value.path);
    expect(frozen.bytes.toString("utf8")).toBe("SAFE-BYTES");
    expect(frozen.evidence).toMatchObject({ nlink: 1n, size: 10n });
    expect(frozen.evidence.sha256).toBe(
      createHash("sha256").update("SAFE-BYTES").digest("hex"),
    );
  });

  it("rejects multiply linked regular files", async () => {
    const value = await regularFileFixture("SAFE-BYTES");
    await link(value.path, value.hardLink);
    await expect(core.readFrozenRegularFile(value.path, "fixture"))
      .rejects.toThrow(/single link|hard link|nlink/iu);
  });

  it("rejects a FIFO within 500ms without waiting for a writer", async () => {
    const value = await regularFileFixture("FIFO-PLACEHOLDER");
    await unlink(value.path);
    execFileSync("mkfifo", [value.path]);
    const readResult = core.readFrozenRegularFile(value.path, "fixture FIFO").then(
      () => Object.freeze({ kind: "resolved" as const }),
      (error: unknown) => Object.freeze({ kind: "rejected" as const, error }),
    );
    let outcome: Awaited<typeof readResult> | Readonly<{ kind: "timeout" }>;
    let cleanupError: unknown = null;

    try {
      outcome = await Promise.race([
        readResult,
        delay(500, Object.freeze({ kind: "timeout" as const })),
      ]);
    } finally {
      try {
        const writer = await open(value.path, constants.O_WRONLY | constants.O_NONBLOCK);
        await writer.close();
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
        if (code !== "ENXIO" && code !== "ENOENT") cleanupError = error;
      }
      await Promise.race([
        readResult,
        delay(500),
      ]);
      await unlink(value.path).catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
        if (code !== "ENOENT" && cleanupError === null) cleanupError = error;
      });
    }

    if (cleanupError !== null) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("FIFO test cleanup failed");
    }
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(String(outcome.error)).toMatch(/regular file|FIFO|file type/iu);
    }
  });

  it("detects same-inode same-size byte changes", async () => {
    const value = await regularFileFixture("SAFE-BYTES");
    const frozen = await core.readFrozenRegularFile(value.path, "fixture");
    await writeFile(value.path, "EVIL-BYTES");
    await expect(core.assertFrozenRegularFile(frozen, "fixture"))
      .rejects.toThrow(/changed|snapshot/iu);
  });

  it("captures and revalidates an exact directory", async () => {
    const value = await exactDirectoryFixture();
    const snapshot = await core.snapshotExactDirectory(value.root, value.names, "exact directory");
    expect(snapshot.names).toEqual(["alpha.txt", "beta.txt"]);
    await expect(core.assertExactDirectory(snapshot, "exact directory")).resolves.toBeUndefined();

    await writeFile(join(value.root, "unknown.txt"), "KEEP", "utf8");
    await expect(core.assertExactDirectory(snapshot, "exact directory"))
      .rejects.toThrow(/exact|unknown|changed|snapshot/iu);
  });

  it("captures and revalidates every allowlisted owned-tree entry", async () => {
    const value = await ownedTreeFixture();
    const snapshot = await core.snapshotOwnedTree(value.root, value.allowlist, "owned tree");
    expect([...snapshot.entries.keys()].sort()).toEqual([...value.allowlist].sort());
    await expect(core.assertOwnedTree(snapshot, "owned tree")).resolves.toBeUndefined();

    await writeFile(join(value.root, "nested", "value.txt"), "CHANGED", "utf8");
    await expect(core.assertOwnedTree(snapshot, "owned tree"))
      .rejects.toThrow(/changed|snapshot/iu);
  });

  it("rejects a child directory replaced between discovery and recursive capture", async () => {
    const value = await ownedTreeFixture();
    const nested = join(value.root, "nested");
    const moved = join(dirname(value.root), "original-nested");
    scheduleAfterLstat(nested, 1, async () => {
      await rename(nested, moved);
      await mkdir(nested);
      await writeFile(join(nested, "value.txt"), "REPLACED", "utf8");
    });

    await expect(core.snapshotOwnedTree(value.root, value.allowlist, "owned tree"))
      .rejects.toThrow(/changed|identity|replacement|snapshot/iu);
    await expect(readFile(join(nested, "value.txt"), "utf8")).resolves.toBe("REPLACED");
  });

  it("stops owned-tree cleanup when an unknown entry appears", async () => {
    const value = await ownedTreeFixture();
    const snapshot = await core.snapshotOwnedTree(value.root, value.allowlist, "owned tree");
    await writeFile(join(value.root, "unknown"), "KEEP");
    await expect(core.removeOwnedTreeBottomUp(snapshot, "owned tree"))
      .rejects.toThrow(/unknown|changed|cleanup/iu);
    await expect(readFile(join(value.root, "unknown"), "utf8")).resolves.toBe("KEEP");
    await expect(readFile(join(value.root, "top.txt"), "utf8")).resolves.toBe("TOP");
  });

  it("removes a fully proven owned tree bottom-up", async () => {
    const value = await ownedTreeFixture();
    const snapshot = await core.snapshotOwnedTree(value.root, value.allowlist, "owned tree");
    await expect(core.removeOwnedTreeBottomUp(snapshot, "owned tree")).resolves.toBeUndefined();
    await expect(lstat(value.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a new singly linked file exclusively", async () => {
    const root = await emptyDirectoryFixture();
    const path = join(root, "exclusive");
    const frozen = await core.writeExclusiveRegularFile(path, Buffer.from("LOCK"), "exclusive file");
    expect(frozen.evidence).toMatchObject({ nlink: 1n, size: 4n });
    await expect(core.writeExclusiveRegularFile(path, Buffer.from("OTHER"), "exclusive file"))
      .rejects.toThrow(/exclusive|exist|written/iu);
    await expect(readFile(path, "utf8")).resolves.toBe("LOCK");
  });

  it("serializes concurrent lock holders and removes the exact lock", async () => {
    const root = await emptyDirectoryFixture();
    const parent = await core.snapshotExactDirectory(root, [], "lock parent");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const first = core.withExclusiveIdentityLock(
      { parent, name: ".acceptance.lock", label: "acceptance lock" },
      async () => {
        entered();
        await gate;
        return "first";
      },
    );
    await active;
    const secondCallback = vi.fn(async () => "second");
    await expect(core.withExclusiveIdentityLock(
      { parent, name: ".acceptance.lock", label: "acceptance lock" },
      secondCallback,
    )).rejects.toThrow(/already exists|concurrent|stale|lock/iu);
    expect(secondCallback).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toBe("first");
    expect(await readdir(root)).toEqual([]);
  });

  it("lets a new holder acquire the lock immediately after the prior owned unlink", async () => {
    const root = await emptyDirectoryFixture();
    const parent = await core.snapshotExactDirectory(root, [], "lock parent");
    const lockInput = { parent, name: ".acceptance.lock", label: "acceptance lock" };
    const lockPath = join(root, lockInput.name);
    let secondEntered!: () => void;
    let releaseSecond!: () => void;
    const entered = new Promise<void>((resolve) => { secondEntered = resolve; });
    const holdSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let second: Promise<string> | null = null;

    scheduleAfterUnlink(lockPath, async () => {
      second = core.withExclusiveIdentityLock(lockInput, async () => {
        secondEntered();
        await holdSecond;
        return "second";
      });
      await entered;
    });

    const firstOutcome = await core.withExclusiveIdentityLock(
      lockInput,
      async () => "first",
    ).then(
      (value) => Object.freeze({ status: "fulfilled" as const, value }),
      (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
    );
    const activeSecond = second;
    if (activeSecond === null) throw new Error("the second lock holder never acquired the released path");
    const secondLockBytes = await readFile(lockPath, "utf8");
    releaseSecond();
    await expect(activeSecond).resolves.toBe("second");

    expect(firstOutcome).toEqual({ status: "fulfilled", value: "first" });
    expect(secondLockBytes).toContain('"schemaVersion":1');
    expect(await readdir(root)).toEqual([]);
  });

  it("never steals a stale lock", async () => {
    const root = await emptyDirectoryFixture();
    const parent = await core.snapshotExactDirectory(root, [], "lock parent");
    const lockPath = join(root, ".acceptance.lock");
    await writeFile(lockPath, "STALE", "utf8");
    const callback = vi.fn(async () => undefined);

    await expect(core.withExclusiveIdentityLock(
      { parent, name: ".acceptance.lock", label: "acceptance lock" },
      callback,
    )).rejects.toThrow(/already exists|concurrent|stale|lock/iu);
    expect(callback).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("STALE");
  });

  it("does not enter the lock callback when the new lock is replaced after creation", async () => {
    const root = await emptyDirectoryFixture();
    const parent = await core.snapshotExactDirectory(root, [], "lock parent");
    const lockPath = join(root, ".acceptance.lock");
    scheduleAfterLstat(lockPath, 2, async () => {
      await unlink(lockPath);
      await writeFile(lockPath, "PRE-CALLBACK-REPLACEMENT", "utf8");
    });
    const callback = vi.fn(async () => undefined);

    await expect(core.withExclusiveIdentityLock(
      { parent, name: ".acceptance.lock", label: "acceptance lock" },
      callback,
    )).rejects.toThrow(/changed|replacement|cleanup|incomplete/iu);
    expect(callback).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("PRE-CALLBACK-REPLACEMENT");
  });

  it("does not enter the lock callback when the parent is replaced after lock creation", async () => {
    const root = await emptyDirectoryFixture();
    const parent = await core.snapshotExactDirectory(root, [], "lock parent");
    const lockName = ".acceptance.lock";
    const lockPath = join(root, lockName);
    const movedParent = join(dirname(root), "original-parent");
    scheduleAfterLstat(lockPath, 2, async () => {
      await rename(root, movedParent);
      await mkdir(root);
      await writeFile(lockPath, "PARENT-REPLACEMENT", "utf8");
    });
    const callback = vi.fn(async () => undefined);

    await expect(core.withExclusiveIdentityLock(
      { parent, name: lockName, label: "acceptance lock" },
      callback,
    )).rejects.toThrow(/changed|identity|cleanup|incomplete/iu);
    expect(callback).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("PARENT-REPLACEMENT");
    await expect(readFile(join(movedParent, lockName), "utf8")).resolves.toContain('"schemaVersion":1');
  });

  it("retains and reports a lock replacement", async () => {
    const root = await emptyDirectoryFixture();
    const parent = await core.snapshotExactDirectory(root, [], "lock parent");
    const lockPath = join(root, ".acceptance.lock");

    await expect(core.withExclusiveIdentityLock(
      { parent, name: ".acceptance.lock", label: "acceptance lock" },
      async () => {
        await unlink(lockPath);
        await writeFile(lockPath, "REPLACEMENT", "utf8");
      },
    )).rejects.toThrow(/changed|replacement|cleanup|incomplete/iu);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("REPLACEMENT");
  });
});
