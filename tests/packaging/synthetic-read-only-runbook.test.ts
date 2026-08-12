import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const runbookPath = resolve("docs/runbooks/synthetic-read-only-acceptance.md");
const runbookExists = existsSync(runbookPath);
const runbook = runbookExists ? readFileSync(runbookPath, "utf8") : "";
const readme = readFileSync(resolve("README.md"), "utf8");
const design = readFileSync(
  resolve("docs/superpowers/specs/2026-07-14-synthetic-read-only-acceptance-install-design.md"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const vitestConfig = readFileSync(resolve("vitest.config.ts"), "utf8");

const heavyTestPaths = [
  "tests/packaging/synthetic-acceptance-fixture.test.ts",
  "tests/packaging/prepare-acceptance-synthetic.test.ts",
  "tests/packaging/install-acceptance-dev.test.ts",
  "tests/packaging/acceptance-artifact-lease.test.ts",
  "tests/packaging/acceptance-workflow-cli.test.ts",
  "tests/packaging/read-only-acceptance-report.test.ts",
  "tests/packaging/read-only-acceptance-recorder.test.ts",
] as const;

const heavyTests = new Map(heavyTestPaths.map((path) => [
  path,
  readFileSync(resolve(path), "utf8"),
]));

const expectedCommands = [
  "npm run prepare:acceptance:synthetic",
  "npm run install:acceptance:dev",
  "npm run record:read-only-acceptance",
  "npm run validate:read-only-acceptance",
] as const;

const stopMarker = "STOP before host control";
const expectedRunbookSha256 = "d73918aa8b0456f1e5de896f0aa090d54abdba0dc2d02225def3c7960c60a3d5";

const hostChecklistPhrases = [
  "Knowledge Workbench (Read-only acceptance)",
  "persistent non-color-only read-only banner",
  "startup normalization completes before any host surface appears",
  "Quick Capture is blocked",
  "plan confirmation and execution are blocked",
  "sample unlock is blocked",
  "write toggle is blocked",
  "Undo is blocked",
  "Seeded History remains aggregate-only",
  "History clear, export, and path-bearing controls are blocked",
  "endpoint, model, and secret inputs and AI actions are absent",
  "non-confirming preview remains usable",
  "scan, Today, search, map, folder-rule review, and suggestion preview remain usable",
  "derived index restores after restart",
  "Recovery required is absent",
  "aggregate corpus remains unchanged",
  "static acceptance-bundle scan is primary network evidence",
  "host observation is supplementary",
  "unattributable traffic is inconclusive",
] as const;

const hostObservationKeys = [
  "recordedAt",
  "obsidianVersion",
  "scanElapsedMs",
  "restartRestoreElapsedMs",
  "hostIsolation",
  "banner",
  "startupNormalization",
  "quickCaptureBlocked",
  "organizationWritesBlocked",
  "undoBlocked",
  "historySensitiveActionsBlocked",
  "aiBlocked",
  "readSurfaces",
  "restartRestore",
  "networkBoundary",
  "recoveryAbsent",
  "finalHostStopped",
] as const;

const expectedHostObservation = {
  recordedAt: "2026-07-14T12:00:00.000Z",
  obsidianVersion: "1.12.7",
  scanElapsedMs: 0,
  restartRestoreElapsedMs: 0,
  hostIsolation: "inconclusive",
  banner: "inconclusive",
  startupNormalization: "inconclusive",
  quickCaptureBlocked: "inconclusive",
  organizationWritesBlocked: "inconclusive",
  undoBlocked: "inconclusive",
  historySensitiveActionsBlocked: "inconclusive",
  aiBlocked: "inconclusive",
  readSurfaces: "inconclusive",
  restartRestore: "inconclusive",
  networkBoundary: "inconclusive",
  recoveryAbsent: "inconclusive",
  finalHostStopped: "inconclusive",
} as const;

interface Fence {
  readonly marker: string;
  readonly language: string;
  readonly body: string;
  readonly index: number;
  readonly contentStart: number;
  readonly contentEnd: number;
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function fences(source: string): Fence[] {
  const result: Fence[] = [];
  let active: Readonly<{ marker: string; language: string; index: number; contentStart: number }> | null = null;
  let offset = 0;
  for (const rawLine of source.split(/(?<=\n)/u)) {
    const line = rawLine.replace(/\r?\n$/u, "");
    if (active === null) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (opening !== null && !(opening[1]?.startsWith("`") === true && opening[2]?.includes("`"))) {
        active = {
          marker: opening[1] ?? "",
          language: (opening[2] ?? "").trim(),
          index: offset,
          contentStart: offset + rawLine.length,
        };
      }
    } else {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
      const closingMarker = closing?.[1];
      if (closingMarker !== undefined
        && closingMarker[0] === active.marker[0]
        && closingMarker.length >= active.marker.length) {
        result.push({
          ...active,
          body: source.slice(active.contentStart, offset).trim(),
          contentEnd: offset,
        });
        active = null;
      }
    }
    offset += rawLine.length;
  }
  if (active !== null) {
    result.push({
      ...active,
      language: `${active.language}\0unclosed`,
      body: source.slice(active.contentStart).trim(),
      contentEnd: source.length,
    });
  }
  return result;
}

function markdownSection(source: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const remainder = source.slice(start + marker.length);
  const nextHeading = remainder.search(/\n## /u);
  return nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
}

function appearsInOrder(source: string, phrases: readonly string[]): boolean {
  let cursor = 0;
  for (const phrase of phrases) {
    const index = source.indexOf(phrase, cursor);
    if (index < 0) return false;
    cursor = index + phrase.length;
  }
  return true;
}

function runbookSafetyViolations(source: string): string[] {
  const violations: string[] = [];
  const allFences = fences(source);
  const stop = source.indexOf(stopMarker);
  const npmRuns = [...source.matchAll(/\bnpm[ \t]+run[ \t]+[A-Za-z0-9:_-]+/gu)].map((match) => ({
    command: match[0].replace(/[ \t]+/gu, " "),
    index: match.index,
  }));

  if (JSON.stringify(npmRuns.map(({ command }) => command)) !== JSON.stringify(expectedCommands)) {
    violations.push("unexpected executable command");
  }
  const expectedFenceSignatures = ["```bash", "```bash", "```json", "```bash", "```bash"];
  if (JSON.stringify(allFences.map((block) => `${block.marker}${block.language}`))
    !== JSON.stringify(expectedFenceSignatures)) {
    violations.push("unexpected fenced block");
  }
  for (const occurrence of npmRuns) {
    const lineStart = source.lastIndexOf("\n", occurrence.index) + 1;
    const nextLine = source.indexOf("\n", occurrence.index);
    const lineEnd = nextLine < 0 ? source.length : nextLine;
    const container = allFences.find((block) => (
      occurrence.index >= block.contentStart && occurrence.index < block.contentEnd
    ));
    if (container?.marker !== "```"
      || container.language !== "bash"
      || source.slice(lineStart, lineEnd).trim() !== occurrence.command) {
      violations.push("package command is outside an exact bash command line");
      break;
    }
  }
  if (stop < 0
    || npmRuns.slice(0, 2).some(({ index }) => index > stop)
    || npmRuns.slice(2).some(({ index }) => index < stop)) {
    violations.push("automation and host commands are not split at the stop gate");
  }

  for (const [label, pattern] of [
    ["copy command", /\b(?:cp|rsync)\b/u],
    ["bare application launch", /\b(?:open\s+-(?:a|b)|osascript)\b/iu],
    ["Finder launch instruction", /(?:\bFinder\b[^\n.]{0,60}\b(?:double[- ]click|launch|open|start)\b|\b(?:double[- ]click|launch|open|start)\b[^\n.]{0,60}\bFinder\b)/iu],
    ["URL", /\b[a-z][a-z0-9+.-]*:\/\//iu],
    ["absolute POSIX path", /(?:^|[\s("'=])\/(?!\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*/mu],
    ["absolute Windows path", /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/u],
    ["environment override", /\b[A-Z][A-Z0-9_]*(?:PATH|ROOT|VAULT|MODE|ARTIFACT|FIXTURE|OUTPUT|RECEIPT|SEED)[A-Z0-9_]*\s*=/u],
    ["unapproved shell command", /(?:^|\n)[ \t]*(?:(?:[-*+]|\d+\.)[ \t]+)?(?:chmod|curl|git|ln|mkdir|mv|node|npx|printf|rm|touch|wget)\b|(?:`|\b(?:execute|run)\s+`?)(?:chmod|curl|git|ln|mkdir|mv|node|npx|printf|rm|touch|wget)\b/imu],
    ["example credential", /(?:\bapi[_ -]?key\s*[:=]|\b(?:sk-|ghp_|AIza|AKIA)[A-Za-z0-9_-]{8,}|\bBearer\s+\S+)/u],
    ["endpoint model or secret value", /\b(?:endpoint|model|secret|credential|token)\b\s+(?:choice\s+)?(?:value\s*)?(?::|=|\bis\b)\s*[A-Za-z0-9_-]{3,}/iu],
  ] as const) {
    if (pattern.test(source)) violations.push(label);
  }

  for (const sentence of source.split(/[.!?\n]/u)) {
    const operation = /\b(?:authorize|browse|choose|delete|enable|enter|identify|inspect|modify|navigate|open|operate|read|scan|select|switch|sync|use|write)\b/iu.exec(sentence);
    if (operation !== null
      && /\breal[- ]vault\b/iu.test(sentence)
      && !/\b(?:do|does|must|may|can|should|will)\s+not\b|\b(?:never|no|forbidden|prohibited)\b/iu.test(sentence.slice(0, operation.index))) {
      violations.push("real-vault operating instruction");
      break;
    }
  }
  for (const [label, pattern] of [
    ["automatic enablement", /(?:\bauto(?:matically)?[- ]enable\b|\b(?:script|automation|programmatically|without manual[^\n.]*)\b[^\n.]{0,60}\benable\b)/iu],
    ["community plugin mutation", /(?:\b(?:add|append|change|edit|modify|patch|remove|replace|truncate|update|write)\b[^\n.]{0,80}\bcommunity-plugins\.json\b|\bcommunity-plugins\.json\b[^\n.]{0,80}\b(?:add|append|change|edit|modify|patch|remove|replace|truncate|update|write)\b)/iu],
    ["endpoint model or secret input", /\b(?:choose|configure|enter|input|paste|populate|provide|set|supply|type|use)\b[^\n.]{0,50}\b(?:credential|endpoint|model|secret|token)\b/iu],
    ["forbidden observation field instruction", /\b(?:add|append|include|provide|supply|write)\b[^\n.]{0,50}\b(?:derived field|path field|free text|run ID|commit|digest|binding|category|local-evidence|explanation)\b/iu],
  ] as const) {
    for (const sentence of source.split(/\n/u)) {
      const match = pattern.exec(sentence);
      if (match !== null
        && !/\b(?:do|does|must|may|can|should|will)\s+not\b|\b(?:never|no|forbidden|prohibited)\b/iu.test(sentence.slice(0, match.index))) {
        violations.push(label);
        break;
      }
    }
  }
  return violations;
}

function callName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = callName(expression.expression);
    return owner === null ? null : `${owner}.${expression.name.text}`;
  }
  if (ts.isCallExpression(expression)) return callName(expression.expression);
  return null;
}

function scopedTimeoutProblems(path: string, source: string): string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const protectedCalls = new Set(["it", "test", "beforeAll", "beforeEach", "afterAll", "afterEach"]);
  const definitions = new Map<string, ts.FunctionLikeDeclaration>();
  const importedFunctions = new Set<string>();
  const timeoutBindings: ts.Declaration[] = [];

  const recordDeclarations = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (moduleName === "vitest" && bindings !== undefined && ts.isNamespaceImport(bindings)) {
        problems.push(`${path}: Vitest namespace imports can hide registration calls`);
      }
      if (moduleName !== "vitest") {
        const defaultImport = node.importClause?.name;
        if (defaultImport !== undefined) importedFunctions.add(defaultImport.text);
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          importedFunctions.add(bindings.name.text);
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) importedFunctions.add(element.name.text);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) definitions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer !== undefined
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        definitions.set(node.name.text, node.initializer);
      }
      if (node.name.text === "HEAVY_TIMEOUT_MS") timeoutBindings.push(node);
      const initializerName = node.initializer !== undefined
        && (ts.isIdentifier(node.initializer)
          || ts.isPropertyAccessExpression(node.initializer)
          || ts.isCallExpression(node.initializer))
        ? callName(node.initializer)
        : null;
      if (initializerName !== null
        && protectedCalls.has(initializerName.split(".")[0] ?? "")) {
        problems.push(`${path}: aliased Vitest registration ${node.name.text}`);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "HEAVY_TIMEOUT_MS") {
      timeoutBindings.push(node);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === "HEAVY_TIMEOUT_MS") {
      timeoutBindings.push(node);
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
      && (ts.isIdentifier(node.right)
        || ts.isPropertyAccessExpression(node.right)
        || ts.isCallExpression(node.right))) {
      const assignmentName = callName(node.right);
      if (assignmentName !== null
        && protectedCalls.has(assignmentName.split(".")[0] ?? "")) {
        problems.push(`${path}: assigned Vitest registration alias ${node.left.text}`);
      }
    }
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      if (protectedCalls.has(imported) && node.name.text !== imported) {
        problems.push(`${path}: aliased Vitest import ${imported} as ${node.name.text}`);
      }
    }
    ts.forEachChild(node, recordDeclarations);
  };
  recordDeclarations(parsed);

  const canonicalTimeouts = timeoutBindings.filter((binding): binding is ts.VariableDeclaration => {
    if (!ts.isVariableDeclaration(binding)
      || !ts.isVariableDeclarationList(binding.parent)
      || !ts.isVariableStatement(binding.parent.parent)
      || !ts.isSourceFile(binding.parent.parent.parent)
      || (binding.parent.flags & ts.NodeFlags.Const) === 0
      || binding.initializer === undefined
      || !ts.isNumericLiteral(binding.initializer)) return false;
    return Number(binding.initializer.getText(parsed).replaceAll("_", "")) === 600_000;
  });
  if (timeoutBindings.length > 0 && (timeoutBindings.length !== 1 || canonicalTimeouts.length !== 1)) {
    problems.push(`${path}: HEAVY_TIMEOUT_MS must be one unshadowed top-level const equal to 600000`);
  }

  const isScopedTimeout = (node: ts.Expression | undefined): boolean => {
    if (node === undefined) return false;
    if (ts.isNumericLiteral(node)) return Number(node.getText(parsed).replaceAll("_", "")) === 600_000;
    return ts.isIdentifier(node) && node.text === "HEAVY_TIMEOUT_MS" && canonicalTimeouts.length === 1 && timeoutBindings.length === 1;
  };

  const expressionReturnsPromise = (node: ts.Expression, seen = new Set<string>()): boolean => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise") return true;
    if (!ts.isCallExpression(node)) return false;
    const name = callName(node.expression);
    if (name?.startsWith("Promise.") === true) return true;
    if (name !== null && importedFunctions.has(name.split(".")[0] ?? "")) return true;
    if (name !== null && definitions.has(name) && !seen.has(name)) {
      seen.add(name);
      return functionReturnsPromise(definitions.get(name), seen);
    }
    return false;
  };

  const functionReturnsPromise = (
    node: ts.FunctionLikeDeclaration | undefined,
    seen = new Set<string>(),
  ): boolean => {
    if (node === undefined) return false;
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true) return true;
    if (node.type?.getText(parsed).replaceAll(" ", "").startsWith("Promise<") === true) return true;
    if (node.body === undefined) return false;
    if (!ts.isBlock(node.body)) return expressionReturnsPromise(node.body, seen);
    let returnsPromise = false;
    const inspectReturns = (child: ts.Node): void => {
      if (ts.isReturnStatement(child) && child.expression !== undefined && expressionReturnsPromise(child.expression, seen)) {
        returnsPromise = true;
      }
      if (!returnsPromise) ts.forEachChild(child, inspectReturns);
    };
    inspectReturns(node.body);
    return returnsPromise;
  };

  const asyncLikeCallback = (node: ts.Expression | undefined): boolean => {
    if (node === undefined) return false;
    if (ts.isIdentifier(node)) return true;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return functionReturnsPromise(node);
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      const parts = name?.split(".") ?? [];
      const isTest = (parts[0] === "it" || parts[0] === "test")
        && parts.slice(1).every((part) => part === "each" || part === "concurrent");
      if (isTest
        && (asyncLikeCallback(node.arguments[1]) || parts.includes("concurrent"))
        && !isScopedTimeout(node.arguments[2])) {
        problems.push(`${path}:${line}: async test lacks a scoped 600000ms timeout`);
      }
      if ((name === "beforeAll" || name === "beforeEach" || name === "afterAll" || name === "afterEach")
        && asyncLikeCallback(node.arguments[0])
        && !isScopedTimeout(node.arguments[1])) {
        problems.push(`${path}:${line}: async setup or cleanup lacks a scoped 600000ms timeout`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return problems;
}

function globalTimeoutProblems(source: string): string[] {
  const parsed = ts.createSourceFile("vitest.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node))
      && (node.text === "testTimeout" || node.text === "hookTimeout")) {
      problems.push(`global timeout key ${node.text}`);
    }
    if (ts.isComputedPropertyName(node)) problems.push("computed property can hide a global timeout");
    if (ts.isSpreadAssignment(node)) problems.push("object spread can hide a global timeout");
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return problems;
}

const expectedReadmeFences = [
  ["```", "bash", "553f2aac8022fb44ceb0cb8331dd9bad5a12f957bfd7ce690bd2d73da4fdd4c6"],
  ["```", "bash", "0a231b71ee445084ce520effcf8f08415ba992f41e6923dda460228494f30208"],
  ["```", "bash", "abf7fd4b720849b9fa9a076c1fc9805237d00f959872be8d206d5a7694917739"],
  ["```", "bash", "fff36812280e12d0f3a2c4a02a8f9e240d069996bb9e9d0a62bb7277f987dce8"],
  ["```", "bash", "5eeb23707c6afaa385534cb2518ddf70a3c6d2935f217de934b7d76341a0aebb"],
  ["```", "json", "ec54d1e5d4682178b1060d2704db90de8dd589fea8b5f1e8a8815002ec9cdebd"],
] as const;

describe("synthetic read-only acceptance runbook", () => {
  it("exists before its contract is evaluated", () => {
    expect(runbookExists, `${runbookPath} must exist before its contract can be evaluated`).toBe(true);
  });

  it("locks the reviewed canonical runbook bytes", () => {
    if (!runbookExists) return;
    expect(sha256(runbook)).toBe(expectedRunbookSha256);
  });

  it("contains only the four package commands on the correct sides of the host stop gate", () => {
    if (!runbookExists) return;
    expect(runbookSafetyViolations(runbook)).toEqual([]);
  });

  it("locks the automation boundary and fixed-vault preflight", () => {
    if (!runbookExists) return;
    expect(runbook).toContain(".dev-vault/read-only-acceptance-vault");
    expect(runbook).toMatch(/fixed ignored synthetic vault/iu);
    expect(runbook).toMatch(/plugin remains disabled/iu);
    expect(runbook).toMatch(/never launches Obsidian/iu);
    expect(runbook).toMatch(/never uses (?:the )?network or credentials/iu);
    expect(runbook).toMatch(/report remains absent[^\n.]*pending/iu);
    expect(runbook).toMatch(/clean committed HEAD/iu);
    expect(runbook).toMatch(/after preparation and before installation[^\n.]*exact preparation state[^\n.]*empty community-plugin list[^\n.]*absent report[^\n.]*pending/iu);
    expect(runbook).toMatch(/after installation[^\n.]*exact preparation state, installation receipt, and run anchor/iu);
    expect(runbook).toMatch(/empty community-plugin list/iu);
    expect(runbook).toMatch(/Sync[^\n.]*external mutator[^\n.]*inactive/iu);
    expect(runbook).toMatch(/\.dev-vault\/acceptance\.json[^\n.]*unchanged/iu);
    expect(runbook).toContain("No path, mode, or artifact environment override is allowed.");
  });

  it("locks host isolation, the ordered checklist, and terminal stop behavior", () => {
    if (!runbookExists) return;
    expect(runbook).toContain("No real vault may be selected or opened.");
    expect(runbook).toContain("No real-vault window may be active.");
    expect(runbook).toMatch(/fully quit Obsidian[^\n.]*before/iu);
    expect(runbook).toMatch(/vault-switcher-only human entry/iu);
    expect(runbook).toMatch(/installed Obsidian UI[^\n.]*does not restore or open a vault first/iu);
    expect(runbook).toMatch(/cannot be reached[^\n.]*do not launch or enable/iu);
    expect(runbook).toMatch(/non-target vault[^\n.]*do not enable[^\n.]*fully quit/iu);
    expect(runbook).toMatch(/canonical fixed path[^\n.]*before enablement[^\n.]*after restart/iu);
    expect(runbook).toMatch(/name-only[^\n.]*duplicate[^\n.]*hidden[^\n.]*ambiguous[^\n.]*hostIsolation[^\n.]*inconclusive/iu);
    expect(runbook).toMatch(/manually enable[^\n.]*confirmed vault/iu);

    const checklist = markdownSection(runbook, "Host rehearsal checklist");
    expect(appearsInOrder(checklist, hostChecklistPhrases)).toBe(true);
    expect(checklist).toMatch(/Seeded History remains aggregate-only[^\n.]*History clear, export, and path-bearing controls are blocked/iu);

    expect(runbook).toMatch(/success and failure[^\n.]*disable the plugin[^\n.]*fully quit Obsidian[^\n.]*record/iu);
    expect(runbook).toMatch(/full stop cannot be confirmed[^\n.]*finalHostStopped[^\n.]*inconclusive/iu);
    expect(runbook).toMatch(/content drift[^\n.]*exposed capability[^\n.]*binding[^\n.]*normalization[^\n.]*unexplained traffic[^\n.]*recovery/iu);
    expect(runbook).toMatch(/do not repair, switch builds, inspect private data, retry, or clean retained objects/iu);
    expect(runbook).toMatch(/cooperative locks[^\n.]*limitation/iu);
    expect(runbook).toMatch(/cannot prove[^\n.]*Obsidian process[^\n.]*attribute[^\n.]*host network traffic/iu);
  });

  it("provides exactly the safe all-unperformed 17-key HostObservation JSON", () => {
    if (!runbookExists) return;
    const json = fences(runbook).filter((block) => block.language === "json");
    expect(json).toHaveLength(1);
    const observation = JSON.parse(json[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(observation)).toEqual(hostObservationKeys);
    expect(observation).toEqual(expectedHostObservation);
    expect(runbook).toMatch(/reads exactly one JSON object from standard input[\s\S]{0,180}send EOF once[^\n.]*do not send any other text/iu);
  });

  it("rejects poisoned launch, private-input, real-vault, and community-plugin instructions", () => {
    if (!runbookExists) return;
    for (const poison of [
      "cp artifact /Users/private-vault/main.js",
      "Open the plugin from Finder.",
      "Configure endpoint https://acceptance.invalid/v1.",
      "Set secret value: sk-examplecredential.",
      "Select and open a real vault.",
      "Automatically enable the plugin.",
      "Edit community-plugins.json to enable the plugin.",
      "OBSIDIAN_DEV_VAULT=/tmp/other-vault",
    ]) expect(runbookSafetyViolations(`${runbook}\n${poison}\n`)).not.toEqual([]);
  });

  it("rejects alternate Markdown command containers and every reviewed safety poison", () => {
    if (!runbookExists) return;
    for (const poison of [
      "Run `npm run install:dev` now.",
      "~~~sh\nnpm run install:dev\n~~~",
      "````bash\nnpm run install:dev\n````",
      "~~~sh\nrm -rf .dev-vault",
      "~~~sh\nharmless prose without a closing fence",
      "```sh\nnpm run install:dev\n```",
      "```\nnpm run install:dev\n```",
      "    npm run install:dev",
      "Run `rm -rf .dev-vault` now.",
      "printf '[]' > community-plugins.json",
      "- printf '[]' > community-plugins.json",
      "Let a script enable the plugin.",
      "In community-plugins.json, add the plugin identifier.",
      "Open Obsidian through obsidian://open?vault=Personal.",
      "Open /tmp/other-vault.",
      "Use Finder to double-click Obsidian.",
      "Scan the real vault after launch.",
      "Model choice is gpt-5; paste token ghp_abcdefghijk.",
      "Add a path field to the observation before recording.",
    ]) expect(runbookSafetyViolations(`${runbook}\n${poison}\n`), poison).not.toEqual([]);
  });

  it("allows safety denials that do not authorize a real vault", () => {
    if (!runbookExists) return;
    for (const warning of [
      "Never open a real vault.",
      "Do not select a real vault.",
      "No real vault may be scanned or inspected.",
    ]) {
      expect(runbookSafetyViolations(`${runbook}\n${warning}\n`), warning)
        .not.toContain("real-vault operating instruction");
    }
  });
});

describe("synthetic acceptance documentation links", () => {
  it("adds a prose runbook link without changing README executable blocks or the real-vault stop gate", () => {
    expect(readme).toMatch(/\[[^\]]+\]\(docs\/runbooks\/synthetic-read-only-acceptance\.md\)/u);
    expect(fences(readme).map((block) => [block.marker, block.language, sha256(block.body)]))
      .toEqual(expectedReadmeFences);
    expect(readme).toContain("| normal | 事务构建的 `main.js`、`manifest.json`、`styles.css` | `Knowledge Workbench` | `knowledge-workbench@<version>:normal` | 合成库使用 `install:dev`；真实库仅在明确授权后使用 `install:normal:real` |");
    expect(readme).toContain("| read-only acceptance | 隔离目录中的 `main.js`、`manifest.json`、`styles.css`、`acceptance-build.json` | `Knowledge Workbench (Read-only acceptance)` | `knowledge-workbench@<version>:read-only-acceptance` | 合成库按固定手册使用 `install:acceptance:dev`；真实库仅在双人工停止门之间使用 `install:acceptance:real` |");
    expect(readme).toContain("[真实库只读事务安装与人工验收停止门](docs/runbooks/real-vault-read-only-acceptance.md)定义唯一受支持的真实库安装入口以及安装前后的人工停止边界。阅读文档、构建产物或实现通过自动化测试都不是安装、打开、启用、扫描或完成真实库验收的授权；实现和测试不代表真实库验收已经完成。");
    expect(readme).toContain("[专用合成库只读验收运行手册](docs/runbooks/synthetic-read-only-acceptance.md)定义固定 prepare/install、自动化停在主机控制之前、人工主机演练和一次性终态证据；它不授权任何真实库操作，也不会改变上面的真实库新授权停止门。");
    expect(readme).toContain("准备产物不构成真实库访问授权");
  });

  it("records the approved linked implementation plan without claiming host acceptance", () => {
    expect(design).toContain("Status: approved; implementation plan linked");
    expect(design).toContain(
      "Implementation plan: [Synthetic read-only acceptance installation and host rehearsal](../plans/2026-07-14-synthetic-read-only-acceptance-install.md)",
    );
    expect(design).not.toMatch(/(?:host rehearsal|product acceptance) (?:passed|complete)/iu);
  });
});

describe("plain-test and heavy-timeout contract", () => {
  it("keeps plain npm test complete and rejects global timeout inflation", () => {
    expect(packageJson.scripts?.test).toBe("vitest run");
    expect(packageJson.scripts?.test).not.toMatch(/--(?:hook|test)Timeout\b/u);
    expect(globalTimeoutProblems(vitestConfig)).toEqual([]);
  });

  it("requires scoped 600000ms timeouts on every async heavy test, setup, and cleanup", () => {
    const problems = [...heavyTests].flatMap(([path, source]) => scopedTimeoutProblems(path, source));
    expect(problems).toEqual([]);
  });

  it("detects Promise returns, callback identifiers, concurrent tests, aliases, and timeout shadowing", () => {
    for (const source of [
      'it("promise", () => Promise.resolve());',
      'const heavyCase = async () => undefined; it("identifier", heavyCase);',
      'it.concurrent("concurrent", async () => undefined);',
      'import { it as spec } from "vitest"; spec("alias", async () => undefined, 600_000);',
      'import * as v from "vitest"; v.it.concurrent("namespace", async () => undefined);',
      'const spec = test; spec("test alias", async () => undefined, 600_000);',
      'const spec = it.concurrent; spec("concurrent alias", async () => undefined, 600_000);',
      'let spec: typeof it; spec = it.concurrent; spec("assigned alias", async () => undefined, 600_000);',
      'import { afterEach as cleanup } from "vitest"; cleanup(async () => undefined, 600_000);',
      'const HEAVY_TIMEOUT_MS = 600_000; describe("shadow", () => { const HEAVY_TIMEOUT_MS = 5; it("case", async () => undefined, HEAVY_TIMEOUT_MS); });',
      'const HEAVY_TIMEOUT_MS = 600_000; describe("destructured", () => { const { HEAVY_TIMEOUT_MS } = { HEAVY_TIMEOUT_MS: 5 }; it("destructured shadow", async () => undefined, HEAVY_TIMEOUT_MS); });',
      'import { heavy } from "./helper"; it("imported Promise helper", () => heavy());',
    ]) expect(scopedTimeoutProblems("synthetic-heavy.test.ts", source), source).not.toEqual([]);
  });

  it("recognizes global timeout shorthand, computed keys, and object-spread indirection", () => {
    for (const source of [
      "const testTimeout = 600_000; export default defineConfig({ test: { testTimeout } });",
      'const key = "testTimeout"; export default defineConfig({ test: { [key]: 600_000 } });',
      'const key = "test" + "Timeout"; export default defineConfig({ test: { [key]: 600_000 } });',
      'import { acceptanceTimeouts } from "./timeouts"; export default defineConfig({ test: { ...acceptanceTimeouts } });',
    ]) expect(globalTimeoutProblems(source), source).not.toEqual([]);
  });
});
