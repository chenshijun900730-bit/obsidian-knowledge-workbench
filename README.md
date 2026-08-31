# Knowledge Workbench for Obsidian

Knowledge Workbench 是一个本地优先的 Obsidian 桌面插件：它在本机建立派生索引，提供 Today、聚焦知识地图、可解释的整理建议、变更预览与可恢复历史。默认只读，写入能力需要用户分阶段明确解锁。

本仓库的自动化不会选择、安装或打开真实库，也不会发布社区插件、自动启用插件、发送遥测或发出真实 AI 请求。真实库的 normal 与 read-only acceptance 安装各有一个受人工明确授权约束的专用事务入口；实现和测试不代表真实库验收已经完成，也不代表 normal 真实库操作已经完成。

## 环境要求

- Obsidian 桌面版。
- Node.js `^20.19.0`、`^22.13.0` 或 `>=24.0.0`；本次发布性能证据使用 Node v24.14.0。
- npm。

```bash
npm install
npm run build
npm test
npm run test:coverage
npm run test:performance
```

普通测试和覆盖率不会运行 75 MiB 性能场景；`test:performance` 会串行运行一次。自动化增量基准使用同一份完成扫描的合成库，串接真实的 `PluginDataStore`、`IndexService`、`IncrementalIndexQueue` 与 `WorkbenchController`，并把合成修改到队列 flush 返回、临时 JSON 文件持久化、延后投影 drain/compute 三段分别报告。这个临时文件端口测量的是写入并原子 rename 完成，不是 Obsidian 主机的 `Plugin.saveData()` 计时，也不宣称断电持久。`projectionDrainElapsedMs` 从调用手动 `scheduler.drain()` 前一刻开始，到 drain 中的投影计算结束为止；它不含调度器预设的 50 ms quiet delay。该字段与单次同步回调耗时都只作报告：当前热修复把持久化路径与完整 UI 投影解耦并合并突发更新，并未消除一次 5,000 条完整投影的主线程成本。堆内存同样是观测值，不是硬门槛。

## 聚焦地图的性能模型

聚焦地图使用 exact lazy frontier：只在节点进入已选集合时计算它到尚未选择节点的关系，再按既有的确定性 crossing-edge 比较器选择下一节点；它保留穷举参考实现的精确 50 节点结果，不先计算全库所有两两关系。每 500 次评分仍会执行可取消进度检查，Workbench 只发布第一个检查点和此后每增加 50,000 次评分的检查点，终态会保留最新完成数。

5,000 条合成记录的自动化发布门禁要求评分次数不超过 250,000、结果不超过 50 个节点。评分次数上限是跨机器稳定的主门禁；自动化地图耗时只作报告，不构成产品性能保证。Electron 窗口退到后台时，系统的 timer throttling 可能明显放大 wall time，因此专用 Obsidian 主机仍单独执行不超过 180 秒的端到端主题发现验收，最终实测证据记录在忽略文件中，而不是写成 README 的固定承诺。

## 构建身份与授权边界

normal 与 read-only acceptance 是两套不可混用的构建身份：

| 构建身份 | 完整产物 | Manifest 名称 | 编译绑定 | 当前允许的安装方式 |
| --- | --- | --- | --- | --- |
| normal | 事务构建的 `main.js`、`manifest.json`、`styles.css` | `Knowledge Workbench` | `knowledge-workbench@<version>:normal` | 合成库使用 `install:dev`；真实库仅在明确授权后使用 `install:normal:real` |
| read-only acceptance | 隔离目录中的 `main.js`、`manifest.json`、`styles.css`、`acceptance-build.json` | `Knowledge Workbench (Read-only acceptance)` | `knowledge-workbench@<version>:read-only-acceptance` | 合成库按固定手册使用 `install:acceptance:dev`；真实库仅在双人工停止门之间使用 `install:acceptance:real` |

只读验收构建只准备产物，不安装、不启动 Obsidian，也不访问任何 vault；准备产物不构成真实库访问授权：

```bash
npm run build:acceptance
```

`install:dev` 始终安装 normal 根目录三件套，且只接受当前 worktree 内 `.dev-vault` 下的专用合成库；它不会安装 acceptance 产物。不要手工复制 acceptance 文件到任何 vault，也不要混用两套构建中的单个文件。

[真实库只读事务安装与人工验收停止门](docs/runbooks/real-vault-read-only-acceptance.md)定义唯一受支持的真实库安装入口以及安装前后的人工停止边界。阅读文档、构建产物或实现通过自动化测试都不是安装、打开、启用、扫描或完成真实库验收的授权；实现和测试不代表真实库验收已经完成。

[真实库 normal 目录安装手册](docs/runbooks/real-vault-normal-catalog.md)定义网络能力 normal 构建的独立事务安装入口。它只负责在插件已禁用且 Obsidian 已退出时发布三个产物；不会自动启用插件、导入 TXT、连接百度或开始核验。

[专用合成库只读验收运行手册](docs/runbooks/synthetic-read-only-acceptance.md)定义固定 prepare/install、自动化停在主机控制之前、人工主机演练和一次性终态证据；它不授权任何真实库操作，也不会改变上面的真实库新授权停止门。

## 只安装到专用测试库

安装器只接受当前仓库 worktree 内的绝对路径：`<worktree>/.dev-vault/<vault-name>`。它拒绝 `.dev-vault` 根目录、相对路径、外部路径，以及关键路径链与安装目标上的任何现存 symlink；不会创建 vault 本身。

先创建一个只含合成笔记的专用测试库：

```bash
mkdir -p .dev-vault/acceptance-vault/.obsidian
printf '%s\n' '{"schemaVersion":1,"purpose":"knowledge-workbench-dedicated-test-vault","contentPolicy":"synthetic-notes-only"}' > .dev-vault/acceptance-vault/.knowledge-workbench-test-vault.json
printf '%s\n' '[]' > .dev-vault/acceptance-vault/.obsidian/community-plugins.json
```

`community-plugins.json` 必须在安装前已经存在，内容必须是只含字符串插件 ID 的 JSON 数组，并且不能包含 `knowledge-workbench`。安装器不会替你创建或修复这份主机状态文件；缺失、格式错误或已经启用本插件都会直接拒绝安装。

随后构建并安装：

```bash
OBSIDIAN_DEV_VAULT="$(pwd)/.dev-vault/acceptance-vault" npm run install:dev
```

安装器会先完整检查 marker、`.obsidian`、`community-plugins.json`、manifest ID、三个源文件和三个目标文件；准备全部暂存文件与回滚备份后，才依次替换 `main.js`、`manifest.json`、`styles.css`。每次替换前都会重新检查目标目录身份和当时的清单状态。失败回滚只处理仍与安装器记录的文件身份完全一致的对象；遇到并发替换或未知对象会停止安全回滚、保留可确认的旧备份并报告 `rollback incomplete`。它不会读取或覆盖目标 `data.json`，也不会创建、修改或自动追加 `community-plugins.json`。若清单缺失、无效或已包含 `knowledge-workbench`，安装会拒绝，避免在未知或正在启用的状态下替换插件。

安装成功只表示安装器在各安全门观察到清单未包含本插件，并且没有修改该清单；它不能保证 Obsidian 主机之后永远不会自动载入插件或改变启用状态。首次打开专用库前请再次核对 `community-plugins.json`，打开后也要在 Obsidian 设置中确认本插件的实际状态仍为禁用；确认无误并准备开始测试时，再由人手动启用。

打开时只在 Obsidian 的 vault switcher 中明确选择当前 worktree 的 `.dev-vault/acceptance-vault`。不要使用裸 `open -a Obsidian`，因为它可能恢复上次打开的其他 vault；不要打开、安装到或检查真实资料库。

## 首次只读验收

初次验收保持写入锁定，并且只用 5,000 篇生成/合成笔记：

1. 打开 Workbench，完成一次冷启动本地扫描，记录耗时；目标不超过 30 秒。
2. 检查文件夹规则，不执行修改。
3. 验证 Today 项目及其解释。
4. 验证地图节点、过滤、Confirmed/推断关系说明。
5. 打开整理建议和冲突预览，但不确认执行。
6. 在已有有效索引后，重新计时两项任务：10 秒内找出一条带解释的下一步行动；3 分钟内找到一个主题、个人笔记和支持它的参考资料。
7. 重启 Obsidian，确认索引与历史仍可恢复。

真实资料库的只读验收不属于本任务，必须在后续获得新的明确授权。启用写入、执行单文件计划或测试真实资料库 Undo 都需要再次确认；后续把上限提高到 10 或 50 项同样需要新的主动选择。

若之后另行授权专用合成库的写入验收，只执行这一条可恢复路径：

1. 选择一篇零入链的合成笔记，预览一次重命名并核对计划。
2. 明确确认后执行该单文件重命名。
3. 重启 Obsidian，打开 History 并预览 Undo。
4. 执行 Undo，确认原文件路径恢复，原 frontmatter 内容保持一致。

在这四步全部完成前，`writeAcceptance` 必须保持 `not-authorized` 或 `pending`，整体 `status` 不能写成 `passed`。

## 写入与恢复边界

- 默认写入锁定；确认预览后仍会在执行前重新校验。
- 每个计划最多 50 个操作。
- 不支持删除、合并、覆盖或正文重写。
- 有入链的重命名/移动会被阻止；执行使用 Obsidian 公共 API。
- 操作日志保留受限历史和恢复状态；History 可预览 Undo，并可导出只含允许字段的 JSON。
- Recovery required 会锁住新的整理写入，直到用户处理恢复状态。

## 可选 AI 与隐私

AI 默认关闭。启用后，每次请求都会先展示动作、endpoint origin、笔记路径、数量与近似字符数；只有用户确认后才读取并发送所选正文。模型输出只显示为建议文本，不会直接进入变更计划或写入路径。

持久设置只保存 Obsidian SecretStorage 的 secret ID，不保存 secret 值；也可以使用仅当前会话有效、卸载时清除的 secret。请只配置自己信任的兼容 endpoint，并阅读预览中的披露。本仓库的自动化不会访问真实 endpoint 或 credential。

## 百度网盘 Cloud Catalog（预检阶段）

Cloud Catalog 的目标是为百度网盘中的 PDF 建立本地可搜索目录，而不是下载 3.2 TB 原文件或把每份 PDF 转成 Markdown。PDF 原件继续留在网盘；派生目录保存在 `~/Library/Application Support/Knowledge Workbench/baidu-catalog/`，不进入 Vault，也不并入 Today、Knowledge Map 或整理写入流程。

normal 构建只组合官方 OOB OAuth、Token 交换和 `GET /rest/2.0/xpan/file?method=list`。OAuth 成功不会自动枚举目录；普通云端扫描和分类核验只接受用户另行确认的非根目录。acceptance 构建无法获得 OAuth、SecretStorage、百度列表或外部目录写入能力。

云端扫描和分类核验都拒绝把 `/` 作为最终根目录。目录选择器默认打开、搜索、筛选和选中本地候选时只读取本地状态，发出的百度请求数为零。用户主动选择“从百度网盘根目录浏览”时，每个插件会话第一次都会先看到一次根目录披露；确认只授权读取根目录当前这一层，不会预加载后代目录。文件夹浏览始终逐层进行，每次明确启动或继续一轮，固定以每次 1,000 条、最多 20 次列表请求检查最多 20,000 条响应记录，并在 120 秒到达时停止；当前层尚未完整时，必须由用户再次明确点击继续。

浏览结果只显示当前层的直接子文件夹；文件和 PDF 条目不会显示，也不会保留在浏览快照、最近目录或界面中。分类核验中选择一个小分类后，界面会同时显示所选分类及其实际核验父目录；这一步只更新草稿，不会开始扫描或核验，仍需经过外层独立确认。高级同名定位入口继续使用单独的固定上限：最多检查 500 个目录、发送 50 次列表请求或运行 120 秒，先到任一上限即停止；它同样不会展示或下载 PDF。

normal 构建可在普通本地插件设置中保存最多 10 条经过精确选择的最近目录路径，用户可以独立清空；这些路径不是凭据，也不存入 SecretStorage。从本地 TXT 目录得到的名称只作为“未核验”搜索提示，不能在未经云端精确核验时当作已确认路径使用。

设置页会把应用凭据和 OAuth Token 保存到 Obsidian SecretStorage；这能避免秘密直接写入插件 `data.json`，但不应被描述为已经证明由 macOS Keychain 保护。`Remove local credentials` 只删除本机保存的凭据，不等于服务器端撤权。真实操作前必须阅读[百度网盘云端目录小目录验收手册](docs/runbooks/baidu-cloud-catalog-small-folder.md)，接受存储属性，并再次明确批准一次真实 OOB 授权和一个不敏感小目录。阅读文档、自动化通过或此前接受 OAuth 范围均不构成该执行授权。

## Acceptance 证据

结果只允许写入 git-ignored 的 `.dev-vault/acceptance.json`，并先验证：

```bash
npm run validate:acceptance
```

允许的精确结构如下；状态只能使用 `pending`、`passed`、`failed`，写入验收还可使用 `not-authorized`。尚未实际测量的数字必须保持 `0`，不能填入推测值：

```json
{
  "schemaVersion": 1,
  "scope": "dedicated-synthetic-vault",
  "contentPolicy": "synthetic-notes-only",
  "status": "pending",
  "recordedAt": "2026-07-13T00:00:00.000Z",
  "pluginVersion": "0.1.0",
  "nodeVersion": "v24.14.0",
  "obsidianVersion": "1.12.7",
  "syntheticNoteCount": 0,
  "scanElapsedMs": 0,
  "incrementalSampleCount": 0,
  "incrementalP95Ms": 0,
  "workbenchOpenSampleCount": 0,
  "workbenchOpenP95Ms": 0,
  "nextActionElapsedMs": 0,
  "nextActionAcceptance": "pending",
  "topicDiscoveryElapsedMs": 0,
  "topicDiscoveryAcceptance": "pending",
  "readOnlyAcceptance": "pending",
  "writeAcceptance": "not-authorized"
}
```

这些指标不能互相替代：

- `incrementalSampleCount: 100` 与 `incrementalP95Ms` 必须来自专用合成库中 100 个端到端样本：每个样本在调用合成笔记的 `vault.modify()` 前一刻开始，只在 `await indexQueue.flushForTest()` 返回后结束，因此包含该主机路径中真实的 Obsidian `Plugin.saveData()`。p95 不超过 1,000 ms。若另行插桩得到 `Plugin.saveData()` 自身 latency，它只能作为 report-only 分解数据，不能替代或填入 `incrementalP95Ms`。`tests/performance/json-file-plugin-data-port.ts` 的临时 JSON 文件模拟也只用于自动化回归，不能填入这两个主机验收字段。
- `workbenchOpenSampleCount: 20` 与 `workbenchOpenP95Ms` 来自自动化的已完成投影控制器之上的 ItemView 构造、订阅、snapshot clone 与 jsdom DOM 渲染，p95 不超过 2,000 ms；计时不包含投影计算，也不是完整 Obsidian 主机启动耗时。
- `nextActionElapsedMs` 必须大于 0 且不超过 10,000 ms；`topicDiscoveryElapsedMs` 必须大于 0 且不超过 180,000 ms，并分别配套 `passed` 状态。
- 整体 `status: "passed"` 只在 5,000 篇合成笔记、扫描、100 次增量、20 次打开、两项定时任务、只读验收和专用库写入/Undo 验收全部达到阈值并标记 `passed` 时才有效。当前未授权写入验收时应保持 `status: "pending"`。

证据文件禁止包含绝对 vault 路径、笔记文件名/标题/正文/frontmatter、endpoint、模型、secret ID/值、插件数据、journal payload 或原始错误。

## 卸载

先在 Obsidian 中禁用插件，再删除专用 vault 的 `.obsidian/plugins/knowledge-workbench`。卸载不会撤销此前由用户确认执行的文件移动或 frontmatter 字段，也不会自动删除 Obsidian SecretStorage 中的条目。插件目录中的 `data.json` 会随目录删除；如需保留历史导出，请先在 History 中导出允许字段 JSON。

开发安装与卸载仅面向专用合成测试库；不要把本流程指向真实资料库。

## 许可证

本项目采用 [MIT License](LICENSE)。
