# Knowledge Workbench 极简自动化界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将知识工作台收口为“文库、任务、更多”三入口，让目录搜索成为默认首页，并通过一个状态驱动主动作完成 TXT 导入、百度连接、书库绑定、分类核验、暂停和恢复，同时保留全部只读、安全配额与检查点语义。

**Architecture:** 在现有 controller 与领域运行时之间增加纯 `LibraryWorkflowState` 派生层；用持久化的非根书库绑定和会话级 TXT 草稿补齐自动化状态；把目录选择器的状态机从 Obsidian Modal 抽成可复用 session，并在工作台内联子页面承载；保留现有 OAuth、SecretStorage、TXT、overlay、checkpoint、自动分段和事务服务，只重组展示、路由和启动适配层。

**Tech Stack:** TypeScript 5.8、Vitest 4、jsdom、Obsidian 1.13 API、现有百度网盘目录运行时、原生 DOM/CSS Container Queries、ESLint 9、esbuild。

---

## Scope and safety invariants

- 以 `docs/superpowers/specs/2026-09-01-knowledge-workbench-simplified-automatic-ui-design.md` 为已经批准的产品合同。
- 实施基线为分支 `codex/verification-progress-auto-resume` 上的设计提交 `6efac79`；本计划提交只增加文档，不修改业务代码。
- 不暂存、修改、重命名或删除仓库根目录现存的 11 个未跟踪研究 Markdown 文件。
- 不使用 PMH，不读取其他实验任务，不运行以前的 A/B benchmark、long-pilot、public-v1、性能 benchmark 或压力脚本，不创建实验快照；本计划只运行功能、隔离、构建与静态门禁。
- 自动化测试只使用合成路径、目录、分类、凭据占位符、时钟、批次、DOM 和网络响应；不得执行真实 OAuth、真实百度请求、真实 TXT 导入、PDF 下载、真实 Vault 写入或插件安装。
- 默认首页和插件启动必须保持离线；只有用户点击当前可见任务卡的主动作，才允许进入已有的显式联网动作。
- 不能删除安全校验。重复确认 Modal 可以退出工作台主流程，但其中的路径、分类、数量、结构化选择和防篡改校验必须抽成纯函数并继续在 runtime 调用前执行。
- `/` 只能在原有受限浏览披露后作为浏览入口，不能绑定、选择、扫描或核验；绑定书库必须是规范化非根路径。
- 最近目录仍只是候选历史，不能在升级、启动或重绘时静默成为正式书库绑定。
- 推荐分类只准备本地草稿；不得覆盖可恢复批次、扩大分类集合或发起网络请求。
- 每次默认只核验一个分类。原有最多 5 个分类能力保留在“任务 → 更换分类 → 高级”，不出现在默认任务卡；高级选择仍回到同一张可见任务卡启动。
- 不制造当前分类的完成百分比。全库覆盖率可以确定显示；当前云端递归活动保持不确定；分段 PDF 只表示安全配额。
- 错误、日志和操作历史不得显示 AppKey、SecretKey、授权码、原始真实路径或百度响应正文。
- 每个实现任务遵循 RED → focused GREEN → relevant regression → 单独中文 conventional commit；只暂存该任务列出的文件。

## Final file responsibility map

新增生产文件：

- `src/storage/cloud-library-binding.ts` — 书库绑定字段的 fail-closed 解码。
- `src/ui/library-workflow-state.ts` — 纯任务状态、唯一主动作和稳定分类推荐。
- `src/ui/workbench-route.ts` — 三入口与内联子页面的合法路由联合类型。
- `src/ui/local-catalog-txt-picker.ts` — 用户主动选择一个本地 TXT 的会话级宿主适配。
- `src/catalog/verification-launch-request.ts` — 从重复确认框抽出的启动/恢复防篡改校验。
- `src/ui/cloud-directory-picker-session.ts` — 无 Modal 依赖的目录选择状态机。
- `src/ui/folder-selection-host.ts` — acceptance-safe 的内联目录页渲染端口，不导入任何百度可执行能力。
- `src/ui/folder-selection-page.ts` — 内联书库目录搜索和受限浏览页面。
- `src/runtime/normal-folder-selection-composition.ts` — 仅 normal 构建注入目录 session、浏览器和内联页。
- `src/ui/library-page.ts` — 搜索优先的文库首页和轻量任务提醒。
- `src/ui/task-page.ts` — 状态驱动唯一主动作、真实覆盖率和运行详情。
- `src/ui/more-page.ts` — 低频摘要与设置、历史、知识工具子页面路由。

新增测试文件：

- `tests/unit/storage/cloud-library-binding.test.ts`
- `tests/ui/library-workflow-state.test.ts`
- `tests/ui/workbench-route.test.ts`
- `tests/ui/local-catalog-txt-picker.test.ts`
- `tests/unit/catalog/verification-launch-request.test.ts`
- `tests/ui/cloud-directory-picker-session.test.ts`
- `tests/ui/folder-selection-page.test.ts`
- `tests/ui/library-page.test.ts`
- `tests/ui/task-page.test.ts`
- `tests/ui/more-page.test.ts`

重点修改文件：

- `src/storage/plugin-data.ts`, `src/storage/plugin-data-store.ts` — 新增带活动 TXT 来源哈希的 nullable 书库绑定，外层 schema 仍为 1。
- `src/catalog/large-catalog-verification-progress.ts`, `src/catalog/hybrid-catalog-runtime.ts` — 向只读 view 暴露活动 TXT 来源哈希和可恢复批次的精确分类集合。
- `src/ui/workbench-shell.ts`, `src/ui/workbench-view.ts`, `src/ui/workbench-controller.ts` — 三入口路由、workflow 快照和主动作接线。
- `src/ui/cloud-directory-picker.ts` — 改为复用 session 的薄 Modal 适配，保留高级/兼容入口。
- `src/ui/cloud-catalog-tab.ts` — 搜索结果详情改为按需展示，不固定遮挡右栏。
- `src/ui/settings-sections.ts`, `src/ui/settings-tab.ts` — 单分组复用并移除第二套分类核验控件。
- `src/ui/catalog-large-scan-confirmation-modal.ts` — 复用纯 launch 校验器，不再拥有私有安全合同。
- `src/i18n/workbench-i18n.ts`, `src/i18n/workbench-directory-picker-i18n.ts`, `styles.css` — 中英文、ARIA、响应式和原生表面。
- `src/plugin/knowledge-workbench-plugin.ts`, `src/main.ts`, `src/main-acceptance.ts` 与 runtime composition — TXT picker 由 Workbench View 显式创建；目录页通过 normal-only capability 注入，acceptance composition 继续排除百度浏览依赖。
- `tests/helpers/ui-fixtures.ts` 及现有 UI、storage、packaging、acceptance 测试 — 完整类型与兼容回归。

## Task 1: Persist only an explicitly bound non-root cloud library

**Files:**

- Create: `src/storage/cloud-library-binding.ts`
- Create: `tests/unit/storage/cloud-library-binding.test.ts`
- Modify: `src/storage/plugin-data.ts`
- Modify: `src/storage/plugin-data-store.ts`
- Modify: `tests/unit/storage/plugin-data-store.test.ts`
- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/unit/runtime/safety-policy.test.ts`
- Modify: `tests/integration/read-only-acceptance-automated-safety.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/ui/settings-tab.test.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `tests/ui/read-only-acceptance-surfaces.test.ts`
- Modify: `tests/packaging/synthetic-acceptance-data.test.ts`
- Modify: `scripts/synthetic-acceptance-data.mjs`

- [ ] **Step 1: Write the failing binding codec tests**

Create `tests/unit/storage/cloud-library-binding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeBoundCloudLibrary } from "../../../src/storage/cloud-library-binding";

describe("cloud library binding", () => {
  it("accepts only a normalized non-root path bound to one TXT source", () => {
    expect(decodeBoundCloudLibrary({
      schemaVersion: 1,
      path: "/Ke\u0301xue",
      sourceImportSha256: "a".repeat(64),
    })).toEqual({
      schemaVersion: 1,
      path: "/Kéxue",
      sourceImportSha256: "a".repeat(64),
    });
    for (const value of [
      undefined,
      null,
      "/科学文库",
      { schemaVersion: 1, path: "/", sourceImportSha256: "a".repeat(64) },
      { schemaVersion: 1, path: "/A", sourceImportSha256: "A".repeat(64) },
      { schemaVersion: 2, path: "/A", sourceImportSha256: "a".repeat(64) },
    ]) expect(decodeBoundCloudLibrary(value)).toBeNull();
  });
});
```

Extend `tests/unit/storage/plugin-data-store.test.ts` to prove that legacy settings without the field decode to `null`, valid values round-trip, malformed values fail closed without resetting unrelated settings, recent directories never promote themselves, and unknown outer schemas preserve only a separately valid binding while retaining the existing write/AI downgrade.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run tests/unit/storage/cloud-library-binding.test.ts tests/unit/storage/plugin-data-store.test.ts
```

Expected: FAIL because `cloud-library-binding.ts` and `PluginSettings.boundCloudLibrary` do not exist.

- [ ] **Step 3: Implement the nullable field without changing outer schema**

Add to `PluginSettings`:

```ts
export interface BoundCloudLibraryV1 {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly sourceImportSha256: string;
}

readonly boundCloudLibrary: BoundCloudLibraryV1 | null;
```

Implement the helper:

```ts
import { normalizeCatalogScanRoot } from "../catalog/catalog-path";
import type { BoundCloudLibraryV1 } from "./plugin-data";

const SHA256 = /^[a-f0-9]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

export const decodeBoundCloudLibrary = (value: unknown): BoundCloudLibraryV1 | null => {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.path !== "string" || typeof value.sourceImportSha256 !== "string") return null;
  if (!SHA256.test(value.sourceImportSha256)) return null;
  try {
    return {
      schemaVersion: 1,
      path: normalizeCatalogScanRoot(value.path),
      sourceImportSha256: value.sourceImportSha256,
    };
  } catch {
    return null;
  }
};
```

Set `boundCloudLibrary: null` in `defaultSettings()` and decode it independently in `decodeSettings()`. Keep outer `schemaVersion: 1`; the current field-level codec is the migration. Add the field to every complete `PluginSettings` fixture and to `KNOWN_SETTING_KEYS`, but keep the synthetic seed missing the field so packaging tests continue to exercise legacy migration. Never upgrade a recent directory or a path-only legacy value into a source-bound library.

- [ ] **Step 4: Verify codec, storage, policy, and packaging fixtures**

```bash
npx vitest run \
  tests/unit/storage/cloud-library-binding.test.ts \
  tests/unit/storage/plugin-data-store.test.ts \
  tests/unit/runtime/safety-policy.test.ts \
  tests/packaging/synthetic-acceptance-data.test.ts
```

Expected: PASS; old/path-only data yields `null`; malformed hashes and roots fail closed; no recent directory is promoted; no index, staging, credential, or journal field is reset by this additive setting.

- [ ] **Step 5: Commit Task 1**

```bash
git add \
  src/storage/cloud-library-binding.ts \
  src/storage/plugin-data.ts \
  src/storage/plugin-data-store.ts \
  tests/unit/storage/cloud-library-binding.test.ts \
  tests/unit/storage/plugin-data-store.test.ts \
  tests/helpers/ui-fixtures.ts \
  tests/unit/runtime/safety-policy.test.ts \
  tests/integration/read-only-acceptance-automated-safety.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts \
  tests/packaging/synthetic-acceptance-data.test.ts \
  scripts/synthetic-acceptance-data.mjs
git commit -m "feat(设置): 保存明确选择的云端书库"
git status --short
```

Expected: commit succeeds; only the 11 pre-existing untracked research files remain.

## Task 2: Derive one finite workflow state and one primary action

**Files:**

- Create: `src/ui/library-workflow-state.ts`
- Create: `tests/ui/library-workflow-state.test.ts`
- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`

- [ ] **Step 1: Write the exhaustive failing state table**

Create table-driven tests for all 12 states and precedence conflicts. The public contract must be:

```ts
export type LibraryWorkflowKind =
  | "needs-txt"
  | "confirm-txt-import"
  | "needs-connection"
  | "needs-library"
  | "ready"
  | "running"
  | "paused"
  | "repair-connection"
  | "repair-library"
  | "retry-later"
  | "complete"
  | "unavailable";

export type LibraryPrimaryAction =
  | "choose-txt"
  | "import-txt"
  | "open-connection"
  | "choose-library"
  | "start"
  | "pause"
  | "resume"
  | "retry"
  | "open-library";

export interface LibraryWorkflowState {
  readonly kind: LibraryWorkflowKind;
  readonly primaryAction: LibraryPrimaryAction;
  readonly titleKey: WorkbenchMessageKey;
  readonly descriptionKey: WorkbenchMessageKey;
  readonly recommendedGroup: HybridCatalogGroupViewModel | null;
  readonly canShowTechnicalDetails: boolean;
}
```

Representative assertions:

```ts
expect(deriveLibraryWorkflowState({
  connection: { status: "authorized" },
  hybrid: pausedHybrid,
  boundCloudLibrary: {
    schemaVersion: 1,
    path: "/科学文库",
    sourceImportSha256: "a".repeat(64),
  },
  hasPendingTxtPath: false,
  capabilityAvailable: true,
})).toMatchObject({ kind: "paused", primaryAction: "resume" });

expect(recommendNextVerificationGroup([
  group("first", 252, "unverified"),
  group("second", 122, "unverified"),
  group("third", 122, "unverified"),
])?.groupKey).toBe("second");
```

Also assert: an actively running batch outranks setup states so it can always be paused; a merely resumable batch does **not** outrank connection or binding validation; token/auth faults outrank ready; path mismatch outranks ready; no active TXT outranks connection; a missing binding or a binding whose `sourceImportSha256` differs from the active TXT always yields `needs-library` before resume/retry; previewed TXT requires a retained session path; `txt-root-items` is never recommended; verified/difference groups are skipped; equal counts keep the input order; every table row has exactly one primary action; calling the functions mutates no input and performs no async work.

Add a session-only `supersededRecoveryBatchId: string | null` input. It may match only the currently displayed failed batch after the user has successfully completed that state's explicit repair action. When it matches, retain the old checkpoint/read model for details but do not let its old repair code outrank a new source-matched binding and start draft. It is never persisted, never set by navigation/repaint, and is cleared when the active source changes, a different batch appears, or the app restarts. Add state-table tests proving repair → explicit reselect → ready changes the primary action without deleting the old checkpoint. If `hybrid-snapshot-corrupt` has no active catalog, map to `needs-txt`/“重新选择目录 TXT” with safe details—not `choose-library`, which cannot succeed without an active catalog.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run tests/ui/library-workflow-state.test.ts
```

Expected: FAIL because `library-workflow-state.ts` does not exist.

- [ ] **Step 3: Implement deterministic recommendation and precedence**

Use one explicit priority ladder, not scattered DOM conditions:

```ts
const CONNECTION_REPAIR = new Set([
  "baidu-token-expired",
  "baidu-permission-denied",
  "credentials-unavailable",
  "authorization-attempt-unavailable",
]);
const LIBRARY_REPAIR = new Set([
  "baidu-not-found",
  "hybrid-cloud-root-mismatch",
  "invalid-large-catalog-root",
  "invalid-scan-root",
]);
const RETRY_LATER = new Set([
  "baidu-rate-limited",
  "baidu-access-unavailable",
]);
const INTEGRITY_REPAIR = new Set([
  "invalid-baidu-response",
  "hybrid-snapshot-corrupt",
  "hybrid-batch-invalid",
]);
```

Expose the active source identity already held by `HybridCatalogRuntimeService`:

```ts
export interface HybridCatalogActiveSummary {
  readonly sourceImportSha256: string;
  // existing aggregate and group fields
}
```

Populate it from `candidates.descriptor.sourceSha256`, clone it as a scalar, and cover reload/import snapshots in `hybrid-catalog-runtime.test.ts`. The workflow may trust only this validated read model, not an independent controller cache.

Derive in this order: unavailable → active running (so pause remains reachable) → no active TXT / pending preview → connection/authorization repair → source-matched non-root binding → unsuperseded path/integrity repair for an existing batch → retry only when `batch.resumeAvailable === true` and the stop reason is rate-limit/access-unavailable → resumable batch → complete → ready. `invalid-baidu-response` and batch consistency anomalies with a valid active catalog map to `repair-library` with “重新选择书库” as the primary action and technical details as a secondary disclosure; they never map to resume. Snapshot corruption without an active catalog maps to TXT recovery. Copy the chosen group before returning it. `recommendNextVerificationGroup()` must compare `{pdfCount, originalIndex}` and never sort the source array in place. Add only the 12 workflow title/description keys to both dictionaries in this task so the `WorkbenchMessageKey` contract compiles; Task 11 adds the remaining page, action, pending and accessibility copy.

- [ ] **Step 4: Verify and commit Task 2**

```bash
npx vitest run \
  tests/ui/library-workflow-state.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git add \
  src/ui/library-workflow-state.ts \
  src/catalog/hybrid-catalog-runtime.ts \
  src/i18n/workbench-i18n.ts \
  tests/ui/library-workflow-state.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git commit -m "feat(任务): 派生唯一工作流主动作"
git status --short
```

Expected: all workflow rows and precedence tests PASS.

## Task 3: Add safe session-only TXT selection and import draft state

**Files:**

- Create: `src/ui/local-catalog-txt-picker.ts`
- Create: `tests/ui/local-catalog-txt-picker.test.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/ui/read-only-acceptance-surfaces.test.ts`

- [ ] **Step 1: Write failing picker and controller draft tests**

The picker must expose only one explicit host action:

```ts
export interface LocalCatalogTxtPicker {
  request(host: HTMLElement): Promise<string | null>;
}

export const createLocalCatalogTxtPicker = (): LocalCatalogTxtPicker => ({
  request: (host) => requestLocalCatalogTxtPath(host),
});
```

Tests must prove: `accept=".txt,text/plain"`; cancel returns `null`; only a selected host file with a non-empty native `path` resolves; the input is removed after settle; repeated `change`/cancel cannot resolve twice; no path is persisted. Task 9 will gate the host action out of acceptance mode when it wires the picker into the task page.

Controller tests must prove:

```ts
const revision = controller.snapshot().taskActionRevision;
await controller.previewTaskCatalogTxt("/Synthetic/catalog.txt", revision);
expect(controller.snapshot().pendingCatalogTxtPath).toBe("/Synthetic/catalog.txt");
expect(controller.snapshot().workflow.kind).toBe("confirm-txt-import");

await controller.importPreviewedTaskCatalogTxt();
expect(controller.snapshot().pendingCatalogTxtPath).toBeNull();
expect(controller.settings().boundCloudLibrary).toBeNull();
```

Also assert: preview failure retains neither path nor false success; a stale revision is rejected before reading the path; canceled import keeps the pending path and old active catalog; successful replacement clears the bound library but leaves recent directory candidates unchanged; if TXT activation commits and projection refresh or binding cleanup then fails, the old binding/source hash mismatch still derives `needs-library` and cannot start; no action fires on controller construction or snapshot.

Add credential-identity regression tests here because these controller paths already change OAuth/SecretStorage state: before replacing credentials, submitting a new authorization attempt, or revoking credentials, `invalidateCloudIdentityState()` must durably clear the binding, structured selection and task selection draft. If that settings write fails, abort before touching credentials/tokens. After a new authorization identity succeeds, mark the current failed batch as session-only `supersededRecoveryBatchId`; it remains visible in details but can neither resume under a potentially different account nor force another connection-repair loop. Refreshing an existing token inside the same authorization session is not a new identity, does not clear the binding, and may resume the original checkpoint. A newly authorized account must always choose a library again and start a new batch.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/ui/local-catalog-txt-picker.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts
```

Expected: FAIL because the picker, draft fields, and task-specific controller methods do not exist.

- [ ] **Step 3: Implement the picker and controller draft lifecycle**

Use a hidden file input appended only for the current request. Read the Electron/Obsidian native path fail-closed:

```ts
type NativePathFile = File & Readonly<{ path?: unknown }>;

const nativePath = (file: NativePathFile | undefined): string | null => (
  file !== undefined && typeof file.path === "string" && file.path.length > 0
    ? file.path
    : null
);
```

Add `pendingCatalogTxtPath: string | null`, controller-owned `taskActionPending: boolean`, `taskActionRevision` and derived `workflow` to `WorkbenchViewModel` and its fixtures. Maintain one private semantic key built from `{activeSourceImportSha256, boundSourceImportSha256, boundRoot, primaryAction, selectedGroupKeys, batchId, runOrdinal, messageCode, supersededRecoveryBatchId}`; compare it centrally on every projection refresh and increment `taskActionRevision` only when that key changes. Do not increment revisions ad hoc in individual DOM actions, and never expose the real path in a DOM dataset or log.

`previewTaskCatalogTxt(path, expectedRevision)` first rejects a stale task card, then sets the draft only after `hybrid.previewTxt(path)` succeeds. Refactor the current `requestCatalogTxtImport()` body into one shared private import helper used by both the legacy settings entry and `importPreviewedTaskCatalogTxt()`: confirm the already-previewed candidate, call `hybrid.importTxt(path)`, then immediately attempt to clear `boundCloudLibrary`, and only then call the controller's external `refreshCatalogProjection()`. Thus every TXT replacement path has the same invalidation order. Regardless of cleanup or external-refresh failure, recompute workflow against the runtime's active source hash so an old binding cannot become ready. Clear the pending draft only on the documented full success path. This task defines the picker and model contract but does not yet expose a new button; Task 9 wires `WorkbenchView` to create it. Do not store the native path in plugin data, recent directories, history, messages, or logs.

- [ ] **Step 4: Verify and commit Task 3**

```bash
npx vitest run \
  tests/ui/local-catalog-txt-picker.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts
git add \
  src/ui/local-catalog-txt-picker.ts \
  src/ui/workbench-controller.ts \
  src/ui/workbench-view.ts \
  tests/helpers/ui-fixtures.ts \
  tests/ui/local-catalog-txt-picker.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts
git commit -m "feat(目录): 增加本地 TXT 会话选择"
git status --short
```

Expected: task TXT draft and explicit import flow PASS without persistence or startup side effects.

## Task 4: Preserve launch validation while removing the duplicate workbench confirmation

**Files:**

- Create: `src/catalog/verification-launch-request.ts`
- Create: `tests/unit/catalog/verification-launch-request.test.ts`
- Modify: `src/catalog/large-catalog-verification-progress.ts`
- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `src/ui/catalog-large-scan-confirmation-modal.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `tests/unit/catalog/large-catalog-verification-progress.test.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `tests/ui/catalog-large-scan-confirmation-modal.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`

- [ ] **Step 1: Move the current safety contract into failing pure tests**

Create `tests/unit/catalog/verification-launch-request.test.ts` by moving the current `checkedRequest()` cases out of the Modal test. The new public API is:

```ts
export interface VerificationLaunchGroup {
  readonly groupKey: string;
  readonly rootRelativePath: string;
  readonly label: string;
  readonly pdfCount: number;
}

export type VerificationLaunchRequest =
  | Readonly<{
      kind: "start";
      cloudRoot: string;
      groups: readonly VerificationLaunchGroup[];
      directorySelection?: CloudDirectorySelection;
    }>
  | Readonly<{
      kind: "resume";
      cloudRoot: string;
      groups: readonly VerificationLaunchGroup[];
    }>;

export function validateVerificationLaunchRequest(
  input: VerificationLaunchRequest,
): VerificationLaunchRequest;
```

Test the exact existing invariants: 1–5 unique valid groups for start and resume; valid non-root normalized parent; safe labels/counts/keys; structured selection revalidation for start; no new directory selection on resume; selection `effectiveRoot` equals launch root; category selection implies exactly one matching group; returned objects are detached. Add a controller assertion that a task start invokes `hybrid.startLargeVerification()` after one page click without calling `CatalogLargeScanConfirmationPresenter.request()`.

Add failing progress/runtime tests for the resumable scope contract:

```ts
export interface LargeCatalogVerificationSummary {
  readonly selectedGroupKeys: readonly string[];
  // existing fields
}

export interface LargeCatalogBatchSummary {
  readonly selectedGroupKeys: readonly string[];
  // existing fields
}
```

`summarizeLargeCatalogVerification()` must copy checkpoint group keys in checkpoint order, assert the count equals `selectedGroupCount`, and never expose the mutable checkpoint array. `batchFromVerification()`, `cloneBatch()` and runtime reload preserve that detached list. Test a process restart with an old five-category checkpoint and prove resume receives exactly those five keys in the same order—never the current recommendation or a newly edited draft.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/unit/catalog/verification-launch-request.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/workbench-controller.test.ts
```

Expected: FAIL because the pure validator and direct task launch path do not exist.

- [ ] **Step 3: Extract validation and add direct task-only launch methods**

Move the current private `checkedRequest()` implementation unchanged in meaning to the new catalog module. The legacy Modal must call `validateVerificationLaunchRequest()` before rendering. Extend the progress/runtime summaries with validated, detached `selectedGroupKeys`; when loading a checkpoint, reject count/key inconsistencies as corrupt instead of fabricating a resumable scope.

Add one permit-owning controller entry:

```ts
async performTaskVerificationAction(
  kind: "start" | "resume",
  expectedRevision: number,
): Promise<void>;
```

Both methods delegate to one private helper used by direct, advanced and remaining legacy callers:

```ts
type TaskActionPermit = Readonly<{
  revision: number;
  nonce: symbol;
}>;

private async withTaskActionPermit<T>(
  expectedRevision: number,
  action: (permit: TaskActionPermit) => Promise<T>,
): Promise<T>;

private async runVerifiedLaunch(input: Readonly<{
  kind: "start" | "resume";
  expectedRevision?: number;
  cloudRoot: string;
  groupKeys: readonly string[];
  directorySelection?: CloudDirectorySelection;
  confirm: boolean;
}>, permit?: TaskActionPermit): Promise<void>;
```

`withTaskActionPermit()` is the only code that checks revision/pending, sets controller-owned `taskActionPending`, creates a permit, and clears pending in `finally`. The launch helper must require and validate that permit for task-card calls, but must not reject merely because pending is true—the permit represents the one legal in-flight action. Legacy confirmed callers omit `expectedRevision`/permit and retain their existing busy guard until Task 10 removes the duplicate controls.

The helper must: recompute the semantic task key/revision; reject stale visible cards; reject source-mismatched bindings; clear hybrid message suppression; capture the before-batch progress marker; validate the exact currently visible 1–5-group scope; optionally ask the presenter only for a legacy caller; lock the root only at actual launch; call start/resume; refresh the catalog projection; and unlock when the batch did not durably advance. It also preserves the current validation-error mapping, cancellation semantics, runtime-error mapping, resume-root-mismatch unlock/message behavior, prior overlay and checkpoint.

`performTaskVerificationAction()` acquires one permit and passes it to `runVerifiedLaunch()`. For start, use the exact group draft displayed on the task card (the default recommendation contains one; advanced mode may contain 2–5). For resume, ignore the current recommendation/draft and use only `snapshot.batch.selectedGroupKeys`; validate that every key still exists in the active catalog and that its length matches `selectedGroupCount` before calling `resumeLargeVerification()`. This task entry does **not** call the duplicate confirmation presenter.

- [ ] **Step 4: Verify direct start, modal compatibility, and failure unlock**

```bash
npx vitest run \
  tests/unit/catalog/verification-launch-request.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/workbench-controller.test.ts
```

Expected: PASS; one task click starts exactly the displayed root and 1–5-group scope; a restarted five-group batch resumes only its original keys; forged, stale or source-mismatched inputs fail before runtime; a rerender while a promise is pending cannot enable a second launch; legacy Modal still validates; cancellation, root mismatch, runtime/projection failure and non-advancing launches unlock without replacing the prior overlay/checkpoint.

- [ ] **Step 5: Commit Task 4**

```bash
git add \
  src/catalog/verification-launch-request.ts \
  src/catalog/large-catalog-verification-progress.ts \
  src/catalog/hybrid-catalog-runtime.ts \
  src/ui/catalog-large-scan-confirmation-modal.ts \
  src/ui/workbench-controller.ts \
  tests/unit/catalog/verification-launch-request.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/workbench-controller.test.ts
git commit -m "refactor(核验): 抽离启动校验并移除重复确认"
git status --short
```

Expected: direct workbench launch is GREEN while all safety validation remains covered.

## Task 5: Extract a host-independent directory picker session

**Files:**

- Create: `src/ui/cloud-directory-picker-session.ts`
- Create: `src/ui/folder-selection-host.ts`
- Create: `tests/ui/cloud-directory-picker-session.test.ts`
- Modify: `src/ui/cloud-directory-picker.ts`
- Modify: `tests/ui/cloud-directory-picker.test.ts`
- Modify: `tests/ui/cloud-directory-browser-view.test.ts`

- [ ] **Step 1: Write failing session parity tests before moving behavior**

Define the detached state/driver boundary in `folder-selection-host.ts` (type-only imports are allowed; it must emit no executable dependency on catalog implementations), then make the concrete session implement it:

```ts
export type CloudDirectoryPickerPhase =
  | "local"
  | "lookup-consent"
  | "locating"
  | "root-consent"
  | "browsing"
  | "settling"
  | "closed";

export type CloudDirectoryPickerStatusCode =
  | "query-required"
  | "no-local-match"
  | "conflict"
  | "lookup-consent-required"
  | "lookup-running"
  | "lookup-complete"
  | "lookup-incomplete"
  | "root-consent-required"
  | "browser-loading"
  | "browser-incomplete"
  | "browser-error"
  | "selection-invalid"
  | "save-failed";

export interface CloudDirectoryPickerSessionState {
  readonly phase: CloudDirectoryPickerPhase;
  readonly query: string;
  readonly enabledSources: readonly CloudDirectoryCandidateSource[];
  readonly rankedCandidates: readonly RankedCloudDirectoryCandidate[];
  readonly selectedPath: string | null;
  readonly draftSelection: CloudDirectorySelection | null;
  readonly browserPath: string | null;
  readonly browserHighlightedPath: string | null;
  readonly browserLayer: CloudDirectoryLayerSnapshot | null;
  readonly browserActivity: "idle" | "running" | "complete" | "incomplete" | "canceled" | "error";
  readonly statusCode: CloudDirectoryPickerStatusCode | null;
}

export type FolderSelectionDraft = CloudDirectorySelection;

export interface FolderSelectionSessionDriver {
  snapshot(): CloudDirectoryPickerSessionState;
  subscribe(listener: () => void): () => void;
  setQuery(value: string): void;
  toggleSource(source: CloudDirectoryCandidateSource): void;
  selectCandidate(path: string): void;
  requestLookupConsent(): void;
  confirmLookup(): Promise<void>;
  revealRootBrowser(): void;
  confirmRootBrowser(): void;
  enterBrowserPath(path: string): void;
  navigateBreadcrumb(path: string): void;
  highlightBrowserPath(path: string | null): void;
  selectCurrentDirectory(): Promise<void>;
  selectHighlightedDirectory(): Promise<void>;
  selectCategory(path: string): Promise<void>;
  continueBrowser(): Promise<void>;
  retryBrowser(): Promise<void>;
  cancelBrowser(): void;
  useSelection(): Promise<FolderSelectionDraft | null>;
  cancel(): void;
  dispose(): void;
}

export type CloudDirectoryPickerSession = FolderSelectionSessionDriver;

export interface CloudDirectoryPickerSessionDependencies {
  readonly candidates: CloudDirectoryCandidateRuntime;
  readonly browser?: CloudDirectoryBrowserRuntime;
  readonly locator?: CloudDirectoryLocatorRuntime;
  readonly purpose: CloudDirectoryPickerPurpose;
  readonly initialPath: string | null;
}

export function createCloudDirectoryPickerSession(
  dependencies: CloudDirectoryPickerSessionDependencies,
): CloudDirectoryPickerSession;
```

Place the phase/status/state/draft/driver declarations in `folder-selection-host.ts`. Place `CloudDirectoryPickerSessionDependencies`, the concrete alias and `createCloudDirectoryPickerSession()` implementation in `cloud-directory-picker-session.ts`; only the latter has executable imports of candidate/browser/locator runtimes.

Port the existing picker tests into session tests first: local search makes zero requests; all four source filters preserve order/state and affect ranking; conflict cannot settle; lookup requires `requestLookupConsent()` then explicit confirmation; root browsing requires separate disclosure; browser highlight, current/highlight/category selection and breadcrumb navigation match the legacy Modal; page continuation uses exact cursor; category returns parent `effectiveRoot` plus `groupKey`; normal directory returns itself; recent persistence happens only after a validated selection; persistence failure does not report success; generation and AbortController reject stale locate/browser results; cancel/dispose settle once and preserve loaded session cache. No arbitrary exception string may enter `statusCode`.

All `selectCurrentDirectory()`, `selectHighlightedDirectory()` and `selectCategory()` actions only validate and replace a detached private/view `draftSelection`; they do not remember, persist, settle or close. `useSelection()` is the sole commit boundary: it revalidates the current draft against the original purpose, calls `candidates.remember()`, and returns a detached selection only if remember succeeds. Cancel/dispose discards the draft. Add explicit tests that selecting a category alone does nothing durable, the later single “使用此文件夹” returns its parent `effectiveRoot + groupKey`, cancellation drops it, and remember failure leaves the session open with no success result.

- [ ] **Step 2: Run session and legacy Modal tests and verify RED**

```bash
npx vitest run \
  tests/ui/cloud-directory-picker-session.test.ts \
  tests/ui/cloud-directory-picker.test.ts \
  tests/ui/cloud-directory-browser-view.test.ts
```

Expected: new session test FAILS; legacy picker tests remain the characterization baseline.

- [ ] **Step 3: Move state and async orchestration, leaving a thin Modal adapter**

Move, rather than duplicate, the existing state for candidate ranking, the four `enabledSources`, locator consent, browser path/layer/highlight, validated `draftSelection`, breadcrumb/category/current-directory selection, generation counters, abort controllers, `startBrowserLoad`, retry/continue/cancel, selection validation, recent persistence, and settle-once behavior into `CloudDirectoryPickerSessionService`. Translate every caught failure to the closed `CloudDirectoryPickerStatusCode` union at the session boundary.

`createCloudDirectoryPickerModalClass()` may retain only Obsidian lifecycle, focus restoration, DOM mounting, translation and calls into the session. It must not own a second copy of request counting, stale-result protection, category resolution or persistence. Keep root disclosure and network lookup confirmations unchanged; they authorize broader discovery and are not the duplicate verification confirmation removed in Task 4.

- [ ] **Step 4: Verify behavioral parity and bounded DOM**

```bash
npx vitest run \
  tests/ui/cloud-directory-picker-session.test.ts \
  tests/ui/cloud-directory-picker.test.ts \
  tests/ui/cloud-directory-browser-view.test.ts \
  tests/ui/windowed-list.test.ts
```

Expected: all legacy behavior and new session state tests PASS; large directory layers still use the windowed list.

- [ ] **Step 5: Commit Task 5**

```bash
git add \
  src/ui/cloud-directory-picker-session.ts \
  src/ui/folder-selection-host.ts \
  src/ui/cloud-directory-picker.ts \
  tests/ui/cloud-directory-picker-session.test.ts \
  tests/ui/cloud-directory-picker.test.ts \
  tests/ui/cloud-directory-browser-view.test.ts
git commit -m "refactor(目录): 抽离可复用选择会话"
git status --short
```

Expected: Modal is a thin host adapter and the reusable session is independently GREEN.

## Task 6: Add the inline folder-selection page and explicit binding action

**Files:**

- Create: `src/ui/folder-selection-page.ts`
- Modify: `src/ui/folder-selection-host.ts`
- Create: `tests/ui/folder-selection-page.test.ts`
- Create: `src/runtime/normal-folder-selection-composition.ts`
- Modify: `src/i18n/workbench-directory-picker-i18n.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/runtime/runtime-composition.ts`
- Modify: `src/plugin/knowledge-workbench-plugin.ts`
- Modify: `src/main.ts`
- Modify: `src/main-acceptance.ts`
- Modify: `tests/unit/i18n/workbench-directory-picker-i18n.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/packaging/composition-roots.test.ts`

- [ ] **Step 1: Write failing inline-page and binding tests**

The canonical page API lives in the acceptance-safe `folder-selection-host.ts`; `folder-selection-page.ts` re-exports these types and supplies only the normal renderer:

```ts
export interface FolderSelectionHostSnapshot {
  readonly i18n: DirectoryPickerI18n;
  readonly state: CloudDirectoryPickerSessionState;
  readonly returnLabel: string;
}

export interface FolderSelectionHostActions {
  readonly onBack: () => void;
  readonly onQuery: (value: string) => void;
  readonly onToggleSource: (source: CloudDirectoryCandidateSource) => void;
  readonly onSelectCandidate: (path: string) => void;
  readonly onUse: () => Promise<void> | void;
  readonly onBrowseOther: () => void; // requestLookupConsent
  readonly onConfirmLookup: () => Promise<void> | void;
  readonly onRevealRoot: () => void;
  readonly onConfirmRoot: () => void;
  readonly onBrowserAction: Readonly<{
    onNavigate: (path: string) => void;
    onHighlight: (path: string | null) => void;
    onSelectCurrent: () => Promise<void> | void;
    onSelectHighlighted: () => Promise<void> | void;
    onSelectCategory: (path: string) => Promise<void> | void;
    onContinue: () => Promise<void> | void;
    onRetry: () => Promise<void> | void;
    onCancel: () => void;
  }>;
}

export type FolderSelectionPageModel = FolderSelectionHostSnapshot;
export type FolderSelectionPageActions = FolderSelectionHostActions;
```

Test that the initial page shows only back, search, recent/current-session matches, disambiguating parent paths, selected folder and one use action. Source filters, manual API path, request quotas and root controls must be absent until “浏览其他文件夹”; the four source filters appear only in that advanced region and delegate to the session. A conflict is visible but not selectable. The browser uses `createCloudDirectoryBrowserView()` inline, keeps its breadcrumb/highlight/current/category/continue/retry/cancel behavior, and restores the search focus when returning.

Controller tests must prove that only `useSelection()` can persist a binding; clicking a browser directory/category only updates `draftSelection`; a directory commit stores its own `effectiveRoot`; a category commit stores the parent `effectiveRoot` and selects only its `groupKey`; recent candidates alone do not bind; remember or binding-save failure reports no completion, keeps the page/session recoverable and leaves the old binding/model intact; cancel drops the draft; explicit close/dispose invalidates the session and stale results cannot bind. Task 7 adds the route-leave disposal assertion.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/ui/folder-selection-page.test.ts \
  tests/ui/workbench-controller.test.ts
```

Expected: FAIL because the inline page and controller session lifecycle do not exist.

- [ ] **Step 3: Implement controller-owned session and atomic binding**

Add controller actions to ask the injected `FolderSelectionSessionFactoryPort` for one `FolderSelectionSessionDriver`, then drive, settle and dispose that safe driver. The controller never imports or constructs `CloudDirectoryPickerSession` directly. Every `FolderSelectionPageActions` method delegates to the matching closed driver action from Task 5. Publish only its detached view state to `WorkbenchViewModel`; the page must never call the Baidu source, locator, SecretStorage or plugin data store directly.

Preserve the read-only acceptance dependency boundary with an injected host capability rather than importing normal-only browser code from shared `WorkbenchView`:

```ts
export interface FolderSelectionHostCapability {
  readonly available: boolean;
  render(
    root: HTMLElement,
    snapshot: FolderSelectionHostSnapshot,
    actions: FolderSelectionHostActions,
  ): DisposableSurface;
}

export interface FolderSelectionSessionFactoryPort {
  readonly available: boolean;
  create(input: Readonly<{
    purpose: CloudDirectoryPickerPurpose;
    initialPath: string | null;
  }>): FolderSelectionSessionDriver;
}
```

Define `FolderSelectionHostSnapshot`, `FolderSelectionHostActions`, `FolderSelectionSessionDriver` and `FolderSelectionSessionFactoryPort` in `folder-selection-host.ts` using only detached data, callbacks and `import type` declarations; it must emit no executable import from session/browser/Baidu modules. `normal-folder-selection-composition.ts` is the only composition root that instantiates and injects the inline renderer/session factory. It and the legacy normal-only Modal adapter may import `folder-selection-page.ts`, `cloud-directory-picker-session.ts`, `cloud-directory-browser-view.ts` and normal Baidu directory dependencies, but none of those imports may enter shared controller/view code. The normal composition closes over candidate/browser/locator runtimes and supplies both ports. `main.ts` injects them through plugin/runtime composition; the plugin passes the factory to `WorkbenchController` and renderer to `WorkbenchView`. `main-acceptance.ts` injects unavailable local-only stubs for both and must retain the current forbidden-import graph. Update `composition-roots.test.ts` to prove the acceptance entry cannot reach session/selection/browser/locator/SecretStorage implementations; do not weaken the deny-list.

On explicit settle:

```ts
const selection = await folderSelectionDriver.useSelection();
if (selection === null) return;
const active = hybrid.snapshot().active;
if (active === undefined) throw new RangeError("active-catalog-required");
const effectiveRoot = normalizeCatalogScanRoot(selection.effectiveRoot);
if (
  selection.kind === "category"
  && !active.groups.some((group) => group.groupKey === selection.groupKey)
) throw new RangeError("folder-selection-group-stale");
await store.updateSettings((settings) => ({
  ...settings,
  boundCloudLibrary: {
    schemaVersion: 1,
    path: effectiveRoot,
    sourceImportSha256: active.sourceImportSha256,
  },
}));
```

The normal session revalidates the concrete selection against its original purpose immediately before adapting it to the safe `FolderSelectionDraft`; the shared controller never imports or calls `cloud-directory-selection.ts`. It only normalizes the returned non-root effective root, rechecks a category key against the current active catalog, and re-reads the active source immediately before the durable write. Reject if the active source changed since selection began. Only after durable save succeeds, update `verificationRoot`, optional structured selection and selected group. If the visible workflow was repairing the current batch, set session-only `supersededRecoveryBatchId` to that exact batch id; this preserves the old checkpoint for details but lets the explicit new binding produce a fresh start card. Then close the session and recompute the central semantic task key so an old button closure cannot start a new invisible scope. Clear the supersession receipt on source change, new batch id, dispose or restart. Tests must prove the primary action changes after repair and never loops back to the same folder picker.

Add the `folderSelection.*` Chinese/English keys used by this page in the same task; never pass ad-hoc user copy through the session's technical `statusCode`.

- [ ] **Step 4: Verify inline semantics and commit Task 6**

```bash
npx vitest run \
  tests/unit/i18n/workbench-directory-picker-i18n.test.ts \
  tests/ui/folder-selection-page.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/cloud-directory-picker-session.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/packaging/composition-roots.test.ts
git add \
  src/ui/folder-selection-page.ts \
  src/ui/folder-selection-host.ts \
  src/runtime/normal-folder-selection-composition.ts \
  src/i18n/workbench-directory-picker-i18n.ts \
  src/ui/workbench-controller.ts \
  src/ui/workbench-view.ts \
  src/runtime/runtime-composition.ts \
  src/plugin/knowledge-workbench-plugin.ts \
  src/main.ts \
  src/main-acceptance.ts \
  tests/unit/i18n/workbench-directory-picker-i18n.test.ts \
  tests/ui/folder-selection-page.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/packaging/composition-roots.test.ts
git commit -m "feat(目录): 在工作台内联选择书库"
git status --short
```

Expected: binding and inline selection tests PASS; no Modal is opened from the default task flow.

## Task 7: Replace the five-page shell with three legal routes

**Files:**

- Create: `src/ui/workbench-route.ts`
- Create: `tests/ui/workbench-route.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `src/ui/workbench-shell.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `tests/ui/workbench-shell.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `tests/ui/accessibility.test.ts`
- Modify: `tests/ui/read-only-acceptance-surfaces.test.ts`

- [ ] **Step 1: Write failing route and three-navigation tests**

Use a discriminated union so invalid page/subpage combinations cannot compile:

```ts
export type WorkbenchTab = "library" | "task" | "more";

export type WorkbenchRoute =
  | Readonly<{ tab: "library" }>
  | Readonly<{
      tab: "task";
      page: "overview" | "folder-selection" | "category-selection";
    }>
  | Readonly<{
      tab: "more";
      page:
        | "overview"
        | "connection"
        | "catalog-data"
        | "language"
        | "history"
        | "knowledge-tools"
        | "advanced";
    }>;

export const defaultWorkbenchRoute = (): WorkbenchRoute => ({ tab: "library" });
export const routeForTab = (tab: WorkbenchTab): WorkbenchRoute => (
  tab === "library"
    ? { tab: "library" }
    : tab === "task"
      ? { tab: "task", page: "overview" }
      : { tab: "more", page: "overview" }
);
```

Tests must assert: exactly three destinations `文库 / 任务 / 更多`; default is `library`; ArrowUp/ArrowDown/Home/End wrap across exactly three buttons; narrow mode still retains accessible names; route changes do not persist settings or cause network actions; leaving task folder selection disposes its session; leaving a rendered settings subsection disposes `SettingsSectionsSurface` exactly once.

- [ ] **Step 2: Run route and shell tests and verify RED**

```bash
npx vitest run \
  tests/ui/workbench-route.test.ts \
  tests/ui/workbench-shell.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/accessibility.test.ts
```

Expected: FAIL because the route union and new navigation labels do not exist.

- [ ] **Step 3: Migrate model/actions/controller atomically**

Replace `activeTab` with `route` in `WorkbenchViewModel`. Retain `startSection` only for “更多 → 知识工具”. Replace `selectTab()` with `selectRoute()` plus the shell convenience `selectTab(tab)` that calls `routeForTab(tab)`. Update `WorkbenchActions`, `WorkbenchViewController`, `populatedWorkbenchModel()` and `noOpWorkbenchActions()` in the same commit so there is no intermediate state where old strings reach the new shell.

The `NAVIGATION` constant becomes:

```ts
const NAVIGATION = [
  { page: "library", key: "nav.library", icon: "⌕" },
  { page: "task", key: "nav.task", icon: "✓" },
  { page: "more", key: "nav.more", icon: "•••" },
] as const;
```

Do not persist the route. Initialization must remain offline and must not auto-navigate away from the library even when a task exists.

Add `nav.library`, `nav.task` and `nav.more` to both dictionaries now; keep legacy keys until Task 11 confirms they have no remaining callers.

Until Tasks 8–10 replace the page bodies, use a compile-safe temporary dispatch: `library` delegates to the existing `renderCloudCatalogTab()`; `task/overview` and `task/category-selection` delegate to the existing `renderVerificationPage()`; `task/folder-selection` renders the Task 6 inline page; `more/history` delegates to `renderHistory()`; `more/knowledge-tools` delegates to `renderStartPage()`; the remaining More subpages delegate to the existing settings surface. This commit changes navigation and legal route state only; it must not duplicate or rewrite domain actions.

- [ ] **Step 4: Verify shell, controller, acceptance policy, and commit Task 7**

```bash
npx vitest run \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/workbench-route.test.ts \
  tests/ui/workbench-shell.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/accessibility.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts
git add \
  src/ui/workbench-route.ts \
  src/i18n/workbench-i18n.ts \
  src/ui/workbench-shell.ts \
  src/ui/workbench-view.ts \
  src/ui/workbench-controller.ts \
  tests/ui/workbench-route.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/workbench-shell.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/helpers/ui-fixtures.ts \
  tests/ui/accessibility.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts
git commit -m "feat(导航): 收口文库任务更多三入口"
git status --short
```

Expected: three-entry navigation and route lifecycle tests PASS.

## Task 8: Make the library the search-first, non-blocking default page

**Files:**

- Create: `src/ui/library-page.ts`
- Create: `tests/ui/library-page.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `src/ui/cloud-catalog-tab.ts`
- Modify: `tests/ui/cloud-catalog-tab.test.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `tests/ui/workbench-view.test.ts`

- [ ] **Step 1: Write failing library composition tests**

Define a thin composition API that reuses catalog search behavior:

```ts
export interface LibraryPageModel {
  readonly catalog: CloudCatalogViewModel;
  readonly selectedCatalogId: string | null;
  readonly recentItems: readonly RecentLibraryItem[];
  readonly filtersExpanded: boolean;
  readonly workflow: LibraryWorkflowState;
  readonly i18n: WorkbenchI18n;
}

export interface RecentLibraryItem {
  readonly catalogId: string;
  readonly filename: string;
  readonly directoryTag: string;
}

export interface LibraryPageActions extends CloudCatalogTabActions {
  readonly onOpenTask: () => void;
}

export function renderLibraryPage(
  root: HTMLElement,
  model: LibraryPageModel,
  actions: LibraryPageActions,
): void;
```

Tests must assert: the first heading is “在文库里找书”; search is the first form control; boundary copy says only filenames/directory information are searched and no PDF is downloaded; task reminder appears only for actionable states and never steals focus or triggers network; its action only routes to Task; recent/empty/result states remain safe; advanced filters are closed by default; no API parent/request/checkpoint terms appear.

Define “最近查看” as a session-only, detached MRU list of at most five catalog rows. Record an item only when the user explicitly opens its detail disclosure; a search result merely becoming visible does not count. De-duplicate by `catalogId`, move a repeated item to the front, show the list only when the query is empty, and clear it on workbench disposal. Do not persist it in plugin settings/history, and do not fetch or copy the full catalog to reconstruct it.

Update catalog detail tests so selecting a result reveals one on-demand detail region adjacent to the selected item (or a same-column disclosure), not a permanently sticky right rail. The list must still render at most `pageSize` rows and preserve copy/open-Baidu actions.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/ui/library-page.test.ts \
  tests/ui/cloud-catalog-tab.test.ts \
  tests/ui/workbench-view.test.ts
```

Expected: FAIL because the library page and non-sticky detail contract do not exist.

- [ ] **Step 3: Compose the page without duplicating catalog state**

`renderLibraryPage()` owns only the heading, safety copy, bounded session MRU and lightweight task reminder, then calls the existing catalog renderer with the same model/actions. Keep query, filters, page and selected record in the existing catalog runtime/controller. The controller/View may retain only five detached recent rows; do not copy the full 68,959-record catalog into the view model and continue using its 50-row projected page.

Refactor `appendDetails()` so details are user-invoked and part of normal document flow. Remove `position: sticky`; narrow widths must not reserve a second column. Preserve focus keys across controller rerenders.

Add the `library.*` page, reminder, boundary and responsive-detail keys to both dictionaries in this task.

- [ ] **Step 4: Verify search behavior and commit Task 8**

```bash
npx vitest run \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/library-page.test.ts \
  tests/ui/cloud-catalog-tab.test.ts \
  tests/ui/workbench-view.test.ts
git add \
  src/ui/library-page.ts \
  src/i18n/workbench-i18n.ts \
  src/ui/cloud-catalog-tab.ts \
  src/ui/workbench-view.ts \
  tests/ui/library-page.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/cloud-catalog-tab.test.ts \
  tests/ui/workbench-view.test.ts
git commit -m "feat(文库): 默认显示搜索优先首页"
git status --short
```

Expected: library search, reminder, detail and bounded-page tests PASS.

## Task 9: Render the task as one visible card and one primary action

**Files:**

- Create: `src/ui/task-page.ts`
- Create: `tests/ui/task-page.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `src/ui/verification-page.ts`
- Modify: `src/ui/verification-progress.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `tests/ui/verification-page.test.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/ui/verification-progress.test.ts`

- [ ] **Step 1: Write failing tests for every task state and action**

Public page contract:

```ts
export interface TaskPageModel {
  readonly i18n: WorkbenchI18n;
  readonly workflow: LibraryWorkflowState;
  readonly boundLibraryPath: string | null;
  readonly visibleGroupScope: readonly HybridCatalogGroupViewModel[];
  readonly taskActionRevision: number;
  readonly hybrid?: HybridCatalogViewModel;
  readonly actionPending: boolean;
}

export interface TaskPageActions {
  readonly onPrimary: (revision: number) => Promise<void> | void;
  readonly onChooseDifferentCategory: () => void;
  readonly onOpenDetails: () => void;
}
```

For every workflow row, assert exactly one `[data-task-primary]` button and the expected Chinese label. The default ready card must show recommended category, candidate count, bound library name, single-category scope, and “只读取目录信息，不下载 PDF，不修改笔记” in the same visible card. Advanced ready cards show the exact 2–5 selected categories and the same read-only boundary in that one visible action card. A paused/retry card shows the exact original checkpoint categories, not a new recommendation. The full group checklist must be absent. “更换分类” is secondary.

Also assert:

- running → only “暂停”; paused → only “继续检查”; complete/unavailable → “去文库搜索”; repair states → one recovery action;
- pending immediately changes the label to “正在打开…” / “正在开始…” / “正在继续…”, sets `aria-busy="true"`, and rejects double click;
- there is no inert primary button: if an action cannot run, derive a different recovery state instead of silently disabling “开始检查”;
- full-library coverage uses `coveredCandidatePdfCount / pdfCount`; current activity remains indeterminate; safety quota stays in collapsed “运行详情”; details are closed by default;
- stale `taskActionRevision` cannot launch; the controller's semantic task key increments the revision before a changed scope can become actionable;
- a pending promise followed by an unrelated runtime rerender remains pending and cannot submit twice; pending is controller-owned, not renderer-local.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/ui/task-page.test.ts \
  tests/ui/verification-progress.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts
```

Expected: FAIL because the task page and unified primary dispatcher do not exist.

- [ ] **Step 3: Implement one controller dispatcher without broadening authority**

Add `performTaskPrimaryAction(expectedRevision)` and switch only on the freshly recomputed workflow. Add one host bridge:

```ts
async performTaskTxtSelection(
  expectedRevision: number,
  requestPath: () => Promise<string | null>,
): Promise<void>;
```

It acquires `withTaskActionPermit()` **before** `WorkbenchView` opens `LocalCatalogTxtPicker`, keeps the permit across the picker await, and calls a private `previewTaskCatalogTxtWithPermit()` only when a path is returned. Cancel, host failure and preview failure all release in `finally`. Keep the public Task 3 `previewTaskCatalogTxt(path, expectedRevision)` as another permit-owning entry for focused tests/legacy callers; it delegates to the same private implementation and is not called from inside the host permit.

For non-host actions, `performTaskPrimaryAction()` either acquires one permit around its branch or delegates to the already permit-owning verification entry—never both:

```ts
switch (workflow.primaryAction) {
  case "import-txt": return this.withTaskActionPermit(expectedRevision, () => this.importPreviewedTaskCatalogTxt());
  case "open-connection": return this.withTaskActionPermit(expectedRevision, async () => this.selectRoute({ tab: "more", page: "connection" }));
  case "choose-library": return this.withTaskActionPermit(expectedRevision, async () => this.selectRoute({ tab: "task", page: "folder-selection" }));
  case "start": return this.performTaskVerificationAction("start", expectedRevision);
  case "pause": return this.withTaskActionPermit(expectedRevision, async () => this.cancelSelectedVerification());
  case "resume":
  case "retry": {
    if (this.hybrid.snapshot().batch?.resumeAvailable !== true) {
      throw new RangeError("task-resume-unavailable");
    }
    return this.performTaskVerificationAction("resume", expectedRevision);
  }
  case "open-library": return this.withTaskActionPermit(expectedRevision, async () => this.selectRoute({ tab: "library" }));
  case "choose-txt": throw new RangeError("host-task-action-required");
}
```

The View delegates `choose-txt` to `performTaskTxtSelection()` and never opens the picker first. The controller compares workflow/revision before granting the permit and again before consuming a returned path. Every snapshot and rerender reads the same controller-owned pending field. Add double-click plus mid-await-rerender tests for start, resume and the open TXT picker path. The dispatcher must not auto-open OAuth, start folder browsing, start verification or resume network work on construction/restart.

For “更换分类”, render the `task/category-selection` subpage with one-selection defaults and stable active-group order. An “高级” disclosure on this same Task subpage contains manual parent-path input and the existing up-to-five checkbox capability. Refactor `verification-page.ts` to export that reusable editor, but it **does not** render its own start/resume/pause action. Saving the editor updates the exact 1–5-group task draft and returns to the one task card, whose visible scope and semantic revision drive the pure launch validator. It never asks the duplicate verification Modal, never routes to More/Settings, and never modifies a resumable batch's original group list.

Add `task.action.*`, `task.pending.*`, `task.details.*` and category-editor keys to both dictionaries in this task. The state title/description keys already landed with Task 2.

- [ ] **Step 4: Verify state/action/progress integration and commit Task 9**

```bash
npx vitest run \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/task-page.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/verification-progress.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts
git add \
  src/ui/task-page.ts \
  src/i18n/workbench-i18n.ts \
  src/ui/verification-page.ts \
  src/ui/verification-progress.ts \
  src/ui/workbench-view.ts \
  src/ui/workbench-controller.ts \
  tests/ui/task-page.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/verification-page.test.ts \
  tests/ui/verification-progress.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts
git commit -m "feat(任务): 提供单一状态驱动主动作"
git status --short
```

Expected: every state has one explained action; start/resume never appear together; progress remains truthful.

## Task 10: Build the More summary and remove the second verification UI

**Files:**

- Create: `src/ui/more-page.ts`
- Create: `tests/ui/more-page.test.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `src/ui/settings-sections.ts`
- Modify: `src/ui/settings-tab.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/adapters/obsidian-workspace-adapter.ts`
- Modify: `src/runtime/runtime-composition.ts`
- Modify: `src/plugin/knowledge-workbench-plugin.ts`
- Modify: `src/main.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `tests/ui/settings-tab.test.ts`
- Modify: `tests/ui/history-tab.test.ts`
- Modify: `tests/ui/start-page.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/integration/plugin-startup-gate.test.ts`

- [ ] **Step 1: Write failing summary, subsection, and de-duplication tests**

Add a subsection contract to the shared settings surface:

```ts
export type SettingsSectionId =
  | "language"
  | "baidu"
  | "catalog-data"
  | "cloud-scan-advanced"
  | "privacy-ai";

export interface SettingsSectionsRenderOptions {
  readonly section?: SettingsSectionId;
}

export interface SettingsSectionsSurface {
  render(
    root: HTMLElement,
    locale: WorkbenchLocale,
    options?: SettingsSectionsRenderOptions,
  ): void;
  dispose(): void;
}
```

`more-page.test.ts` must assert that the overview shows concise rows for connection, remembered library, active catalog count, language/startup, note changes, and advanced features. Each row has one clear route action. Connection/catalog/language subpages render only their requested shared settings section and a back action. History is labeled “笔记改动”. Today/map/suggestions remain available only under “高级功能/知识工具”.

Update settings tests to assert that neither the workbench More page nor the native Obsidian settings page renders the old category checklist, start/resume/pause buttons, or verification progress cards. Instead they render one “打开任务页” action for category checking. In the native settings host, that action must close/relinquish the settings surface, set `task/overview`, call the injected workspace activator, reveal/focus the actual workbench leaf, and remain enabled even when the workbench was not already open. TXT preview/import, OAuth, scan advanced controls, write gates and AI gates keep their existing confirmations and policy restrictions.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/ui/more-page.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/history-tab.test.ts \
  tests/ui/start-page.test.ts \
  tests/ui/workbench-view.test.ts
```

Expected: FAIL because More routing/subsection render and the settings de-duplication do not exist.

- [ ] **Step 3: Implement summary routing and reuse, not duplicate, existing surfaces**

`renderMorePage()` owns only cards and route buttons. Delegate history to `renderHistory()`, knowledge tools to `renderStartPage()`, and individual settings to the one existing `SettingsSectionsSurface`. The Obsidian native settings tab calls `render()` without an option and still shows all low-frequency configuration sections, but no longer owns category selection or run controls.

Add one controller/view action `openTaskOverview()` for the “打开任务页” link. Add a host callback to `createSettingsTabClass()` and runtime composition that: disposes the settings surface; sets the task route; feature-checks the current Obsidian host's settings-close capability in a narrowly typed adapter; closes settings when available; then calls `activateWorkbenchWithRetry()` and focuses the revealed leaf. If the undocumented close capability is absent, still activate the leaf and show fixed local guidance to close Settings—never fail silently or use DOM selectors. Surface a fixed local error if leaf activation fails. The workbench More page may route directly, but the native settings tab must use this host callback so the button never changes only an invisible controller. Ensure surface disposal when switching subsection, route, language or closing the view; do not keep authorization timers or secret input elements alive offscreen. Cover existing leaf, leaf creation, close-capability fallback and focus/navigation with integration/mocked-host tests.

Add all `more.*` summary/subpage keys and the “笔记改动” label to both dictionaries in this task.

- [ ] **Step 4: Verify all retained advanced capabilities and commit Task 10**

```bash
npx vitest run \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/more-page.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/history-tab.test.ts \
  tests/ui/start-page.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/integration/plugin-startup-gate.test.ts
git add \
  src/ui/more-page.ts \
  src/i18n/workbench-i18n.ts \
  src/ui/settings-sections.ts \
  src/ui/settings-tab.ts \
  src/ui/workbench-view.ts \
  src/adapters/obsidian-workspace-adapter.ts \
  src/runtime/runtime-composition.ts \
  src/plugin/knowledge-workbench-plugin.ts \
  src/main.ts \
  tests/ui/more-page.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/history-tab.test.ts \
  tests/ui/start-page.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/integration/plugin-startup-gate.test.ts
git commit -m "refactor(更多): 汇总低频功能并去除重复核验"
git status --short
```

Expected: More and native settings retain every advanced capability but expose only one category-verification UI.

## Task 11: Localize and style the simplified surfaces for narrow Obsidian layouts

**Files:**

- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `src/i18n/workbench-directory-picker-i18n.ts`
- Modify: `styles.css`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`
- Modify: `tests/unit/i18n/workbench-directory-picker-i18n.test.ts`
- Modify: `tests/ui/accessibility.test.ts`
- Modify: `tests/ui/workbench-shell.test.ts`
- Modify: `tests/ui/library-page.test.ts`
- Modify: `tests/ui/task-page.test.ts`
- Modify: `tests/ui/folder-selection-page.test.ts`
- Modify: `tests/ui/more-page.test.ts`

- [ ] **Step 1: Write failing bilingual, ARIA, and structure assertions**

Add every new key to both dictionaries and keep the existing exact-key parity test. Required key families:

```text
nav.library.*
nav.task.*
nav.more.*
library.*
task.state.*
task.action.*
task.pending.*
task.details.*
folderSelection.*
more.*
```

Tests must reject untranslated keys and default-main-flow copies containing “API 父目录 / API parent”, “运行片段 / segment”, “列表请求 / list request” or “检查点 / checkpoint”. These terms remain legal only under `[data-technical-details]`.

Accessibility assertions: one `main`; one current navigation item; all icon-only narrow nav buttons have names; task primary has an accessible name and busy state; error/recovery text uses a polite status region; folder result list supports keyboard focus; back actions restore focus; details have summaries; no focusable hidden advanced controls; reduced-motion CSS disables activity animation.

- [ ] **Step 2: Run i18n/accessibility tests and verify RED**

```bash
npx vitest run \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/unit/i18n/workbench-directory-picker-i18n.test.ts \
  tests/ui/accessibility.test.ts \
  tests/ui/workbench-shell.test.ts \
  tests/ui/library-page.test.ts \
  tests/ui/task-page.test.ts \
  tests/ui/folder-selection-page.test.ts \
  tests/ui/more-page.test.ts
```

Expected: FAIL on missing translations and old structural assumptions.

- [ ] **Step 3: Replace the grid background and enforce responsive content flow**

Remove the global square-grid `background-image`. Use Obsidian theme surfaces and a bounded content column. Keep the left rail for normal widths, collapse it to icons under the existing container threshold, and never move the task primary below a full classification list.

Add container-query rules equivalent to:

```css
.knowledge-workbench {
  container-name: knowledge-workbench;
  container-type: inline-size;
  background: var(--background-primary);
}

.knowledge-workbench__page {
  width: min(100%, 72rem);
  margin-inline: auto;
  padding: var(--size-4-4);
}

@container knowledge-workbench (max-width: 44rem) {
  .knowledge-workbench__sidebar { inline-size: 3.25rem; }
  .knowledge-workbench__library-detail,
  .knowledge-workbench__task-card,
  .knowledge-workbench__folder-selection {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Use normal document flow for selected-book details and folder browsing; no sticky right panel, fixed overlay or horizontal page-level scroll. Preserve `prefers-reduced-motion` and native focus outlines.

- [ ] **Step 4: Verify bilingual and responsive DOM contracts**

```bash
npx vitest run \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/unit/i18n/workbench-directory-picker-i18n.test.ts \
  tests/ui/accessibility.test.ts \
  tests/ui/workbench-shell.test.ts \
  tests/ui/library-page.test.ts \
  tests/ui/task-page.test.ts \
  tests/ui/folder-selection-page.test.ts \
  tests/ui/more-page.test.ts
```

Expected: PASS in Chinese and English; technical terms appear only in closed detail regions; all primary surfaces remain single-column capable.

- [ ] **Step 5: Commit Task 11**

```bash
git add \
  src/i18n/workbench-i18n.ts \
  src/i18n/workbench-directory-picker-i18n.ts \
  styles.css \
  tests/unit/i18n/workbench-i18n.test.ts \
  tests/unit/i18n/workbench-directory-picker-i18n.test.ts \
  tests/ui/accessibility.test.ts \
  tests/ui/workbench-shell.test.ts \
  tests/ui/library-page.test.ts \
  tests/ui/task-page.test.ts \
  tests/ui/folder-selection-page.test.ts \
  tests/ui/more-page.test.ts
git commit -m "style(界面): 完善极简布局与中文交互"
git status --short
```

Expected: translation parity, accessibility, narrow-layout and reduced-motion tests PASS.

## Task 12: Prove compatibility, offline startup, packaging, and bounded rendering

**Files:**

- Modify: `tests/integration/read-only-acceptance-automated-safety.test.ts`
- Modify: `tests/ui/read-only-acceptance-surfaces.test.ts`
- Modify: `tests/packaging/composition-roots.test.ts`
- Modify: `tests/packaging/install-dev.test.ts`
- Modify: `tests/packaging/read-only-acceptance-build.test.ts`
- Modify: `README.md`
- Modify: `docs/runbooks/baidu-cloud-catalog-small-folder.md`
- Modify: `docs/superpowers/specs/2026-09-01-knowledge-workbench-simplified-automatic-ui-design.md`

- [ ] **Step 1: Add final cross-cutting failing acceptance assertions**

Prove these boundaries with synthetic dependencies:

- startup, view open, library search, workflow derivation and route changes issue zero network requests;
- task start sends exactly one previously displayed bound root and the exact visible 1–5-group scope to the hybrid runtime;
- a restarted five-group checkpoint resumes with the same five keys in checkpoint order; recommendation and edited draft cannot replace or enlarge it;
- one authorized batch may continue only its original selected groups under existing segment limits;
- pause/restart only prepares a resumable card and never reconnects automatically;
- token expiration, rate limiting, path mismatch and malformed response preserve the prior active projection and checkpoint while mapping to one recovery action; malformed/integrity responses never offer resume;
- explicit repair of a failed library batch changes the next primary action, retains the old checkpoint only for details, and cannot loop back to the same recovery card; snapshot corruption without an active catalog routes to TXT recovery;
- TXT replacement preserves the old active catalog until explicit import succeeds; after activation, both projection-refresh failure and binding-cleanup save failure remain fail-closed because the old binding source hash cannot match the new active TXT;
- credential replacement/revocation clears binding and selection before OAuth/SecretStorage mutation; a new authorization identity cannot reuse the old path or resume the old-account checkpoint silently, while an in-session token refresh may resume it;
- normal build contains the injected picker/session/connection capabilities; acceptance build's dependency graph still exposes no OAuth, Baidu directory selection/browser/locator, SecretStorage or executable cloud action;
- no PDF download method or Vault write action is called by any library/task flow;
- start, resume and host TXT selection each hold one controller permit across async work and remain single-submit through unrelated rerenders;
- a 100,000-candidate synthetic index still projects at most the existing page/window row limits into the DOM; this is a deterministic bounded-render assertion, not a performance benchmark.

- [ ] **Step 2: Run focused integration, packaging, and bounded-render gates**

```bash
npx vitest run \
  tests/integration/read-only-acceptance-automated-safety.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts \
  tests/packaging/composition-roots.test.ts \
  tests/packaging/install-dev.test.ts \
  tests/packaging/read-only-acceptance-build.test.ts
```

Expected: all focused safety/packaging tests PASS; bounded-render assertions pass without loading the full catalog into page DOM. No benchmark or stress command is run.

- [ ] **Step 3: Run the complete automated gate in repository order**

```bash
npm test
npm run lint
npm run build
npm run build:acceptance
git diff --check
```

Expected:

- all Vitest suites PASS;
- ESLint reports zero errors;
- TypeScript `-noEmit -skipLibCheck` and normal esbuild complete;
- read-only acceptance artifact builds successfully;
- `git diff --check` reports no whitespace errors.

- [ ] **Step 4: Update user/runbook documentation with honest acceptance levels**

Document:

- default “文库 / 任务 / 更多” flow;
- search indexes filenames and directory metadata only;
- TXT selection/preview/import and book-library binding behavior;
- one-click visible-scope check, pause/resume, and recovery actions;
- no PDF download, no note write, no root auto-scan, no startup network;
- distinction among automated PASS, dedicated synthetic Vault visual acceptance, and later real Vault/Baidu acceptance.

Mark the approved spec as implemented only after Step 3 passes. Do not claim real Obsidian or real Baidu PASS from jsdom/build results.

- [ ] **Step 5: Commit the automated release candidate**

```bash
git add \
  tests/integration/read-only-acceptance-automated-safety.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts \
  tests/packaging/composition-roots.test.ts \
  tests/packaging/install-dev.test.ts \
  tests/packaging/read-only-acceptance-build.test.ts \
  README.md \
  docs/runbooks/baidu-cloud-catalog-small-folder.md \
  docs/superpowers/specs/2026-09-01-knowledge-workbench-simplified-automatic-ui-design.md
git commit -m "test(界面): 收口极简工作台自动化门禁"
git status --short
```

Expected: automated implementation is committed; only the 11 unrelated untracked research files remain.

## Manual acceptance gates after automated implementation

These are deliberately **not** authorized by approval of this plan:

1. Dedicated synthetic Vault visual acceptance:
   - install the built plugin only after a fresh explicit authorization;
   - check normal, narrow, and both-sidebar layouts;
   - verify the search field and task primary action remain visible;
   - verify folder selection is inline and no wide verification Modal appears;
   - verify keyboard order, focus restoration, Chinese/English switching and reduced motion.
2. Real Vault installation:
   - requires a separate explicit installation authorization;
   - back up plugin data and enabled-plugin state;
   - keep the plugin disabled until the approved test step.
3. Real Baidu small-category read-only verification:
   - requires another explicit authorization after installation;
   - use only one user-selected non-sensitive non-root small category;
   - do not reveal paths, credentials or codes in chat;
   - do not download PDFs or write notes.
4. Push, PR, merge, tag or public release:
   - each remains a separate external mutation gate;
   - do not bump `manifest.json`, `package.json`, `package-lock.json`, `versions.json` or publish artifacts unless the user requests a release step.
