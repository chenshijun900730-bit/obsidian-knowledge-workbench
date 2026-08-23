import { build, type BuildResult, type OutputFile } from "esbuild";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";

// @ts-expect-error The acceptance contract is intentionally plain ESM without a declaration file.
const contract = await import("../../scripts/acceptance-artifact-contract.mjs") as unknown as {
  readonly FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT: readonly string[];
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const nodeExternals = [...new Set(
  builtinModules.flatMap((name) => [
    name,
    name.startsWith("node:") ? name.slice(5) : `node:${name}`,
  ]),
)];

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
  external: ["obsidian", ...nodeExternals],
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

const externalImports = (
  result: BuildResult<{ metafile: true; write: false }>,
): readonly string[] => Object.values(result.metafile.inputs)
  .flatMap((input) => input.imports)
  .filter((value) => value.external)
  .map((value) => value.path);

describe("composition-root dependency graphs", () => {
  it("wires one loaded-store locale provider through every user-facing factory", async () => {
    const [contractSource, pluginSource, normalSource, acceptanceSource] = await Promise.all([
      readFile(join(root, "src/runtime/runtime-composition.ts"), "utf8"),
      readFile(join(root, "src/plugin/knowledge-workbench-plugin.ts"), "utf8"),
      readFile(join(root, "src/main.ts"), "utf8"),
      readFile(join(root, "src/main-acceptance.ts"), "utf8"),
    ]);
    expect(contractSource).toMatch(/export type\s*\{\s*WorkbenchLocaleProvider\s*\}/u);
    expect(pluginSource).toContain("const getLocale: WorkbenchLocaleProvider = () => store.settings().locale");
    for (const factory of [
      "createQuickCapture",
      "createChangePreview",
      "createHistoryConfirmation",
      "createSettingsTab",
      "createWorkbenchSettingsSurface",
      "createAi",
      "createCatalogConfirmation",
      "createCatalogTxtImportConfirmation",
      "createCatalogLargeScanConfirmation",
      "createCatalogDirectoryPicker",
    ]) expect(pluginSource, factory).toMatch(new RegExp(`${factory}[^\\n]*getLocale|${factory}[\\s\\S]{0,160}getLocale`, "u"));
    expect(normalSource).toContain("getLocale");
    expect(acceptanceSource).toContain("getLocale");
    expect(acceptanceSource).not.toMatch(/requestUrl|secretStorage|createCatalogDirectoryPicker/u);
  });

  it("keeps the read-only acceptance bundle free of normal-only capabilities", async () => {
    const result = await bundle(
      "src/main-acceptance.ts",
      "read-only-acceptance",
      "Knowledge Workbench (Read-only acceptance)",
    );
    const inputs = inputPaths(result);
    const output = outputText(result);
    const forbiddenInputs = [
      "src/main.ts",
      "src/adapters/obsidian-quick-capture-adapter.ts",
      "src/ui/quick-capture-modal.ts",
      "src/adapters/obsidian-ai-client.ts",
      "src/ui/ai-payload-preview-modal.ts",
      "src/adapters/local-catalog-snapshot-adapter.ts",
      "src/catalog/catalog-codec.ts",
      "src/adapters/obsidian-baidu-credential-adapter.ts",
      "src/adapters/baidu-oauth-adapter.ts",
      "src/adapters/baidu-catalog-source-adapter.ts",
      "src/catalog/cloud-catalog-connection-runtime.ts",
      "src/catalog/catalog-scan-service.ts",
      "src/catalog/cloud-directory-discovery-service.ts",
      "src/catalog/cloud-directory-locator.ts",
      "src/ui/cloud-directory-picker.ts",
    ];

    for (const forbidden of forbiddenInputs) {
      expect(inputs, forbidden).not.toContain(forbidden);
    }
    expect(inputs.filter((path) => /baidu.*adapter|adapter.*baidu/iu.test(path))).toEqual([]);
    expect(inputs.filter((path) => path.startsWith("node_modules/"))).toEqual([]);
    expect(externalImports(result).filter((path) => nodeExternals.includes(path))).toEqual([]);
    expect(output).not.toMatch(/node:(?:fs|path|os)/u);
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
      expect(output, forbidden).not.toContain(forbidden);
    }
    expect(output).not.toContain("CloudDirectoryDiscoveryService");
    expect(output).not.toContain("CloudDirectoryLocatorService");
    expect(output).not.toMatch(/method=download|\/filemanager|["']dlink["']/u);
  });

  it("retains normal capabilities in the normal entry graph", async () => {
    const result = await bundle(
      "src/main.ts",
      "normal",
      "Knowledge Workbench",
    );
    const inputs = inputPaths(result);
    const output = outputText(result);

    expect(inputs).toEqual(expect.arrayContaining([
      "src/adapters/obsidian-quick-capture-adapter.ts",
      "src/ui/quick-capture-modal.ts",
      "src/adapters/obsidian-ai-client.ts",
      "src/ui/ai-payload-preview-modal.ts",
      "src/adapters/local-catalog-snapshot-adapter.ts",
      "src/adapters/obsidian-baidu-credential-adapter.ts",
      "src/adapters/baidu-oauth-adapter.ts",
      "src/adapters/baidu-catalog-source-adapter.ts",
      "src/catalog/cloud-catalog-connection-runtime.ts",
      "src/catalog/catalog-scan-service.ts",
      "src/catalog/cloud-directory-discovery-service.ts",
      "src/catalog/cloud-directory-locator.ts",
      "src/ui/cloud-directory-picker.ts",
    ]));
    expect(output).toMatch(/requestUrl/u);
    expect(output).toMatch(/secretStorage/u);
    expect(output).toContain("maxListRequestCount");
    expect(output).toContain("maxDurationMs");
    expect(output).toContain("CloudDirectoryDiscoveryService");
    expect(output).toContain("CloudDirectoryLocatorService");
    expect(output).not.toMatch(/method=download|\/filemanager|["']dlink["']/u);

    const sourceAdapter = await readFile(
      join(root, "src/adapters/baidu-catalog-source-adapter.ts"),
      "utf8",
    );
    expect([...sourceAdapter.matchAll(/searchParams\.set\("method", "([^"]+)"\)/gu)]
      .map((match) => match[1])).toEqual(["list"]);
    expect(sourceAdapter).not.toMatch(
      /method=download|filemanager|["']dlink["']|["'](?:upload|delete|rename|move)["']/u,
    );

    const [normalSource, catalogCompositionSource] = await Promise.all([
      readFile(join(root, "src/main.ts"), "utf8"),
      readFile(join(root, "src/runtime/normal-cloud-catalog-composition.ts"), "utf8"),
    ]);
    expect(normalSource).not.toMatch(/FileSystemAdapter|getBasePath|vault\.configDir/u);
    expect(catalogCompositionSource).toContain("homedir()");
    expect(catalogCompositionSource).toContain('"Application Support"');
    expect(catalogCompositionSource).not.toMatch(/vaultBasePath|configDirectory/u);
    expect(catalogCompositionSource.match(/new BaiduCatalogSourceAdapter/gu)).toHaveLength(1);
    expect(catalogCompositionSource).toMatch(
      /new CloudDirectoryDiscoveryService\(baiduSource/u,
    );
    expect(catalogCompositionSource).toMatch(
      /new CloudDirectoryLocatorService\(baiduSource/u,
    );
  });
});
