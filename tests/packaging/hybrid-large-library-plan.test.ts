import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const plan = readFileSync(
  resolve("docs/superpowers/plans/2026-08-10-baidu-catalog-hybrid-large-library.md"),
  "utf8",
);

function taskTenInstallStep(): string {
  const startMarker = /- \[[ x]\] \*\*Step 5:/u;
  const endMarker = /- \[[ x]\] \*\*Step 6:/u;
  const taskTen = plan.slice(plan.indexOf("### Task 10:"));
  const start = taskTen.search(startMarker);
  const remaining = start < 0 ? "" : taskTen.slice(start);
  const relativeEnd = remaining.search(endMarker);
  const end = relativeEnd < 0 ? -1 : start + relativeEnd;
  if (start < 0 || end < 0) return "";
  return taskTen.slice(start, end);
}

describe("hybrid large-library implementation plan", () => {
  it("uses the disabled normal synthetic-vault installer for Task 10", () => {
    const step = taskTenInstallStep();
    const normalized = step.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      'OBSIDIAN_DEV_VAULT="$(pwd)/.dev-vault/baidu-catalog-oob" npm run install:dev',
    );
    expect(normalized).toContain("plugin is disabled");
    expect(normalized).toContain("Obsidian is fully quit");
    expect(normalized).toContain(
      "must not delete or replace an existing fixed read-only acceptance run",
    );
    expect(normalized).not.toContain("npm run prepare:acceptance:synthetic");
    expect(normalized).not.toContain("npm run install:acceptance:dev");
    expect(normalized).not.toContain("npm run validate:acceptance");
  });
});
