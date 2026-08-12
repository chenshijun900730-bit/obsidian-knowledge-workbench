import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXACT_KEYS = Object.freeze([
  "schemaVersion",
  "scope",
  "contentPolicy",
  "status",
  "recordedAt",
  "pluginVersion",
  "nodeVersion",
  "obsidianVersion",
  "syntheticNoteCount",
  "scanElapsedMs",
  "incrementalSampleCount",
  "incrementalP95Ms",
  "workbenchOpenSampleCount",
  "workbenchOpenP95Ms",
  "nextActionElapsedMs",
  "nextActionAcceptance",
  "topicDiscoveryElapsedMs",
  "topicDiscoveryAcceptance",
  "readOnlyAcceptance",
  "writeAcceptance",
]);
const RUN_STATUS = new Set(["pending", "passed", "failed"]);
const WRITE_STATUS = new Set(["not-authorized", "pending", "passed", "failed"]);

const finite = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
};
const count = (value, label) => {
  finite(value, label);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a finite non-negative integer count`);
  return value;
};
const status = (value, values, label) => {
  if (typeof value !== "string" || !values.has(value)) throw new Error(`${label} has an invalid status`);
  return value;
};
const canonicalTimestamp = (value) => {
  if (typeof value !== "string" || value.length > 32) throw new Error("recordedAt must be a canonical timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) throw new Error("recordedAt must be a canonical timestamp");
  return value;
};
const pluginVersion = (value) => {
  if (typeof value !== "string" || value.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/u.test(value)) {
    throw new Error("pluginVersion must be a bounded semantic version");
  }
  return value;
};
const nodeVersion = (value) => {
  if (typeof value !== "string" || value.length > 32 || !/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value)) {
    throw new Error("nodeVersion must be a bounded Node version");
  }
  return value;
};
const obsidianVersion = (value) => {
  if (typeof value !== "string" || value.length > 40 || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,16})?$/u.test(value)) {
    throw new Error("obsidianVersion must be a bounded version");
  }
  return value;
};

const assertPassedEvidence = (value) => {
  if (value.status !== "passed") return;
  const complete = value.syntheticNoteCount === 5_000
    && value.scanElapsedMs > 0 && value.scanElapsedMs <= 30_000
    && value.incrementalSampleCount === 100
    && value.incrementalP95Ms > 0 && value.incrementalP95Ms <= 1_000
    && value.workbenchOpenSampleCount === 20
    && value.workbenchOpenP95Ms > 0 && value.workbenchOpenP95Ms <= 2_000
    && value.nextActionElapsedMs > 0 && value.nextActionElapsedMs <= 10_000
    && value.nextActionAcceptance === "passed"
    && value.topicDiscoveryElapsedMs > 0 && value.topicDiscoveryElapsedMs <= 180_000
    && value.topicDiscoveryAcceptance === "passed"
    && value.readOnlyAcceptance === "passed"
    && value.writeAcceptance === "passed";
  if (!complete) throw new Error("passed evidence must satisfy every automated and manual acceptance gate");
};

export function decodeAcceptanceEvidence(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Acceptance evidence must be an object with exact keys");
  const keys = Object.keys(value).sort();
  const expected = [...EXACT_KEYS].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    throw new Error("Acceptance evidence must use exact keys");
  }
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (value.scope !== "dedicated-synthetic-vault") throw new Error("scope must be dedicated-synthetic-vault");
  if (value.contentPolicy !== "synthetic-notes-only") throw new Error("contentPolicy must be synthetic-notes-only");
  const decoded = {
    schemaVersion: 1,
    scope: "dedicated-synthetic-vault",
    contentPolicy: "synthetic-notes-only",
    status: status(value.status, RUN_STATUS, "status"),
    recordedAt: canonicalTimestamp(value.recordedAt),
    pluginVersion: pluginVersion(value.pluginVersion),
    nodeVersion: nodeVersion(value.nodeVersion),
    obsidianVersion: obsidianVersion(value.obsidianVersion),
    syntheticNoteCount: count(value.syntheticNoteCount, "syntheticNoteCount"),
    scanElapsedMs: finite(value.scanElapsedMs, "scanElapsedMs"),
    incrementalSampleCount: count(value.incrementalSampleCount, "incrementalSampleCount"),
    incrementalP95Ms: finite(value.incrementalP95Ms, "incrementalP95Ms"),
    workbenchOpenSampleCount: count(value.workbenchOpenSampleCount, "workbenchOpenSampleCount"),
    workbenchOpenP95Ms: finite(value.workbenchOpenP95Ms, "workbenchOpenP95Ms"),
    nextActionElapsedMs: finite(value.nextActionElapsedMs, "nextActionElapsedMs"),
    nextActionAcceptance: status(value.nextActionAcceptance, RUN_STATUS, "nextActionAcceptance"),
    topicDiscoveryElapsedMs: finite(value.topicDiscoveryElapsedMs, "topicDiscoveryElapsedMs"),
    topicDiscoveryAcceptance: status(value.topicDiscoveryAcceptance, RUN_STATUS, "topicDiscoveryAcceptance"),
    readOnlyAcceptance: status(value.readOnlyAcceptance, RUN_STATUS, "readOnlyAcceptance"),
    writeAcceptance: status(value.writeAcceptance, WRITE_STATUS, "writeAcceptance"),
  };
  assertPassedEvidence(decoded);
  return decoded;
}

export async function validateAcceptanceFile(path) {
  const decoded = JSON.parse(await readFile(path, "utf8"));
  return decodeAcceptanceEvidence(decoded);
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === modulePath) {
  const repoRoot = await realpath(dirname(dirname(modulePath)));
  const path = process.argv[2] === undefined ? join(repoRoot, ".dev-vault", "acceptance.json") : resolve(process.argv[2]);
  try {
    const decoded = await validateAcceptanceFile(path);
    process.stdout.write(`${JSON.stringify(decoded, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
