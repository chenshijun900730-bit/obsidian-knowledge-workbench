import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_FAILURE_CATEGORIES = new Set([
  "invalid-invocation",
  "artifact-invalid",
  "artifact-changed",
  "fixture-invalid",
  "fixture-changed",
  "plugin-enabled",
  "target-exists",
  "concurrent-operation",
  "rollback-incomplete",
  "cleanup-incomplete",
]);

const PROJECT_OVERRIDE = /^KNOWLEDGE_WORKBENCH_.*(?:ROOT|PATH|VAULT|FIXTURE|ARTIFACT|MODE|LEASE|OUTPUT|RECEIPT|SEED)$/u;
const SUCCESS_MESSAGE = "Installed the bound read-only acceptance build into the fixed synthetic vault; Obsidian was not started.\n";

function hasForbiddenEnvironmentOverride() {
  return Object.keys(process.env).some((name) => (
    name === "OBSIDIAN_DEV_VAULT" || PROJECT_OVERRIDE.test(name)
  ));
}

function failureCategory(extractFailureCategory, error) {
  try {
    const category = typeof extractFailureCategory === "function"
      ? extractFailureCategory(error)
      : null;
    return typeof category === "string" && ALLOWED_FAILURE_CATEGORIES.has(category)
      ? category
      : "artifact-invalid";
  } catch {
    return "artifact-invalid";
  }
}

function fail(category) {
  process.stderr.write(`Synthetic acceptance installation failed: ${category}.\n`);
  process.exitCode = 1;
}

async function main() {
  if (process.argv.length !== 2 || hasForbiddenEnvironmentOverride()) {
    fail("invalid-invocation");
    return;
  }

  let extractFailureCategory = null;
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { installAcceptanceDevelopment } = await import("./install-acceptance-dev.mjs");
    const extractor = Object.getOwnPropertyDescriptor(
      installAcceptanceDevelopment,
      "extractFailureCategory",
    );
    if (extractor !== undefined && Object.hasOwn(extractor, "value")) {
      extractFailureCategory = extractor.value;
    }
    await installAcceptanceDevelopment({ repoRoot });
    process.stdout.write(SUCCESS_MESSAGE);
  } catch (error) {
    fail(failureCategory(extractFailureCategory, error));
  }
}

await main();
