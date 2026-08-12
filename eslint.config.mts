import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores(["node_modules", "coverage", ".dev-vault/**", ".worktrees/**", "dist/**", "main.js", "package-lock.json", "versions.json"]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__: "readonly",
        __KNOWLEDGE_WORKBENCH_BUILD_MODE__: "readonly",
        __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__: "readonly",
        __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__: "readonly",
      },
      parserOptions: {
        projectService: {
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32,
          allowDefaultProject: [
            "eslint.config.mts",
            "esbuild.config.mjs",
            "scripts/*.mjs",
            "src/runtime/*.mjs",
            "manifest.json",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    // This standalone filesystem installer has no Obsidian Vault instance or Vault#configDir.
    files: ["scripts/install-dev.mjs"],
    rules: { "obsidianmd/hardcoded-config-path": "off" },
  },
);
