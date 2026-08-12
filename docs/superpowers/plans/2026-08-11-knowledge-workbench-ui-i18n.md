# Knowledge Workbench Chinese UI and Task Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the English-heavy, long-form plugin UI with a polished fixed-left task navigator, shared grouped settings, Simplified Chinese/English switching, and a bounded fuzzy cloud-directory picker without changing catalog or Vault safety semantics.

**Status:** Completed at Checkpoint C on 2026-08-12; final implementation commit `1e99fc6113a0610991765afbaa1597603d859e42` passed the recorded full, performance, packaging, and synthetic visual-acceptance gates.

**Architecture:** Add one typed locale source to persisted plugin settings and pass a small translator through pure DOM renderers. Keep existing domain services intact, split the workbench into focused page renderers, and expose a normal-build-only session directory discovery service through the existing cloud runtime. Local fuzzy matching never calls Baidu; the explicit “search more” action reuses `BaiduCatalogSourcePort.listDirectory` with hard request, directory, time, and cancellation limits.

**Tech Stack:** TypeScript 5.8, Vitest 4, jsdom, Obsidian 1.13 APIs, existing Baidu list adapter, CSS with Obsidian theme variables, esbuild.

---

## Scope and safety invariants

- Work only in `/Users/example/Documents/obsidian-knowledge-workbench` on the current `codex/baidu-cloud-catalog-core` branch.
- Never stage or modify the unrelated untracked research Markdown files at the repository root.
- Use the approved design at `docs/superpowers/specs/2026-08-11-knowledge-workbench-ui-i18n-design.md` as the product contract.
- Do not run real OAuth, real Baidu listing, PDF download, real full-library import, or real Vault write during Tasks 1–11.
- All automated tests use synthetic names, paths, credentials, and directory responses.
- Keep the existing small-scan and large-catalog budgets, checkpoint schemas, projection rules, and SecretStorage boundary unchanged.
- Opening a page, switching language, typing a directory query, or opening the directory picker must issue zero Baidu requests.
- Only an explicit confirmed “search more directories” action may call the existing `listDirectory` port.
- Do not add a Baidu search, download, upload, filemanager, rename, move, delete, or sharing endpoint.
- Do not run old A/B benchmark, long-pilot, public-v1, stress, or batch-model scripts.
- Finish Tasks 1–3, stop at Checkpoint A, and report the required engineering-sample metrics. Repeat after Tasks 4–6 at Checkpoint B and after Tasks 7–11 at Checkpoint C.
- Each checkpoint reports current Git commit, completed functionality, tests and results, wrong directions and rework count, available input-token statistics, PMH recall count/token amount without memory content, and whether cross-project or cross-model pollution was detected. Unavailable fields must be reported as unavailable, never estimated.
- A checkpoint ends execution for that turn. Do not start a control-model experiment.

## File map

| File | Responsibility |
| --- | --- |
| `src/i18n/workbench-i18n.ts` | Locale type, typed dictionaries, interpolation, number/date formatting, fixed error messages |
| `src/storage/plugin-data.ts` | Persisted `locale` field on `PluginSettings` |
| `src/storage/plugin-data-store.ts` | Decode missing/invalid locale to `zh-CN` without schema expansion |
| `src/ui/workbench-shell.ts` | Header, language switch, fixed left navigation, and main-page container |
| `src/ui/start-page.ts` | Task progress, next action, Today/Map, suggestions, and Quick Capture entry |
| `src/ui/settings-sections.ts` | Shared grouped settings surface used by both Obsidian Settings and the workbench |
| `src/ui/settings-tab.ts` | Thin Obsidian `PluginSettingTab` adapter over shared settings sections |
| `src/ui/cloud-catalog-tab.ts` | Search-first “My catalog” layout, filters, results, selection, and details |
| `src/ui/verification-page.ts` | Cloud-root input, category selection, bounded summary, progress, pause, and resume |
| `src/ui/cloud-directory-picker.ts` | Session-only folder picker, local fuzzy results, discovery confirmation, and selection |
| `src/catalog/cloud-directory-search.ts` | Pure deterministic directory-query normalization and ranking |
| `src/catalog/cloud-directory-discovery-service.ts` | Bounded, cancelable, session-only `listDirectory` traversal and cache |
| `src/catalog/cloud-catalog-runtime.ts` | Optional normal-build directory discovery capability on the catalog runtime |
| `src/runtime/normal-cloud-catalog-composition.ts` | Compose discovery with the existing Baidu source adapter |
| `src/ui/workbench-controller.ts` | Locale, page, start-section, selection, verification, and picker orchestration |
| `src/ui/workbench-view.ts` | Compose shell and page renderers while preserving focus and async error routing |
| `src/runtime/runtime-composition.ts` | Shared settings surface and directory picker presenter factories |
| `src/plugin/knowledge-workbench-plugin.ts` | Supply locale providers to user-facing factories and register localized host labels |
| `src/main.ts` | Normal Obsidian modal, SecretComponent, and settings-surface bindings |
| `src/main-acceptance.ts` | Chinese-default, network-blocked acceptance bindings only |
| `styles.css` | Theme-aware visual hierarchy and vertical responsive navigation |

## Checkpoint A — locale foundation, shell, and preserved start workflow

### Task 1: Add typed i18n and persist the locale

**Files:**
- Create: `src/i18n/workbench-i18n.ts`
- Create: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `src/storage/plugin-data.ts`
- Modify: `src/storage/plugin-data-store.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/ui/settings-tab.ts`
- Modify: `tests/unit/storage/plugin-data-store.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: settings fixtures reported by `rg -l "openAtStartup:" tests`

- [x] **Step 1: Write failing locale and persistence tests**

Create `tests/unit/i18n/workbench-i18n.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createWorkbenchI18n,
  isWorkbenchLocale,
  WORKBENCH_LOCALES,
} from "../../../src/i18n/workbench-i18n";

describe("workbench i18n", () => {
  it("supports exactly Simplified Chinese and English", () => {
    expect(WORKBENCH_LOCALES).toEqual(["zh-CN", "en"]);
    expect(isWorkbenchLocale("zh-CN")).toBe(true);
    expect(isWorkbenchLocale("en")).toBe(true);
    expect(isWorkbenchLocale("zh")).toBe(false);
  });

  it("formats translated navigation and counts", () => {
    const zh = createWorkbenchI18n("zh-CN");
    const en = createWorkbenchI18n("en");
    expect(zh.t("nav.catalog")).toBe("我的目录");
    expect(en.t("nav.catalog")).toBe("My catalog");
    expect(zh.t("catalog.pdfCount", { count: zh.number(68_959) }))
      .toBe("68,959 本 PDF");
    expect(en.t("catalog.pdfCount", { count: en.number(68_959) }))
      .toBe("68,959 PDFs");
  });

  it("rejects missing interpolation values", () => {
    expect(() => createWorkbenchI18n("zh-CN").t("catalog.pdfCount"))
      .toThrow("i18n-interpolation-missing:count");
  });
});
```

Add storage assertions:

```ts
it("defaults missing or invalid locale to Simplified Chinese", async () => {
  const store = new PluginDataStore(new MemoryPluginDataPort({
    schemaVersion: 1,
    settings: { openAtStartup: true, locale: "fr" },
    activeIndex: null,
    staging: null,
    operational: { pins: {}, dismissals: {}, lastOpened: {}, journals: [] },
  }));
  await store.load();
  expect(store.settings().locale).toBe("zh-CN");
});
```

Add a controller assertion that `setLocale("en")` persists settings, updates `snapshot().locale`, emits once, and does not change `catalog.query`, `activeTab`, or map selection.

- [x] **Step 2: Run the focused tests and verify the module/type failures**

Run:

```bash
npx vitest run tests/unit/i18n/workbench-i18n.test.ts tests/unit/storage/plugin-data-store.test.ts tests/ui/workbench-controller.test.ts
```

Expected: FAIL because `workbench-i18n.ts`, `PluginSettings.locale`, `WorkbenchViewModel.locale`, and `WorkbenchController.setLocale` do not exist.

- [x] **Step 3: Implement the typed locale core**

Create the initial complete dictionary needed by the shell and persistence task:

```ts
export const WORKBENCH_LOCALES = ["zh-CN", "en"] as const;
export type WorkbenchLocale = typeof WORKBENCH_LOCALES[number];

const en = {
  "app.name": "Knowledge Workbench",
  "language.chinese": "Simplified Chinese",
  "language.english": "English",
  "nav.start": "Start",
  "nav.catalog": "My catalog",
  "nav.verification": "Cloud verification",
  "nav.history": "Operation history",
  "nav.settings": "Settings",
  "status.ready": "Ready",
  "status.canceled": "Canceled",
  "status.error": "Error",
  "catalog.pdfCount": "{count} PDFs",
} as const;

export type WorkbenchMessageKey = keyof typeof en;

const zhCN: Record<WorkbenchMessageKey, string> = {
  "app.name": "知识工作台",
  "language.chinese": "简体中文",
  "language.english": "English",
  "nav.start": "开始",
  "nav.catalog": "我的目录",
  "nav.verification": "云端核验",
  "nav.history": "操作记录",
  "nav.settings": "设置",
  "status.ready": "就绪",
  "status.canceled": "已取消",
  "status.error": "错误",
  "catalog.pdfCount": "{count} 本 PDF",
};

const dictionaries: Record<WorkbenchLocale, Record<WorkbenchMessageKey, string>> = {
  "zh-CN": zhCN,
  en,
};

export const isWorkbenchLocale = (value: unknown): value is WorkbenchLocale =>
  value === "zh-CN" || value === "en";

export interface WorkbenchI18n {
  readonly locale: WorkbenchLocale;
  t(key: WorkbenchMessageKey, values?: Readonly<Record<string, string | number>>): string;
  number(value: number): string;
  date(value: number): string;
}

export const createWorkbenchI18n = (locale: WorkbenchLocale): WorkbenchI18n => ({
  locale,
  t(key, values = {}) {
    return dictionaries[locale][key].replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (_, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`i18n-interpolation-missing:${name}`);
      return String(value);
    });
  },
  number: (value) => new Intl.NumberFormat(locale).format(value),
  date: (value) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value)),
});
```

Add `readonly locale: WorkbenchLocale` to `PluginSettings`, set `locale: "zh-CN"` in `defaultSettings()`, and decode only the two approved values:

```ts
locale: isWorkbenchLocale(value.locale) ? value.locale : "zh-CN",
```

Add `locale` to `WorkbenchViewModel`, initialize it from `effectiveSettings(...).locale`, and implement:

```ts
async setLocale(locale: WorkbenchLocale): Promise<void> {
  if (this.disposed || locale === this.model.locale) return;
  const settings = this.dependencies.store.settings();
  await this.dependencies.store.saveSettings({ ...settings, locale });
  if (this.disposed) return;
  this.model = { ...this.model, locale };
  this.emit();
}
```

Expose `setLocale` on `SettingsController` and `WorkbenchViewController`. Do not translate other surfaces in this task; they remain behaviorally unchanged until their page tasks.

- [x] **Step 4: Update typed fixtures and rerun the focused tests**

Add `locale: "zh-CN"` to every complete `PluginSettings` literal reported by:

```bash
rg -l "openAtStartup:" tests src | sort
```

Run:

```bash
npx vitest run tests/unit/i18n/workbench-i18n.test.ts tests/unit/storage/plugin-data-store.test.ts tests/unit/runtime/safety-policy.test.ts tests/ui/workbench-controller.test.ts tests/ui/settings-tab.test.ts
```

Expected: PASS. The storage test must prove a missing historical locale becomes `zh-CN`; it must not bump `PLUGIN_DATA_SCHEMA_VERSION` or clear unrelated settings.

- [x] **Step 5: Commit the locale foundation**

```bash
git add src/i18n/workbench-i18n.ts src/storage/plugin-data.ts src/storage/plugin-data-store.ts src/ui/workbench-controller.ts src/ui/workbench-view.ts src/ui/settings-tab.ts tests/unit/i18n/workbench-i18n.test.ts tests/unit/storage/plugin-data-store.test.ts tests/unit/runtime/safety-policy.test.ts tests/ui/workbench-controller.test.ts tests/ui/settings-tab.test.ts tests/ui/workbench-view.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/helpers/ui-fixtures.ts tests/packaging/synthetic-acceptance-data.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts
git commit -m "feat(界面): 增加中英文语言基础"
```

Before committing, inspect `git status --short` and unstage every unrelated research Markdown file.

### Task 2: Replace top tabs with a fixed-left workbench shell

**Files:**
- Create: `src/ui/workbench-shell.ts`
- Create: `tests/ui/workbench-shell.test.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/ui/accessibility.test.ts`
- Modify: `styles.css`

- [x] **Step 1: Write failing shell and keyboard-navigation tests**

Create `tests/ui/workbench-shell.test.ts` with the approved five items and vertical keyboard behavior:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { renderWorkbenchShell } from "../../src/ui/workbench-shell";

describe("workbench shell", () => {
  it("renders exactly five fixed-left destinations in Chinese", () => {
    const root = document.createElement("div");
    const selected: string[] = [];
    renderWorkbenchShell(root, {
      activePage: "workbench",
      i18n: createWorkbenchI18n("zh-CN"),
      connectionStatus: "authorized",
      onSelectPage: (page) => selected.push(page),
      onSetLocale: () => undefined,
    });
    expect(Array.from(root.querySelectorAll("[data-workbench-page]"))
      .map((node) => node.textContent?.trim())).toEqual([
      "开始", "我的目录", "云端核验", "操作记录", "设置",
    ]);
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(root.querySelector('[data-workbench-sidebar="true"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-workbench-page="cloud-catalog"]')!.click();
    expect(selected).toEqual(["cloud-catalog"]);
  });

  it("moves focus vertically without moving the sidebar to the top", () => {
    const root = document.createElement("div");
    document.body.append(root);
    renderWorkbenchShell(root, {
      activePage: "workbench",
      i18n: createWorkbenchI18n("zh-CN"),
      connectionStatus: "authorized",
      onSelectPage: () => undefined,
      onSetLocale: () => undefined,
    });
    const first = root.querySelector<HTMLButtonElement>('[data-workbench-page="workbench"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-workbench-page")).toBe("cloud-catalog");
    root.remove();
  });
});
```

Update workbench-view expectations to reject the old `Workbench / Organization suggestions / Operation history / Cloud Catalog / Settings` tablist.

- [x] **Step 2: Run the shell tests and verify the missing renderer failure**

Run:

```bash
npx vitest run tests/ui/workbench-shell.test.ts tests/ui/workbench-view.test.ts tests/ui/accessibility.test.ts
```

Expected: FAIL because `renderWorkbenchShell` and the `verification` page do not exist and old tab expectations remain.

- [x] **Step 3: Implement the shell and page contract**

Keep the existing controller identifier names where safe, but redefine the page union as:

```ts
export type WorkbenchTab =
  | "workbench"
  | "cloud-catalog"
  | "verification"
  | "history"
  | "settings";
```

Create `workbench-shell.ts` with a fixed descriptor list:

```ts
const NAVIGATION = [
  { page: "workbench", key: "nav.start", icon: "⌂" },
  { page: "cloud-catalog", key: "nav.catalog", icon: "▤" },
  { page: "verification", key: "nav.verification", icon: "✓" },
  { page: "history", key: "nav.history", icon: "↻" },
  { page: "settings", key: "nav.settings", icon: "⚙" },
] as const;

export interface WorkbenchShellOptions {
  readonly activePage: WorkbenchTab;
  readonly i18n: WorkbenchI18n;
  readonly connectionStatus: CloudCatalogConnectionViewModel["status"] | "unavailable";
  readonly onSelectPage: (page: WorkbenchTab) => void;
  readonly onSetLocale: (locale: WorkbenchLocale) => void;
}

export interface WorkbenchShellElements {
  readonly header: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly status: HTMLElement;
  readonly progress: HTMLElement;
  readonly panel: HTMLElement;
}
```

`renderWorkbenchShell` must create one `.knowledge-workbench__shell` grid, one `<nav aria-label>` sidebar, one `<main>` panel, a header locale control, and connection/safety status. ArrowUp/ArrowDown/Home/End move focus and invoke the selected page only when the user activates a button; focus movement alone must not trigger network or data actions.

Refactor `renderWorkbench` to obtain the shell elements, then render the active page into `shell.panel`. Preserve the existing focus-key and input-selection restoration logic.

Add CSS that never converts the sidebar into a horizontal row:

```css
.knowledge-workbench__shell {
  display: grid;
  grid-template-columns: minmax(9rem, 12rem) minmax(0, 1fr);
  min-height: 100%;
}

.knowledge-workbench__sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--size-2-2);
  background: var(--background-secondary);
  border-inline-end: 1px solid var(--background-modifier-border);
}

@container (max-width: 44rem) {
  .knowledge-workbench__shell {
    grid-template-columns: 3.25rem minmax(0, 1fr);
  }
  .knowledge-workbench__nav-label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}
```

- [x] **Step 4: Run shell, view, and accessibility tests**

Run:

```bash
npx vitest run tests/ui/workbench-shell.test.ts tests/ui/workbench-view.test.ts tests/ui/accessibility.test.ts
```

Expected: PASS. Assert that the page region is labelled by its selected navigation button, the language control has an accessible name, and no duplicate element IDs are created across two workbench roots.

- [x] **Step 5: Commit the fixed-left shell**

```bash
git add src/ui/workbench-shell.ts src/ui/workbench-view.ts styles.css tests/ui/workbench-shell.test.ts tests/ui/workbench-view.test.ts tests/ui/accessibility.test.ts
git commit -m "feat(界面): 改用固定左侧任务导航"
```

### Task 3: Build the start page without removing existing capabilities

**Files:**
- Create: `src/ui/start-page.ts`
- Create: `tests/ui/start-page.test.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `styles.css`

- [x] **Step 1: Write failing start-page preservation tests**

Create a test that renders a ready unified catalog and proves the page contains task progress, one next action, and the old capabilities:

```ts
it("keeps Today, Map, suggestions, and Quick Capture under Start", () => {
  const root = document.createElement("div");
  const model = populatedWorkbenchModel();
  renderStartPage(root, {
    model: {
      ...model,
      locale: "zh-CN",
      startSection: "overview",
      catalog: {
        ...model.catalog,
        status: "ready",
        source: "unified",
        pdfCount: 68_959,
        verificationCounts: {
          unverified: 68_707, verified: 252, difference: 0, cloudMissing: 0,
        },
      },
    },
    actions: noOpWorkbenchActions(),
    policy: NORMAL_RUNTIME_POLICY,
  });
  expect(root.textContent).toContain("68,959 本 PDF");
  expect(root.querySelector('[aria-label="今日"]')).not.toBeNull();
  expect(root.querySelector('[aria-label="知识地图"]')).not.toBeNull();
  expect(root.querySelector('[data-start-section="suggestions"]')).not.toBeNull();
  expect(root.querySelector('[data-action="quick-capture"]')).not.toBeNull();
});
```

Add a second test that switches the page-local section to `suggestions` and proves existing preview callbacks and read-only policy guards are unchanged.

- [x] **Step 2: Run the focused tests and verify the missing page/model failures**

Run:

```bash
npx vitest run tests/ui/start-page.test.ts tests/ui/workbench-controller.test.ts tests/ui/workbench-view.test.ts tests/ui/read-only-acceptance-surfaces.test.ts
```

Expected: FAIL because `start-page.ts`, `startSection`, and `onSelectStartSection` do not exist.

- [x] **Step 3: Implement the start-page model and renderer**

Add:

```ts
export type StartSection = "overview" | "suggestions";
```

Initialize `startSection: "overview"` in `WorkbenchViewModel`. Implement `selectStartSection` as a synchronous local state transition with no catalog or Vault calls.

`renderStartPage` must:

1. derive three progress cards from `catalog.source`, `catalog.pdfCount`, and verification counts;
2. route the primary search action to `onSelectTab("cloud-catalog")`;
3. route the recommended verification action to `onSelectTab("verification")`;
4. render `renderTodayPane` and `renderMapPane` when `startSection === "overview"`;
5. render `renderSuggestionsTab` with the existing confirmation-aware callbacks when `startSection === "suggestions"`;
6. show Quick Capture only when the policy allows it and preserve the command/ribbon entry independently.

Use translated keys added in this task, including:

```ts
"start.title": "Continue your knowledge library" / "继续整理你的知识库"
"start.step.import": "Import catalog" / "导入目录"
"start.step.search": "Search check" / "搜索检查"
"start.step.verify": "Cloud verification" / "云端核验"
"start.section.overview": "Today and map" / "今日与知识地图"
"start.section.suggestions": "Organization suggestions" / "整理建议"
"start.next": "Recommended next step" / "建议的下一步"
```

- [x] **Step 4: Run start-page and legacy behavior tests**

Run:

```bash
npx vitest run tests/ui/start-page.test.ts tests/ui/workbench-controller.test.ts tests/ui/workbench-view.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/integration/confirmed-plan-flow.test.ts
```

Expected: PASS. The acceptance build must still hide Quick Capture, organization writes, and AI actions while showing the localized read-only explanation.

- [x] **Step 5: Commit the preserved start workflow**

```bash
git add src/i18n/workbench-i18n.ts src/ui/start-page.ts src/ui/workbench-controller.ts src/ui/workbench-view.ts styles.css tests/helpers/ui-fixtures.ts tests/ui/start-page.test.ts tests/ui/workbench-controller.test.ts tests/ui/workbench-view.test.ts tests/ui/read-only-acceptance-surfaces.test.ts
git commit -m "feat(界面): 建立任务首页并保留原功能"
```

### Checkpoint A: Stop and report

Run before stopping:

```bash
npx vitest run tests/unit/i18n/workbench-i18n.test.ts tests/unit/storage/plugin-data-store.test.ts tests/ui/workbench-shell.test.ts tests/ui/start-page.test.ts tests/ui/workbench-controller.test.ts tests/ui/workbench-view.test.ts tests/ui/accessibility.test.ts tests/ui/read-only-acceptance-surfaces.test.ts
git status --short --branch
git rev-parse HEAD
```

Report the required engineering-sample fields. Do not begin Task 4 in the same turn.

## Checkpoint B — shared settings, catalog, and verification pages

### Task 4: Extract shared grouped settings for both entry points

**Files:**
- Create: `src/ui/settings-sections.ts`
- Create: `tests/ui/settings-sections.test.ts`
- Modify: `src/ui/settings-tab.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/runtime/runtime-composition.ts`
- Modify: `src/plugin/knowledge-workbench-plugin.ts`
- Modify: `src/main.ts`
- Modify: `src/main-acceptance.ts`
- Modify: `tests/ui/settings-tab.test.ts`
- Modify: `tests/ui/read-only-acceptance-surfaces.test.ts`
- Modify: `tests/integration/read-only-acceptance-automated-safety.test.ts`
- Modify: `styles.css`

- [x] **Step 1: Write failing shared-settings tests**

Test that both the Obsidian settings adapter and workbench settings page use the same section renderer:

```ts
const settingsControllerFixture = (): SettingsController => ({
  settings: () => ({
    locale: "zh-CN",
    writeEnabled: false,
    writePreviewAcknowledged: false,
    openAtStartup: false,
    folderRules: [],
    excludedPrefixes: [],
    aiEnabled: false,
    aiEndpoint: "",
    aiModel: "",
    secretId: "",
  }),
  folderRuleProposals: () => [],
  previewSampleChange: () => undefined,
  setLocale: async () => undefined,
  setOpenAtStartup: async () => undefined,
  setWriteEnabled: async () => undefined,
  applyFolderRules: async () => undefined,
  setExcludedPrefixes: async () => undefined,
});

it("renders the same five grouped settings in both hosts", () => {
  const controller = settingsControllerFixture();
  const nativeRoot = document.createElement("div");
  const workbenchRoot = document.createElement("div");
  const native = createSettingsSectionsSurface({
    app: {} as App,
    controller,
    policy: NORMAL_RUNTIME_POLICY,
    createSecretComponent: undefined,
  });
  const workbench = createSettingsSectionsSurface({
    app: {} as App,
    controller,
    policy: NORMAL_RUNTIME_POLICY,
    createSecretComponent: undefined,
  });
  native.render(nativeRoot, "zh-CN");
  workbench.render(workbenchRoot, "zh-CN");
  const names = (root: HTMLElement) => Array.from(root.querySelectorAll("[data-settings-section]"))
    .map((node) => node.getAttribute("data-settings-section"));
  expect(names(nativeRoot)).toEqual([
    "language", "baidu", "large-catalog", "verification", "privacy-ai",
  ]);
  expect(names(workbenchRoot)).toEqual(names(nativeRoot));
});
```

Also assert cards are collapsed by default, the language card remains directly usable, expanding one card does not expose credential values in `textContent`, and the acceptance surface never constructs SecretComponent or network controls.

- [x] **Step 2: Run settings tests and verify the missing shared surface failure**

Run:

```bash
npx vitest run tests/ui/settings-sections.test.ts tests/ui/settings-tab.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts
```

Expected: FAIL because `settings-sections.ts` and `createWorkbenchSettingsSurface` do not exist.

- [x] **Step 3: Extract one stateful settings surface**

Define a reusable contract:

```ts
export interface SettingsSectionsSurface {
  render(root: HTMLElement, locale: WorkbenchLocale): void;
  dispose(): void;
}

export interface SettingsSectionsDependencies {
  readonly app: App;
  readonly controller: SettingsController;
  readonly policy: RuntimeSafetyPolicy;
  readonly createSecretComponent?: (app: App, root: HTMLElement) => SecretComponentLike;
}
```

The surface owns only UI state: expanded section IDs, session-only input drafts, selected group keys, subscriptions, and the current live-status element. It must not own persistent settings, catalog snapshots, or credentials after the corresponding action succeeds.

Move the existing settings controls into these exact section builders:

```ts
renderLanguageSection();
renderBaiduConnectionSection();
renderLargeCatalogSection();
renderVerificationSection();
renderPrivacyAiSection();
renderAdvancedOrganizationSection();
```

`renderAdvancedOrganizationSection` appears inside the privacy/advanced card so existing write safety, folder-rule proposals, exclusions, and preview gates remain available without becoming a sixth top-level card.

Make `createSettingsTabClass` a thin adapter that creates one surface, calls `surface.render(this.containerEl, controller.settings().locale)` in `display()`, and calls `surface.dispose()` on hide. Add `RuntimeComposition.createWorkbenchSettingsSurface(app, controller)` so `WorkbenchView` mounts the same implementation when `activeTab === "settings"`.

Translate each section heading, summary, button, help text, live status, error fallback, ARIA label, and acceptance lock. Keep fixed brands such as `AppKey`, `SecretKey`, `OAuth`, `TXT`, `PDF`, and `SecretStorage` within explanatory Chinese labels.

- [x] **Step 4: Run settings and composition tests**

Run:

```bash
npx vitest run tests/ui/settings-sections.test.ts tests/ui/settings-tab.test.ts tests/ui/workbench-view.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/packaging/composition-roots.test.ts
```

Expected: PASS. Confirm that both hosts mutate the same controller settings, failed saves roll controls back, and acceptance composition contains no SecretComponent, Baidu source, or mutable configuration surface.

- [x] **Step 5: Commit shared grouped settings**

```bash
git add src/i18n/workbench-i18n.ts src/ui/settings-sections.ts src/ui/settings-tab.ts src/ui/workbench-view.ts src/runtime/runtime-composition.ts src/plugin/knowledge-workbench-plugin.ts src/main.ts src/main-acceptance.ts styles.css tests/ui/settings-sections.test.ts tests/ui/settings-tab.test.ts tests/ui/workbench-view.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/packaging/composition-roots.test.ts
git commit -m "feat(设置): 提供共享中文分组界面"
```

### Task 5: Redesign My Catalog as search, filters, results, and details

**Files:**
- Modify: `src/ui/cloud-catalog-tab.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `tests/ui/cloud-catalog-tab.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/performance/hybrid-catalog-search.bench.test.ts`
- Modify: `styles.css`

- [x] **Step 1: Write failing catalog layout and selection tests**

Add tests for the approved information hierarchy:

```ts
it("renders a Chinese search-first catalog with selected details", () => {
  const root = document.createElement("div");
  const actions = actionFixture();
  renderCloudCatalogTab(root, readyCatalog({
    source: "unified",
    pdfCount: 68_959,
    total: 2,
    items: [
      {
        catalogId: "baidu:1",
        filename: "Synthetic literature.pdf",
        pathLabel: "Synthetic/9-Literature/Synthetic literature.pdf",
        cloudPathAvailable: true,
        verificationStatus: "verified",
        differenceKinds: [],
        hierarchyTags: ["folder/Synthetic", "folder/9-Literature"],
      },
      {
        catalogId: `txt:${"a".repeat(64)}`,
        filename: "Candidate.pdf",
        pathLabel: "Synthetic/Candidate.pdf",
        cloudPathAvailable: false,
        verificationStatus: "unverified",
        differenceKinds: [],
        hierarchyTags: ["folder/Synthetic"],
      },
    ],
  }), actions, {
    i18n: createWorkbenchI18n("zh-CN"),
    selectedCatalogId: "baidu:1",
    filtersExpanded: false,
  });
  expect(root.textContent).toContain("当前仅索引文件名和目录标签");
  expect(root.querySelector('[data-catalog-search="true"]')).not.toBeNull();
  expect(root.querySelector('[data-catalog-details="baidu:1"]')).not.toBeNull();
  expect(root.querySelector('[data-action="copy-cloud-path"]')?.textContent).toBe("复制云端路径");
});
```

Add tests for selection persistence across catalog emissions, disabled path copy for TXT-only candidates, collapsed advanced filters, keyboard result selection, and `aria-live` text that never includes filenames or paths.

- [x] **Step 2: Run catalog UI and performance tests to verify failures**

Run:

```bash
npx vitest run tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-controller.test.ts
```

Expected: FAIL because the renderer has no selected-details/options contract and English strings remain.

- [x] **Step 3: Implement catalog view state and layout**

Add view-only fields to `WorkbenchViewModel`:

```ts
readonly selectedCatalogId: string | null;
readonly catalogFiltersExpanded: boolean;
```

Implement controller methods that only update local view state:

```ts
selectCatalogRecord(catalogId: string): void;
setCatalogFiltersExpanded(expanded: boolean): void;
```

When a catalog snapshot removes the selected ID, clear the selection before emitting. Do not add selection to `CloudCatalogRuntime` or persistent storage.

Refactor `renderCloudCatalogTab` into four visible regions:

1. title, count, search, and the fixed no-content-index warning;
2. common status chips plus a collapsible advanced-filter area;
3. the existing 50-row paged list;
4. a selected-record details panel with hierarchy tags, status, path label, source, and safe copy buttons.

Keep the existing search service and page size unchanged. Use translated `Intl` counts and translated difference/status labels. Preserve all existing data attributes used by safety and copy tests.

- [x] **Step 4: Run catalog UI and product-performance gates**

Run:

```bash
npx vitest run tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-controller.test.ts
KNOWLEDGE_WORKBENCH_PERFORMANCE=1 npx vitest run tests/performance/hybrid-catalog-search.bench.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=180000 --reporter=verbose
```

Expected: PASS. The performance test must retain its existing product threshold; the visual refactor must not rebuild the 70,000-record search index on every DOM render.

- [x] **Step 5: Commit the catalog page**

```bash
git add src/i18n/workbench-i18n.ts src/ui/cloud-catalog-tab.ts src/ui/workbench-controller.ts src/ui/workbench-view.ts src/catalog/cloud-catalog-runtime.ts styles.css tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-controller.test.ts tests/performance/hybrid-catalog-search.bench.test.ts
git commit -m "feat(目录): 重构中文搜索与详情界面"
```

### Task 6: Add the dedicated Cloud Verification page and actionable errors

**Files:**
- Create: `src/ui/verification-page.ts`
- Create: `tests/ui/verification-page.test.ts`
- Create: `src/ui/catalog-message-presenter.ts`
- Create: `tests/ui/catalog-message-presenter.test.ts`
- Modify: `src/ui/catalog-progress-presenter.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `styles.css`

- [x] **Step 1: Write failing verification-page and message tests**

Cover ready, scanning, paused, not-found, unauthorized, invalid-root, and cancellation states. The key ready-state assertion is:

```ts
it("summarizes scope and safety before verification", () => {
  const root = document.createElement("div");
  const actions: VerificationPageActions = {
    onRootChange: () => undefined,
    onToggleGroup: () => undefined,
    onStart: async () => undefined,
    onResume: async () => undefined,
    onCancel: () => undefined,
    onBrowseRoot: async () => null,
  };
  renderVerificationPage(root, {
    i18n: createWorkbenchI18n("zh-CN"),
    rootPath: "/Synthetic-library",
    selectedGroupKeys: [`group:${"b".repeat(64)}`],
    connection: { status: "authorized" },
    hybrid: {
      status: "ready",
      active: {
        importedAt: 1,
        pdfCount: 252,
        unverifiedCount: 252,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [{
          groupKey: `group:${"b".repeat(64)}`,
          label: "9-Literature-253",
          pdfCount: 252,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
    },
    actions,
  });
  expect(root.textContent).toContain("本次操作摘要");
  expect(root.textContent).toContain("不会下载 PDF");
  expect(root.textContent).toContain("252");
  expect(root.querySelector('[data-action="start-verification"]')).not.toBeNull();
});
```

Message tests must assert that `baidu-not-found` produces a cause, preservation statement, and next action without echoing a supplied private error object.

- [x] **Step 2: Run verification tests and verify missing modules/model failures**

Run:

```bash
npx vitest run tests/ui/verification-page.test.ts tests/ui/catalog-message-presenter.test.ts tests/ui/workbench-controller.test.ts
```

Expected: FAIL because the page, presenter, and verification view state do not exist.

- [x] **Step 3: Implement verification view state and renderer**

Extend `WorkbenchViewModel` with detached UI-facing snapshots:

```ts
readonly catalogConnection?: CloudCatalogConnectionViewModel;
readonly hybridCatalog?: HybridCatalogViewModel;
readonly verificationRoot: string;
readonly selectedVerificationGroupKeys: readonly string[];
```

Update all four values when the catalog runtime emits, preserving only group keys still present in the active hybrid catalog. Add controller actions:

```ts
setVerificationRoot(value: string): void;
toggleVerificationGroup(groupKey: string): void;
startSelectedVerification(): Promise<void>;
resumeSelectedVerification(): Promise<void>;
cancelSelectedVerification(): void;
```

`startSelectedVerification` delegates to the existing `requestLargeCatalogVerification` and existing confirmation presenter. It must not bypass root normalization, the parent-root guard, maximum-five selection, or confirmation.

Create `catalog-message-presenter.ts` as a pure mapping from fixed message codes to translated `{ title, preservation, nextAction }` values. Never accept or interpolate arbitrary `Error.message` for credential, authorization, or Baidu failures.

Update `presentCatalogProgress(connection, i18n)` to localize status, counts, elapsed time, and stop reason while preserving exact list-request counts.

- [x] **Step 4: Run verification, settings, and hybrid integration tests**

Run:

```bash
npx vitest run tests/ui/verification-page.test.ts tests/ui/catalog-message-presenter.test.ts tests/ui/workbench-controller.test.ts tests/ui/settings-sections.test.ts tests/integration/catalog-large-verification.test.ts tests/integration/catalog-hybrid-composition.test.ts
```

Expected: PASS. Starting with no category or a category leaf as the parent root must issue zero list calls and show a translated local validation error.

- [x] **Step 5: Commit the verification page**

```bash
git add src/i18n/workbench-i18n.ts src/ui/verification-page.ts src/ui/catalog-message-presenter.ts src/ui/catalog-progress-presenter.ts src/ui/workbench-controller.ts src/ui/workbench-view.ts styles.css tests/helpers/ui-fixtures.ts tests/ui/verification-page.test.ts tests/ui/catalog-message-presenter.test.ts tests/ui/workbench-controller.test.ts tests/ui/settings-sections.test.ts
git commit -m "feat(核验): 增加中文范围与恢复页面"
```

### Checkpoint B: Stop and report

Run before stopping:

```bash
npx vitest run tests/ui/settings-sections.test.ts tests/ui/settings-tab.test.ts tests/ui/cloud-catalog-tab.test.ts tests/ui/verification-page.test.ts tests/ui/catalog-message-presenter.test.ts tests/ui/workbench-controller.test.ts tests/ui/workbench-view.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/integration/catalog-large-verification.test.ts tests/integration/catalog-hybrid-composition.test.ts
git status --short --branch
git rev-parse HEAD
```

Report the required engineering-sample fields. Do not begin Task 7 in the same turn.

## Checkpoint C — fuzzy directory picker, complete localization, and release gates

### Task 7: Implement deterministic local fuzzy directory search

**Files:**
- Create: `src/catalog/cloud-directory-search.ts`
- Create: `tests/unit/catalog/cloud-directory-search.test.ts`

- [x] **Step 1: Write failing ranking tests**

```ts
import { describe, expect, it } from "vitest";
import { rankCloudDirectories } from "../../../src/catalog/cloud-directory-search";

const directories = [
  { path: "/Synthetic/Topics/Modern literature", filename: "Modern literature" },
  { path: "/Synthetic/9-Literature-253", filename: "9-Literature-253" },
  { path: "/Synthetic/Updates/Chinese literature", filename: "Chinese literature" },
];

describe("cloud directory search", () => {
  it("matches partial normalized text and ranks name prefixes before path matches", () => {
    expect(rankCloudDirectories(directories, "literature").map((value) => value.path))
      .toEqual([
        "/Synthetic/9-Literature-253",
        "/Synthetic/Topics/Modern literature",
        "/Synthetic/Updates/Chinese literature",
      ]);
  });

  it("matches Chinese fragments and numeric fragments without pinyin inference", () => {
    const values = [
      { path: "/Synthetic/9-文学253册", filename: "9-文学253册" },
      { path: "/Synthetic/哲学601册", filename: "哲学601册" },
    ];
    expect(rankCloudDirectories(values, "文学").map((value) => value.path))
      .toEqual(["/Synthetic/9-文学253册"]);
    expect(rankCloudDirectories(values, "253").map((value) => value.path))
      .toEqual(["/Synthetic/9-文学253册"]);
    expect(rankCloudDirectories(values, "wenxue")).toEqual([]);
  });

  it("returns detached results with deterministic path tie-breaking", () => {
    const result = rankCloudDirectories(directories, "synthetic");
    expect(result.map((value) => value.path)).toEqual([...result.map((value) => value.path)].sort());
    expect(result).not.toBe(directories);
  });
});
```

- [x] **Step 2: Run the test and verify the missing module failure**

Run:

```bash
npx vitest run tests/unit/catalog/cloud-directory-search.test.ts
```

Expected: FAIL because `cloud-directory-search.ts` does not exist.

- [x] **Step 3: Implement normalization and ranking**

Use a deterministic, non-AI scorer:

```ts
export interface CloudDirectoryCandidate {
  readonly path: string;
  readonly filename: string;
}

export interface RankedCloudDirectory extends CloudDirectoryCandidate {
  readonly score: number;
}

const normalize = (value: string): string => value
  .normalize("NFC")
  .toLocaleLowerCase("en-US")
  .replace(/[\s._—\-/]+/gu, " ")
  .trim();

const score = (candidate: CloudDirectoryCandidate, query: string): number | null => {
  const name = normalize(candidate.filename);
  const path = normalize(candidate.path);
  const tokens = normalize(query).split(" ").filter((value) => value.length > 0);
  if (tokens.length === 0) return 0;
  if (!tokens.every((token) => name.includes(token) || path.includes(token))) return null;
  const joined = tokens.join(" ");
  if (name === joined) return 0;
  if (name.startsWith(joined)) return 10 + name.length;
  const nameIndex = name.indexOf(joined);
  if (nameIndex >= 0) return 100 + nameIndex;
  return 1_000 + path.indexOf(joined);
};

export const rankCloudDirectories = (
  candidates: readonly CloudDirectoryCandidate[],
  query: string,
): readonly RankedCloudDirectory[] => candidates
  .map((candidate) => ({ ...candidate, score: score(candidate, query) }))
  .filter((candidate): candidate is RankedCloudDirectory => candidate.score !== null)
  .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path));
```

If the second ranking assertion exposes a mismatch between the approved ranking description and this exact scorer, adjust the numeric bands, not the product scope. Do not add pinyin, edit distance, embeddings, or a dependency.

- [x] **Step 4: Run the ranking tests**

Run:

```bash
npx vitest run tests/unit/catalog/cloud-directory-search.test.ts
```

Expected: PASS with zero network fakes or Obsidian imports in the test module.

- [x] **Step 5: Commit local fuzzy search**

```bash
git add src/catalog/cloud-directory-search.ts tests/unit/catalog/cloud-directory-search.test.ts
git commit -m "feat(目录): 增加本地模糊文件夹搜索"
```

### Task 8: Add bounded session-only cloud directory discovery

**Files:**
- Create: `src/catalog/cloud-directory-discovery-service.ts`
- Create: `tests/unit/catalog/cloud-directory-discovery-service.test.ts`
- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `src/catalog/disabled-cloud-catalog-runtime.ts`
- Modify: `src/catalog/offline-cloud-catalog-runtime.ts`
- Modify: `src/runtime/normal-cloud-catalog-composition.ts`
- Modify: `tests/fakes/fake-cloud-catalog-runtime.ts`
- Modify: `tests/integration/catalog-offline-composition.test.ts`
- Modify: `tests/packaging/composition-roots.test.ts`

- [x] **Step 1: Write failing request-boundary tests**

Test five invariants:

1. `searchCached("literature")` issues zero source calls;
2. `/` and malformed roots fail before a source call;
3. one explicit discovery counts each `beforeRequest`, including a token-refresh retry;
4. cancellation and all three limits return fixed stop reasons;
5. only directories inside the confirmed root enter the cache.

Use this synthetic source shape:

```ts
const source: BaiduCatalogSourcePort = {
  async listDirectory(input) {
    await input.beforeRequest();
    calls.push({ path: input.path, start: input.start });
    return {
      entries: input.path === "/Synthetic"
        ? [
            {
              fsId: "1",
              path: "/Synthetic/9-Literature-253",
              filename: "9-Literature-253",
              sizeBytes: 0,
              serverModifiedAt: 1,
              isDirectory: true,
            },
            {
              fsId: "2",
              path: "/Synthetic/ignored.pdf",
              filename: "ignored.pdf",
              sizeBytes: 10,
              serverModifiedAt: 1,
              isDirectory: false,
            },
          ]
        : [],
    };
  },
};
```

- [x] **Step 2: Run discovery tests and verify the missing service failure**

Run:

```bash
npx vitest run tests/unit/catalog/cloud-directory-discovery-service.test.ts tests/integration/catalog-offline-composition.test.ts tests/packaging/composition-roots.test.ts
```

Expected: FAIL because the discovery service and runtime capability do not exist.

- [x] **Step 3: Implement the fixed discovery contract**

Define immutable limits:

```ts
export const CLOUD_DIRECTORY_DISCOVERY_BUDGET = Object.freeze({
  maxDirectoryCount: 500,
  maxListRequestCount: 300,
  maxDurationMs: 1_800_000,
} as const);

export type CloudDirectoryDiscoveryStopReason =
  | "complete"
  | "user-canceled"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

export interface CloudDirectoryDiscoverySummary {
  readonly status: "complete" | "paused" | "canceled";
  readonly stopReason: CloudDirectoryDiscoveryStopReason;
  readonly rootPath: string;
  readonly directoryCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
}

export interface CloudDirectoryDiscoveryRuntime {
  searchCached(query: string): readonly RankedCloudDirectory[];
  discoverMore(rootPath: string, signal?: AbortSignal): Promise<CloudDirectoryDiscoverySummary>;
  clear(): void;
  dispose(): void;
}
```

Implement page-atomic breadth-first traversal with `normalizeCatalogScanRoot`, exact `beforeRequest` permits, normalized direct-child validation, duplicate `fsId`/path rejection, and session memory only. If committing a returned page would exceed 500 unique directories, discard that entire page and return `directory-limit`. Do not persist a checkpoint or directory cache.

Expose `readonly directoryDiscovery?: CloudDirectoryDiscoveryRuntime` on `CloudCatalogRuntime`. Compose it only in `createNormalCloudCatalogRuntime` using the same `baiduSource`. `CloudCatalogRuntimeService.dispose()` must call `directoryDiscovery.dispose()` exactly once. Offline and disabled runtimes omit it; their object graphs must not import the normal discovery service or source adapter.

- [x] **Step 4: Run unit, composition, and packaging tests**

Run:

```bash
npx vitest run tests/unit/catalog/cloud-directory-discovery-service.test.ts tests/integration/catalog-offline-composition.test.ts tests/packaging/composition-roots.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts
```

Expected: PASS. Packaging output must still contain no `method=download`, `filemanager`, `dlink`, upload, delete, rename, or move capability. The only new normal-build network path remains the existing `method=list` adapter.

- [x] **Step 5: Commit bounded discovery**

```bash
git add src/catalog/cloud-directory-discovery-service.ts src/catalog/cloud-catalog-runtime.ts src/catalog/disabled-cloud-catalog-runtime.ts src/catalog/offline-cloud-catalog-runtime.ts src/runtime/normal-cloud-catalog-composition.ts tests/unit/catalog/cloud-directory-discovery-service.test.ts tests/fakes/fake-cloud-catalog-runtime.ts tests/integration/catalog-offline-composition.test.ts tests/packaging/composition-roots.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts
git commit -m "feat(目录): 增加有界只读文件夹发现"
```

### Task 9: Add the fuzzy directory picker and wire automatic path filling

**Files:**
- Create: `src/ui/cloud-directory-picker.ts`
- Create: `tests/ui/cloud-directory-picker.test.ts`
- Modify: `src/runtime/runtime-composition.ts`
- Modify: `src/plugin/knowledge-workbench-plugin.ts`
- Modify: `src/main.ts`
- Modify: `src/main-acceptance.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/ui/settings-sections.ts`
- Modify: `src/ui/verification-page.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `tests/ui/verification-page.test.ts`
- Modify: `tests/integration/read-only-acceptance-automated-safety.test.ts`
- Modify: `styles.css`

- [x] **Step 1: Write failing picker interaction tests**

Use a fake discovery runtime and assert the exact request boundary:

```ts
class ModalSurface {
  readonly contentEl = document.createElement("div");
  constructor(readonly app: App) {}
  setTitle(value: string): void { this.contentEl.dataset.title = value; }
  open(): void { (this as unknown as { onOpen(): void }).onOpen(); }
  close(): void { (this as unknown as { onClose(): void }).onClose(); }
}

const fakeDirectoryDiscovery = (
  results: readonly RankedCloudDirectory[],
): CloudDirectoryDiscoveryRuntime & {
  readonly searchQueries: string[];
  readonly discoverCalls: string[];
} => {
  const searchQueries: string[] = [];
  const discoverCalls: string[] = [];
  return {
    searchQueries,
    discoverCalls,
    searchCached(query) { searchQueries.push(query); return structuredClone(results); },
    async discoverMore(rootPath) {
      discoverCalls.push(rootPath);
      return {
        status: "complete",
        stopReason: "complete",
        rootPath,
        directoryCount: results.length,
        listRequestCount: 1,
        elapsedMs: 1,
      };
    },
    clear: () => undefined,
    dispose: () => undefined,
  };
};

it("filters cached folders while typing and requires confirmation before discovery", async () => {
  const discovery = fakeDirectoryDiscovery([
    { path: "/Synthetic/9-文学253册", filename: "9-文学253册", score: 0 },
  ]);
  const Picker = createCloudDirectoryPickerModalClass(ModalSurface);
  const picker = new Picker({} as App, discovery, () => createWorkbenchI18n("zh-CN"));
  const result = picker.request({ initialRoot: "/Synthetic" });
  const input = picker.contentEl.querySelector<HTMLInputElement>('[data-directory-query="true"]')!;
  input.value = "文学";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(discovery.searchQueries).toEqual(["文学"]);
  expect(discovery.discoverCalls).toEqual([]);
  picker.contentEl.querySelector<HTMLButtonElement>('[data-action="search-more-directories"]')!.click();
  expect(discovery.discoverCalls).toEqual([]);
  picker.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm-directory-discovery"]')!.click();
  await Promise.resolve();
  expect(discovery.discoverCalls).toEqual(["/Synthetic"]);
  picker.contentEl.querySelector<HTMLButtonElement>('[data-directory-path="/Synthetic/9-文学253册"]')!.click();
  picker.contentEl.querySelector<HTMLButtonElement>('[data-action="use-directory"]')!.click();
  await expect(result).resolves.toBe("/Synthetic/9-文学253册");
});
```

Add tests for empty/non-root start rejection, Escape/cancel, focus restoration, cancellation during discovery, partial-limit explanation, no PDF rows, sanitized errors, and acceptance mode with no picker factory.

- [x] **Step 2: Run picker and host tests to verify failures**

Run:

```bash
npx vitest run tests/ui/cloud-directory-picker.test.ts tests/ui/settings-sections.test.ts tests/ui/verification-page.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts
```

Expected: FAIL because the picker presenter, runtime-composition factory, and browse actions do not exist.

- [x] **Step 3: Implement the modal and controller orchestration**

Define:

```ts
export interface CloudDirectoryPickerRequest {
  readonly initialRoot: string;
}

export interface CloudDirectoryPickerPresenter {
  request(input: CloudDirectoryPickerRequest): Promise<string | null>;
}
```

The modal holds only query text, selected path, confirmation visibility, and one `AbortController`. Typing calls `discovery.searchCached`. “Search more directories” first reveals the exact root and fixed budget; only the separate confirm button calls `discoverMore`. Closing aborts discovery, clears password-like drafts, detaches listeners, and resolves `null` once.

Add `RuntimeComposition.createCatalogDirectoryPicker(app, discovery, getLocale)` as an optional normal-only factory. Acceptance composition must not provide it.

Extend `WorkbenchDependencies` with:

```ts
readonly catalogDirectoryPicker?: CloudDirectoryPickerPresenter;
```

During plugin startup, construct the presenter only when both the normal runtime factory and `catalog.directoryDiscovery` are present, then pass the presenter into `WorkbenchController`. No presenter or discovery object may be constructed by the acceptance composition.

Add controller method:

```ts
async chooseCatalogRoot(initialRoot: string): Promise<string | null> {
  if (this.disposed) return null;
  const normalized = this.validateCatalogScanRoot(initialRoot);
  const discovery = this.dependencies.catalog.directoryDiscovery;
  const picker = this.dependencies.catalogDirectoryPicker;
  if (discovery === undefined || picker === undefined) throw new Error("catalog-unavailable");
  return picker.request({ initialRoot: normalized });
}
```

Wire “浏览网盘目录” in shared settings and verification. On a successful result, assign the returned normalized path to the session-only input and controller `verificationRoot`; do not save it to `PluginSettings`, SecretStorage, hybrid manifests, logs, or history.

- [x] **Step 4: Run picker, settings, verification, and safety tests**

Run:

```bash
npx vitest run tests/ui/cloud-directory-picker.test.ts tests/ui/settings-sections.test.ts tests/ui/verification-page.test.ts tests/ui/workbench-controller.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/packaging/composition-roots.test.ts
```

Expected: PASS. The tests must prove query input causes zero list calls and only the explicit second confirmation causes discovery.

- [x] **Step 5: Commit the directory picker**

```bash
git add src/i18n/workbench-i18n.ts src/ui/cloud-directory-picker.ts src/runtime/runtime-composition.ts src/plugin/knowledge-workbench-plugin.ts src/main.ts src/main-acceptance.ts src/ui/workbench-controller.ts src/ui/workbench-view.ts src/ui/settings-sections.ts src/ui/verification-page.ts styles.css tests/ui/cloud-directory-picker.test.ts tests/ui/settings-sections.test.ts tests/ui/verification-page.test.ts tests/ui/workbench-controller.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/packaging/composition-roots.test.ts
git commit -m "feat(目录): 增加模糊搜索选择器"
```

### Task 10: Localize remaining user-facing surfaces and accessibility text

**Files:**
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `src/ui/today-pane.ts`
- Modify: `src/ui/map-pane.ts`
- Modify: `src/ui/suggestions-tab.ts`
- Modify: `src/ui/history-tab.ts`
- Modify: `src/ui/ai-suggestion.ts`
- Modify: `src/ui/quick-capture-modal.ts`
- Modify: `src/ui/change-preview-modal.ts`
- Modify: `src/ui/ai-payload-preview-modal.ts`
- Modify: `src/ui/catalog-scan-confirmation-modal.ts`
- Modify: `src/ui/catalog-txt-import-confirmation-modal.ts`
- Modify: `src/ui/catalog-large-scan-confirmation-modal.ts`
- Modify: `src/ui/catalog-progress-presenter.ts`
- Modify: `src/runtime/runtime-composition.ts`
- Modify: `src/plugin/knowledge-workbench-plugin.ts`
- Modify: `src/main.ts`
- Modify: `src/main-acceptance.ts`
- Create: `tests/packaging/ui-localization-boundary.test.ts`
- Modify: corresponding tests under `tests/ui/`
- Modify: `tests/ui/accessibility.test.ts`

- [x] **Step 1: Write failing full-surface localization tests**

Add `tests/packaging/ui-localization-boundary.test.ts` to scan the listed UI source files and reject new hard-coded user strings in `textContent`, `setTitle`, `aria-label`, and button labels outside `workbench-i18n.ts`. Allow only fixed data identifiers, CSS classes, technical codes, and user data assignments.

Add parameterized UI tests that render each surface once with `zh-CN` and once with `en`. For sensitive modal tests, assert neither language output contains supplied secret/error detail.

- [x] **Step 2: Run the localization boundary and UI suite to capture every remaining English surface**

Run:

```bash
npx vitest run tests/packaging/ui-localization-boundary.test.ts tests/ui
```

Expected: FAIL with the exact remaining files and hard-coded labels.

- [x] **Step 3: Pass a locale provider through host factories and translate every remaining surface**

Extend user-facing factory signatures to accept:

```ts
type WorkbenchLocaleProvider = () => WorkbenchLocale;
```

In plugin startup, define the provider only after the store loads:

```ts
const getLocale: WorkbenchLocaleProvider = () => store.settings().locale;
```

Pass it to Quick Capture, change preview, history confirmation, AI preview, catalog confirmation, TXT import confirmation, large verification confirmation, directory picker, settings surface, ribbon label, and command label. Pure page renderers receive `WorkbenchI18n` from `model.locale`.

Add exact translated keys for all current status, action, modal, empty-state, failure, ARIA, tooltip, and confirmation strings. Dynamic file names and paths remain original user data and are never translated. Runtime error objects remain excluded from credential/catalog messages.

Use these fixed key namespaces so the boundary test can identify ownership without string heuristics:

| Namespace | Surface |
| --- | --- |
| `today.*` | Today filters, reasons, explanations, and actions |
| `map.*` | Map search, filters, node details, progress, and ARIA labels |
| `suggestions.*` | Selection, preview, local/AI actions, and empty states |
| `history.*` | Undo, recovery, export, clear confirmation, and status |
| `quickCapture.*` | Modal title, field labels, cancel, and create action |
| `changePreview.*` | Preview title, write boundary, confirm, and cancel |
| `ai.*` | Payload preview, local fallback, disabled state, and safe errors |
| `catalog.confirm.*` | Small scan and TXT import confirmation |
| `verification.confirm.*` | Category start/resume confirmation and budgets |
| `progress.*` | Scan status, counts, elapsed time, and stop reasons |
| `acceptance.*` | Read-only build banners and unavailable-feature notices |
| `host.*` | Ribbon, command, view title, and host-action fallbacks |

Registered Obsidian command and ribbon labels use the locale present at plugin load. Workbench and both settings hosts update immediately after `setLocale`; changing registered host command text does not require mutating Obsidian internals during the session.

- [x] **Step 4: Run the full UI, accessibility, and packaging localization tests**

Run:

```bash
npx vitest run tests/packaging/ui-localization-boundary.test.ts tests/ui tests/integration/read-only-acceptance-automated-safety.test.ts tests/packaging/composition-roots.test.ts
```

Expected: PASS. Both locales must retain focus, ARIA relationships, modal Escape behavior, disabled states, and read-only acceptance restrictions.

- [x] **Step 5: Commit complete localization**

```bash
git add src/i18n/workbench-i18n.ts src/ui/today-pane.ts src/ui/map-pane.ts src/ui/suggestions-tab.ts src/ui/history-tab.ts src/ui/ai-suggestion.ts src/ui/quick-capture-modal.ts src/ui/change-preview-modal.ts src/ui/ai-payload-preview-modal.ts src/ui/catalog-scan-confirmation-modal.ts src/ui/catalog-txt-import-confirmation-modal.ts src/ui/catalog-large-scan-confirmation-modal.ts src/ui/catalog-progress-presenter.ts src/runtime/runtime-composition.ts src/plugin/knowledge-workbench-plugin.ts src/main.ts src/main-acceptance.ts tests/packaging/ui-localization-boundary.test.ts tests/ui/accessibility.test.ts tests/ui/ai-preview-modal.test.ts tests/ui/catalog-large-scan-confirmation-modal.test.ts tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/catalog-txt-import-confirmation-modal.test.ts tests/ui/change-preview-modal.test.ts tests/ui/history-tab.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/ui/workbench-view.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/packaging/composition-roots.test.ts
git commit -m "feat(界面): 完成插件双语与无障碍文案"
```

Inspect the staged diff before committing so generated artifacts, `.superpowers/`, secrets, catalog snapshots, and unrelated Markdown files remain unstaged.

### Task 11: Run complete regression, performance, build, and synthetic installation gates

**Files:**
- Modify only if a gate exposes a real defect: files already listed in Tasks 1–10
- Verify: `main.js`, `manifest.json`, `styles.css`
- Verify: `.dev-vault/baidu-catalog-oob/.obsidian/plugins/knowledge-workbench/`

- [x] **Step 1: Run the complete deterministic test suite serially**

```bash
npx vitest run --no-file-parallelism --maxWorkers=1
```

Expected: all test files and tests PASS. Record the exact counts and duration; do not reuse counts from an earlier commit.

- [x] **Step 2: Run the catalog product-performance gate**

```bash
npm run test:catalog-performance
KNOWLEDGE_WORKBENCH_PERFORMANCE=1 npx vitest run tests/performance/hybrid-catalog-search.bench.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=180000 --reporter=verbose
```

Expected: both commands PASS at the existing 100,000/70,000-record product thresholds. Record measured output without inventing a performance conclusion beyond the asserted gates.

- [x] **Step 3: Run lint and both builds**

```bash
npm run lint
npm run build
npm run build:acceptance
```

Expected: each command exits 0. Existing baseline warnings may remain only if the warning count and files are unchanged; new warnings introduced by this branch must be fixed.

- [x] **Step 4: Re-run packaging and safety assertions against built artifacts**

```bash
npx vitest run tests/packaging/composition-roots.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: PASS. Normal output may contain only the existing Baidu list/OAuth network composition; acceptance output contains neither network nor mutable configuration capabilities.

- [x] **Step 5: Install the normal build into the fixed synthetic Vault while disabled**

First verify Obsidian is closed and the synthetic Vault marker and disabled-community-plugin state are intact. Then run:

```bash
OBSIDIAN_DEV_VAULT="/Users/example/Documents/obsidian-knowledge-workbench/.dev-vault/baidu-catalog-oob" npm run install:dev
```

Expected: the installer reports success, does not start Obsidian, leaves the plugin disabled, and installs only `main.js`, `manifest.json`, and `styles.css` into the fixed synthetic Vault.

- [x] **Step 6: Verify source/destination hashes and forbidden data absence**

```bash
shasum -a 256 main.js manifest.json styles.css
shasum -a 256 .dev-vault/baidu-catalog-oob/.obsidian/plugins/knowledge-workbench/main.js .dev-vault/baidu-catalog-oob/.obsidian/plugins/knowledge-workbench/manifest.json .dev-vault/baidu-catalog-oob/.obsidian/plugins/knowledge-workbench/styles.css
rg -n "sk-private|sk-session-private|/Volumes/example-drive/全部文件/科学文库" main.js styles.css .dev-vault/baidu-catalog-oob/.obsidian/plugins/knowledge-workbench || true
```

Expected: corresponding hashes match. The forbidden-data scan returns no credential, authorization, local-volume path, or user-specific breadcrumb value. Fixed safe UI documentation strings must use synthetic examples only.

- [x] **Step 7: Perform local visual acceptance without a Baidu request**

Temporarily enable the plugin only in the dedicated synthetic Vault, do not connect or start discovery, and verify:

1. Chinese is the default and English switches immediately;
2. both light and dark Obsidian themes retain readable contrast and focus outlines;
3. the five destinations remain vertically on the left at wide and narrow widths;
4. Start retains Today, Map, suggestions, and Quick Capture policy behavior;
5. settings cards are shared, grouped, and secrets are never rendered as text;
6. My Catalog shows synthetic results, selection details, and the PDF-content warning;
7. Cloud Verification explains the path format and safety boundary;
8. typing in the fuzzy directory search produces zero network requests;
9. do not click the confirmed “search more directories” action in this acceptance pass;
10. close Obsidian and leave the plugin disabled after inspection.

Record only observed UI results. Do not copy a directory path, AppKey, SecretKey, authorization code, filename, or catalog content into the report.

- [x] **Step 8: Commit any verified gate fix, otherwise keep the prior commit as final**

If a real defect required a code change, first run `git status --short` and `git diff --check`, list each reviewed fix path explicitly in the checkpoint notes, stage only those paths with separate `git add -- path` arguments, rerun the directly affected test plus Steps 1–4, and commit with `git commit -m "fix(界面): 修正最终验收缺陷"`. If no code changed, do not create an empty commit.

### Checkpoint C: Stop and report completion evidence

Run:

```bash
git status --short --branch
git rev-parse HEAD
git log --oneline --max-count=12
```

Report:

- current Git commit;
- Tasks 7–11 completed functionality;
- exact full-suite, performance, lint, build, packaging, hash, and synthetic acceptance results;
- wrong directions and rework count for this checkpoint;
- available input-token statistics;
- PMH recall count and token amount without memory content;
- cross-project or cross-model pollution result;
- confirmation that no real Baidu request, PDF download, or real Vault write occurred.

Do not start another experiment or a real cloud search after reporting.
