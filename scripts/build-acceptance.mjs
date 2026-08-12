import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAcceptanceArtifact } from "./acceptance-build.mjs";

if (process.argv.length !== 2) {
  process.stderr.write("build-acceptance does not accept arguments or an output path\n");
  process.exitCode = 1;
} else {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    await buildAcceptanceArtifact({ repoRoot });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
