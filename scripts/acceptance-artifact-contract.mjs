import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ACCEPTANCE_PLUGIN_NAME,
  PLUGIN_ID,
} from "../esbuild.config.mjs";
import { isStrictBoundedSemver } from "../src/runtime/strict-semver.mjs";

export const ACCEPTANCE_FILES = Object.freeze([
  "acceptance-build.json",
  "main.js",
  "manifest.json",
  "styles.css",
]);

export const FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT = Object.freeze([
  "requestUrl",
  "WebSocket",
  "fetch(",
  "secretStorage",
  "SecretComponent",
  "ObsidianAiClient",
  "ObsidianQuickCaptureAdapter",
]);

const ARTIFACT_SET_DOMAIN = Buffer.from(
  "knowledge-workbench-acceptance-artifact-set-v1\0",
  "ascii",
);

export function acceptanceMetadata(version) {
  return Object.freeze({
    schemaVersion: 1,
    pluginVersion: version,
    buildMode: "read-only-acceptance",
    artifactBinding: `${PLUGIN_ID}@${version}:read-only-acceptance`,
    contentWrites: "blocked",
    network: "blocked",
  });
}

function parseObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must decode to an object`);
  }
  return value;
}

function requireSnapshotShape(snapshot) {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new Error("Acceptance artifact snapshot must be an object");
  }
  if (
    typeof snapshot.directory !== "object"
    || snapshot.directory === null
    || typeof snapshot.directory.path !== "string"
    || !isAbsolute(snapshot.directory.path)
    || typeof snapshot.directory.dev !== "bigint"
    || typeof snapshot.directory.ino !== "bigint"
  ) {
    throw new Error("Acceptance artifact directory snapshot is invalid");
  }
  if (!Array.isArray(snapshot.names) || !isDeepStrictEqual([...snapshot.names], ACCEPTANCE_FILES)) {
    throw new Error("Acceptance artifact snapshot must use the exact four-file contract");
  }
  if (
    typeof snapshot.files !== "object"
    || snapshot.files === null
    || typeof snapshot.files.get !== "function"
    || typeof snapshot.files.keys !== "function"
    || snapshot.files.size !== ACCEPTANCE_FILES.length
    || !isDeepStrictEqual([...snapshot.files.keys()], ACCEPTANCE_FILES)
  ) {
    throw new Error("Acceptance artifact file map must contain the exact four files in contract order");
  }
}

function requireFrozenFile(snapshot, name) {
  const file = snapshot.files.get(name);
  if (
    typeof file !== "object"
    || file === null
    || typeof file.path !== "string"
    || basename(file.path) !== name
    || !Buffer.isBuffer(file.bytes)
    || file.bytes.byteLength === 0
    || typeof file.evidence !== "object"
    || file.evidence === null
    || typeof file.evidence.dev !== "bigint"
    || typeof file.evidence.ino !== "bigint"
    || file.evidence.nlink !== 1n
    || file.evidence.size !== BigInt(file.bytes.byteLength)
    || typeof file.evidence.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(file.evidence.sha256)
    || createHash("sha256").update(file.bytes).digest("hex") !== file.evidence.sha256
  ) {
    throw new Error(`Acceptance artifact file ${name} has invalid frozen evidence`);
  }
  return file;
}

export function validateAcceptanceArtifactSnapshot(snapshot) {
  requireSnapshotShape(snapshot);
  const files = new Map();
  for (const name of ACCEPTANCE_FILES) files.set(name, requireFrozenFile(snapshot, name));

  const manifest = parseObject(files.get("manifest.json").bytes, "Acceptance manifest");
  if (manifest.id !== PLUGIN_ID || manifest.name !== ACCEPTANCE_PLUGIN_NAME) {
    throw new Error("Acceptance manifest identity must be exact");
  }
  if (!isStrictBoundedSemver(manifest.version)) {
    throw new Error("Acceptance manifest version must be a bounded semantic version");
  }

  const metadataFile = files.get("acceptance-build.json");
  const metadataText = metadataFile.bytes.toString("utf8");
  if (!metadataText.endsWith("\n")) throw new Error("Acceptance metadata must end with a newline");
  const metadata = parseObject(metadataFile.bytes, "Acceptance metadata");
  if (!isDeepStrictEqual(metadata, acceptanceMetadata(manifest.version))) {
    throw new Error("Acceptance metadata must use the exact six coherent keys");
  }

  const artifactBinding = `${PLUGIN_ID}@${manifest.version}:read-only-acceptance`;
  const bundle = files.get("main.js").bytes.toString("utf8");
  for (const forbidden of FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT) {
    if (bundle.includes(forbidden)) {
      throw new Error(`Acceptance bundle contains forbidden capability ${forbidden}`);
    }
  }
  for (const required of [
    "read-only-acceptance",
    manifest.version,
    ACCEPTANCE_PLUGIN_NAME,
    artifactBinding,
  ]) {
    if (!bundle.includes(required)) throw new Error(`Acceptance bundle is missing compile binding ${required}`);
  }

  return Object.freeze({ pluginVersion: manifest.version, artifactBinding });
}

export function computeAcceptanceArtifactSetDigest(snapshot) {
  validateAcceptanceArtifactSnapshot(snapshot);
  const hash = createHash("sha256");
  hash.update(ARTIFACT_SET_DOMAIN);
  const names = [...ACCEPTANCE_FILES].sort((left, right) => (
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  ));
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const file = snapshot.files.get(name);
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
