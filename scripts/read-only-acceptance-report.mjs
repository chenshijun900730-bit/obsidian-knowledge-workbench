import { isStrictBoundedSemver } from "../src/runtime/strict-semver.mjs";
import { SYNTHETIC_ACCEPTANCE_NOTE_COUNT } from "./synthetic-note-fixture.mjs";

const TERMINAL_STATUSES = Object.freeze(["passed", "inconclusive", "failed"]);
const STARTUP_NORMALIZATION_EVIDENCE = Object.freeze([
  "seed-unchanged",
  "normalized-safe",
  "unsafe",
  "indeterminate",
]);
const FAILURE_CATEGORY_ORDER = Object.freeze([
  "artifact",
  "fixture",
  "startup",
  "host-isolation",
  "ui-capability",
  "content-drift",
  "network",
  "recovery",
  "timing",
]);
const HOST_KEYS = Object.freeze([
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
]);
const LOCAL_KEYS = Object.freeze([
  "runId",
  "commit",
  "pluginVersion",
  "artifactBinding",
  "syntheticNoteCount",
  "artifactIdentity",
  "fixtureIdentity",
  "automatedSafety",
  "contentUnchanged",
  "startupNormalizationEvidence",
  "hostIsolation",
  "historySensitiveActionsBlocked",
  "networkBoundary",
  "recoveryAbsent",
  "finalHostStopped",
]);
const REPORT_KEYS = Object.freeze([
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
]);
const FINAL_GATE_KEYS = Object.freeze([
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
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const OBSIDIAN_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,16})?$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_RECORDED_AT_LENGTH = 32;
const MAX_OBSIDIAN_VERSION_LENGTH = 40;
const MAX_TIMING_MS = 3_600_000;
const ACCEPTANCE_TIMING_MS = 30_000;
const STATUS_RANK = Object.freeze({ passed: 0, inconclusive: 1, failed: 2 });

function readExactDataRecord(value, keys, label) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object with the standard object prototype`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== keys.length
    || !actualKeys.every((key, index) => key === keys[index])
  ) {
    throw new Error(`${label} must use the exact keys in canonical order`);
  }

  const data = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} ${key} must be an own enumerable data property, not an accessor`);
    }
    data[key] = descriptor.value;
  }
  return data;
}

function requireStatus(value, label) {
  if (typeof value !== "string" || !TERMINAL_STATUSES.includes(value)) {
    throw new Error(`${label} status must be passed, failed, or inconclusive`);
  }
  return value;
}

function requireStartupEvidence(value) {
  if (typeof value !== "string" || !STARTUP_NORMALIZATION_EVIDENCE.includes(value)) {
    throw new Error("Startup normalization evidence must use an exact allowed status category");
  }
  return value;
}

function requireRecordedAt(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RECORDED_AT_LENGTH) {
    throw new Error("Recorded date must be a bounded canonical ISO date");
  }
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error("Recorded date must be a canonical ISO date");
  }
  if (canonical !== value) throw new Error("Recorded date must use canonical ISO encoding");
  return value;
}

function requireObsidianVersion(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_OBSIDIAN_VERSION_LENGTH
    || !OBSIDIAN_VERSION.test(value)
  ) {
    throw new Error("Obsidian version must be a bounded canonical version");
  }
  return value;
}

function requireTiming(value, label) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Object.is(value, -0)
    || value < 0
    || value > MAX_TIMING_MS
  ) {
    throw new Error(`${label} timing must be a finite number within the safety bound`);
  }
  return value;
}

function requireRunId(value) {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new Error("Run ID must be a canonical lowercase UUIDv4");
  }
  return value;
}

function requireCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error("Commit must be a canonical lowercase 40- or 64-hex object ID");
  }
  return value;
}

function requirePluginVersion(value) {
  if (!isStrictBoundedSemver(value)) {
    throw new Error("Plugin version must be a strict bounded semantic version");
  }
  return value;
}

function requireArtifactBinding(value, pluginVersion) {
  const expected = `knowledge-workbench@${pluginVersion}:read-only-acceptance`;
  if (value !== expected) {
    throw new Error("Artifact binding must exactly match the plugin version and acceptance build mode");
  }
  return expected;
}

function requireSyntheticNoteCount(value) {
  if (
    !Number.isSafeInteger(value)
    || value !== SYNTHETIC_ACCEPTANCE_NOTE_COUNT
  ) {
    throw new Error("Synthetic note count must equal 5000");
  }
  return SYNTHETIC_ACCEPTANCE_NOTE_COUNT;
}

function canonicalFailureCategories(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("Failure categories must be a plain array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > FAILURE_CATEGORY_ORDER.length
  ) {
    throw new Error("Failure category array must contain at most nine values");
  }
  const length = lengthDescriptor.value;
  const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), "length"];
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.length
    || !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new Error("Failure category array must be dense and use exact canonical keys");
  }

  const categories = [];
  let previousOrder = -1;
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error("Each failure category must be an own enumerable data property");
    }
    const category = descriptor.value;
    const order = FAILURE_CATEGORY_ORDER.indexOf(category);
    if (typeof category !== "string" || order < 0) {
      throw new Error("Failure category must use the exact allowlist");
    }
    if (order <= previousOrder) {
      throw new Error("Failure categories must be unique and use canonical category order");
    }
    previousOrder = order;
    categories.push(category);
  }
  return Object.freeze(categories);
}

function canonicalHostObservation(value) {
  const input = readExactDataRecord(value, HOST_KEYS, "Host observation");
  return Object.freeze({
    recordedAt: requireRecordedAt(input.recordedAt),
    obsidianVersion: requireObsidianVersion(input.obsidianVersion),
    scanElapsedMs: requireTiming(input.scanElapsedMs, "Scan elapsed"),
    restartRestoreElapsedMs: requireTiming(input.restartRestoreElapsedMs, "Restart restore elapsed"),
    hostIsolation: requireStatus(input.hostIsolation, "Host isolation"),
    banner: requireStatus(input.banner, "Banner"),
    startupNormalization: requireStatus(input.startupNormalization, "Startup normalization"),
    quickCaptureBlocked: requireStatus(input.quickCaptureBlocked, "Quick capture"),
    organizationWritesBlocked: requireStatus(input.organizationWritesBlocked, "Organization writes"),
    undoBlocked: requireStatus(input.undoBlocked, "Undo"),
    historySensitiveActionsBlocked: requireStatus(
      input.historySensitiveActionsBlocked,
      "History-sensitive actions",
    ),
    aiBlocked: requireStatus(input.aiBlocked, "AI"),
    readSurfaces: requireStatus(input.readSurfaces, "Read surfaces"),
    restartRestore: requireStatus(input.restartRestore, "Restart restore"),
    networkBoundary: requireStatus(input.networkBoundary, "Network boundary"),
    recoveryAbsent: requireStatus(input.recoveryAbsent, "Recovery absence"),
    finalHostStopped: requireStatus(input.finalHostStopped, "Final host stopped"),
  });
}

function canonicalLocalEvidence(value) {
  const input = readExactDataRecord(value, LOCAL_KEYS, "Local acceptance evidence");
  const pluginVersion = requirePluginVersion(input.pluginVersion);
  return Object.freeze({
    runId: requireRunId(input.runId),
    commit: requireCommit(input.commit),
    pluginVersion,
    artifactBinding: requireArtifactBinding(input.artifactBinding, pluginVersion),
    syntheticNoteCount: requireSyntheticNoteCount(input.syntheticNoteCount),
    artifactIdentity: requireStatus(input.artifactIdentity, "Artifact identity"),
    fixtureIdentity: requireStatus(input.fixtureIdentity, "Fixture identity"),
    automatedSafety: requireStatus(input.automatedSafety, "Automated safety"),
    contentUnchanged: requireStatus(input.contentUnchanged, "Content unchanged"),
    startupNormalizationEvidence: requireStartupEvidence(input.startupNormalizationEvidence),
    hostIsolation: requireStatus(input.hostIsolation, "Local host isolation"),
    historySensitiveActionsBlocked: requireStatus(
      input.historySensitiveActionsBlocked,
      "Local history-sensitive actions",
    ),
    networkBoundary: requireStatus(input.networkBoundary, "Local network boundary"),
    recoveryAbsent: requireStatus(input.recoveryAbsent, "Local recovery absence"),
    finalHostStopped: requireStatus(input.finalHostStopped, "Local final host stopped"),
  });
}

function canonicalReportShape(value) {
  const input = readExactDataRecord(value, REPORT_KEYS, "Read-only acceptance report");
  if (input.schemaVersion !== 1) throw new Error("Report schemaVersion must equal 1");
  if (input.scope !== "dedicated-synthetic-vault") {
    throw new Error("Report scope must equal dedicated-synthetic-vault");
  }
  if (input.contentPolicy !== "deterministic-synthetic-notes-only") {
    throw new Error("Report content policy must equal deterministic-synthetic-notes-only");
  }
  if (input.buildMode !== "read-only-acceptance") {
    throw new Error("Report build mode must equal read-only-acceptance");
  }
  const pluginVersion = requirePluginVersion(input.pluginVersion);
  return Object.freeze({
    schemaVersion: 1,
    scope: "dedicated-synthetic-vault",
    contentPolicy: "deterministic-synthetic-notes-only",
    buildMode: "read-only-acceptance",
    status: requireStatus(input.status, "Report"),
    recordedAt: requireRecordedAt(input.recordedAt),
    runId: requireRunId(input.runId),
    commit: requireCommit(input.commit),
    pluginVersion,
    obsidianVersion: requireObsidianVersion(input.obsidianVersion),
    artifactBinding: requireArtifactBinding(input.artifactBinding, pluginVersion),
    syntheticNoteCount: requireSyntheticNoteCount(input.syntheticNoteCount),
    scanElapsedMs: requireTiming(input.scanElapsedMs, "Scan elapsed"),
    restartRestoreElapsedMs: requireTiming(input.restartRestoreElapsedMs, "Restart restore elapsed"),
    artifactIdentity: requireStatus(input.artifactIdentity, "Artifact identity"),
    fixtureIdentity: requireStatus(input.fixtureIdentity, "Fixture identity"),
    automatedSafety: requireStatus(input.automatedSafety, "Automated safety"),
    hostIsolation: requireStatus(input.hostIsolation, "Host isolation"),
    banner: requireStatus(input.banner, "Banner"),
    startupNormalization: requireStatus(input.startupNormalization, "Startup normalization"),
    quickCaptureBlocked: requireStatus(input.quickCaptureBlocked, "Quick capture"),
    organizationWritesBlocked: requireStatus(input.organizationWritesBlocked, "Organization writes"),
    undoBlocked: requireStatus(input.undoBlocked, "Undo"),
    historySensitiveActionsBlocked: requireStatus(
      input.historySensitiveActionsBlocked,
      "History-sensitive actions",
    ),
    aiBlocked: requireStatus(input.aiBlocked, "AI"),
    readSurfaces: requireStatus(input.readSurfaces, "Read surfaces"),
    restartRestore: requireStatus(input.restartRestore, "Restart restore"),
    contentUnchanged: requireStatus(input.contentUnchanged, "Content unchanged"),
    networkBoundary: requireStatus(input.networkBoundary, "Network boundary"),
    recoveryAbsent: requireStatus(input.recoveryAbsent, "Recovery absence"),
    finalHostStopped: requireStatus(input.finalHostStopped, "Final host stopped"),
    failureCategories: canonicalFailureCategories(input.failureCategories),
  });
}

function worstStatus(...statuses) {
  let worst = "passed";
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

function timingFloor(value) {
  if (value === 0) return "inconclusive";
  if (value > ACCEPTANCE_TIMING_MS) return "failed";
  return "passed";
}

function startupStatus(evidence, hostStatus) {
  if (evidence === "unsafe") return "failed";
  if (evidence === "indeterminate") return worstStatus("inconclusive", hostStatus);
  if (evidence === "seed-unchanged") {
    if (hostStatus === "passed") return "failed";
    return hostStatus;
  }
  return hostStatus;
}

function computeStatusFromReport(report) {
  return worstStatus(...FINAL_GATE_KEYS.map((key) => report[key]));
}

function deriveCategoriesFromReport(report) {
  const present = new Set();
  const addWhenNotPassed = (category, ...keys) => {
    if (keys.some((key) => report[key] !== "passed")) present.add(category);
  };

  addWhenNotPassed("artifact", "artifactIdentity");
  addWhenNotPassed("fixture", "fixtureIdentity");
  addWhenNotPassed("startup", "banner", "startupNormalization", "restartRestore");
  addWhenNotPassed("host-isolation", "hostIsolation", "finalHostStopped");
  addWhenNotPassed(
    "ui-capability",
    "automatedSafety",
    "quickCaptureBlocked",
    "organizationWritesBlocked",
    "undoBlocked",
    "historySensitiveActionsBlocked",
    "aiBlocked",
    "readSurfaces",
  );
  addWhenNotPassed("content-drift", "contentUnchanged");
  addWhenNotPassed("network", "networkBoundary");
  addWhenNotPassed("recovery", "recoveryAbsent");
  if (
    timingFloor(report.scanElapsedMs) !== "passed"
    || timingFloor(report.restartRestoreElapsedMs) !== "passed"
  ) {
    present.add("timing");
  }
  return Object.freeze(FAILURE_CATEGORY_ORDER.filter((category) => present.has(category)));
}

function requireReportConsistency(report) {
  if (STATUS_RANK[report.readSurfaces] < STATUS_RANK[timingFloor(report.scanElapsedMs)]) {
    throw new Error("Read-surfaces status must be consistent with the scan timing floor");
  }
  if (STATUS_RANK[report.restartRestore] < STATUS_RANK[timingFloor(report.restartRestoreElapsedMs)]) {
    throw new Error("Restart-restore status must be consistent with the restart timing floor");
  }
  const status = computeStatusFromReport(report);
  if (report.status !== status) {
    throw new Error("Report status must be consistent with every final gate");
  }
  const categories = deriveCategoriesFromReport(report);
  if (
    report.failureCategories.length !== categories.length
    || !report.failureCategories.every((category, index) => category === categories[index])
  ) {
    throw new Error("Report failure categories must be consistent with final gates and timing");
  }
  return report;
}

function encodeCanonical(report) {
  return Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function decodeHostObservation(value) {
  return canonicalHostObservation(value);
}

export function decodeReadOnlyAcceptanceReport(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Read-only acceptance report bytes must be a Uint8Array");
  }
  let input;
  let text;
  try {
    input = Buffer.from(bytes);
    text = UTF8.decode(input);
  } catch (error) {
    throw new Error("Read-only acceptance report must use valid UTF-8 encoding", { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Read-only acceptance report must be valid JSON", { cause: error });
  }
  const report = requireReportConsistency(canonicalReportShape(value));
  if (!input.equals(encodeCanonical(report))) {
    throw new Error("Read-only acceptance report JSON must use exact canonical encoding and key order");
  }
  return report;
}

export function composeReadOnlyAcceptanceReport(local, host) {
  const current = canonicalLocalEvidence(local);
  const observation = canonicalHostObservation(host);
  const gates = {
    artifactIdentity: current.artifactIdentity,
    fixtureIdentity: current.fixtureIdentity,
    automatedSafety: current.automatedSafety,
    hostIsolation: worstStatus(current.hostIsolation, observation.hostIsolation),
    banner: observation.banner,
    startupNormalization: startupStatus(
      current.startupNormalizationEvidence,
      observation.startupNormalization,
    ),
    quickCaptureBlocked: observation.quickCaptureBlocked,
    organizationWritesBlocked: observation.organizationWritesBlocked,
    undoBlocked: observation.undoBlocked,
    historySensitiveActionsBlocked: worstStatus(
      current.historySensitiveActionsBlocked,
      observation.historySensitiveActionsBlocked,
    ),
    aiBlocked: observation.aiBlocked,
    readSurfaces: worstStatus(observation.readSurfaces, timingFloor(observation.scanElapsedMs)),
    restartRestore: worstStatus(
      observation.restartRestore,
      timingFloor(observation.restartRestoreElapsedMs),
    ),
    contentUnchanged: current.contentUnchanged,
    networkBoundary: worstStatus(current.networkBoundary, observation.networkBoundary),
    recoveryAbsent: worstStatus(current.recoveryAbsent, observation.recoveryAbsent),
    finalHostStopped: worstStatus(current.finalHostStopped, observation.finalHostStopped),
  };
  const status = worstStatus(...FINAL_GATE_KEYS.map((key) => gates[key]));
  const categorySource = {
    ...gates,
    scanElapsedMs: observation.scanElapsedMs,
    restartRestoreElapsedMs: observation.restartRestoreElapsedMs,
  };
  const failureCategories = deriveCategoriesFromReport(categorySource);

  return Object.freeze({
    schemaVersion: 1,
    scope: "dedicated-synthetic-vault",
    contentPolicy: "deterministic-synthetic-notes-only",
    buildMode: "read-only-acceptance",
    status,
    recordedAt: observation.recordedAt,
    runId: current.runId,
    commit: current.commit,
    pluginVersion: current.pluginVersion,
    obsidianVersion: observation.obsidianVersion,
    artifactBinding: current.artifactBinding,
    syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
    scanElapsedMs: observation.scanElapsedMs,
    restartRestoreElapsedMs: observation.restartRestoreElapsedMs,
    artifactIdentity: gates.artifactIdentity,
    fixtureIdentity: gates.fixtureIdentity,
    automatedSafety: gates.automatedSafety,
    hostIsolation: gates.hostIsolation,
    banner: gates.banner,
    startupNormalization: gates.startupNormalization,
    quickCaptureBlocked: gates.quickCaptureBlocked,
    organizationWritesBlocked: gates.organizationWritesBlocked,
    undoBlocked: gates.undoBlocked,
    historySensitiveActionsBlocked: gates.historySensitiveActionsBlocked,
    aiBlocked: gates.aiBlocked,
    readSurfaces: gates.readSurfaces,
    restartRestore: gates.restartRestore,
    contentUnchanged: gates.contentUnchanged,
    networkBoundary: gates.networkBoundary,
    recoveryAbsent: gates.recoveryAbsent,
    finalHostStopped: gates.finalHostStopped,
    failureCategories,
  });
}

export function computeReportStatus(report) {
  return computeStatusFromReport(canonicalReportShape(report));
}

export function deriveFailureCategories(report) {
  return deriveCategoriesFromReport(canonicalReportShape(report));
}

export function encodeReadOnlyAcceptanceReport(report) {
  return encodeCanonical(requireReportConsistency(canonicalReportShape(report)));
}
