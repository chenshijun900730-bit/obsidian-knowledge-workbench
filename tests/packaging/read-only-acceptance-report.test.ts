import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeReadOnlyAcceptanceReport,
  computeReportStatus,
  decodeHostObservation,
  decodeReadOnlyAcceptanceReport,
  deriveFailureCategories,
  encodeReadOnlyAcceptanceReport,
  type HostObservation,
  type LocalAcceptanceEvidence,
  type ReadOnlyAcceptanceReport,
} from "../../scripts/read-only-acceptance-report.mjs";
// @ts-expect-error The local evidence collector is intentionally plain ESM without declarations.
import * as localEvidenceModule from "../../scripts/read-only-acceptance-local-evidence.mjs";
// @ts-expect-error Task 7 production is intentionally plain ESM without declarations.
import * as prepareModule from "../../scripts/prepare-acceptance-synthetic.mjs";
// @ts-expect-error Task 8 production is intentionally plain ESM without declarations.
import * as installModule from "../../scripts/install-acceptance-dev.mjs";

interface LocalEvidenceModule {
  readonly AUTOMATED_SAFETY_TESTS: readonly string[];
  gatherLocalAcceptanceEvidence(repoRoot: string): Promise<LocalAcceptanceEvidence>;
  validateReportAgainstCurrentEvidence(
    repoRoot: string,
    report: ReadOnlyAcceptanceReport,
  ): Promise<void>;
}

interface PrepareModule {
  prepareSyntheticAcceptance(options: Readonly<{ repoRoot: string }>): Promise<unknown>;
}

interface InstallModule {
  installAcceptanceDevelopment(options: Readonly<{ repoRoot: string }>): Promise<unknown>;
}

const localEvidence = localEvidenceModule as unknown as LocalEvidenceModule;
const prepareApi = prepareModule as unknown as PrepareModule;
const installApi = installModule as unknown as InstallModule;
const prepareAcceptance = (options: Readonly<{ repoRoot: string }>): Promise<unknown> => (
  prepareApi.prepareSyntheticAcceptance(options)
);
const installAcceptance = (options: Readonly<{ repoRoot: string }>): Promise<unknown> => (
  installApi.installAcceptanceDevelopment(options)
);
const temporaryPaths: string[] = [];
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const COMMIT = "a".repeat(40);
const currentManifest = JSON.parse(readFileSync(resolve("manifest.json"), "utf8")) as {
  readonly version: string;
};
const PLUGIN_VERSION = currentManifest.version;
const ARTIFACT_BINDING = `knowledge-workbench@${PLUGIN_VERSION}:read-only-acceptance`;
const RECORDED_AT = "2026-07-14T00:00:00.000Z";

const HOST_KEYS = [
  "recordedAt",
  "obsidianVersion",
  "scanElapsedMs",
  "restartRestoreElapsedMs",
  "hostIsolation",
  "banner",
  "startupNormalization",
  "quickCaptureBlocked",
  "organizationWritesBlocked",
  "undoBlocked",
  "historySensitiveActionsBlocked",
  "aiBlocked",
  "readSurfaces",
  "restartRestore",
  "networkBoundary",
  "recoveryAbsent",
  "finalHostStopped",
] as const;

const REPORT_KEYS = [
  "schemaVersion",
  "scope",
  "contentPolicy",
  "buildMode",
  "status",
  "recordedAt",
  "runId",
  "commit",
  "pluginVersion",
  "obsidianVersion",
  "artifactBinding",
  "syntheticNoteCount",
  "scanElapsedMs",
  "restartRestoreElapsedMs",
  "artifactIdentity",
  "fixtureIdentity",
  "automatedSafety",
  "hostIsolation",
  "banner",
  "startupNormalization",
  "quickCaptureBlocked",
  "organizationWritesBlocked",
  "undoBlocked",
  "historySensitiveActionsBlocked",
  "aiBlocked",
  "readSurfaces",
  "restartRestore",
  "contentUnchanged",
  "networkBoundary",
  "recoveryAbsent",
  "finalHostStopped",
  "failureCategories",
] as const;

const FAILURE_CATEGORY_ORDER = [
  "artifact",
  "fixture",
  "startup",
  "host-isolation",
  "ui-capability",
  "content-drift",
  "network",
  "recovery",
  "timing",
] as const;

const AUTOMATED_SAFETY_TESTS = [
  "tests/unit/runtime/artifact-binding.test.ts",
  "tests/integration/plugin-startup-gate.test.ts",
  "tests/integration/read-only-acceptance.test.ts",
  "tests/integration/read-only-acceptance-automated-safety.test.ts",
  "tests/packaging/composition-roots.test.ts",
  "tests/packaging/read-only-acceptance-build.test.ts",
  "tests/ui/read-only-acceptance-surfaces.test.ts",
] as const;

const TASK_9_FILES = [
  "scripts/read-only-acceptance-report.mjs",
  "scripts/read-only-acceptance-report.d.mts",
  "scripts/read-only-acceptance-local-evidence.mjs",
  "tests/packaging/read-only-acceptance-report.test.ts",
  "tests/integration/read-only-acceptance-automated-safety.test.ts",
  "tests/ui/read-only-acceptance-surfaces.test.ts",
] as const;

const validHost = (overrides: Partial<HostObservation> = {}): HostObservation => ({
  recordedAt: RECORDED_AT,
  obsidianVersion: "1.12.7",
  scanElapsedMs: 1,
  restartRestoreElapsedMs: 1,
  hostIsolation: "passed",
  banner: "passed",
  startupNormalization: "passed",
  quickCaptureBlocked: "passed",
  organizationWritesBlocked: "passed",
  undoBlocked: "passed",
  historySensitiveActionsBlocked: "passed",
  aiBlocked: "passed",
  readSurfaces: "passed",
  restartRestore: "passed",
  networkBoundary: "passed",
  recoveryAbsent: "passed",
  finalHostStopped: "passed",
  ...overrides,
});

const validLocal = (
  overrides: Partial<LocalAcceptanceEvidence> = {},
): LocalAcceptanceEvidence => ({
  runId: RUN_ID,
  commit: COMMIT,
  pluginVersion: PLUGIN_VERSION,
  artifactBinding: ARTIFACT_BINDING,
  syntheticNoteCount: 5_000,
  artifactIdentity: "passed",
  fixtureIdentity: "passed",
  automatedSafety: "passed",
  contentUnchanged: "passed",
  startupNormalizationEvidence: "normalized-safe",
  hostIsolation: "passed",
  historySensitiveActionsBlocked: "passed",
  networkBoundary: "passed",
  recoveryAbsent: "passed",
  finalHostStopped: "passed",
  ...overrides,
});

const validReport = (): ReadOnlyAcceptanceReport => (
  composeReadOnlyAcceptanceReport(validLocal(), decodeHostObservation(validHost()))
);

function runGit(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type RunnerFault = "assertion" | "collection" | "max-buffer";

async function createCurrentTaskRepository(runnerFault?: RunnerFault): Promise<string> {
  const sourceRoot = await realpath(process.cwd());
  const created = await mkdtemp(join(tmpdir(), "kwb-report-evidence-"));
  temporaryPaths.push(created);
  execFileSync("git", ["clone", "--quiet", "--shared", sourceRoot, created], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const repoRoot = await realpath(created);
  runGit(repoRoot, ["config", "user.email", "acceptance@example.invalid"]);
  runGit(repoRoot, ["config", "user.name", "Acceptance Test"]);
  runGit(repoRoot, ["config", "core.hooksPath", "/dev/null"]);
  for (const relativePath of TASK_9_FILES) {
    const destination = join(repoRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, relativePath), destination);
  }
  const automatedSafetyPath = join(
    repoRoot,
    "tests/integration/read-only-acceptance-automated-safety.test.ts",
  );
  if (runnerFault === "assertion") {
    await writeFile(
      automatedSafetyPath,
      '\nit("injected assertion classification", () => { expect("actual").toBe("expected"); });\n',
      { flag: "a" },
    );
  } else if (runnerFault === "collection") {
    await writeFile(automatedSafetyPath, "\nconst injected collection syntax = ;\n", { flag: "a" });
  } else if (runnerFault === "max-buffer") {
    await writeFile(
      automatedSafetyPath,
      '\nfor (let injected = 0; injected < 128; injected += 1) { it(`overflow-${injected}-${"x".repeat(10_000)}`, () => { expect("actual").toBe("expected"); }); }\n',
      { flag: "a" },
    );
  }
  runGit(repoRoot, ["add", ...TASK_9_FILES]);
  runGit(repoRoot, ["commit", "--quiet", "--allow-empty", "-m", "task 9 evidence fixture"]);
  await writeFile(join(repoRoot, ".git", "info", "exclude"), "node_modules\n", { flag: "a" });
  await symlink(join(sourceRoot, "node_modules"), join(repoRoot, "node_modules"), "dir");
  await mkdir(join(repoRoot, ".dev-vault"), { mode: 0o700 });
  const status = runGit(repoRoot, ["status", "--short", "--untracked-files=all"]);
  if (status.length !== 0) throw new Error(`Temporary evidence repository is dirty: ${status}`);
  return repoRoot;
}

async function writeMinimalRunAnchor(repoRoot: string): Promise<void> {
  const commit = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const state = {
    schemaVersion: 1,
    scope: "dedicated-synthetic-vault",
    contentPolicy: "deterministic-synthetic-notes-only",
    runId: RUN_ID,
    commit,
    syntheticNoteCount: 5_000,
    syntheticTotalBytes: 75 * 1024 * 1024,
    corpusDigest: `sha256:${"a".repeat(64)}`,
  };
  const stateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  const receipt = {
    schemaVersion: 1,
    runId: RUN_ID,
    commit,
    pluginVersion: PLUGIN_VERSION,
    artifactBinding: ARTIFACT_BINDING,
    artifactSetDigest: `sha256:${"b".repeat(64)}`,
    fixtureStateDigest: `sha256:${createHash("sha256").update(stateBytes).digest("hex")}`,
    seedDataDigest: `sha256:${"c".repeat(64)}`,
  };
  await writeFile(
    join(repoRoot, ".dev-vault", "read-only-acceptance-state.json"),
    stateBytes,
  );
  await writeFile(
    join(repoRoot, ".dev-vault", "read-only-acceptance-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
}

async function normalizeInstalledData(repoRoot: string): Promise<void> {
  const dataPath = installedDataPath(repoRoot);
  const data = JSON.parse(await readFile(dataPath, "utf8")) as Record<string, unknown>;
  const settings = data.settings as Record<string, unknown>;
  settings.writeEnabled = false;
  data.activeIndex = {
    builtAt: 1,
    records: [{
      id: "synthetic-derived-record",
      path: "Generated/00000/note-00000-3db92208.md",
      basename: "note-00000-3db92208",
      kind: "note",
      title: "Synthetic derived record",
      aliases: [],
      headings: ["Synthetic derived record"],
      tags: ["synthetic"],
      ownedFields: {},
      relationFields: {},
      outgoingLinks: [],
      tokens: ["synthetic", "derived"],
      mtime: 1,
      size: 1,
      contentHash: "synthetic-derived-content",
    }],
  };
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function installedDataPath(repoRoot: string): string {
  return join(
    repoRoot,
    ".dev-vault",
    "read-only-acceptance-vault",
    [".", "obsidian"].join(""),
    "plugins",
    "knowledge-workbench",
    "data.json",
  );
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
}, 600_000);

function omitKey<T extends object>(value: T, key: PropertyKey): T {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as T;
}

function reorderLastFirst<T extends object>(value: T): T {
  const entries = Object.entries(value);
  return Object.fromEntries([entries.at(-1)!, ...entries.slice(0, -1)]) as T;
}

function consistentReportWith(
  report: ReadOnlyAcceptanceReport,
  overrides: Partial<ReadOnlyAcceptanceReport>,
): ReadOnlyAcceptanceReport {
  const draft: ReadOnlyAcceptanceReport = {
    ...report,
    ...overrides,
    failureCategories: [],
  };
  const withStatus: ReadOnlyAcceptanceReport = {
    ...draft,
    status: computeReportStatus(draft),
  };
  return {
    ...withStatus,
    failureCategories: deriveFailureCategories(withStatus),
  };
}

describe("read-only acceptance host observation contract", () => {
  it("accepts only the exact ordered plain-data schema", () => {
    const decoded = decodeHostObservation(validHost());

    expect(Reflect.ownKeys(decoded)).toEqual(HOST_KEYS);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(decoded).toEqual(validHost());

    expect(() => decodeHostObservation(omitKey(validHost(), "banner"))).toThrow(/exact|key|banner/iu);
    expect(() => decodeHostObservation({ ...validHost(), notePath: "Generated/A.md" })).toThrow(/exact|key/iu);
    expect(() => decodeHostObservation(reorderLastFirst(validHost()))).toThrow(/order|canonical|key/iu);
    expect(() => decodeHostObservation(Object.assign(Object.create(null), validHost()))).toThrow(/plain|prototype/iu);
    expect(() => decodeHostObservation([])).toThrow(/plain|object/iu);
  });

  it("rejects accessors without invoking them and rejects symbols", () => {
    let invoked = false;
    const accessor = Object.defineProperty(validHost(), "banner", {
      enumerable: true,
      get: () => { invoked = true; throw new Error("private getter detail"); },
    });
    expect(() => decodeHostObservation(accessor)).toThrow(/data|accessor|property/iu);
    expect(invoked).toBe(false);
    expect(() => decodeHostObservation(Object.assign(validHost(), { [Symbol("private")]: true })))
      .toThrow(/key|symbol|exact/iu);
  });

  it.each([
    ["invalid status", { banner: "pending" }],
    ["noncanonical date", { recordedAt: "2026-07-14" }],
    ["long date", { recordedAt: "2026-07-14T00:00:00.000Z-extra" }],
    ["bad Obsidian version", { obsidianVersion: "latest" }],
    ["long Obsidian version", { obsidianVersion: `1.2.3-${"x".repeat(17)}` }],
    ["negative timing", { scanElapsedMs: -1 }],
    ["negative zero timing", { scanElapsedMs: -0 }],
    ["NaN timing", { scanElapsedMs: Number.NaN }],
    ["infinite timing", { scanElapsedMs: Number.POSITIVE_INFINITY }],
    ["over-bound timing", { restartRestoreElapsedMs: 3_600_001 }],
  ] as const)("rejects %s", (_label, override) => {
    expect(() => decodeHostObservation(validHost(override as Partial<HostObservation>)))
      .toThrow(/status|date|version|timing|bound|finite|canonical/iu);
  });

  it.each([
    "Generated/A.md",
    "https://acceptance.invalid/v1",
    "secret-token",
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "raw host error",
  ])("rejects arbitrary privacy-bearing input %s", (privateValue) => {
    expect(() => decodeHostObservation({ ...validHost(), detail: privateValue }))
      .toThrow(/exact|key/iu);
  });
});

describe("terminal report composition", () => {
  it("builds the exact frozen canonical passed report", () => {
    const report = validReport();

    expect(Reflect.ownKeys(report)).toEqual(REPORT_KEYS);
    expect(Object.isFrozen(report)).toBe(true);
    expect(report).toMatchObject({
      schemaVersion: 1,
      scope: "dedicated-synthetic-vault",
      contentPolicy: "deterministic-synthetic-notes-only",
      buildMode: "read-only-acceptance",
      status: "passed",
      runId: RUN_ID,
      commit: COMMIT,
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      syntheticNoteCount: 5_000,
      failureCategories: [],
    });
    expect(Object.isFrozen(report.failureCategories)).toBe(true);
    expect(computeReportStatus(report)).toBe("passed");
    expect(deriveFailureCategories(report)).toEqual([]);
  });

  it.each([
    ["normalized-safe", "passed", "passed"],
    ["normalized-safe", "inconclusive", "inconclusive"],
    ["normalized-safe", "failed", "failed"],
    ["unsafe", "passed", "failed"],
    ["unsafe", "inconclusive", "failed"],
    ["unsafe", "failed", "failed"],
    ["indeterminate", "passed", "inconclusive"],
    ["indeterminate", "inconclusive", "inconclusive"],
    ["indeterminate", "failed", "failed"],
    ["seed-unchanged", "passed", "failed"],
    ["seed-unchanged", "inconclusive", "inconclusive"],
    ["seed-unchanged", "failed", "failed"],
  ] as const)(
    "composes startup evidence %s with host %s as %s",
    (evidence, hostStatus, expected) => {
      const report = composeReadOnlyAcceptanceReport(
        validLocal({ startupNormalizationEvidence: evidence }),
        decodeHostObservation(validHost({ startupNormalization: hostStatus })),
      );
      expect(report.startupNormalization).toBe(expected);
    },
  );

  it.each([
    [0, "inconclusive"],
    [1, "passed"],
    [30_000, "passed"],
    [30_001, "failed"],
  ] as const)("folds scan timing %s only into read surfaces as %s", (timing, expected) => {
    const report = composeReadOnlyAcceptanceReport(
      validLocal(),
      decodeHostObservation(validHost({ scanElapsedMs: timing })),
    );
    expect(report.readSurfaces).toBe(expected);
    expect(report.restartRestore).toBe("passed");
  });

  it("folds restart timing separately and rejects timing beyond the safety bound", () => {
    const zero = composeReadOnlyAcceptanceReport(
      validLocal(),
      decodeHostObservation(validHost({ restartRestoreElapsedMs: 0 })),
    );
    expect(zero.restartRestore).toBe("inconclusive");
    expect(zero.readSurfaces).toBe("passed");
    expect(() => decodeHostObservation(validHost({ scanElapsedMs: 3_600_001 })))
      .toThrow(/timing|bound/iu);
  });

  it("uses failed then inconclusive then passed precedence for every composite gate", () => {
    const failed = composeReadOnlyAcceptanceReport(
      validLocal({ hostIsolation: "failed" }),
      decodeHostObservation(validHost({ hostIsolation: "passed" })),
    );
    const inconclusive = composeReadOnlyAcceptanceReport(
      validLocal({ networkBoundary: "inconclusive" }),
      decodeHostObservation(validHost({ networkBoundary: "passed" })),
    );
    expect(failed.hostIsolation).toBe("failed");
    expect(failed.status).toBe("failed");
    expect(inconclusive.networkBoundary).toBe("inconclusive");
    expect(inconclusive.status).toBe("inconclusive");
  });
});

describe("status and failure category derivation", () => {
  it("derives unique categories in the fixed order from all mapped gates and raw timing", () => {
    const base = validReport();
    const report: ReadOnlyAcceptanceReport = {
      ...base,
      status: "failed",
      scanElapsedMs: 0,
      artifactIdentity: "failed",
      fixtureIdentity: "inconclusive",
      automatedSafety: "failed",
      hostIsolation: "inconclusive",
      banner: "failed",
      startupNormalization: "inconclusive",
      quickCaptureBlocked: "failed",
      organizationWritesBlocked: "failed",
      undoBlocked: "failed",
      historySensitiveActionsBlocked: "inconclusive",
      aiBlocked: "failed",
      readSurfaces: "inconclusive",
      restartRestore: "failed",
      contentUnchanged: "failed",
      networkBoundary: "inconclusive",
      recoveryAbsent: "failed",
      finalHostStopped: "inconclusive",
      failureCategories: [],
    };

    expect(computeReportStatus(report)).toBe("failed");
    expect(deriveFailureCategories(report)).toEqual(FAILURE_CATEGORY_ORDER);
  });

  it("keeps a behavioral timing failure in both mapped categories", () => {
    const report = {
      ...validReport(),
      status: "failed" as const,
      scanElapsedMs: 30_001,
      readSurfaces: "failed" as const,
      failureCategories: [],
    };
    expect(deriveFailureCategories(report)).toEqual(["ui-capability", "timing"]);
  });
});

describe("terminal report canonical codec", () => {
  it("encodes two-space JSON in exact key order with one final newline", () => {
    const report = validReport();
    const bytes = encodeReadOnlyAcceptanceReport(report);
    const text = bytes.toString("utf8");

    expect(text).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(decodeReadOnlyAcceptanceReport(bytes)).toEqual(report);
  });

  it("rejects noncanonical JSON bytes", () => {
    const report = validReport();
    const canonical = encodeReadOnlyAcceptanceReport(report).toString("utf8");
    const reordered = reorderLastFirst(report);
    const duplicate = canonical.replace(
      '  "schemaVersion": 1,',
      '  "schemaVersion": 1,\n  "schemaVersion": 1,',
    );
    const variants = [
      JSON.stringify(report),
      canonical.trimEnd(),
      canonical.replaceAll("\n", "\r\n"),
      `\uFEFF${canonical}`,
      `${JSON.stringify(reordered, null, 2)}\n`,
      duplicate,
      canonical.replace('"scanElapsedMs": 1', '"scanElapsedMs": 1.0'),
    ];
    for (const value of variants) {
      expect(() => decodeReadOnlyAcceptanceReport(Buffer.from(value, "utf8")))
        .toThrow(/canonical|encoding|json|key|utf-8/iu);
    }
  });

  it("rejects invalid report identities, constants, categories, and consistency", () => {
    const report = validReport();
    const invalid: ReadOnlyAcceptanceReport[] = [
      { ...report, schemaVersion: 2 as 1 },
      { ...report, scope: "other" as "dedicated-synthetic-vault" },
      { ...report, runId: RUN_ID.toUpperCase() },
      { ...report, commit: "A".repeat(40) },
      { ...report, pluginVersion: "1.0" },
      { ...report, artifactBinding: "knowledge-workbench@9.9.9:read-only-acceptance" },
      { ...report, syntheticNoteCount: 4_999 as 5_000 },
      { ...report, failureCategories: ["artifact", "artifact"] },
      { ...report, failureCategories: ["unknown" as "artifact"] },
      { ...report, failureCategories: ["timing", "artifact"] },
      { ...report, status: "failed", failureCategories: [] },
      { ...report, artifactIdentity: "failed", status: "failed", failureCategories: [] },
      { ...report, failureCategories: ["artifact"] },
    ];
    for (const value of invalid) {
      expect(() => encodeReadOnlyAcceptanceReport(value))
        .toThrow(/schema|scope|run|commit|version|binding|count|category|status|consistent|canonical/iu);
    }
  });

  it("rejects missing, extra, reordered, accessor, and non-plain report objects", () => {
    const report = validReport();
    expect(() => encodeReadOnlyAcceptanceReport(omitKey(report, "banner"))).toThrow(/exact|key/iu);
    expect(() => encodeReadOnlyAcceptanceReport({ ...report, path: "Generated/A.md" } as ReadOnlyAcceptanceReport))
      .toThrow(/exact|key/iu);
    expect(() => encodeReadOnlyAcceptanceReport(reorderLastFirst(report))).toThrow(/order|canonical|key/iu);
    const nonPlain = Object.assign(new (class NonPlainReport {})(), report);
    expect(() => encodeReadOnlyAcceptanceReport(nonPlain))
      .toThrow(/plain|prototype/iu);

    let invoked = false;
    const accessor = Object.defineProperty({ ...report }, "banner", {
      enumerable: true,
      get: () => { invoked = true; throw new Error("private getter detail"); },
    });
    expect(() => encodeReadOnlyAcceptanceReport(accessor))
      .toThrow(/data|accessor|property/iu);
    expect(invoked).toBe(false);
  });
});

describe("local acceptance evidence public boundary", () => {
  it("publishes the exact frozen same-commit automated safety suite", () => {
    expect(localEvidence.AUTOMATED_SAFETY_TESTS).toEqual(AUTOMATED_SAFETY_TESTS);
    expect(Object.isFrozen(localEvidence.AUTOMATED_SAFETY_TESTS)).toBe(true);
  });

  it("keeps gather and current-evidence validation on the exact two public functions", () => {
    expect(typeof localEvidence.gatherLocalAcceptanceEvidence).toBe("function");
    expect(typeof localEvidence.validateReportAgainstCurrentEvidence).toBe("function");
  });

  it("locks the runner command, bounded environment, timeout, and output limit", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "read-only-acceptance-local-evidence.mjs"),
      "utf8",
    );
    expect(source).toContain("execFile(\n      process.execPath,");
    expect(source).toContain('vitestPath,\n        "run",\n        ...AUTOMATED_SAFETY_TESTS,');
    expect(source).toContain('"--no-file-parallelism",\n        "--maxWorkers=1",');
    expect(source).toContain("timeout: 600_000,");
    expect(source).toContain("maxBuffer: 1_048_576,");
    expect(source).toContain("shell: false,");
    expect(source).toContain('PATH: process.env.PATH ?? "",');
    expect(source).toContain('NODE_ENV: "test",\n          CI: "1",\n          NO_COLOR: "1",');
    expect(source).not.toContain("...process.env");
  }, 600_000);

  it.each([
    ["assertion", "failed"],
    ["collection", "inconclusive"],
    ["max-buffer", "inconclusive"],
  ] as const)("classifies a fixed-suite %s result as %s", async (fault, expected) => {
    const repoRoot = await createCurrentTaskRepository(fault);
    await writeMinimalRunAnchor(repoRoot);
    const evidence = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(evidence.automatedSafety).toBe(expected);
  }, 600_000);

  it("classifies an unavailable worktree-local Vitest entry as inconclusive", async () => {
    const repoRoot = await createCurrentTaskRepository();
    await writeMinimalRunAnchor(repoRoot);
    await rm(join(repoRoot, "node_modules"));
    const evidence = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(evidence.automatedSafety).toBe("inconclusive");
  }, 600_000);

  it("rejects saved composite and startup gates that are better than current floors", async () => {
    const repoRoot = await createCurrentTaskRepository();
    await writeMinimalRunAnchor(repoRoot);
    const current = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    const report = composeReadOnlyAcceptanceReport(current, decodeHostObservation(validHost()));
    const optimisticComposite = consistentReportWith(report, { hostIsolation: "passed" });
    await expect(localEvidence.validateReportAgainstCurrentEvidence(repoRoot, optimisticComposite))
      .rejects.toThrow(/hostIsolation|better|local evidence/iu);
    const optimisticStartup = consistentReportWith(report, { startupNormalization: "passed" });
    await expect(localEvidence.validateReportAgainstCurrentEvidence(repoRoot, optimisticStartup))
      .rejects.toThrow(/startupNormalization|better|local evidence/iu);
  }, 600_000);

  it("accepts Obsidian's terminal disabled-plugin serialization without a trailing newline", async () => {
    const repoRoot = await createCurrentTaskRepository();
    await prepareAcceptance({ repoRoot });
    await installAcceptance({ repoRoot });
    await normalizeInstalledData(repoRoot);

    const communityPluginsPath = join(
      repoRoot,
      ".dev-vault",
      "read-only-acceptance-vault",
      [".", "obsidian"].join(""),
      "community-plugins.json",
    );
    await writeFile(communityPluginsPath, "[]", "utf8");

    const evidence = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(evidence).toMatchObject({
      fixtureIdentity: "passed",
      hostIsolation: "passed",
      finalHostStopped: "passed",
    });
  }, 600_000);

  it("classifies pre-enable evidence and anchored fixture drift", async () => {
    const repoRoot = await createCurrentTaskRepository();
    const legacyPath = join(repoRoot, ".dev-vault", "acceptance.json");
    const legacyBytes = Buffer.from("legacy normal acceptance sentinel\n", "utf8");
    await writeFile(legacyPath, legacyBytes);

    await prepareAcceptance({ repoRoot });
    await installAcceptance({ repoRoot });

    const stoppedBeforeEnable = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(stoppedBeforeEnable).toMatchObject({
      fixtureIdentity: "passed",
      contentUnchanged: "passed",
      startupNormalizationEvidence: "seed-unchanged",
      hostIsolation: "inconclusive",
      historySensitiveActionsBlocked: "passed",
      recoveryAbsent: "passed",
      finalHostStopped: "inconclusive",
    });
    const stoppedReport = composeReadOnlyAcceptanceReport(
      stoppedBeforeEnable,
      decodeHostObservation(validHost({
        hostIsolation: "inconclusive",
        startupNormalization: "inconclusive",
      })),
    );
    expect(stoppedReport.hostIsolation).toBe("inconclusive");
    expect(stoppedReport.startupNormalization).toBe("inconclusive");

    const dataPath = installedDataPath(repoRoot);
    const seedDataBytes = await readFile(dataPath);
    await rm(dataPath);
    const missingData = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(missingData.artifactIdentity).toBe("passed");
    expect(missingData.fixtureIdentity).toBe("failed");
    expect(missingData.contentUnchanged).toBe("passed");
    expect(missingData.startupNormalizationEvidence).toBe("unsafe");
    expect(missingData.historySensitiveActionsBlocked).toBe("failed");
    expect(missingData.recoveryAbsent).toBe("inconclusive");
    await writeFile(dataPath, seedDataBytes);

    const receiptPath = join(repoRoot, ".dev-vault", "read-only-acceptance-receipt.json");
    const receiptBytes = await readFile(receiptPath);
    const wrongSeedReceipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
    wrongSeedReceipt.seedDataDigest = `sha256:${"f".repeat(64)}`;
    await writeFile(receiptPath, `${JSON.stringify(wrongSeedReceipt, null, 2)}\n`, "utf8");
    const wrongSeed = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(wrongSeed.artifactIdentity).toBe("passed");
    expect(wrongSeed.fixtureIdentity).toBe("failed");
    expect(wrongSeed.contentUnchanged).toBe("passed");
    expect(wrongSeed.startupNormalizationEvidence).toBe("indeterminate");
    expect(wrongSeed.historySensitiveActionsBlocked).toBe("inconclusive");
    expect(wrongSeed.recoveryAbsent).toBe("passed");
    await writeFile(receiptPath, receiptBytes);

    const statePath = join(repoRoot, ".dev-vault", "read-only-acceptance-state.json");
    const stateBytes = await readFile(statePath);
    const wrongCorpusState = JSON.parse(stateBytes.toString("utf8")) as Record<string, unknown>;
    wrongCorpusState.corpusDigest = `sha256:${"e".repeat(64)}`;
    const wrongCorpusStateBytes = Buffer.from(
      `${JSON.stringify(wrongCorpusState, null, 2)}\n`,
      "utf8",
    );
    const matchingReceipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
    matchingReceipt.fixtureStateDigest = `sha256:${createHash("sha256")
      .update(wrongCorpusStateBytes).digest("hex")}`;
    await writeFile(statePath, wrongCorpusStateBytes);
    await writeFile(receiptPath, `${JSON.stringify(matchingReceipt, null, 2)}\n`, "utf8");
    const wrongCorpus = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(wrongCorpus.fixtureIdentity).toBe("failed");
    expect(wrongCorpus.contentUnchanged).toBe("failed");
    await writeFile(statePath, stateBytes);
    await writeFile(receiptPath, receiptBytes);
    expect(await readFile(legacyPath)).toEqual(legacyBytes);
  }, 600_000);

  it("gathers normalized evidence and classifies plugin data states", async () => {
    const repoRoot = await createCurrentTaskRepository();
    const legacyPath = join(repoRoot, ".dev-vault", "acceptance.json");
    const legacyBytes = Buffer.from("legacy normal acceptance sentinel\n", "utf8");
    await writeFile(legacyPath, legacyBytes);

    await prepareAcceptance({ repoRoot });
    await installAcceptance({ repoRoot });
    await normalizeInstalledData(repoRoot);

    const dataPath = installedDataPath(repoRoot);
    const reportPath = join(repoRoot, ".dev-vault", "read-only-acceptance-report.json");
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const gathered = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(gathered.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(gathered).toEqual({
      runId: gathered.runId,
      commit: runGit(repoRoot, ["rev-parse", "HEAD"]),
      pluginVersion: PLUGIN_VERSION,
      artifactBinding: ARTIFACT_BINDING,
      syntheticNoteCount: 5_000,
      artifactIdentity: "passed",
      fixtureIdentity: "passed",
      automatedSafety: "passed",
      contentUnchanged: "passed",
      startupNormalizationEvidence: "normalized-safe",
      hostIsolation: "passed",
      historySensitiveActionsBlocked: "passed",
      networkBoundary: "passed",
      recoveryAbsent: "passed",
      finalHostStopped: "passed",
    });
    expect(Object.isFrozen(gathered)).toBe(true);
    expect(await readFile(legacyPath)).toEqual(legacyBytes);
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" });

    const report = composeReadOnlyAcceptanceReport(gathered, decodeHostObservation(validHost()));
    expect(report.status).toBe("passed");
    const pessimisticReport = composeReadOnlyAcceptanceReport(
      gathered,
      decodeHostObservation(validHost({
        hostIsolation: "failed",
        networkBoundary: "failed",
      })),
    );
    await expect(localEvidence.validateReportAgainstCurrentEvidence(repoRoot, pessimisticReport))
      .resolves.toBeUndefined();

    const normalizedDataBytes = await readFile(dataPath);
    await writeFile(dataPath, "{}\n", "utf8");
    const malformedData = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(malformedData.artifactIdentity).toBe("passed");
    expect(malformedData.fixtureIdentity).toBe("passed");
    expect(malformedData.contentUnchanged).toBe("passed");
    expect(malformedData.startupNormalizationEvidence).toBe("unsafe");
    expect(malformedData.historySensitiveActionsBlocked).toBe("failed");
    expect(malformedData.recoveryAbsent).toBe("inconclusive");
    expect(malformedData.finalHostStopped).toBe("failed");
    await writeFile(dataPath, normalizedDataBytes);

    const recoveryData = JSON.parse(normalizedDataBytes.toString("utf8")) as Record<string, unknown>;
    const recoveryOperational = recoveryData.operational as Record<string, unknown>;
    const recoveryJournals = recoveryOperational.journals as unknown[];
    recoveryJournals.push({ status: "recovery-required" });
    await writeFile(dataPath, `${JSON.stringify(recoveryData, null, 2)}\n`, "utf8");
    const recovery = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(recovery.startupNormalizationEvidence).toBe("normalized-safe");
    expect(recovery.historySensitiveActionsBlocked).toBe("passed");
    expect(recovery.recoveryAbsent).toBe("failed");
    expect(recovery.finalHostStopped).toBe("passed");

    const missingHistoryData = JSON.parse(normalizedDataBytes.toString("utf8")) as Record<string, unknown>;
    const missingHistoryOperational = missingHistoryData.operational as Record<string, unknown>;
    missingHistoryOperational.journals = [];
    await writeFile(dataPath, `${JSON.stringify(missingHistoryData, null, 2)}\n`, "utf8");
    const missingHistory = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(missingHistory.startupNormalizationEvidence).toBe("normalized-safe");
    expect(missingHistory.historySensitiveActionsBlocked).toBe("failed");
    expect(missingHistory.recoveryAbsent).toBe("passed");
    expect(missingHistory.finalHostStopped).toBe("passed");
    await writeFile(dataPath, normalizedDataBytes);
    expect(await readFile(legacyPath)).toEqual(legacyBytes);
  }, 600_000);

  it("isolates host-boundary and synthetic-note drift", async () => {
    const repoRoot = await createCurrentTaskRepository();
    const legacyPath = join(repoRoot, ".dev-vault", "acceptance.json");
    const legacyBytes = Buffer.from("legacy normal acceptance sentinel\n", "utf8");
    await writeFile(legacyPath, legacyBytes);

    await prepareAcceptance({ repoRoot });
    await installAcceptance({ repoRoot });
    await normalizeInstalledData(repoRoot);

    const receiptPath = join(repoRoot, ".dev-vault", "read-only-acceptance-receipt.json");
    const reportPath = join(repoRoot, ".dev-vault", "read-only-acceptance-report.json");
    const gathered = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    const report = composeReadOnlyAcceptanceReport(gathered, decodeHostObservation(validHost()));

    const markerPath = join(
      repoRoot,
      ".dev-vault/read-only-acceptance-vault/.knowledge-workbench-test-vault.json",
    );
    const markerBytes = await readFile(markerPath);
    const forbiddenConfiguration = join(
      repoRoot,
      ".dev-vault/read-only-acceptance-vault",
      [".", "obsidian"].join(""),
      "forbidden-host-state.json",
    );
    await writeFile(markerPath, "{}\n", "utf8");
    const changedMarker = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(changedMarker.artifactIdentity).toBe("passed");
    expect(changedMarker.fixtureIdentity).toBe("failed");
    expect(changedMarker.contentUnchanged).toBe("passed");
    expect(changedMarker.hostIsolation).toBe("failed");
    await writeFile(markerPath, markerBytes);

    await writeFile(forbiddenConfiguration, "{}\n", "utf8");
    const forbiddenConfig = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(forbiddenConfig.artifactIdentity).toBe("passed");
    expect(forbiddenConfig.fixtureIdentity).toBe("failed");
    expect(forbiddenConfig.contentUnchanged).toBe("passed");
    expect(forbiddenConfig.hostIsolation).toBe("failed");
    await rm(forbiddenConfiguration);

    await writeFile(
      join(
        repoRoot,
        ".dev-vault/read-only-acceptance-vault/Generated/00000/note-00000-3db92208.md",
      ),
      "definite synthetic note drift\n",
      "utf8",
    );
    const drifted = await localEvidence.gatherLocalAcceptanceEvidence(repoRoot);
    expect(drifted.fixtureIdentity).toBe("passed");
    expect(drifted.contentUnchanged).toBe("failed");
    expect(drifted.artifactIdentity).toBe("passed");
    expect(drifted.finalHostStopped).toBe("failed");
    expect(await readFile(legacyPath)).toEqual(legacyBytes);
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(localEvidence.validateReportAgainstCurrentEvidence(repoRoot, report))
      .rejects.toThrow(/contentUnchanged|local evidence/iu);

    await writeFile(
      receiptPath,
      "{}\n",
      "utf8",
    );
    await expect(localEvidence.gatherLocalAcceptanceEvidence(repoRoot))
      .rejects.toThrow(/receipt|anchor|canonical|key|schema/iu);
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 600_000);
});
