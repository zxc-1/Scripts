# AnyRouter 自动签到

## 使用

1. 在 Surge 中安装 `AnyRouter自动签到.sgmodule`，启用 HTTPS MITM 并信任证书。
2. 在同一设备的浏览器登录 [anyrouter.top](https://anyrouter.top/console)，打开一次“个人设置”或刷新控制台。
3. 脚本只会在 `/api/user/self` 返回 `success: true`、用户 ID 与 `New-API-User` 一致，并且请求带有 `session` 时保存账号。未登录、WAF 页面、错误响应都不会保存或提示成功。
4. 模块默认每天设备本地时间 `09:10` 运行；AnyRouter 的签到日期通常在北京时间 `08:00` 后切换。

首次抓取会在持久化存储写入 `ANYROUTER_ACCOUNTS` JSON。多账号按服务端用户 ID 隔离，最多 10 个；相同 session、UA 的重复页面请求不会再次写入或通知。

## Telegram（可选）

在 Surge 持久化存储中设置 `TG_BOT_TOKEN` 和 `TG_CHAT_ID`。推送使用纯文本；Telegram 失败只显示失败原因，不会覆盖本地签到结果。

## 动态验证与限制

`acw_sc__v2` 只在本次请求的内存 Cookie jar 中按已验证的置换/XOR 变换生成，不会保存或发送到第三方中转。挑战格式变化或连续验证失败会明确报错并停止，不执行远端混淆 JavaScript，也不会把 HTTP 200 的验证页当成签到成功。

模块脚本 URL 使用仓库固定分支；合并后可将其替换为 `main`。
