import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runbookPath = resolve("docs/runbooks/real-vault-read-only-acceptance.md");
const runbook = existsSync(runbookPath) ? readFileSync(runbookPath, "utf8") : "";
const readme = readFileSync(resolve("README.md"), "utf8");
const design = readFileSync(
  resolve("docs/superpowers/specs/2026-07-14-read-only-acceptance-mode-design.md"),
  "utf8",
);

function markdownSection(source: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const remainder = source.slice(start + marker.length);
  const nextHeading = remainder.search(/\n## /u);
  return nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
}

function bashBlocks(source: string): string[] {
  return [...source.matchAll(/```bash\n([\s\S]*?)```/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function jsonBlocks(source: string): string[] {
  return [...source.matchAll(/```json\n([\s\S]*?)```/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

const evidenceBullets = [
  "- approved commit;",
  "- plugin and Obsidian versions;",
  "- aggregate note count;",
  "- aggregate timings;",
  "- boolean pass or fail checks;",
  "- sanitized error categories that contain no identifiers or content.",
];
const evidenceProhibition = "Evidence must never include paths, file names, note titles, note content, bodies, frontmatter, screenshots, plugin data, journal payloads, endpoints, models, secret identifiers, or secret values.";
const evidenceOnlyMarker = "Evidence may contain only:";

function evidenceContractIsSafe(source: string): boolean {
  const evidence = markdownSection(source, "Evidence allowlist");
  const bullets = evidence.split("\n").filter((line) => line.startsWith("- "));
  const onlyMarkerCount = evidence.split(evidenceOnlyMarker).length - 1;
  return JSON.stringify(bullets) === JSON.stringify(evidenceBullets)
    && onlyMarkerCount === 1
    && evidence.includes(evidenceProhibition)
    && !/\bEvidence\s+(?:may|can)\s+include\b/iu.test(evidence)
    && !/\bEvidence\s+can\s+contain\b/iu.test(evidence)
    && !/\bEvidence\s+may\s+contain(?!\s+only:)/iu.test(evidence);
}

function runbookSafetyViolations(source: string): string[] {
  const violations: string[] = [];
  if (JSON.stringify(bashBlocks(source)) !== JSON.stringify([
    "npm run build:acceptance",
    "npm run install:acceptance:real",
  ])) {
    violations.push("unexpected executable command");
  }
  for (const [label, pattern] of [
    ["absolute location", /\/(?:Users|Volumes|home|private)(?:\/|\b)/u],
    ["Windows location", /[A-Za-z]:\\/u],
    ["URL", /https?:\/\//u],
    ["file URL", /file:\/\//u],
    ["copy command", /\b(?:cp|rsync)\b/u],
    ["launcher command", /\bopen\s+-a\s+Obsidian\b/u],
    ["Finder launch instruction", /\bfrom\s+Finder\b/iu],
    ["development-vault instruction", /(?:OBSIDIAN_DEV_VAULT|\.dev-vault)/u],
    ["path-bearing environment override", /KNOWLEDGE_WORKBENCH_(?:REAL_VAULT|CUSTOM_ARTIFACT_PATH)/u],
    ["piped stdin", /\b(?:echo|printf)\b[^\n]*\|/u],
    ["heredoc", /<<[-~]?\s*[A-Za-z_]/u],
    ["long identifier", /\b[A-Fa-f0-9]{32,}\b/u],
  ] as const) {
    if (pattern.test(source)) violations.push(label);
  }
  return violations;
}

const syntheticConfigDirectory = [".ob", "sidian"].join("");
const expectedReadmeBashBlocks = [
  "npm install\nnpm run build\nnpm test\nnpm run test:coverage\nnpm run test:performance",
  "npm run build:acceptance",
  `mkdir -p .dev-vault/acceptance-vault/${syntheticConfigDirectory}\nprintf '%s\\n' '{"schemaVersion":1,"purpose":"knowledge-workbench-dedicated-test-vault","contentPolicy":"synthetic-notes-only"}' > .dev-vault/acceptance-vault/.knowledge-workbench-test-vault.json\nprintf '%s\\n' '[]' > .dev-vault/acceptance-vault/${syntheticConfigDirectory}/community-plugins.json`,
  "OBSIDIAN_DEV_VAULT=\"$(pwd)/.dev-vault/acceptance-vault\" npm run install:dev",
  "npm run validate:acceptance",
];

function readmeExecutableSafetyViolations(source: string): string[] {
  const violations: string[] = [];
  if (JSON.stringify(bashBlocks(source)) !== JSON.stringify(expectedReadmeBashBlocks)) {
    violations.push("README executable block changed");
  }
  if (/\/(?:Users|Volumes|home|private)(?:\/|\b)/u.test(source)) {
    violations.push("README contains an absolute location");
  }
  return violations;
}

describe("read-only acceptance runbook", () => {
  it("makes preparation a fresh-authorization stop gate with an exact artifact identity", () => {
    expect(runbook).toContain("Preparation is not authorization");
    expect(runbook).toContain(
      "Stop before installation until the user gives fresh, explicit authorization",
    );
    expect(runbook).toContain("zero plugin-initiated vault-content writes");
    expect(runbook).toContain("zero plugin-initiated network requests");
    expect(runbook).toContain("Obsidian configuration and cache files may change");
    expect(runbook).toContain("Derived index data may be written to the plugin data file");
    expect(runbook).toContain("`npm run build:acceptance`");
    for (const artifact of [
      "`main.js`",
      "`manifest.json`",
      "`styles.css`",
      "`acceptance-build.json`",
    ]) expect(runbook).toContain(artifact);
    expect(runbook).toContain("`Knowledge Workbench (Read-only acceptance)`");
    expect(runbook).toContain("`knowledge-workbench@<version>:read-only-acceptance`");
    expect(runbook).toContain("Do not combine files from normal and acceptance builds");
  });

  it("defines allowed, forbidden, stop, cleanup, and troubleshooting behavior", () => {
    for (const heading of [
      "Artifact and version preflight",
      "Human authorization stop: installation",
      "Supported transactional installer",
      "Post-install human authorization stop",
      "Allowed actions after authorization",
      "Forbidden actions",
      "Stop conditions",
      "Rollback and troubleshooting",
      "Cleanup",
      "Evidence allowlist",
    ]) expect(runbook).toContain(`## ${heading}`);

    expect(runbook).toContain("Never hot-overwrite a loaded plugin");
    expect(runbook).toContain("A normal artifact requires a separate replacement authorization");
    expect(runbook).toContain("`rollback incomplete`");
    expect(runbook).toContain("Do not assume cleanup residue is a complete or restorable backup");
    expect(runbook).toContain("Routine cleanup requires fresh, explicit authorization");
    expect(runbook).toContain(
      "Require the later authorization to include this emergency stop action explicitly",
    );
    expect(runbook).toContain(
      "The emergency stop authorization applies only when a stop condition occurs; it authorizes no other cleanup",
    );
    expect(runbook).toContain(
      "Removing the acceptance artifact, restoring another build, inspecting or changing plugin data, and reopening Obsidian are separate actions requiring fresh authorization",
    );
    expect(runbook).toContain("does not start Obsidian");
    expect(runbook).toContain("does not enable the plugin");
    expect(runbook).toContain("does not modify `community-plugins.json`");
    expect(runbook).toContain("does not traverse Markdown files or attachments");
    expect(runbook).toContain("opaque bytes without parsing");
    for (const category of [
      "`rollback-incomplete`",
      "`cleanup-incomplete`",
      "`concurrent-operation`",
      "`host-state-unknown`",
    ]) expect(runbook).toContain(category);
    expect(runbook).not.toContain("`backup-retained`");
  });

  it("documents the exact private stdin contract and both human stop gates", () => {
    const requestBlocks = jsonBlocks(runbook);
    expect(requestBlocks).toHaveLength(1);
    expect(JSON.parse(requestBlocks[0]!)).toEqual({
      action: "INSTALL_READ_ONLY_ACCEPTANCE_IN_THIS_VAULT",
      vaultPath: "<explicit authorized absolute vault path>",
    });
    const successSentence = "Installed the bound read-only acceptance build into the authorized real vault; Obsidian was not started.";
    expect(runbook).toContain(successSentence);
    const build = runbook.indexOf("npm run build:acceptance");
    const installStop = runbook.indexOf("## Human authorization stop: installation");
    const install = runbook.indexOf("npm run install:acceptance:real");
    const success = runbook.indexOf(successSentence);
    const hostStop = runbook.indexOf("## Post-install human authorization stop");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(installStop).toBeGreaterThan(build);
    expect(install).toBeGreaterThan(installStop);
    expect(success).toBeGreaterThan(install);
    expect(hostStop).toBeGreaterThan(success);
  });

  it("limits evidence to the exact aggregate allowlist and excludes private fields", () => {
    const evidence = markdownSection(runbook, "Evidence allowlist");
    expect(evidenceContractIsSafe(runbook)).toBe(true);
    expect(evidence).toContain(evidenceProhibition);
    for (const excluded of [
      "paths",
      "file names",
      "note titles",
      "note content",
      "bodies",
      "frontmatter",
      "screenshots",
      "plugin data",
      "journal payloads",
      "endpoints",
      "models",
      "secret identifiers",
      "secret values",
    ]) expect(evidence).toContain(excluded);
  });

  it("contains only the two fixed acceptance commands and no location or launch instructions", () => {
    expect(runbookSafetyViolations(runbook)).toEqual([]);
  });

  it("keeps every executable README install and open step synthetic-vault-only", () => {
    expect(readme).toContain("## 构建身份与授权边界");
    expect(readme).toContain("`Knowledge Workbench`");
    expect(readme).toContain("`knowledge-workbench@<version>:normal`");
    expect(readme).toContain("`Knowledge Workbench (Read-only acceptance)`");
    expect(readme).toContain("`knowledge-workbench@<version>:read-only-acceptance`");
    expect(readme).toContain("只读验收构建只准备产物，不安装、不启动 Obsidian，也不访问任何 vault");
    expect(readme).toContain("准备产物不构成真实库访问授权");
    expect(readme).toContain("`install:dev` 始终安装 normal 根目录三件套");
    expect(readme).toContain("只接受当前 worktree 内 `.dev-vault` 下的专用合成库");
    expect(readme).toContain("不要手工复制 acceptance 文件到任何 vault");
    expect(readme).toContain("不要使用裸 `open -a Obsidian`");
    expect(readme).toContain(
      "[真实库只读事务安装与人工验收停止门](docs/runbooks/real-vault-read-only-acceptance.md)",
    );
    expect(readme).toContain("`install:acceptance:real`");
    expect(readme).toContain("自动化不会选择、安装或打开真实库");
    expect(readme).toContain("实现和测试不代表真实库验收已经完成");
    expect(readmeExecutableSafetyViolations(readme)).toEqual([]);
  });

  it("rejects poisoned documentation that adds unsafe actions or permissive evidence", () => {
    const poisonedReadme = `${readme}\n\`\`\`bash\ncp dist/read-only-acceptance/main.js /Users/private-vault/main.js\nopen -a Obsidian\n\`\`\`\n`;
    const permissiveEvidence = runbook.replace(
      evidenceProhibition,
      "Evidence may include paths, file names, note titles, or note content.",
    );
    const missingOnly = runbook.replace(evidenceOnlyMarker, "Evidence may contain:");
    const extraPermission = `${runbook}\nEvidence may include endpoints, models, secret identifiers, or secret values.\n`;
    const finderInstruction = `${runbook}\nInstall the acceptance build into the real vault and launch it from Finder.\n`;

    expect(readmeExecutableSafetyViolations(poisonedReadme)).not.toEqual([]);
    expect(evidenceContractIsSafe(permissiveEvidence)).toBe(false);
    expect(evidenceContractIsSafe(missingOnly)).toBe(false);
    expect(evidenceContractIsSafe(extraPermission)).toBe(false);
    expect(runbookSafetyViolations(finderInstruction)).not.toEqual([]);
  });

  it("records approved implementation without claiming a real-vault pass", () => {
    expect(design).toContain("Status: approved; implementation covered by the linked plan");
    expect(design).toContain(
      "Implementation plan: [2026-07-14 read-only acceptance mode](../plans/2026-07-14-read-only-acceptance-mode.md)",
    );
    expect(design).not.toMatch(/real-vault acceptance (?:passed|complete)/iu);
  });
});
