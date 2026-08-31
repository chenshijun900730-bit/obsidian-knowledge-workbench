import { createHash } from "node:crypto";
import {
  cp,
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
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];
type HookName = "afterStageCreate" | "beforeBundle" | "afterStageValidation" | "afterBackup" | "afterPublish";
interface HookContext {
  readonly repoRoot: string;
  readonly dist: string;
  readonly target: string;
  readonly stage: string;
  readonly backup: string | null;
  readonly lock: string;
}
interface BuilderModule {
  readonly ACCEPTANCE_FILES: readonly string[];
  acceptanceMetadata(version: string): Readonly<Record<string, unknown>>;
  buildAcceptanceArtifact(options?: Readonly<{
    repoRoot?: string;
    hooks?: Partial<Record<HookName, (context: HookContext) => void | Promise<void>>>;
  }>): Promise<Readonly<{ target: string; artifacts: readonly string[] }>>;
}
// @ts-expect-error The filesystem builder is intentionally plain ESM without a declaration file.
const builder = await import("../../scripts/acceptance-build.mjs") as unknown as BuilderModule;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<string> {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-acceptance-build-")));
  roots.push(repoRoot);
  await cp(join(projectRoot, "src"), join(repoRoot, "src"), { recursive: true });
  for (const file of ["manifest.json", "package.json", "styles.css"]) {
    await cp(join(projectRoot, file), join(repoRoot, file));
  }
  await writeFile(join(repoRoot, "main.js"), "NORMAL-MAIN-SENTINEL\n", "utf8");
  return repoRoot;
}

const targetOf = (repoRoot: string): string => join(repoRoot, "dist", "read-only-acceptance");

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileEvidence(path: string) {
  const stat = await lstat(path, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    sha256: await sha256(path),
  };
}

async function artifactHashes(repoRoot: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of builder.ACCEPTANCE_FILES) {
    hashes[file] = await sha256(join(targetOf(repoRoot), file));
  }
  return hashes;
}

async function artifactEvidence(repoRoot: string) {
  const target = targetOf(repoRoot);
  const stat = await lstat(target, { bigint: true });
  const files: Record<string, Awaited<ReturnType<typeof fileEvidence>>> = {};
  for (const file of builder.ACCEPTANCE_FILES) {
    files[file] = await fileEvidence(join(target, file));
  }
  return {
    directory: { dev: stat.dev, ino: stat.ino },
    files,
  };
}

async function expectNoTarget(repoRoot: string): Promise<void> {
  await expect(lstat(targetOf(repoRoot))).rejects.toThrow();
}

async function updateNormalIdentity(
  repoRoot: string,
  updates: Readonly<Record<string, unknown>>,
): Promise<void> {
  const manifestPath = join(repoRoot, "manifest.json");
  const packagePath = join(repoRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
  const nextManifest = { ...manifest, ...updates };
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  await writeFile(
    packagePath,
    `${JSON.stringify({ ...packageJson, version: nextManifest.version }, null, 2)}\n`,
    "utf8",
  );
}

describe("read-only acceptance artifact builder", () => {
  it("publishes exactly four version-bound files without touching normal artifacts", async () => {
    const repoRoot = await fixture();
    const normalBefore = await Promise.all(
      ["main.js", "manifest.json", "styles.css"].map((file) => readFile(join(repoRoot, file), "utf8")),
    );
    const normalEvidenceBefore = await Promise.all(
      ["main.js", "manifest.json", "styles.css"].map((file) => fileEvidence(join(repoRoot, file))),
    );
    const normalManifest = JSON.parse(normalBefore[1]!) as Readonly<{ version: string }>;

    await builder.buildAcceptanceArtifact({ repoRoot });

    const target = join(repoRoot, "dist", "read-only-acceptance");
    expect((await readdir(target)).sort()).toEqual([
      "acceptance-build.json",
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    expect(JSON.parse(await readFile(join(target, "acceptance-build.json"), "utf8")))
      .toEqual(builder.acceptanceMetadata(normalManifest.version));
    expect(await Promise.all(
      ["main.js", "manifest.json", "styles.css"].map((file) => readFile(join(repoRoot, file), "utf8")),
    )).toEqual(normalBefore);
    expect(await Promise.all(
      ["main.js", "manifest.json", "styles.css"].map((file) => fileEvidence(join(repoRoot, file))),
    )).toEqual(normalEvidenceBefore);
  });

  it("excludes normal-only TXT, hybrid storage, credentials, and verification capabilities", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    const bundle = await readFile(join(targetOf(repoRoot), "main.js"), "utf8");

    for (const forbidden of [
      "node:fs",
      "Local inventory TXT (session only)",
      "catalog-preview-txt",
      "catalog-import-txt",
      "catalog-start-large-scan",
      "catalog-resume-large-scan",
      "candidate-active.json",
      "LocalHybridCatalogAdapter",
      "BaiduCatalogSourceAdapter",
      "SecretStorage",
      "secretStorage",
      "requestUrl",
      "directoryPicker.",
      "CloudDirectoryDiscoveryService",
      "CloudDirectoryBrowserService",
      "CloudDirectoryLocatorService",
      "cloud-directory-root-consent-required",
      "Locate same-name folders in Baidu Netdisk",
      "Fixed limit: {directories} folders, {requests} list requests, and {seconds} seconds.",
      "\u5728\u7f51\u76d8\u4e2d\u5b9a\u4f4d\u540c\u540d\u76ee\u5f55",
      "\u4ece\u767e\u5ea6\u7f51\u76d8\u6839\u76ee\u5f55\u6d4f\u89c8",
      "\u56fa\u5b9a\u4e0a\u9650\uff1a{directories} \u4e2a\u76ee\u5f55\u3001{requests} \u6b21\u5217\u8868\u8bf7\u6c42\u3001{seconds} \u79d2\u3002",
      "https://openapi.baidu.com/oauth/2.0/authorize",
      "https://openapi.baidu.com/oauth/2.0/token",
      "/rest/2.0/xpan/file",
    ]) {
      expect(bundle, forbidden).not.toContain(forbidden);
    }
  });

  it("writes exact newline-terminated metadata and changes only the manifest display name", async () => {
    const repoRoot = await fixture();
    const normalManifest = JSON.parse(await readFile(join(repoRoot, "manifest.json"), "utf8")) as Record<string, unknown>;

    await builder.buildAcceptanceArtifact({ repoRoot });

    const metadataText = await readFile(join(targetOf(repoRoot), "acceptance-build.json"), "utf8");
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    expect(metadataText.endsWith("\n")).toBe(true);
    expect(Object.keys(metadata).sort()).toEqual([
      "artifactBinding",
      "buildMode",
      "contentWrites",
      "network",
      "pluginVersion",
      "schemaVersion",
    ]);
    expect(metadataText).not.toMatch(/vault|endpoint|model|secret|note|state|journal/iu);
    const acceptanceManifest = JSON.parse(
      await readFile(join(targetOf(repoRoot), "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(acceptanceManifest).toEqual({
      ...normalManifest,
      name: "Knowledge Workbench (Read-only acceptance)",
    });
    expect({ ...acceptanceManifest, name: normalManifest.name }).toEqual(normalManifest);
  });

  it("is deterministic across different canonical roots and source mtimes", async () => {
    const first = await fixture();
    const second = await fixture();
    await utimes(join(first, "styles.css"), new Date(1_000), new Date(2_000));
    await utimes(join(second, "styles.css"), new Date(3_000), new Date(4_000));

    await builder.buildAcceptanceArtifact({ repoRoot: first });
    await builder.buildAcceptanceArtifact({ repoRoot: second });

    expect(await artifactHashes(second)).toEqual(await artifactHashes(first));
  });

  it("rejects noncanonical roots and symlinked required sources before creating dist", async () => {
    const relative = await fixture();
    await expect(builder.buildAcceptanceArtifact({ repoRoot: "relative-repo" })).rejects.toThrow(/absolute/u);
    expect(await readdir(relative)).not.toContain("dist");

    const linkedRoot = await fixture();
    const link = join(dirname(linkedRoot), `${linkedRoot.split("/").at(-1)}-link`);
    roots.push(link);
    await symlink(linkedRoot, link, "dir");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: link })).rejects.toThrow(/canonical|symlink/u);
    expect(await readdir(linkedRoot)).not.toContain("dist");

    for (const source of ["package.json", "manifest.json", "styles.css", "src/main-acceptance.ts"]) {
      const repoRoot = await fixture();
      const path = join(repoRoot, source);
      const replacement = join(repoRoot, `.real-${source.replaceAll("/", "-")}`);
      await rename(path, replacement);
      await symlink(replacement, path);
      await expect(builder.buildAcceptanceArtifact({ repoRoot }), source).rejects.toThrow(/regular non-symlink/u);
      expect(await readdir(repoRoot), source).not.toContain("dist");
    }
  });

  it("rejects multiply linked required source files before creating a target", async () => {
    for (const source of ["package.json", "manifest.json", "styles.css", join("src", "main-acceptance.ts")]) {
      const repoRoot = await fixture();
      await link(join(repoRoot, source), join(repoRoot, `hard-link-${source.replaceAll("/", "-")}`));

      await expect(builder.buildAcceptanceArtifact({ repoRoot }))
        .rejects.toThrow(/single link|hard link|nlink/iu);
      await expectNoTarget(repoRoot);
    }
  });

  it("rejects incoherent normal identity and unsafe dist or target objects in place", async () => {
    for (const manifest of [
      { id: "other", name: "Knowledge Workbench", version: "0.1.0" },
      { id: "knowledge-workbench", name: "Knowledge Workbench (Read-only acceptance)", version: "0.1.0" },
      { id: "knowledge-workbench", name: "Knowledge Workbench", version: "01.1.0" },
      { id: "knowledge-workbench", name: "Knowledge Workbench", version: "9999.1.0" },
      { id: "knowledge-workbench", name: "Knowledge Workbench", version: "1.0.0-01" },
      { id: "knowledge-workbench", name: "Knowledge Workbench", version: "1.0.0-a..b" },
    ]) {
      const repoRoot = await fixture();
      await writeFile(join(repoRoot, "manifest.json"), JSON.stringify(manifest), "utf8");
      await writeFile(
        join(repoRoot, "package.json"),
        JSON.stringify({ name: "knowledge-workbench", version: manifest.version }),
        "utf8",
      );
      await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/identity|semantic version|coherent/u);
      expect(await readdir(repoRoot)).not.toContain("dist");
    }

    const mismatch = await fixture();
    await writeFile(join(mismatch, "package.json"), JSON.stringify({ name: "knowledge-workbench", version: "0.2.0" }), "utf8");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: mismatch })).rejects.toThrow(/versions|coherent/u);
    expect(await readdir(mismatch)).not.toContain("dist");

    const distFile = await fixture();
    await writeFile(join(distFile, "dist"), "do-not-remove", "utf8");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: distFile })).rejects.toThrow(/dist.*directory/iu);
    await expect(readFile(join(distFile, "dist"), "utf8")).resolves.toBe("do-not-remove");

    const targetFile = await fixture();
    await mkdir(join(targetFile, "dist"));
    await writeFile(targetOf(targetFile), "do-not-remove", "utf8");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: targetFile })).rejects.toThrow(/target.*directory/iu);
    await expect(readFile(targetOf(targetFile), "utf8")).resolves.toBe("do-not-remove");

    const distLink = await fixture();
    const distOutside = join(distLink, "dist-outside");
    await mkdir(distOutside);
    await writeFile(join(distOutside, "sentinel"), "DIST-SYMLINK-SENTINEL", "utf8");
    await symlink(distOutside, join(distLink, "dist"), "dir");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: distLink })).rejects.toThrow(/dist.*symlink|dist.*directory/iu);
    await expect(readFile(join(distOutside, "sentinel"), "utf8")).resolves.toBe("DIST-SYMLINK-SENTINEL");

    const targetLink = await fixture();
    const targetOutside = join(targetLink, "target-outside");
    await mkdir(join(targetLink, "dist"));
    await mkdir(targetOutside);
    await writeFile(join(targetOutside, "sentinel"), "TARGET-SYMLINK-SENTINEL", "utf8");
    await symlink(targetOutside, targetOf(targetLink), "dir");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: targetLink })).rejects.toThrow(/target.*symlink|target.*directory/iu);
    await expect(readFile(join(targetOutside, "sentinel"), "utf8")).resolves.toBe("TARGET-SYMLINK-SENTINEL");
  });

  it("fails closed on a stale lock and never removes it", async () => {
    const repoRoot = await fixture();
    const dist = join(repoRoot, "dist");
    const lock = join(dist, ".read-only-acceptance.lock");
    await mkdir(dist);
    await writeFile(lock, "STALE-LOCK\n", "utf8");

    await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/lock/u);

    await expect(readFile(lock, "utf8")).resolves.toBe("STALE-LOCK\n");
    await expect(readdir(dist)).resolves.toEqual([".read-only-acceptance.lock"]);
  });

  it("acquires the cooperative builder lock before inspecting an existing target", async () => {
    const repoRoot = await fixture();
    const dist = join(repoRoot, "dist");
    const lock = join(dist, ".read-only-acceptance.lock");
    await mkdir(dist);
    await writeFile(targetOf(repoRoot), "MALFORMED-TARGET\n", "utf8");
    await writeFile(lock, "COOPERATIVE-BUILDER-LOCK\n", "utf8");

    await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/lock/u);

    await expect(readFile(targetOf(repoRoot), "utf8")).resolves.toBe("MALFORMED-TARGET\n");
    await expect(readFile(lock, "utf8")).resolves.toBe("COOPERATIVE-BUILDER-LOCK\n");
  });

  it("serializes concurrent builders with an exclusive lock", async () => {
    const repoRoot = await fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        beforeBundle: async () => {
          enter();
          await blocked;
        },
      },
    });
    await entered;

    await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/lock/u);
    release();
    await expect(first).resolves.toMatchObject({ target: targetOf(repoRoot) });
  });

  it("detects same-inode same-size lock tampering and retains the replacement", async () => {
    const repoRoot = await fixture();
    let replacement = "";
    let lockPath = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        beforeBundle: async ({ lock }) => {
          lockPath = lock;
          const original = await readFile(lock, "utf8");
          replacement = `${original.startsWith("X") ? "Y" : "X"}${original.slice(1)}`;
          await writeFile(lock, replacement, "utf8");
        },
      },
    })).rejects.toThrow(/lock|snapshot|changed/u);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
    await expect(readFile(targetOf(repoRoot), "utf8")).rejects.toThrow();
  });

  it("retains an unproven stage when its initial empty snapshot cannot be established", async () => {
    const repoRoot = await fixture();
    let stagePath = "";
    let caught: unknown;

    try {
      await builder.buildAcceptanceArtifact({
        repoRoot,
        hooks: {
          afterStageCreate: async ({ stage }) => {
            stagePath = stage;
            await writeFile(join(stage, "unknown-before-snapshot"), "UNTRUSTED", "utf8");
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.message).toMatch(/cleanup|rollback incomplete/u);
    expect(aggregate.errors.map((error) => String(error))).toEqual(expect.arrayContaining([
      expect.stringMatching(/initially be empty|snapshot/u),
      expect.stringMatching(/cleanup ownership could not be proved/u),
    ]));
    await expect(readFile(join(stagePath, "unknown-before-snapshot"), "utf8")).resolves.toBe("UNTRUSTED");
    await expectNoTarget(repoRoot);
  });

  it("cleans a proven empty stage when the post-create hook itself fails", async () => {
    const repoRoot = await fixture();

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterStageCreate: () => { throw new Error("injected post-create failure"); },
      },
    })).rejects.toThrow("injected post-create failure");

    await expectNoTarget(repoRoot);
    await expect(readdir(join(repoRoot, "dist"))).resolves.toEqual([]);
  });

  it("revalidates the full stage snapshot after hooks and retains tampered stages", async () => {
    const repoRoot = await fixture();
    let stagePath = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterStageValidation: async ({ stage }) => {
          stagePath = stage;
          const path = join(stage, "styles.css");
          const original = await readFile(path, "utf8");
          await writeFile(path, `${original.startsWith("X") ? "Y" : "X"}${original.slice(1)}`, "utf8");
        },
      },
    })).rejects.toThrow(/stage|snapshot|changed|hash/u);

    expect((await readdir(stagePath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
    await expect(lstat(targetOf(repoRoot))).rejects.toThrow();
  });

  it("rejects a same-inode same-size transitive input change after stage validation", async () => {
    const repoRoot = await fixture();
    const transitivePath = join(repoRoot, "src", "runtime", "safety-policy.ts");
    const before = await fileEvidence(transitivePath);

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterStageValidation: async () => {
          const original = await readFile(transitivePath, "utf8");
          const replacement = `${original.startsWith("X") ? "Y" : "X"}${original.slice(1)}`;
          await writeFile(transitivePath, replacement, "utf8");
          const after = await fileEvidence(transitivePath);
          expect(after.ino).toBe(before.ino);
          expect(after.size).toBe(before.size);
          expect(after.sha256).not.toBe(before.sha256);
        },
      },
    })).rejects.toThrow(/input|snapshot|changed|safety-policy/u);

    await expectNoTarget(repoRoot);
  });

  it("retains an unexpected fifth stage file", async () => {
    const repoRoot = await fixture();
    let stagePath = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterStageValidation: async ({ stage }) => {
          stagePath = stage;
          await writeFile(join(stage, "fifth.file"), "preserve", "utf8");
        },
      },
    })).rejects.toThrow(/stage|exact|snapshot|changed/u);

    await expect(readFile(join(stagePath, "fifth.file"), "utf8")).resolves.toBe("preserve");
  });

  it.each([
    ["WebSocket", 'globalThis.console.log(new WebSocket("ws://127.0.0.1"));'],
    ["fetch(", 'void fetch("https://example.invalid/acceptance-tripwire");'],
  ] as const)("rejects a real acceptance bundle containing %s", async (_token, injectedSource) => {
    const repoRoot = await fixture();
    const entry = join(repoRoot, "src", "main-acceptance.ts");
    await writeFile(entry, `${await readFile(entry, "utf8")}\n${injectedSource}\n`, "utf8");

    await expect(builder.buildAcceptanceArtifact({ repoRoot }))
      .rejects.toThrow(/bundle.*forbidden|forbidden.*capability/iu);
    await expectNoTarget(repoRoot);
  });

  it("retains replacements for the owned lock and stage instead of deleting them", async () => {
    const lockRepo = await fixture();
    let lockPath = "";
    await expect(builder.buildAcceptanceArtifact({
      repoRoot: lockRepo,
      hooks: {
        beforeBundle: async ({ lock }) => {
          lockPath = lock;
          await unlink(lock);
          await writeFile(lock, "UNTRUSTED-LOCK-REPLACEMENT\n", "utf8");
        },
      },
    })).rejects.toThrow(/lock|snapshot|changed|rollback incomplete/u);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("UNTRUSTED-LOCK-REPLACEMENT\n");

    const stageRepo = await fixture();
    let stagePath = "";
    let movedPath = "";
    await expect(builder.buildAcceptanceArtifact({
      repoRoot: stageRepo,
      hooks: {
        afterStageValidation: async ({ stage }) => {
          stagePath = stage;
          movedPath = `${stage}-moved`;
          await rename(stage, movedPath);
          await mkdir(stage);
          await writeFile(join(stage, "sentinel"), "UNTRUSTED-STAGE-REPLACEMENT", "utf8");
        },
      },
    })).rejects.toThrow(/stage|identity|snapshot|rollback incomplete/u);
    await expect(readFile(join(stagePath, "sentinel"), "utf8")).resolves.toBe("UNTRUSTED-STAGE-REPLACEMENT");
    expect((await readdir(movedPath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
  });

  it("preserves the cleanup proof failure when stage ownership is lost", async () => {
    const repoRoot = await fixture();
    let stagePath = "";
    let movedPath = "";
    let caught: unknown;

    try {
      await builder.buildAcceptanceArtifact({
        repoRoot,
        hooks: {
          afterStageValidation: async ({ stage }) => {
            stagePath = stage;
            movedPath = `${stage}-moved-for-cleanup-proof`;
            await rename(stage, movedPath);
            await mkdir(stage);
            await writeFile(join(stage, "sentinel"), "UNTRUSTED-STAGE", "utf8");
            throw new Error("injected stage ownership loss");
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.message).toMatch(/cleanup|rollback incomplete/u);
    expect(aggregate.errors.length).toBeGreaterThan(1);
    expect(aggregate.errors.map((error) => String(error))).toEqual(expect.arrayContaining([
      expect.stringMatching(/stage|identity|snapshot|changed/u),
    ]));
    await expect(readFile(join(stagePath, "sentinel"), "utf8")).resolves.toBe("UNTRUSTED-STAGE");
    expect((await readdir(movedPath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
  });

  it("replaces an exact existing artifact and removes only its owned backup", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });

    await expect(builder.buildAcceptanceArtifact({ repoRoot })).resolves.toMatchObject({ target: targetOf(repoRoot) });

    expect((await readdir(targetOf(repoRoot))).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
    expect(await readdir(join(repoRoot, "dist"))).toEqual(["read-only-acceptance"]);
  });

  it("upgrades a self-consistent prior artifact to the requested 0.2.0 build", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    await updateNormalIdentity(repoRoot, { version: "0.2.0" });

    await builder.buildAcceptanceArtifact({ repoRoot });

    const manifest = JSON.parse(await readFile(join(targetOf(repoRoot), "manifest.json"), "utf8")) as Record<string, unknown>;
    const metadata = JSON.parse(await readFile(join(targetOf(repoRoot), "acceptance-build.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.version).toBe("0.2.0");
    expect(metadata).toEqual(builder.acceptanceMetadata("0.2.0"));
    await expect(readFile(join(targetOf(repoRoot), "main.js"), "utf8"))
      .resolves.toContain("knowledge-workbench@0.2.0:read-only-acceptance");
  });

  it("restores the exact old-version artifact when an upgrade fails after publication", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    const oldEvidence = await artifactEvidence(repoRoot);
    const oldManifest = JSON.parse(
      await readFile(join(targetOf(repoRoot), "manifest.json"), "utf8"),
    ) as Readonly<{ version: string }>;
    await updateNormalIdentity(repoRoot, { version: "0.2.0" });

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterPublish: () => { throw new Error("injected upgrade publication failure"); },
      },
    })).rejects.toThrow("injected upgrade publication failure");

    expect(await artifactEvidence(repoRoot)).toEqual(oldEvidence);
    const restoredManifest = JSON.parse(
      await readFile(join(targetOf(repoRoot), "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(restoredManifest.version).toBe(oldManifest.version);
  });

  it("replaces a coherent old artifact when other normal manifest fields change", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    await updateNormalIdentity(repoRoot, {
      description: "Updated acceptance-safe description",
      minAppVersion: "1.9.0",
    });

    await builder.buildAcceptanceArtifact({ repoRoot });

    const manifest = JSON.parse(await readFile(join(targetOf(repoRoot), "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "Knowledge Workbench (Read-only acceptance)",
      description: "Updated acceptance-safe description",
      minAppVersion: "1.9.0",
    });
  });

  it("accepts a coherent old artifact when current source styles have changed", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    await writeFile(join(repoRoot, "styles.css"), "UPDATED-NORMAL-STYLES\n", "utf8");

    await builder.buildAcceptanceArtifact({ repoRoot });

    await expect(readFile(join(targetOf(repoRoot), "styles.css"), "utf8")).resolves.toBe("UPDATED-NORMAL-STYLES\n");
    await expect(readFile(join(repoRoot, "styles.css"), "utf8")).resolves.toBe("UPDATED-NORMAL-STYLES\n");
  });

  it("rejects malformed preexisting targets in place before backup", async () => {
    const fifth = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot: fifth });
    await writeFile(join(targetOf(fifth), "fifth.file"), "DO-NOT-REMOVE", "utf8");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: fifth })).rejects.toThrow(/exact|target|artifact/u);
    await expect(readFile(join(targetOf(fifth), "fifth.file"), "utf8")).resolves.toBe("DO-NOT-REMOVE");

    const metadata = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot: metadata });
    await writeFile(join(targetOf(metadata), "acceptance-build.json"), "{}\n", "utf8");
    await expect(builder.buildAcceptanceArtifact({ repoRoot: metadata })).rejects.toThrow(/metadata|coherent|six/u);
    await expect(readFile(join(targetOf(metadata), "acceptance-build.json"), "utf8")).resolves.toBe("{}\n");

    const linked = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot: linked });
    const manifest = join(targetOf(linked), "manifest.json");
    await unlink(manifest);
    await symlink(join(linked, "manifest.json"), manifest);
    await expect(builder.buildAcceptanceArtifact({ repoRoot: linked })).rejects.toThrow(/regular non-symlink/u);
    expect((await lstat(manifest)).isSymbolicLink()).toBe(true);
  });

  it("cleans owned state on ordinary first-build failures at every boundary", async () => {
    for (const hookName of ["beforeBundle", "afterStageValidation", "afterBackup", "afterPublish"] as const) {
      const repoRoot = await fixture();
      await expect(builder.buildAcceptanceArtifact({
        repoRoot,
        hooks: { [hookName]: () => { throw new Error(`injected ${hookName}`); } },
      }), hookName).rejects.toThrow(`injected ${hookName}`);
      await expectNoTarget(repoRoot);
      expect(await readdir(join(repoRoot, "dist")), hookName).toEqual([]);
    }
  });

  it.each(["afterStageCreate", "beforeBundle"] as const)(
    "rejects null thrown by the %s hook and cleans owned state",
    async (hookName) => {
      const repoRoot = await fixture();

      await expect(builder.buildAcceptanceArtifact({
        repoRoot,
        hooks: {
          [hookName]: () => {
            // JavaScript permits arbitrary thrown values; hook plumbing must preserve them.
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise arbitrary thrown-value preservation.
            throw null;
          },
        },
      }), hookName).rejects.toBeNull();

      await expectNoTarget(repoRoot);
      await expect(readdir(join(repoRoot, "dist"))).resolves.toEqual([]);
    },
  );

  it("restores the exact old artifact on ordinary replacement failures at every boundary", async () => {
    for (const hookName of ["beforeBundle", "afterStageValidation", "afterBackup", "afterPublish"] as const) {
      const repoRoot = await fixture();
      await builder.buildAcceptanceArtifact({ repoRoot });
      const before = await artifactEvidence(repoRoot);
      await expect(builder.buildAcceptanceArtifact({
        repoRoot,
        hooks: { [hookName]: () => { throw new Error(`injected ${hookName}`); } },
      }), hookName).rejects.toThrow(`injected ${hookName}`);
      expect(await artifactEvidence(repoRoot), hookName).toEqual(before);
      expect(await readdir(join(repoRoot, "dist")), hookName).toEqual(["read-only-acceptance"]);
    }
  });

  it("does not restore a same-inode same-size tampered backup", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    let backupPath = "";
    let replacement = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterBackup: async ({ backup }) => {
          if (backup === null) throw new Error("expected backup");
          backupPath = backup;
          const path = join(backup, "styles.css");
          const original = await readFile(path, "utf8");
          replacement = `${original.startsWith("X") ? "Y" : "X"}${original.slice(1)}`;
          await writeFile(path, replacement, "utf8");
        },
      },
    })).rejects.toThrow(/backup retained|rollback incomplete/u);

    await expectNoTarget(repoRoot);
    await expect(readFile(join(backupPath, "styles.css"), "utf8")).resolves.toBe(replacement);
  });

  it("preserves a nonempty target introduced by the afterBackup hook before revalidation", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    let backupPath = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterBackup: async ({ backup, target }) => {
          if (backup === null) throw new Error("expected backup");
          backupPath = backup;
          await mkdir(target);
          await writeFile(join(target, "sentinel"), "CONCURRENT-TARGET", "utf8");
          throw new Error("target interference");
        },
      },
    })).rejects.toThrow(/backup retained|rollback incomplete/u);

    await expect(readFile(join(targetOf(repoRoot), "sentinel"), "utf8")).resolves.toBe("CONCURRENT-TARGET");
    expect((await readdir(backupPath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
  });

  it("retains both an unexpected backup replacement and the moved recovery artifact", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    let backupPath = "";
    let movedPath = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterBackup: async ({ backup }) => {
          if (backup === null) throw new Error("expected backup");
          backupPath = backup;
          movedPath = `${backup}-moved`;
          await rename(backup, movedPath);
          await mkdir(backup);
          await writeFile(join(backup, "sentinel"), "UNTRUSTED-BACKUP-REPLACEMENT", "utf8");
        },
      },
    })).rejects.toThrow(/backup retained|rollback incomplete/u);

    await expect(readFile(join(backupPath, "sentinel"), "utf8")).resolves.toBe("UNTRUSTED-BACKUP-REPLACEMENT");
    expect((await readdir(movedPath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
    await expectNoTarget(repoRoot);
  });

  it("restores an old artifact after afterPublish failure through owned quarantine", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    const before = await artifactEvidence(repoRoot);

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: { afterPublish: () => { throw new Error("post-publish verification failure"); } },
    })).rejects.toThrow("post-publish verification failure");

    expect(await artifactEvidence(repoRoot)).toEqual(before);
    expect(await readdir(join(repoRoot, "dist"))).toEqual(["read-only-acceptance"]);
  });

  it("retains a modified first-build target when ownership can no longer be proved", async () => {
    const repoRoot = await fixture();

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterPublish: async ({ target }) => {
          await writeFile(join(target, "fifth.file"), "UNTRUSTED", "utf8");
        },
      },
    })).rejects.toThrow(/rollback incomplete/u);

    await expect(readFile(join(targetOf(repoRoot), "fifth.file"), "utf8")).resolves.toBe("UNTRUSTED");
  });

  it("retains a modified published target and the old backup on replacement", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    let backupPath = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterPublish: async ({ target, backup }) => {
          if (backup === null) throw new Error("expected backup");
          backupPath = backup;
          await writeFile(join(target, "fifth.file"), "UNTRUSTED-PUBLISHED-TARGET", "utf8");
        },
      },
    })).rejects.toThrow(/backup retained|rollback incomplete/u);

    await expect(readFile(join(targetOf(repoRoot), "fifth.file"), "utf8")).resolves.toBe("UNTRUSTED-PUBLISHED-TARGET");
    expect((await readdir(backupPath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
  });

  it("does not follow a target replacement during post-publish rollback", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    let backupPath = "";
    let movedPublished = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterPublish: async ({ target, backup }) => {
          if (backup === null) throw new Error("expected backup");
          backupPath = backup;
          movedPublished = `${target}-moved-published`;
          await rename(target, movedPublished);
          await mkdir(target);
          await writeFile(join(target, "sentinel"), "UNTRUSTED-TARGET-REPLACEMENT", "utf8");
        },
      },
    })).rejects.toThrow(/backup retained|rollback incomplete/u);

    await expect(readFile(join(targetOf(repoRoot), "sentinel"), "utf8")).resolves.toBe("UNTRUSTED-TARGET-REPLACEMENT");
    expect((await readdir(movedPublished)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
    expect((await readdir(backupPath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
  });

  it("forbids post-publish restore when the backup hash changes without inode or size changes", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    let backupPath = "";
    let replacement = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterPublish: async ({ backup }) => {
          if (backup === null) throw new Error("expected backup");
          backupPath = backup;
          const path = join(backup, "styles.css");
          const original = await readFile(path, "utf8");
          replacement = `${original.startsWith("X") ? "Y" : "X"}${original.slice(1)}`;
          await writeFile(path, replacement, "utf8");
        },
      },
    })).rejects.toThrow(/backup retained|rollback incomplete/u);

    expect((await readdir(targetOf(repoRoot))).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
    await expect(readFile(join(backupPath, "styles.css"), "utf8")).resolves.toBe(replacement);
  });

  it("retains a same-size modified published file and its valid old backup", async () => {
    const repoRoot = await fixture();
    await builder.buildAcceptanceArtifact({ repoRoot });
    let backupPath = "";
    let replacement = "";

    await expect(builder.buildAcceptanceArtifact({
      repoRoot,
      hooks: {
        afterPublish: async ({ target, backup }) => {
          if (backup === null) throw new Error("expected backup");
          backupPath = backup;
          const path = join(target, "styles.css");
          const original = await readFile(path, "utf8");
          replacement = `${original.startsWith("X") ? "Y" : "X"}${original.slice(1)}`;
          await writeFile(path, replacement, "utf8");
        },
      },
    })).rejects.toThrow(/backup retained|rollback incomplete/u);

    await expect(readFile(join(targetOf(repoRoot), "styles.css"), "utf8")).resolves.toBe(replacement);
    expect((await readdir(backupPath)).sort()).toEqual([...builder.ACCEPTANCE_FILES].sort());
  });

  it("preserves retained stage, backup, and quarantine objects and refuses to build", async () => {
    for (const name of [
      ".read-only-acceptance.tmp-old",
      ".read-only-acceptance.backup-old",
      ".read-only-acceptance.quarantine-old",
    ]) {
      const repoRoot = await fixture();
      const dist = join(repoRoot, "dist");
      await mkdir(join(dist, name), { recursive: true });
      await writeFile(join(dist, name, "sentinel"), name);
      await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/residue|retained|hard stop/iu);
      await expect(readFile(join(dist, name, "sentinel"), "utf8")).resolves.toBe(name);
    }
  });
});
