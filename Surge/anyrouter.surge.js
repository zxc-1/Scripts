/**
 * AnyRouter 自动签到 + 会话获取（Surge 一体版）
 * 登录并打开个人设置后，验证 /api/user/self 的响应再保存账号。
 * ANYROUTER_ACCOUNTS：一个 JSON 记录，按已验证的用户 ID 保存 session 与原始 UA。
 * Telegram（可选）：TG_BOT_TOKEN / TG_CHAT_ID。使用 Surge iOS 5.9+ / Mac 5.5+。
 */

const BASE = "https://anyrouter.top";
const ACCOUNTS_KEY = "ANYROUTER_ACCOUNTS";
const MAX_ACCOUNTS = 10;
const REQUEST_TIMEOUT = 4;
const RUN_BUDGET_MS = 45000;
const WAF_MASK = "3000176000856006061501533003690027800375";
const WAF_PERMUTATION = [
  15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23,
  25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17,
  5, 3, 28, 34, 37, 12, 36,
];
const secrets = [];

function redact(value) {
  let text = String(value || "");
  for (const secret of secrets) {
    if (!secret) continue;
    for (const variant of [secret, encodeURIComponent(secret)]) text = text.split(variant).join("[已隐藏]");
  }
  return text.replace(/session\s*=\s*[^;\s]+/gi, "session=[已隐藏]")
    .replace(/\b\d+:[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
}

function notify(title, subtitle, body) {
  $notification.post(title, subtitle, redact(body));
}

function headerValues(headers, name) {
  const entries = Array.isArray(headers)
    ? headers.map(item => [item.field, item.value]) : Object.entries(headers || {});
  return entries.filter(([key]) => String(key).toLowerCase() === name.toLowerCase())
    .flatMap(([, value]) => Array.isArray(value) ? value.map(String) : [String(value ?? "")]);
}

function positiveId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSession(value) {
  return typeof value === "string" && /^[\x21-\x7e]+$/.test(value) && !/[;,"\\]/.test(value);
}

function validUserAgent(value) {
  return typeof value === "string" && !!value.trim() && !/[\r\n\x00]/.test(value);
}

function sessionFromHeaders(headers) {
  const values = headerValues(headers, "Cookie");
  const matches = [];
  for (const header of values) {
    if (/[\r\n]/.test(header)) return "";
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (part.slice(0, index).trim() === "session" && index > 0) matches.push(part.slice(index + 1).trim());
    }
  }
  return matches.length === 1 && validSession(matches[0]) ? matches[0] : "";
}

function readAccounts() {
  const raw = $persistentStore.read(ACCOUNTS_KEY);
  if (!raw) return [];
  let record;
  try { record = JSON.parse(raw); }
  catch (error) { throw new Error("账号存储不是有效 JSON，请检查 ANYROUTER_ACCOUNTS"); }
  if (record?.version !== 1 || !Array.isArray(record.accounts) || record.accounts.length > MAX_ACCOUNTS) {
    throw new Error("账号存储版本或数量无效，请检查 ANYROUTER_ACCOUNTS");
  }
  const seen = new Set();
  for (const account of record.accounts) {
    if (!account || !positiveId(account.id) || !validSession(account.session) || !validUserAgent(account.userAgent) || seen.has(account.id)) {
      throw new Error("账号存储包含无效或重复账号，请检查 ANYROUTER_ACCOUNTS");
    }
    seen.add(account.id);
  }
  return record.accounts;
}

function capture() {
  if (!/^https:\/\/anyrouter\.top\/api\/user\/self(?:\?.*)?$/i.test($request.url || "") ||
      String($request.method || "").toUpperCase() !== "GET" || typeof $response === "undefined") return;
  let result;
  try {
    if (Number($response.status ?? $response.statusCode) !== 200) return;
    result = JSON.parse($response.body);
  } catch (error) { return; }
  const id = result?.data?.id;
  const headerId = headerValues($request.headers, "New-API-User");
  const agents = headerValues($request.headers, "User-Agent");
  const session = sessionFromHeaders($request.headers);
  if (result?.success !== true || !positiveId(id) || headerId.length !== 1 || headerId[0].trim() !== String(id) ||
      agents.length !== 1 || !validUserAgent(agents[0]) || !session) return;
  const userAgent = agents[0].trim();
  const accounts = readAccounts();
  const index = accounts.findIndex(account => account.id === id);
  if (index >= 0 && accounts[index].session === session && accounts[index].userAgent === userAgent) return;
  const account = { id, session, userAgent };
  if (index >= 0) accounts[index] = account;
  else {
    if (accounts.length >= MAX_ACCOUNTS) throw new Error(`账号存储最多支持 ${MAX_ACCOUNTS} 个账号，请先移除停用账号`);
    accounts.push(account);
  }
  try {
    if (!$persistentStore.write(JSON.stringify({ version: 1, accounts }), ACCOUNTS_KEY)) throw new Error("write failed");
  } catch (error) {
    notify("AnyRouter CK 获取失败", "保存失败", "原会话已保留，请检查持久化存储后重试");
    return;
  }
  notify("AnyRouter CK 获取成功", `账号 ${id}`, "已验证登录并保存 session、User-Agent 和用户 ID");
}

function http(method, url, headers, body, deadline = Infinity) {
  const timeout = Math.min(REQUEST_TIMEOUT, Math.floor((deadline - Date.now()) / 1000));
  if (timeout < 1) return Promise.reject(new Error("时间预算已用尽，本次请求未发送，请分批运行"));
  const options = {
    url, headers, timeout,
    "auto-cookie": false, "auto-redirect": false, "full-header-mode": true,
  };
  if (method === "POST") options.body = body ?? "";
  return new Promise((resolve, reject) => {
    $httpClient[method.toLowerCase()](options, (error, response, data) => {
      if (error) return reject(new Error("网络请求失败或超时，结果未确认"));
      resolve({ status: Number(response?.status ?? response?.statusCode), headers: response?.headers || {}, body: String(data || "") });
    });
  });
}

function parseResponse(response, label) {
  if (response.status !== 200) {
    if (response.status === 401) throw new Error(`${label} HTTP 401：登录已失效，请重新登录抓取`);
    throw new Error(`${label} HTTP ${response.status || "未知"}`);
  }
  try { return JSON.parse(response.body); }
  catch (error) { throw new Error(`${label} 返回不是 JSON，结果未确认`); }
}

function solveChallenge(body) {
  const arg = body.match(/\barg1\s*=\s*['"]([0-9a-f]{40})['"]/i)?.[1];
  const vector = body.match(/\bfor\s*\(\s*var\s+m\s*=\s*\[([^\]]+)\]/)?.[1];
  const positions = vector?.split(",").map(value => Number(value.trim()));
  if (!arg || !positions || positions.length !== WAF_PERMUTATION.length ||
      positions.some((value, index) => value !== WAF_PERMUTATION[index])) {
    throw new Error("动态验证格式已变化，请更新脚本");
  }
  // 只复现已验证的置换 + XOR 变换；不执行服务器下发的混淆 JavaScript。
  const shuffled = WAF_PERMUTATION.map(position => arg[position - 1]).join("");
  let cookie = "";
  for (let index = 0; index < 40; index += 2) {
    cookie += (parseInt(shuffled.slice(index, index + 2), 16) ^ parseInt(WAF_MASK.slice(index, index + 2), 16)).toString(16).padStart(2, "0");
  }
  return cookie;
}

function mergeCookies(jar, headers) {
  for (const header of headerValues(headers, "Set-Cookie")) {
    for (const cookie of header.split(/,(?=\s*[^;,=\s]+\s*=)/)) {
      const parts = cookie.split(";").map(part => part.trim());
      const index = parts[0].indexOf("=");
      if (index < 1) continue;
      const name = parts[0].slice(0, index), value = parts[0].slice(index + 1);
      if (!["session", "acw_tc", "cdn_sec_tc", "acw_sc__v2"].includes(name)) continue;
      const attribute = key => parts.slice(1).find(part => part.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
      const domain = attribute("domain");
      if (domain && domain.toLowerCase().replace(/^\./, "") !== "anyrouter.top") continue;
      const maxAge = attribute("max-age"), expires = attribute("expires");
      const expired = maxAge !== undefined ? Number(maxAge) <= 0 : expires && Date.parse(expires) <= Date.now();
      if (!value || expired) delete jar[name];
      else if (validSession(value)) jar[name] = value;
    }
  }
}

async function api(account, jar, method, path, deadline) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!validSession(jar.session)) throw new Error("服务端已清除登录 session，请重新登录抓取");
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": account.userAgent, "New-API-User": String(account.id),
      Cookie: Object.keys(jar).map(name => `${name}=${jar[name]}`).join("; "),
      "Cache-Control": "no-store", Referer: `${BASE}/console`,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers.Origin = BASE;
    }
    const response = await http(method, `${BASE}${path}`, headers, undefined, deadline);
    mergeCookies(jar, response.headers);
    const challenge = [200, 403].includes(response.status) && /<script\b/i.test(response.body) && response.body.includes("acw_sc__v2");
    if (!challenge) return response;
    if (attempt === 2) throw new Error("动态验证失败：重试已达上限");
    jar.acw_sc__v2 = solveChallenge(response.body);
  }
}

async function signAccount(account, deadline) {
  const jar = { session: account.session };
  const identity = parseResponse(await api(account, jar, "GET", "/api/user/self", deadline), "账号验证");
  if (identity?.success !== true || identity?.data?.id !== account.id) throw new Error("登录状态无效或用户 ID 不一致，请重新登录抓取");
  const result = parseResponse(await api(account, jar, "POST", "/api/user/sign_in", deadline), "签到");
  if (result?.success !== true) {
    const message = typeof result?.message === "string" ? `：${redact(result.message).slice(0, 180)}` : "";
    throw new Error(`签到未成功${message}`);
  }
  if (typeof result.message !== "string") throw new Error("签到响应缺少 message，结果未确认");
  const message = redact(result.message.trim()).slice(0, 180);
  if (!message || /今日已签到|已经签到|already.*(?:signed|check)/i.test(message)) return { kind: "repeat", message: message || "今日已签到" };
  return { kind: "success", message };
}

async function telegram(text) {
  const token = String($persistentStore.read("TG_BOT_TOKEN") || "").trim();
  const chatId = String($persistentStore.read("TG_CHAT_ID") || "").trim();
  if (token) secrets.push(token);
  if (!token && !chatId) return "";
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token) || !chatId) return "Telegram 配置不完整或 Token 格式无效";
  try {
    const response = await http("POST", `https://api.telegram.org/bot${token}/sendMessage`, {
      "Content-Type": "application/json",
    }, JSON.stringify({ chat_id: chatId, text: redact(text), disable_web_page_preview: true }));
    if (parseResponse(response, "Telegram")?.ok !== true) return "Telegram 推送失败：API 未确认成功";
    return "";
  } catch (error) { return "Telegram 推送失败：网络、HTTP 或 JSON 错误"; }
}

async function cron() {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const accounts = readAccounts();
  if (!accounts.length) throw new Error("没有已保存账号，请在 Surge 生效的设备上登录并打开个人设置");
  secrets.push(...accounts.map(account => account.session));
  const token = $persistentStore.read("TG_BOT_TOKEN");
  if (token) secrets.push(String(token).trim());
  // 按账号顺序执行，避免多账号同时触发动态验证或形成突发访问。
  const results = [];
  for (const account of accounts) {
    try { results.push({ id: account.id, ...await signAccount(account, deadline) }); }
    catch (error) { results.push({ id: account.id, kind: "failed", message: redact(error.message).slice(0, 180) }); }
  }
  const count = kind => results.filter(result => result.kind === kind).length;
  const summary = `成功 ${count("success")}，重复 ${count("repeat")}，失败 ${count("failed")}`;
  const text = results.map(result => `账号 ${result.id}：${result.message}`).join("\n");
  const tgError = await telegram(`AnyRouter 签到\n${summary}\n${text}`);
  notify("AnyRouter 自动签到", summary, `${text}${tgError ? `\n${tgError}` : ""}`);
}

(async () => {
  const capturing = typeof $request !== "undefined";
  try {
    if (capturing) capture();
    else await cron();
  } catch (error) {
    notify(capturing ? "AnyRouter CK 获取失败" : "AnyRouter 签到失败", "配置或存储错误", error.message);
  } finally {
    $done({});
  }
})();
