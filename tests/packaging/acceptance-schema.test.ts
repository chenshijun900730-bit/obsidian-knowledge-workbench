import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface AcceptanceEvidence {
  readonly schemaVersion: 1;
  readonly scope: "dedicated-synthetic-vault";
  readonly contentPolicy: "synthetic-notes-only";
  readonly status: "pending" | "passed" | "failed";
  readonly recordedAt: string;
  readonly pluginVersion: string;
  readonly nodeVersion: string;
  readonly obsidianVersion: string;
  readonly syntheticNoteCount: number;
  readonly scanElapsedMs: number;
  readonly incrementalSampleCount: number;
  readonly incrementalP95Ms: number;
  readonly workbenchOpenSampleCount: number;
  readonly workbenchOpenP95Ms: number;
  readonly nextActionElapsedMs: number;
  readonly nextActionAcceptance: "pending" | "passed" | "failed";
  readonly topicDiscoveryElapsedMs: number;
  readonly topicDiscoveryAcceptance: "pending" | "passed" | "failed";
  readonly readOnlyAcceptance: "pending" | "passed" | "failed";
  readonly writeAcceptance: "not-authorized" | "pending" | "passed" | "failed";
}
interface AcceptanceModule { decodeAcceptanceEvidence(value: unknown): AcceptanceEvidence }
// @ts-expect-error The validation CLI is intentionally plain ESM without a declaration file.
const acceptance = await import("../../scripts/validate-acceptance.mjs") as unknown as AcceptanceModule;
const decodeAcceptanceEvidence: AcceptanceModule["decodeAcceptanceEvidence"] = (value) => acceptance.decodeAcceptanceEvidence(value);

const valid = (): AcceptanceEvidence => ({
  schemaVersion: 1,
  scope: "dedicated-synthetic-vault",
  contentPolicy: "synthetic-notes-only",
  status: "pending",
  recordedAt: "2026-07-13T00:00:00.000Z",
  pluginVersion: "0.1.0",
  nodeVersion: "v22.13.0",
  obsidianVersion: "1.12.7",
  syntheticNoteCount: 5_000,
  scanElapsedMs: 1_000,
  incrementalSampleCount: 100,
  incrementalP95Ms: 50,
  workbenchOpenSampleCount: 20,
  workbenchOpenP95Ms: 20,
  nextActionElapsedMs: 0,
  nextActionAcceptance: "pending",
  topicDiscoveryElapsedMs: 0,
  topicDiscoveryAcceptance: "pending",
  readOnlyAcceptance: "pending",
  writeAcceptance: "not-authorized",
});

describe("dedicated-vault acceptance evidence", () => {
  it("isolates heavy performance evidence from default tests and coverage", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const config = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    const performanceScript = packageJson.scripts["test:performance"];
    expect(performanceScript).toBeTypeOf("string");
    expect(performanceScript ?? "").toContain("KNOWLEDGE_WORKBENCH_PERFORMANCE=1");
    expect(performanceScript ?? "").toContain("--no-file-parallelism");
    expect(performanceScript ?? "").toContain("--maxWorkers=1");
    expect(performanceScript ?? "").toContain("--testTimeout=180000");
    expect(config).toContain('"tests/performance/**"');
    expect(config).toContain("configDefaults.exclude");
  });

  it("runs fixed synthetic-vault test groups serially", () => {
    const config = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toMatch(/name: "acceptance-workflows"[\s\S]*?groupOrder: 1/u);
    expect(config).toMatch(/name: "acceptance-heavy"[\s\S]*?groupOrder: 2/u);
  });

  it("runs acceptance workflows without worker or file-level parallelism", () => {
    const config = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    const acceptanceWorkflows = config.match(
      /name: "acceptance-workflows"([\s\S]*?)name: "acceptance-heavy"/u,
    )?.[1] ?? "";
    expect(acceptanceWorkflows).toContain("maxWorkers: 1");
    expect(acceptanceWorkflows).toContain("fileParallelism: false");
  });

  it("accepts only the documented finite metrics and fixed status enums", () => {
    expect(decodeAcceptanceEvidence(valid())).toEqual(valid());
  });

  it("rejects unknown or hostile keys rather than silently dropping them", () => {
    for (const extra of [
      { noteBody: "private" },
      { vaultPath: "/private/vault" },
      { endpoint: "https://private.invalid" },
      { journal: { payload: "private" } },
    ]) {
      expect(() => decodeAcceptanceEvidence({ ...valid(), ...extra })).toThrow("exact keys");
    }
  });

  it("binds every evidence record to the dedicated synthetic-vault scope", () => {
    expect(() => decodeAcceptanceEvidence({ ...valid(), scope: "real-vault" })).toThrow("scope");
    expect(() => decodeAcceptanceEvidence({ ...valid(), contentPolicy: "copied-notes" })).toThrow("contentPolicy");
  });

  it("rejects non-finite metrics, invalid timestamps, and invented statuses", () => {
    expect(() => decodeAcceptanceEvidence({ ...valid(), scanElapsedMs: Number.NaN })).toThrow("finite");
    expect(() => decodeAcceptanceEvidence({ ...valid(), recordedAt: "yesterday" })).toThrow("timestamp");
    expect(() => decodeAcceptanceEvidence({ ...valid(), recordedAt: "2026-07-13T00:00:00Z" })).toThrow("timestamp");
    expect(() => decodeAcceptanceEvidence({ ...valid(), readOnlyAcceptance: "maybe" })).toThrow("status");
  });

  it("accepts only narrow bounded plugin and Node version strings", () => {
    expect(() => decodeAcceptanceEvidence({ ...valid(), pluginVersion: "../../private" })).toThrow("pluginVersion");
    expect(() => decodeAcceptanceEvidence({ ...valid(), pluginVersion: `1.0.0-${"x".repeat(80)}` })).toThrow("pluginVersion");
    expect(() => decodeAcceptanceEvidence({ ...valid(), nodeVersion: "v22.13.0/private" })).toThrow("nodeVersion");
    expect(() => decodeAcceptanceEvidence({ ...valid(), nodeVersion: `v${"2".repeat(80)}` })).toThrow("nodeVersion");
    expect(() => decodeAcceptanceEvidence({ ...valid(), obsidianVersion: "1.12.7/private" })).toThrow("obsidianVersion");
  });

  it("requires every release and manual gate when overall status is passed", () => {
    const passed: AcceptanceEvidence = {
      ...valid(),
      status: "passed",
      nextActionElapsedMs: 10_000,
      nextActionAcceptance: "passed",
      topicDiscoveryElapsedMs: 180_000,
      topicDiscoveryAcceptance: "passed",
      readOnlyAcceptance: "passed",
      writeAcceptance: "passed",
    };
    expect(decodeAcceptanceEvidence(passed)).toEqual(passed);
    for (const invalid of [
      { ...passed, syntheticNoteCount: 4_999 },
      { ...passed, scanElapsedMs: 30_001 },
      { ...passed, incrementalSampleCount: 99 },
      { ...passed, incrementalP95Ms: 1_001 },
      { ...passed, workbenchOpenSampleCount: 19 },
      { ...passed, workbenchOpenP95Ms: 2_001 },
      { ...passed, nextActionElapsedMs: 10_001 },
      { ...passed, nextActionAcceptance: "failed" },
      { ...passed, topicDiscoveryElapsedMs: 180_001 },
      { ...passed, topicDiscoveryAcceptance: "failed" },
      { ...passed, readOnlyAcceptance: "failed" },
      { ...passed, writeAcceptance: "not-authorized" },
    ]) {
      expect(() => decodeAcceptanceEvidence(invalid)).toThrow("passed evidence");
    }
  });
});
