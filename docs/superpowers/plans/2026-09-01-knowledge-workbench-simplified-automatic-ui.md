# Knowledge Workbench 极简自动化界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将知识工作台收口为“文库、任务、更多”三入口，让目录搜索成为默认首页，并通过一个状态驱动主动作完成 TXT 导入、百度连接、书库绑定、分类核验、暂停和恢复，同时保留全部只读、安全配额与检查点语义。

**Architecture:** 在现有 controller 与领域运行时之间增加纯 `LibraryWorkflowState` 派生层；用持久化的非根书库绑定、非秘密身份代次/根目录作用域和会话级 TXT 草稿补齐自动化状态；把目录选择器的状态机从 Obsidian Modal 抽成可复用 session，并在工作台内联子页面承载；保留现有 OAuth、SecretStorage、TXT、overlay、checkpoint、自动分段和事务服务，但只有来源、身份代次和根目录作用域完全匹配的云端结果可参与当前覆盖率与推荐，其余只保留为历史。

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
- 升级前已有 overlay/checkpoint 不清零：只允许在用户第一次明确“使用此文件夹”时，以不可变指纹白名单一次性认领；最近目录、来源/root 模糊匹配或后台启动都不能认领。
- 推荐分类只准备本地草稿；不得覆盖可恢复批次、扩大分类集合或发起网络请求。
- 任何会改变百度授权身份的操作都必须先确认没有真实在途的目录扫描/分类核验，并在触碰凭据前持久废止当前最新且仍影响工作流的批次；运行中只允许先暂停/取消，不允许跨身份继续请求。
- 每次默认只核验一个分类。原有最多 5 个分类能力保留在“任务 → 更换分类 → 高级”，不出现在默认任务卡；高级选择仍回到同一张可见任务卡启动。
- 不制造当前分类的完成百分比。全库覆盖率可以确定显示；当前云端递归活动保持不确定；分段 PDF 只表示安全配额。
- 错误、日志和操作历史不得显示 AppKey、SecretKey、授权码、原始真实路径或百度响应正文。
- 每个实现任务遵循 RED → focused GREEN → relevant regression → 单独中文 conventional commit；只暂存该任务列出的文件。

## Final file responsibility map

新增生产文件：

- `src/storage/cloud-library-binding.ts` — 书库绑定字段的 fail-closed 解码。
- `src/storage/verification-batch-tombstones.ts` — 持久、限长的旧核验批次废止记录。
- `src/storage/legacy-verification-adoption.ts` — 一次性认领升级前核验成果的不可变指纹侧车。
- `src/catalog/cloud-verification-scope.ts` — 非秘密身份代次、TXT 来源与云端根目录的可信范围。
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
- `tests/unit/storage/verification-batch-tombstones.test.ts`
- `tests/unit/storage/legacy-verification-adoption.test.ts`
- `tests/unit/catalog/cloud-verification-scope.test.ts`
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
- Create: `src/storage/verification-batch-tombstones.ts`
- Create: `src/storage/legacy-verification-adoption.ts`
- Create: `tests/unit/storage/cloud-library-binding.test.ts`
- Create: `tests/unit/storage/verification-batch-tombstones.test.ts`
- Create: `tests/unit/storage/legacy-verification-adoption.test.ts`
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
      verificationGeneration: 3,
    })).toEqual({
      schemaVersion: 1,
      path: "/Kéxue",
      sourceImportSha256: "a".repeat(64),
      verificationGeneration: 3,
    });
    for (const value of [
      undefined,
      null,
      "/科学文库",
      { schemaVersion: 1, path: "/", sourceImportSha256: "a".repeat(64) },
      { schemaVersion: 1, path: "/A", sourceImportSha256: "A".repeat(64), verificationGeneration: 1 },
      { schemaVersion: 1, path: "/A", sourceImportSha256: "a".repeat(64), verificationGeneration: 0 },
      { schemaVersion: 2, path: "/A", sourceImportSha256: "a".repeat(64) },
    ]) expect(decodeBoundCloudLibrary(value)).toBeNull();
  });
});
```

Extend `tests/unit/storage/plugin-data-store.test.ts` to prove that legacy settings without the field decode to `null`, valid values round-trip, malformed values fail closed without resetting unrelated settings, recent directories never promote themselves, and unknown outer schemas preserve only a separately valid binding while retaining the existing write/AI downgrade.

Create `tests/unit/storage/verification-batch-tombstones.test.ts` for one additive, safely round-trippable setting:

```ts
export type VerificationBatchTombstonesV1 =
  | Readonly<{
      schemaVersion: 1;
      state: "valid";
      batchIds: readonly string[];
    }>
  | Readonly<{
      schemaVersion: 1;
      state: "invalid";
    }>;

readonly verificationBatchTombstones: VerificationBatchTombstonesV1;
```

Define the tagged union and helpers in `verification-batch-tombstones.ts`; `plugin-data.ts` imports only the type. The persisted codec accepts only exact-key schema-1 envelopes and unique NFC-safe local ids matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. A persisted valid envelope with more than 16 ids is malformed and decodes to the canonical invalid sentinel—never silently slices away a potentially important old id. A missing legacy field decodes to `{state:"valid", batchIds:[]}` because the positive generation plus the one-time adoption sidecar below supplies the upgrade boundary. An explicit exact-key `{state:"invalid"}` sentinel or any present malformed/extra-key envelope decodes to the canonical invalid sentinel and must encode back as invalid; unrelated locale/startup/AI setting writes may never turn it into valid-empty. The trusted `appendSupersededVerificationBatchId()` helper alone may move a repeated id to newest and, when adding a seventeenth trusted id, drop the oldest. `repairVerificationBatchTombstones()` is the only API allowed to replace an invalid sentinel with a valid envelope, and only as part of an explicit rebind or identity-reset transaction that captures the current workflow-affecting batch id. Never promote arbitrary history/path strings.

Create `legacy-verification-adoption.ts` for the compatibility bridge required by the approved “do not reset existing overlay/checkpoint semantics” contract. Its exact-key tagged union has `none`, `pending`, `ineligible`, `invalid`, and `adopted` states. `adopted` contains one exact positive `verificationGeneration` plus `sourceImportSha256` and `cloudRootSha256` scope triple, the active candidate import id plus manifest/descriptor SHA-256, a unique bounded allowlist (maximum 128) of legacy V1 overlay `{overlayId, groupKey, descriptorSha256}` fingerprints, an optional V1 unified `{snapshotId, descriptorSha256}`, and at most one resumable V3 `{batchId, checkpointSha256, sourceImportSha256, cloudRootSha256}` fingerprint. It stores no raw path, account id, credential, authorization code or response body. New-install defaults are `none`; decoding an otherwise known persisted schema-1 settings object that predates this field yields `pending`; a present malformed/extra-key value is sticky `invalid`; explicit identity replacement before adoption writes `ineligible`. Only the first explicit binding transaction may change `pending` to `adopted`, and generation greater than 0 can never create or replace an adoption sidecar.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/unit/storage/cloud-library-binding.test.ts \
  tests/unit/storage/verification-batch-tombstones.test.ts \
  tests/unit/storage/legacy-verification-adoption.test.ts \
  tests/unit/storage/plugin-data-store.test.ts
```

Expected: FAIL because the binding, tombstone and legacy-adoption codecs plus new `PluginSettings` fields do not exist.

- [ ] **Step 3: Implement the nullable field without changing outer schema**

Add to `PluginSettings`:

```ts
export interface BoundCloudLibraryV1 {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly sourceImportSha256: string;
  readonly verificationGeneration: number;
}

readonly boundCloudLibrary: BoundCloudLibraryV1 | null;
readonly cloudVerificationGeneration: number;
readonly verificationBatchTombstones: VerificationBatchTombstonesV1;
readonly legacyVerificationAdoption: LegacyVerificationAdoptionV1;
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
  if (
    typeof value.path !== "string"
    || typeof value.sourceImportSha256 !== "string"
    || typeof value.verificationGeneration !== "number"
    || !Number.isSafeInteger(value.verificationGeneration)
    || value.verificationGeneration < 1
  ) return null;
  if (!SHA256.test(value.sourceImportSha256)) return null;
  try {
    return {
      schemaVersion: 1,
      path: normalizeCatalogScanRoot(value.path),
      sourceImportSha256: value.sourceImportSha256,
      verificationGeneration: value.verificationGeneration,
    };
  } catch {
    return null;
  }
};
```

Set `boundCloudLibrary: null`, `cloudVerificationGeneration: 0`, valid-empty tombstones and `legacyVerificationAdoption:{schemaVersion:1,state:"none"}` in `defaultSettings()`. Generation 0 is an unbound transition state: it may expose the pre-existing active legacy projection for local-only search, but it can never start/resume network work or appear in a valid binding/new scoped artifact. Decode only safe integers from 0 through `Number.MAX_SAFE_INTEGER`; malformed values fall back to 0, which is fail-closed. `decodeSettings()` decodes tombstones and adoption independently. Keep outer `schemaVersion: 1`; these field-level codecs are the migration. Add all four fields to every complete `PluginSettings` fixture and `KNOWN_SETTING_KEYS`, while the synthetic legacy seed omits them to exercise `pending` adoption. Never upgrade a recent directory, a path-only value, or a pre-generation binding into a trusted library. Add store regressions proving: malformed load → unrelated save → reload remains invalid; safe generation/binding, valid or invalid tombstones, and every adoption state survive the existing unknown-outer-schema safety downgrade while write/AI remain disabled; a binding is trusted only when its independently decoded positive generation matches; new-install `none` and legacy `pending` are distinguishable; and only the dedicated explicit binding/identity helpers may leave invalid/pending states.

- [ ] **Step 4: Verify codec, storage, policy, and packaging fixtures**

```bash
npx vitest run \
  tests/unit/storage/cloud-library-binding.test.ts \
  tests/unit/storage/verification-batch-tombstones.test.ts \
  tests/unit/storage/legacy-verification-adoption.test.ts \
  tests/unit/storage/plugin-data-store.test.ts \
  tests/unit/runtime/safety-policy.test.ts \
  tests/packaging/synthetic-acceptance-data.test.ts \
  tests/integration/read-only-acceptance-automated-safety.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/settings-tab.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts
```

Expected: PASS; old/path-only binding data yields `null`; malformed hashes/roots fail closed; legacy tombstones decode valid-empty while malformed present tombstones remain invalid across unrelated writes; legacy settings become adoption-pending while new installs remain none; malformed adoption is sticky; no recent directory is promoted and no index, staging, credential, or journal field is reset.

- [ ] **Step 5: Commit Task 1**

```bash
git add \
  src/storage/cloud-library-binding.ts \
  src/storage/verification-batch-tombstones.ts \
  src/storage/legacy-verification-adoption.ts \
  src/storage/plugin-data.ts \
  src/storage/plugin-data-store.ts \
  tests/unit/storage/cloud-library-binding.test.ts \
  tests/unit/storage/verification-batch-tombstones.test.ts \
  tests/unit/storage/legacy-verification-adoption.test.ts \
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
git commit -m "feat(设置): 保存书库绑定与旧结果认领"
git status --short
```

Expected: commit succeeds; only the 11 pre-existing untracked research files remain.

## Task 2: Isolate verification authority and derive one finite workflow state

**Files:**

- Create: `src/catalog/cloud-verification-scope.ts`
- Create: `src/ui/library-workflow-state.ts`
- Create: `tests/unit/catalog/cloud-verification-scope.test.ts`
- Create: `tests/ui/library-workflow-state.test.ts`
- Modify: `src/catalog/hybrid-catalog-types.ts`
- Modify: `src/catalog/hybrid-catalog-codec.ts`
- Modify: `src/catalog/hybrid-catalog-ports.ts`
- Modify: `src/catalog/catalog-reconciliation-service.ts`
- Modify: `src/catalog/large-catalog-verification-service.ts`
- Modify: `src/catalog/large-catalog-verification-progress.ts`
- Modify: `src/catalog/unified-catalog-projection-service.ts`
- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `src/adapters/local-hybrid-catalog-adapter.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-contracts.test.ts`
- Modify: `tests/unit/catalog/local-hybrid-catalog-adapter.test.ts`
- Modify: `tests/unit/catalog/catalog-reconciliation-service.test.ts`
- Modify: `tests/unit/catalog/large-catalog-batch-contracts.test.ts`
- Modify: `tests/unit/catalog/large-catalog-verification-service.test.ts`
- Modify: `tests/unit/catalog/large-catalog-verification-progress.test.ts`
- Modify: `tests/unit/catalog/unified-catalog-projection-service.test.ts`
- Modify: `tests/unit/catalog/cloud-catalog-runtime.test.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/fakes/fake-cloud-catalog-runtime.ts`
- Modify: `tests/integration/catalog-large-verification.test.ts`
- Modify: `tests/integration/catalog-hybrid-composition.test.ts`
- Modify: `tests/performance/large-catalog-streaming.bench.test.ts`
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

export interface PendingCatalogTxtDraft {
  readonly path: string;
  readonly sourceSha256: string;
}

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
    verificationGeneration: 3,
  },
  cloudVerificationGeneration: 3,
  verificationBatchTombstones: {
    schemaVersion: 1,
    state: "valid",
    batchIds: [],
  },
  legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
  pendingCatalogTxt: null,
  capabilityAvailable: true,
})).toMatchObject({ kind: "paused", primaryAction: "resume" });

expect(recommendNextVerificationGroup([
  group("first", 252, "unverified"),
  group("second", 122, "unverified"),
  group("third", 122, "unverified"),
])?.groupKey).toBe("second");
```

Also assert: a runtime with `executionActive === true` outranks even unavailable/setup states so a real in-flight request can always be paused; a merely resumable batch does **not** outrank connection or binding validation; token/auth faults outrank ready; path mismatch outranks ready; no active TXT outranks connection; when the tombstone envelope is valid, a missing binding or a binding whose source/generation differs from the active TXT/settings always yields `needs-library` before resume/retry; an invalid envelope with active TXT is the explicit higher-priority `repair-library` conflict row and the same folder choice repairs both conditions; confirm-import requires both a retained session path/hash and a runtime preview candidate with that same hash; `txt-root-items` is never recommended; verified/difference groups are skipped; equal counts keep the input order; every table row has exactly one primary action; calling the functions mutates no input and performs no async work. A completed latest batch yields `ready` when another unverified group is still recommendable; only no remaining recommendation yields whole-library `complete`. Add a two-category sequence test: finish the first → ready with the second → finish the second → complete.

Add the decoded `verificationBatchTombstones` envelope as an input. A batch is superseded only when the envelope is valid and its exact id is in `batchIds`. Retain its checkpoint/read model for details but do not let its old repair code or `resumeAvailable` outrank a new source-matched binding and start draft. An invalid envelope with an active catalog always maps to `repair-library`/“重新选择书库”, even before a batch exists, so a new run cannot create an immediately unresumable checkpoint. That explicit rebind uses the dedicated repair helper to capture the current workflow-affecting batch id when present and restore a valid envelope; direct resume remains impossible while invalid. Add state-table tests proving malformed load → unrelated settings save → reload stays blocked, and repair → explicit reselect → ready survives controller recreation without deleting the old checkpoint. If `hybrid-snapshot-corrupt` has no active catalog, map to `needs-txt`/“重新选择目录 TXT” with safe details—not `choose-library`, which cannot succeed without an active catalog.

Add a non-secret authority/root scope before trusting any cloud-derived status:

```ts
export interface CloudVerificationScope {
  readonly generation: number; // safe integer >= 1
  readonly sourceImportSha256: string;
  readonly cloudRootSha256: string;
}

export interface LegacyVerificationAllowlist {
  readonly candidate: Readonly<{
    importId: string;
    manifestSha256: string;
    descriptorSha256: string;
  }>;
  readonly overlays: readonly Readonly<{
    overlayId: string;
    groupKey: string;
    descriptorSha256: string;
  }>[];
  readonly unified: Readonly<{
    snapshotId: string;
    descriptorSha256: string;
  }> | null;
  readonly resumableBatch: Readonly<{
    batchId: string;
    checkpointSha256: string;
    sourceImportSha256: string;
    cloudRootSha256: string;
  }> | null;
}

export type CloudVerificationAuthority =
  | Readonly<{
      kind: "legacy-local-only";
      sourceImportSha256: string;
      activeManifestSha256: string;
    }>
  | Readonly<{
      kind: "scoped";
      scope: CloudVerificationScope;
      legacyAllowlist: LegacyVerificationAllowlist | null;
    }>;
```

`deriveCloudVerificationScope(binding)` normalizes and hashes the bound root and requires the binding generation/source hash. A binding is current only when its generation equals `PluginSettings.cloudVerificationGeneration` and that value is at least 1. Generation 0 can never authorize network work. For an upgraded installation whose adoption state is `pending`, the already active legacy projection may remain visible for local-only search and coverage until the user explicitly binds a library; startup, recent directories and inferred paths cannot seal or extend that trust. The first explicit binding either atomically records a generation-1 allowlist of the exact active legacy artifacts or, when no legacy artifacts exist, starts clean. This is a one-time compatibility bridge, not a general source/root inference rule.

Persist the exact authority in every new batch; tombstones and the adoption allowlist are defense in depth, not substitutes. Introduce exact-key `LargeCatalogBatchCheckpointV4` and `LargeCatalogRunReceiptV4` with `schemaVersion:4`, nested `verificationScope`, and `legacyCheckpointSha256:string|null`; keep the bounded group/page/budget fields unchanged. A V4 checkpoint also carries `latestReceipt:null|{runOrdinal,receiptSha256}` so its hash commits to the latest durable V4 receipt. Every V4 batch directory uses a bounded double-buffer protocol: immutable legacy `checkpoint.json` remains V3; mutable V4 slots are `checkpoint-v4-a.json` and `checkpoint-v4-b.json`; exact-key `active-checkpoint.json` stores `{schemaVersion:1,batchId,activeSlot,activeCheckpointSha256,legacyCheckpointSha256,verificationScope}`. Updates write and fsync the inactive slot through a temporary file, fsync the directory, then atomically replace/fsync the pointer. Missing pointer means legacy V3; a present malformed pointer, missing/hash-mismatched slot, scope/anchor/receipt mismatch or extra key fails closed and never falls back to V3; abandoned temporary files and unreferenced slots are ignored.

Native V4 creation never writes directly into an enumerable published storage root and never relies on check-then-rename for no-clobber behavior. First create a unique sibling staging directory whose leading-dot name cannot pass the batch-id codec (for example `.batch-staging-<nonce>`), write/fsync slot A plus its pointer and an exact staging manifest there, and fsync the staging directory. Then claim the validated final `batchId` with one atomic non-recursive `mkdir(final, 0o700)`; `EEXIST` is a hard collision and nothing is overwritten. Create/fsync exact `claim.json` with the same batch id, nonce and staging-manifest hash using exclusive creation, fsync the final directory and parent, then rename the complete staging directory to the previously absent `final/published` child and fsync final plus parent. The freshly claimed directory and nonce make this an owner-scoped internal publication; an existing/mismatched `published`, claim, symlink or unexpected entry fails closed. The V4 storage root is `final/published` for native batches and the legacy batch directory itself for an in-place adopted-V3 promotion.

`loadLatestBatch()` never interprets an unpublished native claim as V3. On restart, classify native final directories before choosing any older batch: (A) no `published` plus an exact unfinished claim/staging nonce may finish the internal publish after revalidating every hash, otherwise it is ignored without network; (B) no `published` plus an empty/foreign/incomplete claim is quarantined/ignored and never deleted or overwritten automatically; (C) once `published` exists, any missing/malformed/mismatched claim, staging manifest hash, pointer, slot, nonce or unexpected entry returns `hybrid-batch-invalid` globally and forbids fallback to an older batch; (D) only exact claim plus fully validated `published/active-checkpoint.json` is eligible. Thus a crash before claim leaves only non-enumerable staging, a crash after claim but before internal publish leaves an unpublished claim that cannot outrank the last valid batch, and a crash after publish either exposes a complete V4 directory or an explicit repair state—never silent rollback. Native V4 starts with slot A, a null legacy anchor and a null receipt reference. `loadLatestBatch()` resolves validated published/native or direct legacy directories and then keeps the existing deterministic `{startedAt,runOrdinal,batchId}` ordering; a valid pointer always selects V4 for that same batch id. Add table tests for A–D plus create crashes after staging creation, slot fsync, pointer fsync, final claim, claim fsync, internal publish and parent fsync, and final-name/claim/published collisions, proving restart performs zero network work, performs no overwrite, preserves the last valid older batch only before publication, and never hides published corruption by selecting an older batch.

Add page envelope V3 for all V4 transitions, carrying exact prior/next V4 checkpoint hashes plus the existing page/identity data; the current operation journal treats page/envelope/slot/pointer as one recoverable transition. Before pointer swap, recovery retains the old slot; after a valid pointer swap, it completes/validates the matching page commit. Existing V1/V2 page envelopes and embedded V3 checkpoints remain an immutable legacy prefix. Promotion may bridge that prefix only when both the adoption sidecar and pointer's `legacyCheckpointSha256` equal the canonical V3 checkpoint hash and the entire old page/journal/reference chain validates; later writes use envelope V3 and never append to the old chain.

The batch store read side returns a tagged V3/V4 union for history, while normal create/page/permit/advance/finalize writes accept V4 only. A canonical V3 is eligible for one promotion only when its id/fingerprint is current-scope allowlisted. Before promotion, validate the complete bounded legacy receipt prefix expected by the canonical V3 checkpoint. Compute `expectedLastReceiptOrdinal = checkpoint.status === "scanning" ? Math.max(0, checkpoint.runOrdinal - 1) : checkpoint.runOrdinal`: scanning means its current ordinal has not finalized (including zero receipts for the first live segment), while paused/stopped/complete checkpoints have finalized their current ordinal. Every canonical V3 `run-N` receipt from 1 through that expected ordinal must be immutable and hash/identity consistent, and no later ordinal may be imported. The legacy anchor plus adoption sidecar must match exactly. A missing, malformed, mismatched or too-late expected receipt rejects before network. `promoteAdoptedLegacyBatch()` deterministically constructs slot A with the original selected groups/order/counts/pending semantics, full scope and legacy anchor, then atomically writes the pointer; original V3/pages/receipts remain unchanged. Repeating promotion with the same sidecar/scope is idempotent; a different scope/fingerprint rejects. Tombstones retain the same batch id across promotion. The runtime exposes detached `verificationScope: CloudVerificationScope|null` and `legacyPromotionRequired:boolean`: exact adopted V3 projects the current scope and may offer resume through promotion; unlisted V3 is non-resumable; V4 requires full scope match. Promotion never fabricates or rewrites a receipt; the validated V3 receipt chain is an immutable prefix only, and every later receipt is V4.

For every new V4 segment finalization, first serialize the canonical `run-v4-N.json` receipt and next-slot bytes into fsynced staging files. Then durably write/fsync a `prepared` operation journal containing their exact hashes, scope/ordinal, prior active-pointer hash, target inactive slot/hash and any page-envelope transition. Only after that journal is durable may the adapter atomically publish the canonical receipt without overwrite (for example, hard-link the fsynced staged receipt into the canonical name and require `EEXIST` content to match exactly), fsync the directory, install/fsync the target slot, and finally replace/fsync the pointer. The new slot's `latestReceipt` contains that exact ordinal/hash, so only then may the pointer expose a terminal/paused/complete checkpoint. After a valid pointer swap, settle/fsync the journal and remove staging files.

Recovery ignores unjournaled staging files. A prepared journal can finish from its hash-checked staged files; it may reuse an already installed canonical receipt only when exact canonical bytes/hash/scope/ordinal match, otherwise it fails closed. Before pointer swap the old slot remains authoritative; after pointer swap, loading a checkpoint whose referenced receipt is missing or mismatched fails closed, and an unsettled matching journal is completed idempotently. The sequence “canonical receipt installed before prepared journal” is forbidden by construction. Add crash tests at journal-before-receipt, receipt-before-slot, slot-before-pointer, pointer-before-journal-settle and journal settlement, plus a guard proving receipt-before-journal cannot occur; test identical retry, conflicting existing receipt, paused/orphan-scanning V3 promotion with the correct off-by-one receipt prefix, missing/bad legacy receipts, malformed-pointer/no-fallback, restart/latest selection, repeated finalize/promotion idempotency, old-page bridge validation and same-id tombstones.

`LargeCatalogVerificationService.start()` must durably create the V4 checkpoint with the validated scope before its first Baidu list request. `runSegment()` loads only V4, compares generation/source/root exactly before any network or overlay mutation, and uses that stored scope for every schema-2 overlay and receipt. The controller/runtime resume adapter promotes an exactly adopted V3 first, then invokes the same V4-only segment path with its original group order and pending/page semantics. A source/root-matched but unlisted V3, or a V4 from another generation, remains non-resumable even when tombstones are valid-empty. Add codec, adapter, service, progress and reconstructed-runtime tests for canonical promotion, stale fingerprint, journal failure, scope mismatch and zero-network-before-durable-V4.

Version cloud-derived artifacts without discarding approved legacy semantics. New schema-2 overlay descriptors carry `verificationGeneration` and `cloudRootSha256`; new schema-2 unified descriptors carry either the exact `CloudVerificationScope` used to build them or `null` for a candidate-only local projection. A schema-1 overlay/unified may contribute only when its immutable id plus descriptor SHA-256 appears in the current-scope adoption allowlist; never trust all legacy data merely because the TXT or root matches. Exact-scope schema 2 wins over an adopted schema 1 for the same group. Extend reconciliation results, ports, codecs and the local adapter with exact-key fail-closed checks. `LargeCatalogVerificationService` receives the validated scope and writes schema 2. `UnifiedCatalogProjectionService.rebuild(authority)` applies matching schema 2 plus only allowlisted legacy artifacts, then atomically writes a scope-tagged schema-2 unified snapshot. Unlisted legacy files and old-scope descriptors remain readable for technical history but never contribute current verified counts, differences, coverage or recommendations.

`LegacyVerificationAllowlist` is a detached catalog-layer copy of the adopted sidecar fingerprints, never the mutable settings object. Add these methods to the catalog/hybrid runtime boundary:

```ts
setVerificationAuthority(authority: CloudVerificationAuthority | null): void;
prepareLegacyVerificationAdoption(
  scope: CloudVerificationScope,
): Promise<LegacyVerificationAdoptionV1 | null>;
revalidatePreparedLegacyAdoption(
  prepared: LegacyVerificationAdoptionV1 | null,
): Promise<void>;
rebuildVerificationProjection(): Promise<void>;
```

`legacy-local-only` is created solely when a pre-existing settings object decoded to `pending` and the current active candidate/manifest validates; it keeps old local search/coverage visible but every start/resume/overlay mutation rejects it. Preparation is strictly local/read-only: validate candidate manifest, descriptor/content hashes, V1 overlay/unified fingerprints and at most one latest V3 checkpoint/page/journal chain; return `null` only when no legacy artifact exists, and throw fixed deterministic codes for ambiguous/root-mismatched lineage separately from transient I/O. `revalidatePreparedLegacyAdoption()` immediately re-reads and compares every immutable id/hash plus the active pointer and returns no data; it is required after any awaited UI/session work and directly before the settings CAS. Add fake/runtime tests for unchanged, stale, ambiguous and transient cases. `WorkbenchController` installs the correct local-only/scoped/null authority before catalog initialization. Every unified query carries it and fails closed on fingerprint/scope mismatch. A later identity/root/source change first invalidates trust, then rebuilds candidate-only/new-scope projection. Add restart tests: upgrade preserves exact pre-upgrade search/coverage and pending paused progress locally; explicit matching adoption preserves them under scope; new authority/root makes the allowlist history-only and yields a fresh recommendation; same-account token repair preserves it.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run \
  tests/unit/catalog/cloud-verification-scope.test.ts \
  tests/unit/catalog/hybrid-catalog-contracts.test.ts \
  tests/unit/catalog/local-hybrid-catalog-adapter.test.ts \
  tests/unit/catalog/catalog-reconciliation-service.test.ts \
  tests/unit/catalog/large-catalog-batch-contracts.test.ts \
  tests/unit/catalog/large-catalog-verification-service.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/unified-catalog-projection-service.test.ts \
  tests/unit/catalog/cloud-catalog-runtime.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/library-workflow-state.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/integration/catalog-large-verification.test.ts \
  tests/integration/catalog-hybrid-composition.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
```

Expected: FAIL because scoped V4/adoption-aware catalog contracts, authority runtime methods, required execution state and `library-workflow-state.ts` do not exist.

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
  readonly legacyArtifactSetSha256: string | null;
  // existing aggregate and group fields
}
```

Populate `sourceImportSha256` from `candidates.descriptor.sourceSha256`. Compute `legacyArtifactSetSha256` locally from a canonical, sorted inventory of the exact active candidate/manifest plus every legacy overlay, unified snapshot, V3 checkpoint/page/journal and receipt identifier/content hash; include a bounded overflow/invalid marker rather than trusting or omitting excess entries, return `null` only when no legacy artifact exists, and update it whenever that inventory changes. Clone both as scalars. The artifact-set hash is solely a detached change-detection token and never grants authority. Cover reload, import, artifact mutation, invalid/overflow inventory and empty snapshots in `hybrid-catalog-runtime.test.ts`. The workflow may trust only this validated read model, not an independent controller cache.

Add required top-level `executionActive: boolean` to `HybridCatalogViewModel`, defaulting to false in every resting/error/disposed snapshot. It represents a live runtime controller, not a persisted checkpoint or optional batch summary. During `initialize()`, a loaded current-scope V4—or an exactly allowlisted V3 waiting for local promotion—whose stored status is `scanning` has `executionActive:false`, is projected as offline `paused` with `resumeAvailable:true`, and remains recoverable through the service's existing `recoveredFromScanning` path; unlisted V3 or scope-mismatched scanning data remains history-only with `resumeAvailable:false`. `startLargeVerification()`/`resumeLargeVerification()` set it true synchronously when the `scanController` is created—after any V3 promotion has durably completed but before the first awaited verification/network call or progress event—and clear it only in the owning runtime generation's `finally`/dispose. Test crash/restart current-scope V4 and adopted-V3 orphan-scanning → paused/resumable; unlisted V3/old-generation scanning → history-only; a `verification.start()` promise suspended before its first progress callback still exposes execution-active/running/cancelable; and exactly one cancel reaches the live controller.

Update `tests/fakes/fake-cloud-catalog-runtime.ts` in this task so every required authority, projection, preview and `executionActive` member has deterministic defaults and call capture. Update the two integration compositions for the new exact snapshot/authority contracts. Keep `tests/performance/large-catalog-streaming.bench.test.ts` compiling against the V4/scope types, but do **not** run that benchmark in this task or in Task 12; it is covered only by the later TypeScript/build gate, consistent with the no-benchmark rule.

Derive in this order: execution-active runtime → unavailable → no active TXT / pending preview → connection/authorization repair → invalid tombstone/adoption recovery → source/generation-matched non-root binding → current-scope V4 or exactly adopted-V3 batch eligibility → unsuperseded path/integrity repair for that eligible batch → retry only when it is not tombstoned, `resumeAvailable === true` and the stop reason is rate-limit/access-unavailable → unsuperseded resumable batch → compute the next recommendation → ready when a recommendation exists → whole-library complete only when none exists. A tombstoned, unlisted-V3 or scope-mismatched batch is detail-only and the workflow proceeds to a fresh ready/start state. A `pending` adoption with no binding preserves local legacy search/coverage but yields `needs-library`, never resume/start; `invalid` blocks network with the same explicit reselect/repair action. `invalid-baidu-response` and batch consistency anomalies with a valid active catalog map to `repair-library` with “重新选择书库” as the primary action and technical details as a secondary disclosure; they never map to resume. Snapshot corruption without an active catalog maps to TXT recovery. Copy the chosen group before returning it. `recommendNextVerificationGroup()` must compare `{pdfCount, originalIndex}` and never sort the source array in place. Add only the 12 workflow title/description keys to both dictionaries in this task so the `WorkbenchMessageKey` contract compiles; Task 11 adds the remaining page, action, pending and accessibility copy.

- [ ] **Step 4: Verify and commit Task 2**

```bash
npx vitest run \
  tests/unit/catalog/cloud-verification-scope.test.ts \
  tests/unit/catalog/hybrid-catalog-contracts.test.ts \
  tests/unit/catalog/local-hybrid-catalog-adapter.test.ts \
  tests/unit/catalog/catalog-reconciliation-service.test.ts \
  tests/unit/catalog/large-catalog-batch-contracts.test.ts \
  tests/unit/catalog/large-catalog-verification-service.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/unified-catalog-projection-service.test.ts \
  tests/unit/catalog/cloud-catalog-runtime.test.ts \
  tests/ui/library-workflow-state.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/integration/catalog-large-verification.test.ts \
  tests/integration/catalog-hybrid-composition.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git add \
  src/catalog/cloud-verification-scope.ts \
  src/ui/library-workflow-state.ts \
  src/catalog/hybrid-catalog-types.ts \
  src/catalog/hybrid-catalog-codec.ts \
  src/catalog/hybrid-catalog-ports.ts \
  src/catalog/catalog-reconciliation-service.ts \
  src/catalog/large-catalog-verification-service.ts \
  src/catalog/large-catalog-verification-progress.ts \
  src/catalog/unified-catalog-projection-service.ts \
  src/catalog/cloud-catalog-runtime.ts \
  src/catalog/hybrid-catalog-runtime.ts \
  src/adapters/local-hybrid-catalog-adapter.ts \
  src/ui/workbench-controller.ts \
  src/i18n/workbench-i18n.ts \
  tests/unit/catalog/cloud-verification-scope.test.ts \
  tests/unit/catalog/hybrid-catalog-contracts.test.ts \
  tests/unit/catalog/local-hybrid-catalog-adapter.test.ts \
  tests/unit/catalog/catalog-reconciliation-service.test.ts \
  tests/unit/catalog/large-catalog-batch-contracts.test.ts \
  tests/unit/catalog/large-catalog-verification-service.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/unified-catalog-projection-service.test.ts \
  tests/unit/catalog/cloud-catalog-runtime.test.ts \
  tests/ui/library-workflow-state.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/fakes/fake-cloud-catalog-runtime.ts \
  tests/integration/catalog-large-verification.test.ts \
  tests/integration/catalog-hybrid-composition.test.ts \
  tests/performance/large-catalog-streaming.bench.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git commit -m "feat(核验): 隔离身份并派生唯一主动作"
git status --short
```

Expected: all workflow rows and precedence tests PASS; upgraded local search/coverage is unchanged, only exact adopted V1/V3 is trusted, every new network-capable batch is scoped V4, and unlisted/old-scope artifacts are history-only.

## Task 3: Add safe session-only TXT selection and import draft state

**Files:**

- Create: `src/ui/local-catalog-txt-picker.ts`
- Create: `tests/ui/local-catalog-txt-picker.test.ts`
- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `src/i18n/workbench-i18n.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `src/ui/settings-sections.ts`
- Modify: `tests/helpers/ui-fixtures.ts`
- Modify: `tests/fakes/fake-cloud-catalog-runtime.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Modify: `tests/ui/settings-sections.test.ts`
- Modify: `tests/ui/read-only-acceptance-surfaces.test.ts`
- Modify: `tests/ui/catalog-txt-import-confirmation-modal.test.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `tests/unit/i18n/workbench-i18n.test.ts`

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
expect(controller.snapshot().pendingCatalogTxt).toEqual({
  path: "/Synthetic/catalog.txt",
  sourceSha256: "b".repeat(64),
});
expect(controller.snapshot().workflow.kind).toBe("confirm-txt-import");

await controller.importPreviewedTaskCatalogTxt();
expect(controller.snapshot().pendingCatalogTxt).toBeNull();
expect(controller.settings().boundCloudLibrary).toBeNull();
```

Also assert: preview failure retains neither path nor false success; overlapping previews cannot race; a stale revision is rejected before reading the path; canceled import keeps the pending path and old active catalog; a preview whose source hash equals the current active source is re-read atomically, treated as unchanged, consumes both runtime candidate and controller draft without reimport, and preserves the valid binding; a changed file/hash is rejected before no-op; a different-hash replacement clears the bound library but leaves recent directory candidates unchanged; once different-hash activation commits, the pending draft is consumed immediately, so projection-refresh or binding-cleanup failure derives `needs-library` from source mismatch instead of returning to an unusable confirm-import state; no action fires on controller construction or snapshot.

Add credential-identity regression tests here because these controller paths already change OAuth/SecretStorage state. Distinguish two explicit intents: `repair-same-account` (token refresh or OOB reconnect with unchanged AppKey/SecretKey and user-facing copy requiring the original Baidu account) and `replace-identity` (change/remove credentials, revoke, or “使用其他账号”). Both reject a **live** hybrid execution (`hybrid.executionActive === true`) or live cloud catalog scan with fixed localized `verification-must-pause`/`scan-must-cancel` guidance before calling settings or credential ports. A crash-restored checkpoint with `executionActive:false` is not in flight.

`repair-same-account` acquires cloud authority but preserves generation, binding, tombstones and adoption; its authorization session records intent plus the prepared generation so code submission cannot silently switch intent or apply twice. This path cannot cryptographically prove historic Baidu identity, so UI/runbook copy must say to use the original account and direct account changes to the separate identity action. `replace-identity` identifies the latest workflow-affecting batch by exact id whenever status is not `complete`, then one settings transaction increments the checked generation, clears the binding, tombstones that id (repairing an invalid envelope only through the dedicated helper), and changes `pending` adoption to `ineligible`; an already `adopted` sidecar remains immutable history but no longer matches the new generation. If the write fails, abort before credentials/tokens. After success, synchronously clear session selection/draft/root, set verification authority `null` and invalidate old views before any await; complete the candidate-only rebuild before the credential mutation. Reject overflow. A replacement identity must explicitly bind again and cannot reuse old overlays/checkpoints after restart. Add Chinese/English copy and native Settings error mapping for both intents and the pause/cancel guidance.

Close the start/identity TOCTOU with a second controller-owned mutex that is independent of the task-card pending flag:

```ts
type CloudAuthorityOperation =
  | "verification-launch"
  | "catalog-scan-launch"
  | "library-binding"
  | "authorization-repair"
  | "identity-change";

private async withCloudAuthorityPermit<T>(
  kind: CloudAuthorityOperation,
  action: (nonce: symbol) => Promise<T>,
): Promise<T>;
```

All existing/direct start and resume entries, cloud-scan start, explicit library binding/root change, same-account authorization repair, credential/identity replacement and revoke must acquire this permit before their first validation/write and hold it across confirmation, settings, projection, credential and runtime awaits. The permit is fail-fast rather than queued: a conflicting second action immediately returns the fixed pause/cancel/busy guidance and can never execute later merely because the first promise settled. An authorization attempt records its intent and prepared generation in session state, so code submission acquires the same operation kind without rotating twice; stale/restarted or intent-mismatched attempts fail closed. Verification pause and cloud-scan cancel are the only idempotent interrupt channels allowed to bypass the permit. Re-check binding source/generation/adoption, tombstone envelope/id and exact resume groups after any legacy presenter returns and immediately before the runtime call. Tests must interleave deferred settings, presenter and runtime promises in both directions and prove that identity/root change cannot cross a launch and launch cannot cross either—even before the first progress event—and that rejected conflicts never run later.

Because Task 3 itself can change credential identity, it must also add a minimal fail-closed guard to **every existing resume entry** (`resumeSelectedVerification()` and `requestResumeLargeCatalogVerification()`) before any presenter, root lock or runtime call. Require: active TXT and bound library source hashes match; binding generation equals the current positive setting generation; tombstones are valid and omit the current batch id; and the batch is either current-scope V4 or the one exact V3 fingerprint allowlisted by the current-scope adoption sidecar. An adopted V3 must be promoted durably to V4 before the runtime can issue network work. Task 4 may refactor this guard into the shared launch helper, but the Task 3 commit may never leave an unlisted V3, stale fingerprint, old-generation/root or tombstoned batch resumable. Test both public/legacy entries before committing.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/ui/local-catalog-txt-picker.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts \
  tests/ui/catalog-txt-import-confirmation-modal.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
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

Reuse `PendingCatalogTxtDraft` from `library-workflow-state.ts`, then add one inseparable session draft, controller-owned `taskActionPending: boolean`, `taskActionRevision` and derived `workflow` to `WorkbenchViewModel` and its fixtures:

```ts
readonly pendingCatalogTxt: PendingCatalogTxtDraft | null;
```

Change `previewTxt(path)` to return its detached validated `CatalogTxtImportSummary` while retaining the runtime candidate, and serialize the whole open/preview operation so overlapping paths cannot win out of order. The controller stores the returned path/hash only after success. Maintain one private semantic key built from `{activeSourceImportSha256, pendingSourceImportSha256, boundSourceImportSha256, boundRoot, authorityGeneration, legacyAdoptionStateAndFingerprint, primaryAction, selectedGroupKeys, batchId, runOrdinal, messageCode, currentBatchSuperseded, verificationBatchTombstoneState}`; compare it centrally on every projection refresh and increment `taskActionRevision` only when that key changes. Do not increment revisions ad hoc in individual DOM actions, and never expose the real path in a DOM dataset or log.

Update the shared fake runtime again for `previewTxt()`'s returned summary and `consumeTxtPreview()`. Refactor `catalog-txt-import-confirmation-modal.test.ts` away from the old “clear binding before import” event order: the one-use runtime consume/activation boundary happens first, then binding/authority cleanup; cancellation and failed activation still preserve the old active catalog and binding.

Add a runtime-owned one-use operation and refactor legacy `importTxt(path)` to delegate with the current candidate hash:

```ts
export type ConsumeTxtPreviewResult = Readonly<{
  kind: "unchanged" | "activated";
  sourceSha256: string;
}>;

consumeTxtPreview(input: Readonly<{
  path: string;
  expectedSourceSha256: string;
}>): Promise<ConsumeTxtPreviewResult>;
```

The runtime operation holds the import/busy permit across all steps, requires its retained candidate hash to equal `expectedSourceSha256`, reopens and previews the supplied path, and rejects/clears the stale candidate if the bytes no longer match. If the verified hash equals the active source, it clears the candidate, restores the correct ready/paused/complete projection, and returns `unchanged` without writing. Otherwise it executes the existing import → activation → projection rebuild → reload transaction and rollback behavior, clears the candidate only after committed activation, and returns `activated`. No controller-side hash comparison may substitute for this atomic re-read.

`previewTaskCatalogTxt(path, expectedRevision)` first rejects a stale task card, then stores the returned path/hash draft only after `hybrid.previewTxt(path)` succeeds. Refactor the current `requestCatalogTxtImport()` body into one shared private helper used by both the legacy settings entry and `importPreviewedTaskCatalogTxt()`:

1. Confirm the exact preview candidate and pass the pending path/hash to `consumeTxtPreview()`.
2. On `unchanged`, consume the controller draft, report the new bilingual fixed key `task.txtContentUnchanged`, preserve the binding, and skip external projection refresh because the active catalog did not change.
3. On `activated`, immediately consume the controller draft—the preview crossed its one-use activation boundary.
4. Then attempt to clear `boundCloudLibrary`, synchronously install verification authority `null`, invalidate the trusted cloud view, and rebuild the local candidate-only projection before calling the controller's external `refreshCatalogProjection()`. The immutable adoption sidecar may remain for history, but its source/scope cannot match without the old binding. Even if cleanup save fails, the newly active TXT no longer matches the old binding, so authority remains `null`; cleanup or refresh failure cannot resurrect the consumed preview or make old overlays trusted. Source mismatch derives `needs-library` and blocks start.

If `consumeTxtPreview()` fails and restores the prior activation, retain confirm-import only when the runtime still exposes the same preview candidate hash; otherwise consume the stale draft and map the fixed import error. Add Chinese/English assertions for `task.txtContentUnchanged` and both credential-operation guidance keys. Thus every TXT entry shares one deterministic invalidation order, and reimporting identical bytes has an explicit safe no-op semantic. This task defines the picker/model contract but does not yet expose a new button; Task 9 wires `WorkbenchView` to create it. Do not store the native path in plugin data, recent directories, history, messages, or logs.

- [ ] **Step 4: Verify and commit Task 3**

```bash
npx vitest run \
  tests/ui/local-catalog-txt-picker.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts \
  tests/ui/catalog-txt-import-confirmation-modal.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git add \
  src/ui/local-catalog-txt-picker.ts \
  src/catalog/hybrid-catalog-runtime.ts \
  src/i18n/workbench-i18n.ts \
  src/ui/workbench-controller.ts \
  src/ui/workbench-view.ts \
  src/ui/settings-sections.ts \
  tests/helpers/ui-fixtures.ts \
  tests/fakes/fake-cloud-catalog-runtime.ts \
  tests/ui/local-catalog-txt-picker.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/ui/workbench-view.test.ts \
  tests/ui/settings-sections.test.ts \
  tests/ui/read-only-acceptance-surfaces.test.ts \
  tests/ui/catalog-txt-import-confirmation-modal.test.ts \
  tests/unit/i18n/workbench-i18n.test.ts
git commit -m "feat(目录): 增加安全 TXT 草稿与身份隔离"
git status --short
```

Expected: the TXT draft remains session-only; explicit identity mutation persists only its approved binding/tombstone reset; construction and startup remain side-effect free.

## Task 4: Preserve launch validation while removing the duplicate workbench confirmation

**Files:**

- Create: `src/catalog/verification-launch-request.ts`
- Create: `tests/unit/catalog/verification-launch-request.test.ts`
- Modify: `src/catalog/large-catalog-verification-progress.ts`
- Modify: `src/catalog/hybrid-catalog-runtime.ts`
- Modify: `src/ui/catalog-large-scan-confirmation-modal.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/main.ts`
- Modify: `tests/unit/catalog/large-catalog-verification-progress.test.ts`
- Modify: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Modify: `tests/ui/catalog-large-scan-confirmation-modal.test.ts`
- Modify: `tests/ui/workbench-controller.test.ts`
- Modify: `tests/packaging/composition-roots.test.ts`

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

export type VerificationLaunchSelectionValidator = (
  selection: CloudDirectorySelection,
  purpose: CloudDirectoryPickerPurpose,
) => CloudDirectorySelection;

export function validateVerificationLaunchRequest(
  input: VerificationLaunchRequest,
  validateSelection: VerificationLaunchSelectionValidator | undefined,
): VerificationLaunchRequest;
```

`verification-launch-request.ts` may import `CloudDirectorySelection`/`CloudDirectoryPickerPurpose` with `import type` only; it must not execute-import `cloud-directory-selection.ts`. Test the exact existing invariants: 1–5 unique valid groups for start and resume; valid non-root normalized parent; safe labels/counts/keys; structured selection revalidation for start; no new directory selection on resume; selection `effectiveRoot` equals launch root; category selection implies exactly one matching group; returned objects are detached. A start without an injected validator fails closed. Add a controller assertion that a task start invokes `hybrid.startLargeVerification()` after one page click without calling `CatalogLargeScanConfirmationPresenter.request()`.

Add failing progress/runtime tests for the resumable scope contract:

```ts
export interface LargeCatalogVerificationSummary {
  readonly verificationScope: CloudVerificationScope; // established in Task 2
  readonly selectedGroupKeys: readonly string[];
  // existing fields
}

export interface LargeCatalogBatchSummary {
  readonly verificationScope: CloudVerificationScope | null; // established in Task 2
  readonly legacyPromotionRequired: boolean; // established in Task 2
  readonly selectedGroupKeys: readonly string[];
  // existing fields
}
```

`summarizeLargeCatalogVerification()` must copy checkpoint group keys in checkpoint order, assert the count equals `selectedGroupCount`, and never expose the mutable checkpoint array. `batchFromVerification()`, `cloneBatch()` and runtime reload preserve that detached list. Test a process restart with a current-scope V4 five-category checkpoint and prove resume receives exactly those five keys in the same order—never the current recommendation or a newly edited draft. Pair it with one exactly adopted V3 fixture that must first promote locally to V4 while keeping the same keys/order, plus an unlisted V3 fixture that remains details-only.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run \
  tests/unit/catalog/verification-launch-request.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/packaging/composition-roots.test.ts
```

Expected: FAIL because the pure validator and direct task launch path do not exist.

- [ ] **Step 3: Extract validation and add direct task-only launch methods**

Move the current private `checkedRequest()` safety intent to the new catalog module, receive the structured selection validator as an injected function, and strengthen resume validation to require the exact 1–5 checkpoint groups instead of the legacy empty display-only array. This is still not a new selection: the adapter reconstructs only the stored scope. `main.ts` passes the normal `validateCloudDirectorySelection` implementation into the legacy Modal factory; `WorkbenchController` passes its already injected `catalogDirectorySelectionValidator` into direct validation. Missing injection fails closed. The new pure module and shared controller contain only the type-level dependency, so `main-acceptance.ts` still cannot reach `cloud-directory-selection.ts`; keep that file on the packaging forbidden-input list and add an explicit graph assertion. Extend the progress/runtime summaries with validated, detached `selectedGroupKeys`; when loading a checkpoint, reject count/key inconsistencies as corrupt instead of fabricating a resumable scope.

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

`withTaskActionPermit()` is the only code that checks revision/pending, sets controller-owned `taskActionPending` plus its nonce, creates a permit, and clears pending in `finally` **only if it still owns that nonce**. The launch helper must require and validate that permit for task-card calls, but must not reject merely because pending is true—the permit represents the one legal in-flight action. The separate cloud-authority permit from Task 3 prevents identity/scan races for the entire launch promise. Legacy confirmed callers omit `expectedRevision`/task permit and retain their existing busy guard until Task 10 removes the duplicate controls.

The helper must: recompute the semantic task key/revision; reject stale visible cards; reject source/generation/root-scope-mismatched bindings; clear hybrid message suppression; capture the before-batch progress marker; validate the exact currently visible 1–5-group scope; optionally ask the presenter only for a legacy caller; after that presenter returns, re-read the binding, generation, tombstone envelope and groups under the cloud-authority permit; derive one exact `CloudVerificationScope`; lock the root only at actual launch; pass that scope into start/resume; refresh the catalog projection; and unlock when the batch did not durably advance. It also preserves the current validation-error mapping, cancellation semantics, runtime-error mapping, resume-root-mismatch unlock/message behavior, prior overlay and checkpoint.

`performTaskVerificationAction()` acquires one permit and passes it to `runVerifiedLaunch()`. For start, use the exact group draft displayed on the task card (the default recommendation contains one; advanced mode may contain 2–5). For resume, ignore the current recommendation/draft and use only `snapshot.batch.selectedGroupKeys`; require valid tombstones without that batch id; require binding/current generation and authority to match; accept either current-scope V4 or the one exact adopted-V3 fingerprint. Validate every key and `selectedGroupCount`; if legacy promotion is required, create/fsync/activate V4 locally and re-read it under the same authority permit before `resumeLargeVerification()`. Both runtime entries receive the exact scope and may write only schema-2 overlays/V4 receipts. Add reconstructed-controller tests proving unlisted/stale-fingerprint V3, tombstone, old identity or old root blocks resume even if TXT/path match. This task entry does **not** call the duplicate confirmation presenter.

- [ ] **Step 4: Verify direct start, modal compatibility, and failure unlock**

```bash
npx vitest run \
  tests/unit/catalog/verification-launch-request.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/packaging/composition-roots.test.ts
```

Expected: PASS; one task click starts exactly the displayed root and 1–5-group scope; restarted current-scope V4 and exactly adopted/promoted V3 batches resume only their original keys; forged, stale-fingerprint, unlisted-V3 or source/generation/root-mismatched inputs fail before runtime; a rerender while pending cannot enable a second launch; legacy Modal still validates; cancellation, root mismatch, promotion/runtime/projection failure and non-advancing launches unlock without replacing prior artifacts.

- [ ] **Step 5: Commit Task 4**

```bash
git add \
  src/catalog/verification-launch-request.ts \
  src/catalog/large-catalog-verification-progress.ts \
  src/catalog/hybrid-catalog-runtime.ts \
  src/ui/catalog-large-scan-confirmation-modal.ts \
  src/ui/workbench-controller.ts \
  src/main.ts \
  tests/unit/catalog/verification-launch-request.test.ts \
  tests/unit/catalog/large-catalog-verification-progress.test.ts \
  tests/unit/catalog/hybrid-catalog-runtime.test.ts \
  tests/ui/catalog-large-scan-confirmation-modal.test.ts \
  tests/ui/workbench-controller.test.ts \
  tests/packaging/composition-roots.test.ts
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

Cover the default local-search path explicitly. When `selectCandidate(path)` runs under a verification purpose, compare the normalized selected basename/direct parent against the active TXT groups: exactly one matching `rootRelativePath` creates a category draft `{kind:"category", selectedPath:path, effectiveRoot:parent, groupKey}`; zero matches creates a normal directory draft for that path; multiple matches are ambiguous, set the closed `conflict` status and create no draft. Apply this to exact, recent and current-session-cache candidates, with no network call. Add the regression for the user's original error: selecting the visible category folder never stores that category itself as the API parent; `useSelection()` returns its parent plus group key.

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

Move, rather than duplicate, the existing state for candidate ranking, the four `enabledSources`, locator consent, browser path/layer/highlight, validated `draftSelection`, breadcrumb/category/current-directory selection, generation counters, abort controllers, `startBrowserLoad`, retry/continue/cancel, selection validation, recent persistence, and settle-once behavior into `CloudDirectoryPickerSessionService`. Give `selectCandidate()` one pure local inference helper that derives the category parent only on one exact active-group match; never guess on ambiguity. Translate every caught failure to the closed `CloudDirectoryPickerStatusCode` union at the session boundary.

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
  readonly legacyProgressMode: "none" | "will-preserve" | "requires-fresh";
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

Keep the cause of a failed legacy adoption private to the controller and session-only:

```ts
interface LegacyAdoptionFailureToken {
  readonly selectedEffectiveRootSha256: string;
  readonly activeSourceImportSha256: string;
  readonly legacyArtifactSetSha256: string;
}
```

`legacyProgressMode` is derived, never independently latched: malformed persisted adoption is unconditionally `requires-fresh`; a pending adoption is `requires-fresh` only while the current selected-root/source/artifact triple exactly matches this token, otherwise it is `will-preserve`; all other states are `none`. Never persist, render or log the token or any of its hashes.

Test that the initial page shows only back, search, recent/current-session matches, disambiguating parent paths, selected folder and one use action. Source filters, manual API path, request quotas and root controls must be absent until “浏览其他文件夹”; the four source filters appear only in that advanced region and delegate to the session. A conflict is visible but not selectable. The browser uses `createCloudDirectoryBrowserView()` inline, keeps its breadcrumb/highlight/current/category/continue/retry/cancel behavior, and restores the search focus when returning.

Controller tests must prove that only `useSelection()` can persist a binding; clicking a browser directory/category only updates `draftSelection`; a directory commit stores its own `effectiveRoot`; a category commit—including a category inferred from an inline local-search result—stores the parent `effectiveRoot` and selects only its `groupKey`; recent candidates alone do not bind; remember or binding-save failure reports no completion, keeps the page/session recoverable and leaves the old binding/model intact; cancel drops the draft; explicit close/dispose invalidates the session and stale results cannot bind. Task 7 adds the route-leave disposal assertion.

Add the one-time compatibility matrix: a legacy `pending` catalog shows `will-preserve` copy but no extra confirmation; matching active TXT/root plus exact artifact fingerprints commits generation 1, binding and adoption in one settings CAS; search count, verified coverage and group statuses are identical before/after; an adopted V3 batch offers resume and is promoted to V4 before zero-or-more later network calls. A deterministic whole-lineage conflict (root mismatch, stale active manifest/checkpoint or ambiguity) makes zero settings/network changes, records only the exact private failure token and derives `requires-fresh`; its sole primary button becomes “使用此文件夹并重新检查”. That second explicit click atomically writes generation 1, binding, `ineligible` adoption and the exact legacy batch tombstone, leaving files as history and reaching ready after restart. Selecting another folder, importing another TXT, or changing any legacy artifact makes the token mismatch immediately, returns the page to `will-preserve`, and makes the next use action retry adoption rather than discard progress. An initially malformed sidecar enters `requires-fresh` immediately without a token, so one explicit click performs the same fresh transition instead of looping. Individual corrupt/unprovable overlay entries may be skipped with a closed detail count; they do not force the whole-lineage state. Transient I/O failures remain retryable and never silently become fresh. A post-commit projection rebuild failure/restart still serves the allowlisted legacy active set and retries locally. Identity replacement before adoption makes it permanently ineligible; no recent/inferred directory can adopt; schema-2 overlay/unified artifacts coexist with allowlisted legacy schema-1 artifacts, with schema 2 winning per group, while promoted V4 batches supersede only their exact adopted V3 batch. Test wrong root → deterministic conflict → select the matching root → preservation succeeds; legacy artifact mutation follows the same reset/retry path; and a stale button revision or old token can never fresh-bind changed inputs.

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

On explicit settle, execute the entire selection revalidation, optional legacy-adoption preparation, settings transaction, authority installation and projection rebuild inside `withCloudAuthorityPermit("library-binding", ...)`; this serializes the binding/root change against verification launch, catalog scan launch and every credential operation. The permit is fail-fast, while pause/cancel remain the only interrupts that bypass it. Add deferred-promise tests proving a binding/root change cannot cross a launch or identity mutation in either direction, rejected conflicts never run later, and a session/adoption result is revalidated after its await before the durable write.

Inside that permit:

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
const currentSettings = store.settings();
const rootChanged = currentSettings.boundCloudLibrary !== null
  && currentSettings.boundCloudLibrary.path !== effectiveRoot;
const rotateGeneration = currentSettings.cloudVerificationGeneration === 0 || rootChanged;
const nextGeneration = rotateGeneration
  ? checkedNextVerificationGeneration(currentSettings.cloudVerificationGeneration)
  : currentSettings.cloudVerificationGeneration;
const proposedScope = deriveCloudVerificationScope({
  schemaVersion: 1,
  path: effectiveRoot,
  sourceImportSha256: active.sourceImportSha256,
  verificationGeneration: nextGeneration,
});
const legacyInput: LegacyAdoptionFailureToken | null =
  active.legacyArtifactSetSha256 === null
    ? null
    : {
        selectedEffectiveRootSha256: proposedScope.cloudRootSha256,
        activeSourceImportSha256: active.sourceImportSha256,
        legacyArtifactSetSha256: active.legacyArtifactSetSha256,
      };
const forceFreshByInvalid = currentSettings.legacyVerificationAdoption.state === "invalid";
const forceFreshByToken = legacyInput !== null
  && sameLegacyAdoptionFailureToken(this.legacyAdoptionFailureToken, legacyInput);
const forceFreshLegacy = forceFreshByInvalid || forceFreshByToken;
let preparedAdoption: LegacyVerificationAdoptionV1 | null = null;
if (
  !forceFreshLegacy
  && currentSettings.cloudVerificationGeneration === 0
  && currentSettings.legacyVerificationAdoption.state === "pending"
) {
  try {
    preparedAdoption = await hybrid.prepareLegacyVerificationAdoption(proposedScope);
    await hybrid.revalidatePreparedLegacyAdoption(preparedAdoption);
  } catch (error) {
    if (!isDeterministicLegacyAdoptionConflict(error)) throw error;
    if (legacyInput === null) throw new RangeError("legacy-adoption-input-unavailable");
    this.legacyAdoptionFailureToken = legacyInput;
    return; // zero settings writes and zero network requests
  }
}
const latestActive = hybrid.snapshot().active;
const latestSettings = store.settings();
const latestLegacyInput = latestActive?.legacyArtifactSetSha256 == null
  ? null
  : {
      selectedEffectiveRootSha256: proposedScope.cloudRootSha256,
      activeSourceImportSha256: latestActive.sourceImportSha256,
      legacyArtifactSetSha256: latestActive.legacyArtifactSetSha256,
    };
if (
  latestActive?.sourceImportSha256 !== active.sourceImportSha256
  || latestActive?.legacyArtifactSetSha256 !== active.legacyArtifactSetSha256
  || latestSettings.cloudVerificationGeneration !== currentSettings.cloudVerificationGeneration
  || legacyAdoptionFingerprint(latestSettings.legacyVerificationAdoption)
    !== legacyAdoptionFingerprint(currentSettings.legacyVerificationAdoption)
) throw new RangeError("cloud-verification-generation-stale");
if (
  forceFreshByToken
  && !sameLegacyAdoptionFailureToken(this.legacyAdoptionFailureToken, latestLegacyInput)
) {
  this.legacyAdoptionFailureToken = null;
  return; // derive will-preserve; never fresh-bind changed input
}
const adoptedBatchId = preparedAdoption?.state === "adopted"
  ? preparedAdoption.resumableBatch?.batchId ?? null
  : null;
const repairBatchId = currentWorkflowAffectingBatchId({
  excludeBatchId: forceFreshLegacy ? null : adoptedBatchId,
  includeLegacyFreshStart: forceFreshLegacy,
  includeRootChange: rootChanged,
});
await store.updateSettings((settings) => {
  const mustRepair = settings.verificationBatchTombstones.state === "invalid";
  if (
    settings.cloudVerificationGeneration !== currentSettings.cloudVerificationGeneration
    || legacyAdoptionFingerprint(settings.legacyVerificationAdoption)
      !== legacyAdoptionFingerprint(currentSettings.legacyVerificationAdoption)
  ) {
    throw new RangeError("cloud-verification-generation-stale");
  }
  return {
    ...settings,
    cloudVerificationGeneration: nextGeneration,
    boundCloudLibrary: {
      schemaVersion: 1,
      path: effectiveRoot,
      sourceImportSha256: active.sourceImportSha256,
      verificationGeneration: nextGeneration,
    },
    legacyVerificationAdoption: forceFreshLegacy
      ? { schemaVersion: 1, state: "ineligible" }
      : preparedAdoption
        ?? (settings.legacyVerificationAdoption.state === "pending"
          ? { schemaVersion: 1, state: "none" }
          : settings.legacyVerificationAdoption),
    verificationBatchTombstones: repairBatchId === null && !mustRepair
      ? settings.verificationBatchTombstones
      : repairVerificationBatchTombstones(
          settings.verificationBatchTombstones,
          repairBatchId,
        ),
  };
});
```

The normal session revalidates the concrete selection against its original purpose immediately before adapting it to the safe `FolderSelectionDraft`; the shared controller never executable-imports or constructs `cloud-directory-selection.ts`, though normal composition may supply its existing validator through the type-only port defined in Task 4. The controller normalizes the returned non-root effective root, rechecks a category key against the current active catalog, and re-reads settings, active source, artifact-set hash, adoption fingerprints and batch immediately before the durable write. Reject if source, generation, full adoption fingerprint or repair batch changed since selection began. If a recoverable V3 exists while adoption is pending, its canonical source/root must match. A deterministic mismatch/stale/ambiguous result stores only the exact private failure token and returns; transient I/O continues to show retry. Before a token-authorized fresh CAS, re-read and compare the token again; any changed folder/source/artifact clears that session token, derives `will-preserve` and performs zero writes so preservation is retried on the current input. V1 data without a provable V3 root lineage may be adopted only by exact immutable fingerprint under this one explicit current-root choice; document that this preserves the prior trust model but cannot cryptographically prove the historic Baidu account. Individual unverifiable overlays are skipped and remain history; never inflate coverage merely to preserve a number.

First binding rotates generation 0 to 1. An actual later root change rotates again and tombstones the latest non-complete batch; the one allowlisted V3 is exempt only during its one-time generation-1 adoption. Same root/identity preserves generation and scope-tagged/adopted results. If the visible workflow is repairing a batch or tombstones are invalid, use the dedicated repair helper in the **same settings transaction**. `requires-fresh` is the only branch allowed to replace pending/invalid adoption with `ineligible`, and for pending adoption it must be backed by the still-matching private failure token; it also tombstones the exact legacy resumable batch and installs a clean scoped binding. Thus one explicit recovery click survives restart and cannot loop back to repair. No other render/search/recent-path action may perform this conversion.

Immediately after durable save, clear the controller's session-only failure token, synchronously install `CloudVerificationAuthority` containing the new scope and saved allowlist, then rebuild the local schema-2 unified projection. A rebuild failure keeps the atomic binding/adoption transaction and continues serving only the exactly allowlisted prior unified/overlays; restart retries the local rebuild without clearing coverage or rewriting settings. Only after successful rebuild, update `verificationRoot`, structured selection/group, close the session and recompute the semantic key. If an adopted V3 exists, the task shows the usual “继续检查”; its first click performs local V4 promotion before network. New identity/root makes the old allowlist history-only and yields a fresh recommendation.

The page adds no migration wizard or second confirmation. `will-preserve` shows one short sentence above the existing “使用此文件夹” button—“会沿用这台设备上与该文件夹匹配的已有检查进度”—and after success “已保留已有进度”. `requires-fresh` replaces that button, not adds another, with “使用此文件夹并重新检查” plus one sentence that old progress remains in history. Details stay closed. Add these `folderSelection.*` Chinese/English keys in this task and never pass ad-hoc copy through technical `statusCode`.

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
  readonly pauseRequested: boolean;
}

export interface TaskPageActions {
  readonly onPrimary: (revision: number) => Promise<void> | void;
  readonly onChooseDifferentCategory: () => void;
  readonly onOpenDetails: () => void;
}
```

For every workflow row, assert exactly one `[data-task-primary]` button and the expected Chinese label. The default ready card must show recommended category, candidate count, bound library name, single-category scope, and “只读取目录信息，不下载 PDF，不修改笔记” in the same visible card. Advanced ready cards show the exact 2–5 selected categories and the same read-only boundary in that one visible action card. A paused/retry card shows the exact original checkpoint categories, not a new recommendation. The full group checklist must be absent. “更换分类” is secondary.

Also assert:

- running → only “暂停”, even while the original long-running start/resume promise still owns `actionPending`; paused → only “继续检查”; complete/unavailable → “去文库搜索”; repair states → one recovery action;
- pending immediately changes the label to “正在打开…” / “正在开始…” / “正在继续…”, sets `aria-busy="true"`, and rejects double click;
- there is no inert primary button: if an action cannot run, derive a different recovery state instead of silently disabling “开始检查”;
- full-library coverage uses `coveredCandidatePdfCount / pdfCount`; current activity remains indeterminate; safety quota stays in collapsed “运行详情”; details are closed by default;
- stale `taskActionRevision` cannot launch; the controller's semantic task key increments the revision before a changed scope can become actionable;
- a pending promise followed by an unrelated runtime rerender remains pending and cannot submit twice; pending is controller-owned, not renderer-local.
- start promise unresolved → top-level `executionActive:true` → Pause remains enabled; the first click sets `pauseRequested`, aborts exactly once through a dedicated interrupt channel, and later settlement of the old start nonce cannot clear or corrupt a newer action.

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

Add `requestTaskPause(expectedRevision)` as the sole exception to normal task permits. It requires a freshly derived running workflow and `hybrid.executionActive === true`, uses a controller-owned `pauseRequested` latch, and calls `cancelLargeVerification()` at most once. It acquires neither the task-action permit nor the cloud-authority permit, so it can interrupt the long promise that owns both; it never starts work or mutates credentials. Clear the latch only when execution-active becomes false or the owning runtime generation changes. While running, renderer state is driven by workflow + `pauseRequested`, not by the still-pending launch label.

For non-host actions, `performTaskPrimaryAction()` either acquires one permit around its branch or delegates to the already permit-owning verification entry—never both:

```ts
switch (workflow.primaryAction) {
  case "import-txt": return this.withTaskActionPermit(expectedRevision, () => this.importPreviewedTaskCatalogTxt());
  case "open-connection": return this.withTaskActionPermit(expectedRevision, async () => this.selectRoute({ tab: "more", page: "connection" }));
  case "choose-library": return this.withTaskActionPermit(expectedRevision, async () => this.selectRoute({ tab: "task", page: "folder-selection" }));
  case "start": return this.performTaskVerificationAction("start", expectedRevision);
  case "pause": return this.requestTaskPause(expectedRevision);
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

The View delegates `choose-txt` to `performTaskTxtSelection()` and never opens the picker first. The controller compares workflow/revision before granting the permit and again before consuming a returned path. Every snapshot and rerender reads the same controller-owned pending/nonce/pause fields. Add double-click plus mid-await-rerender tests for start, resume and the open TXT picker path, plus start-promise-pending → running → single pause → settled-start nonce ownership. The dispatcher must not auto-open OAuth, start folder browsing, start verification or resume network work on construction/restart.

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

The default connection recovery surface is explicitly “重新连接原账号” and dispatches `repair-same-account`; its concise copy says to complete authorization with the original Baidu account. “更换账号或 AppKey/SecretKey” is a separate advanced/destructive subsection that dispatches `replace-identity`, explains that old cloud results stay in history and the library must be selected again, and retains the existing credential confirmation gates. Neither action runs on route entry or render. Add DOM/dispatcher tests proving the two intents cannot be confused and the default task recovery never rotates authority.

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
- an upgraded `pending` legacy catalog preserves its exact local search results, verified coverage and paused progress before binding; startup/recent directories never seal adoption or start network;
- task start sends exactly one previously displayed bound root and the exact visible 1–5-group scope to the hybrid runtime;
- launch, cloud scan, library/root binding and identity mutation share one controller cloud-authority permit; deferred presenter/settings/runtime interleavings cannot cross, and the source, generation, tombstone and exact group scope are revalidated immediately before runtime;
- every new batch is persisted as exact-key checkpoint V4 with the full generation/source/root scope before its first Baidu request; native creation prepares a non-enumerable sibling staging directory, atomically claims the never-overwritten final batch id, and publishes only under its nonce-matched `published` child, so crashes before/after slot, pointer, claim, internal publish or parent fsync never expose a half-created newest batch or hide the last valid older batch; an unpublished incomplete claim may be recovered/ignored, but once `published` exists any claim/manifest/pointer/slot mismatch fails closed globally without selecting an older batch; collisions and ambiguous claims never overwrite; the bounded A/B checkpoint slots plus exact atomic active pointer survive each enumerated update crash phase, malformed/missing/hash-mismatched pointers fail closed without V3 fallback, old page prefix plus new envelope-V3 chain validates, repeated promotion is idempotent and same batch-id tombstones still apply; only the one exact-fingerprint V3 in a current-scope adoption may promote, while unlisted/stale/old-scope data remains history even with the same TXT/root and valid-empty tombstones;
- adopted V3 promotion validates its complete expected immutable legacy receipt prefix, using `runOrdinal - 1` for a live `scanning` checkpoint and `runOrdinal` after finalization, and never fabricates a receipt; every later V4 finalize first durably journals the staged receipt/slot transition, then installs an exact scope-tagged receipt before the slot references its ordinal/hash and before the pointer can expose terminal state; missing/bad legacy receipts and V4 journal/receipt/slot/pointer mismatches fail before network, while crashes at journal-before-receipt, receipt-before-slot, slot-before-pointer and pointer-before-journal-settle recover idempotently without duplicate receipts or false completion;
- restarted current-scope V4 and exactly adopted/promoted five-group checkpoints resume with the same five keys in checkpoint order; recommendation and edited draft cannot replace or enlarge them;
- one authorized batch may continue only its original selected groups under existing segment limits;
- pause/restart only prepares a resumable card and never reconnects automatically; crash-restored current-scope V4 or exactly adopted V3 `scanning` data has `executionActive:false` and can resume (V3 only after local promotion), while unlisted V3/old-scope data remains history; none creates an unpausable credential-change deadlock; a live start before first progress has top-level `executionActive:true`, keeps Pause visible, and one dedicated interrupt aborts it exactly once while the long launch permit remains held;
- token expiration, rate limiting, path mismatch and malformed response preserve the prior active projection and checkpoint while mapping to one recovery action; malformed/integrity responses never offer resume;
- first explicit generation-0 binding atomically saves binding plus the exact immutable legacy allowlist; matching upgrade artifacts retain coverage/search; root mismatch, stale fingerprint or ambiguous lineage first makes zero settings/network changes and exposes one “使用此文件夹并重新检查” action only for that exact session-only selected-root/source/artifact-set failure token, whose still-matching explicit click writes `ineligible` plus clean binding/tombstone once and remains ready after restart; selecting a correct different root, importing another TXT or mutating the legacy artifact set automatically returns to preservation and cannot reuse the stale fresh-start action; initially invalid adoption enters that same reachable fresh path without a token; token values never persist/render/log; save failure remains zero-change, rebuild failure/crash continues using the allowlist, and recent directories never adopt; other repair batches use bounded exact tombstones, with persisted >16/malformed envelopes fail-closed and sticky;
- TXT replacement preserves the old active catalog until explicit import succeeds; the runtime atomically reopens and rehashes the pending path before consuming it; identical content is a logical no-op that clears the one-use runtime/controller draft and preserves a valid binding, while a different-hash activation consumes its draft immediately and any later projection-refresh or binding-cleanup save failure derives `needs-library` from the source mismatch instead of reopening confirmation;
- same-account authorization repair and explicit identity replacement are separate intents: both fail fast during a live scan/verification; repair with unchanged credentials preserves generation/binding/adoption, while replacement first atomically increments generation, clears binding, tombstones the current non-complete batch and makes pending adoption ineligible before OAuth/SecretStorage mutation; a new identity/root cannot reuse the old allowlist or scoped artifacts after restart, while same-account repair preserves exact adopted/schema-2 results;
- a completed single-category batch returns to ready when another unverified category exists; whole-library complete appears only when no recommendation remains;
- selecting a locally searchable category directory infers its parent root only on one exact active-group match; ambiguity never guesses or binds;
- normal build contains the injected picker/session/connection capabilities; acceptance build's dependency graph still exposes no OAuth, Baidu directory selection/browser/locator, SecretStorage or executable cloud action;
- no PDF download method or Vault write action is called by any library/task flow;
- start, resume and host TXT selection each hold one controller permit across async work and remain single-submit through unrelated rerenders; conflicting authority operations fail immediately, never queue and execute later;
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
- one-time legacy adoption behavior, its exact fingerprint/root gates, and the honest limitation that historic artifacts have no cryptographic Baidu-account identity—explicitly choosing the current root is the one-time ownership declaration;
- same-account reconnect versus explicit account/credential replacement, including the requirement to use the original account on the repair path;
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
