import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ALLOWED_FAILURE_CATEGORIES = new Set([
  "invalid-invocation",
  "target-exists",
  "concurrent-operation",
  "fixture-invalid",
  "fixture-changed",
  "cleanup-incomplete",
]);

const PROJECT_PATH_OVERRIDE = /^KNOWLEDGE_WORKBENCH_.*(?:ROOT|PATH|VAULT|FIXTURE)$/u;
const SUCCESS_MESSAGE = "Prepared the fixed synthetic acceptance vault; Obsidian was not started.\n";

function hasForbiddenEnvironmentOverride() {
  return Object.keys(process.env).some((name) => (
    name === "OBSIDIAN_DEV_VAULT" || PROJECT_PATH_OVERRIDE.test(name)
  ));
}

function failureCategory(error) {
  if (typeof error !== "object" || error === null) return "fixture-invalid";

  try {
    return typeof error.category === "string" && ALLOWED_FAILURE_CATEGORIES.has(error.category)
      ? error.category
      : "fixture-invalid";
  } catch {
    return "fixture-invalid";
  }
}

function fail(category) {
  process.stderr.write(`Synthetic acceptance preparation failed: ${category}.\n`);
  process.exitCode = 1;
}

async function main() {
  if (process.argv.length !== 2 || hasForbiddenEnvironmentOverride()) {
    fail("invalid-invocation");
    return;
  }

  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { prepareSyntheticAcceptance } = await import("./prepare-acceptance-synthetic.mjs");
    await prepareSyntheticAcceptance({ repoRoot });
    process.stdout.write(SUCCESS_MESSAGE);
  } catch (error) {
    fail(failureCategory(error));
  }
}

await main();
