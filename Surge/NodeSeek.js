/*
 NodeSeek 一体化脚本 (Surge) —— 单账号版（修正版：适配 refract-* 头）
 - 仍保留原来的 HTTP-Request 抓 CK + Cron 签到/统计
 - 新增：
    1) 自动拉取/刷新 refract-key（GET /edge-cgi/ping 取响应头 refract-key-update）
    2) 为所有 API 请求补齐 refract-key / refract-version / refract-sign
       refract-sign = SHA1( method + "\n\n" + url(no hash) + "\n\n" + UA + "\n\n" + bodyText + "\n\n" + refractKey )

  可配置（持久化存储）：
   NODESEEK_REFRACT_VERSION  默认 0.3.33（来自抓包）
   NODESEEK_REFRACT_AUTO_PING=true/false 默认 true（每次运行先 ping 一次刷新 refract-key）
   NODESEEK_UA               自定义 UA（不填用默认）
*/

const $prefs = {
  read: (k) => $persistentStore.read(k),
  write: (v, k) => $persistentStore.write(v, k),
};

// ========== HTTP-REQUEST：获取 Cookie（可见，无频率限制） ==========
if (typeof $request !== "undefined") {
  try {
    const raw = $request.headers?.Cookie || $request.headers?.cookie || "";
    if (raw) {
      const KEY = "NODESEEK_COOKIE";
      const trimmed = String(raw).trim();
      const old = $prefs.read(KEY) || "";
      if (trimmed !== old) {
        $prefs.write(trimmed, KEY);
        $notification.post("NodeSeek", "✅ 获取Cookie成功（已保存/更新）", trimmed);
      } else {
        $notification.post("NodeSeek", "ℹ️ Cookie 未变化（已存在）", trimmed);
      }
      console.log("Captured Cookie:", trimmed);
    } else {
      $notification.post("NodeSeek", "❌ 无 Cookie", "本次请求未携带 Cookie");
      console.log("No Cookie header.");
    }
  } catch (e) {
    console.log("GetCookie error:", String(e));
  }
  $done({});
}

// ========== 配置读取 ==========
function readConf(key, defVal = "") {
  const v = $prefs.read(key);
  return v !== null && v !== undefined && v !== "" ? v : defVal;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const UA = readConf("NODESEEK_UA", DEFAULT_UA);

const ONLY_SIGNIN = String(readConf("ONLY_SIGNIN", "false")).toLowerCase() === "true";
const NS_RANDOM = String(readConf("NS_RANDOM", "true")).toLowerCase() === "true";
const RANDOM_SIGNIN = String(readConf("RANDOM_SIGNIN", "true")).toLowerCase() === "true";
const MAX_RANDOM_DELAY = parseInt(readConf("MAX_RANDOM_DELAY", "3600"), 10) || 0;
const STATS_DAYS = Math.max(1, parseInt(readConf("STATS_DAYS", "30"), 10) || 30);
const MANUAL_NO_DELAY = String(readConf("MANUAL_NO_DELAY", "true")).toLowerCase() === "true";

const REFRACT_VERSION = readConf("NODESEEK_REFRACT_VERSION", "0.3.33");
const REFRACT_AUTO_PING = String(readConf("NODESEEK_REFRACT_AUTO_PING", "true")).toLowerCase() === "true";

const cookie = (readConf("NODESEEK_COOKIE", "") || "").trim();
if (!cookie) {
  $notification.post("NodeSeek 签到", "❌ 未找到Cookie", "请先访问网站以获取 Cookie");
  $done();
}

// ========== 工具 ==========
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getHeader(resp, name) {
  if (!resp || !resp.headers) return "";
  const keys = Object.keys(resp.headers);
  const hit = keys.find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? resp.headers[hit] : "";
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    $httpClient.get({ url, headers, timeout: 30 }, (err, resp, data) => resolve({ err, resp, data }));
  });
}

function httpPost(url, headers = {}, body = "") {
  return new Promise((resolve) => {
    $httpClient.post({ url, headers, body, timeout: 30 }, (err, resp, data) => resolve({ err, resp, data }));
  });
}

// ========== SHA-1（纯 JS，避免依赖） ==========
function sha1Hex(msg) {
  // UTF-8 encode
  const utf8 = unescape(encodeURIComponent(msg));
  const words = [];
  for (let i = 0; i < utf8.length; i++) {
    words[i >> 2] |= utf8.charCodeAt(i) << (24 - (i % 4) * 8);
  }
  const bitLen = utf8.length * 8;
  words[bitLen >> 5] |= 0x80 << (24 - bitLen % 32);
  words[((bitLen + 64 >> 9) << 4) + 15] = bitLen;

  function rol(n, c) {
    return (n << c) | (n >>> (32 - c));
  }
  function toHex(n) {
    let s = "";
    for (let i = 7; i >= 0; i--) s += ((n >>> (i * 4)) & 0x0f).toString(16);
    return s;
  }

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array(80);
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[i + t] | 0;
    for (let t = 16; t < 80; t++) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);

    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;

    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rol(a, 5) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = (rol(b, 30) | 0);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

// ========== refract 头生成 ==========
function normalizeUrlNoHash(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch (_e) {
    const i = String(url).indexOf("#");
    return i >= 0 ? String(url).slice(0, i) : String(url);
  }
}

function computeRefractSign(method, url, ua, bodyText, refractKey) {
  const s = [method, normalizeUrlNoHash(url), ua || "", bodyText || "", refractKey || ""].join("\n\n");
  return sha1Hex(s);
}

async function refreshRefractKey() {
  const pingUrl = "https://www.nodeseek.com/edge-cgi/ping";
  const headers = {
    Accept: "*/*",
    "User-Agent": UA,
    Referer: `https://www.nodeseek.com/sw.js?v=${REFRACT_VERSION}`,
    Cookie: cookie || "sortBy=postTime",
  };
  const { err, resp } = await httpGet(pingUrl, headers);
  if (err) return false;
  const k = getHeader(resp, "refract-key-update");
  if (k) {
    $prefs.write(k, "NODESEEK_REFRACT_KEY");
    return true;
  }
  return false;
}

function getRefractKey() {
  return (readConf("NODESEEK_REFRACT_KEY", "") || "").trim();
}

async function ensureRefractKey() {
  if (!REFRACT_AUTO_PING) return getRefractKey();
  await refreshRefractKey();
  return getRefractKey();
}

async function refractRequest(method, url, extraHeaders = {}, bodyText = "") {
  const refractKey = await ensureRefractKey();
  const sign = computeRefractSign(method, url, UA, bodyText, refractKey);

  const headers = Object.assign(
    {
      Accept: "*/*",
      "User-Agent": UA,
      Origin: "https://www.nodeseek.com",
      Referer: `https://www.nodeseek.com/sw.js?v=${REFRACT_VERSION}`,
      Cookie: cookie,
      "refract-version": REFRACT_VERSION,
      "refract-key": refractKey,
      "refract-sign": sign,
    },
    extraHeaders
  );

  if (method === "GET") return httpGet(url, headers);
  return httpPost(url, headers, bodyText);
}

// ========== 签到 ==========
async function doSign() {
  const url = `https://www.nodeseek.com/api/attendance?random=${NS_RANDOM ? "true" : "false"}`;
  const body = ""; // 抓包里是空 body
  const headers = {
    "Content-Type": "text/plain;charset=UTF-8",
  };

  try {
    const { err, resp, data } = await refractRequest("POST", url, headers, body);
    if (err) return { status: "error", msg: String(err) };

    // 非 JSON 保护：被验证或未登录会返回 HTML（以 "<" 开头）
    if (!data || typeof data !== "string" || data.trim().charAt(0) !== "{") {
      const code = resp && (resp.status || resp.statusCode) ? `HTTP ${resp.status || resp.statusCode}` : "";
      return { status: "error", msg: `返回非 JSON，可能 CK 失效/需人机验证 ${code}` };
    }

    const j = JSON.parse(data || "{}");
    const msg = j.message || "";
    if (j.success || msg.includes("鸡腿")) return { status: "success", msg };
    if (msg.includes("已完成签到")) return { status: "already", msg };
    if (j.status === 404) return { status: "invalid", msg };
    return { status: "fail", msg: msg || "未知错误" };
  } catch (e) {
    return { status: "error", msg: String(e) };
  }
}

// ========== 统计（可选） ==========
async function getStats(days = 30) {
  const now = Date.now();
  const queryStart = now - days * 24 * 3600 * 1000;

  let all = [];
  for (let p = 1; p <= 10; p++) {
    const url = `https://www.nodeseek.com/api/account/credit/page-${p}`;
    const { err, data } = await refractRequest("GET", url, {}, "");
    if (err) break;
    if (!data || typeof data !== "string" || data.trim().charAt(0) !== "{") break;

    const j = JSON.parse(data || "{}");
    if (!j.success || !Array.isArray(j.data) || j.data.length === 0) break;
    all = all.concat(j.data);
    await sleep(250);
  }

  const signin = all.filter((r) => {
    const desc = r && r[2];
    const ts = r && r[3];
    const t = Date.parse(ts || "") + 8 * 3600 * 1000; // UTC+8
    return t >= queryStart && desc && desc.includes("签到收益") && desc.includes("鸡腿");
  });

  const total = signin.reduce((s, r) => s + Number((r && r[0]) || 0), 0);
  const count = signin.length;
  const avg = count ? Math.round((total / count) * 100) / 100 : 0;
  return { total, count, avg, period: days === 1 ? "今天" : `近${days}天` };
}

// ========== 主流程（Cron，非阻塞随机延迟，单账号） ==========
(async () => {
  const NEXT_KEY = "NODESEEK_NEXT_TS";
  const now = Date.now();
  let nextTs = parseInt($prefs.read(NEXT_KEY) || "0", 10);

  // 原脚本逻辑保留：如果你想让 Cron 随机延迟生效，把 MANUAL_NO_DELAY 设为 false
  if (RANDOM_SIGNIN && MAX_RANDOM_DELAY > 0) {
    if (!MANUAL_NO_DELAY) {
      if (!nextTs || now > nextTs + 24 * 3600 * 1000) {
        nextTs = now + Math.floor(Math.random() * (MAX_RANDOM_DELAY + 1)) * 1000;
        $prefs.write(String(nextTs), NEXT_KEY);
        console.log("已设置随机延迟，计划时间:", new Date(nextTs).toLocaleString());
        $notification.post("NodeSeek", "⏳ 已设置随机延迟", "计划执行时间：" + new Date(nextTs).toLocaleString());
        return $done();
      } else if (now < nextTs) {
        console.log("未到计划时间，跳过。本次不阻塞。计划时间:", new Date(nextTs).toLocaleString());
        return $done();
      } else {
        $prefs.write("", NEXT_KEY);
      }
    }
  }

  const ret = await doSign();
  if (ret.status === "success" || ret.status === "already") {
    if (ONLY_SIGNIN) {
      $notification.post("NodeSeek 签到 ✅", "账号1", ret.msg || "OK");
    } else {
      const s = await getStats(STATS_DAYS);
      $notification.post(
        "NodeSeek 签到 ✅",
        "账号1",
        (ret.msg || "OK") + "\n" + (s.period + "已签到" + s.count + "天，共" + s.total + "个鸡腿，平均" + s.avg + "/天")
      );
    }
  } else {
    $notification.post("NodeSeek 签到 ❌", "账号1", ret.msg || "未知原因");
  }

  console.log("==== 签到完成 ====");
  $done();
})();