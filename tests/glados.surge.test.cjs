const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = process.env.GLADOS_SCRIPT || path.resolve(__dirname, '../Surge/glados.surge.js');
const modulePath = process.env.GLADOS_MODULE || path.resolve(__dirname, '../Surge/GLaDOS自动签到.sgmodule');
const source = fs.readFileSync(scriptPath, 'utf8');
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const COOKIE = 'gld:sess=test-session; gld:sess.sig=test-signature';
const storedSession = { GLADOS_COOKIE: COOKIE, GLADOS_USER_AGENT: MAC_UA, GLADOS_API_BASE: 'https://glados.network' };
const statusBody = { code: 0, data: { email: 'test@example.com', leftDays: 342 } };
const successBody = { code: 0, points: 10, message: 'Checkin! Got 10 Points', streak: 1, list: [] };
const repeatBody = { code: 1, points: 0, message: "Today's observation logged. Return tomorrow for more points.", streak: 1, list: [] };
const mismatchBody = { code: 4, reason: 'device-mismatch', points: 0, loginDevice: 'macOS', currentDevice: 'Windows', message: 'Automated check-in detected. Please sign in again to continue.', list: [] };

async function runScript(options = {}) {
  const values = { ...options.store };
  const requests = [];
  const writes = [];
  const notifications = [];
  let doneCalls = 0;
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const respond = (method, request, callback) => {
    requests.push({ method, ...request });
    const isCheckin = request.url.endsWith('/api/user/checkin');
    const reply = options.reply ? options.reply({ method, request, isCheckin }) : {
      status: 200,
      body: isCheckin ? successBody : statusBody,
    };
    queueMicrotask(() => callback(reply.error || null, { status: reply.status, headers: {} },
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)));
  };
  const context = {
    $persistentStore: { read: key => values[key] ?? null, write: (value, key) => { writes.push({ key, value }); if (options.failWriteKey === key) return false; values[key] = value; return true; } },
    $httpClient: { get: (request, cb) => respond('GET', request, cb), post: (request, cb) => respond('POST', request, cb) },
    $notification: { post: (...args) => notifications.push(args) },
    $done: () => { doneCalls++; finish(); },
    setTimeout: callback => { queueMicrotask(callback); return 0; },
    console,
  };
  if (options.request) context.$request = options.request;
  vm.runInNewContext(source, context, { filename: scriptPath, timeout: 1000 });
  await complete;
  assert.equal(doneCalls, 1, '$done must be called exactly once');
  return { values, requests, writes, notifications, text: notifications.flat().join('\n') };
}

test('capture preserves the actual login User-Agent alongside the cookie', async () => {
  const result = await runScript({ request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } } });
  assert.equal(result.values.GLADOS_COOKIE, COOKIE);
  assert.equal(result.values.GLADOS_USER_AGENT, MAC_UA);
  assert.equal(result.values.GLADOS_API_BASE, 'https://glados.network');
  assert.equal(result.requests.length, 0);
});

test('capture accepts HTTP header names regardless of case', async () => {
  const result = await runScript({ request: { url: 'https://glados.network/api/user/status', headers: { cOoKiE: COOKIE, 'uSeR-aGeNt': MAC_UA } } });
  assert.equal(result.values.GLADOS_COOKIE, COOKIE);
  assert.equal(result.values.GLADOS_USER_AGENT, MAC_UA);
});

test('an incomplete capture keeps the previous cookie and device paired', async () => {
  const result = await runScript({ store: storedSession, request: { url: 'https://glados.network/api/user/status', headers: { Cookie: 'new-session' } } });
  assert.equal(result.values.GLADOS_COOKIE, COOKIE);
  assert.equal(result.values.GLADOS_USER_AGENT, MAC_UA);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
});

test('cron reuses the captured device on both API calls', async () => {
  const result = await runScript({ store: storedSession });
  assert.equal(result.requests.length, 2);
  assert.deepEqual(result.requests.map(r => r.headers['User-Agent']), [MAC_UA, MAC_UA]);
  assert.deepEqual(JSON.parse(result.requests[0].body), { token: 'glados.network' });
  assert.match(result.text, /成功 1，重复 0，失败 0/);
  assert.match(result.text, /获得 10 积分/);
});

test('a missing device capture fails explicitly without sending a request', async () => {
  const result = await runScript({ store: { GLADOS_COOKIE: COOKIE } });
  assert.equal(result.requests.length, 0);
  assert.match(result.text, /User-Agent/);
  assert.match(result.text, /失败 1/);
});

test('the default API origin is the currently used network domain', async () => {
  const result = await runScript({ store: { GLADOS_COOKIE: COOKIE, GLADOS_USER_AGENT: MAC_UA } });
  assert.equal(result.requests[0].url, 'https://glados.network/api/user/checkin');
});

test('device-mismatch with zero points is a failure rather than a success', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin }) => ({ status: 200, body: isCheckin ? mismatchBody : statusBody }) });
  assert.match(result.text, /成功 0，重复 0，失败 1/);
  assert.doesNotMatch(result.text, /签到成功/);
  assert.match(result.text, /设备|device-mismatch/);
});

test('the current zero-point repeat response is classified as already checked in', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin }) => ({ status: 200, body: isCheckin ? repeatBody : statusBody }) });
  assert.match(result.text, /成功 0，重复 1，失败 0/);
  assert.doesNotMatch(result.text, /获得 0 积分/);
});

test('unknown business errors with numeric points are still failures', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin }) => ({ status: 200, body: isCheckin ? { code: 9, points: 0, message: 'Invalid token' } : statusBody }) });
  assert.match(result.text, /成功 0，重复 0，失败 1/);
  assert.match(result.text, /Invalid token/);
});

test('an expired session in the status API is never reported as successful', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin }) => ({ status: 200, body: isCheckin ? successBody : { code: 1, message: 'Invalid cookie' } }) });
  assert.match(result.text, /失败 1/);
  assert.match(result.text, /Invalid cookie/);
});

test('a real successful zero-point checkin still respects code zero', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin }) => ({ status: 200, body: isCheckin ? { ...successBody, points: 0 } : statusBody }) });
  assert.match(result.text, /成功 1，重复 0，失败 0/);
});

test('non-JSON and HTTP errors remain visible', async () => {
  for (const response of [{ status: 403, body: 'Forbidden' }, { status: 200, body: '<html>Challenge</html>' }]) {
    const result = await runScript({ store: storedSession, reply: () => response });
    assert.match(result.text, /失败 1/);
    assert.match(result.text, /HTTP 403|JSON 解析失败/);
  }
});

test('indexed accounts retain their individual login devices', async () => {
  const store = { GLADOS_API_BASE: 'https://glados.network', GLADOS_COOKIE_1: COOKIE, GLADOS_COOKIE_2: 'test-second-cookie', GLADOS_USER_AGENT_1: MAC_UA, GLADOS_USER_AGENT_2: WINDOWS_UA };
  const result = await runScript({ store });
  assert.deepEqual(result.requests.map(r => r.headers['User-Agent']), [MAC_UA, MAC_UA, WINDOWS_UA, WINDOWS_UA]);
  assert.match(result.text, /成功 2，重复 0，失败 0/);
});

test('bulk accounts can specify each device with the same indexed keys', async () => {
  const store = { GLADOS_API_BASE: 'https://glados.network', GLADOS_EMAILS: 'one@example.com,two@example.com', GLADOS_COOKIES: `${COOKIE},test-second-cookie`, GLADOS_USER_AGENT_1: MAC_UA, GLADOS_USER_AGENT_2: WINDOWS_UA };
  const result = await runScript({ store });
  assert.deepEqual(result.requests.map(r => r.headers['User-Agent']), [MAC_UA, MAC_UA, WINDOWS_UA, WINDOWS_UA]);
});

test('the Surge module captures the current API host and appends MITM hosts', () => {
  const module = fs.readFileSync(modulePath, 'utf8');
  const capture = module.split('\n').find(line => line.startsWith('GLaDOS_Capture'));
  const pattern = new RegExp(capture.match(/pattern=([^,]+)/)[1]);
  for (const host of ['glados.network', 'glados.cloud', 'glados.one']) {
    assert.equal(pattern.test(`https://${host}/api/user/status`), true, host);
    assert.equal(pattern.test(`https://${host}/api/user/checkin`), true, host);
  }
  assert.equal(pattern.test('https://glados.network.evil.test/api/user/status'), false);
  assert.match(module, /hostname\s*=\s*%APPEND%.*glados\.network/);
});

test('the module schedules its daily 09:10 cron using the documented Surge format', () => {
  const module = fs.readFileSync(modulePath, 'utf8');
  const cron = module.split('\n').find(line => /type=cron(?:,|$)/.test(line));
  assert.ok(cron, 'a named cron script must be registered');
  assert.match(cron, /cronexp="10 9 \* \* \*"/);
  assert.match(cron, /timeout=60/);
  assert.match(cron, /wake-system=true/);
});

test('revisiting status and checkin with the saved session is silent and writes nothing', async () => {
  const first = await runScript({ request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } } });
  assert.equal(first.notifications.length, 1);
  assert.equal(first.writes.length, 3);
  for (const endpoint of ['status', 'checkin', 'status']) {
    const next = await runScript({ store: first.values, request: { url: `https://glados.network/api/user/${endpoint}`, headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } } });
    assert.equal(next.notifications.length, 0, endpoint);
    assert.equal(next.writes.length, 0, endpoint);
    assert.equal(next.requests.length, 0, endpoint);
  }
});

test('cookie whitespace and ordering changes do not trigger another capture', async () => {
  const result = await runScript({ store: storedSession, request: { url: 'https://glados.network/api/user/status', headers: { Cookie: 'gld:sess.sig=test-signature ;gld:sess=test-session', 'User-Agent': MAC_UA } } });
  assert.equal(result.notifications.length, 0);
  assert.equal(result.writes.length, 0);
});

test('a changed cookie, device or API origin is captured once and then becomes silent', async () => {
  for (const change of [{ Cookie: 'gld:sess=new-session; gld:sess.sig=new-signature' }, { 'User-Agent': WINDOWS_UA }, { origin: 'https://glados.cloud' }]) {
    const origin = change.origin || 'https://glados.network';
    const headers = { Cookie: change.Cookie || COOKIE, 'User-Agent': change['User-Agent'] || MAC_UA };
    const request = { url: `${origin}/api/user/status`, headers };
    const updated = await runScript({ store: storedSession, request });
    assert.equal(updated.notifications.length, 1);
    assert.equal(updated.values.GLADOS_COOKIE, headers.Cookie);
    assert.equal(updated.values.GLADOS_USER_AGENT, headers['User-Agent']);
    assert.equal(updated.values.GLADOS_API_BASE, origin);
    const repeated = await runScript({ store: updated.values, request });
    assert.equal(repeated.notifications.length, 0);
    assert.equal(repeated.writes.length, 0);
  }
});

test('logged-out and preflight requests silently leave the saved session untouched', async () => {
  for (const headers of [{}, { 'User-Agent': MAC_UA }]) {
    const result = await runScript({ store: storedSession, request: { url: 'https://glados.network/api/user/status', headers } });
    assert.deepEqual(result.values, storedSession);
    assert.equal(result.writes.length, 0);
    assert.equal(result.notifications.length, 0);
  }
});

test('a failed capture write restores the old session and never announces success', async () => {
  for (const failWriteKey of ['GLADOS_COOKIE', 'GLADOS_USER_AGENT', 'GLADOS_API_BASE']) {
    const result = await runScript({ store: storedSession, failWriteKey, request: { url: 'https://glados.cloud/api/user/status', headers: { Cookie: 'gld:sess=new-session; gld:sess.sig=new-signature', 'User-Agent': WINDOWS_UA } } });
    assert.deepEqual(result.values, storedSession, failWriteKey);
    assert.doesNotMatch(result.text, /获取成功/);
    assert.match(result.text, /保存失败/);
  }
});

test('explicit indexed accounts take precedence over an automatically captured single account', async () => {
  const store = { ...storedSession, GLADOS_COOKIE_1: 'first-indexed-cookie', GLADOS_USER_AGENT_1: WINDOWS_UA, GLADOS_COOKIE_2: 'second-indexed-cookie', GLADOS_USER_AGENT_2: MAC_UA };
  const result = await runScript({ store });
  assert.deepEqual(result.requests.filter(r => r.method === 'POST').map(r => r.headers.Cookie), ['first-indexed-cookie', 'second-indexed-cookie']);
  assert.match(result.text, /成功 2/);
});

test('explicit bulk accounts take precedence over an automatically captured single account', async () => {
  const store = { ...storedSession, GLADOS_EMAILS: 'one@example.com,two@example.com', GLADOS_COOKIES: 'first-bulk-cookie,second-bulk-cookie', GLADOS_USER_AGENT_1: WINDOWS_UA, GLADOS_USER_AGENT_2: MAC_UA };
  const result = await runScript({ store });
  assert.deepEqual(result.requests.filter(r => r.method === 'POST').map(r => r.headers.Cookie), ['first-bulk-cookie', 'second-bulk-cookie']);
  assert.match(result.text, /成功 2/);
});

test('incomplete bulk configuration reports its error before any checkin', async () => {
  const result = await runScript({ store: { ...storedSession, GLADOS_EMAILS: 'one@example.com,two@example.com', GLADOS_COOKIES: COOKIE } });
  assert.equal(result.requests.length, 0);
  assert.match(result.text, /批量|数量/);
});

test('successful result counts come from the API code rather than translated message text', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin }) => ({ status: 200, body: isCheckin ? { code: 0, message: 'Observation accepted' } : statusBody }) });
  assert.match(result.text, /成功 1，重复 0，失败 0/);
});

test('Telegram sends plain text so upstream errors cannot turn into HTML markup', async () => {
  const result = await runScript({ store: { ...storedSession, TG_BOT_TOKEN: '123:synthetic-token', TG_CHAT_ID: 'synthetic-chat' }, reply: ({ request }) => ({ status: 200, body: request.url.includes('api.telegram.org') ? { ok: true, result: {} } : '<html>Challenge & retry</html>' }) });
  const telegram = result.requests.find(r => r.url.includes('api.telegram.org'));
  assert.ok(telegram);
  const body = JSON.parse(telegram.body);
  assert.equal(body.parse_mode, undefined);
  assert.match(body.text, /<html>Challenge & retry<\/html>/);
  assert.match(result.text, /失败 1/);
});

test('Telegram failures are visible without hiding the checkin result or leaking the bot token', async () => {
  const failures = [
    { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } },
    { status: 200, body: { ok: false, description: 'Bot request rejected' } },
    { status: 0, error: 'POST https://api.telegram.org/bot123:synthetic-token/sendMessage failed' },
    { status: 200, body: '<html>Proxy error</html>' },
  ];
  for (const failure of failures) {
    const result = await runScript({ store: { ...storedSession, TG_BOT_TOKEN: '123:synthetic-token', TG_CHAT_ID: 'synthetic-chat' }, reply: ({ request, isCheckin }) => request.url.includes('api.telegram.org') ? failure : { status: 200, body: isCheckin ? successBody : statusBody } });
    assert.match(result.text, /成功 1，重复 0，失败 0/);
    assert.match(result.text, /Telegram 推送失败/);
    assert.doesNotMatch(result.text, /synthetic-token|脚本运行失败/);
  }
});
