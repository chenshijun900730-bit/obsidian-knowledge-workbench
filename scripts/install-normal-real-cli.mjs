import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_REQUEST_BYTES = 16 * 1024;
const AUTHORIZED_ACTION = "INSTALL_NORMAL_BUILD_IN_THIS_VAULT";
const FAILURE_PREFIX = "Real-vault normal installation failed";
const SUCCESS_MESSAGE = "Installed the bound normal build into the authorized real vault; Obsidian was not started and the plugin remains disabled.\n";
const PROJECT_OVERRIDE = /^KNOWLEDGE_WORKBENCH_.*(?:ROOT|PATH|VAULT|FIXTURE|ARTIFACT|MODE|LEASE|OUTPUT|RECEIPT|SEED)$/u;
const ALLOWED_FAILURE_CATEGORIES = new Set([
  "invalid-invocation",
  "artifact-invalid",
  "artifact-changed",
  "vault-invalid",
  "vault-changed",
  "host-running",
  "host-state-unknown",
  "plugin-enabled",
  "plugin-state-changed",
  "target-invalid",
  "target-changed",
  "concurrent-operation",
  "rollback-incomplete",
  "cleanup-incomplete",
]);

function fail(category) {
  process.stderr.write(`${FAILURE_PREFIX}: ${category}.\n`);
  process.exitCode = 1;
}

function exactRequest(value) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "vaultPath") return null;
  if (value.action !== AUTHORIZED_ACTION || typeof value.vaultPath !== "string") return null;
  return Object.freeze({ action: value.action, vaultPath: value.vaultPath });
}

async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const request = exactRequest(parsed);
  if (request === null) throw new Error("invalid request");
  return request;
}

async function main() {
  if (
    process.argv.length !== 2
    || Object.keys(process.env).some((name) => (
      name === "OBSIDIAN_DEV_VAULT" || PROJECT_OVERRIDE.test(name)
    ))
  ) {
    fail("invalid-invocation");
    return;
  }

  let request;
  try {
    request = await readRequest();
  } catch {
    fail("invalid-invocation");
    return;
  }

  let extractFailureCategory = null;
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { installRealVaultNormal } = await import("./install-acceptance-real.mjs");
    const extractor = Object.getOwnPropertyDescriptor(
      installRealVaultNormal,
      "extractFailureCategory",
    );
    if (extractor !== undefined && Object.hasOwn(extractor, "value")) {
      extractFailureCategory = extractor.value;
    }
    await installRealVaultNormal({ repoRoot, ...request });
    process.stdout.write(SUCCESS_MESSAGE);
  } catch (error) {
    let category = "artifact-invalid";
    try {
      const extracted = typeof extractFailureCategory === "function"
        ? extractFailureCategory(error)
        : null;
      if (typeof extracted === "string" && ALLOWED_FAILURE_CATEGORIES.has(extracted)) {
        category = extracted;
      }
    } catch {
      category = "artifact-invalid";
    }
    fail(category);
  }
}

await main();
