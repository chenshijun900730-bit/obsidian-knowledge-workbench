# 百度网盘 OOB 授权范围可行性门

- 状态：已完成；OOB 页面可用，授权页无目录选择器，用户已明确接受全盘 `basic,netdisk` 读写范围
- 目的：确认个人应用、OOB 页面和实际 OAuth 范围，并把“外部授权范围”与“产品只读能力”分开记录
- 本步骤只确认授权范围；真实授权码交换必须等凭证、OAuth 和只读列表适配器通过隔离测试

## 1. 必须遵守的边界

- 只使用[百度网盘开放平台控制台](https://pan.baidu.com/union/console/applist)和百度官方 OAuth 页面。
- 不配置 localhost、`127.0.0.1`、局域网地址、通配符或第三方回调域名；授权模式固定为 `redirect_uri=oob`。
- AppKey、SecretKey、一次性授权码、账号信息、真实目录路径和完整授权 URL 不得发送到聊天、终端、项目文件、截图或 PMH 记录。
- 本步骤不需要 SecretKey。授权 URL 只会在本地浏览器中使用 AppKey 作为 `client_id`。
- 在凭证和 OAuth 适配器验证完成前，不点击授权；若误显示一次性授权码，立即关闭页面，不复制、保存、交换或发送。
- 不安装到真实 Vault，不下载 PDF，不调用任何网盘文件接口。

## 2. 创建个人使用软件应用

1. 用户亲自在官方控制台登录；如页面要求，完成个人实名认证。
2. 选择“创建应用”。
3. 应用用途选择“个人使用”。
4. 应用类型选择“软件”。
5. 应用名称和描述使用不包含个人目录、书名或账号信息的普通名称。
6. 创建后只在本地私密位置查看并暂存 AppKey、SecretKey；不要把它们粘贴到 Codex、终端、环境变量或仓库。

若无法创建个人使用软件应用，停止并只回复：`个人应用不可用`。

## 3. 打开官方 OOB 授权页

在浏览器地址栏本地构造以下官方 URL，把 `<APPKEY>` 替换为刚创建应用的 AppKey。不要把替换后的 URL 发给任何人：

```text
https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=<APPKEY>&redirect_uri=oob&scope=basic%2Cnetdisk
```

确认浏览器最终停留在百度官方域名，并显示该应用的官方授权界面。

- 若页面拒绝 `redirect_uri=oob`、应用或 `basic,netdisk` 权限，停止并只回复：`OOB 页面不可用`。
- 若页面正常显示授权内容，继续下一节；不要记录页面 URL。

## 4. 检查授权范围

授权界面已经确认：

1. 页面提供 `basic` 与 `netdisk` 权限；
2. `netdisk` 文案包含在百度网盘创建文件夹并读写数据；
3. 页面不提供现有目录选择器；
4. 用户已明确接受该全盘读写 OAuth 范围；
5. 产品仍只允许 OAuth、Token 交换与 `GET + method=list`，不因此获得任何写操作代码路径。

此结果只证明 OAuth 范围可被用户接受，不证明任意现有路径可列举。现有路径能力必须在自动化安全门通过后，通过一次用户确认的小目录只读请求验证。

## 5. 固定结果

最终记录必须保持粗粒度，不包含截图、路径、应用名称、账号信息、AppKey、SecretKey、授权码、Token 或 URL：

- `personal_app=ready`
- `oob_page=available`
- `folder_selector=unavailable`
- `broad_netdisk_scope=accepted`
- `existing_path_list=not_tested`

## 6. 停止条件

- 先实现并隔离验证 SecretStorage，再用 TDD 实现 OOB OAuth 与严格只读列表适配器。
- 在自动化安全门完成前不交换真实授权码。
- 真实验证只允许一个用户再次确认的不敏感小目录；不得先列举根目录或父目录。
- 任意权限拒绝、应用访问错误或出现写请求都立即停止，不改用 Cookie、账号密码、隐藏接口或第三方工具。
