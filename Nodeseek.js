/*
 NodeSeek 签到（Surge 版）
 - 支持多账号：NODESEEK_COOKIE 用 & 分隔多个 Cookie
 - 支持随机延迟：RANDOM_SIGNIN=true，MAX_RANDOM_DELAY=秒（默认3600=1小时）
 - 支持查询近 N 天签到收益统计：STATS_DAYS（默认30）
 - 支持 ns_random 参数：NS_RANDOM=true/false（默认 true）
 - 结果通过日志 + 通知输出
 使用：
  [Script]
  NodeSeek-签到 = type=cron,cronexp=23 14 * * *,wake-system=1,timeout=600,script-path=YOUR_PATH/nodeseek.js,argument=NODESEEK_COOKIE=ck1&ck2&RANDOM_SIGNIN=true&MAX_RANDOM_DELAY=3600&STATS_DAYS=30&NS_RANDOM=true

  也可把参数写入持久化存储：
  - $persistentStore.write("cookie1&cookie2","NODESEEK_COOKIE")
  - $persistentStore.write("true","RANDOM_SIGNIN")
  - $persistentStore.write("3600","MAX_RANDOM_DELAY")
  - $persistentStore.write("30","STATS_DAYS")
  - $persistentStore.write("true","NS_RANDOM")
*/

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0";

const log = (...args) => console.log("[NodeSeek]", ...args);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 解析 $argument：key=v&key2=v2&...  -> {key:val}
function parseArgument(str) {
  if (!str) return {};
  return Object.fromEntries(
    String(str).split("&").filter(Boolean).map(kv => {
      const pos = kv.indexOf("=");
      if (pos === -1) return [decodeURIComponent(kv), ""];
      return [decodeURIComponent(kv.slice(0,pos)), decodeURIComponent(kv.slice(pos+1))];
    })
  );
}

const arg = parseArgument($argument);

// 优先 $argument，其次 $persistentStore
function readConf(key, defVal = "") {
  if (key in arg && arg[key] !== "") return arg[key];
  const v = $persistentStore.read(key);
  return (v !== null && v !== undefined && v !== "") ? v : defVal;
}

// ===== 配置项 =====
const NS_RANDOM = (String(readConf("NS_RANDOM", "true")).toLowerCase() === "true");
const RANDOM_SIGNIN = (String(readConf("RANDOM_SIGNIN", "true")).toLowerCase() === "true");
const MAX_RANDOM_DELAY = parseInt(readConf("MAX_RANDOM_DELAY", "3600"), 10) || 0;   // 秒
const STATS_DAYS = Math.max(1, parseInt(readConf("STATS_DAYS", "30"), 10) || 30);
const rawCookies = readConf("NODESEEK_COOKIE", "").trim();
const cookieList = rawCookies.split("&").map(s => s.trim()).filter(Boolean);

async function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    $httpClient.get({ url, headers, timeout: 30 }, (err, resp, data) => {
      resolve({ err, resp, data });
    });
  });
}

async function httpPost(url, headers = {}, body = "") {
  return new Promise((resolve) => {
    $httpClient.post({ url, headers, body, timeout: 30 }, (err, resp, data) => {
      resolve({ err, resp, data });
    });
  });
}

// 签到
async function sign(cookie, ns_random) {
  if (!cookie) return { status: "invalid", msg: "无有效Cookie" };
  const headers = {
    "User-Agent": UA,
    "origin": "https://www.nodeseek.com",
    "referer": "https://www.nodeseek.com/board",
    "Content-Type": "application/json",
    "Cookie": cookie
  };
  const url = `https://www.nodeseek.com/api/attendance?random=${ns_random ? "true" : "false"}`;
  try {
    const { err, data } = await httpPost(url, headers, "");
    if (err) return { status: "error", msg: String(err) };
    const j = JSON.parse(data || "{}");
    const msg = j.message || "";
    if (msg.includes("鸡腿") || j.success) return { status: "success", msg };
    if (msg.includes("已完成签到")) return { status: "already", msg };
    if (j.status === 404) return { status: "invalid", msg };
    return { status: "fail", msg: msg || "未知错误" };
  } catch (e) {
    return { status: "error", msg: String(e) };
  }
}

// 查询近 N 天签到收益
async function getSigninStats(cookie, days = 30) {
  if (!cookie) return { ok: false, msg: "无有效Cookie" };
  if (days <= 0) days = 1;

  const headers = {
    "User-Agent": UA,
    "origin": "https://www.nodeseek.com",
    "referer": "https://www.nodeseek.com/board",
    "Cookie": cookie
  };

  try {
    // 以上海时区统计（UTC+8）
    const now = Date.now();
    const queryStart = now - days * 24 * 3600 * 1000; // UTC 时间点；比较时统一到 UTC，再加8小时等价

    let all = [];
    for (let page = 1; page <= 10; page++) {
      const url = `https://www.nodeseek.com/api/account/credit/page-${page}`;
      const { err, data } = await httpGet(url, headers);
      if (err) break;
      const j = JSON.parse(data || "{}");
      if (!j.success || !j.data || !Array.isArray(j.data) || j.data.length === 0) break;

      const records = j.data;
      // 记录格式: [amount, balance, description, timestampISO]
      const last = records[records.length - 1];
      const lastTimeUTC = Date.parse(last[3]); // 毫秒（UTC）
      const lastTimeShanghai = lastTimeUTC + 8 * 3600 * 1000;

      if (lastTimeShanghai < queryStart) {
        for (const r of records) {
          const tUTC = Date.parse(r[3]);
          const tShanghai = tUTC + 8 * 3600 * 1000;
          if (tShanghai >= queryStart) all.push(r);
        }
        break;
      } else {
        all = all.concat(records);
      }

      await sleep(500);
    }

    // 筛选近 N 天内 且 描述包含“签到收益”、“鸡腿”
    const signin = [];
    for (const r of all) {
      const [amount, , description, ts] = r;
      const tUTC = Date.parse(ts);
      const tShanghai = tUTC + 8 * 3600 * 1000;
      if (tShanghai >= queryStart && description && description.includes("签到收益") && description.includes("鸡腿")) {
        const d = new Date(tShanghai);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(d.getUTCDate()).padStart(2, "0");
        signin.push({ amount, date: `${y}-${m}-${dd}`, description });
      }
    }

    const period = days === 1 ? "今天" : `近${days}天`;
    if (signin.length === 0) {
      return {
        ok: true,
        msg: `查询成功，但没有找到${period}的签到记录`,
        stats: { total_amount: 0, average: 0, days_count: 0, records: [], period }
      };
    }

    const total = signin.reduce((s, r) => s + Number(r.amount || 0), 0);
    const count = signin.length;
    const avg = count > 0 ? Math.round((total / count) * 100) / 100 : 0;

    return {
      ok: true,
      msg: "查询成功",
      stats: { total_amount: total, average: avg, days_count: count, records: signin, period }
    };
  } catch (e) {
    return { ok: false, msg: `查询异常: ${e}` };
  }
}

function fmtRemain(sec) {
  if (sec <= 0) return "立即执行";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

async function main() {
  log(`共发现 ${cookieList.length} 个Cookie`);
  if (cookieList.length === 0) {
    log("未找到任何Cookie，请通过 argument 或 $persistentStore 设置 NODESEEK_COOKIE");
    $notification.post("NodeSeek 签到", "配置错误", "未找到 Cookie");
    $done();
    return;
  }

  log(`随机签到: ${RANDOM_SIGNIN ? "启用" : "禁用"}`);
  if (RANDOM_SIGNIN) log(`随机签到时间窗口: ${Math.floor(MAX_RANDOM_DELAY / 60)} 分钟`);

  // 生成执行计划
  const now = Date.now();
  const plan = cookieList.map((ck, i) => {
    const delay = RANDOM_SIGNIN ? Math.floor(Math.random() * (MAX_RANDOM_DELAY + 1)) : 0;
    return {
      idx: i + 1,
      user: `账号${i + 1}`,
      cookie: ck,
      delay,
      runAt: new Date(now + delay * 1000)
    };
  }).sort((a, b) => a.delay - b.delay);

  if (RANDOM_SIGNIN) {
    log("==== 生成签到时间表 ====");
    for (const p of plan) {
      const hh = String(p.runAt.getHours()).padStart(2, "0");
      const mm = String(p.runAt.getMinutes()).padStart(2, "0");
      const ss = String(p.runAt.getSeconds()).padStart(2, "0");
      log(`${p.user}: 延迟 ${fmtRemain(p.delay)} 后签到 (预计 ${hh}:${mm}:${ss})`);
    }
    log("==== 签到执行顺序 ====");
    log(plan.map(p => `${p.user}`).join(" -> "));
  }

  log("==== 开始执行签到任务 ====");

  for (const p of plan) {
    if (p.delay > 0) {
      // 倒计时：每10秒提示一次，最后10秒逐秒
      let remain = p.delay;
      log(`${p.user} 需要等待 ${fmtRemain(remain)}`);
      while (remain > 0) {
        const step = remain <= 10 ? 1 : Math.min(10, remain);
        await sleep(step * 1000);
        remain -= step;
        if (remain <= 10 || remain % 10 === 0) {
          log(`${p.user} 倒计时: ${fmtRemain(remain)}`);
        }
      }
    }

    log(`==== ${p.user} 开始签到 ====`);
    const nowStr = new Date().toTimeString().split(" ")[0];
    log(`当前时间: ${nowStr}`);

    // 签到
    const ret = await sign(p.cookie, NS_RANDOM);
    if (ret.status === "success" || ret.status === "already") {
      log(`${p.user} 签到成功: ${ret.msg || ""}`);

      // 查询统计
      log("正在查询签到收益统计...");
      const statsRes = await getSigninStats(p.cookie, STATS_DAYS);
      if (statsRes.ok && statsRes.stats) {
        const s = statsRes.stats;
        log(`\n==== ${p.user} 签到收益统计 (${s.period}) ====`);
        log(`签到天数: ${s.days_count} 天`);
        log(`总获得鸡腿: ${s.total_amount} 个`);
        log(`平均每日鸡腿: ${s.average} 个`);
        $notification.post(
          "NodeSeek 签到",
          `${p.user} 签到成功`,
          `${ret.msg}\n${s.period}已签到${s.days_count}天，共获${s.total_amount}个鸡腿，平均${s.average}个/天`
        );
      } else {
        log(`统计查询失败: ${statsRes.msg}`);
        $notification.post("NodeSeek 签到", `${p.user} 成功但统计失败`, statsRes.msg || "");
      }
    } else {
      log(`${p.user} 签到失败: ${ret.msg}`);
      $notification.post("NodeSeek 签到失败", p.user, ret.msg || "未知原因");
    }
  }

  log("==== 所有账号签到完成 ====");
  const end = new Date();
  const ts = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,"0")}-${String(end.getDate()).padStart(2,"0")} ${String(end.getHours()).padStart(2,"0")}:${String(end.getMinutes()).padStart(2,"0")}:${String(end.getSeconds()).padStart(2,"0")}`;
  log(`完成时间: ${ts}`);
  $done();
}

main();