/**
 * GLaDOS 自动签到（Surge 版）
 * 抓包要点（你这份 HAR）：
 * - 接口域名已不再是 glados.rocks，而是 glados.cloud（同时部分场景也会用 glados.one）
 * - POST /api/user/checkin 的 body 里 token 会跟随域名（例如 glados.cloud / glados.one）
 */

const UA_LIST = [
  // 贴近你抓包里的 iOS Chrome UA（也保留桌面/安卓以防）
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_3_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/146.0.7680.24 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; zh-CN; SM-G9750) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
];

const DEFAULT_API_BASES = ["https://glados.cloud", "https://glados.one"];

// ------- 偏好项（Surge -> Scripts -> glados.surge.js 的 Arguments / 或用持久化键写入）-------
// 必填：
// - GLADOS_COOKIE（示例：koa:sess=xxx; koa:sess.sig=yyy）
//
// 可选：
// - GLADOS_API_BASE（强制指定域名：例如 https://glados.cloud；不填则按 DEFAULT_API_BASES 依次尝试）
//
// 多账号仍支持原来的三种写法：
// 1) 单账号：GLADOS_COOKIE
// 2) 多账号成对：GLADOS_EMAIL_1 / GLADOS_COOKIE_1，GLADOS_EMAIL_2 / GLADOS_COOKIE_2...
// 3) 批量：GLADOS_EMAILS（逗号分隔），GLADOS_COOKIES（逗号分隔）
//
// 可选 Telegram 推送：TG_BOT_TOKEN, TG_CHAT_ID
// ---------------------------------------------------------------------------------------------

const $prefs = {
  read: (k) => $persistentStore.read(k),
  write: (v, k) => $persistentStore.write(v, k),
};

function pickUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

function hostFromBase(base) {
  return String(base || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim();
}

function apiBases() {
  const v = ($prefs.read("GLADOS_API_BASE") || "").trim();
  return v ? [v] : DEFAULT_API_BASES;
}

function headers(cookie, apiBase) {
  return {
    "Accept": "application/json, text/plain, */*",
    // 避免 br 造成部分环境解压异常
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Content-Type": "application/json;charset=utf-8",
    "Cookie": cookie,
    "Origin": apiBase,
    "User-Agent": pickUA(),
  };
}

function httpPost(url, body, hdrs) {
  return new Promise((resolve, reject) => {
    $httpClient.post({ url, headers: hdrs, body: JSON.stringify(body) }, (err, resp, data) => {
      if (err) return reject(err);
      resolve({ status: resp?.status || resp?.statusCode, headers: resp?.headers, body: data });
    });
  });
}

function httpGet(url, hdrs) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, headers: hdrs }, (err, resp, data) => {
      if (err) return reject(err);
      resolve({ status: resp?.status || resp?.statusCode, headers: resp?.headers, body: data });
    });
  });
}

function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function translateMessage(rawMessage, points) {
  if (typeof points === "number") return `签到成功，获得 ${points} 积分`;
  if (rawMessage === "Please Try Tomorrow") return "签到失败，请明天再试";
  if (rawMessage === "Checkin Repeats! Please Try Tomorrow") return "重复签到，请明天再试";
  if (typeof rawMessage === "string" && rawMessage.includes("Checkin! Got")) {
    const m = rawMessage.match(/Got\s+(\d+(?:\.\d+)?)\s+Points/i);
    return m ? `签到成功，获得 ${m[1]} 积分` : "签到成功";
  }
  return `未知的签到结果: ${rawMessage ?? ""}`;
}

async function signOnce(email, cookie) {
  let lastErr = "";
  for (const base of apiBases()) {
    const apiBase = base.replace(/\/+$/, "");
    const hdrs = headers(cookie, apiBase);
    const token = hostFromBase(apiBase);

    try {
      const checkinUrl = `${apiBase}/api/user/checkin`;
      const statusUrl = `${apiBase}/api/user/status`;

      const r1 = await httpPost(checkinUrl, { token }, hdrs);
      if (String(r1.status) !== "200") throw new Error(`Checkin HTTP ${r1.status}: ${String(r1.body || "").slice(0, 120)}`);

      const j1 = JSON.parse(r1.body || "{}");
      const msg = translateMessage(j1.message, j1.points);

      const r2 = await httpGet(statusUrl, hdrs);
      if (String(r2.status) !== "200") throw new Error(`Status HTTP ${r2.status}: ${String(r2.body || "").slice(0, 120)}`);

      const j2 = JSON.parse(r2.body || "{}");
      const leftDaysRaw = j2?.data?.leftDays;
      const left = typeof leftDaysRaw === "number" ? leftDaysRaw.toString() : String(leftDaysRaw || "未知");

      return {
        ok: true,
        email: email || j2?.data?.email || "(未提供邮箱)",
        message: msg,
        leftDays: left,
        apiBase,
      };
    } catch (e) {
      lastErr = `${apiBase} -> ${e}`;
      // 尝试下一个域名
    }
  }

  return { ok: false, email: email || "(未提供邮箱)", message: `请求异常：${lastErr || "unknown"}`, leftDays: "error", apiBase: "-" };
}

function parseAccounts() {
  // 单账号
  const single = $prefs.read("GLADOS_COOKIE");
  if (single) return [{ email: $prefs.read("GLADOS_EMAIL") || "", cookie: single }];

  // 批量（逗号）
  const emailsBulk = ($prefs.read("GLADOS_EMAILS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const cookiesBulk = ($prefs.read("GLADOS_COOKIES") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (emailsBulk.length && emailsBulk.length === cookiesBulk.length) {
    return emailsBulk.map((e, i) => ({ email: e, cookie: cookiesBulk[i] }));
  }

  // 编号键
  const acc = [];
  for (let i = 1; i <= 20; i++) {
    const e = $prefs.read(`GLADOS_EMAIL_${i}`);
    const c = $prefs.read(`GLADOS_COOKIE_${i}`);
    if (!c) break;
    acc.push({ email: e || "", cookie: c });
  }
  return acc;
}

async function sendTelegram(summaryText) {
  const token = $prefs.read("TG_BOT_TOKEN");
  const chatId = $prefs.read("TG_CHAT_ID");
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: summaryText,
    parse_mode: "HTML",
  };

  return new Promise((resolve) => {
    $httpClient.post(
      {
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      (_e, _r, _d) => resolve()
    );
  });
}

(async () => {
  const accounts = parseAccounts();
  if (!accounts.length) {
    $notification.post("GLaDOS 签到", "未配置 Cookie", "请在持久化存储写入 GLADOS_COOKIE 或 GLADOS_COOKIE_1 等键");
    return $done();
  }

  const results = [];
  for (const { email, cookie } of accounts) {
    // 防止过快，轻微随机延时（0~2s），避免风控
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2000)));
    results.push(await signOnce(email, cookie));
  }

  const success = results.filter((r) => r.ok && r.message.includes("成功")).length;
  const repeats = results.filter((r) => r.ok && r.message.includes("重复")).length;
  const failed = results.filter((r) => !r.ok || r.message.includes("失败") || r.message.includes("异常")).length;

  // 本地通知
  const lines = results.map((r) => `• ${r.email} | ${r.message} | 剩余: ${r.leftDays} 天 | ${r.apiBase}`);
  const title = `GLaDOS 签到（${nowStr()}）`;
  const subtitle = `成功 ${success}，重复 ${repeats}，失败 ${failed}`;
  $notification.post(title, subtitle, lines.join("\n"));

  // 可选：Telegram 推送
  const tgText = [
    `当前时间: ${nowStr()}`,
    "",
    "GLaDOS 签到结果：",
    ...results.map((r) => `- ${r.email}: ${r.message}`),
    "",
    "账号状态：",
    ...results.map((r) => `- ${r.email}: 剩余 ${r.leftDays} 天（${r.apiBase}）`),
  ].join("\n");
  await sendTelegram(tgText);

  $done();
})();