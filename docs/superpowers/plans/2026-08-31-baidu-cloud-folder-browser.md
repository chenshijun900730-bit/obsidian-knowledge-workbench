# Knowledge Workbench Baidu Cloud Folder Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first, one-level-at-a-time Baidu Netdisk folder browser that selects either a non-root parent folder or one uniquely matched catalog category without downloading PDFs, recursively scanning the tree, or starting verification.

**Architecture:** Add one normal-build-only `CloudDirectoryBrowserService` over the existing shared `BaiduCatalogSourcePort`. The service owns session-only root consent, page-atomic layer caches, fixed 20,000-entry rounds, exact cursors, and progress notifications. Keep category matching pure, render large layers through a bounded-DOM list, and return a structured selection so hosts can distinguish the chosen category from the effective verification parent.

**Tech Stack:** TypeScript 5.8, Vitest 4, jsdom, Obsidian 1.13 APIs, existing Baidu OAuth/list adapter, CSS with Obsidian theme variables, esbuild.

---

## Scope and safety invariants

- The business-code baseline is commit `8711913` on branch `codex/verification-progress-auto-resume`; implementation starts from the later documentation-only commit containing this approved plan.
- Treat `docs/superpowers/specs/2026-08-31-baidu-cloud-folder-browser-design.md` as the approved product contract.
- Do not stage, modify, rename, or delete the 11 unrelated untracked research Markdown files at the repository root.
- Do not use PMH, read another experiment task, run PMH benchmarks, or create experiment snapshots.
- Automated tests use only synthetic paths, entries, clocks, identities, groups, credentials, and DOM fixtures.
- Do not perform real OAuth, real Baidu requests, PDF downloads, real TXT imports, real Vault writes, plugin installation, push, PR, or merge while executing this plan. Each later real-world action needs its own explicit gate.
- Picker open/search/local-candidate/cache reads issue zero Baidu requests. Root browsing requires one in-memory confirmation per plugin session. Non-root browsing starts only from an explicit user action.
- One browse round checks at most 20,000 response entries, starts at most 20 request permits, runs at most 120 seconds between checks, and always calls the source with `limit: 1000`.
- Browsing is one-level only. Files are validated and counted, then discarded; only direct child folders enter session memory or UI.
- `/` is an internal browse entry and can never be selected, remembered, persisted, scanned, or verified.
- A category selection returns its parent as `effectiveRoot`, exactly one matching `groupKey`, and never lists that category's contents.
- Folder selection changes draft state only. Existing scan and verification confirmations remain independent.
- Acceptance, disabled, and offline compositions must not expose or bundle the browser, picker, OAuth, SecretStorage, or Baidu list capability.

## File map

| File | Responsibility |
| --- | --- |
| `src/catalog/cloud-directory-selection.ts` | Picker purpose/result types and fail-closed category resolution |
| `src/catalog/cloud-directory-browser.ts` | Root consent, one-layer pagination, budgets, cache, progress, cancellation, disposal |
| `src/catalog/cloud-catalog-runtime.ts` | Optional normal-only browser capability and lifecycle |
| `src/runtime/normal-cloud-catalog-composition.ts` | Compose one browser over the existing shared Baidu source |
| `src/ui/windowed-list.ts` | Reusable bounded-DOM renderer |
| `src/ui/cloud-directory-browser-view.ts` | Breadcrumb, rows, progress, details, and explicit actions |
| `src/ui/cloud-directory-picker.ts` | Local-first/browser/locator state machine and structured result |
| `src/ui/cloud-directory-field.ts` | Display chosen folder versus effective root |
| `src/ui/workbench-controller.ts` | Construct picker purpose and apply structured selection |
| `src/ui/verification-page.ts`, `src/ui/workbench-view.ts` | Hold session-only selection and selected verification groups |
| `src/ui/settings-sections.ts` | Scan and verification picker integration |
| `src/ui/catalog-large-scan-confirmation-modal.ts` | Final verification summary and invariant checks |
| `src/i18n/workbench-directory-picker-i18n.ts`, `src/i18n/workbench-i18n.ts` | Chinese/English browser and selection copy |
| `styles.css` | Browser layout, fixed-height rows, progress, focus, responsive behavior |
| `tests/**` | Synthetic unit, UI, integration, packaging, and performance evidence |
| `README.md`, `docs/runbooks/baidu-cloud-catalog-small-folder.md` | User flow and later real-acceptance gate |
| `manifest.json`, `package.json`, `package-lock.json`, `versions.json` | Version `0.1.2` only after all automated gates pass |

## Task 1: Define structured parent/category selection semantics

**Files:**
- Create: `src/catalog/cloud-directory-selection.ts`
- Create: `tests/unit/catalog/cloud-directory-selection.test.ts`

- [ ] **Step 1: Write the failing selection-contract tests**

Create `tests/unit/catalog/cloud-directory-selection.test.ts`. Cover these exact cases with synthetic `group:${"a".repeat(64)}` keys:

```ts
expect(resolveCloudDirectorySelection({
  selectionKind: "directory",
  purpose: { kind: "scan" },
  currentPath: "/科学文库",
  selectedPath: "/科学文库/资料",
})).toEqual({
  kind: "directory",
  selectedPath: "/科学文库/资料",
  effectiveRoot: "/科学文库/资料",
});

expect(resolveCloudDirectorySelection({
  selectionKind: "category",
  purpose: {
    kind: "verification",
    groups: [{
      groupKey: GROUP_A,
      rootRelativePath: "6-经济类",
      label: "6-经济类",
    }],
  },
  currentPath: "/科学文库",
  selectedPath: "/科学文库/6-经济类",
})).toEqual({
  kind: "category",
  selectedPath: "/科学文库/6-经济类",
  effectiveRoot: "/科学文库",
  groupKey: GROUP_A,
});
```

Also assert: scan purpose cannot resolve `category`; `/` is rejected for either output path; category must be a direct child; zero or two group matches throw `cloud-directory-category-ambiguous`; `txt-root-items`, malformed keys, control characters, decomposed paths, and parent escape are rejected; returned purpose/selection objects are detached; no `fsId` appears in the result.

- [ ] **Step 2: Run the focused test and record the expected red state**

```bash
npx vitest run tests/unit/catalog/cloud-directory-selection.test.ts
```

Expected: FAIL because `cloud-directory-selection.ts` does not exist.

- [ ] **Step 3: Implement the pure contract**

Export these exact public types and functions:

```ts
export type CloudDirectoryPickerPurpose =
  | Readonly<{ kind: "scan" }>
  | Readonly<{
      kind: "verification";
      groups: readonly Readonly<{
        groupKey: string;
        rootRelativePath: string;
        label: string;
      }>[];
    }>;

export type CloudDirectorySelection =
  | Readonly<{
      kind: "directory";
      selectedPath: string;
      effectiveRoot: string;
    }>
  | Readonly<{
      kind: "category";
      selectedPath: string;
      effectiveRoot: string;
      groupKey: string;
    }>;

export function resolveCloudDirectorySelection(input: Readonly<{
  selectionKind: "directory" | "category";
  purpose: CloudDirectoryPickerPurpose;
  currentPath: string;
  selectedPath: string;
}>): CloudDirectorySelection;

export function validateCloudDirectorySelection(
  selection: CloudDirectorySelection,
  purpose: CloudDirectoryPickerPurpose,
): CloudDirectorySelection;
```

Normalize `currentPath` with `normalizeCloudAbsolutePath`, because `/` is a valid internal browse parent. Normalize every returned `selectedPath` and `effectiveRoot` with `normalizeCatalogScanRoot`, so neither can be `/`. For category resolution, require a non-root current parent, join each normalized `rootRelativePath` to it, require an exact direct-child path and exactly one non-`txt-root-items` group match, then return a detached object. Do not export mutable group collections.

- [ ] **Step 4: Verify and commit Task 1**

```bash
npx vitest run tests/unit/catalog/cloud-directory-selection.test.ts
git add src/catalog/cloud-directory-selection.ts tests/unit/catalog/cloud-directory-selection.test.ts
git commit -m "feat(目录): 定义云端目录选择语义"
git status --short
```

Expected: tests PASS; after commit only the 11 pre-existing untracked research files remain.

## Task 2: Implement the one-level browser and fixed round budgets

**Files:**
- Create: `src/catalog/cloud-directory-browser.ts`
- Create: `tests/unit/catalog/cloud-directory-browser.test.ts`
- Reuse unchanged: `src/catalog/cloud-directory-page-validator.ts`
- Reuse unchanged: `src/catalog/catalog-ports.ts`

- [ ] **Step 1: Write failing tests for consent, paging, file discard, and progress**

Create `tests/unit/catalog/cloud-directory-browser.test.ts` with a source fake that records every `{path,start,limit}` and invokes `beforeRequest()` once. Assert:

```ts
expect(CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET).toEqual({
  maxEntryCount: 20_000,
  maxListRequestCount: 20,
  maxDurationMs: 120_000,
});
expect(Object.isFrozen(CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET)).toBe(true);

await expect(browser.loadLayer({ path: "/", start: 0 }))
  .rejects.toThrow("cloud-directory-root-consent-required");
browser.grantRootAccess();
await browser.loadLayer({ path: "/", start: 0 });

expect(calls.every((call) => call.limit === 1000)).toBe(true);
expect(calls.map((call) => call.path)).toEqual(["/", "/"]);
expect(calls).toHaveLength(2);
```

Use one full 1,000-entry page followed by a short page. Verify only direct child directories enter the snapshot; files are absent; no child path is requested; a short page sets `complete=true` and `nextStart=null`; a full page keeps `nextStart=1000`. Subscribe before loading and assert one notification after every page commit plus the final stop transition. Confirm `snapshot()` returns detached arrays.

Add a 20-full-page case and assert exactly 20 calls, 20,000 checked entries, `status="paused"`, `stopReason="entry-limit"`, and `nextStart=20_000`; no 21st request starts.

- [ ] **Step 2: Run the focused test and record the expected red state**

```bash
npx vitest run tests/unit/catalog/cloud-directory-browser.test.ts
```

Expected: FAIL because the browser module does not exist.

- [ ] **Step 3: Implement the public runtime and immutable snapshots**

Export the frozen budget and these public contracts:

```ts
export const CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET = Object.freeze({
  maxEntryCount: 20_000,
  maxListRequestCount: 20,
  maxDurationMs: 120_000,
} as const);

export interface CloudDirectoryBrowserRuntime {
  rootAccessGranted(): boolean;
  grantRootAccess(): void;
  loadLayer(
    input: Readonly<{ path: string; start: number }>,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryBrowseRound>;
  snapshot(path: string): CloudDirectoryLayerSnapshot | null;
  subscribe(listener: (path: string) => void): () => void;
  clear(): void;
  dispose(): void;
}
```

`CloudDirectoryLayerSnapshot` contains normalized `path`, detached directory identities (`fsId`, `path`, `filename`), `nextStart`, `complete`, cumulative checked entries, cumulative request permits, and last stop reason. `CloudDirectoryBrowseRound` uses `checkedEntryCount` and `listRequestCount` for this round, `cumulativeCheckedEntryCount` and `cumulativeListRequestCount` for the layer session totals, plus cursor, directory count, elapsed milliseconds, status, and stop reason.

Implement `CloudDirectoryBrowserService(source, { now = Date.now } = {})`. Permit `/` only inside this service and only after `grantRootAccess()`. Normalize non-root paths with `normalizeCloudAbsolutePath`. Reject starts that are negative, unsafe, not divisible by 1000, or different from the cached `nextStart`. Never schedule child paths.

- [ ] **Step 4: Implement the round loop with page-sized commits**

For every page:

1. Check abort, duration, 20,000-entry, and 20-permit budgets.
2. Call `source.listDirectory({path,start,limit:1000,beforeRequest})`.
3. Increment the round and cumulative request permit counts inside `beforeRequest`, including failed or token-refresh replay permits.
4. Require an array of at most 1,000 entries and validate every entry with `validateBaiduListEntry({currentPath:path,traversalRoot:path})`.
5. Store only directories and discard validated files.
6. Advance by exactly 1,000 only after committing a full page; mark complete after a short page.
7. Emit after the page commit and again when the round reaches a terminal status.

Progress is `CloudDirectoryBrowseRound.checkedEntryCount / 20_000`; do not infer whole-folder or whole-netdisk percentage.

- [ ] **Step 5: Verify and commit Task 2**

```bash
npx vitest run tests/unit/catalog/cloud-directory-browser.test.ts
git add src/catalog/cloud-directory-browser.ts tests/unit/catalog/cloud-directory-browser.test.ts
git commit -m "feat(目录): 实现单层云端目录浏览"
git status --short
```

Expected: consent, one-level paging, fixed limits, file discard, progress emission, short-page completion, and 20-page pause tests PASS.

## Task 3: Make page recovery, identity, cancellation, and lifecycle fail closed

**Files:**
- Modify: `src/catalog/cloud-directory-browser.ts`
- Modify: `tests/unit/catalog/cloud-directory-browser.test.ts`

- [ ] **Step 1: Add failing atomicity and lifecycle tests**

Add tests for all of the following:

- `beforeRequest()` invoked twice for one adapter call counts two permits but commits the returned page once.
- A failed request increases cumulative permits but leaves `checkedEntryCount` and `nextStart` unchanged.
- Duplicate path/different `fsId`, duplicate `fsId`/different path, malformed direct parent, and invalid 1,001-entry pages reject the entire page.
- After an invalid page, snapshot directories, checked count, and cursor are unchanged; retry begins at the same cursor.
- Cancel while awaiting a delayed response discards that response, makes no next request, preserves earlier complete pages, and reports `user-canceled`.
- A synthetic clock crossing 120,000 ms after response validation discards the uncommitted page and reports `time-limit`.
- Two simultaneous loads for the same service are rejected with `cloud-directory-browser-busy`.
- `clear()` aborts work and resets layer caches plus root consent; `dispose()` is idempotent, aborts work, clears listeners, and makes every public method except repeated `dispose()` throw `cloud-directory-browser-unavailable`.

Use this exact permit assertion:

```ts
const summary = await browser.loadLayer({ path: "/科学文库", start: 0 });
expect(summary.listRequestCount).toBe(2);
expect(summary.cumulativeListRequestCount).toBe(2);
expect(browser.snapshot("/科学文库")?.directories).toHaveLength(1);
```

- [ ] **Step 2: Run the focused test and confirm the new cases fail**

```bash
npx vitest run tests/unit/catalog/cloud-directory-browser.test.ts
```

Expected: FAIL on atomic identity, late-response cancellation, and lifecycle cases while Task 2 cases remain green.

- [ ] **Step 3: Separate request accounting from atomic page mutation**

Keep `cumulativeListRequestCount` in the layer state. Each `beforeRequest` first rejects when the signal, time limit, or `roundRequests >= 20` would forbid another request; otherwise it increments both `roundRequests` and the cumulative counter immediately before granting the permit. Do not include granted-request accounting in the page transaction: a network or validation failure retains the consumed permit while leaving the page cursor and entries unchanged. A rejected 21st permit is not counted because no request may start.

Implement page commit by cloning both persisted directory identity maps (`path -> fsId`, `fsId -> path`) and the layer directory map. Seed page-local identity maps from those clones, validate every returned entry against the page-local maps, and mutate service state only after the whole page succeeds. Merge only directory identities into persistent maps; file identities exist only during page validation and are then discarded. This detects file/directory conflicts against cached folders and all conflicts within the page without retaining file paths or `fsId` values.

- [ ] **Step 4: Add operation generation and linked cancellation**

Each `loadLayer` gets one internal `AbortController` and generation. Recheck generation/signal after awaiting the source and before page commit. `clear`, `dispose`, or external abort invalidates the generation. Stop summaries use fixed reason codes and never include raw response bodies, token text, stack traces, or credentials.

- [ ] **Step 5: Verify and commit Task 3**

```bash
npx vitest run tests/unit/catalog/cloud-directory-browser.test.ts
git add src/catalog/cloud-directory-browser.ts tests/unit/catalog/cloud-directory-browser.test.ts
git commit -m "fix(目录): 保证浏览分页原子恢复"
git status --short
```

Expected: all browser tests PASS, including exact cursor retry, consumed failed permits, session identity conflicts, cancellation, time limit, clear, and dispose.

## Task 4: Expose the browser only through the normal runtime

**Files:**
- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `src/runtime/normal-cloud-catalog-composition.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `tests/fakes/fake-cloud-catalog-runtime.ts`
- Modify: `tests/unit/runtime/runtime-composition.test.ts`
- Modify: `tests/integration/catalog-hybrid-composition.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`

- [ ] **Step 1: Write failing runtime-composition tests**

Assert the following exact runtime properties:

```ts
expect(runtime.directoryBrowser).toBe(browser);
expect(runtime.directoryBrowser?.rootAccessGranted()).toBe(false);
expect(runtime.directoryBrowser?.snapshot("/")).toBeNull();
```

In the normal-composition integration test, initialize and import the synthetic TXT catalog, then assert the host request mock is still `0`. Read `src/runtime/normal-cloud-catalog-composition.ts` as text and assert one `new BaiduCatalogSourceAdapter`, one `new CloudDirectoryBrowserService(baiduSource`, one discovery, and one locator. Add disposal-order expectations: locator, browser, discovery, hybrid, connection.

Add controller tests proving both credential removal and OAuth revoke cancel the locator, clear discovery, and clear browser session consent/cache.

- [ ] **Step 2: Run the focused runtime tests and confirm they fail**

```bash
npx vitest run \
  tests/unit/runtime/runtime-composition.test.ts \
  tests/integration/catalog-hybrid-composition.test.ts \
  tests/ui/workbench-controller.test.ts
```

Expected: FAIL because `CloudCatalogRuntime` has no `directoryBrowser` capability.

- [ ] **Step 3: Wire one shared browser into the normal graph**

Add this optional property to `CloudCatalogRuntime` and `CloudCatalogRuntimeService`:

```ts
readonly directoryBrowser?: CloudDirectoryBrowserRuntime;
```

Use constructor order `directoryDiscovery, directoryBrowser, directoryLocator` consistently in production and fakes. In the normal composition create exactly one:

```ts
const directoryBrowser = new CloudDirectoryBrowserService(baiduSource, { now });
```

Pass the same `baiduSource` instance used by scanner, discovery, locator, and verification. Dispose in the order locator, browser, discovery, hybrid, connection so no UI operation can survive the browser. Keep offline, disabled, and acceptance constructors unchanged so the optional property remains absent.

- [ ] **Step 4: Clear browser state at identity boundaries**

In controller paths that remove credentials or revoke OAuth, cancel locator first, clear discovery second, clear browser third, then mutate the connection. Do not clear browser state when a picker Modal merely closes; its layer cache and root consent are plugin-session state.

- [ ] **Step 5: Verify and commit Task 4**

```bash
npx vitest run \
  tests/unit/runtime/runtime-composition.test.ts \
  tests/integration/catalog-hybrid-composition.test.ts \
  tests/ui/workbench-controller.test.ts
git add \
  src/catalog/cloud-catalog-runtime.ts \
  src/runtime/normal-cloud-catalog-composition.ts \
  src/ui/workbench-controller.ts \
  tests/fakes/fake-cloud-catalog-runtime.ts \
  tests/unit/runtime/runtime-composition.test.ts \
  tests/integration/catalog-hybrid-composition.test.ts \
  tests/ui/workbench-controller.test.ts
git commit -m "feat(运行时): 注入云端目录浏览能力"
git status --short
```

Expected: focused tests PASS and normal initialization still issues zero list requests.

## Task 5: Extract a reusable bounded-DOM list

**Files:**
- Create: `src/ui/windowed-list.ts`
- Create: `tests/ui/windowed-list.test.ts`
- Modify: `src/ui/map-pane.ts`
- Verify: `tests/ui/workbench-view.test.ts`

- [ ] **Step 1: Write failing tests for bounds, reachability, updates, and disposal**

Create a jsdom test with 20,000 strings and this public surface:

```ts
const surface = createWindowedList(document, {
  rows: values,
  rowHeight: 44,
  windowSize: 100,
  overscan: 10,
  renderRow: (value) => {
    const row = document.createElement("li");
    row.textContent = value;
    return row;
  },
});
```

Assert `surface.element.dataset.totalRows === "20000"`, no more than 102 `li` nodes exist at once, scrolling to `44 * 20_000` renders `Folder 19999`, `surface.update(["A","B"])` replaces the data, and `dispose()` removes the scroll listener and is idempotent.

- [ ] **Step 2: Run the focused test and record the expected red state**

```bash
npx vitest run tests/ui/windowed-list.test.ts
```

Expected: FAIL because `src/ui/windowed-list.ts` does not exist.

- [ ] **Step 3: Implement a typed reusable renderer**

Export:

```ts
export interface WindowedListSurface<T> {
  readonly element: HTMLUListElement;
  update(rows: readonly T[]): void;
  dispose(): void;
}

export function createWindowedList<T>(
  document: Document,
  options: Readonly<{
    rows: readonly T[];
    rowHeight: number;
    windowSize: number;
    overscan: number;
    renderRow: (row: T, index: number) => HTMLLIElement;
  }>,
): WindowedListSurface<T>;
```

Copy the rows array once per `update`, render top/bottom spacers plus at most `windowSize + 2` content rows, clamp scroll-derived indices, and abort the listener from `dispose()`. Reject non-positive row height/window size and negative overscan.

- [ ] **Step 4: Replace the private map helper without changing behavior**

Remove the private `windowedList` implementation from `src/ui/map-pane.ts`. Call `createWindowedList` with its existing 36 px row height, 100-row window, and 10-row overscan. Keep existing row markup, click handlers, ARIA, sorting, and visible content unchanged. The map pane returns `surface.element`; replacing the pane releases that element and its listener together. The long-lived folder browser retains its surface and calls `dispose()` explicitly before replacement or close.

- [ ] **Step 5: Verify and commit Task 5**

```bash
npx vitest run tests/ui/windowed-list.test.ts tests/ui/workbench-view.test.ts
git add src/ui/windowed-list.ts src/ui/map-pane.ts tests/ui/windowed-list.test.ts
git commit -m "refactor(界面): 提取有界列表渲染"
git status --short
```

Expected: new 20,000-row bounds tests and the existing map scroll-to-final-result regression PASS.

## Task 6: Add the hierarchical browser view and picker state machine

**Files:**
- Create: `src/ui/cloud-directory-browser-view.ts`
- Create: `tests/ui/cloud-directory-browser-view.test.ts`
- Modify: `src/ui/cloud-directory-picker.ts`
- Modify: `tests/ui/cloud-directory-picker.test.ts`
- Modify: `src/i18n/workbench-directory-picker-i18n.ts`
- Modify: `tests/unit/i18n/workbench-directory-picker-i18n.test.ts`

- [ ] **Step 1: Write browser-view tests before implementation**

In jsdom, render root, complete non-root, partial, running, empty, canceled, conflict, and fixed-error states. Assert:

- `/` has no enabled “select current folder” action.
- Folder-name/arrow emits `enter(path)` while the separate row selector emits `highlight(path)`.
- A uniquely matched category row exposes a category action; activating it emits selection without an `enter` event.
- Breadcrumbs emit only paths present in the supplied ancestor list.
- Partial layers show “continue current layer”, checked entries, found folders, exact cursor, per-round requests, cumulative requests, elapsed time, completeness, and stop reason.
- A 20,000-folder snapshot uses the shared list and retains at most 102 content rows.
- Progress has `max=20000`, uses current-round checked entries, and changes to complete state after a short page without fabricating 100%.
- Dispose removes row, scroll, breadcrumb, continue, cancel, and subscribe handlers.

- [ ] **Step 2: Implement the view as a network-free rendering surface**

Export one state object and one actions object; the view must not import `BaiduCatalogSourcePort`, OAuth, settings, or controller types. It receives an already detached layer snapshot plus `CloudDirectoryPickerPurpose`, derives category badges through Task 1, and emits only explicit UI intentions. Use `createWindowedList` with 44 px rows, 100-row window, and 10-row overscan.

- [ ] **Step 3: Convert picker request/result types and write state-machine tests**

Change the public picker contract to:

```ts
export interface CloudDirectoryPickerRequest {
  readonly initialPath: string | null;
  readonly purpose: CloudDirectoryPickerPurpose;
  readonly candidates: CloudDirectoryCandidateRuntime;
  readonly browser?: CloudDirectoryBrowserRuntime;
  readonly locator?: CloudDirectoryLocatorRuntime;
}

export interface CloudDirectoryPickerPresenter {
  request(input: CloudDirectoryPickerRequest): Promise<CloudDirectorySelection | null>;
}
```

Update picker tests to prove:

1. opening, typing, filtering, selecting a local exact candidate, and showing a cached layer cause zero browser loads;
2. the first root action opens a disclosure and cancellation preserves local state with zero loads;
3. accepting root disclosure calls `grantRootAccess()` then loads `/`; a second new Modal over the same runtime skips the disclosure;
4. entering a non-root recent path loads only that path and requires no root grant;
5. each enter/continue/retry owns one generation; repeated clicks cannot overlap; close/Escape aborts; late notifications and results are ignored;
6. category selection resolves without loading the category path;
7. parent selection returns a directory result; `/` cannot settle even through a forged click;
8. advanced same-name locator remains a separate explicit confirmation/action and never starts from browser search;
9. the opener regains focus and the Promise settles once.

- [ ] **Step 4: Implement the picker orchestration**

Keep initial phase local. Subscribe to the shared browser only while the Modal is open. On explicit entry, use `snapshot(path)` first; if absent, call `loadLayer({path,start:0})`. “Continue current layer” uses that snapshot's exact `nextStart`. Root disclosure state comes exclusively from `browser.rootAccessGranted()` so it survives Modal recreation but resets on browser clear/dispose.

Keep manual entry and local fuzzy search in the existing advanced/local area. Never call `loadLayer` from query events, candidate ranking, render, lifecycle open, or subscription callbacks. A subscription callback only reads `snapshot(currentPath)` and rerenders.

- [ ] **Step 5: Add complete Chinese/English copy and fixed error mapping**

Add matching keys for: recent view, browse-root disclosure, breadcrumb root, current path, enter, highlight, select folder, select category, actual verification parent, loading, complete, incomplete, empty, continue, retry, cancel, checked/found progress, request/cursor/time details, every fixed stop reason, root-not-selectable, conflict, stale directory, and browser unavailable. Verify both locales have identical keys and placeholder names.

- [ ] **Step 6: Run focused UI tests and commit Task 6**

```bash
npx vitest run \
  tests/ui/cloud-directory-browser-view.test.ts \
  tests/ui/cloud-directory-picker.test.ts \
  tests/unit/i18n/workbench-directory-picker-i18n.test.ts
git add \
  src/ui/cloud-directory-browser-view.ts \
  src/ui/cloud-directory-picker.ts \
  src/i18n/workbench-directory-picker-i18n.ts \
  tests/ui/cloud-directory-browser-view.test.ts \
  tests/ui/cloud-directory-picker.test.ts \
  tests/unit/i18n/workbench-directory-picker-i18n.test.ts
git commit -m "feat(目录): 增加逐层文件夹浏览界面"
git status --short
```

Expected: UI tests PASS with zero-request local flows, once-per-runtime root consent, exact one-layer actions, bounded DOM, and late-result protection.

## Task 7: Apply structured selection in the workbench without starting verification

**Files:**
- Modify: `src/ui/cloud-directory-field.ts`
- Modify: `tests/ui/cloud-directory-field.test.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `src/ui/verification-page.ts`
- Modify: `tests/ui/verification-page.test.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`

- [ ] **Step 1: Write failing field/controller tests**

Change `CloudDirectoryFieldActions.onChoose` to return `Promise<CloudDirectorySelection | null>` and add `onSelection(selection)`. Test that a category result displays both `/科学文库/6-经济类` and actual root `/科学文库`, emits the structured object once, and does not rewrite the manual input to the category path. A directory result displays one path. A manual edit clears the structured summary and emits the manual root only. A stale chooser result after field disposal or a newer manual edit is ignored.

Controller tests must assert these exact state transitions:

```ts
await controller.applyCatalogRootSelection({
  kind: "category",
  selectedPath: "/科学文库/6-经济类",
  effectiveRoot: "/科学文库",
  groupKey: GROUP_A,
});
expect(controller.snapshot()).toMatchObject({
  verificationRoot: "/科学文库",
  selectedVerificationGroupKeys: [GROUP_A],
});
expect(startVerification).not.toHaveBeenCalled();
```

For a directory result, retain the current selected group keys after filtering them against active imported groups. Reject a category result whose key is absent/inactive. Manual root change clears the structured selection summary but preserves existing legal group selections.

- [ ] **Step 2: Update the controller picker API and purpose construction**

Replace `chooseCatalogRoot(initialRoot: string)` with:

```ts
chooseCatalogRoot(input: Readonly<{
  initialRoot: string;
  purpose: CloudDirectoryPickerPurpose;
}>): Promise<CloudDirectorySelection | null>;
```

Pass candidates, the optional shared browser, optional locator, and a detached purpose into the picker. Add `applyCatalogRootSelection(selection)` as the only method that mutates the verification draft. Validate the returned selection again at this controller boundary. Store `selectedPath` only as session UI explanation; persist neither it nor `fsId`.

- [ ] **Step 3: Route the structured result through verification page and view**

Add optional `directorySelection` to the verification page model and an `onDirectorySelection` action. Build verification purpose from active non-`txt-root-items` catalog groups using `groupKey`, `rootRelativePath`, and label. The workbench browse action must await the picker, then call `applyCatalogRootSelection` only if a result exists. It must not call start/resume confirmation or the verification runtime.

- [ ] **Step 4: Add translated selection summaries**

Add Chinese/English labels for “选择的文件夹”, “实际核验父目录”, and “本次核验分类”. Keep long normalized paths wrapping and expose both paths to assistive technology.

- [ ] **Step 5: Verify and commit Task 7**

```bash
npx vitest run \
  tests/ui/cloud-directory-field.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git add \
  src/ui/cloud-directory-field.ts \
  src/ui/workbench-controller.ts \
  src/ui/verification-page.ts \
  src/ui/workbench-view.ts \
  src/i18n/workbench-i18n.ts \
  tests/ui/cloud-directory-field.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git commit -m "feat(核验): 应用分类目录选择结果"
git status --short
```

Expected: all focused tests PASS and selecting any folder leaves scan/verification call counts at zero.

## Task 8: Integrate scan settings, verification settings, and final confirmation

**Files:**
- Modify: `src/ui/settings-sections.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `src/ui/catalog-large-scan-confirmation-modal.ts`
- Modify: `tests/ui/catalog-large-scan-confirmation-modal.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`

- [ ] **Step 1: Write failing settings-host tests**

For the cloud scan field, assert `chooseCatalogRoot` receives `{initialRoot, purpose:{kind:"scan"}}`, accepts only a directory result, writes `effectiveRoot` into the scan draft, and still waits for the separate scan confirmation.

For large-catalog verification, use active imported groups and assert `chooseCatalogRoot` receives a detached verification purpose. A category result must set the settings-local root to its parent and replace `largeCatalogSelectedGroupKeys` with exactly the returned group key. A directory result changes only the root and retains currently legal group selections. Cancellation changes nothing. Manual input clears the structured selection summary. Every chooser path leaves `requestCatalogScan` and `requestLargeCatalogVerification` uncalled.

- [ ] **Step 2: Extend the final confirmation request with structured context**

For `kind:"start"`, add optional `directorySelection: CloudDirectorySelection` and add `rootRelativePath` to each start confirmation group. Build a `CloudDirectoryPickerPurpose` from the supplied groups and call `validateCloudDirectorySelection` inside `checkedRequest`. Then require:

- `directorySelection.effectiveRoot === normalized cloudRoot`;
- a directory selection does not change the supplied groups;
- a category selection has exactly one supplied group, its `groupKey` equals that group, and its selected path exactly matches `cloudRoot + rootRelativePath`;
- neither selected nor effective path is `/`.

For `kind:"resume"`, reject a supplied `directorySelection` and preserve the existing zero-group resume contract. Do not infer a historical selection from a checkpoint.

- [ ] **Step 3: Render the final human-checkable summary**

When start confirmation has a structured selection, show selected folder, actual cloud root, and selected category label before the existing candidate count and budget disclosure. When it is absent (manual/root-only flow), show the existing cloud root and groups unchanged. Tests must cover mismatch, forged category key, root path, detached result, start-without-selection compatibility, and resume compatibility.

- [ ] **Step 4: Run focused settings/confirmation tests**

```bash
npx vitest run \
  tests/ui/settings-sections.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
```

Expected: PASS; category choice narrows to one group, scan choice cannot become category, and neither host starts a cloud action during selection.

- [ ] **Step 5: Commit Task 8**

```bash
git add \
  src/ui/settings-sections.ts \
  src/ui/catalog-large-scan-confirmation-modal.ts \
  src/i18n/workbench-i18n.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git commit -m "feat(设置): 接入结构化目录选择"
git status --short
```

Expected: only the 11 pre-existing untracked research files remain.

## Task 9: Close accessibility, responsive layout, and renderer-pressure gates

**Files:**
- Modify: `styles.css`
- Modify: `src/ui/cloud-directory-browser-view.ts`
- Modify: `src/ui/cloud-directory-picker.ts`
- Modify: `tests/ui/cloud-directory-browser-view.test.ts`
- Modify: `tests/ui/cloud-directory-picker.test.ts`
- Modify: `tests/performance/workbench-open.bench.test.ts`

- [ ] **Step 1: Add failing keyboard, ARIA, and pressure tests**

Add jsdom tests for:

- initial focus in local search;
- Up/Down changes `aria-selected` among visible folders;
- Enter enters the highlighted folder and never selects it;
- the explicit select button returns the highlighted folder;
- Backspace with empty search returns to a loaded ancestor, but Backspace with text edits only the query;
- Escape first cancels a running layer operation and otherwise closes the Modal;
- `role="status"`, `aria-live="polite"`, accurate `progress[max="20000"]`, labeled breadcrumbs, and non-color conflict/error text;
- long paths and Chinese folder names remain text-visible at a synthetic narrow width;
- 20,000 directory rows leave at most 102 content rows after repeated scroll, filter, enter, back, rerender, and disposal cycles;
- 20,000 mixed source entries leave no file names in browser snapshots or DOM.

Extend the existing synthetic workbench performance fixture to open the 68,959-entry catalog plus a 20,000-folder browser snapshot. Assert the catalog store is not copied into the browser surface, the browser retains one directory array, and the DOM bound remains constant. Do not add a wall-clock threshold that is unstable across machines; assert allocations/counts and existing benchmark invariants.

- [ ] **Step 2: Implement deterministic keyboard and focus behavior**

Keep one highlighted-path value per displayed layer. After filtering or paging, preserve it only if the path still exists; otherwise select the first visible folder. Restore focus to the opener after any settle path. Use one `AbortController` for DOM listeners and one operation controller for network work; disposing either surface must not dispose the shared runtime.

- [ ] **Step 3: Add theme-safe and narrow-window styles**

Use Obsidian theme variables only. Give virtual rows a fixed 44 px layout height, visible focus ring, separate enter/select hit targets, wrapping full-path text, scrollable breadcrumbs, and a responsive single-column action layout below 640 px. Style incomplete/conflict/error states with icons or text in addition to color. Keep progress and expandable run details visually subordinate to folder choice.

- [ ] **Step 4: Run UI and synthetic pressure gates**

```bash
npx vitest run \
  tests/ui/cloud-directory-browser-view.test.ts \
  tests/ui/cloud-directory-picker.test.ts
npm run test:performance
```

Expected: all accessibility/UI tests PASS; existing performance suite remains green with the additional bounded-DOM/allocation assertions. No external network is used.

- [ ] **Step 5: Commit Task 9**

```bash
git add \
  styles.css \
  src/ui/cloud-directory-browser-view.ts \
  src/ui/cloud-directory-picker.ts \
  tests/ui/cloud-directory-browser-view.test.ts \
  tests/ui/cloud-directory-picker.test.ts \
  tests/performance/workbench-open.bench.test.ts
git commit -m "style(目录): 完善浏览器状态与无障碍"
git status --short
```

Expected: only the 11 pre-existing untracked research files remain.

## Task 10: Preserve acceptance isolation and close the release documentation

**Files:**
- Modify: `tests/packaging/composition-roots.test.ts`
- Modify: `tests/packaging/read-only-acceptance-build.test.ts`
- Modify: `README.md`
- Modify: `docs/runbooks/baidu-cloud-catalog-small-folder.md`
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `versions.json`

- [ ] **Step 1: Strengthen packaging tests before changing release metadata**

Add these browser inputs to the acceptance forbidden-input list:

```ts
"src/catalog/cloud-directory-browser.ts",
"src/catalog/cloud-directory-selection.ts",
"src/ui/cloud-directory-browser-view.ts",
"src/ui/cloud-directory-picker.ts",
"src/i18n/workbench-directory-picker-i18n.ts",
```

Add bundle text tripwires for `CloudDirectoryBrowserService`, `cloud-directory-root-consent-required`, the Chinese root-browse label, and the existing OAuth/list endpoint strings. In the normal-graph source assertions, require the browser constructor exactly once. In disabled/offline/acceptance runtime tests, assert `directoryBrowser` is `undefined`.

- [ ] **Step 2: Run packaging tests and fix graph leaks before versioning**

```bash
npx vitest run \
  tests/packaging/composition-roots.test.ts \
  tests/packaging/read-only-acceptance-build.test.ts \
  tests/integration/catalog-offline-composition.test.ts \
  tests/integration/read-only-acceptance-automated-safety.test.ts
```

Expected: PASS. If a forbidden browser input or tripwire appears in acceptance, remove the import path from the acceptance graph; do not weaken or delete the assertion.

- [ ] **Step 3: Update user and operator documentation**

Update the README Cloud Catalog section to state:

- default picker open/search is local and makes zero Baidu requests;
- root browse has a once-per-plugin-session disclosure;
- browsing is one level at a time;
- each explicit round checks at most 20,000 response entries through up to 20 fixed 1,000-entry requests;
- incomplete layers require explicit continue;
- files/PDFs are not shown or retained;
- category choice displays its actual verification parent and does not start verification.

Extend the small-folder runbook with a later real-acceptance sequence: back up plugin data/list, use one non-sensitive non-root folder, observe the chooser, select one small category, verify exact request/stop details, download no PDF, write no note, and restore plugins. Mark that sequence “not executed by this automated plan” and require fresh explicit authorization.

- [ ] **Step 4: Bump all release metadata together**

Change `0.1.1` to `0.1.2` in `manifest.json`, `package.json`, the root package entry in `package-lock.json`, and `versions.json`. Do not change minimum app version or acceptance artifact identity.

- [ ] **Step 5: Run the complete automated gate serially**

```bash
npx vitest run --no-file-parallelism --maxWorkers=1
npm run lint
npm run build
npm run build:acceptance
npm run test:catalog-performance
npm run test:performance
git diff --check
```

Expected: every command exits `0`; normal build includes the browser, acceptance build excludes it, and performance tests use synthetic data only. Do not run any `install:*`, OAuth, real acceptance, network, push, or PR command.

- [ ] **Step 6: Inspect the final diff and commit Task 10**

```bash
git status --short
git diff --stat HEAD
git diff --check
git add \
  tests/packaging/composition-roots.test.ts \
  tests/packaging/read-only-acceptance-build.test.ts \
  README.md \
  docs/runbooks/baidu-cloud-catalog-small-folder.md \
  manifest.json package.json package-lock.json versions.json
git commit -m "chore(发布): 收口文件夹浏览版本"
git status --short
```

Expected: the commit contains only the named files. The 11 unrelated research Markdown files remain untracked and untouched.

## Final implementation handoff checklist

- [ ] All ten task commits exist with the specified Chinese commit-message format.
- [ ] Full serial Vitest, lint, normal build, acceptance build, catalog performance, and workbench performance commands passed with recorded exit codes.
- [ ] Local open/search/cache flows and selection itself are proven zero-request.
- [ ] Root consent is shared for one plugin session and reset by identity/lifecycle clearing.
- [ ] Every layer request is explicit, one-level, fixed at `limit=1000`, and bounded to 20,000 entries/20 permits/120 seconds per round.
- [ ] Failed or invalid pages consume request permits but never advance cursors or partially mutate caches.
- [ ] Files/PDFs are absent from snapshots, DOM, persisted settings, recent paths, and logs.
- [ ] Category selection lists no category contents and narrows verification to exactly one active group.
- [ ] `/` cannot cross the selection, settings, controller, confirmation, scan, or verification boundaries.
- [ ] Bounded-DOM, keyboard, focus, ARIA, long-path, narrow-window, and multi-plugin pressure regressions are green.
- [ ] Disabled/offline/acceptance graphs expose no browser and acceptance bundle tripwires remain absent.
- [ ] No real Baidu request, OAuth, PDF download, Vault write, plugin install, push, PR, or merge was performed.
- [ ] Only a later, separately authorized real acceptance may install the normal build or contact Baidu.
