# AnyRouter 自动签到

## 使用

1. 在 Surge 中安装 `AnyRouter自动签到.sgmodule`，启用 HTTPS MITM 并信任证书。
2. 在同一设备的浏览器登录 [anyrouter.top](https://anyrouter.top/console)，打开一次“个人设置”或刷新控制台。
3. 脚本只会在 `/api/user/self` 返回 `success: true`、用户 ID 与 `New-API-User` 一致，并且请求带有 `session` 时保存账号。未登录、WAF 页面、错误响应都不会保存或提示成功。
4. 模块默认每天设备本地时间 `09:10` 运行；AnyRouter 的签到日期通常在北京时间 `08:00` 后切换。

首次抓取会在持久化存储写入 `ANYROUTER_ACCOUNTS` JSON。多账号按服务端用户 ID 隔离，最多 10 个；相同 session、UA 的重复页面请求不会再次写入或通知。

## 动态验证与限制

`acw_sc__v2` 只在本次请求的内存 Cookie jar 中按已验证的置换/XOR 变换生成，不会保存或发送到第三方中转。挑战格式变化或连续验证失败会明确报错并停止，不执行远端混淆 JavaScript，也不会把 HTTP 200 的验证页当成签到成功。

账号顺序执行，单次请求超时设为 4 秒，每个接口的动态验证最多重试两次；网络超时不会自动重发签到 POST，以免把未知结果误报为成功。签到结果通过 Surge 本地通知显示。

脚本不另设总运行预算，整个 cron 由模块中的 `timeout=60` 控制。4 秒和 60 秒都是本项目配置值，不是 Surge 的强制上限；官方文档说明[单次 HTTP 请求超时](https://manual.nssurge.com/scripting/api.html)和[脚本总超时](https://manual.nssurge.com/scripting/overview.html)均按秒设置，默认均为 5 秒。账号较多或网络较慢时，总运行时间仍可能超过模块配置的 60 秒并被 Surge 终止，届时可能没有完整的汇总通知；可按实际需求调整模块中的 `timeout`。

需要 Surge iOS 5.9+ / Mac 5.5+，用于关闭 HTTP 自动重定向和共享 Cookie 管理。登录会话只发往 `anyrouter.top`。

移除停用账号时，在 Surge 持久化存储 `ANYROUTER_ACCOUNTS` 的 `accounts` 数组中删除对应 ID 的记录；清空所有账号可写入 `{"version":1,"accounts":[]}`。注销网页不会自动删除定时签到配置。

仓库模块脚本 URL 使用功能分支，合并后可改为 `main`；交付目录中的模块锁定已测试的提交。
