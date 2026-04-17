/**
 * GLaDOS 自动签到 + 自动获取 CK（Surge 一体版）
 *
 * 功能：
 * 1. 作为 http-request 脚本运行时：自动抓取 Cookie 并写入持久化
 * 2. 作为 cron 脚本运行时：读取 Cookie 自动签到
 *
 * 持久化键：
 * - GLADOS_COOKIE
 * - GLADOS_API_BASE
 * - GLADOS_EMAIL（可选）
 *
 * 多账号支持：
 * - GLADOS_COOKIE
 * - GLADOS_EMAIL_1 / GLADOS_COOKIE_1
 * - GLADOS_EMAILS / GLADOS_COOKIES
 *
 * 可选 TG 推送：
 * - TG_BOT_TOKEN
 * - TG_CHAT_ID
 */

const UA_LIST = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_3_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/146.0.7680.24 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; zh-CN; SM-G9750) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
];

const DEFAULT_API_BASES = ["https://glados.cloud", "https://glados.one"];

const Store = {
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
  const forced = (Store.read("GLADOS_API_BASE") || "").trim();
  if (forced) return [forced];
  return DEFAULT_API_BASES;
}

function headers(cookie, apiBase) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Content-Type": "application/json;charset=utf-8",
    Cookie: cookie,
    Origin: apiBase,
    Referer: apiBase + "/",
    "User-Agent": pickUA(),
  };
}

function httpPost(url, body, hdrs) {
  return new Promise((resolve, reject) => {
    $httpClient.post(
      { url, headers: hdrs, body: JSON.stringify(body) },
      (err, resp, data) => {
        if (err) return reject(err);
        resolve({
          status: resp?.status || resp?.statusCode,
          headers: resp?.headers || {},
          body: data,
        });
      }
    );
  });
}

function httpGet(url, hdrs) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, headers: hdrs }, (err, resp, data) => {
      if (err) return reject(err);
      resolve({
        status: resp?.status || resp?.statusCode,
        headers: resp?.headers || {},
        body: data,
      });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  if (typeof rawMessage === "string" && rawMessage.trim()) {
    return rawMessage;
  }

  return "未知签到结果";
}

function normalizeCookie(cookie) {
  return String(cookie || "")
    .replace(/\s*;\s*/g, "; ")
    .trim();
}

/**
 * 抓取 Cookie
 */
function captureCookieFromRequest() {
  const url = $request?.url || "";
  const headers = $request?.headers || {};

  const cookie = normalizeCookie(headers.Cookie || headers.cookie || "");
  if (!cookie) {
    $notification.post("GLaDOS CK 获取失败", "请求头中没有 Cookie", url);
    $done({});
    return;
  }

  const m = url.match(/^https:\/\/([^/]+)/i);
  const host = m ? m[1] : "";
  const apiBase = host ? `https://${host}` : "";

  Store.write(cookie, "GLADOS_COOKIE");
  if (apiBase) Store.write(apiBase, "GLADOS_API_BASE");

  $notification.post(
    "GLaDOS CK 获取成功",
    host || "未知域名",
    `已写入 GLADOS_COOKIE${apiBase ? " / GLADOS_API_BASE" : ""}`
  );

  $done({});
}

/**
 * 解析多账号
 */
function parseAccounts() {
  const single = Store.read("GLADOS_COOKIE");
  if (single) {
    return [{ email: Store.read("GLADOS_EMAIL") || "", cookie: single }];
  }

  const emailsBulk = (Store.read("GLADOS_EMAILS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cookiesBulk = (Store.read("GLADOS_COOKIES") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (emailsBulk.length && emailsBulk.length === cookiesBulk.length) {
    return emailsBulk.map((e, i) => ({ email: e, cookie: cookiesBulk[i] }));
  }

  const acc = [];
  for (let i = 1; i <= 20; i++) {
    const e = Store.read(`GLADOS_EMAIL_${i}`);
    const c = Store.read(`GLADOS_COOKIE_${i}`);
    if (!c) break;
    acc.push({ email: e || "", cookie: c });
  }
  return acc;
}

async function signOnce(email, cookie) {
  let lastErr = "";

  for (const base of apiBases()) {
    const apiBase = String(base || "").replace(/\/+$/, "");
    const hdrs = headers(cookie, apiBase);
    const token = hostFromBase(apiBase);

    try {
      const checkinUrl = `${apiBase}/api/user/checkin`;
      const statusUrl = `${apiBase}/api/user/status`;

      const r1 = await httpPost(checkinUrl, { token }, hdrs);
      if (String(r1.status) !== "200") {
        throw new Error(`Checkin HTTP ${r1.status}: ${String(r1.body || "").slice(0, 150)}`);
      }

      let j1 = {};
      try {
        j1 = JSON.parse(r1.body || "{}");
      } catch (e) {
        throw new Error(`Checkin JSON 解析失败: ${String(r1.body || "").slice(0, 150)}`);
      }

      const msg = translateMessage(j1.message, j1.points);

      const r2 = await httpGet(statusUrl, hdrs);
      if (String(r2.status) !== "200") {
        throw new Error(`Status HTTP ${r2.status}: ${String(r2.body || "").slice(0, 150)}`);
      }

      let j2 = {};
      try {
        j2 = JSON.parse(r2.body || "{}");
      } catch (e) {
        throw new Error(`Status JSON 解析失败: ${String(r2.body || "").slice(0, 150)}`);
      }

      const leftDaysRaw = j2?.data?.leftDays;
      const left = typeof leftDaysRaw === "number"
        ? String(leftDaysRaw)
        : String(leftDaysRaw || "未知");

      const finalEmail = email || j2?.data?.email || "(未提供邮箱)";

      return {
        ok: true,
        email: finalEmail,
        message: msg,
        leftDays: left,
        apiBase,
      };
    } catch (e) {
      lastErr = `${apiBase} -> ${e}`;
    }
  }

  return {
    ok: false,
    email: email || "(未提供邮箱)",
    message: `请求异常：${lastErr || "unknown"}`,
    leftDays: "error",
    apiBase: "-",
  };
}

async function sendTelegram(summaryText) {
  const token = Store.read("TG_BOT_TOKEN");
  const chatId = Store.read("TG_CHAT_ID");
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
      () => resolve()
    );
  });
}

async function runCheckin() {
  const accounts = parseAccounts();

  if (!accounts.length) {
    $notification.post(
      "GLaDOS 签到",
      "未配置 Cookie",
      "请先登录 GLaDOS，让抓 CK 脚本自动写入 GLADOS_COOKIE"
    );
    $done();
    return;
  }

  const results = [];

  for (const { email, cookie } of accounts) {
    await sleep(Math.floor(Math.random() * 2000));
    results.push(await signOnce(email, normalizeCookie(cookie)));
  }

  const success = results.filter((r) => r.ok && r.message.includes("成功")).length;
  const repeats = results.filter((r) => r.ok && r.message.includes("重复")).length;
  const failed = results.filter((r) => !r.ok || r.message.includes("失败") || r.message.includes("异常")).length;

  const lines = results.map(
    (r) => `• ${r.email} | ${r.message} | 剩余: ${r.leftDays} 天 | ${r.apiBase}`
  );

  const title = `GLaDOS 签到（${nowStr()}）`;
  const subtitle = `成功 ${success}，重复 ${repeats}，失败 ${failed}`;

  $notification.post(title, subtitle, lines.join("\n"));

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
}

/**
 * 主入口
 * - 有 $request：抓 CK
 * - 没有 $request：执行签到
 */
if (typeof $request !== "undefined") {
  captureCookieFromRequest();
} else {
  runCheckin().catch((e) => {
    $notification.post("GLaDOS 签到异常", "脚本运行失败", String(e));
    $done();
  });
}