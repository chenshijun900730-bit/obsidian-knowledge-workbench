import { build, type BuildResult, type OutputFile } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error The acceptance contract is intentionally plain ESM without a declaration file.
const contract = await import("../../scripts/acceptance-artifact-contract.mjs") as unknown as {
  readonly FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT: readonly string[];
};

const root = fileURLToPath(new URL("../..", import.meta.url));

const bundle = async (
  entryPoint: "src/main.ts" | "src/main-acceptance.ts",
  mode: "normal" | "read-only-acceptance",
  manifestName: "Knowledge Workbench" | "Knowledge Workbench (Read-only acceptance)",
): Promise<BuildResult<{ metafile: true; write: false }>> => build({
  absWorkingDir: root,
  entryPoints: [entryPoint],
  bundle: true,
  define: {
    __KNOWLEDGE_WORKBENCH_BUILD_MODE__: JSON.stringify(mode),
    __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__: JSON.stringify("0.1.0"),
    __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__: JSON.stringify(manifestName),
    __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__: JSON.stringify(
      `knowledge-workbench@0.1.0:${mode}`,
    ),
  },
  external: ["obsidian"],
  format: "cjs",
  logLevel: "silent",
  metafile: true,
  platform: "browser",
  sourcemap: false,
  target: "es2021",
  treeShaking: true,
  write: false,
});

const inputPaths = (result: BuildResult<{ metafile: true; write: false }>): readonly string[] =>
  Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));

const outputText = (result: BuildResult<{ metafile: true; write: false }>): string =>
  result.outputFiles.map((file: OutputFile) => file.text).join("\n");

describe("composition-root dependency graphs", () => {
  it("keeps the read-only acceptance bundle free of normal-only capabilities", async () => {
    const result = await bundle(
      "src/main-acceptance.ts",
      "read-only-acceptance",
      "Knowledge Workbench (Read-only acceptance)",
    );
    const inputs = inputPaths(result);
    const forbiddenInputs = [
      "src/main.ts",
      "src/adapters/obsidian-quick-capture-adapter.ts",
      "src/ui/quick-capture-modal.ts",
      "src/adapters/obsidian-ai-client.ts",
      "src/ui/ai-payload-preview-modal.ts",
    ];

    for (const forbidden of forbiddenInputs) {
      expect(inputs, forbidden).not.toContain(forbidden);
    }
    expect(contract.FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT).toEqual([
      "requestUrl",
      "WebSocket",
      "fetch(",
      "secretStorage",
      "SecretComponent",
      "ObsidianAiClient",
      "ObsidianQuickCaptureAdapter",
    ]);
    for (const forbidden of contract.FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT) {
      expect(outputText(result), forbidden).not.toContain(forbidden);
    }
  });

  it("retains normal capabilities in the normal entry graph", async () => {
    const result = await bundle(
      "src/main.ts",
      "normal",
      "Knowledge Workbench",
    );
    const inputs = inputPaths(result);

    expect(inputs).toEqual(expect.arrayContaining([
      "src/adapters/obsidian-quick-capture-adapter.ts",
      "src/ui/quick-capture-modal.ts",
      "src/adapters/obsidian-ai-client.ts",
      "src/ui/ai-payload-preview-modal.ts",
    ]));
    expect(outputText(result)).toMatch(/requestUrl/u);
    expect(outputText(result)).toMatch(/secretStorage/u);
  });
});
