# AnyRouter 自动签到

## 使用

1. 在 Surge 中安装 `AnyRouter自动签到.sgmodule`，启用 HTTPS MITM 并信任证书。
2. 在同一设备的浏览器登录 [anyrouter.top](https://anyrouter.top/console)，打开一次“个人设置”或刷新控制台。
3. 脚本只会在 `/api/user/self` 返回 `success: true`、用户 ID 与 `New-API-User` 一致，并且请求带有 `session` 时保存账号。未登录、WAF 页面、错误响应都不会保存或提示成功。
4. 模块默认每天设备本地时间 `09:30` 运行；AnyRouter 的签到日期通常在北京时间 `08:00` 后切换。

首次抓取会在持久化存储写入 `ANYROUTER_ACCOUNTS` JSON。多账号按服务端用户 ID 隔离，最多 10 个；相同 session、UA 的重复页面请求不会再次写入或通知。

## 动态验证与限制

`acw_sc__v2` 只在本次请求的内存 Cookie jar 中按已验证的置换/XOR 变换生成，不会保存或发送到第三方中转。挑战格式变化或连续验证失败会明确报错并停止，不执行远端混淆 JavaScript，也不会把 HTTP 200 的验证页当成签到成功。

账号顺序执行，单次请求超时设为 4 秒，每个接口的动态验证最多重试两次；网络超时不会自动重发签到 POST，以免把未知结果误报为成功。签到结果通过 Surge 本地通知按账号分段显示，附带签到后重新查询的剩余额度、已用额度与总额度（剩余 + 已用）；多账号会合计已获取的额度。美元换算参数来自 `/api/status`，每次定时运行只读取一次。额度查询失败会单独提示，不使用签到前余额，也不改变已经确认的签到结果。

脚本不另设总运行预算，模块默认设置 `timeout=465`。依据是（10 个账号 × 3 个接口 + 1 次共享额度配置）× 每接口最多 3 次请求 × 单次 4 秒，共 372 秒请求耗时，再留 25% 的执行余量。脚本完成后立即通过 `$done()` 退出；可在本地模块的 `AnyRouter_Checkin` 行修改 `timeout`。

4 秒和 465 秒都是项目配置值。[官方 HTTP API 文档](https://manual.nssurge.com/scripting/api.html)和[脚本配置文档](https://manual.nssurge.com/scripting/overview.html)说明两种超时都按秒设置、默认均为 5 秒；[cron 文档](https://manual.nssurge.com/scripting/cron.html)明确允许根据任务需求增大脚本超时，但这些文档未公布硬性最大值，也未说明 `0` 可用于关闭超时。465 秒是上述执行路径的参考配置，实际仍可能受 Surge 引擎调度、设备休眠或系统终止影响。

需要 Surge iOS 5.9+ / Mac 5.5+，用于关闭 HTTP 自动重定向和共享 Cookie 管理。登录会话只发往 `anyrouter.top`。

移除停用账号时，在 Surge 持久化存储 `ANYROUTER_ACCOUNTS` 的 `accounts` 数组中删除对应 ID 的记录；清空所有账号可写入 `{"version":1,"accounts":[]}`。注销网页不会自动删除定时签到配置。

仓库模块脚本 URL 使用 `main`；交付目录中的模块锁定已测试的提交。
