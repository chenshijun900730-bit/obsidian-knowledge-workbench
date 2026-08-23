# Knowledge Workbench Smart Cloud Directory Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cloud-directory selection usable from an empty path by combining local recent paths, TXT group hints, and validated session cache, while allowing only an explicitly confirmed, bounded, read-only Baidu same-name lookup.

**Architecture:** Keep persisted recent paths in the existing typed plugin settings codec, derive and rank local candidates with pure catalog functions, and add a normal-build-only locator that reuses the existing `BaiduCatalogSourcePort`. The controller supplies a narrow candidate runtime to a stateful modal; the modal never reads settings or credentials and never calls scan or verification actions. Both settings and workbench verification render one shared current-directory field with manual entry folded under an advanced section.

**Tech Stack:** TypeScript 5.8, Vitest 4, jsdom, Obsidian 1.13 APIs, existing Baidu OAuth/list adapter, CSS with Obsidian theme variables, esbuild.

---

## Scope and safety invariants

- Work only on branch `codex/smart-directory-picker` in `/Users/xiaowanzi/Documents/obsidian-knowledge-workbench`.
- Use `docs/superpowers/specs/2026-08-23-smart-cloud-directory-picker-design.md` as the product contract.
- Never stage or modify the unrelated untracked research Markdown files at the repository root.
- Do not use PMH, run PMH experiments, or create PMH checkpoints for this work.
- Do not run real OAuth, a real Baidu request, PDF download, a real full-library import, or a real Vault write while implementing this plan.
- Opening the picker, typing, changing source filters, clearing recent paths, and choosing an already exact local candidate must issue zero Baidu list requests.
- A Baidu list call is permitted only after the user clicks the same-name locator action and confirms the displayed query, root entry, and fixed budget.
- The locator may use `/` only inside its own traversal. Existing scan and verification entry points must continue to reject `/`.
- Selecting a directory only returns and remembers a path. It must not invoke scan, large verification, resume, OAuth, or any write-capable Baidu API.
- Acceptance, disabled, and offline compositions must not expose or bundle the locator, OAuth, SecretStorage, or Baidu list capability.
- All tests use synthetic paths, identities, responses, and credentials.
- After every commit, inspect `git status --short`; the only staged files must be files named by that task.

## File map

| File | Responsibility |
| --- | --- |
| `src/storage/recent-cloud-directories.ts` | Versioned recent-path codec, strict validation, MRU update, clear, and 10-item cap |
| `src/storage/plugin-data.ts` | Add the typed recent-directory field to `PluginSettings` |
| `src/storage/plugin-data-store.ts` | Decode historical, missing, and malformed recent-directory data fail-closed |
| `src/catalog/cloud-directory-candidates.ts` | Candidate union, source merge, conflict projection, filtering, and stable ranking |
| `src/catalog/cloud-directory-search.ts` | Reuse the existing deterministic fuzzy scorer without network access |
| `src/catalog/cloud-directory-page-validator.ts` | Shared absolute-path, direct-parent, filename, identity, and Baidu entry validation |
| `src/catalog/cloud-directory-discovery-service.ts` | Preserve non-root discovery and expose detached validated session-cache snapshots |
| `src/catalog/cloud-directory-locator.ts` | Root-entry, 500-directory, 50-request, 120-second page-atomic BFS locator |
| `src/catalog/cloud-catalog-runtime.ts` | Optional locator capability and lifecycle disposal on the cloud runtime |
| `src/runtime/normal-cloud-catalog-composition.ts` | Compose discovery and locator over the same Baidu source instance |
| `src/runtime/runtime-composition.ts` | Keep the picker factory normal-build-only and independent of the Baidu adapter |
| `src/ui/workbench-controller.ts` | Build candidate snapshots, remember/clear recent paths, coordinate locator, and accept empty initial paths |
| `src/ui/cloud-directory-picker.ts` | Local search/filter UI, explicit locator confirmation, selection, keyboard, and late-result guards |
| `src/ui/cloud-directory-field.ts` | Shared current-directory card, select action, and advanced manual input |
| `src/ui/settings-sections.ts` | Use the shared field for scan and category-verification roots |
| `src/ui/verification-page.ts` | Use the same shared field in the workbench verification page |
| `src/ui/workbench-view.ts` | Route the shared picker result without starting verification |
| `src/i18n/workbench-i18n.ts` | Chinese/English source, state, budget, warning, conflict, and accessibility strings |
| `src/main.ts` | Bind the normal Obsidian modal and safe notice surface |
| `src/plugin/knowledge-workbench-plugin.ts` | Construct the picker presenter without requiring a pre-entered discovery root |
| `styles.css` | Responsive current-directory card, result metadata, source chips, focus, and long-path layout |
| `README.md` | Explain recent-path persistence and the locator-only root exception |
| `manifest.json`, `package.json`, `package-lock.json`, `versions.json` | Release `v0.1.1` metadata |

## Task 1: Add a versioned, bounded recent-directory setting

**Files:**
- Create: `src/storage/recent-cloud-directories.ts`
- Create: `tests/unit/storage/recent-cloud-directories.test.ts`
- Modify: `src/storage/plugin-data.ts`
- Modify: `src/storage/plugin-data-store.ts`
- Modify: `tests/unit/storage/plugin-data-store.test.ts`
- Modify: complete `PluginSettings` fixtures reported by `rg -l "secretId:" src tests`

- [x] **Step 1: Write the failing codec and persistence tests**

Cover normalization, deduplication, MRU movement, deterministic ordering, the 10-item cap, invalid roots, and canonical UTC timestamps. The central test is:

```ts
import { describe, expect, it } from "vitest";
import {
  EMPTY_RECENT_CLOUD_DIRECTORIES,
  rememberRecentCloudDirectory,
} from "../../../src/storage/recent-cloud-directories";

describe("recent cloud directories", () => {
  it("normalizes, deduplicates, moves the selected path to the front, and caps at ten", () => {
    let state = EMPTY_RECENT_CLOUD_DIRECTORIES;
    for (let index = 0; index < 11; index += 1) {
      state = rememberRecentCloudDirectory(
        state,
        `/Synthetic/Folder-${index}`,
        Date.UTC(2026, 7, 23, 0, 0, index),
      );
    }
    state = rememberRecentCloudDirectory(
      state,
      "/Synthetic/Folder-5",
      Date.UTC(2026, 7, 23, 0, 1, 0),
    );

    expect(state.schemaVersion).toBe(1);
    expect(state.items).toHaveLength(10);
    expect(state.items[0]).toEqual({
      path: "/Synthetic/Folder-5",
      filename: "Folder-5",
      lastUsedAt: "2026-08-23T00:01:00.000Z",
    });
    expect(new Set(state.items.map((item) => item.path)).size).toBe(10);
  });

  it.each(["/", "Synthetic", "/Synthetic//Child", "/Synthetic/../Child"])(
    "refuses an invalid remembered path %j",
    (path) => {
      expect(() => rememberRecentCloudDirectory(
        EMPTY_RECENT_CLOUD_DIRECTORIES,
        path,
        Date.UTC(2026, 7, 23),
      )).toThrow("invalid-scan-root");
    },
  );
});
```

In `plugin-data-store.test.ts`, load settings whose recent field has a wrong schema, more than 10 entries, a root path, a mismatched filename, or a non-canonical timestamp. Assert that the entire recent field becomes the empty v1 value while locale and `openAtStartup` survive. Also assert that valid data survives save/reload and serialized settings contain no AppKey, SecretKey, token, authorization code, or `fsId` field.

- [x] **Step 2: Run the focused tests and verify expected failures**

```bash
npx vitest run tests/unit/storage/recent-cloud-directories.test.ts tests/unit/storage/plugin-data-store.test.ts
```

Expected: FAIL because the module and `PluginSettings.recentCloudDirectories` do not exist.

- [x] **Step 3: Implement the complete recent-path value object**

Create this public surface:

```ts
import { normalizeCatalogScanRoot } from "../catalog/catalog-path";

export const MAX_RECENT_CLOUD_DIRECTORY_COUNT = 10 as const;

export interface RecentCloudDirectory {
  readonly path: string;
  readonly filename: string;
  readonly lastUsedAt: string;
}

export interface RecentCloudDirectoriesV1 {
  readonly schemaVersion: 1;
  readonly items: readonly RecentCloudDirectory[];
}

export const EMPTY_RECENT_CLOUD_DIRECTORIES: RecentCloudDirectoriesV1 =
  Object.freeze({ schemaVersion: 1, items: Object.freeze([]) });

export function decodeRecentCloudDirectories(value: unknown): RecentCloudDirectoriesV1;

export function rememberRecentCloudDirectory(
  current: RecentCloudDirectoriesV1,
  path: string,
  usedAt: number,
): RecentCloudDirectoriesV1;
```

The decoder must require schema `1`, an array no longer than 10, unique normalized non-root paths, a filename equal to the path tail, and a canonical `YYYY-MM-DDTHH:mm:ss.sssZ` timestamp whose `new Date(value).toISOString()` round-trips. If any entry fails, return a detached empty v1 value; never retain a valid subset. Sort valid decoded entries by descending timestamp and then path.

Add `readonly recentCloudDirectories: RecentCloudDirectoriesV1` to `PluginSettings`, default it to empty v1, and decode it from `value.recentCloudDirectories`. Keep `PLUGIN_DATA_SCHEMA_VERSION` unchanged because the field is backward-compatible.

- [x] **Step 4: Update typed fixtures and rerun storage tests**

```bash
rg -n "secretId:" src tests
npx vitest run tests/unit/storage/recent-cloud-directories.test.ts tests/unit/storage/plugin-data-store.test.ts tests/unit/runtime/safety-policy.test.ts tests/ui/workbench-controller.test.ts tests/ui/settings-sections.test.ts
```

Expected: PASS. Missing historical data becomes an empty list without clearing other settings.

- [x] **Step 5: Commit the storage boundary**

```bash
git add src/storage/recent-cloud-directories.ts src/storage/plugin-data.ts src/storage/plugin-data-store.ts tests/unit/storage/recent-cloud-directories.test.ts tests/unit/storage/plugin-data-store.test.ts tests/unit/runtime/safety-policy.test.ts tests/ui/workbench-controller.test.ts tests/ui/settings-sections.test.ts tests/helpers/ui-fixtures.ts
git commit -m "feat(目录): 保存有限最近云端路径"
```

## Task 2: Build pure local candidates and expose a detached session-cache snapshot

**Files:**
- Create: `src/catalog/cloud-directory-candidates.ts`
- Create: `tests/unit/catalog/cloud-directory-candidates.test.ts`
- Modify: `src/catalog/cloud-directory-discovery-service.ts`
- Modify: `tests/unit/catalog/cloud-directory-discovery-service.test.ts`
- Modify: `src/catalog/cloud-directory-search.ts`
- Modify: `tests/unit/catalog/cloud-directory-search.test.ts`

- [x] **Step 1: Write failing candidate merge and cache-detachment tests**

Use the approved discriminated union:

```ts
export type CloudDirectoryCandidate =
  | Readonly<{
      kind: "exact";
      path: string;
      filename: string;
      source: "recent" | "session-cache" | "cloud-locator";
      pathState: "previously-used" | "session-verified";
      cloudFsId?: string;
    }>
  | Readonly<{
      kind: "name-hint";
      filename: string;
      source: "txt-group";
      catalogGroupKey: string;
    }>
  | Readonly<{
      kind: "conflict";
      filename: string;
      path: string;
      source: "cloud-locator";
      reason: "same-path-different-identity";
    }>;
```

Tests must prove source priority, `txt-root-items` exclusion, TXT nonselection, no root/name concatenation, same-path source merging, same-name/different-path preservation, conflict precedence, selected-path priority, stable fuzzy ties, Chinese/numeric matching, no pinyin inference, detached outputs, and zero source calls.

- [x] **Step 2: Run focused tests and verify missing exports**

```bash
npx vitest run tests/unit/catalog/cloud-directory-candidates.test.ts tests/unit/catalog/cloud-directory-search.test.ts tests/unit/catalog/cloud-directory-discovery-service.test.ts
```

Expected: FAIL because the candidate module and `snapshotCached()` do not exist.

- [x] **Step 3: Implement candidate construction and ranking**

Export these interfaces:

```ts
export type CloudDirectoryCandidateSource = CloudDirectoryCandidate["source"];

export interface RankedCloudDirectoryCandidate {
  readonly candidate: CloudDirectoryCandidate;
  readonly sources: readonly CloudDirectoryCandidateSource[];
  readonly score: number;
  readonly selected: boolean;
}

export interface CloudDirectoryCandidateRuntime {
  snapshot(): readonly CloudDirectoryCandidate[];
  remember(path: string): Promise<void>;
  clearRecent(): Promise<void>;
}

export function buildLocalCloudDirectoryCandidates(input: Readonly<{
  recent: RecentCloudDirectoriesV1;
  cached: readonly CachedCloudDirectory[];
  groups: readonly Pick<HybridCatalogGroupViewModel, "groupKey" | "label">[];
}>): readonly CloudDirectoryCandidate[];

export function rankCloudDirectoryCandidates(input: Readonly<{
  candidates: readonly CloudDirectoryCandidate[];
  query: string;
  enabledSources: ReadonlySet<CloudDirectoryCandidateSource>;
  selectedPath: string | null;
}>): readonly RankedCloudDirectoryCandidate[];
```

Reuse an exported pure score function from `cloud-directory-search.ts`. Exact merge keys are normalized paths; hint keys are group keys; conflict wins for its path. Keep a fixed source order for deterministic labels and ties.

Extend `CloudDirectoryDiscoveryRuntime` with:

```ts
export interface CachedCloudDirectory {
  readonly fsId: string;
  readonly path: string;
  readonly filename: string;
}

snapshotCached(): readonly CachedCloudDirectory[];
```

Return a sorted structured clone and preserve `searchCached()`. Never persist this cache.

- [x] **Step 4: Rerun candidate and discovery tests**

```bash
npx vitest run tests/unit/catalog/cloud-directory-candidates.test.ts tests/unit/catalog/cloud-directory-search.test.ts tests/unit/catalog/cloud-directory-discovery-service.test.ts
```

Expected: PASS, including zero source calls for build, rank, filter, and snapshot operations.

- [x] **Step 5: Commit local candidate aggregation**

```bash
git add src/catalog/cloud-directory-candidates.ts src/catalog/cloud-directory-discovery-service.ts src/catalog/cloud-directory-search.ts tests/unit/catalog/cloud-directory-candidates.test.ts tests/unit/catalog/cloud-directory-discovery-service.test.ts tests/unit/catalog/cloud-directory-search.test.ts
git commit -m "feat(目录): 合并本地目录候选来源"
```

## Task 3: Add the bounded root-entry same-name locator

**Files:**
- Create: `src/catalog/cloud-directory-page-validator.ts`
- Create: `tests/unit/catalog/cloud-directory-page-validator.test.ts`
- Create: `src/catalog/cloud-directory-locator.ts`
- Create: `tests/unit/catalog/cloud-directory-locator.test.ts`
- Modify: `src/catalog/cloud-directory-discovery-service.ts`
- Modify: `tests/unit/catalog/cloud-directory-discovery-service.test.ts`

- [x] **Step 1: Write failing validator and locator tests**

Freeze and assert the budget:

```ts
expect(CLOUD_DIRECTORY_LOCATOR_BUDGET).toEqual({
  maxDirectoryCount: 500,
  maxListRequestCount: 50,
  maxDurationMs: 120_000,
});
expect(Object.isFrozen(CLOUD_DIRECTORY_LOCATOR_BUDGET)).toBe(true);
```

Using a synthetic source, cover blank-query refusal, BFS from `/`, no root result, local fuzzy matching, file exclusion, exact `beforeRequest()` counts including refresh replay, all three limits, page-atomic discard, cancellation before request and after response, every existing Baidu entry validation rule, path/fsId bijection, same-path/different-fsId conflict, retained committed matches on pause, and exact-once cancel/dispose.

- [x] **Step 2: Run locator tests and verify module failures**

```bash
npx vitest run tests/unit/catalog/cloud-directory-page-validator.test.ts tests/unit/catalog/cloud-directory-locator.test.ts tests/unit/catalog/cloud-directory-discovery-service.test.ts
```

Expected: FAIL because the validator and locator do not exist.

- [x] **Step 3: Extract validation without weakening scan-root policy**

Create:

```ts
export function validateBaiduListEntry(input: Readonly<{
  entry: unknown;
  currentPath: string;
  traversalRoot: string;
}>): BaiduListEntry;
```

Normalize current and traversal paths with `normalizeCloudAbsolutePath`, never `normalizeCatalogScanRoot`. Accept traversal membership only with:

```ts
const inTraversal = traversalRoot === "/"
  ? path !== "/"
  : path.startsWith(`${traversalRoot}/`);
```

Then require direct parent, NFC filename equal to tail, decimal `fsId`, safe non-negative timestamps/sizes, and zero directory size. Response failures become only `CatalogError("invalid-baidu-response")`. Keep `normalizeCatalogScanRoot` unchanged and keep discovery calling it before traversal.

- [x] **Step 4: Implement the locator state machine**

Create these contracts:

```ts
export const CLOUD_DIRECTORY_LOCATOR_BUDGET = Object.freeze({
  maxDirectoryCount: 500,
  maxListRequestCount: 50,
  maxDurationMs: 120_000,
} as const);

export type CloudDirectoryLocatorStopReason =
  | "complete"
  | "user-canceled"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

export interface CloudDirectoryLocatorSummary {
  readonly status: "complete" | "paused" | "canceled";
  readonly stopReason: CloudDirectoryLocatorStopReason;
  readonly query: string;
  readonly directoryCount: number;
  readonly matchCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
  readonly candidates: readonly CloudDirectoryCandidate[];
}

export interface CloudDirectoryLocatorRuntime {
  locateByName(name: string, signal?: AbortSignal): Promise<CloudDirectoryLocatorSummary>;
  cancel(): void;
  dispose(): void;
}
```

Use one internal AbortController per run and bridge the caller signal. Stage decoded entries, identity maps, queue changes, counts, matches, and conflicts in copies; publish only after a complete page validates and fits. Complete every page of a parent before visiting children. For a later different `fsId` at the same path, remove the exact match and pending traversal for that path and emit one disabled conflict. One `fsId` under different paths is invalid. Do not retry or resume automatically, and never expose raw response data.

- [x] **Step 5: Run locator and scan regressions**

```bash
npx vitest run tests/unit/catalog/cloud-directory-page-validator.test.ts tests/unit/catalog/cloud-directory-locator.test.ts tests/unit/catalog/cloud-directory-discovery-service.test.ts tests/integration/catalog-small-folder-preflight.test.ts tests/integration/catalog-scan.test.ts
```

Expected: PASS. Existing scans still reject `/`; only the synthetic locator lists it.

- [x] **Step 6: Commit the locator**

```bash
git add src/catalog/cloud-directory-page-validator.ts src/catalog/cloud-directory-locator.ts src/catalog/cloud-directory-discovery-service.ts tests/unit/catalog/cloud-directory-page-validator.test.ts tests/unit/catalog/cloud-directory-locator.test.ts tests/unit/catalog/cloud-directory-discovery-service.test.ts
git commit -m "feat(目录): 增加受限同名云端定位"
```

## Task 4: Wire persistence and locator through the normal runtime

**Files:**
- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `src/runtime/normal-cloud-catalog-composition.ts`
- Modify: `src/runtime/runtime-composition.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/plugin/knowledge-workbench-plugin.ts`
- Modify: `src/main.ts`
- Modify: `tests/unit/runtime/runtime-composition.test.ts`
- Modify: `tests/integration/catalog-offline-composition.test.ts`
- Modify: `tests/integration/read-only-acceptance-automated-safety.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/packaging/composition-roots.test.ts`

- [x] **Step 1: Write failing composition and controller tests**

Prove normal composition exposes one locator and discovery over the same fake source; cloud disposal disposes both once; credential replacement/revoke cancels lookup and clears only session cache; offline/disabled/acceptance expose neither locator nor picker factory; blank initial path opens; invalid nonblank path rejects; snapshots combine recent/cache/groups; remember uses `clock.now()` without journals or secrets; clear affects only recent; local selection never calls scan/verify/resume/OAuth/locator; and missing locator still leaves local candidates/manual entry.

- [x] **Step 2: Run focused tests and observe interface failures**

```bash
npx vitest run tests/unit/runtime/runtime-composition.test.ts tests/integration/catalog-offline-composition.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/ui/workbench-controller.test.ts tests/packaging/composition-roots.test.ts
```

Expected: FAIL because the runtime lacks a locator and picker opening still normalizes a mandatory root.

- [x] **Step 3: Add the locator to normal composition**

Extend `CloudCatalogRuntime` with `readonly directoryLocator?: CloudDirectoryLocatorRuntime`. Pass it separately to `CloudCatalogRuntimeService`, dispose it exactly once, and keep disabled constants without it. In normal composition, build both services from the same source:

```ts
const directoryDiscovery = new CloudDirectoryDiscoveryService(baiduSource, { now });
const directoryLocator = new CloudDirectoryLocatorService(baiduSource, { now });
```

Do not construct a second OAuth, credential, or Baidu source adapter. Change `RuntimeComposition.createCatalogDirectoryPicker` to accept only `app` and `getLocale`; request-scoped candidate and locator capabilities come from the controller. Keep `main-acceptance.ts` without the factory.

- [x] **Step 4: Implement the controller-owned candidate runtime**

Change the picker request to:

```ts
export interface CloudDirectoryPickerRequest {
  readonly initialPath: string | null;
  readonly candidates: CloudDirectoryCandidateRuntime;
  readonly locator?: CloudDirectoryLocatorRuntime;
}
```

Build one controller runtime:

```ts
private readonly cloudDirectoryCandidates: CloudDirectoryCandidateRuntime = {
  snapshot: () => buildLocalCloudDirectoryCandidates({
    recent: this.dependencies.store.settings().recentCloudDirectories,
    cached: this.dependencies.catalog.directoryDiscovery?.snapshotCached() ?? [],
    groups: this.dependencies.catalog.hybrid?.snapshot().active?.groups ?? [],
  }),
  remember: async (path) => {
    const settings = this.dependencies.store.settings();
    await this.dependencies.store.saveSettings({
      ...settings,
      recentCloudDirectories: rememberRecentCloudDirectory(
        settings.recentCloudDirectories,
        path,
        this.dependencies.clock.now(),
      ),
    });
  },
  clearRecent: async () => {
    const settings = this.dependencies.store.settings();
    await this.dependencies.store.saveSettings({
      ...settings,
      recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
    });
  },
};
```

If compiler initialization order rejects this field, assign the same frozen object once in the constructor. Do not move persistence into the modal.

Allow blank opening while retaining nonblank validation:

```ts
const trimmed = initialRoot.trim();
const initialPath = trimmed.length === 0
  ? null
  : this.validateCatalogScanRoot(trimmed);
return picker.request({
  initialPath,
  candidates: this.cloudDirectoryCandidates,
  ...(this.dependencies.catalog.directoryLocator === undefined
    ? {}
    : { locator: this.dependencies.catalog.directoryLocator }),
});
```

Before replacing or revoking credentials, call `directoryLocator?.cancel()` and `directoryDiscovery?.clear()`. Do not clear persisted recent history.

- [x] **Step 5: Rerun composition and controller tests**

```bash
npx vitest run tests/unit/runtime/runtime-composition.test.ts tests/integration/catalog-offline-composition.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/ui/workbench-controller.test.ts tests/packaging/composition-roots.test.ts
```

Expected: PASS. Acceptance source and runtime still have no picker or locator.

- [x] **Step 6: Commit runtime wiring**

```bash
git add src/catalog/cloud-catalog-runtime.ts src/runtime/normal-cloud-catalog-composition.ts src/runtime/runtime-composition.ts src/ui/workbench-controller.ts src/plugin/knowledge-workbench-plugin.ts src/main.ts tests/unit/runtime/runtime-composition.test.ts tests/integration/catalog-offline-composition.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/ui/workbench-controller.test.ts tests/packaging/composition-roots.test.ts
git commit -m "feat(目录): 接入智能选择器运行时"
```

## Task 5: Rebuild the modal around local-first candidates and explicit lookup

**Files:**
- Modify: `src/ui/cloud-directory-picker.ts`
- Modify: `tests/ui/cloud-directory-picker.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `styles.css`
- Modify: `src/main.ts`

- [x] **Step 1: Replace old modal tests with the approved contract**

Create fake candidate and locator runtimes with separate counters. Test blank opening/autofocus; zero-call local operations; merged source/path/status rendering; TXT/conflict nonselection even under synthetic clicks; same-name full paths; `aria-pressed` filters; listbox keyboard/`aria-selected`; two-step locator confirmation showing `/`, 500, 50, and 120 seconds; one confirmed call and signal; fixed partial/canceled/error messages; nonblocking recent-save notice; Escape/close/dispose cleanup; late-result guards; and 320-pixel long-path layout.

- [x] **Step 2: Run modal and locale tests**

```bash
npx vitest run tests/ui/cloud-directory-picker.test.ts tests/unit/i18n/workbench-i18n.test.ts
```

Expected: FAIL against the old root-scoped modal.

- [x] **Step 3: Implement local search, filtering, and exact-only selection**

Keep state explicit:

```ts
private query = "";
private readonly enabledSources = new Set<CloudDirectoryCandidateSource>([
  "recent",
  "session-cache",
  "txt-group",
  "cloud-locator",
]);
private locatedCandidates: readonly CloudDirectoryCandidate[] = [];
private selectedPath: string | null = null;
private activeExactIndex = -1;
private renderGeneration = 0;
```

Every local render reads `candidates.snapshot()`, appends detached located candidates, and calls `rankCloudDirectoryCandidates`. It never calls the locator. Render exact rows as selectable listbox options and hints/conflicts as explanatory non-options. Full paths must be visible text.

On use, re-run `normalizeCatalogScanRoot`, await `candidates.remember(path)`, catch to emit one fixed localized notice, then resolve the path. Never call locator, scan, verification, resume, OAuth, or connection here.

- [x] **Step 4: Implement two-step lookup and lifecycle guards**

The first action reveals query, `/`, and budget. Only final confirmation calls `locateByName(query, signal)`. Capture request generation and signal; before every merge, status, notice, or selection mutation, require open state, matching generation, and non-aborted signal. Append returned exact/conflict candidates only after resolution. Paused summaries keep committed matches and state the limit.

On close, Escape, cancel, dispose, or new generation: abort, clear input values and located results, remove DOM, detach signal listeners, resolve once, and restore opener focus with `preventScroll`.

- [x] **Step 5: Add complete bilingual strings and styles**

Add keys for filters/sources, selection/path state, TXT hint, conflict, clear recent, persistence warning, lookup action/confirmation/budget/progress/limits/unavailable/error, and ARIA labels. Extend parity tests to require identical interpolation names.

Use Obsidian tokens for two-line results, source chips, selected outline, conflict explanation, responsive actions, and `overflow-wrap: anywhere`. Preserve standalone `:focus-visible` coverage.

- [x] **Step 6: Rerun modal, locale, and localization packaging tests**

```bash
npx vitest run tests/ui/cloud-directory-picker.test.ts tests/unit/i18n/workbench-i18n.test.ts tests/packaging/ui-localization-boundary.test.ts
```

Expected: PASS with no real cloud path or credential in test source.

- [ ] **Step 7: Commit the modal**

```bash
git add src/ui/cloud-directory-picker.ts src/i18n/workbench-i18n.ts styles.css src/main.ts tests/ui/cloud-directory-picker.test.ts tests/unit/i18n/workbench-i18n.test.ts tests/packaging/ui-localization-boundary.test.ts
git commit -m "feat(目录): 重做本地优先选择交互"
```

## Task 6: Unify scan and verification hosts with a current-directory card

**Files:**
- Create: `src/ui/cloud-directory-field.ts`
- Create: `tests/ui/cloud-directory-field.test.ts`
- Modify: `src/ui/settings-sections.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `src/ui/verification-page.ts`
- Modify: `tests/ui/verification-page.test.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `styles.css`
- Modify: `src/i18n/workbench-i18n.ts`

- [ ] **Step 1: Write failing shared-field and host tests**

Across settings scan, settings category verification, and workbench verification, test empty/current cards, empty-path selection, fill-only behavior, valid-root start gating, no automatic start/resume/locator, closed advanced manual entry, local validation, root refusal, busy/locked disabling, cancel preserving prior draft, language rerender preserving path/groups, and narrow long-path wrapping.

- [ ] **Step 2: Run shared-field and host tests**

```bash
npx vitest run tests/ui/cloud-directory-field.test.ts tests/ui/settings-sections.test.ts tests/ui/verification-page.test.ts tests/ui/workbench-view.test.ts
```

Expected: FAIL because manual input remains primary.

- [ ] **Step 3: Implement the shared field**

Create this pure DOM interface:

```ts
export interface CloudDirectoryFieldModel {
  readonly path: string;
  readonly disabled: boolean;
  readonly locked: boolean;
}

export interface CloudDirectoryFieldActions {
  readonly onChoose: () => Promise<string | null>;
  readonly onManualChange: (value: string) => void;
  readonly onValidate: (value: string) => string;
}

export interface CloudDirectoryFieldSurface {
  readonly root: HTMLElement;
  readonly manualInput: HTMLInputElement;
  readonly chooseButton: HTMLButtonElement;
  readonly valid: () => boolean;
  setPath(path: string): void;
  dispose(): void;
}

export function createCloudDirectoryField(
  document: Document,
  i18n: WorkbenchI18n,
  model: CloudDirectoryFieldModel,
  actions: CloudDirectoryFieldActions,
): CloudDirectoryFieldSurface;
```

The helper owns DOM and one local draft only. Render current card, primary choose button, and closed advanced `<details>` with manual input and local validation. `valid()` calls the supplied validator and returns false for blank, `/`, and malformed paths. Do not import catalog runtime, store, secrets, or Baidu ports.

- [ ] **Step 4: Replace settings and verification root controls**

In settings, replace both visible path labels with shared fields while preserving session draft members. Recompute start disabled state after selection, manual input, connection, group selection, and busy changes.

In verification page, preserve `rootLocked`, route selection only through `onRootChange`, and retain the selected-category-is-root guard. In workbench view, keep browse as a path-returning action with no automatic start.

- [ ] **Step 5: Add translations and responsive card CSS**

Add current directory, empty, selected-session, choose, advanced manual entry, invalid path, and local recent-storage disclosure in both languages. Ensure name/path wrap and actions remain reachable.

- [ ] **Step 6: Rerun UI and safety tests**

```bash
npx vitest run tests/ui/cloud-directory-field.test.ts tests/ui/settings-sections.test.ts tests/ui/verification-page.test.ts tests/ui/workbench-view.test.ts tests/ui/workbench-controller.test.ts tests/ui/read-only-acceptance-surfaces.test.ts
```

Expected: PASS. Picker selection increments no scan, verification, resume, OAuth, or locator counter.

- [ ] **Step 7: Commit the unified host UI**

```bash
git add src/ui/cloud-directory-field.ts src/ui/settings-sections.ts src/ui/verification-page.ts src/ui/workbench-view.ts src/i18n/workbench-i18n.ts styles.css tests/ui/cloud-directory-field.test.ts tests/ui/settings-sections.test.ts tests/ui/verification-page.test.ts tests/ui/workbench-view.test.ts tests/ui/workbench-controller.test.ts tests/ui/read-only-acceptance-surfaces.test.ts
git commit -m "feat(目录): 统一云端目录选择界面"
```

## Task 7: Close packaging, documentation, versioning, and release gates

**Files:**
- Modify: `tests/packaging/composition-roots.test.ts`
- Modify: `tests/packaging/read-only-acceptance-build.test.ts`
- Modify: `tests/packaging/ui-localization-boundary.test.ts`
- Modify: `tests/integration/catalog-offline-composition.test.ts`
- Modify: `README.md`
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `versions.json`

- [ ] **Step 1: Add final packaging and isolation assertions**

Prove normal imports one locator; acceptance source/bundle contains no picker, locator, locator budget/action labels, OAuth URL, SecretStorage, `requestUrl`, source adapter, or list endpoint; disabled/offline expose no locator; scan/large verification still reject `/`; only the explicit synthetic locator test lists root; and both language dictionaries remain complete.

- [ ] **Step 2: Run packaging tests**

```bash
npx vitest run tests/packaging/composition-roots.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/ui-localization-boundary.test.ts tests/integration/catalog-offline-composition.test.ts
```

Expected: PASS. If a bundle assertion fails, fix the build graph; never weaken the assertion or add string-replacement hacks.

- [ ] **Step 3: Update docs and release metadata**

README must state: scans and category verification reject `/`; only explicit same-name lookup reads root metadata; lookup is read-only and capped at 500 directories, 50 requests, or 120 seconds; PDFs are not shown/downloaded; up to 10 exact recent paths live in ordinary local settings and can be cleared; TXT names are unverified hints.

Bump `package.json`, `package-lock.json`, and `manifest.json` to `0.1.1`. Add `"0.1.1": "1.12.7"` to `versions.json` while retaining `0.1.0`.

- [ ] **Step 4: Run focused tests, lint, and both builds**

```bash
npx vitest run tests/unit/storage/recent-cloud-directories.test.ts tests/unit/catalog/cloud-directory-candidates.test.ts tests/unit/catalog/cloud-directory-page-validator.test.ts tests/unit/catalog/cloud-directory-locator.test.ts tests/ui/cloud-directory-picker.test.ts tests/ui/cloud-directory-field.test.ts tests/ui/settings-sections.test.ts tests/ui/verification-page.test.ts tests/ui/workbench-controller.test.ts tests/integration/catalog-offline-composition.test.ts tests/packaging/composition-roots.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/ui-localization-boundary.test.ts
npm run lint
npm run build
npm run build:acceptance
```

Expected: all PASS with no Baidu contact.

- [ ] **Step 5: Run complete serial and performance gates**

```bash
npx vitest run --no-file-parallelism --maxWorkers=1
npm run test:catalog-performance
npm run test:performance
```

Expected: all existing measured thresholds PASS. Record only executed results.

- [ ] **Step 6: Install only into the repository synthetic Vault**

```bash
npm run install:dev
```

Expected: the developer installer accepts only the repository `.dev-vault` target and installs normal `main.js`, `manifest.json`, and `styles.css`. Do not enable a real Vault or perform OAuth/cloud lookup.

Manual synthetic checks:

1. Open settings and workbench verification with an empty path.
2. Confirm local picker query/filter works without network.
3. Confirm TXT hints are nonselectable and duplicate names show parent paths.
4. Confirm locator disclosure shows `/`, 500, 50, and 120 seconds; cancel without starting.
5. Select a synthetic recent path and confirm only the current card changes.
6. Confirm scan and verification remain separate actions.
7. Switch languages and preserve path draft and selected groups.
8. Verify keyboard focus, Escape restoration, and long-path wrapping.

- [ ] **Step 7: Inspect final diff and commit release closure**

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
```

Confirm the 11 unrelated research files remain untracked and unstaged. Then:

```bash
git add README.md manifest.json package.json package-lock.json versions.json tests/packaging/composition-roots.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/ui-localization-boundary.test.ts tests/integration/catalog-offline-composition.test.ts
git commit -m "docs(目录): 收口智能选择器发布说明"
```

## Final acceptance checklist

- [ ] Empty path opens the picker.
- [ ] Local open/search/filter/select paths make zero Baidu requests.
- [ ] Recent paths persist as a bounded ordinary setting and clear independently.
- [ ] TXT group names remain visibly unverified and nonselectable.
- [ ] Same-name directories show parent paths; same-path identity conflicts are disabled.
- [ ] Root traversal occurs only after two explicit actions and respects 500/50/120 limits.
- [ ] `/` never becomes a candidate, recent path, scan root, or verification root.
- [ ] Selection does not start scan, verification, resume, OAuth, or cloud writes.
- [ ] Cancel, revoke, dispose, and late results cannot mutate stale UI or persistence.
- [ ] Chinese/English, keyboard, focus, ARIA, narrow layout, and long paths pass.
- [ ] Acceptance/offline/disabled compositions contain no locator capability.
- [ ] Full serial, lint, normal build, acceptance build, and both performance gates pass.
- [ ] Synthetic install succeeds; no real OAuth, Baidu listing, PDF download, or real Vault write occurs.
