/**
 * GLaDOS 自动签到 + Cookie / User-Agent 获取（Surge 一体版）
 * 同时更新脚本与模块；在 Surge 已启用 HTTPS 解密的设备上登录并刷新控制台，验证登录后保存会话。
 * 单账号: GLADOS_COOKIE / GLADOS_USER_AGENT / GLADOS_API_BASE / GLADOS_EMAIL（可选）
 * 多账号: GLADOS_EMAIL_1 / GLADOS_COOKIE_1 / GLADOS_USER_AGENT_1（依次编号，优先于自动抓取的单账号）
 * 批量: GLADOS_EMAILS / GLADOS_COOKIES（逗号分隔），每个账号配置 GLADOS_USER_AGENT_1 等。
 */

const DEFAULT_API_BASES = ["https://glados.network"];
const SESSION_COOKIE_NAMES = ["gld:sess", "gld:sess.sig"];
const API_PATHS = ["/api/user/checkin", "/api/user/status", "/api/user/points"];

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

function http(method, options) {
  const request = { ...options, "auto-cookie": false, "auto-redirect": false, "full-header-mode": true };
  return new Promise((resolve, reject) => {
    $httpClient[method](request, (err, resp, data) => {
      if (err) return reject(err);
      resolve({
        status: resp?.status ?? resp?.statusCode,
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

function headerValues(headers, name) {
  const entries = Array.isArray(headers) ? headers.map(item => [item.field, item.value]) : Object.entries(headers || {});
  return entries.filter(([key]) => String(key).toLowerCase() === name.toLowerCase())
    .flatMap(([, value]) => Array.isArray(value) ? value.map(String) : [String(value ?? "")]);
}

function cookieJar(cookie) {
  const jar = {};
  for (const part of String(cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (/^[\x21-\x7e]+$/.test(name) && /^[\x21-\x7e]*$/.test(value) && !/[;,"\\]/.test(value)) jar[name] = value;
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).filter(([, value]) => value !== "").map(([name, value]) => `${name}=${value}`).join("; ");
}

function apiCookiePath(path) {
  const value = String(path || "/").trim();
  if (!value.startsWith("/")) return false;
  const prefix = value.endsWith("/") ? value : `${value}/`;
  return API_PATHS.every(endpoint => endpoint === value || endpoint.startsWith(prefix));
}

function cookieDomainMatches(domain, host) {
  const value = String(domain || "").trim().toLowerCase().replace(/^\./, "");
  const current = String(host || "").trim().toLowerCase();
  return !value || current === value || current.endsWith(`.${value}`);
}

function mergeSetCookies(cookie, headers, host) {
  const original = normalizeCookie(cookie);
  const responseCookies = headerValues(headers, "Set-Cookie");
  if (!responseCookies.length) return original;
  const jar = cookieJar(cookie);
  let touched = false;
  let invalid = false;
  for (const header of responseCookies) {
    for (const raw of header.split(/,(?=\s*[^;,=\s]+\s*=)/)) {
      const parts = raw.split(";").map(part => part.trim());
      const index = parts[0].indexOf("=");
      if (index < 1) continue;
      const name = parts[0].slice(0, index).trim();
      if (!SESSION_COOKIE_NAMES.includes(name)) continue;
      const attribute = key => parts.slice(1).find(part => part.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
      if (!cookieDomainMatches(attribute("domain"), host) || !apiCookiePath(attribute("path"))) continue;
      touched = true;
      const value = parts[0].slice(index + 1).trim();
      const maxAge = attribute("max-age");
      const expires = attribute("expires");
      const expired = maxAge !== undefined ? Number(maxAge) <= 0 : expires && Date.parse(expires) <= Date.now();
      if (!value || expired) delete jar[name];
      else if (/^[\x21-\x7e]+$/.test(value) && !/[;,"\\]/.test(value)) jar[name] = value;
      else invalid = true;
    }
  }
  if (!touched) return original;
  if (invalid) throw new Error("服务端返回无效会话 Cookie，请重新登录并抓取 Cookie 与 User-Agent");
  if (!SESSION_COOKIE_NAMES.every(name => !!jar[name])) {
    throw new Error("登录会话已清除，请重新登录并抓取 Cookie 与 User-Agent");
  }
  return cookieHeader(jar);
}

function headersAfterResponse(hdrs, response, apiBase) {
  return { ...hdrs, Cookie: mergeSetCookies(hdrs.Cookie, response.headers, hostFromBase(apiBase)) };
}

function hasSessionCookie(cookie) {
  const jar = cookieJar(cookie);
  const present = SESSION_COOKIE_NAMES.some(name => Object.prototype.hasOwnProperty.call(jar, name));
  return !present || SESSION_COOKIE_NAMES.every(name => !!jar[name]);
}

function requireSessionCookie(cookie, label) {
  if (!hasSessionCookie(cookie)) throw new Error(`${label} 登录会话已清除，请重新登录并抓取 Cookie 与 User-Agent`);
}

function requestHeader(name) {
  const headers = $request.headers || {};
  if (Array.isArray(headers)) {
    return headers.find(item => String(item.field).toLowerCase() === name.toLowerCase())?.value || "";
  }
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
  let cookie = normalizeCookie(requestHeader("Cookie"));
  const userAgent = String(requestHeader("User-Agent") || "").trim();
  if (!cookie || !userAgent) {
    $done({});
    return;
  }
  try { cookie = mergeSetCookies(cookie, $response.headers, hostFromBase(url)); }
  catch (error) {
    $notification.post("GLaDOS CK 获取失败", "登录会话无效", error.message);
    $done({});
    return;
  }
  if (!hasSessionCookie(cookie)) {
    $notification.post("GLaDOS CK 获取失败", "登录会话不完整", "登录会话已清除，请重新登录并刷新控制台后重试");
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
    .map((s, cookieIndex) => ({ cookie: s.trim(), cookieIndex }))
    .filter(entry => entry.cookie);

  if (emailsBulk.length || cookiesBulk.length) {
    if (!emailsBulk.length || emailsBulk.length !== cookiesBulk.length) {
      throw new Error("批量账号 GLADOS_EMAILS 与 GLADOS_COOKIES 数量不一致，请检查配置");
    }
    return emailsBulk.map((e, i) => ({ email: e, ...cookiesBulk[i], userAgent: userAgentFor(i + 1), userAgentIndex: i + 1, cookieKey: "GLADOS_COOKIES" }));
  }

  const acc = [];
  for (let i = 1; i <= 20; i++) {
    const e = Store.read(`GLADOS_EMAIL_${i}`);
    const c = Store.read(`GLADOS_COOKIE_${i}`);
    if (!c) break;
    acc.push({ email: e || "", cookie: c, userAgent: userAgentFor(i), userAgentIndex: i, cookieKey: `GLADOS_COOKIE_${i}` });
  }
  if (acc.length) return acc;
  const single = Store.read("GLADOS_COOKIE");
  return single ? [{ email: Store.read("GLADOS_EMAIL") || "", cookie: single, userAgent: userAgentFor(), cookieKey: "GLADOS_COOKIE" }] : [];
}

function storedCookieFor(account) {
  const raw = String(Store.read(account.cookieKey) || "");
  if (!Number.isInteger(account.cookieIndex)) return raw;
  return raw.split(",")[account.cookieIndex]?.trim() || "";
}

function persistCookie(account, cookie, apiBase) {
  const current = storedCookieFor(account);
  const currentBase = apiBases().map(base => String(base).replace(/\/+$/, ""));
  const currentAgent = userAgentFor(account.userAgentIndex);
  if (sameCookie(current, cookie)) {
    if (currentAgent !== account.userAgent || !currentBase.includes(apiBase)) {
      throw new Error("Cookie 保存失败：会话已被更新，设备或域名也已变化，请保留最新会话");
    }
    return { ...account, cookie };
  }
  if (!sameCookie(current, account.cookie) || currentAgent !== account.userAgent || !currentBase.includes(apiBase)) {
    throw new Error("Cookie 保存失败：会话已被更新，请保留最新会话");
  }
  let value = cookie;
  if (Number.isInteger(account.cookieIndex)) {
    const entries = String(Store.read(account.cookieKey) || "").split(",").map(item => item.trim());
    if (entries.length <= account.cookieIndex) throw new Error("Cookie 保存失败：批量账号存储已变化");
    entries[account.cookieIndex] = cookie;
    value = entries.join(",");
  }
  if (!Store.write(value, account.cookieKey)) throw new Error("Cookie 保存失败：持久化存储拒绝写入");
  return { ...account, cookie };
}

function parseResponse(response, label) {
  if (String(response.status) !== "200") {
    throw new Error(`${label} HTTP ${response.status}: ${String(response.body || "").slice(0, 150)}`);
  }
  let result;
  try {
    result = JSON.parse(response.body || "{}");
  } catch (e) {
    throw new Error(`${label} JSON 解析失败: ${String(response.body || "").slice(0, 150)}`);
  }
  if (result?.code === -2) throw new Error(sessionExpiredMessage(label, result.message || "code -2"));
  return result;
}

function sessionExpiredMessage(label, detail) {
  const suffix = detail ? `（${String(detail).slice(0, 120)}）` : "";
  return `${label} 登录会话已失效${suffix}，请在当前设备重新登录并抓取 Cookie 与 User-Agent`;
}

function isSessionRejected(result) {
  return result?.code === -2 || /没有权限|invalid\s+(?:cookie|session)/i.test(String(result?.message || ""));
}

function checkinMessage(result) {
  if (result?.code === 0) return translateMessage(result.message, result.points);
  if (isSessionRejected(result)) throw new Error(sessionExpiredMessage("签到", result.message));
  if (result?.code === 1 && /Checkin Repeats|Today's observation logged/i.test(result.message || "")) {
    return "重复签到，今日已完成，请明天再试";
  }
  if (result?.code === 4 && result.reason === "device-mismatch") {
    throw new Error(`设备不一致（登录: ${result.loginDevice || "未知"}，当前: ${result.currentDevice || "未知"}），请在当前设备重新登录并抓取 Cookie 与 User-Agent`);
  }
  throw new Error(`签到失败 (code ${result?.code ?? "未知"}): ${result?.message || "未知签到结果"}`);
}

async function pointsMessage(apiBase, hdrs, account) {
  try {
    const response = await http("get", { url: `${apiBase}/api/user/points`, headers: hdrs });
    const nextHeaders = headersAfterResponse(hdrs, response, apiBase);
    requireSessionCookie(nextHeaders.Cookie, "Points");
    const result = parseResponse(response, "Points");
    if (isSessionRejected(result)) throw new Error(sessionExpiredMessage("Points", result.message));
    if (result?.code !== 0) throw new Error(`积分接口拒绝请求 (code ${result?.code ?? "未知"}): ${result?.message || "未知错误"}`);
    persistCookie(account, nextHeaders.Cookie, apiBase);
    const raw = typeof result.points === "number" || typeof result.points === "string" ? String(result.points).trim() : "";
    if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error("积分余额无效");
    const [integer, decimals = ""] = raw.split(".");
    const balance = Number(integer);
    if (!Number.isSafeInteger(balance)) throw new Error("积分余额无效");
    const fraction = decimals.replace(/0+$/, "");
    const balanceText = `${balance}${fraction ? `.${fraction}` : ""}`;
    const plans = result.plans && typeof result.plans === "object" && !Array.isArray(result.plans) ? Object.values(result.plans) : [];
    if (!plans.length || plans.some(plan => !plan || !Number.isSafeInteger(plan.points) || plan.points <= 0 || !Number.isSafeInteger(plan.days) || plan.days <= 0)) {
      throw new Error("兑换档位无效");
    }
    // 余额的小数按十进制求差，避免接近兑换门槛时被浮点舍入成可兑换。
    const complement = fraction.split("").map((digit, index) => (index === fraction.length - 1 ? 10 : 9) - Number(digit)).join("");
    const progress = plans.sort((a, b) => a.points - b.points).map(plan => {
      const gap = fraction ? `${plan.points - balance - 1}.${complement}` : String(plan.points - balance);
      return `${plan.points} 分 → ${plan.days} 天：${balance >= plan.points ? "✅ 可兑换" : `还差 ${gap} 分`}`;
    });
    return [`当前积分: ${balanceText}`, ...progress].join("\n");
  } catch (e) {
    return `积分查询失败: ${e.message || String(e)}`;
  }
}

function accountMessage(result) {
  const icon = !result.ok ? "❌" : result.repeated ? "🟡" : "✅";
  const lines = [`${icon} ${result.email}`, result.message];
  if (result.ok) lines.push(`剩余时长: ${result.leftDays} 天`, result.pointsMessage);
  return lines.join("\n");
}

async function signOnce(account) {
  const { email, userAgent } = account;
  const cookie = normalizeCookie(account.cookie);
  let lastErr = "";
  for (const base of apiBases()) {
    const apiBase = String(base || "").replace(/\/+$/, "");
    try {
      let hdrs = headers(cookie, apiBase, userAgent);
      const token = hostFromBase(apiBase);
      const r1 = await http("post", { url: `${apiBase}/api/user/checkin`, body: JSON.stringify({ token }), headers: hdrs });
      hdrs = headersAfterResponse(hdrs, r1, apiBase);
      requireSessionCookie(hdrs.Cookie, "Checkin");
      const j1 = parseResponse(r1, "Checkin");
      const msg = checkinMessage(j1);
      const r2 = await http("get", { url: `${apiBase}/api/user/status`, headers: hdrs });
      hdrs = headersAfterResponse(hdrs, r2, apiBase);
      requireSessionCookie(hdrs.Cookie, "Status");
      const j2 = parseResponse(r2, "Status");
      if (isSessionRejected(j2)) throw new Error(sessionExpiredMessage("Status", j2.message));
      if (j2?.code !== 0 || typeof j2.data?.email !== "string" || !j2.data.email.trim()) {
        throw new Error(`Status 失败 (code ${j2?.code ?? "未知"}): ${j2?.message || "缺少账号状态"}`);
      }
      const savedAccount = persistCookie(account, hdrs.Cookie, apiBase);
      const leftDaysRaw = j2.data.leftDays;
      const left = typeof leftDaysRaw === "number" ? String(leftDaysRaw) : String(leftDaysRaw || "未知");
      const points = await pointsMessage(apiBase, hdrs, savedAccount);
      return { ok: true, repeated: j1.code === 1, email: email || j2.data.email || "(未提供邮箱)", message: msg, leftDays: left, apiBase, pointsMessage: points };
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

  for (const account of accounts) {
    await sleep(Math.floor(Math.random() * 2000));
    results.push(await signOnce(account));
  }

  const success = results.filter((r) => r.ok && !r.repeated).length;
  const repeats = results.filter((r) => r.ok && r.repeated).length;
  const failed = results.filter((r) => !r.ok).length;

  const lines = results.map(accountMessage);

  const title = `GLaDOS 签到（${nowStr()}）`;
  const subtitle = `成功 ${success}，重复 ${repeats}，失败 ${failed}`;

  $notification.post(title, subtitle, lines.join("\n\n"));

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
