import { configDefaults, defineConfig } from "vitest/config";

const performance = process.env.KNOWLEDGE_WORKBENCH_PERFORMANCE === "1";
const heavyAcceptanceTest = "tests/packaging/install-acceptance-dev-heavy.test.ts";
const acceptanceWorkflowTests = "tests/packaging/**/*acceptance*.test.ts";
const baseExclude = performance
  ? [...configDefaults.exclude]
  : [...configDefaults.exclude, "tests/performance/**"];

export default defineConfig({
  test: {
    environment: "node",
    exclude: baseExclude,
    projects: performance ? undefined : [
      {
        extends: true,
        test: {
          name: "default",
          environment: "node",
          exclude: [...baseExclude, acceptanceWorkflowTests],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "acceptance-workflows",
          environment: "node",
          include: [acceptanceWorkflowTests],
          exclude: [...baseExclude, heavyAcceptanceTest],
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "acceptance-heavy",
          environment: "node",
          include: [heavyAcceptanceTest],
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
