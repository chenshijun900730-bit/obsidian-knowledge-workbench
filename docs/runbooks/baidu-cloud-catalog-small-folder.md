# 百度网盘云端目录小目录验收手册

- 状态：实现验证阶段；本轮不会发起新的真实 OAuth、真实目录列表或真实 Vault 操作
- 用途：在不下载 PDF、不扫描根目录、不写入真实 Vault 的前提下，只验证一个用户明确选择的不敏感小目录
- 授权边界：阅读或执行本手册的自动化部分，不等于授权真实 OAuth 或真实目录请求
- 重新授权边界：到达 Checkpoint F 后，必须获得一次新的明确授权，才能再发起真实目录请求；此前的授权或验收结果不得复用为执行许可

## 1. 先确认产品边界

本功能只把百度网盘中的 PDF 元数据做成本地目录。原 PDF 继续保存在百度网盘，目录快照保存在：

```text
~/Library/Application Support/Knowledge Workbench/baidu-catalog/
```

目录快照不写入 Obsidian Vault，不包含 PDF 正文，也不会把 PDF 转成 Markdown。生产网络能力只包含：

- 百度官方 OOB OAuth 页面；
- OAuth Token 交换或一次 Token 刷新；
- `GET /rest/2.0/xpan/file?method=list`。

不存在下载、上传、创建目录、移动、复制、重命名、删除或分享接口。百度授权页显示的 `basic,netdisk` 范围比产品能力更宽；用户已经接受该外部范围，但这不授权产品增加写操作。

## 2. 真实操作前的停止门

下列条件必须同时成立，否则停止：

1. 使用用户本人创建的个人使用软件应用，官方 OOB 页面可用，`redirect_uri` 固定为 `oob`，不使用 localhost、本机监听器、Cookie、账号密码或第三方登录工具。
2. 只在仓库内专用合成 Vault 的 normal 构建中运行；不得安装到、打开或扫描真实 Vault。
3. 用户在百度网盘客户端中先选定一个不敏感、非根小目录。建议包含 20–100 个 PDF、1–2 层子目录，并在客户端中预先人工统计 PDF、目录和其他文件数量。
4. 目录路径、AppKey、SecretKey 和授权码只输入插件本地界面，不发送到聊天、终端、源码、截图、Git、日志或 PMH；Token 和响应内容同样不得进入这些位置。
5. 目录不能是 `/`，也不能为了寻找目标目录先枚举父目录。当前运行时会拒绝根目录。
6. 用户再次明确同意“现在执行一次真实 OOB 授权，并只扫描这个已选小目录”。此前对设计、OAuth 范围或其他验收轮次的同意不替代这一次执行授权。
7. 用户已经确认并接受下面的 SecretStorage 属性，或另行批准更换凭证存储设计。

### SecretStorage 的准确含义

当前实现把 AppKey、SecretKey、access token 和 refresh token 交给 Obsidian SecretStorage，并证明适配器不会把它们写入插件 `data.json`、Vault、仓库或外部目录快照。Obsidian 官方文档说明，SecretStorage 避免秘密直接出现在插件 `data.json`，实际秘密保存在按 Vault 加键的本地存储中，并可在插件间共享；该 API 名称本身不保证 macOS Keychain 或静态加密。

因此，自动化边界测试不等于“已经证明由 macOS Keychain 保护”。如果用户不接受 Obsidian SecretStorage 的这一属性，真实 AppKey、SecretKey 和 Token 不得输入，必须先单独设计并批准 macOS Keychain 适配器。

参考：[Obsidian SecretStorage 官方指南](https://docs.obsidian.md/Plugins/Guides/SecretStorage)

## 3. 自动化预检

真实授权前运行：

```bash
npx vitest run tests/unit/catalog tests/integration/catalog-scan.test.ts tests/integration/catalog-small-folder-preflight.test.ts tests/ui/cloud-catalog-tab.test.ts tests/ui/settings-tab.test.ts tests/packaging/composition-roots.test.ts
npm run verify
npm run test:coverage
```

预检必须证明：

- 打开 OOB 页面时，Token 和列表请求数均为零；
- 提交合成授权码时只有一次 Token 请求，列表请求数仍为零；
- 取消扫描确认时列表请求数仍为零；
- 确认合成小目录后只出现 `GET + method=list`，下载请求数和 PDF 下载字节数为零；
- normal 构建包含 OAuth、SecretStorage、列表和外部快照能力，read-only acceptance 构建不包含这些能力；
- `/` 在确认框或列表请求之前被拒绝；
- 所有测试只使用合成路径、假凭据和临时目录。

任一门失败时，不进入真实授权。

## 4. 一次真实小目录验收

只有第 2 节获得新的明确执行授权后，才执行本节。

1. 在专用合成 Vault 中打开 normal 构建的设置页。
2. 在本地界面输入 AppKey 和 SecretKey，点击 `Connect`。两个输入框会立即清空；凭据保存到 Obsidian SecretStorage。
3. 确认浏览器只打开百度官方域名的 OOB 授权页。不要截图、复制完整 URL 或打开开发者日志。
4. 人工确认页面仍显示此前接受的 `basic,netdisk` 范围，然后点击官方授权。
5. 只把官方页面显示的一次性授权码粘贴到插件的密码输入框并立即提交。不要把授权码保存到剪贴板历史、笔记、终端、聊天或证据文件。提交、取消或十分钟超时后确认输入框为空。
6. OAuth 成功后先停一下：此时列表请求数必须仍为零。
7. 在插件本地输入此前选定的小目录绝对路径，点击 `Validate path`。不得输入 `/`，不得尝试父目录。
8. 点击 `Start read-only scan`，在确认框中核对“递归列出元数据”“不下载 PDF”“旧完整快照保留”三项提示，再人工确认一次。
9. 只执行这一个目录。完成、部分完成、暂停或失败后都停止，不扩大到父目录或根目录。

本次验收只有在下列条件全部满足时才算成功：扫描状态为 `complete`，PDF、目录和其他文件数量与客户端预先统计完全一致，`list_request_count <= 25`，没有错误码，且 `downloaded_pdf_bytes=0`。预算触发后的 `paused` 是安全停止结果，不是验收成功，也不授权恢复或扩大扫描。

## 5. 网络与结果核验

可以在本机临时查看请求类型，但不得保存 HAR、原始 URL、请求头、响应正文或截图，因为其中可能包含 Token、真实路径、文件名和账号线索。只记录聚合结果：

- OAuth 请求只到官方 OAuth endpoint；
- 文件请求全部是 `GET /rest/2.0/xpan/file` 且 `method=list`；
- 没有 download、dlink、filemanager、upload、create、move、copy、rename、delete 或 share 请求；
- `downloaded_pdf_bytes=0`；
- 将插件返回的目录数、PDF 数和忽略文件数，与百度网盘客户端可见数量人工核对。

允许保存的唯一证据结构：

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

禁止记录目录路径、文件名、书名、账号身份、AppKey、SecretKey、授权码、Token、原始 URL、响应正文或目录快照内容。

## 6. 立即停止条件

出现以下任一情况立即停止，不重试扩大范围：

- `baidu-permission-denied`、`baidu-access-unavailable` 或应用无权访问现有目录；
- `baidu-rate-limited` 或任何配额提示；
- `baidu-not-found`、`invalid-baidu-response`、`snapshot-corrupt`；
- OOB 页面不可用、授权范围变化或域名不是百度官方域名；
- 出现任何非 OAuth、非 `GET + method=list` 的文件请求；
- 下载字节数不为零；
- 用户输入根目录、要求先枚举父目录或未完成最终确认；
- SecretStorage 属性尚未被接受；
- 插件运行在真实 Vault 中。

权限或配额错误只记录固定错误码。不得改用 Cookie、账号密码、隐藏接口、第三方工具、父目录扫描、根目录扫描或并发请求绕过。

## 7. 本地断开、刷新与恢复

- `Remove local credentials` 只删除本机 SecretStorage 中的应用凭据和 Token，并取消本地授权/扫描状态；它不宣称已经撤销百度服务器端授权。
- 如需撤销宽范围授权，用户还要在百度官方“授权管理”页面人工撤销；不要把该页面截图或账号信息写入证据。
- Token 过期时，产品最多执行一次官方刷新并重放同一个 list 请求；不会循环重试。
- 取消或限流会保留仅供审计的部分 checkpoint/receipt；当前界面不提供恢复扫描。只有完整扫描才提升为当前目录快照。
- 新扫描完成前，旧的完整快照仍保留。不得通过删除真实 Vault 内容处理目录故障。

## 8. 验收结束点

一次小目录验收完成后立即停止并汇报聚合字段。不得继续根目录、第二个目录、真实 Vault 安装、对照模型实验或批量模型调用。70,000 上限或其他大规模模式不在本手册范围内，必须另行设计和批准。下一步必须由用户另行确认。
