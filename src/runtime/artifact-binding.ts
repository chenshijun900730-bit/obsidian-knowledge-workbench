import { isStrictBoundedSemver } from "./strict-semver.mjs";

export interface AcceptanceBuildMetadata {
  readonly schemaVersion: 1;
  readonly pluginVersion: string;
  readonly buildMode: "read-only-acceptance";
  readonly artifactBinding: string;
  readonly contentWrites: "blocked";
  readonly network: "blocked";
}

export type ArtifactExpectation = Readonly<{
  mode: "normal" | "read-only-acceptance";
  pluginVersion: string;
  manifestName: "Knowledge Workbench" | "Knowledge Workbench (Read-only acceptance)";
  artifactBinding: string;
}>;

export interface HostArtifactPort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

export interface HostPluginManifest {
  readonly dir?: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

const FAILURE_PREFIX = "Knowledge Workbench artifact binding failed:";
const PLUGIN_ID = "knowledge-workbench";
const NORMAL_MANIFEST_NAME = "Knowledge Workbench";
const ACCEPTANCE_MANIFEST_NAME = "Knowledge Workbench (Read-only acceptance)";
const BASE_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"] as const);
const ACCEPTANCE_METADATA_FILE = "acceptance-build.json";
const METADATA_KEYS = Object.freeze([
  "artifactBinding",
  "buildMode",
  "contentWrites",
  "network",
  "pluginVersion",
  "schemaVersion",
] as const);

const bindingFailure = (detail: string): Error => new Error(`${FAILURE_PREFIX} ${detail}`);

const prefixedFailure = (cause: unknown): Error => {
  let detail = "unexpected verifier failure";
  try {
    if (typeof cause === "string") {
      detail = cause;
    } else if (
      (typeof cause === "object" && cause !== null)
      || typeof cause === "function"
    ) {
      const message = Reflect.get(cause, "message") as unknown;
      if (typeof message === "string") detail = message;
    }
  } catch {
    detail = "unexpected verifier failure";
  }
  return detail.startsWith(FAILURE_PREFIX) ? new Error(detail) : bindingFailure(detail);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const isBoundedSemanticVersion = (value: unknown): value is string => (
  isStrictBoundedSemver(value)
);

const assertExactMetadataKeys = (value: Record<string, unknown>): void => {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw bindingFailure("acceptance metadata must have exactly six string keys");
  }
  const sorted = (ownKeys as string[]).sort();
  if (
    sorted.length !== METADATA_KEYS.length
    || sorted.some((key, index) => key !== METADATA_KEYS[index])
  ) {
    throw bindingFailure("acceptance metadata must have exactly six known keys");
  }
};

export function decodeAcceptanceBuildMetadata(value: unknown): AcceptanceBuildMetadata {
  try {
    if (!isRecord(value)) throw bindingFailure("acceptance metadata must be an object");
    assertExactMetadataKeys(value);
    if (value.schemaVersion !== 1) throw bindingFailure("acceptance metadata schemaVersion must be 1");
    if (!isBoundedSemanticVersion(value.pluginVersion)) {
      throw bindingFailure("acceptance metadata pluginVersion must be a bounded semantic version");
    }
    if (value.buildMode !== "read-only-acceptance") {
      throw bindingFailure("acceptance metadata buildMode is invalid");
    }
    if (typeof value.artifactBinding !== "string") {
      throw bindingFailure("acceptance metadata artifactBinding must be a string");
    }
    if (value.contentWrites !== "blocked") {
      throw bindingFailure("acceptance metadata contentWrites must be blocked");
    }
    if (value.network !== "blocked") {
      throw bindingFailure("acceptance metadata network must be blocked");
    }
    const expectedBinding = `${PLUGIN_ID}@${value.pluginVersion}:read-only-acceptance`;
    if (value.artifactBinding !== expectedBinding) {
      throw bindingFailure("acceptance metadata artifactBinding is incoherent");
    }
    return Object.freeze({
      schemaVersion: 1,
      pluginVersion: value.pluginVersion,
      buildMode: "read-only-acceptance",
      artifactBinding: value.artifactBinding,
      contentWrites: "blocked",
      network: "blocked",
    });
  } catch (cause) {
    throw prefixedFailure(cause);
  }
}

const assertCoherentExpectation = (expectation: ArtifactExpectation): void => {
  if (expectation.mode !== "normal" && expectation.mode !== "read-only-acceptance") {
    throw bindingFailure("compiled mode is unsupported");
  }
  if (!isBoundedSemanticVersion(expectation.pluginVersion)) {
    throw bindingFailure("compiled plugin version is invalid");
  }
  const expectedName = expectation.mode === "normal" ? NORMAL_MANIFEST_NAME : ACCEPTANCE_MANIFEST_NAME;
  if (expectation.manifestName !== expectedName) {
    throw bindingFailure("compiled manifest name is incoherent");
  }
  const expectedBinding = `${PLUGIN_ID}@${expectation.pluginVersion}:${expectation.mode}`;
  if (expectation.artifactBinding !== expectedBinding) {
    throw bindingFailure("compiled artifact binding is incoherent");
  }
};

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const validatedPluginDirectory = (dir: unknown): string => {
  if (
    typeof dir !== "string"
    || dir.length === 0
    || dir !== dir.trim()
    || dir.startsWith("/")
    || dir.endsWith("/")
    || dir.includes("\\")
    || dir.includes(":")
    || containsControlCharacter(dir)
  ) {
    throw bindingFailure("manifest directory must be a normalized relative slash path");
  }
  const segments = dir.split("/");
  if (segments.some((segment) => (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment.endsWith(".")
    || segment.endsWith(" ")
  ))) {
    throw bindingFailure("manifest directory must be a normalized relative slash path");
  }
  if (segments.at(-1) !== PLUGIN_ID) {
    throw bindingFailure("manifest directory must end with knowledge-workbench");
  }
  return dir;
};

const requireInstalledFile = async (
  port: HostArtifactPort,
  directory: string,
  file: string,
): Promise<string> => {
  const path = `${directory}/${file}`;
  if (!await port.exists(path)) throw bindingFailure(`required installed file is missing: ${file}`);
  return path;
};

export async function verifyArtifactBinding(
  manifest: HostPluginManifest,
  port: HostArtifactPort,
  expectation: ArtifactExpectation,
): Promise<void> {
  try {
    assertCoherentExpectation(expectation);
    const directory = validatedPluginDirectory(manifest.dir);
    if (manifest.id !== PLUGIN_ID) throw bindingFailure("manifest ID is invalid");
    if (manifest.version !== expectation.pluginVersion) throw bindingFailure("manifest version is invalid");
    if (manifest.name !== expectation.manifestName) throw bindingFailure("manifest display name is invalid");

    for (const file of BASE_FILES) await requireInstalledFile(port, directory, file);
    const metadataPath = `${directory}/${ACCEPTANCE_METADATA_FILE}`;
    if (expectation.mode === "normal") {
      if (await port.exists(metadataPath)) {
        throw bindingFailure("normal runtime must not include acceptance metadata");
      }
      return;
    }

    await requireInstalledFile(port, directory, ACCEPTANCE_METADATA_FILE);
    const source = await port.read(metadataPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (cause) {
      throw prefixedFailure(cause);
    }
    const metadata = decodeAcceptanceBuildMetadata(parsed);
    if (metadata.pluginVersion !== expectation.pluginVersion) {
      throw bindingFailure("acceptance metadata version does not match the compiled version");
    }
    if (metadata.artifactBinding !== expectation.artifactBinding) {
      throw bindingFailure("acceptance metadata binding does not match the compiled binding");
    }
  } catch (cause) {
    throw prefixedFailure(cause);
  }
}
