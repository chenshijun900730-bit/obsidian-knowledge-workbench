# Hard Read-Only Acceptance Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separately bound Obsidian artifact that can index and preview a vault while making Markdown writes, Quick Capture, Undo, history disclosure/mutation, AI, and plugin-initiated network access unreachable.

**Architecture:** A frozen compile-time policy is injected at the composition root, controller, and UI factories. The acceptance entry point has a separate dependency graph, rejecting write/capture ports, strict artifact binding, and a startup setting-normalization gate that completes before host registration. A same-filesystem staged builder publishes an exact four-file artifact atomically; the normal build and synthetic-only installer remain separate.

**Tech Stack:** TypeScript 5.8, Obsidian API 1.13, esbuild 0.25, Vitest 4, Node.js ESM build scripts, ESLint, Graphify.

---

## File map

New production files:

- `src/runtime/safety-policy.ts` — frozen normal and acceptance capabilities plus effective settings.
- `src/runtime/read-only-ports.ts` — rejecting `VaultWritePort` and `QuickCapturePort` implementations.
- `src/runtime/artifact-binding.ts` — strict metadata decoder and pre-registration host artifact verifier.
- `src/runtime/runtime-composition.ts` — narrow factories shared by the plugin shell without importing normal-only capabilities.
- `src/plugin/knowledge-workbench-plugin.ts` — shared plugin lifecycle and composition shell extracted from `src/main.ts`.
- `src/main-acceptance.ts` — acceptance-only entry point with no Quick Capture, AI client, secret, or request imports.
- `src/build-mode.d.ts` — types for esbuild-injected artifact constants.
- `src/ai/ai-config.ts` — pure AI configuration normalization, separated from the network client.
- `scripts/acceptance-build.mjs` — exact schema, staging validation, dependency scan, and rollback-safe publish logic.
- `scripts/build-acceptance.mjs` — small CLI wrapper for the acceptance builder.

New tests and documentation:

- `tests/unit/runtime/safety-policy.test.ts`
- `tests/unit/runtime/artifact-binding.test.ts`
- `tests/integration/read-only-acceptance.test.ts`
- `tests/packaging/read-only-acceptance-build.test.ts`
- `tests/packaging/read-only-runbook.test.ts`
- `docs/runbooks/real-vault-read-only-acceptance.md`

Existing files changed:

- `src/adapters/obsidian-ai-client.ts`, `src/storage/plugin-data-store.ts`, `src/ui/workbench-controller.ts`
- `src/ui/workbench-view.ts`, `src/ui/today-pane.ts`, `src/ui/history-tab.ts`, `src/ui/settings-tab.ts`, `src/ui/change-preview-modal.ts`
- `src/main.ts`, `esbuild.config.mjs`, `package.json`, `eslint.config.mts`, `scripts/install-dev.mjs`, `styles.css`
- focused unit, integration, UI, packaging, helper, and benchmark compile fixtures named in the tasks below.

### Task 1: Pure runtime policy, pure AI configuration, and rejecting ports

**Files:**

- Create: `src/runtime/safety-policy.ts`
- Create: `src/runtime/read-only-ports.ts`
- Create: `src/ai/ai-config.ts`
- Modify: `src/adapters/obsidian-ai-client.ts`
- Modify: `src/storage/plugin-data-store.ts`
- Modify: `src/ui/workbench-controller.ts`
- Create: `tests/unit/runtime/safety-policy.test.ts`
- Modify: `tests/unit/adapters/obsidian-ai-client.test.ts`
- Modify: `tests/unit/storage/plugin-data-store.test.ts`

- [ ] **Step 1: Write the policy and rejecting-port tests**

Add tests that assert exact capability values, frozen objects, fail-closed effective settings, normal factory execution, acceptance factory non-execution, and both rejecting ports:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
  effectiveSettings,
  normalOnly,
  policyFor,
} from "../../../src/runtime/safety-policy";
import {
  READ_ONLY_QUICK_CAPTURE_PORT,
  READ_ONLY_VAULT_WRITE_PORT,
} from "../../../src/runtime/read-only-ports";

describe("runtime safety policy", () => {
  it("exposes exact immutable normal and acceptance capabilities", () => {
    expect(NORMAL_RUNTIME_POLICY).toEqual({
      mode: "normal",
      contentWrites: "allowed",
      quickCapture: "allowed",
      planConfirmation: "allowed",
      history: "full",
      configuration: "mutable",
      ai: "available",
      network: "allowed",
    });
    expect(READ_ONLY_ACCEPTANCE_POLICY).toEqual({
      mode: "read-only-acceptance",
      contentWrites: "blocked",
      quickCapture: "blocked",
      planConfirmation: "blocked",
      history: "aggregate-only",
      configuration: "read-only",
      ai: "blocked",
      network: "blocked",
    });
    expect(Object.isFrozen(NORMAL_RUNTIME_POLICY)).toBe(true);
    expect(Object.isFrozen(READ_ONLY_ACCEPTANCE_POLICY)).toBe(true);
    expect(policyFor("normal")).toBe(NORMAL_RUNTIME_POLICY);
    expect(policyFor("read-only-acceptance")).toBe(READ_ONLY_ACCEPTANCE_POLICY);
    expect(() => policyFor("unexpected" as never)).toThrow("Unsupported runtime mode");
  });

  it("forces persisted write and AI capability off only in acceptance mode", () => {
    const settings = {
      writeEnabled: true,
      writePreviewAcknowledged: true,
      openAtStartup: true,
      folderRules: [{ prefix: "Notes", kind: "note" as const }],
      excludedPrefixes: ["Private"],
      aiEnabled: true,
      aiEndpoint: "https://example.test/v1",
      aiModel: "fixture",
      secretId: "fixture-secret",
    };
    expect(effectiveSettings(NORMAL_RUNTIME_POLICY, settings)).toEqual(settings);
    expect(effectiveSettings(READ_ONLY_ACCEPTANCE_POLICY, settings)).toEqual({
      ...settings,
      writeEnabled: false,
      aiEnabled: false,
    });
  });

  it("never constructs a normal-only dependency in acceptance mode", () => {
    const factory = vi.fn(() => ({ value: 1 }));
    expect(normalOnly(READ_ONLY_ACCEPTANCE_POLICY, factory)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(normalOnly(NORMAL_RUNTIME_POLICY, factory)).toEqual({ value: 1 });
    expect(factory).toHaveBeenCalledOnce();
  });

  it("rejects direct content writes and direct Quick Capture", async () => {
    await expect(READ_ONLY_VAULT_WRITE_PORT.renameFile(
      "A.md",
      "B.md",
      { path: "A.md", exists: true, mtime: 1, contentHash: "a" },
      { path: "B.md", exists: false },
    )).rejects.toThrow("Read-only acceptance mode blocks vault content writes");
    await expect(READ_ONLY_VAULT_WRITE_PORT.setOwnedField(
      "A.md",
      "knowledge-workbench-kind",
      { present: false },
      { present: true, value: "note" },
    )).rejects.toThrow("Read-only acceptance mode blocks vault content writes");
    await expect(READ_ONLY_QUICK_CAPTURE_PORT.capture()).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx vitest run tests/unit/runtime/safety-policy.test.ts
```

Expected: FAIL because the runtime modules do not exist.

- [ ] **Step 3: Implement the frozen policy and rejecting ports**

Create `src/runtime/safety-policy.ts`:

```ts
import type { PluginSettings } from "../storage/plugin-data";

export type BuildMode = "normal" | "read-only-acceptance";

export interface RuntimeSafetyPolicy {
  readonly mode: BuildMode;
  readonly contentWrites: "allowed" | "blocked";
  readonly quickCapture: "allowed" | "blocked";
  readonly planConfirmation: "allowed" | "blocked";
  readonly history: "full" | "aggregate-only";
  readonly configuration: "mutable" | "read-only";
  readonly ai: "available" | "blocked";
  readonly network: "allowed" | "blocked";
}

export const NORMAL_RUNTIME_POLICY: RuntimeSafetyPolicy = Object.freeze({
  mode: "normal",
  contentWrites: "allowed",
  quickCapture: "allowed",
  planConfirmation: "allowed",
  history: "full",
  configuration: "mutable",
  ai: "available",
  network: "allowed",
});

export const READ_ONLY_ACCEPTANCE_POLICY: RuntimeSafetyPolicy = Object.freeze({
  mode: "read-only-acceptance",
  contentWrites: "blocked",
  quickCapture: "blocked",
  planConfirmation: "blocked",
  history: "aggregate-only",
  configuration: "read-only",
  ai: "blocked",
  network: "blocked",
});

export function policyFor(mode: BuildMode): RuntimeSafetyPolicy {
  if (mode === "normal") return NORMAL_RUNTIME_POLICY;
  if (mode === "read-only-acceptance") return READ_ONLY_ACCEPTANCE_POLICY;
  throw new Error("Unsupported runtime mode");
}

export function effectiveSettings(
  policy: RuntimeSafetyPolicy,
  settings: PluginSettings,
): PluginSettings {
  return policy.mode === "normal"
    ? structuredClone(settings)
    : { ...structuredClone(settings), writeEnabled: false, aiEnabled: false };
}

export function normalOnly<T>(
  policy: RuntimeSafetyPolicy,
  factory: () => T,
): T | undefined {
  return policy.mode === "normal" ? factory() : undefined;
}
```

Create `src/runtime/read-only-ports.ts`:

```ts
import type { QuickCapturePort, VaultWritePort } from "../core/ports";

const contentWriteBlocked = (): Error => new Error(
  "Read-only acceptance mode blocks vault content writes",
);

export const READ_ONLY_VAULT_WRITE_PORT: VaultWritePort = Object.freeze({
  renameFile: async () => { throw contentWriteBlocked(); },
  setOwnedField: async () => { throw contentWriteBlocked(); },
});

export const READ_ONLY_QUICK_CAPTURE_PORT: QuickCapturePort = Object.freeze({
  capture: async () => null,
});
```

- [ ] **Step 4: Extract AI configuration normalization from the network adapter**

Move `normalizeAiEndpoint`, `normalizeAiModel`, and `normalizeAiSecretId` unchanged into `src/ai/ai-config.ts`. Import them from that pure module in:

```ts
// src/adapters/obsidian-ai-client.ts
export {
  normalizeAiEndpoint,
  normalizeAiModel,
  normalizeAiSecretId,
} from "../ai/ai-config";
import { normalizeAiEndpoint, normalizeAiModel } from "../ai/ai-config";

// src/storage/plugin-data-store.ts and src/ui/workbench-controller.ts
import {
  normalizeAiEndpoint,
  normalizeAiModel,
  normalizeAiSecretId,
} from "../ai/ai-config";
```

Keep the existing validation behavior and existing adapter tests unchanged except for direct import paths where the tests intentionally test the pure functions.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/unit/runtime/safety-policy.test.ts tests/unit/adapters/obsidian-ai-client.test.ts tests/unit/storage/plugin-data-store.test.ts
```

Expected: all focused tests PASS and no Obsidian network adapter is imported by the policy test.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/runtime/safety-policy.ts src/runtime/read-only-ports.ts src/ai/ai-config.ts src/adapters/obsidian-ai-client.ts src/storage/plugin-data-store.ts src/ui/workbench-controller.ts tests/unit/runtime/safety-policy.test.ts tests/unit/adapters/obsidian-ai-client.test.ts tests/unit/storage/plugin-data-store.test.ts
git commit -m "feat: add immutable acceptance safety policy"
```

### Task 2: Durable startup normalization and strict artifact binding

**Files:**

- Create: `src/runtime/artifact-binding.ts`
- Modify: `src/storage/plugin-data-store.ts`
- Modify: `tests/unit/storage/plugin-data-store.test.ts`
- Create: `tests/unit/runtime/artifact-binding.test.ts`

- [ ] **Step 1: Write RED tests for durable setting normalization**

Add `enforceRuntimePolicy` tests to `tests/unit/storage/plugin-data-store.test.ts`. Import `vi`, `PLUGIN_DATA_SCHEMA_VERSION`, `PluginSettings`, both runtime policies, and the existing `MemoryPluginDataPort`. Cover:

```ts
it("durably disables historical write and AI settings in acceptance mode", async () => {
  const port = new MemoryPluginDataPort({
    schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
    settings: {
      writeEnabled: true,
      writePreviewAcknowledged: true,
      openAtStartup: true,
      folderRules: [],
      excludedPrefixes: [],
      aiEnabled: true,
      aiEndpoint: "https://example.test/v1",
      aiModel: "fixture",
      secretId: "fixture-secret",
    },
    activeIndex: null,
    staging: null,
    operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
  });
  const store = new PluginDataStore(port);
  await store.load();
  await store.enforceRuntimePolicy(READ_ONLY_ACCEPTANCE_POLICY);
  expect(store.settings()).toMatchObject({
    writeEnabled: false,
    aiEnabled: false,
    openAtStartup: true,
    secretId: "fixture-secret",
  });
  const persisted = await port.load() as { settings: PluginSettings };
  expect(persisted.settings.writeEnabled).toBe(false);
  expect(persisted.settings.aiEnabled).toBe(false);
});

it("performs no policy save or reload for the normal build", async () => {
  const port = new MemoryPluginDataPort();
  const load = vi.spyOn(port, "load");
  const store = new PluginDataStore(port);
  await store.load();
  const loadCount = load.mock.calls.length;
  await store.enforceRuntimePolicy(NORMAL_RUNTIME_POLICY);
  expect(load).toHaveBeenCalledTimes(loadCount);
  expect(port.saveCalls).toHaveLength(0);
});
```

Also add one test each for save failure, reload failure, and a port that silently preserves historical true values. Every failure must reject with `Acceptance safety settings could not be verified`.

- [ ] **Step 2: Run the store test and verify RED**

Run:

```bash
npx vitest run tests/unit/storage/plugin-data-store.test.ts
```

Expected: FAIL because `enforceRuntimePolicy` is missing.

- [ ] **Step 3: Implement the normalization gate**

Add this public method to `PluginDataStore`:

```ts
async enforceRuntimePolicy(policy: RuntimeSafetyPolicy): Promise<void> {
  if (policy.mode === "normal") return;
  const safe = effectiveSettings(policy, this.settings());
  try {
    await this.saveSettings(safe);
    await this.reload();
  } catch {
    throw new Error("Acceptance safety settings could not be verified");
  }
  const verified = this.settings();
  if (verified.writeEnabled || verified.aiEnabled) {
    throw new Error("Acceptance safety settings could not be verified");
  }
}
```

Import `RuntimeSafetyPolicy` and `effectiveSettings` from `src/runtime/safety-policy.ts`. Do not clear acknowledgement, endpoint, model, secret ID, index, journal, or ordinary plugin-local state; only `writeEnabled` and `aiEnabled` are forced false.

- [ ] **Step 4: Write strict artifact decoder and cross-mix tests**

Create `tests/unit/runtime/artifact-binding.test.ts` with a fake host file port. Cover both valid modes plus all cross-mixes:

```ts
const metadata = {
  schemaVersion: 1,
  pluginVersion: "0.1.0",
  buildMode: "read-only-acceptance",
  artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
  contentWrites: "blocked",
  network: "blocked",
};

it("accepts the complete bound acceptance set", async () => {
  await expect(verifyArtifactBinding(
    { id: "knowledge-workbench", name: "Knowledge Workbench (Read-only acceptance)", version: "0.1.0", dir: ".obsidian/plugins/knowledge-workbench" },
    fakeArtifactPort({
      "main.js": "bundle",
      "manifest.json": "{}",
      "styles.css": "styles",
      "acceptance-build.json": JSON.stringify(metadata),
    }),
    {
      mode: "read-only-acceptance",
      pluginVersion: "0.1.0",
      manifestName: "Knowledge Workbench (Read-only acceptance)",
      artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
    },
  )).resolves.toBeUndefined();
});
```

Use table tests for normal plus stale metadata, acceptance plus missing metadata, either wrong display name/version/binding, each of four missing files, every metadata key removed, one extra key, wrong value types, and hostile JSON. Assert the fake `registerHostSurface` spy has zero calls after every failure. Include an extra `data.json` in the fake installed directory and prove it is allowed; exact-four applies to the built distribution, not the installed plugin directory.

- [ ] **Step 5: Run the artifact test and verify RED**

Run:

```bash
npx vitest run tests/unit/runtime/artifact-binding.test.ts
```

Expected: FAIL because `artifact-binding.ts` does not exist.

- [ ] **Step 6: Implement the exact runtime verifier**

Create `src/runtime/artifact-binding.ts` with these public contracts:

```ts
export interface AcceptanceBuildMetadata {
  readonly schemaVersion: 1;
  readonly pluginVersion: string;
  readonly buildMode: "read-only-acceptance";
  readonly artifactBinding: string;
  readonly contentWrites: "blocked";
  readonly network: "blocked";
}

export type ArtifactExpectation = Readonly<{
  mode: "normal" | "read-only-acceptance";
  pluginVersion: string;
  manifestName: "Knowledge Workbench" | "Knowledge Workbench (Read-only acceptance)";
  artifactBinding: string;
}>;

export interface HostArtifactPort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

export interface HostPluginManifest {
  readonly dir?: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
}
```

Implement `decodeAcceptanceBuildMetadata(value)` using `Reflect.ownKeys` and an exact sorted key list. Require all six values and require:

```ts
const binding = `knowledge-workbench@${value.pluginVersion}:read-only-acceptance`;
```

Implement `verifyArtifactBinding(manifest, port, expectation)` in this order:

1. Check manifest directory, ID, version, and exact expected display name.
2. Require `main.js`, `manifest.json`, and `styles.css` to exist.
3. In normal mode, reject if `acceptance-build.json` exists.
4. In acceptance mode, require and decode the metadata, then compare version and binding to the compiled expectation.

Every rejection uses a fixed prefix `Knowledge Workbench artifact binding failed:` and occurs before returning control to plugin composition.

- [ ] **Step 7: Run both focused suites and commit Task 2**

Run:

```bash
npx vitest run tests/unit/storage/plugin-data-store.test.ts tests/unit/runtime/artifact-binding.test.ts
```

Expected: both suites PASS.

Commit:

```bash
git add src/runtime/artifact-binding.ts src/storage/plugin-data-store.ts tests/unit/storage/plugin-data-store.test.ts tests/unit/runtime/artifact-binding.test.ts
git commit -m "feat: fail closed on acceptance startup binding"
```

### Task 3: Policy-first controller gates with zero downstream calls

**Files:**

- Modify: `src/ui/workbench-controller.ts`
- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/performance/index-benchmark.ts`
- Create: `tests/integration/read-only-acceptance.test.ts`
- Modify: `tests/integration/offline.test.ts`

- [ ] **Step 1: Add an acceptance policy option and complete call counters to the controller fixture**

Extend `ControllerFixtureOptions` with:

```ts
readonly policy?: RuntimeSafetyPolicy;
readonly historicalWriteEnabled?: boolean;
readonly historicalAiEnabled?: boolean;
```

Give `FixtureStore` a `saveSettingsCalls: PluginSettings[]` array and push a detached value at the start of `saveSettings`. Initialize historical settings when requested. Add the policy to the controller dependencies:

```ts
policy: options.policy ?? NORMAL_RUNTIME_POLICY,
```

The performance fixture in `tests/performance/index-benchmark.ts` must pass `NORMAL_RUNTIME_POLICY` explicitly so its compile contract remains exact; the heavy performance suite is not run for this feature.

- [ ] **Step 2: Write the acceptance zero-call integration test**

Create `tests/integration/read-only-acceptance.test.ts`. Use one acceptance fixture with historical true settings and direct programmatic calls:

```ts
import { describe, expect, it } from "vitest";
import { READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";
import { controllerFixture } from "../helpers/ui-fixtures";

describe("read-only acceptance controller", () => {
  it("blocks every write, history-detail, and AI boundary before downstream work", async () => {
    const fixture = controllerFixture({
      policy: READ_ONLY_ACCEPTANCE_POLICY,
      historicalWriteEnabled: true,
      historicalAiEnabled: true,
    });
    const suggestion = fixture.controller.refreshSuggestions()[0];
    expect(suggestion).toBeDefined();
    await fixture.controller.previewSuggestion(suggestion!.operation.id);
    await fixture.controller.startQuickCapture();
    await fixture.controller.previewUndo("journal:completed");
    await fixture.controller.requestClearHistory();
    await expect(fixture.controller.historyExportJson("2026-07-14T00:00:00.000Z"))
      .rejects.toThrow("Read-only acceptance mode blocks history details");
    await fixture.controller.viewRecovery("journal:recovery");
    await fixture.controller.previewSampleChange();
    await fixture.controller.setWriteEnabled(true);
    await fixture.controller.saveAiSettings({
      enabled: true,
      endpoint: "https://should-not-parse.invalid/v1",
      model: "blocked",
      secretId: "blocked",
    });
    fixture.controller.setSessionAiSecret("must-not-be-retained");
    await fixture.controller.summarize(new Proxy(["Notes/Alpha.md"], {}));

    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.transactions.calls).toHaveLength(0);
    expect(fixture.quickCapture.calls).toBe(0);
    expect(fixture.undo.calls).toHaveLength(0);
    expect(fixture.historyConfirmation.calls).toBe(0);
    expect(fixture.journal.clearCalls).toBe(0);
    expect(fixture.journal.listCalls).toBe(0);
    expect(fixture.changePreview.sampleCalls).toBe(0);
    expect(fixture.store.saveSettingsCalls).toHaveLength(0);
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.controller.settings()).toMatchObject({
      writeEnabled: false,
      aiEnabled: false,
    });
  });
});
```

Make the fixture preview presenter return `null` when the policy blocks plan confirmation, while still counting the visible plan preview. Do not reuse `organizationWritesBlocked()` for acceptance mode; that method remains exclusively the recovery/journal lock so suggestion preview stays available.

- [ ] **Step 3: Run the integration test and verify RED**

Run:

```bash
npx vitest run tests/integration/read-only-acceptance.test.ts
```

Expected: FAIL because the controller does not yet accept or enforce a runtime policy.

- [ ] **Step 4: Add policy to `WorkbenchDependencies` and effective settings**

Add:

```ts
readonly policy: RuntimeSafetyPolicy;
```

Import `effectiveSettings` and `RuntimeSafetyPolicy`. Change `settings()` to:

```ts
settings(): PluginSettings {
  return effectiveSettings(this.dependencies.policy, this.dependencies.store.settings());
}
```

Use one fixed helper for visible safe status without exposing paths or input:

```ts
private reportAcceptanceBlock(message: string): void {
  if (this.disposed) return;
  this.model = { ...this.model, status: "ready", statusMessage: message };
  this.emit();
}
```

- [ ] **Step 5: Put policy checks at the first executable line of each blocked action**

Use the following exact guards before input validation, presenter calls, store reads, journal reads, secret retention, or client construction:

```ts
if (this.dependencies.policy.contentWrites === "blocked") {
  this.reportAcceptanceBlock("Read-only acceptance mode blocks organization writes");
  return null;
}
```

Place it in `executeConfirmedPlan` before `disposed`, busy, recovery, or transaction checks. Place equivalent guards in:

- `previewUndo` — return before `undo.preview`.
- `startQuickCapture` — return `Promise.resolve(null)` before `quickCapture.capture`.
- `previewSampleChange` and `setWriteEnabled` — return before presenter/store access.
- `requestClearHistory` — return before confirmation and journal access.
- `historyExportJson` — throw `Read-only acceptance mode blocks history details` before journal access.
- `viewRecovery` — return before journal access.
- `saveAiSettings` — return before trimming or normalizing input.
- `setSessionAiSecret` — return before invalidation, settings read, or private-field assignment.
- `startAiAction` — return `{ kind: "local-fallback", reason: "disabled" }` before inspecting the paths array or reading settings.

The public AI methods continue to delegate to `startAiAction`, making the policy check the first shared boundary. The normal policy follows every existing code path unchanged.

- [ ] **Step 6: Prove normal offline behavior did not regress**

Run:

```bash
npx vitest run tests/integration/read-only-acceptance.test.ts tests/integration/offline.test.ts tests/ui/workbench-view.test.ts
```

Expected: acceptance zero-call assertions and existing normal/offline assertions all PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/ui/workbench-controller.ts tests/helpers/ui-fixtures.ts tests/performance/index-benchmark.ts tests/integration/read-only-acceptance.test.ts tests/integration/offline.test.ts
git commit -m "feat: block acceptance actions before side effects"
```

### Task 4: Visible and accessible preview-only UI

**Files:**

- Modify: `src/ui/workbench-view.ts`
- Modify: `src/ui/today-pane.ts`
- Modify: `src/ui/history-tab.ts`
- Modify: `src/ui/settings-tab.ts`
- Modify: `src/ui/change-preview-modal.ts`
- Modify: `styles.css`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/ui/accessibility.test.ts`
- Modify: `tests/ui/history-tab.test.ts`
- Modify: `tests/ui/settings-tab.test.ts`
- Modify: `tests/ui/change-preview-modal.test.ts`

- [ ] **Step 1: Write UI tests for every explanatory disabled state**

Add focused assertions using `READ_ONLY_ACCEPTANCE_POLICY`:

```ts
renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions(), READ_ONLY_ACCEPTANCE_POLICY);
expect(root.querySelector('[data-acceptance-banner="true"]')?.textContent).toBe(
  "Read-only acceptance build. Quick Capture, organization writes, Undo, and AI are unavailable. Derived index data is stored in the plugin's data file.",
);
const capture = root.querySelector<HTMLButtonElement>('[data-action="quick-capture"]');
expect(capture?.disabled).toBe(true);
expect(capture?.getAttribute("aria-label")).toContain("creates Markdown");
```

Cover all of these cases:

- Banner order is tabs, banner, status, progress, panel; it has `role="status"` and explicit text.
- Quick Capture remains visible, is natively disabled, and explains that it creates Markdown.
- AI buttons are omitted in acceptance mode and unchanged in normal mode.
- Aggregate History summaries remain; Undo, View recovery, Clear history, and Export history remain visibly labeled but disabled; recovery paths/details are not rendered.
- Settings retain startup/rule/exclusion review, replace write controls with a fixed notice, replace AI fields with a fixed notice, and construct zero `SecretComponent` instances.
- The preview modal shows operations but cannot submit, never calls `plans.confirm`, returns only `null`, and `requestSample()` returns false without opening.
- Existing normal-mode UI snapshots and action tests remain unchanged.

- [ ] **Step 2: Run the five UI suites and verify RED**

Run:

```bash
npx vitest run tests/ui/workbench-view.test.ts tests/ui/accessibility.test.ts tests/ui/history-tab.test.ts tests/ui/settings-tab.test.ts tests/ui/change-preview-modal.test.ts
```

Expected: new acceptance assertions FAIL while normal assertions continue to pass.

- [ ] **Step 3: Inject policy into renderers without expanding the view model**

Add an optional final parameter defaulting to normal in pure renderers so existing callers stay normal:

```ts
export function renderWorkbench(
  root: HTMLElement,
  model: WorkbenchViewModel,
  actions: WorkbenchActions,
  policy: RuntimeSafetyPolicy = NORMAL_RUNTIME_POLICY,
): void
```

Add the same final policy parameter to `renderTodayPane` and `renderHistory`. Change `createWorkbenchViewClass` to require a policy and pass it to `renderWorkbench`:

```ts
export function createWorkbenchViewClass(
  ItemViewBase: ItemViewConstructor,
  policy: RuntimeSafetyPolicy,
)
```

This keeps persisted state out of mode detection and avoids duplicating policy state inside `WorkbenchViewModel`.

- [ ] **Step 4: Render the banner, disabled Quick Capture, aggregate-only History, and no AI actions**

In `renderWorkbench`, create and insert this element only for acceptance mode:

```ts
const banner = doc.createElement("div");
banner.className = "knowledge-workbench__acceptance-banner";
banner.dataset.acceptanceBanner = "true";
banner.setAttribute("role", "status");
banner.setAttribute("aria-label", "Read-only acceptance mode is active");
banner.textContent = "Read-only acceptance build. Quick Capture, organization writes, Undo, and AI are unavailable. Derived index data is stored in the plugin's data file.";
```

Insert it immediately after the tab row. When acceptance is active, pass no AI callbacks to the suggestions/map surfaces and do not render a stale `aiSuggestion`.

In `renderTodayPane`, create the existing Quick Capture button but set:

```ts
capture.dataset.action = "quick-capture";
capture.disabled = true;
capture.setAttribute(
  "aria-label",
  "Quick Capture creates Markdown and is unavailable in read-only acceptance mode",
);
capture.title = "Unavailable in read-only acceptance mode";
```

Do not attach the capture callback in acceptance mode.

In `renderHistory`, acceptance mode still renders each aggregate summary. Render the four relevant button labels with `disabled = true`, `aria-label` ending in `unavailable in read-only acceptance mode`, and no event listener. Skip `model.recoveryReport` entirely in aggregate-only mode.

- [ ] **Step 5: Make Settings and plan previews policy-aware**

Change the factories to require policy:

```ts
createSettingsTabClass(PluginSettingTabBase, SecretComponentBase, policy)
createChangePreviewModalClass(ModalBase, policy)
```

For acceptance Settings, render this fixed write notice instead of sample review or the write toggle:

```ts
const locked = doc.createElement("p");
locked.className = "knowledge-workbench__locked";
locked.textContent = "Organization writes are unavailable in the read-only acceptance build.";
safety.append(locked);
```

Render a separate `Optional private AI` section containing only `AI configuration and requests are unavailable in the read-only acceptance build.` Do not instantiate `SecretComponentBase` or create endpoint, model, persistent-secret, or session-secret inputs.

For the acceptance change preview:

- `requestSample()` immediately resolves false without `open()`.
- The title is `Change plan preview (read-only)`.
- The introduction says `Preview only. This build cannot confirm or execute changes.`
- The visible final button is labeled `Confirmation unavailable`, natively disabled, and has no submit path.
- `confirmSelection` returns at its first line when `policy.planConfirmation === "blocked"`.
- Closing or Escape settles the request with `null`.

- [ ] **Step 6: Add non-color-only styling**

Add:

```css
.knowledge-workbench__acceptance-banner {
  margin: var(--size-4-3) var(--size-4-4) 0;
  padding: var(--size-4-3);
  border: 2px solid var(--text-warning);
  border-left-width: 0.5rem;
  background: var(--background-secondary);
  color: var(--text-normal);
  font-weight: 600;
}

.knowledge-workbench button:disabled {
  cursor: not-allowed;
  text-decoration: line-through;
  opacity: 0.72;
}
```

The border shape, text, and disabled semantics remain understandable without color.

- [ ] **Step 7: Run UI suites and commit Task 4**

Run:

```bash
npx vitest run tests/ui/workbench-view.test.ts tests/ui/accessibility.test.ts tests/ui/history-tab.test.ts tests/ui/settings-tab.test.ts tests/ui/change-preview-modal.test.ts
```

Expected: all acceptance and normal UI cases PASS.

Commit:

```bash
git add src/ui/workbench-view.ts src/ui/today-pane.ts src/ui/history-tab.ts src/ui/settings-tab.ts src/ui/change-preview-modal.ts styles.css tests/ui/workbench-view.test.ts tests/ui/accessibility.test.ts tests/ui/history-tab.test.ts tests/ui/settings-tab.test.ts tests/ui/change-preview-modal.test.ts
git commit -m "feat: expose accessible acceptance-only UI"
```

### Task 5: Separate composition roots and pre-registration startup gate

**Files:**

- Create: `src/build-mode.d.ts`
- Create: `src/runtime/runtime-composition.ts`
- Create: `src/plugin/knowledge-workbench-plugin.ts`
- Create: `src/main-acceptance.ts`
- Rewrite: `src/main.ts`
- Create: `tests/integration/plugin-startup-gate.test.ts`
- Modify: `tests/smoke/constants.test.ts`

- [ ] **Step 1: Write startup-order tests before moving the plugin shell**

Export a small `runStartupGate` from the future shared plugin module and test its strict sequence with spies:

```ts
it("finishes binding and durable normalization before composition", async () => {
  const order: string[] = [];
  const store = { id: "store" };
  await expect(runStartupGate({
    verifyArtifact: async () => { order.push("verify"); },
    loadStore: async () => { order.push("load"); return store; },
    enforcePolicy: async (value) => { expect(value).toBe(store); order.push("normalize"); },
  })).resolves.toBe(store);
  expect(order).toEqual(["verify", "load", "normalize"]);
});

it.each(["verify", "load", "normalize"] as const)(
  "does not reach composition after %s failure",
  async (failure) => {
    const compose = vi.fn();
    await expect(runStartupGate({
      verifyArtifact: async () => { if (failure === "verify") throw new Error("blocked"); },
      loadStore: async () => {
        if (failure === "load") throw new Error("blocked");
        return {};
      },
      enforcePolicy: async () => { if (failure === "normalize") throw new Error("blocked"); },
    }).then(compose)).rejects.toThrow("blocked");
    expect(compose).not.toHaveBeenCalled();
  },
);
```

The plugin's adapter creation and every `registerView`, `addRibbonIcon`, `addCommand`, `addSettingTab`, metadata listener, and layout listener call must remain after the awaited gate.

- [ ] **Step 2: Run the startup test and verify RED**

Run:

```bash
npx vitest run tests/integration/plugin-startup-gate.test.ts
```

Expected: FAIL because the shared plugin module does not exist.

- [ ] **Step 3: Declare the compile-time artifact constants and runtime composition contract**

Create `src/build-mode.d.ts`:

```ts
declare const __KNOWLEDGE_WORKBENCH_BUILD_MODE__: "normal" | "read-only-acceptance";
declare const __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__: string;
declare const __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__: string;
declare const __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__: string;
```

Create `src/runtime/runtime-composition.ts`:

```ts
import type { App, Plugin, PluginSettingTab } from "obsidian";
import type { QuickCapturePort, VaultWritePort } from "../core/ports";
import type { ObsidianVaultAdapter } from "../adapters/obsidian-vault-adapter";
import type { ChangePlanService } from "../plans/change-plan-service";
import type { ChangePreviewPresenter } from "../ui/change-preview-modal";
import type { HistoryConfirmationPresenter } from "../ui/history-tab";
import type {
  WorkbenchAiDependencies,
  WorkbenchController,
} from "../ui/workbench-controller";
import type { ArtifactExpectation } from "./artifact-binding";
import type { RuntimeSafetyPolicy } from "./safety-policy";

export interface DisposableQuickCapturePort extends QuickCapturePort {
  dispose(): void;
}

export interface RuntimeComposition {
  readonly policy: RuntimeSafetyPolicy;
  readonly artifact: ArtifactExpectation;
  readonly selectVaultWrites: (vault: ObsidianVaultAdapter) => VaultWritePort;
  readonly createQuickCapture: (app: App) => DisposableQuickCapturePort;
  readonly createChangePreview: (
    app: App,
    plans: ChangePlanService,
  ) => ChangePreviewPresenter;
  readonly createHistoryConfirmation: (app: App) => HistoryConfirmationPresenter;
  readonly createSettingsTab: (
    app: App,
    plugin: Plugin,
    controller: WorkbenchController,
  ) => PluginSettingTab;
  readonly createAi?: (app: App) => WorkbenchAiDependencies;
}
```

The composition module has type-only references to Obsidian and adapters; it must emit no normal-only runtime dependency.

- [ ] **Step 4: Extract the shared plugin class and put the gate first**

Move the current lifecycle class from `src/main.ts` into `src/plugin/knowledge-workbench-plugin.ts` and export:

```ts
export interface StartupGateDependencies<T> {
  readonly verifyArtifact: () => Promise<void>;
  readonly loadStore: () => Promise<T>;
  readonly enforcePolicy: (store: T) => Promise<void>;
}

export async function runStartupGate<T>(
  dependencies: StartupGateDependencies<T>,
): Promise<T> {
  await dependencies.verifyArtifact();
  const store = await dependencies.loadStore();
  await dependencies.enforcePolicy(store);
  return store;
}
```

The shared module imports only common safe Obsidian values (`Plugin`, `ItemView`, `Notice`, `TFile`, parsers, and path helpers). It imports no `Modal`, `SecretComponent`, `requestUrl`, Quick Capture adapter, or AI adapter. Export `createKnowledgeWorkbenchPluginClass(runtime: RuntimeComposition)`, declare `ConcreteWorkbenchView = createWorkbenchViewClass(ItemView, runtime.policy)` inside it, and return the existing named `KnowledgeWorkbenchPlugin extends Plugin` class. Move every current lifecycle field and method into that returned class; the composition replacements below are the only behavior changes.

Its `onload()` begins lifecycle setup, then performs exactly:

```ts
const store = await runStartupGate({
  verifyArtifact: () => verifyArtifactBinding(
    this.manifest,
    {
      exists: (path) => this.app.vault.adapter.exists(path),
      read: (path) => this.app.vault.adapter.read(path),
    },
    runtime.artifact,
  ),
  loadStore: async () => {
    const value = new PluginDataStore(new ObsidianPluginDataAdapter(this));
    await value.load();
    return value;
  },
  enforcePolicy: (value) => value.enforceRuntimePolicy(runtime.policy),
});
if (!this.lifecycle.owns(epoch)) return;
```

Only after this block may the method construct `ObsidianVaultAdapter`, indexing, workspace, plans, journal, recovery, Undo, transactions, Quick Capture, change preview, history confirmation, Settings, or AI dependencies.

Change composition points to:

```ts
const quickCapture = runtime.createQuickCapture(this.app);
const changePlans = new ChangePlanService(vaultAdapter, () => {
  const settings = store.settings();
  return runtime.policy.contentWrites === "allowed"
    && settings.writePreviewAcknowledged
    && settings.writeEnabled;
});
const transactions = new TransactionService(
  changePlans,
  vaultAdapter,
  runtime.selectVaultWrites(vaultAdapter),
  journal,
  systemClock,
  recoveryReadiness,
);
const controller = new WorkbenchController({
  policy: runtime.policy,
  reads: vaultAdapter,
  index,
  indexQueue: queue,
  classification: new ClassificationService(),
  today: new TodayService(systemClock),
  map: new MapService(),
  suggestions: new SuggestionService(),
  changePlans,
  changePreview: runtime.createChangePreview(this.app, changePlans),
  store,
  workspace,
  quickCapture,
  transactions,
  journal,
  undo,
  historyConfirmation: runtime.createHistoryConfirmation(this.app),
  clock: systemClock,
  ai: runtime.createAi?.(this.app),
});
```

Create `ConcreteWorkbenchView` with `createWorkbenchViewClass(ItemView, runtime.policy)` inside the factory. Preserve all existing lifecycle, recovery, indexing, command, error-surfacing, and cleanup behavior. The quick-capture field uses `DisposableQuickCapturePort`, so both modes have a no-throw `dispose()`.

- [ ] **Step 5: Rewrite the normal entry point as the only owner of normal-only imports**

`src/main.ts` remains the normal entry point and imports `requestUrl`, `SecretComponent`, `ObsidianAiClient`, `ObsidianQuickCaptureAdapter`, and `createQuickCaptureModalClass`. It must assert the compiled mode before composition:

```ts
if (
  __KNOWLEDGE_WORKBENCH_BUILD_MODE__ !== "normal"
  || __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__ !== "Knowledge Workbench"
) {
  throw new Error("Normal entry point requires a normal build mode");
}
const policy = policyFor(__KNOWLEDGE_WORKBENCH_BUILD_MODE__);
```

Its artifact expectation is:

```ts
const artifact: ArtifactExpectation = Object.freeze({
  mode: "normal",
  pluginVersion: __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__,
  manifestName: __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__,
  artifactBinding: __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__,
});
```

Normal factories reproduce current behavior:

- `selectVaultWrites` returns the vault adapter.
- Quick Capture constructs `ObsidianQuickCaptureAdapter` and its modal.
- Change preview permits confirmation.
- History creates the current confirmation modal.
- Settings receives `SecretComponent`.
- AI creates the preview presenter, secret getter, `ObsidianAiClient`, `requestUrl` transport, timers, and delay exactly as before.

Export `createKnowledgeWorkbenchPluginClass(runtime)` as default.

- [ ] **Step 6: Add the acceptance entry point with a disjoint dependency graph**

Create `src/main-acceptance.ts`. It may import common Obsidian bases, parsers, `READ_ONLY_VAULT_WRITE_PORT`, the policy, safe UI factories, and the shared plugin factory. It must not import the normal main, Quick Capture modal/adapter, AI client/payload modal, `requestUrl`, or `SecretComponent`.

Assert mode and artifact binding:

```ts
if (
  __KNOWLEDGE_WORKBENCH_BUILD_MODE__ !== "read-only-acceptance"
  || __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__ !== "Knowledge Workbench (Read-only acceptance)"
) {
  throw new Error("Acceptance entry point requires read-only-acceptance mode");
}
const policy = policyFor(__KNOWLEDGE_WORKBENCH_BUILD_MODE__);
const artifact: ArtifactExpectation = Object.freeze({
  mode: "read-only-acceptance",
  pluginVersion: __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__,
  manifestName: __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__,
  artifactBinding: __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__,
});
```

The acceptance composition uses:

```ts
selectVaultWrites: () => READ_ONLY_VAULT_WRITE_PORT,
createQuickCapture: () => ({
  capture: READ_ONLY_QUICK_CAPTURE_PORT.capture,
  dispose: () => undefined,
}),
createAi: undefined,
```

Create the change-preview factory with acceptance policy, the Settings factory with `undefined` secret constructor and acceptance policy, and a history confirmation presenter whose `request()` resolves false. The controller prevents these presenters from being called; the factories are second-layer defenses.

- [ ] **Step 7: Run startup, smoke, integration, and type/build checks**

Run:

```bash
npx vitest run tests/integration/plugin-startup-gate.test.ts tests/integration/read-only-acceptance.test.ts tests/smoke/constants.test.ts
npx tsc -noEmit -skipLibCheck
npm run build
```

Expected: all tests PASS, TypeScript passes, and the root normal `main.js` builds with explicit normal constants.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/build-mode.d.ts src/runtime/runtime-composition.ts src/plugin/knowledge-workbench-plugin.ts src/main.ts src/main-acceptance.ts tests/integration/plugin-startup-gate.test.ts tests/smoke/constants.test.ts
git commit -m "refactor: split normal and acceptance composition roots"
```

### Task 6: Exact four-file, rollback-safe acceptance builder

**Files:**

- Modify: `esbuild.config.mjs`
- Create: `scripts/acceptance-build.mjs`
- Create: `scripts/build-acceptance.mjs`
- Modify: `scripts/install-dev.mjs`
- Modify: `package.json`
- Modify: `eslint.config.mts`
- Create: `tests/packaging/read-only-acceptance-build.test.ts`
- Modify: `tests/packaging/install-dev.test.ts`

- [ ] **Step 1: Write packaging tests against the real builder**

Create `tests/packaging/read-only-acceptance-build.test.ts`. Run the builder inside a temporary copy containing only the required source tree and build files, or use an explicit temporary `outputRoot` test seam that remains constrained beneath the repository's `dist` directory. Cover:

```ts
const EXPECTED_METADATA = Object.freeze({
  schemaVersion: 1,
  pluginVersion: "0.1.0",
  buildMode: "read-only-acceptance",
  artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
  contentWrites: "blocked",
  network: "blocked",
});

it("publishes exactly four version-bound files without touching normal artifacts", async () => {
  const before = await hashesOf(["main.js", "manifest.json", "styles.css"]);
  await buildAcceptanceArtifact({ repoRoot: process.cwd() });
  const target = resolve("dist/read-only-acceptance");
  expect((await readdir(target)).sort()).toEqual([
    "acceptance-build.json",
    "main.js",
    "manifest.json",
    "styles.css",
  ]);
  expect(JSON.parse(await readFile(join(target, "acceptance-build.json"), "utf8")))
    .toEqual(EXPECTED_METADATA);
  expect(JSON.parse(await readFile(join(target, "manifest.json"), "utf8")))
    .toMatchObject({
      id: "knowledge-workbench",
      name: "Knowledge Workbench (Read-only acceptance)",
      version: "0.1.0",
    });
  expect(await hashesOf(["main.js", "manifest.json", "styles.css"])).toEqual(before);
});
```

Add tests for:

- Two clean builds produce identical hashes for all four final files.
- Metadata has exactly six keys, exact types/values, a trailing newline, and no vault path, endpoint, model, secret, note identifier, state, or journal field.
- Manifest ID/version remain normal while only the name changes.
- Acceptance bundle embeds the expected mode/version/name/binding.
- esbuild metafile inputs exclude `src/main.ts`, `src/adapters/obsidian-quick-capture-adapter.ts`, `src/ui/quick-capture-modal.ts`, `src/adapters/obsidian-ai-client.ts`, and `src/ui/ai-payload-preview-modal.ts`.
- Bundle text excludes `requestUrl`, `secretStorage`, `SecretComponent`, `ObsidianAiClient`, and `ObsidianQuickCaptureAdapter`.
- A source style/manifest symlink is rejected.
- A symlink or non-directory `dist`/target is rejected without removal.
- Injected failure before bundle, after stage validation, and after target backup leaves no first-time target and preserves an existing target byte-for-byte.
- If rollback cannot prove backup identity, the backup is retained and the error says `backup retained`.
- A failed build never publishes a partial directory or a fifth file.

- [ ] **Step 2: Run the packaging test and verify RED**

Run:

```bash
npx vitest run tests/packaging/read-only-acceptance-build.test.ts
```

Expected: FAIL because the acceptance builder and script are missing.

- [ ] **Step 3: Export one explicit esbuild function for both modes**

Refactor `esbuild.config.mjs` to export:

```js
export async function buildBundle({
  entryPoint,
  outfile,
  mode,
  pluginVersion,
  manifestName,
  artifactBinding,
  production,
  metafile = false,
})
```

Reject any mode except `normal` and `read-only-acceptance`. Pass exact JSON literals through esbuild `define`:

```js
define: {
  __KNOWLEDGE_WORKBENCH_BUILD_MODE__: JSON.stringify(mode),
  __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__: JSON.stringify(pluginVersion),
  __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__: JSON.stringify(manifestName),
  __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__: JSON.stringify(artifactBinding),
},
```

Keep the current banner, external modules, CJS format, `es2021` target, and tree shaking. Production uses `minify: true` and no source map. Return esbuild's build result so the acceptance builder can inspect the in-memory metafile. The direct CLI path is protected with an `import.meta.url`/`pathToFileURL(process.argv[1])` guard, preventing an import from starting watch mode.

The direct normal build strictly reads root `manifest.json`, requires:

```json
{
  "id": "knowledge-workbench",
  "name": "Knowledge Workbench"
}
```

It also requires a bounded semantic version and equality with `package.json.version`. Compile `src/main.ts` to root `main.js` with binding `knowledge-workbench@<version>:normal`. Development watch remains normal-only.

- [ ] **Step 4: Implement exact metadata and stage validation**

In `scripts/acceptance-build.mjs`, export:

```js
export const ACCEPTANCE_FILES = Object.freeze([
  "acceptance-build.json",
  "main.js",
  "manifest.json",
  "styles.css",
]);

export function acceptanceMetadata(version) {
  return Object.freeze({
    schemaVersion: 1,
    pluginVersion: version,
    buildMode: "read-only-acceptance",
    artifactBinding: `knowledge-workbench@${version}:read-only-acceptance`,
    contentWrites: "blocked",
    network: "blocked",
  });
}

export async function buildAcceptanceArtifact({
  repoRoot,
  hooks = {},
})
```

Use `lstat` and `realpath` to require the repository root to be a canonical non-symlink directory. If `dist` is absent, create that one direct child and verify it; if present, require it to be a non-symlink directory within the canonical repository. Require source `manifest.json` and `styles.css` to be regular non-symlink files. Create a unique sibling stage:

```js
const stage = join(dist, `.read-only-acceptance.tmp-${process.pid}-${randomUUID()}`);
```

Inside the new stage:

1. Build `src/main-acceptance.ts` to `main.js` with production settings and `metafile: true`.
2. Copy `styles.css` with `COPYFILE_EXCL`.
3. Write a cloned manifest whose only changed field is the exact acceptance display name.
4. Write `JSON.stringify(acceptanceMetadata(version), null, 2) + "\n"`.
5. Require sorted `readdir(stage)` to equal `ACCEPTANCE_FILES` exactly.
6. Require all four entries to be non-empty regular non-symlink files.
7. Decode manifest and metadata again, require exact bindings, inspect metafile input denylist, and scan bundle tripwire strings.

Test hooks may run only at named internal boundaries `beforeBundle`, `afterStageValidation`, and `afterBackup`; production calls use the default empty frozen object.

- [ ] **Step 5: Implement rollback-safe directory publication**

Publish only after full stage validation:

1. If `dist/read-only-acceptance` exists, require a non-symlink directory, record its `(dev, ino)`, and rename it to a unique sibling backup.
2. Rename the validated stage to `dist/read-only-acceptance` on the same filesystem.
3. Revalidate the published exact four-file set and bindings.
4. Remove the backup only if its current identity still equals the recorded identity.
5. On any failure after backup, restore only when the backup identity still matches and the target is absent. Never recursively remove an object whose identity changed.
6. If safe restore or cleanup is impossible, retain the backup and include `backup retained` in the error.
7. In `finally`, remove only a stage whose recorded identity still matches.

This is a directory-level publisher. Do not reuse the development installer's per-file replacement algorithm and do not accept a vault path.

- [ ] **Step 6: Add the CLI, scripts, lint ignore, and normal-only installer guard**

Create `scripts/build-acceptance.mjs` as a CLI-only wrapper:

```js
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAcceptanceArtifact } from "./acceptance-build.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await buildAcceptanceArtifact({ repoRoot });
```

Update scripts:

```json
{
  "dev": "node esbuild.config.mjs development normal",
  "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production normal",
  "build:acceptance": "tsc -noEmit -skipLibCheck && node scripts/build-acceptance.mjs"
}
```

Keep `install:dev` calling normal `build`. Add `dist/**` to `globalIgnores` in `eslint.config.mts`, because lint runs after a generated acceptance bundle exists.

Strengthen `scripts/install-dev.mjs` so the source manifest must have exact normal ID/name/version and the root repository must not contain `acceptance-build.json`. Keep its artifact list exactly `main.js`, `manifest.json`, `styles.css`; do not add a mode or arbitrary destination.

Update the installer fixture manifest and add a regression proving an existing `dist/read-only-acceptance` does not change the three root files installed into a dedicated synthetic `.dev-vault`.

- [ ] **Step 7: Run packaging, build, installer, and lint checks**

Run:

```bash
npx vitest run tests/packaging/read-only-acceptance-build.test.ts tests/packaging/install-dev.test.ts tests/unit/runtime/artifact-binding.test.ts
npm run build:acceptance
npm run lint
```

Expected: all tests PASS; the generated directory contains exactly four files; lint ignores `dist/**`; root normal artifacts remain unchanged by the acceptance build.

- [ ] **Step 8: Commit Task 6 without generated `dist/` files**

```bash
git status --short
git add esbuild.config.mjs scripts/acceptance-build.mjs scripts/build-acceptance.mjs scripts/install-dev.mjs package.json eslint.config.mts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/install-dev.test.ts
git commit -m "build: add atomic read-only acceptance artifact"
```

Expected: `dist/` remains ignored and no generated artifact is staged.

### Task 7: Authorization-gated real-vault runbook

**Files:**

- Create: `docs/runbooks/real-vault-read-only-acceptance.md`
- Create: `tests/packaging/read-only-runbook.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-14-read-only-acceptance-mode-design.md`

- [ ] **Step 1: Write the runbook contract test**

Create `tests/packaging/read-only-runbook.test.ts` and assert:

```ts
const runbook = readFileSync(
  resolve("docs/runbooks/real-vault-read-only-acceptance.md"),
  "utf8",
);

expect(runbook).toContain("Preparation is not authorization");
expect(runbook).toContain("Stop before installation until the user gives fresh, explicit authorization");
for (const heading of [
  "Artifact and version preflight",
  "Allowed actions after authorization",
  "Forbidden actions",
  "Stop conditions",
  "Cleanup",
  "Evidence allowlist",
]) expect(runbook).toContain(`## ${heading}`);

expect(runbook).not.toMatch(/\/(?:Users|Volumes|home|private)\//u);
expect(runbook).not.toMatch(/[A-Za-z]:\\/u);
expect(runbook).not.toMatch(/https?:\/\//u);
expect(runbook).not.toMatch(/\b[A-Fa-f0-9]{32,}\b/u);
expect(runbook).toContain("Never hot-overwrite a loaded plugin");
expect(runbook).toContain("Derived index data may be written to the plugin data file");
expect(runbook).toContain("A normal artifact requires a separate replacement authorization");
```

Also assert the evidence allowlist names only commit, plugin/Obsidian versions, aggregate note count, aggregate timings, boolean results, and sanitized error categories. Assert explicit prohibitions for note names/titles/bodies/frontmatter/screenshots, paths, plugin data, journals, endpoints, models, and secret identifiers/values.

- [ ] **Step 2: Run the runbook test and verify RED**

Run:

```bash
npx vitest run tests/packaging/read-only-runbook.test.ts
```

Expected: FAIL because the runbook does not exist.

- [ ] **Step 3: Write the complete runbook**

Create `docs/runbooks/real-vault-read-only-acceptance.md` with this operational content:

```markdown
# Real-vault read-only acceptance runbook

Preparation is not authorization. Stop before installation until the user gives fresh, explicit authorization for real-vault access and the exact action to be taken.

This procedure promises zero plugin-initiated vault-content writes and zero plugin-initiated network requests. Obsidian configuration and cache files may change. Derived index data may be written to the plugin data file.

## Artifact and version preflight

1. Record only the approved commit, plugin version, and Obsidian version.
2. Build the acceptance artifact with `npm run build:acceptance`.
3. Confirm the prepared directory contains exactly `main.js`, `manifest.json`, `styles.css`, and `acceptance-build.json`.
4. Confirm the manifest name is `Knowledge Workbench (Read-only acceptance)` and the metadata says content writes and network are blocked.
5. Stop here unless fresh, explicit authorization has been given.

After authorization, disable the currently loaded plugin and fully quit Obsidian before replacing files. Never hot-overwrite a loaded plugin. Replace the complete four-file artifact as one prepared set. Do not combine files from normal and acceptance builds.

Restart Obsidian. Before any vault interaction, confirm the read-only banner and artifact binding. A missing banner, binding error, partial file set, or startup-normalization error is an immediate stop.

## Allowed actions after authorization

- Complete an index scan and record aggregate count and timing only.
- Review folder-rule proposals without applying them.
- Validate Today using boolean checks and aggregate counts only.
- Search, focus, cancel, and inspect the map without recording note identifiers.
- Open an organization suggestion preview and close or cancel it.
- Restart once and observe whether the derived index restores.

## Forbidden actions

- Do not use Quick Capture or create, edit, move, rename, or delete Markdown.
- Do not confirm or execute a plan and do not use Undo.
- Do not clear or export History and do not open recovery details.
- Do not configure AI, enter an endpoint, model, secret identifier, or secret value, and do not make an AI request.
- Do not change folder rules or exclusions during the first pass.
- Do not take screenshots containing note content.
- Do not record paths, file names, note titles, bodies, frontmatter, plugin data, journal payloads, endpoints, models, or secret identifiers or values.

## Stop conditions

Immediately disable the plugin and stop if any of these occurs:

- Any Markdown inventory or hash changes in a way attributable to the plugin.
- Any write, Quick Capture, Undo, History detail/export/mutation, or AI control is available.
- The read-only banner is missing or artifact binding fails.
- Unexpected plugin-initiated network activity appears.
- `Recovery required` appears.
- Startup normalization fails or an error cannot be explained without inspecting private content.

Do not switch to a normal artifact after a stop. First verify that durable `writeEnabled` and `aiEnabled` are false under a separately authorized diagnostic action.

## Cleanup

Disable the plugin and fully quit Obsidian. Stop there. Removing the acceptance artifact, restoring another build, or changing plugin data is a separate action requiring authorization. A normal artifact requires a separate replacement authorization.

## Evidence allowlist

Evidence may contain only:

- approved commit;
- plugin and Obsidian versions;
- aggregate note count;
- aggregate timings;
- boolean pass or fail checks;
- sanitized error categories that contain no identifiers or content.

Review the evidence against this allowlist before sharing or saving it. If a field is not listed, omit it.
```

This document intentionally contains no real vault location, note example, endpoint, model, credential, screenshot, or journal sample.

- [ ] **Step 4: Link the runbook without implying authorization**

Add a README release-safety paragraph that says the acceptance build is prepared by `npm run build:acceptance`, the runbook is for a later separately authorized pass, and neither the build command nor the document authorizes installation or real-vault access.

Change the design status line to `Status: approved; implementation covered by the linked plan` and add a relative link to this implementation plan. Do not mark the real-vault acceptance itself passed.

- [ ] **Step 5: Run privacy and documentation tests**

Run:

```bash
npx vitest run tests/packaging/read-only-runbook.test.ts tests/packaging/read-only-acceptance-build.test.ts
rg -n '/Users/|/Volumes/|https?://|file://' docs/runbooks/real-vault-read-only-acceptance.md
```

Expected: both tests PASS and `rg` returns no matches.

- [ ] **Step 6: Commit Task 7**

```bash
git add docs/runbooks/real-vault-read-only-acceptance.md tests/packaging/read-only-runbook.test.ts README.md docs/superpowers/specs/2026-07-14-read-only-acceptance-mode-design.md
git commit -m "docs: add gated read-only acceptance runbook"
```

### Task 8: Full verification, dependency audit, Graphify refresh, and review

**Files:**

- Verify all changed files from Tasks 1–7.
- Update generated Graphify files only if the installed CLI's supported `graphify update .` command changes tracked output.

- [ ] **Step 1: Run the focused safety matrix**

Run:

```bash
npx vitest run \
  tests/unit/runtime/safety-policy.test.ts \
  tests/unit/runtime/artifact-binding.test.ts \
  tests/unit/storage/plugin-data-store.test.ts \
  tests/integration/read-only-acceptance.test.ts \
  tests/integration/offline.test.ts \
  tests/integration/plugin-startup-gate.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/accessibility.test.ts \
  tests/ui/history-tab.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/change-preview-modal.test.ts \
  tests/packaging/read-only-acceptance-build.test.ts \
  tests/packaging/read-only-runbook.test.ts \
  tests/packaging/install-dev.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Build both artifacts and inspect the acceptance dependency boundary**

Run:

```bash
npm run build
npm run build:acceptance
find dist/read-only-acceptance -maxdepth 1 -type f -print | sort
rg -n 'requestUrl|secretStorage|SecretComponent|ObsidianAiClient|ObsidianQuickCaptureAdapter' dist/read-only-acceptance/main.js
```

Expected: `find` prints exactly the four allowlisted files and the denylist scan returns no matches. Root `main.js`, `manifest.json`, and `styles.css` remain the normal artifact.

- [ ] **Step 3: Run the complete release gate**

Run:

```bash
npm run verify
```

Expected: lint, all default Vitest suites, TypeScript, and normal production build PASS. Do not run `npm run test:performance`; indexing, projection, map scoring, and persistence performance are outside this change.

- [ ] **Step 4: Check spec coverage and unfinished markers**

Read the approved design from top to bottom and map every requirement to a passing test or an explicit runbook line. Then scan the implementation plan, production code, tests, and runbook for unfinished markers or instruction-like filler; replace any occurrence with executable code or precise prose. Confirm type names, mode strings, metadata keys, banner text, manifest names, and artifact binding match across source, builder, tests, and documentation.

- [ ] **Step 5: Run independent code and threat reviews**

Request two reviews against the approved design:

1. Correctness/maintainability review of the plugin split, controller gates, normal-mode regression risk, tests, and atomic builder.
2. Threat review for every Markdown write path, Quick Capture, Undo, History disclosure/mutation, AI/secret/network dependency, startup ordering, artifact cross-mix, symlink/TOCTOU, rollback, and evidence privacy path.

Address every actionable finding, rerun the smallest affected suite, then rerun `npm run verify` if production code changed.

- [ ] **Step 6: Refresh Graphify and verify the hook**

Run from the repository root:

```bash
graphify update .
graphify hook status
git status --short
```

Expected: Graphify update succeeds and the post-commit hook reports installed. If tracked graph output changes, commit only that generated update:

```bash
git add graphify-out
git commit -m "chore: refresh project graph"
```

- [ ] **Step 7: Make the final verification commit if review fixes remain**

If review fixes are present and uncommitted, inspect `git status --short`, stage each reviewed path by its literal name, and commit with `git commit -m "fix: close acceptance safety review findings"`. Do not stage an unrelated user change. Then require a clean worktree.

- [ ] **Step 8: Report the prepared boundary accurately**

Report:

- commit hashes;
- focused and full verification results;
- exact acceptance artifact directory and four-file schema;
- normal artifact preservation;
- dependency-denylist result;
- Graphify hook/update state;
- explicit statement that no real vault, endpoint, credential, network request, publication, or deployment was used;
- explicit statement that building the artifact prepares but does not authorize or complete a real-vault acceptance pass.
