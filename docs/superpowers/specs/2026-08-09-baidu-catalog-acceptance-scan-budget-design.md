# 百度云端目录小样本扫描预算设计

- 状态：设计已于 2026-08-09 分段确认
- 适用项目：Knowledge Workbench for Obsidian
- 适用模式：百度云端目录的小样本真实验收
- 基础规格：`docs/superpowers/specs/2026-08-05-baidu-netdisk-cloud-catalog-design.md`

## 1. 背景

Cloud Catalog 已具备官方 OOB OAuth、只读 `GET + method=list`、串行递归扫描、Vault 外 checkpoint、完整快照提升和 Obsidian 搜索能力。第一次真实目录验收发现，用户选定的非根目录虽然被当作“小目录”，实际包含约 6.9 万个 PDF。扫描只能在人工观察到聚合规模后取消，当时设置页仍显示旧的 `authorized` 状态，而且暂停扫描没有生成可直接使用的聚合回执。

这说明“用户选择非根目录”和“扫描器串行运行”不足以构成小样本边界。预算必须进入扫描核心，不能依赖设置页、人工盯守或事后读取 checkpoint。

本规格补充基础 Cloud Catalog 设计，只处理小样本验收安全闸。它不批准恢复现有大型 checkpoint，也不批准完整书库扫描。

## 2. 目标

本轮完成后，小样本扫描必须：

1. 使用不可由设置页修改的固定预算；
2. 在所有正常终态中精确统计每一次真实百度目录列表调用，包括 Token 刷新后的列表重放；
3. 在下一次请求前阻止超过请求数或时间预算的扫描；
4. 对会超过 PDF 或目录预算的响应整页不落盘；
5. 在完成、用户取消、预算暂停、限流或固定错误后生成聚合回执；
6. 实时向设置页发布聚合进度，不发布路径或文件名；
7. 只有完整扫描才能替换活动快照；
8. 保留现有旧版大型 checkpoint，但不自动迁移或恢复。

## 3. 非目标

本轮不实现：

- 70,000 PDF 的大书库模式；
- 用户可编辑预算；
- 超限后的“一键继续”；
- 自动恢复旧版或新版本暂停扫描；
- 根目录或父目录枚举；
- PDF 下载、预览、解析、OCR、Markdown 转换、摘要或嵌入；
- 百度网盘上传、创建、移动、复制、重命名、删除或分享；
- 删除现有 checkpoint、快照、凭据或云端文件；
- 旧 A/B benchmark、long-pilot、public-v1、压力脚本或对照模型实验。

大书库模式保留 70,000 PDF 作为后续设计输入，但必须在小样本真实验收通过后单独设计、批准和实现。

## 4. 固定小样本预算

正常构建为每个新验收扫描注入以下只读预算：

```ts
interface CatalogScanBudget {
  readonly maxPdfCount: 1_000;
  readonly maxDirectoryCount: 20;
  readonly maxListRequestCount: 25;
  readonly maxDurationMs: 120_000;
}
```

这些值不进入插件设置，不接受表单、命令行、环境变量或云端响应覆盖。测试可以通过构造函数注入合成预算，但生产组合根只能使用上述常量。

预算含义：

- PDF 和目录预算限制可提交到 checkpoint 的记录总数；
- 请求预算限制真实 `GET method=list` 的尝试次数；
- 时间预算从 scan ID 创建后开始计算，包含网络等待和本地持久化时间；
- 已经发出的单次请求不能由 Obsidian `requestUrl` 中断，但响应返回后不得再发下一次请求；
- 达到某项预算且仍有待扫描工作时，扫描进入 `paused`，不推断目录已完整。

## 5. 扫描状态与固定停止原因

预算暂停不是程序错误。新增独立固定类型：

```ts
type CatalogScanPauseReason =
  | "user-canceled"
  | "pdf-limit"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

type CatalogScanStopReason =
  | "complete"
  | CatalogScanPauseReason
  | CatalogErrorCode;
```

扫描仍使用 `complete`、`paused` 和 `partial` 三种终态：

- `complete`：队列和最后一页均已完整处理；
- `paused`：用户取消、预算到达或官方限流；
- `partial`：权限、目录不存在、响应损坏或其他固定来源错误。

同一个响应同时触发多个本地停止条件时，优先级固定为：用户取消、时间上限、PDF 上限、目录上限。请求次数只在下一次请求许可阶段判断。

## 6. 精确列表请求计数

`BaiduCatalogSourcePort.listDirectory` 获得一个窄的异步请求许可回调。生产 `BaiduCatalogSourceAdapter` 必须在每一次真实 `GET method=list` 之前调用该回调：

1. 初始列表请求调用一次；
2. Token 失效后的单次列表重放再次调用；
3. OAuth Token 刷新请求不属于列表请求，不计入该字段；
4. 许可回调拒绝后，不得构造或发送列表请求；
5. 许可暂停不得被适配器翻译成百度错误。

请求许可由 `CatalogScanService` 所有。许可过程按顺序执行：

1. 检查取消信号；
2. 检查已用时间；
3. 检查 `listRequestCount` 是否已经达到 25；
4. 将 `listRequestCount + 1` 写入 checkpoint；
5. 只有持久化成功后才允许网络请求。

许可持久化成功后，生产适配器必须在同一个同步代码段内立即调用列表传输函数，中间不得出现 `await`、条件分支或其他副作用。网络失败、Token 错误和限流时，该调用仍被计数。所有能够写出终态回执的运行中，`listRequestCount` 必须与测试捕获的列表传输调用次数完全一致。

如果进程恰好在许可持久化后、传输函数调用前退出，checkpoint 中的计数只能视为保守上界。该异常退出不会生成验收回执，也不得在重启后被解释成精确网络证据。生产扫描并发继续固定为 1，不存在并发许可竞争。

## 7. 整页原子处理

列表响应先在内存中完成现有的严格解码、直接父目录验证和记录转换，然后计算候选下一 checkpoint。

处理顺序固定为：

1. 响应返回后再次检查取消信号；
2. 再次检查时间预算；
3. 计算整页提交后的 PDF 和目录总数；
4. 若会超过任一数量预算，丢弃整页转换结果；
5. 否则原子提交页面和下一 checkpoint；
6. 发布一次聚合进度；
7. 若计数已经等于预算且仍有待扫描工作，在下一次请求前暂停。

被丢弃页面的路径、文件名和记录不得写入 checkpoint、页面文件、回执、日志、错误或 PMH。它对应的网络请求仍计入 `listRequestCount`。

如果最后一个合法页面恰好使计数等于预算，并且扫描队列已经为空，扫描可以正常完成。若还需要空页、下一分页或子目录请求来证明完整性，则必须暂停，不能宣称完整。

## 8. checkpoint v2

所有新扫描创建 schema v2 checkpoint。除原有队列和计数外，v2 固定增加：

```ts
interface CatalogScanCheckpointV2 {
  readonly schemaVersion: 2;
  readonly scanId: string;
  readonly rootPath: string;
  readonly startedAt: number;
  readonly budget: CatalogScanBudget;
  readonly listRequestCount: number;
  readonly pending: readonly Readonly<{ path: string; start: number }>[];
  readonly committedPageKeys: readonly string[];
  readonly completedDirectoryCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly status: "scanning" | "paused" | "partial";
  readonly pauseReason: CatalogScanPauseReason | null;
}
```

预算、根路径、开始时间、已提交页面和内容计数保持不可回退。请求许可只允许递增 `listRequestCount`；页面提交只允许按既有原子规则扩展 committed page 和内容计数；终止只允许改变状态、固定原因、错误计数或重试计数。

现有 schema v1 checkpoint 不改写、不删除、不自动加载到新扫描，也不从已提交页面数推断“精确请求数”。新扫描使用新的随机 scan ID，不与旧目录复用。未来若设计恢复流程，必须单独处理 v1 的计数不可证明问题。

## 9. 聚合回执 v2

完成、用户取消、预算暂停、限流和固定错误都调用统一的终止持久化端口。端口先保存终态 checkpoint，再幂等写入严格 v2 回执：

```ts
interface CatalogScanReceiptV2 {
  readonly schemaVersion: 2;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: CatalogScanStopReason;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly budget: CatalogScanBudget;
  readonly listRequestCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly downloadedPdfBytes: 0;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly snapshotSha256: string | null;
}
```

约束：

- `durationMs` 必须等于 `endedAt - startedAt`，且为非负安全整数；
- 只有 `complete` 可以包含非空 `snapshotSha256`；
- `paused` 和 `partial` 不提升 `active.json`；
- `downloadedPdfBytes` 只能是字面量 `0`；
- 回执的键必须完全匹配，拒绝未知字段；
- 回执不包含 scan ID、根路径、pending 队列、页面键、文件名、账号、凭据、Token、URL 或响应正文；
- 终态写入失败时返回固定 `snapshot-corrupt`，且旧活动快照保持不变。
- 进程异常退出后遗留的非终态 checkpoint 不能转换成声称精确请求数的验收回执。

## 10. 实时进度与设置页

`CatalogScanProgress` 增加预算和请求计数，仍只包含聚合值：

```ts
interface CatalogScanProgress {
  readonly status: "scanning" | "paused" | "partial" | "complete";
  readonly directoryCount: number;
  readonly completedDirectoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly pendingDirectoryCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
  readonly budget: CatalogScanBudget;
  readonly stopReason?: CatalogScanStopReason;
}
```

连接运行时必须把扫描核心进度转成只读 view model，并通过订阅通知现有 Workbench/UI 生命周期。设置页不得依赖初始 `snapshot()` 值或轮询猜测扫描状态。

设置页显示：

- 扫描状态；
- PDF 当前值与 1,000 上限；
- 子目录当前值与 20 上限；
- 列表请求当前值与 25 上限；
- 已用时间与 120 秒上限；
- 固定停止原因；
- 仅在扫描中可用的 `Cancel scan`。

最终确认返回 true 后，设置页在调用扫描运行时前把路径输入框清空。扫描事件、状态、通知和错误不得包含该路径。暂停后不显示恢复按钮；新的扫描必须重新输入路径并重新经过确认框。

## 11. 取消、刷新与来源错误

### 11.1 用户取消

- 请求前取消：不发请求，写 `paused + user-canceled` 回执；
- 请求中取消：等待当前 `requestUrl` 返回，丢弃该页，不再发请求，写回执；
- 页面提交后取消：保留已原子提交页面，写回执；
- 取消不删除 checkpoint 或旧活动快照。

### 11.2 Token 刷新

来源适配器仍只允许一次官方 Token 刷新和一次相同列表请求重放。两次列表尝试都必须取得许可并计数。如果第二次许可触发预算暂停，刷新后的列表请求不得发出。

### 11.3 固定来源错误

- `baidu-rate-limited`：立即 `paused`，不睡眠、不自动重试；
- 权限、访问、目录不存在和无效响应：立即 `partial`；
- `snapshot-corrupt` 和无效扫描根：失败关闭，不扩大范围；
- 所有来源错误继续只暴露固定错误码。

## 12. 数据与能力隔离

本改动不扩展百度权限或网络接口。normal 构建仍只组合：

- 官方 OOB OAuth；
- Token 交换或一次刷新；
- `GET /rest/2.0/xpan/file?method=list`。

acceptance 构建仍不包含 OAuth、SecretStorage、百度适配器或 Vault 外目录能力。代码中不得出现下载、dlink、上传、文件管理、移动、复制、重命名、删除或分享能力。

所有 checkpoint 和回执继续存放在 Vault、仓库和插件目录之外，并保持目录 `0700`、文件 `0600`。Cloud Catalog 记录继续与 Today、Knowledge Map、Suggestions、History、交易和 AI 隔离。

## 13. 自动化验证

实现必须以失败测试先锁定以下行为，再写生产代码：

1. 固定生产预算不能被 UI 或运行时输入覆盖；
2. 第 25 次列表请求可以完成最后一页，但存在后续工作时第 26 次请求被阻止；
3. 初始列表和刷新重放各计数一次；
4. 请求许可计数在网络调用前持久化，终态回执计数与捕获的传输调用次数一致；
5. 超过 1,000 PDF 或 20 目录的候选页面整页不提交；
6. 正好达到预算且队列为空时允许完成；
7. 120 秒前允许请求，达到时间后不再请求；
8. 请求中取消后丢弃响应页面；
9. 完成、用户取消、每种预算暂停、限流和固定错误均生成严格 v2 回执；
10. v2 回执拒绝未知键和任何路径、文件名、账号、凭据、Token、URL 或响应正文；
11. 暂停和部分扫描不替换旧活动快照；
12. 实时进度从扫描器到连接 view model 再到设置页；
13. 最终确认后路径输入框立即清空；
14. 设置页不提供恢复按钮；
15. 旧 v1 checkpoint 文件不被修改；
16. normal/acceptance 组合根隔离和无下载能力测试继续通过。

另加一项崩溃窗口测试：许可已经持久化但传输函数未被调用时，只留下非终态 checkpoint，不生成精确验收回执。

测试只使用合成路径、假凭据、假时钟、临时目录和确定性来源。实现阶段不得执行真实 OAuth、真实目录请求、旧实验脚本或批量模型调用。

## 14. 第二次真实小目录验收

自动化验证、构建和安装到专用合成 Vault 全部通过后停止，重新取得用户对第二次真实目录请求的明确授权。验收目录应由用户在百度客户端先行确认，建议包含 20 至 100 个 PDF、最多一至两层子目录，并人工记录目录数、PDF 数和其他文件数。

允许记录的结果仍仅为：

```text
authorization_status=<success|canceled|blocked>
scan_status=<complete|partial|paused|blocked>
list_request_count=<integer>
directory_count=<integer>
pdf_count=<integer>
ignored_file_count=<integer>
downloaded_pdf_bytes=0
error_codes=<fixed codes only>
duration_ms=<integer>
client_count_match=<yes|no|not-available>
```

成功标准：

- `scan_status=complete`；
- 三类数量与用户本地清单完全一致；
- `list_request_count` 为准确整数且不超过 25；
- `downloaded_pdf_bytes=0`；
- 无固定错误码；
- 生成完整 v2 回执和可搜索活动快照。

任一预算触发属于安全暂停，但不算小目录验收成功。验收结束后立即停止，不继续大型目录、第二个目录、真实 Vault 安装或大书库模式。

## 15. 后续大书库模式的边界

小样本验收通过后，才为大书库模式另写规格。已确认的唯一输入是单次 PDF 上限 70,000。后续规格仍需决定分批单位、目录上限、请求与时间预算、恢复授权、进度持久化、完成度核对和旧 checkpoint 处理；不得从本规格推断这些决定已经批准。
