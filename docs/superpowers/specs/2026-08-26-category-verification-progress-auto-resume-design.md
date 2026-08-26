# Knowledge Workbench 分类核验可信进度与自动分段续跑设计

- 状态：已实现；自动化回归、normal build 与 acceptance build 已通过；真实百度核验待单独授权
- 日期：2026-08-26
- 适用产品：Knowledge Workbench for Obsidian
- 目标版本：`v0.1.2`
- 前置规格：`2026-08-10-baidu-catalog-hybrid-large-library-design.md`、`2026-08-11-knowledge-workbench-ui-i18n-design.md`、`2026-08-23-smart-cloud-directory-picker-design.md`
- 范围：仅调整大型 TXT 候选目录的分类核验进度、自动分段续跑、运行详情和错误恢复；不改变 PDF 内容边界或百度网盘只读边界

## 1. 背景与问题

现有分类核验按固定片段预算执行：每段最多 10,000 个 PDF、500 个目录、300 次列表请求和 30 分钟。达到任一预算后，checkpoint 会安全落盘，但用户必须再次点击“继续核验”。

当前真实使用界面曾显示：68,959 个候选 PDF、57,089 个待核验、11,870 个已核验、7/24 个分类完成，当前片段因达到 PDF 上限而暂停。这里同时存在三个产品问题：

1. `pdfCount` 是“当前片段已提交 PDF 数”，不是整个分类或全库完成度，但界面没有解释；
2. 百度递归遍历在完成前不知道云端总量，不能诚实提供“当前分类完成百分比”；
3. 完整分类可能需要多个片段，反复手动继续既不方便，也容易让用户误以为核验已经结束。

此外，runtime 目前仅在整个批次 `complete` 时重新加载活动目录摘要。如果前一个分类已经完成、后一个分类在同一批次中暂停，全库覆盖率可能继续显示旧值。服务也没有向 runtime 提供每页提交后的实时进度事件。

本阶段采用已批准的方案：

- A 作为主界面：全库覆盖率、当前扫描活动、本段安全配额三层分开显示；
- C 作为折叠“运行详情”：请求数、队列、目录、片段和停止原因按需展开；
- 一次确认后，在同一会话、同一根目录、同一批次和同一组选中分类内自动串行续跑预算片段；
- 用户暂停、百度限流、授权或网络问题、响应异常、本地一致性错误都立即停止自动链，并保留 checkpoint。

## 2. 用户目标与成功标准

完成后，用户应能够：

1. 一眼看出全库有多少候选项属于“已完整核验分类”；
2. 区分“正在扫描”“本段配额使用量”和“全库真实覆盖率”；
3. 一次确认后让当前选中的分类自动跨越多个安全片段，直到完成或安全停止；
4. 随时暂停，并在当前请求返回后的安全边界得到已保存 checkpoint；
5. 在限流、令牌失效、网络、路径、权限或数据错误时看到明确原因和可执行恢复动作；
6. 展开“运行详情”查看本段和累计请求、已提交页面、完成目录、待处理队列、当前片段和停止原因；
7. 关闭或重启 Obsidian 后保持离线，不自动联网；重新选择会话根目录后再手动继续。

验收级成功标准：

- 全库覆盖率的分子是已存在完整 overlay 的分类所包含的 TXT 候选 PDF 数之和，分母是活动 TXT 候选总数；
- `difference` 分类和 `verified` 分类都计入覆盖率，`verifiedCount` 不得冒充覆盖分子；
- 当前分类使用不确定进度条，不提供 `aria-valuenow`，并明确说明“云端总量尚未知”；
- 只有本段安全配额使用确定进度条，显示 `segmentPdfCount / 10,000`，且文案明确它不是完成度；
- 服务每次持久化请求许可、页面、分类推进或终态后都能提供一致的进度快照；
- 自动链只对四类预算暂停继续，所有用户取消和错误都会终止自动链；
- 自动链在没有持久进展时停止，不能重复请求同一超限页面形成死循环；
- 全库覆盖率和累计计数只增不退，本段计数在新片段开始时正确归零；
- 任何核验路径都只读取百度元数据，下载 PDF 字节数继续为 `0`。

## 3. 非目标与不变边界

本阶段不会：

- 下载、打开、OCR、解析、摘要或索引 PDF 正文；
- 上传、移动、重命名、覆盖或删除百度网盘文件；
- 自动选择用户没有勾选的分类；
- 绕过每段 10,000 PDF、500 目录、300 请求和 30 分钟预算；
- 在启动 Obsidian、启用插件或恢复 Vault 时自动联网；
- 持久化“仅本次会话”的云端根目录；
- 把当前分类的已扫描 PDF 数除以 TXT 候选数，制造可能超过 100% 的假完成度；
- 对百度限流或其他错误执行无上限自动重试；
- 改变大型 TXT 导入上限、最多选择 5 个分类或已有 overlay 原子激活语义；
- 将路径、AppKey、SecretKey、OAuth 令牌、授权码或原始响应写入进度 UI、普通日志或测试 fixture。

## 4. 三层进度口径

### 4.1 全库核验覆盖率

全库进度是唯一确定的“完成百分比”：

```text
coveredCandidatePdfCount =
  sum(group.pdfCount for group with a complete active overlay)

overallCoverage =
  active.pdfCount === 0 ? 0 : coveredCandidatePdfCount / active.pdfCount
```

规则：

- overlay 完整发布后，该分类才进入分子；
- 分类内存在 cloud-added、cloud-missing、renamed 或 moved 差异不影响“已完整核验”状态；
- UI 同时显示百分比、候选项数量和分类数量，例如 `17.2% · 11,870 / 68,959 · 7 / 24 个分类`；
- 百分比夹在 `0%` 到 `100%`，零分母显示 `0%`，不得出现 `NaN` 或 `Infinity`；
- 新 TXT 导入会产生新的活动候选集并按既有规则重新计算，不承诺跨候选版本单调。

### 4.2 当前分类扫描活动

百度递归列表完成前没有可靠总目录数或总 PDF 数，因此当前分类只显示活动状态：

- 文案：`正在核验：<分类名> · 第 <runOrdinal> 段`；
- 使用不确定动画条和 `role="progressbar"`，不设置 `aria-valuenow/min/max`；
- 辅助文案：`云端总量尚未知，正在递归发现目录`；
- 暂停、错误或完成后停止动画并显示对应状态；
- 活动条不参与全库覆盖率计算，也不宣称当前分类完成百分比。

### 4.3 本段安全配额

本段 PDF 配额是确定进度：

- `segmentPdfCount / LARGE_CATALOG_RUN_BUDGET.maxPdfCount`；
- 使用确定进度条并设置合法的 ARIA 数值；
- 标题固定为“本段安全配额”，不能写成“扫描完成度”；
- 新片段开始时分子归零，`runOrdinal` 加一；
- 在折叠详情中同时显示目录、请求和时间预算，避免主界面堆叠四条进度条。

## 5. 主界面与运行详情

### 5.1 主界面

分类核验页面按以下顺序呈现：

1. **全库核验覆盖率**：确定进度条、候选 PDF 覆盖数、完成分类数；
2. **当前分类扫描活动**：分类名、片段序号、不确定进度条和总量未知说明；
3. **本段安全配额**：本段 PDF 数和 10,000 上限；
4. **当前状态卡片**：自动续跑中、正在保存 checkpoint、已暂停、错误或完成；
5. **主要动作**：运行中仅显示“暂停核验”；停止后依据原因显示“继续核验”“重新连接”“重新选择目录”或“重新开始”；
6. **运行详情**：默认折叠。

分类选择、云端根目录和一次性确认继续沿用现有门禁。一次确认只授权确认框中列出的分类和根目录；所选分类全部完成后必须停止，不能自动选择其余分类。

### 5.2 折叠运行详情

`details[data-verification-run-details]` 默认关闭，并保留用户在当前页面会话中的展开状态。内容包括：

- 当前自动片段序号；
- 本段 / 累计列表请求数；
- 本段 PDF、发现目录和忽略文件数；
- 批次累计已提交 PDF 数和页面数；
- 已完成目录数；
- 当前 pending 队列长度；
- 已完成 / 已选择分类数；
- 当前停止原因；
- checkpoint 是否已保存及最近一次安全状态。

页面因 runtime emit 重绘时，不得强制折叠详情或无故丢失键盘焦点。

建议使用稳定测试属性：

- `data-verification-overall-progress`
- `data-verification-current-progress`
- `data-verification-segment-budget`
- `data-verification-run-details`
- `data-verification-run-requests`
- `data-verification-run-queue`
- `data-verification-run-stop`

设置页继续只显示简短摘要；技术计数若保留，同样必须放入折叠区，主工作流以知识工作台为准。

## 6. 自动分段状态机

### 6.1 状态流

```text
IDLE
  └─ 用户确认一次 → RUNNING_SEGMENT

RUNNING_SEGMENT
  ├─ complete → DONE
  ├─ paused + 预算原因 → CHECKING_BOUNDARY
  ├─ paused + user-canceled → PAUSED_BY_USER
  ├─ partial/error → BLOCKED_ERROR
  └─ dispose/root/batch/source 变化 → STOPPED

CHECKING_BOUNDARY
  ├─ 已取消或 generation 失效 → PAUSED_BY_USER
  ├─ 无持久进展 → STOPPED_NO_PROGRESS
  ├─ 达到自动链上限 → STOPPED_AUTO_LIMIT
  └─ checkpoint 已完成且边界有效 → RUNNING_SEGMENT
```

`RUNNING_SEGMENT` 必须严格串行；上一段 `finalizeBatchRun` 和 receipt 完成前不得调用下一次 `runSegment`。

### 6.2 可自动继续的停止原因

仅以下 `paused` 原因可进入下一段：

- `pdf-limit`
- `directory-limit`
- `list-request-limit`
- `time-limit`

它们必须同时满足：

- 仍处于同一次已确认的自动链；
- 根目录、batch ID、source SHA 和选中分类序列没有变化；
- 外层取消信号未触发；
- 当前 segment 已完全终结并保存；
- 相比 segment 开始时存在新的已提交页面、pending 推进、完成目录或分类推进。

请求数、`runOrdinal` 或耗时变化不属于持久进展。

### 6.3 自动链安全上限

一次确认启动的自动链最多连续执行 12 个片段。该上限：

- 覆盖 120,000 个片段 PDF 配额，高于本产品 70,000 个 TXT 候选上限，为正常核验保留云端差异和目录片段余量；
- 同时把理论最坏情况限制在 3,600 次列表请求和 6 小时片段时间预算内；
- 达到后保存当前 checkpoint，显示“已达到本次自动续跑安全上限”；
- 用户可明确点击“继续核验”开启新的、同样最多 12 段的自动链；
- 不改变底层 checkpoint schema，也不把会话根目录持久化。

### 6.4 无进展防循环

单个百度分页最多可返回 1,000 条，而每段目录预算只有 500。若某页包含 501 个目录，该页会整页拒绝提交；如果无条件自动 resume，会永远重复同一请求。

runtime 在每段前后比较持久进展标记：

```ts
interface LargeVerificationProgressMarker {
  readonly committedPageCount: number;
  readonly completedDirectoryCount: number;
  readonly completedGroupCount: number;
  readonly currentGroupIndex: number;
  readonly pendingFingerprint: string;
}
```

预算暂停且标记完全相同时，自动链立即停止，保留原始预算停止原因，并增加仅存在于 runtime/UI 的 `auto-resume-no-progress` 状态。它不伪造新的持久化 stop reason。

从异常退出恢复、原 checkpoint 仍为 `scanning` 且预算已经耗尽时，可以先完成一次“旧片段边界正规化”；该动作不计为新的自动片段。正规化后若新片段仍无持久进展，必须停止。

### 6.5 粘性取消

整个自动链共享一个外层 `AbortController` 和 generation，而不是每个片段创建彼此独立的取消状态：

- 段内点击“暂停”会 abort 当前请求边界；
- 两段之间点击“暂停”也会阻止下一段启动；
- 请求已经发出时，沿用现有语义：等待响应返回，响应后检查取消，不提交该页；
- dispose、插件禁用、连接撤销或新批次替换都会使 generation 失效；
- 迟到结果不得更新 DOM、开始下一段或覆盖更新的活动目录。

## 7. 错误、暂停与恢复

### 7.1 必须停止自动链

以下情况绝不自动重试：

- `user-canceled`
- `baidu-rate-limited`
- `baidu-token-expired`
- `baidu-access-unavailable`
- `baidu-permission-denied`
- `baidu-not-found`
- `invalid-baidu-response`
- `hybrid-snapshot-corrupt`
- `hybrid-batch-invalid`
- `hybrid-batch-unavailable`
- `hybrid-cloud-root-mismatch`

百度 adapter 仍可按现有规则对 token 执行一次内部刷新；刷新后仍失败即进入上述停止状态。

### 7.2 恢复动作

- 用户暂停：显示“继续核验”；
- 百度限流：显示“请求受限，稍后继续”，允许用户稍后手动恢复同一 checkpoint；
- token 失效：显示“重新连接百度网盘”，连接恢复后才能继续；
- 临时访问不可用：显示“检查网络后继续”；
- 权限或路径不存在：停止恢复按钮，要求重新选择根目录并开始新批次；
- 响应异常或本地 checkpoint/快照异常：禁止自动或手动重放，显示安全诊断建议；
- 自动链 12 段到限或无进展：显示 checkpoint 已保存；前者允许继续，后者要求先检查目录结构或预算问题。

service 已能从 `partial` checkpoint 继续，但当前 runtime 对所有 `partial` 都隐藏恢复入口。本阶段只为明确可恢复的 `baidu-rate-limited`、`baidu-token-expired` 和 `baidu-access-unavailable` 开放手动恢复；其他错误保持 fail-closed。

### 7.3 重启行为

Obsidian 重启后：

- 只加载 checkpoint 和离线摘要；
- 不创建自动链，不调用百度列表 API；
- 把异常退出时的 `scanning` 显示为“可恢复的已暂停”；
- 用户重新选择与 checkpoint hash 匹配的会话根目录并点击继续后，才开始新的自动链；
- 路径不匹配继续使用现有 `hybrid-cloud-root-mismatch` 拒绝逻辑。

## 8. 数据模型与进度事件

### 8.1 活动目录摘要

`HybridCatalogActiveSummary` 新增：

```ts
readonly coveredCandidatePdfCount: number;
```

它由完整活动 overlay 对应分类的候选数量计算，不从 `verifiedCount` 推导。

### 8.2 批次摘要

在不改变现有 checkpoint V3 schema 的前提下，service 从已加载的 records、groups 和 checkpoint 派生并向 runtime 暴露：

```ts
readonly selectedGroupCount: number;
readonly completedGroupCount: number;
readonly currentGroupIndex: number;
readonly currentGroupKey: string | null;
readonly committedPdfCount: number;
readonly committedPageCount: number;
readonly completedDirectoryCount: number;
readonly pendingDirectoryCount: number;
```

既有 `pdfCount/directoryCount/listRequestCount` 继续表示本段，`cumulativeListRequestCount` 继续表示批次累计。`committedPdfCount` 使用 `loaded.records.length`；页面、完成目录和 pending 数从 checkpoint groups 计算。

### 8.3 持久化后事件

`LargeCatalogVerificationService` 增加可选的进度观察边界。事件只能在以下持久化成功后发出：

- `saveBatchPermit`
- `commitBatchPage`
- `advanceBatchGroup`
- `finalizeBatchRun`

事件不包含云端路径、文件名、fsId、凭据、令牌或响应内容，只包含聚合数字、状态、原因、当前 group key 和 run ordinal。UI listener 的异常不得回滚或破坏已经持久化的扫描数据。

runtime 收到事件后：

- 更新本段和批次聚合进度并 emit；
- 分类完整发布时重新加载 active summary；
- 每段终止时无论 `complete`、`paused` 或 `partial` 都重新加载 active summary，修复当前只在全批次完成后刷新的旧行为；
- 所有异步更新都检查 generation、dispose 和外层取消状态。

## 9. 组件边界与预计修改面

定向调整：

- `src/catalog/large-catalog-verification-service.ts`：聚合摘要、持久化后事件；
- `src/catalog/hybrid-catalog-runtime.ts`：自动链、粘性取消、进展标记、12 段上限、每段 active 刷新和可恢复 partial 判定；
- `src/catalog/hybrid-catalog-types.ts`：只增加 runtime 级常量或非持久化类型，不改变 checkpoint V3；
- `src/ui/verification-page.ts`：三层进度、状态卡片、折叠运行详情和动作映射；
- `src/ui/settings-sections.ts`：保持摘要优先，技术信息折叠；
- `src/ui/workbench-view.ts`：保存 details 展开状态和焦点；
- `src/i18n/workbench-i18n.ts`：中英文进度、自动续跑、停止原因、恢复动作与 ARIA 文案；
- 测试 fake：支持进度事件、连续 segment 结果、段间取消和聚合快照。

不新增第二套百度 source、OAuth 或存储 adapter，不创建后台 worker，不复制 checkpoint 仓库。

## 10. 可访问性与视觉规则

- 全库和本段确定进度使用原生 `<progress>` 或等价 ARIA，并提供可读文本；
- 当前扫描不确定进度不得声明伪造数值；
- 动画遵守 `prefers-reduced-motion`，减少动态时改用静态“正在核验”状态；
- 颜色不是唯一状态信号，必须同时提供图标或文字；
- 状态变化通过节制的 `role="status"` 宣告，不为每一页重复打断屏幕阅读器；
- 错误使用 `role="alert"`，包含原因和下一步；
- 主操作顺序稳定，重绘后保留可恢复焦点；
- 中英文必须表达相同口径，数字使用现有 locale formatter。

## 11. 测试与验收

### 11.1 服务层

在 `tests/unit/catalog/large-catalog-verification-service.test.ts` 覆盖：

- permit、页面 commit、分类推进和终态事件的顺序；
- PDF/目录计数只在页面提交后增长；
- 超预算整页不进入累计提交数；
- 新片段本段计数归零，累计请求和已提交聚合不倒退；
- 取消响应后不提交该页；
- 单页 501 个目录产生可识别的零进展预算暂停；
- 事件 payload 不含路径、文件名或文件身份。

### 11.2 runtime

在 `tests/unit/catalog/hybrid-catalog-runtime.test.ts` 覆盖：

- 一次 start 后四类预算暂停都会串行自动调用下一段直到 complete；
- user-canceled、限流和所有错误都不会自动启动下一段；
- 段内和段间取消均为粘性；
- 无持久进展立即停止，不能用请求数或 runOrdinal 冒充进展；
- 第 12 段到限后安全停止，第 13 段不会启动；
- dispose、并发 start、根或 batch 变化不会产生迟到续跑；
- 第一个分类完成、第二个分类暂停时 active 覆盖率已经刷新；
- 初始化只加载 checkpoint，绝不自动联网；
- 仅明确可恢复的 partial 提供手动继续。

### 11.3 UI

在 `tests/ui/verification-page.test.ts`、`tests/ui/workbench-view.test.ts` 和 `tests/ui/settings-sections.test.ts` 覆盖：

- `verifiedCount` 故意不同于覆盖候选数时，整体进度仍按完整分类候选数计算；
- 当前扫描无 `aria-valuenow`，本段配额具有准确 ARIA 数值；
- 0 分母和异常输入不产生越界百分比；
- 片段从 9,500 切到下一段 200 时，本段条归零后增长，覆盖和累计数不倒退；
- 运行详情默认折叠且数字准确，重绘后保留展开状态；
- 用户暂停、自动到限、限流、授权失效和本地错误显示不同动作；
- 自动续跑过程中不显示误导性的手动“继续”按钮；
- 中英文与可访问性键完整。

### 11.4 回归命令

实施完成后至少执行：

```bash
npm run lint
npm test
npm run build
npm run build:acceptance
```

真实百度分类核验不属于普通自动测试。若需要真实验收，必须另行确认具体非敏感、非根目录，只读列出元数据，不下载 PDF，并记录实际停止原因和请求计数。

## 12. 完成定义

只有同时满足以下条件，本阶段才算完成：

1. 三层进度在中文主界面中可见且口径准确；
2. 一次确认后的自动链能跨预算片段完成所选分类；
3. 用户取消、错误、无进展和 12 段上限都能安全停止；
4. 每页持久化后 UI 能实时更新，完成分类后全库覆盖率及时增长；
5. 运行详情默认折叠并保留展开状态；
6. 重启不自动联网，会话根目录不持久化；
7. checkpoint V3、现有 overlay、已有活动目录和 acceptance 构建边界保持兼容；
8. 相关测试、lint、normal build 与 acceptance build 通过；
9. 没有下载 PDF、修改云端文件或写入真实 Vault 内容。
