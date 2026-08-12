# 百度网盘大书库混合目录设计

- 状态：已批准；用户授权后续产品选择按本文推荐方案直接推进
- 日期：2026-08-10
- 工作名称：Hybrid Large Library Catalog / 混合式大书库目录
- 适用产品：Knowledge Workbench for Obsidian
- 前置规格：`2026-08-05-baidu-netdisk-cloud-catalog-design.md`、`2026-08-09-baidu-catalog-acceptance-scan-budget-design.md`

## 1. 背景与结论

用户约有 3.2 TB PDF 保存在百度网盘，本地磁盘不能容纳全部原文件。现有 Cloud Catalog 已通过一次专用合成 Vault 中的真实小目录只读验收，证明官方 OOB 授权、零 PDF 下载、严格列表请求计数和本地搜索链路可工作。小样本模式的固定预算仍保持不变。

用户同时提供了一份本地目录 TXT。对该文件的只读聚合检查得到：

- 69,050 条非空树形行；
- 68,959 个唯一 PDF 相对路径；
- 84 个可由后续缩进确定的目录；
- 7 个非 PDF 叶子；
- 最大深度为 3；
- 0 个重复 PDF 路径；
- 文件中没有显式标签、关键词、学科字段或正文元数据。

本阶段采用混合方案：先把 TXT 导入为可搜索的候选目录，再按一级分类分批使用百度网盘只读列表接口核验。PDF 正文继续只存在百度网盘，需要时由用户从目录入口人工定位；不批量下载，不批量转 Markdown。

## 2. 方案比较

### 2.1 纯百度实时全库扫描

优点是云端事实单一，缺点是首次获得可用目录较慢，约 6.9 万条记录需要复杂的恢复、限流和完整性证明。任何中断都会延后全库可搜索时间。

### 2.2 只导入 TXT

优点是最快、无网络风险，缺点是无法发现云端新增、删除、改名和移动，也无法证明 TXT 与当前网盘一致。

### 2.3 TXT 底座加分类覆盖层（采用）

TXT 候选记录立即进入统一搜索；每个一级分类完成云端核验后，以不可变覆盖层原子更新该分类。未完成分类仍使用 TXT 底座。这样既能尽快得到全库目录，也能逐批接近当前云端事实，并将失败限制在单个分类或单次运行段。

不采用嵌入式 SQLite。现有项目已经具备严格 NDJSON、内容哈希、原子替换和 Vault 外快照边界；约 7 万条记录仍适合不可变 NDJSON 加内存搜索索引。新增 SQLite 会引入原生依赖、Obsidian 打包和迁移成本，而当前查询需求不需要关系数据库。

## 3. 目标

实现完成后，用户可以：

1. 在设置页选择一次本地树形 TXT，预览聚合计数后手动导入。
2. 不依赖外置硬盘继续搜索约 6.9 万条候选 PDF。
3. 在 Cloud Catalog 中同时搜索未核验、已核验和有差异的记录。
4. 按一级分类查看候选数量、核验状态和最近完整核验时间。
5. 每次最多选择 5 个一级分类，按固定大书库预算串行核验。
6. 在网络、限流、取消或预算暂停后，看到准确的剩余范围，并通过新的人工操作继续。
7. 看到云端新增、云端缺失、改名和移动差异，在本地确认后清除差异提示。
8. 继续使用复制文件名、复制云端路径和打开百度网盘入口按需访问原文件。

## 4. 非目标

本阶段不会：

- 下载、缓存、预览、OCR 或解析 PDF 正文；
- 根据正文生成内容标签、摘要、嵌入或 AI 问答；
- 为约 6.9 万个 PDF 创建 Markdown 文件或附件；
- 后台、定时或插件启动时访问百度网盘；
- 扫描百度网盘 `/`、用户未输入的父目录或无关目录；
- 修改、移动、重命名、删除、上传或分享云端文件；
- 把私有文件名、路径或凭证写入日志、Git、测试快照、PMH recall 或工程 checkpoint；
- 自动迁移或恢复缺少精确请求计数的 schema v1 扫描；
- 运行旧 A/B benchmark、long-pilot、public-v1、压力脚本、批量模型调用或对照模型实验；
- 写入真实 Vault。

正文标签属于后续独立的按需内容增强项目。层级目录词只作为本地目录筛选标签，不宣称是书籍内容标签。

## 5. 总体架构

```text
本地目录 TXT ──一次性流式解析──> 不可变候选底座
                                      │
百度一级分类 ──人工启动只读核验──> 分类覆盖层与差异账本
                                      │
                                      v
                           原子编译的统一活动目录
                                      │
                                      v
                           Cloud Catalog 只读搜索视图
```

新增单元保持单一职责：

- `CatalogTxtImportService`：验证、解析和导入树形 TXT，不访问网络。
- `HybridCatalogStorePort`：保存候选底座、分类覆盖层、差异账本、批次 checkpoint 和统一活动目录。
- `CatalogReconciliationService`：对完整分类快照做确定性比对，不读 TXT 文件、不访问网络。
- `LargeCatalogVerificationService`：执行人工授权的串行分类核验和精确恢复，不直接更新活动目录。
- `UnifiedCatalogProjectionService`：把候选底座与已完成覆盖层编译成一个活动目录。
- `UnifiedCatalogSearchService`：只读取活动目录，提供搜索、状态和层级筛选。

现有小样本 `CatalogScanService`、schema v2 回执和 `SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET` 不改变语义。大书库使用独立合约，避免恢复能力或更高预算意外扩散到小样本安全闸。

## 6. TXT 导入合约

### 6.1 输入边界

设置页提供 `Local inventory TXT (session only)` 文件路径输入和以下动作：

1. `Preview import`：只解析并返回聚合计数；
2. `Import candidate catalog`：再次显示聚合确认框，确认后原子写入候选底座。

源文件路径只存在于当前设置页和调用栈，不保存到插件配置、导入回执或活动目录。导入完成后不再依赖源文件或外置硬盘。

固定输入预算：

```ts
interface CatalogTxtImportBudget {
  readonly maxBytes: 16_777_216;
  readonly maxNonEmptyLineCount: 71_000;
  readonly maxPdfCount: 70_000;
  readonly maxDepth: 32;
  readonly maxLineBytes: 16_384;
}
```

这些值是产品常量，不提供无限制设置项。70,000 是统一活动目录允许的 PDF 硬上限，不是建议目标。

### 6.2 树形语法

解析器以 UTF-8 流式读取，允许 LF 或 CRLF。每条非空行必须匹配：

```text
("│   " 重复 0 至 31 次) + ("├── " 或 "└── ") + 名称
```

深度等于缩进段数加一。名称执行 Unicode NFC 和首尾空白清理；发生清理只增加聚合 `normalizedWhitespaceCount`，不输出原值。

目录由结构推断：某个非 PDF 行只有在下一条非空行深度更大时才是目录。其他不以 `.pdf` 结尾的叶子只累计为 `ignoredLeafCount`。`.pdf` 判断不区分扩展名大小写，生成的逻辑扩展名统一为 `pdf`。

解析器保留一行前瞻和当前目录栈，不把整个 TXT 内容复制到内存。每个 PDF 生成规范化相对路径；父层缺失、深度跳跃、空名称、NUL、路径分隔符注入、超预算或重复规范化路径都使整个候选导入失败关闭。失败只返回固定错误码和聚合拒绝数，不返回原始行、文件名或路径。

### 6.3 候选记录

```ts
interface TxtCandidateRecordV1 {
  readonly schemaVersion: 1;
  readonly source: "txt-candidate";
  readonly candidateId: string;
  readonly relativePath: string;
  readonly parentRelativePath: string;
  readonly filename: string;
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly topLevelGroupId: string;
  readonly hierarchyTags: readonly string[];
}
```

`candidateId` 是 `txt:` 加规范化相对路径的 SHA-256，不包含源文件路径。`topLevelGroupId` 是首个目录段的哈希；根层 PDF 使用固定常量组 `txt-root-items`。哈希 ID 用于 manifest、回执和 UI 状态关联，但不得被描述为匿名化后可公开的数据。

`hierarchyTags` 只由相对路径中的目录段生成，用于本地筛选。系统另派生 `status/unverified`、`status/verified` 或 `status/difference` 标签。这些标签不写成 Obsidian Markdown 标签，也不推断主题、作者、学科或内容。

### 6.4 导入回执

导入回执只保存：schema 版本、源文件 SHA-256、字节数、导入时间、非空行数、PDF 数、目录数、忽略叶子数、规范化空白数、最大深度、候选 NDJSON 哈希和固定错误码计数。它不保存源文件路径、目录名、文件名、书名或实际标签值。

只有解析、计数、唯一性、NDJSON 解码和哈希全部通过时，新候选底座才成为活动底座。失败或取消继续使用上一次完整底座。

## 7. 统一记录与状态

```ts
type CatalogVerificationStatus = "unverified" | "verified" | "difference";

type CatalogDifferenceKind =
  | "cloud-added"
  | "cloud-missing"
  | "renamed"
  | "moved";

interface UnifiedCatalogRecordV1 {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly candidateId: string | null;
  readonly fsId: string | null;
  readonly relativePath: string;
  readonly cloudPath: string | null;
  readonly filename: string;
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly sizeBytes: number | null;
  readonly serverModifiedAt: number | null;
  readonly topLevelGroupId: string;
  readonly hierarchyTags: readonly string[];
  readonly verificationStatus: CatalogVerificationStatus;
  readonly differenceKinds: readonly CatalogDifferenceKind[];
  readonly visibleByDefault: boolean;
}
```

身份规则固定为：

1. 未核验记录使用确定性的 `candidateId` 作为 `catalogId`。
2. 首次精确路径匹配云端记录后，使用 `baidu:` 加十进制 `fsId` 作为稳定 `catalogId`，并保留 `candidateId` 别名。
3. 后续核验优先按相同 `fsId` 识别同一资产，因此改名或移动不会生成一个假新资产。
4. 没有既有 `fsId` 时只允许规范化相对路径精确匹配；不按相似标题、同名、大小或 ISBN 自动合并。

状态含义：

- `unverified`：只来自候选底座，默认可搜索；
- `verified`：最近一次完整分类核验中存在且没有未确认差异，默认可搜索；
- `difference`：存在未确认的新增、缺失、改名或移动事实。

`cloud-added`、`renamed` 和 `moved` 记录使用当前云端元数据并默认可搜索。`cloud-missing` 记录保留在差异账本但从默认搜索隐藏，可通过“云端缺失”筛选查看。

用户确认差异只修改本地目录：

- 确认新增、改名或移动后清除差异标记，记录成为 `verified`；
- 确认云端缺失后，从活动目录移除候选记录，并在差异归档中保留聚合审计事实；
- 任何确认都不调用百度写接口，也不创建、移动或删除 Vault 文件。

## 8. 分类核验与协调

### 8.1 比对算法

分类只有在本次所有分页和子目录完整结束后才进入协调：

1. 读取全部活动覆盖层的全局 `fsId` 身份索引、该分类上一次已完成覆盖层和当前 TXT 候选；
2. 先按全局既有 `fsId` 匹配，识别同一分类或跨分类的改名和移动；
3. 对尚未匹配的首次核验记录按规范化相对路径精确匹配；
4. 剩余云端记录标记 `cloud-added`；
5. 剩余候选或旧覆盖记录标记 `cloud-missing`；
6. 写入新的不可变分类覆盖层和差异账本；
7. 编译并验证新的统一目录；
8. 原子切换活动 manifest。

协调过程是纯本地、确定性的。跨分类移动不会改写旧的不可变覆盖层；新覆盖层记录被其 `fsId` 取代的旧目录身份，统一投影按该关系抑制旧位置，并在一次活动 manifest 替换中发布新位置和移动差异。任一解码、哈希、计数、身份冲突或全局上限失败时，不提升分类覆盖层或统一目录。

### 8.2 分类原子性

暂停、部分失败或异常退出的分类扫描只保留 staging 页面和 checkpoint。该分类继续显示上一次完整覆盖层；若从未完成核验，则继续显示 TXT 候选为 `unverified`。不同分类互不覆盖。

新的完整 TXT 导入不会静默丢弃旧覆盖层。只有覆盖层记录的候选源哈希与新底座一致时才可复用；否则所有分类回到 `unverified`，旧覆盖层保留为不可活动历史，等待重新核验。

## 9. 大书库运行预算

每次人工确认的网络运行段使用固定预算：

```ts
interface LargeCatalogRunBudget {
  readonly maxSelectedTopLevelGroups: 5;
  readonly maxPdfCount: 10_000;
  readonly maxDirectoryCount: 500;
  readonly maxListRequestCount: 300;
  readonly maxDurationMs: 1_800_000;
}
```

规则：

- 每次最多涉及 5 个一级分类，分类严格串行；
- 选择器显示候选 PDF 聚合数，总计划量超过 10,000 时拆成多个运行段；
- 单个超大分类可以跨多个人工运行段继续，但只有整个分类完成后才提升覆盖层；
- 实际云端新增导致 PDF 数提前达到 10,000 时安全暂停；
- 列表响应仍按整页原子提交，超预算页面丢弃并在下次运行重新请求；
- 活动统一目录最多 70,000 个 PDF，超过时拒绝提升并保留旧活动目录；
- 不允许设置页或运行时参数放宽这些预算。

TXT 中的根层 PDF 使用 `txt-root-items` 特殊组。核验该组只列举用户输入书库根目录的直接子项，不递归进入任何子目录。该直接根列表仍需要产品内的明确人工确认，不因 TXT 导入或插件启动自动执行。

## 10. checkpoint v3 与人工恢复

大书库创建独立 schema v3 batch 和分类 checkpoint。至少保存：

- 结构版本、随机 batch ID 和候选源哈希；
- 选定分类的本地受限 manifest；
- 当前分类序号与每个分类的状态；
- 待处理相对目录与分页位置；
- 已提交页面键和内容哈希；
- 本运行段与累计的 PDF、目录、忽略文件、列表请求和耗时；
- 固定预算、错误码计数、重试次数和停止原因；
- 上次完整覆盖层 ID，不保存任何凭证。

生产列表并发固定为 1。每个真实 `GET + method=list` 前先原子持久化请求许可和递增后的准确请求数，然后立即调用传输端口。若恰好在许可持久化后、传输前崩溃，只留下非终态 checkpoint；不得生成声称请求数精确的终态回执。

插件启动时可以只读加载 checkpoint 聚合状态，但不得自动继续网络。用户点击 `Resume next bounded segment` 后，界面显示：剩余分类数、当前分类是否部分完成、本次固定预算和累计请求数。再次确认后才取得新的运行段许可。恢复从已提交页面之后继续，不重写或推断 schema v1/v2 的请求事实。

每个运行段生成严格聚合回执，禁止包含 batch ID、分类 ID、根路径、文件名、待处理队列、页面键、账号、凭证、Token、URL 或响应正文。路径和文件名只存在于权限受限的本地目录数据文件中。

## 11. 本地存储布局

新增数据继续位于 Vault、Git 仓库和插件目录之外：

```text
baidu-catalog/
  hybrid/
    active.json
    imports/<import-id>/
      candidates.ndjson
      receipt.json
    batches/<batch-id>/
      checkpoint.json
      receipt-<run-ordinal>.json
      pages/
    overlays/<group-id>/<overlay-id>/
      records.ndjson
      differences.ndjson
      descriptor.json
    unified/<snapshot-id>/
      catalog.ndjson
      differences.ndjson
      descriptor.json
```

目录权限为 `0700`，文件权限为 `0600`。所有 JSON 和 NDJSON 使用严格键白名单、Unicode NFC、十进制字符串 `fsId`、内容哈希、同目录临时文件和原子 rename。`active.json` 只在候选、全部引用覆盖层和统一目录都通过解码、计数与哈希验证后替换。

此前用户授权删除的旧 schema v1 大型 checkpoint 已通过可恢复方式移出活动存储。产品代码仍必须拒绝恢复任何后来出现的 v1 checkpoint，不自动迁移、不从页面数推断请求数，也不把它作为 v3 输入。

## 12. 搜索与界面

### 12.1 Cloud Catalog

现有标签页扩展为统一目录视图，顶部显示：

- 活动候选导入时间和 PDF 总数；
- `未核验 / 已核验 / 有差异 / 云端缺失` 聚合计数；
- 已完整核验的一级分类数；
- 当前暂停批次的聚合状态；
- 明确的“目录不含 PDF 正文或内容标签”说明。

搜索覆盖标题、文件名、ISBN 候选、相对路径、云端路径和本地层级标签。默认包含 `unverified`、`verified`、`cloud-added`、`renamed`、`moved`，不包含 `cloud-missing`。状态、一级分类和层级标签都可组合筛选。结果继续虚拟化或分页，不一次渲染约 7 万行。

结果行显示来源与状态芯片、标题、父层级、云端路径可用性、大小和修改时间。只有已核验或云端新增记录提供复制云端路径；未核验记录只能复制候选文件名或相对位置。`Open Baidu Netdisk` 仍只打开官方入口，不构造未保证的深链。

### 12.2 设置页

设置页分成三个明确区域：

1. 小样本连接与验收：保留现有行为和预算；
2. 本地 TXT 候选目录：预览、导入、活动底座聚合；
3. 大书库分类核验：候选分类、最多 5 项的运行段、固定预算、开始/取消/恢复和差异聚合。

所有网络按钮在未授权、未导入候选底座、已有运行段执行中或缺少 session-only 根路径时禁用。TXT 导入按钮不需要百度授权。任何路径输入在确认启动后立即从设置控件清空。

## 13. 错误处理

| 情况 | 行为 |
| --- | --- |
| TXT 非 UTF-8、语法错误、深度跳跃或超预算 | 拒绝整个导入，返回固定错误码和聚合计数 |
| TXT 重复规范化 PDF 路径 | 拒绝整个导入，不猜测合并 |
| 导入中取消或写入失败 | 不替换上一次完整候选底座 |
| 新 TXT 与覆盖层源哈希不同 | 新底座可激活，旧覆盖层停用，分类回到未核验 |
| 分类路径不存在或无权限 | 当前分类标记部分失败，其他分类与活动目录不变 |
| Token 过期 | 只允许既有的一次刷新和一次重新列表，两次请求都计数 |
| 百度限流 | 立即安全暂停，不睡眠、不自动重试 |
| 用户取消 | 等待当前请求结束，丢弃未提交页面，写聚合回执 |
| 任一运行预算耗尽 | 安全暂停，保留精确 v3 checkpoint，不提升未完整分类 |
| 统一目录会超过 70,000 PDF | 拒绝提升，继续使用旧活动目录 |
| 覆盖层、差异或统一目录哈希不匹配 | 标记本地目录损坏，不自动修复、不发网络请求 |
| v1/v2 checkpoint 被交给大书库恢复 | 固定拒绝，不读取为 v3、不推断请求数 |

错误、通知和日志只允许固定代码及聚合数字，不回显本地源路径、云端路径、文件名、请求 URL 或响应正文。

## 14. 测试策略

### 14.1 TXT 导入

- 使用合成树形夹具覆盖 LF/CRLF、`├──`/`└──`、NFC、大小写 `.pdf`、根层 PDF、空白规范化和非 PDF 叶子；
- 覆盖父层缺失、深度跳跃、重复路径、路径分隔符、NUL、超长行、非 UTF-8 和每项预算；
- 证明 70,000 PDF 可以导入，70,001 PDF 原子拒绝；
- 证明预览不写入，失败不替换旧底座，导入回执不含源路径或名称；
- 使用合成数据验证流式内存边界，不把用户真实 TXT 纳入仓库或测试快照。

### 14.2 协调与统一投影

- 首次精确路径匹配变为 `verified`；
- 既有 `fsId` 优先识别 rename/move；
- 跨一级分类出现的既有 `fsId` 只保留新位置，并产生一个 moved 差异；
- 同名、大小或 ISBN 相似但路径不同不会自动合并；
- cloud-added 立即进入默认搜索，cloud-missing 默认隐藏；
- 差异确认只改本地元数据，不调用百度、Vault 或 AI 端口；
- 单个分类失败不改变其他分类或旧活动覆盖层；
- 新源哈希停用旧覆盖层；
- 统一目录哈希、记录数和 70,000 上限失败都保持旧活动 manifest。

### 14.3 大书库扫描

- 最多 5 个分类、PDF 10,000、目录 500、请求 300 和 30 分钟预算不可覆盖；
- 分类严格串行，完整分类才协调和提升；
- 大分类跨人工运行段精确恢复，插件启动不自动发请求；
- 请求许可在传输前持久化，终态回执与捕获的传输调用数一致；
- 崩溃窗口只留下非终态 checkpoint；
- 限流、取消、权限错误、Token 刷新、整页超预算和活动快照保留；
- 根层特殊组只直接列表，不递归进入子目录；
- v1/v2 恢复请求固定拒绝。

### 14.4 搜索、性能与组合隔离

- 状态、分类、层级标签和默认隐藏规则可组合；
- 70,000 条合成记录在目标 Mac 上 10 秒内完成加载和索引构建；
- 50 个固定本地查询 p95 不超过 250 毫秒；
- normal 构建只组合官方 OOB、Token、`GET + method=list` 和本地目录能力；
- acceptance 构建不含真实 OAuth、SecretStorage、百度来源或 Vault 外写入；
- 无下载、百度写操作、Vault 写入或 AI 发送能力的依赖图测试继续通过。

自动化测试只使用合成名称、路径、凭证、时钟、网络响应和临时目录。开发阶段不执行真实 OAuth、真实全库扫描或真实 PDF 下载。

## 15. 实施分段与工程 checkpoint

实施按以下可验证阶段推进：

1. 固定混合目录类型、预算、严格 codec 和安全合约；
2. 实现流式 TXT 预览、导入与不可变候选存储；
3. 实现统一投影、搜索状态和 70,000 条性能边界；
4. 实现分类协调、差异账本与本地确认；
5. 实现 v3 分批扫描、请求许可和人工恢复；
6. 接入设置页与 Cloud Catalog，并完成组合隔离；
7. 执行全量自动化、构建和专用合成 Vault 安装验证；
8. 仅在单独的真实数据授权下，执行本地 TXT 导入或大书库分类核验。

每完成 3 至 5 个可验证开发阶段建立一次 PMH 工程 checkpoint 并停止汇报。checkpoint 只记录当前 Git 提交、实际功能、真实测试结果、错误方向与返工次数、可获得的输入 Token 统计、PMH recall 条数和 Token 量，以及是否发现跨项目或跨模型污染；不输出 recall 内容或私有目录元数据。到达 checkpoint 后不启动对照模型实验。

## 16. 完成标准

本开发目标在以下条件全部满足时完成：

1. 合成测试证明 TXT 候选目录可以安全导入并在源文件离线后继续搜索；
2. 70,000 PDF 硬上限、原子替换和严格聚合回执生效；
3. 未核验、已核验、有差异及四类差异语义可搜索和筛选；
4. 分类覆盖层只有完整核验后原子提升，失败不会污染其他分类；
5. 大书库运行段固定预算、准确请求计数和人工恢复生效；
6. 插件启动、授权成功和恢复状态加载都不会自动访问百度；
7. 所有 PDF 下载字节为零，产品依赖图不存在百度文件写操作；
8. normal/acceptance 构建、相关测试、全量测试和 lint 达到项目既有门槛；
9. 专用合成 Vault 安装验证通过，真实 Vault 未被修改；
10. 工程 checkpoint 未发现跨项目、跨来源或跨模型污染。

真实 TXT 导入和真实分类核验属于用户数据操作证据，不是自动化代码完成的前提；它们只能由产品内的本地明确动作启动。用户已经授权按推荐方案继续开发，不等于授权后台网络、全库真实扫描或真实 Vault 写入。
