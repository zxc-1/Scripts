/**
 * GLaDOS 自动签到 + Cookie / User-Agent 获取（Surge 一体版）
 * 同时更新脚本与模块；在 Surge 已启用 HTTPS 解密的设备上登录并刷新控制台，验证登录后保存会话。
 * 单账号: GLADOS_COOKIE / GLADOS_USER_AGENT / GLADOS_API_BASE / GLADOS_EMAIL（可选）
 * 多账号: GLADOS_EMAIL_1 / GLADOS_COOKIE_1 / GLADOS_USER_AGENT_1（依次编号，优先于自动抓取的单账号）
 * 批量: GLADOS_EMAILS / GLADOS_COOKIES（逗号分隔），每个账号配置 GLADOS_USER_AGENT_1 等。
 */

const DEFAULT_API_BASES = ["https://glados.network"];

const Store = {
  read: (k) => $persistentStore.read(k),
  write: (v, k) => $persistentStore.write(v, k),
};

function userAgentFor(index) {
  const key = index ? `GLADOS_USER_AGENT_${index}` : "GLADOS_USER_AGENT";
  return String(Store.read(key) || "").trim();
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

function headers(cookie, apiBase, userAgent) {
  if (!userAgent) throw new Error("缺少 User-Agent，请重新登录并抓取 Cookie 与 User-Agent");
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Content-Type": "application/json;charset=utf-8",
    Cookie: cookie,
    Origin: apiBase,
    Referer: apiBase + "/",
    "User-Agent": userAgent,
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

function sameCookie(left, right) {
  const parts = (cookie) => normalizeCookie(cookie).split("; ").filter(Boolean).sort().join("; ");
  return parts(left) === parts(right);
}

function requestHeader(name) {
  const headers = $request.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

function hasAuthenticatedStatusResponse() {
  if (typeof $response === "undefined") return false;
  try {
    const result = parseResponse($response, "Status");
    return result?.code === 0 && typeof result.data?.email === "string" && !!result.data.email.trim();
  } catch (e) {
    // 未登录、错误或不完整的响应直接放行，不保存候选 Cookie。
    return false;
  }
}

function captureCookieFromResponse() {
  const url = $request.url || "";
  const m = url.match(/^https:\/\/(glados\.(?:network|cloud|one))\/api\/user\/status(?:\?.*)?$/i);
  if (!m || !hasAuthenticatedStatusResponse()) {
    $done({});
    return;
  }
  const cookie = normalizeCookie(requestHeader("Cookie"));
  const userAgent = String(requestHeader("User-Agent") || "").trim();
  if (!cookie || !userAgent) {
    $done({});
    return;
  }
  const host = m[1].toLowerCase();
  const apiBase = `https://${host}`;
  if (sameCookie(Store.read("GLADOS_COOKIE"), cookie) &&
      userAgentFor() === userAgent && Store.read("GLADOS_API_BASE") === apiBase) {
    $done({});
    return;
  }
  const updates = [["GLADOS_COOKIE", cookie], ["GLADOS_USER_AGENT", userAgent], ["GLADOS_API_BASE", apiBase]];
  const written = [];
  try {
    for (const [key, value] of updates) {
      const previous = Store.read(key);
      if (!Store.write(value, key)) throw new Error("保存失败");
      written.push([key, previous]);
    }
    $notification.post("GLaDOS CK 获取成功", host || "未知域名", "已验证登录并保存 Cookie、User-Agent 和 API 域名");
  } catch (e) {
    let restored = true;
    for (const [key, previous] of written.reverse()) {
      try { if (!Store.write(previous ?? "", key)) restored = false; }
      catch (e) { restored = false; }
    }
    $notification.post("GLaDOS CK 获取失败", "配置保存失败", restored
      ? "原会话已保留，请检查持久化存储后重试" : "配置未完整恢复，请检查持久化存储并重新抓取");
  }
  $done({});
}

function parseAccounts() {
  const emailsBulk = (Store.read("GLADOS_EMAILS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cookiesBulk = (Store.read("GLADOS_COOKIES") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (emailsBulk.length || cookiesBulk.length) {
    if (!emailsBulk.length || emailsBulk.length !== cookiesBulk.length) {
      throw new Error("批量账号 GLADOS_EMAILS 与 GLADOS_COOKIES 数量不一致，请检查配置");
    }
    return emailsBulk.map((e, i) => ({ email: e, cookie: cookiesBulk[i], userAgent: userAgentFor(i + 1) }));
  }

  const acc = [];
  for (let i = 1; i <= 20; i++) {
    const e = Store.read(`GLADOS_EMAIL_${i}`);
    const c = Store.read(`GLADOS_COOKIE_${i}`);
    if (!c) break;
    acc.push({ email: e || "", cookie: c, userAgent: userAgentFor(i) });
  }
  if (acc.length) return acc;
  const single = Store.read("GLADOS_COOKIE");
  return single ? [{ email: Store.read("GLADOS_EMAIL") || "", cookie: single, userAgent: userAgentFor() }] : [];
}

function parseResponse(response, label) {
  if (String(response.status) !== "200") {
    throw new Error(`${label} HTTP ${response.status}: ${String(response.body || "").slice(0, 150)}`);
  }
  try {
    return JSON.parse(response.body || "{}");
  } catch (e) {
    throw new Error(`${label} JSON 解析失败: ${String(response.body || "").slice(0, 150)}`);
  }
}

function checkinMessage(result) {
  if (result?.code === 0) return translateMessage(result.message, result.points);
  if (result?.code === 1 && /Checkin Repeats|Today's observation logged/i.test(result.message || "")) {
    return "重复签到，今日已完成，请明天再试";
  }
  if (result?.code === 4 && result.reason === "device-mismatch") {
    throw new Error(`设备不一致（登录: ${result.loginDevice || "未知"}，当前: ${result.currentDevice || "未知"}），请在当前设备重新登录并抓取 Cookie 与 User-Agent`);
  }
  throw new Error(`签到失败 (code ${result?.code ?? "未知"}): ${result?.message || "未知签到结果"}`);
}

async function signOnce(email, cookie, userAgent) {
  let lastErr = "";
  for (const base of apiBases()) {
    const apiBase = String(base || "").replace(/\/+$/, "");
    try {
      const hdrs = headers(cookie, apiBase, userAgent);
      const token = hostFromBase(apiBase);
      const r1 = await httpPost(`${apiBase}/api/user/checkin`, { token }, hdrs);
      const j1 = parseResponse(r1, "Checkin");
      const msg = checkinMessage(j1);
      const r2 = await httpGet(`${apiBase}/api/user/status`, hdrs);
      const j2 = parseResponse(r2, "Status");
      if (j2?.code !== 0 || !j2.data) {
        throw new Error(`Status 失败 (code ${j2?.code ?? "未知"}): ${j2?.message || "缺少账号状态"}`);
      }
      const leftDaysRaw = j2.data.leftDays;
      const left = typeof leftDaysRaw === "number" ? String(leftDaysRaw) : String(leftDaysRaw || "未知");
      return { ok: true, repeated: j1.code === 1, email: email || j2.data.email || "(未提供邮箱)", message: msg, leftDays: left, apiBase };
    } catch (e) {
      lastErr = `${apiBase} -> ${e}`;
    }
  }
  return { ok: false, email: email || "(未提供邮箱)", message: `请求异常：${lastErr || "unknown"}`, leftDays: "error", apiBase: "-" };
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

  for (const { email, cookie, userAgent } of accounts) {
    await sleep(Math.floor(Math.random() * 2000));
    results.push(await signOnce(email, normalizeCookie(cookie), userAgent));
  }

  const success = results.filter((r) => r.ok && !r.repeated).length;
  const repeats = results.filter((r) => r.ok && r.repeated).length;
  const failed = results.filter((r) => !r.ok).length;

  const lines = results.map(
    (r) => `• ${r.email} | ${r.message} | 剩余: ${r.leftDays} 天 | ${r.apiBase}`
  );

  const title = `GLaDOS 签到（${nowStr()}）`;
  const subtitle = `成功 ${success}，重复 ${repeats}，失败 ${failed}`;

  $notification.post(title, subtitle, lines.join("\n"));

  $done();
}

/**
 * 主入口
 * - 有 $request：验证 status 响应中的登录状态后抓 CK
 * - 没有 $request：执行签到
 */
if (typeof $request !== "undefined") {
  captureCookieFromResponse();
} else {
  runCheckin().catch((e) => {
    $notification.post("GLaDOS 签到异常", "脚本运行失败", String(e));
    $done();
  });
}
