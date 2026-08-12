import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PLUGIN_DATA_SCHEMA_VERSION, PLUGIN_ID, VIEW_TYPE } from "../../src/constants";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("plugin constants", () => {
  it("keeps manifest identity and storage schema stable", () => {
    expect(PLUGIN_ID).toBe("knowledge-workbench");
    expect(VIEW_TYPE).toBe("knowledge-workbench-view");
    expect(PLUGIN_DATA_SCHEMA_VERSION).toBe(1);
  });

  it("defines every artifact constant and wires the normal CLI identity", async () => {
    const source = await readFile(`${root}/esbuild.config.mjs`, "utf8");

    expect(source).toContain("__KNOWLEDGE_WORKBENCH_BUILD_MODE__: JSON.stringify(mode)");
    expect(source).toContain("__KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__: JSON.stringify(pluginVersion)");
    expect(source).toContain("__KNOWLEDGE_WORKBENCH_MANIFEST_NAME__: JSON.stringify(manifestName)");
    expect(source).toContain("__KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__: JSON.stringify(artifactBinding)");
    expect(source).toContain('mode: "normal"');
    expect(source).toContain("manifestName: identity.name");
    expect(source).toContain("artifactBinding: `${PLUGIN_ID}@${identity.version}:normal`");
  });
});
