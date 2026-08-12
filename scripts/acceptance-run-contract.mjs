import { createHash } from "node:crypto";
import { isStrictBoundedSemver } from "../src/runtime/strict-semver.mjs";
import {
  SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
  SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
} from "./synthetic-note-fixture.mjs";

export const PREPARATION_STATE_RELATIVE_PATH = ".dev-vault/read-only-acceptance-state.json";
export const INSTALLATION_RECEIPT_RELATIVE_PATH = ".dev-vault/read-only-acceptance-receipt.json";
export const ACCEPTANCE_REPORT_RELATIVE_PATH = ".dev-vault/read-only-acceptance-report.json";
export const SYNTHETIC_ACCEPTANCE_VAULT_RELATIVE_PATH = ".dev-vault/read-only-acceptance-vault";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const STATE_KEYS = Object.freeze([
  "schemaVersion",
  "scope",
  "contentPolicy",
  "runId",
  "commit",
  "syntheticNoteCount",
  "syntheticTotalBytes",
  "corpusDigest",
]);
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "runId",
  "commit",
  "pluginVersion",
  "artifactBinding",
  "artifactSetDigest",
  "fixtureStateDigest",
  "seedDataDigest",
]);

function requireRecord(value, label) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || !actual.every((key, index) => key === keys[index])
  ) {
    throw new Error(`${label} must use the exact keys in canonical order`);
  }
}

function requireRunId(value, label = "Run ID") {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new Error(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function requireCommit(value, label = "Commit") {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error(`${label} must be a lowercase 40- or 64-hex Git object ID`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  try {
    return Buffer.from(value);
  } catch (error) {
    throw new TypeError(`${label} must be readable bytes`, { cause: error });
  }
}

function canonicalState(value) {
  const state = requireRecord(value, "Preparation state");
  requireExactKeys(state, STATE_KEYS, "Preparation state");
  if (state.schemaVersion !== 1) throw new Error("Preparation state schemaVersion must equal 1");
  if (state.scope !== "dedicated-synthetic-vault") {
    throw new Error("Preparation state scope must be dedicated-synthetic-vault");
  }
  if (state.contentPolicy !== "deterministic-synthetic-notes-only") {
    throw new Error("Preparation state contentPolicy must be deterministic-synthetic-notes-only");
  }
  const runId = requireRunId(state.runId);
  const commit = requireCommit(state.commit);
  if (
    !Number.isSafeInteger(state.syntheticNoteCount)
    || state.syntheticNoteCount !== SYNTHETIC_ACCEPTANCE_NOTE_COUNT
  ) {
    throw new Error("Preparation state synthetic note count must equal 5000");
  }
  if (
    !Number.isSafeInteger(state.syntheticTotalBytes)
    || state.syntheticTotalBytes !== SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES
  ) {
    throw new Error("Preparation state synthetic total bytes must equal 78643200");
  }
  const corpusDigest = requireDigest(state.corpusDigest, "Corpus digest");
  return Object.freeze({
    schemaVersion: 1,
    scope: "dedicated-synthetic-vault",
    contentPolicy: "deterministic-synthetic-notes-only",
    runId,
    commit,
    syntheticNoteCount: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
    syntheticTotalBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    corpusDigest,
  });
}

function canonicalReceipt(value) {
  const receipt = requireRecord(value, "Installation receipt");
  requireExactKeys(receipt, RECEIPT_KEYS, "Installation receipt");
  if (receipt.schemaVersion !== 1) throw new Error("Installation receipt schemaVersion must equal 1");
  const runId = requireRunId(receipt.runId);
  const commit = requireCommit(receipt.commit);
  if (!isStrictBoundedSemver(receipt.pluginVersion)) {
    throw new Error("Installation receipt plugin version must be a bounded semantic version");
  }
  const artifactBinding = `knowledge-workbench@${receipt.pluginVersion}:read-only-acceptance`;
  if (receipt.artifactBinding !== artifactBinding) {
    throw new Error("Installation receipt artifact binding must match the plugin version and acceptance mode");
  }
  const artifactSetDigest = requireDigest(receipt.artifactSetDigest, "Artifact-set digest");
  const fixtureStateDigest = requireDigest(receipt.fixtureStateDigest, "Fixture-state digest");
  const seedDataDigest = requireDigest(receipt.seedDataDigest, "Seed-data digest");
  return Object.freeze({
    schemaVersion: 1,
    runId,
    commit,
    pluginVersion: receipt.pluginVersion,
    artifactBinding,
    artifactSetDigest,
    fixtureStateDigest,
    seedDataDigest,
  });
}

function encodeCanonical(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function decodeJson(bytes, label) {
  const input = requireBytes(bytes, label);
  let text;
  try {
    text = UTF8.decode(input);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8`, { cause: error });
  }
  try {
    return { input, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createPreparationState(input) {
  const value = requireRecord(input, "Preparation-state input");
  const attestation = requireRecord(value.attestation, "Corpus attestation");
  if (typeof attestation.tree !== "object" || attestation.tree === null || Array.isArray(attestation.tree)) {
    throw new Error("Corpus attestation must include an in-process tree snapshot");
  }
  return canonicalState({
    schemaVersion: 1,
    scope: "dedicated-synthetic-vault",
    contentPolicy: "deterministic-synthetic-notes-only",
    runId: requireRunId(value.runId),
    commit: requireCommit(value.commit),
    syntheticNoteCount: attestation.syntheticNoteCount,
    syntheticTotalBytes: attestation.syntheticTotalBytes,
    corpusDigest: attestation.corpusDigest,
  });
}

export function encodePreparationState(state) {
  return encodeCanonical(canonicalState(state));
}

export function decodePreparationState(bytes) {
  const decoded = decodeJson(bytes, "Preparation-state bytes");
  const state = canonicalState(decoded.value);
  if (!decoded.input.equals(encodeCanonical(state))) {
    throw new Error("Preparation-state bytes must use the exact canonical encoding and final newline");
  }
  return state;
}

export function createInstallationReceipt(input) {
  const value = requireRecord(input, "Installation-receipt input");
  const state = canonicalState(value.state);
  const stateBytes = requireBytes(value.stateBytes, "Preparation-state bytes");
  const decodedState = decodePreparationState(stateBytes);
  if (!stateBytes.equals(encodeCanonical(state)) || decodedState.runId !== state.runId || decodedState.commit !== state.commit) {
    throw new Error("Installation receipt state bytes must exactly match the supplied preparation state");
  }
  if (!isStrictBoundedSemver(value.pluginVersion)) {
    throw new Error("Installation receipt plugin version must be a bounded semantic version");
  }
  const artifactBinding = `knowledge-workbench@${value.pluginVersion}:read-only-acceptance`;
  if (value.artifactBinding !== artifactBinding) {
    throw new Error("Installation receipt artifact binding must match the plugin version and acceptance mode");
  }
  const artifactSetDigest = requireDigest(value.artifactSetDigest, "Artifact-set digest");
  const seedBytes = requireBytes(value.seedBytes, "Seed bytes");
  return canonicalReceipt({
    schemaVersion: 1,
    runId: state.runId,
    commit: state.commit,
    pluginVersion: value.pluginVersion,
    artifactBinding,
    artifactSetDigest,
    fixtureStateDigest: digest(stateBytes),
    seedDataDigest: digest(seedBytes),
  });
}

export function encodeInstallationReceipt(receipt) {
  return encodeCanonical(canonicalReceipt(receipt));
}

export function decodeInstallationReceipt(bytes) {
  const decoded = decodeJson(bytes, "Installation-receipt bytes");
  const receipt = canonicalReceipt(decoded.value);
  if (!decoded.input.equals(encodeCanonical(receipt))) {
    throw new Error("Installation-receipt bytes must use the exact canonical encoding and final newline");
  }
  return receipt;
}
