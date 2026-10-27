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
const ROTATED_COOKIE = 'gld:sess=rotated-session==; gld:sess.sig=rotated-signature';
const rotatedHeaders = { 'Set-Cookie': ['gld:sess=rotated-session==; Path=/; HttpOnly', 'gld:sess.sig=rotated-signature; Path=/; HttpOnly'] };
const storedSession = { GLADOS_COOKIE: COOKIE, GLADOS_USER_AGENT: MAC_UA, GLADOS_API_BASE: 'https://glados.network' };
const statusBody = { code: 0, data: { email: 'test@example.com', leftDays: 342 } };
const pointsBody = { code: 0, points: '276.0000000000000000', plans: { plan100: { points: 100, days: 10 }, plan200: { points: 200, days: 30 }, plan500: { points: 500, days: 100 } } };
const unauthenticatedStatusBody = { code: -2, message: '没有权限' };
const successBody = { code: 0, points: 10, message: 'Checkin! Got 10 Points', streak: 1, list: [] };
const repeatBody = { code: 1, points: 0, message: "Today's observation logged. Return tomorrow for more points.", streak: 1, list: [] };
const mismatchBody = { code: 4, reason: 'device-mismatch', points: 0, loginDevice: 'macOS', currentDevice: 'Windows', message: 'Automated check-in detected. Please sign in again to continue.', list: [] };

async function runScript(options = {}) {
  const values = { ...options.store };
  const requests = [];
  const writes = [];
  const notifications = [];
  let doneCalls = 0;
  const doneResults = [];
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const respond = (method, request, callback) => {
    requests.push({ method, ...request, headers: { ...request.headers } });
    const isCheckin = request.url.endsWith('/api/user/checkin');
    const isPoints = request.url.endsWith('/api/user/points');
    const reply = options.reply ? options.reply({ method, request, isCheckin, isPoints, values }) : {
      status: 200,
      body: isCheckin ? successBody : isPoints ? pointsBody : statusBody,
    };
    queueMicrotask(() => callback(reply.error || null, { status: reply.status, headers: reply.headers || {} },
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)));
  };
  const context = {
    $persistentStore: { read: key => values[key] ?? null, write: (value, key) => { writes.push({ key, value }); if (options.failWriteKey === key) return false; values[key] = value; return true; } },
    $httpClient: { get: (request, cb) => respond('GET', request, cb), post: (request, cb) => respond('POST', request, cb) },
    $notification: { post: (...args) => notifications.push(args) },
    $done: result => { doneCalls++; doneResults.push(result); finish(); },
    setTimeout: callback => { queueMicrotask(callback); return 0; },
    console,
  };
  if (options.request) {
    context.$request = options.request;
    const response = options.response === undefined ? { status: 200, body: statusBody } : options.response;
    if (response) context.$response = { ...response, body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
  }
  vm.runInNewContext(source, context, { filename: scriptPath, timeout: 1000 });
  await complete;
  assert.equal(doneCalls, 1, '$done must be called exactly once');
  return { values, requests, writes, notifications, doneResults, text: notifications.flat().join('\n') };
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

test('cron reuses the captured device on the checkin, status and points calls', async () => {
  const result = await runScript({ store: storedSession });
  assert.equal(result.requests.length, 3);
  assert.deepEqual(result.requests.map(r => r.headers['User-Agent']), [MAC_UA, MAC_UA, MAC_UA]);
  assert.deepEqual(JSON.parse(result.requests[0].body), { token: 'glados.network' });
  assert.match(result.text, /成功 1，重复 0，失败 0/);
  assert.match(result.text, /获得 10 积分/);
});

test('points notification uses the live balance and plans without redeeming anything', async () => {
  const result = await runScript({ store: storedSession });
  assert.match(result.text, /当前积分: 276(?:\n|$)/);
  assert.match(result.text, /100 分 → 10 天：✅ 可兑换/);
  assert.match(result.text, /200 分 → 30 天：✅ 可兑换/);
  assert.match(result.text, /500 分 → 100 天：还差 224 分/);
  assert.match(result.text, /✅ test@example\.com\n签到成功，获得 10 积分\n剩余时长: 342 天/);
  assert.deepEqual(result.requests.map(r => [r.method, r.url]), [
    ['POST', 'https://glados.network/api/user/checkin'],
    ['GET', 'https://glados.network/api/user/status'],
    ['GET', 'https://glados.network/api/user/points'],
  ]);
  assert.equal(result.notifications.length, 1);
  assert.deepEqual(result.values, storedSession);
});

for (const balance of [0, 99, 100, 199, 200, 499, 500, 600, 99.5]) {
  test(`points notification handles redemption boundaries for balance ${balance}`, async () => {
    const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
      status: 200, body: isCheckin ? successBody : isPoints ? { ...pointsBody, points: String(balance) } : statusBody,
    }) });
    assert.match(result.text, new RegExp(`当前积分: ${String(balance).replace('.', '\\.')}\\n`));
    for (const plan of Object.values(pointsBody.plans)) {
      const expected = `${plan.points} 分 → ${plan.days} 天：${balance >= plan.points ? '✅ 可兑换' : `还差 ${plan.points - balance} 分`}`;
      assert.ok(result.text.includes(expected), expected);
    }
  });
}

test('points notification follows changed server plans instead of assuming fixed tiers', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
    status: 200, body: isCheckin ? successBody : isPoints ? { ...pointsBody, plans: { longer: { points: 600, days: 120 }, starter: { points: 50, days: 4 } } } : statusBody,
  }) });
  assert.match(result.text, /50 分 → 4 天：✅ 可兑换/);
  assert.match(result.text, /600 分 → 120 天：还差 324 分/);
  assert.doesNotMatch(result.text, /100 分 → 10 天/);
  assert.ok(result.text.indexOf('50 分 →') < result.text.indexOf('600 分 →'));
});

test('points notification formats a fractional gap without floating-point noise', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
    status: 200, body: isCheckin ? successBody : isPoints ? { ...pointsBody, points: '99.9000000000000000' } : statusBody,
  }) });
  assert.match(result.text, /100 分 → 10 天：还差 0\.1 分(?:\n|$)/);
});

test('points notification keeps a precise decimal just below a threshold non-redeemable', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
    status: 200, body: isCheckin ? successBody : isPoints ? { ...pointsBody, points: '99.9999999999999999' } : statusBody,
  }) });
  assert.match(result.text, /当前积分: 99\.9999999999999999/);
  assert.match(result.text, /100 分 → 10 天：还差 0\.0000000000000001 分(?:\n|$)/);
  assert.doesNotMatch(result.text, /可兑换/);
});

test('points notification preserves an already checked-in result', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
    status: 200, body: isCheckin ? repeatBody : isPoints ? pointsBody : statusBody,
  }) });
  assert.match(result.text, /成功 0，重复 1，失败 0/);
  assert.match(result.text, /🟡 test@example\.com/);
  assert.match(result.text, /当前积分: 276/);
  assert.doesNotMatch(result.text, /获得 0 积分/);
});

test('points notification reports query failures without changing a confirmed checkin result', async () => {
  const failures = [
    { status: 401, body: { code: -2, message: 'Unauthorized' } },
    { status: 200, body: { code: -2, message: 'Invalid session' } },
    { status: 200, body: '<html>Challenge</html>' },
    { status: 200, body: 'not json' },
    { status: 0, body: '', error: 'Request timed out' },
  ];
  for (const failure of failures) {
    const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => isPoints ? failure : ({ status: 200, body: isCheckin ? successBody : statusBody }) });
    assert.match(result.text, /成功 1，重复 0，失败 0/);
    assert.match(result.text, /积分查询失败/);
    assert.doesNotMatch(result.text, /可兑换|还差 \d+ 分|当前积分: 0/);
    assert.equal(result.requests.length, 3);
  }
});

test('points notification never treats missing or malformed points as a zero balance', async () => {
  for (const points of [undefined, null, '', ' ', false, [], {}, 'NaN', '1e3', -1, '-1', 'Infinity']) {
    const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
      status: 200, body: isCheckin ? successBody : isPoints ? { ...pointsBody, points } : statusBody,
    }) });
    assert.match(result.text, /积分查询失败/);
    assert.doesNotMatch(result.text, /可兑换|还差 \d+ 分|当前积分: 0/);
  }
});

test('points notification reports invalid plans instead of using stale tiers', async () => {
  for (const plans of [undefined, null, [], {}, { plan: null }, { plan: { points: 0, days: 10 } }, { plan: { points: 100, days: 'oops' } }]) {
    const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
      status: 200, body: isCheckin ? successBody : isPoints ? { ...pointsBody, plans } : statusBody,
    }) });
    assert.match(result.text, /积分查询失败/);
    assert.doesNotMatch(result.text, /可兑换|还差 \d+ 分/);
  }
});

test('points notification keeps each account balance and redemption progress separate', async () => {
  const store = { GLADOS_API_BASE: storedSession.GLADOS_API_BASE, GLADOS_EMAIL_1: 'one@example.com', GLADOS_COOKIE_1: COOKIE, GLADOS_USER_AGENT_1: MAC_UA, GLADOS_EMAIL_2: 'two@example.com', GLADOS_COOKIE_2: 'second-cookie', GLADOS_USER_AGENT_2: WINDOWS_UA };
  const result = await runScript({ store, reply: ({ request, isCheckin, isPoints }) => ({
    status: 200, body: isCheckin ? successBody : isPoints ? { ...pointsBody, points: request.headers.Cookie === COOKIE ? '276' : '50' } : statusBody,
  }) });
  const body = result.notifications[0][2];
  assert.match(body, /✅ one@example\.com[\s\S]*当前积分: 276[\s\S]*还差 224 分\n\n✅ two@example\.com[\s\S]*当前积分: 50[\s\S]*100 分 → 10 天：还差 50 分[\s\S]*500 分 → 100 天：还差 450 分/);
  assert.equal(result.requests.length, 6);
  assert.deepEqual(result.requests.filter(r => r.url.endsWith('/points')).map(r => r.headers['User-Agent']), [MAC_UA, WINDOWS_UA]);
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
  assert.deepEqual(result.requests.map(r => r.headers['User-Agent']), [MAC_UA, MAC_UA, MAC_UA, WINDOWS_UA, WINDOWS_UA, WINDOWS_UA]);
  assert.match(result.text, /成功 2，重复 0，失败 0/);
});

test('bulk accounts can specify each device with the same indexed keys', async () => {
  const store = { GLADOS_API_BASE: 'https://glados.network', GLADOS_EMAILS: 'one@example.com,two@example.com', GLADOS_COOKIES: `${COOKIE},test-second-cookie`, GLADOS_USER_AGENT_1: MAC_UA, GLADOS_USER_AGENT_2: WINDOWS_UA };
  const result = await runScript({ store });
  assert.deepEqual(result.requests.map(r => r.headers['User-Agent']), [MAC_UA, MAC_UA, MAC_UA, WINDOWS_UA, WINDOWS_UA, WINDOWS_UA]);
});

test('the Surge module validates status responses on the supported API hosts and appends MITM hosts', () => {
  const module = fs.readFileSync(modulePath, 'utf8');
  const capture = module.split('\n').find(line => line.startsWith('GLaDOS_Capture'));
  assert.match(capture, /type=http-response(?:,|$)/);
  assert.match(capture, /requires-body=(?:true|1)(?:,|$)/);
  assert.match(capture, /full-header-mode=(?:true|1)(?:,|$)/);
  const pattern = new RegExp(capture.match(/pattern=([^,]+)/)[1]);
  for (const host of ['glados.network', 'glados.cloud', 'glados.one']) {
    assert.equal(pattern.test(`https://${host}/api/user/status`), true, host);
    assert.equal(pattern.test(`https://${host}/api/user/status?source=console`), true, host);
    assert.equal(pattern.test(`https://${host}/api/user/checkin`), false, host);
    assert.equal(pattern.test(`https://${host}/api/user/status/anything`), false, host);
  }
  assert.equal(pattern.test('https://glados.network.evil.test/api/user/status'), false);
  assert.match(module, /hostname\s*=\s*%APPEND%.*glados\.network/);
});

test('the module schedules its daily 09:10 cron using the documented Surge format', () => {
  const module = fs.readFileSync(modulePath, 'utf8');
  const cron = module.split('\n').find(line => /type=cron(?:,|$)/.test(line));
  assert.ok(cron, 'a named cron script must be registered');
  assert.match(cron, /cronexp="10 9 \* \* \*"/);
  assert.match(cron, /timeout=\d+(?:,|$)/);
  assert.match(cron, /wake-system=true/);
});

test('the module timeout covers twenty indexed accounts including their request and pacing time', async () => {
  const store = { GLADOS_API_BASE: storedSession.GLADOS_API_BASE };
  for (let index = 1; index <= 20; index++) {
    Object.assign(store, { [`GLADOS_EMAIL_${index}`]: `test-${index}@example.com`, [`GLADOS_COOKIE_${index}`]: COOKIE, [`GLADOS_USER_AGENT_${index}`]: MAC_UA });
  }
  const result = await runScript({ store });
  assert.equal(result.requests.length, 60);
  assert.match(result.text, /成功 20，重复 0，失败 0/);
  const requestSeconds = result.requests.reduce((sum, request) => sum + (request.timeout ?? 5), 0);
  const pacingSeconds = 20 * 2;
  const module = fs.readFileSync(modulePath, 'utf8');
  const cron = module.split('\n').find(line => line.startsWith('GLaDOS_Checkin'));
  const timeoutSeconds = Number(cron.match(/timeout=(\d+)(?:,|$)/)?.[1]);
  assert.ok(timeoutSeconds > requestSeconds + pacingSeconds, `${timeoutSeconds}s module timeout cannot cover ${requestSeconds + pacingSeconds}s plus script work`);
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

test('legacy Telegram settings never send a push or change the local checkin result', async () => {
  for (const settings of [{ TG_BOT_TOKEN: '123:synthetic-token', TG_CHAT_ID: 'synthetic-chat' }, { TG_BOT_TOKEN: '123:synthetic-token' }, { TG_CHAT_ID: 'synthetic-chat' }]) {
    const store = { ...storedSession, ...settings };
    const result = await runScript({ store });
    assert.deepEqual(result.requests.map(request => request.url), ['https://glados.network/api/user/checkin', 'https://glados.network/api/user/status', 'https://glados.network/api/user/points']);
    assert.match(result.text, /成功 1，重复 0，失败 0/);
    assert.doesNotMatch(result.text, /Telegram|synthetic-token/);
    assert.equal(result.notifications.length, 1);
    assert.deepEqual(result.values, store);
  }
});


test('an unauthenticated status response with analytics cookies is never captured', async () => {
  for (const store of [{}, storedSession]) {
    const result = await runScript({ store, request: { url: 'https://glados.network/api/user/status', headers: { Cookie: '_ga=anonymous; _gid=tracking', 'User-Agent': MAC_UA } }, response: { status: 200, body: unauthenticatedStatusBody } });
    assert.deepEqual(result.values, store);
    assert.equal(result.writes.length, 0);
    assert.equal(result.notifications.length, 0);
    assert.equal(result.requests.length, 0);
    assert.equal(JSON.stringify(result.doneResults), '[{}]', 'the website response must pass through untouched');
  }
});

test('a rejected or expired session never replaces the previously saved account', async () => {
  const result = await runScript({ store: storedSession, request: { url: 'https://glados.network/api/user/status', headers: { Cookie: 'gld:sess=expired; gld:sess.sig=expired-signature', 'User-Agent': WINDOWS_UA } }, response: { status: 200, body: unauthenticatedStatusBody } });
  assert.deepEqual(result.values, storedSession);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
});

test('a request without a server response cannot claim a successful capture', async () => {
  const result = await runScript({ request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } }, response: null });
  assert.deepEqual(result.values, {});
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
  assert.equal(result.requests.length, 0);
});

test('HTTP errors, invalid JSON and status bodies without an authenticated account are ignored', async () => {
  const responses = [
    { status: 401, body: statusBody },
    { status: 403, body: statusBody },
    { status: 302, body: statusBody },
    { status: 200, body: '<html>Please log in</html>' },
    { status: 200, body: '' },
    { status: 200, body: 'null' },
    { status: 200, body: { code: 0, data: {} } },
    { status: 200, body: { code: 0, data: { email: '  ' } } },
    { status: 200, body: { code: 0, data: { email: 123 } } },
    { status: 200, body: { code: 0, data: null } },
    { status: 200, body: { ...statusBody, code: 1 } },
    { status: 200, body: { ...statusBody, code: '0' } },
  ];
  for (const response of responses) {
    const result = await runScript({ store: storedSession, request: { url: 'https://glados.network/api/user/status', headers: { Cookie: 'candidate-session', 'User-Agent': WINDOWS_UA } }, response });
    assert.deepEqual(result.values, storedSession);
    assert.equal(result.writes.length, 0);
    assert.equal(result.notifications.length, 0);
    assert.equal(result.requests.length, 0);
    assert.equal(JSON.stringify(result.doneResults), '[{}]');
  }
});

test('even a valid account body is captured only from an exact trusted HTTPS status URL', async () => {
  for (const url of ['https://glados.network/api/user/checkin', 'https://glados.network/api/user/status/anything', 'https://glados.network.evil.test/api/user/status', 'https://example.com/api/user/status', 'http://glados.network/api/user/status']) {
    const result = await runScript({ request: { url, headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } }, response: { status: 200, body: statusBody } });
    assert.deepEqual(result.values, {}, url);
    assert.equal(result.writes.length, 0, url);
    assert.equal(result.notifications.length, 0, url);
  }
});

test('browsing anonymously, logging in, refreshing and logging out produces one valid capture', async () => {
  const request = { url: 'https://glados.network/api/user/status?source=console', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } };
  const anonymous = await runScript({ request: { ...request, headers: { ...request.headers, Cookie: '_ga=anonymous' } }, response: { status: 200, body: unauthenticatedStatusBody } });
  assert.deepEqual(anonymous.values, {});
  assert.equal(anonymous.notifications.length, 0);
  const loggedIn = await runScript({ store: anonymous.values, request, response: { status: 200, body: statusBody } });
  assert.equal(loggedIn.notifications.length, 1);
  assert.equal(loggedIn.values.GLADOS_COOKIE, COOKIE);
  assert.match(loggedIn.text, /获取成功/);
  const refreshed = await runScript({ store: loggedIn.values, request, response: { status: 200, body: statusBody } });
  assert.equal(refreshed.notifications.length, 0);
  assert.equal(refreshed.writes.length, 0);
  const loggedOut = await runScript({ store: refreshed.values, request: { ...request, headers: { ...request.headers, Cookie: '_ga=anonymous' } }, response: { status: 200, body: unauthenticatedStatusBody } });
  assert.deepEqual(loggedOut.values, loggedIn.values);
  assert.equal(loggedOut.notifications.length, 0);
  assert.equal(loggedOut.writes.length, 0);
  assert.equal([anonymous, loggedIn, refreshed, loggedOut].reduce((total, result) => total + result.requests.length, 0), 0);
});

test('capture saves the response session rather than the cookie sent before rotation', async () => {
  for (const headers of [
    rotatedHeaders,
    { 'sEt-CoOkIe': rotatedHeaders['Set-Cookie'].join(', ') },
    rotatedHeaders['Set-Cookie'].map(value => ({ field: 'set-cookie', value })),
  ]) {
    const result = await runScript({
      store: storedSession,
      request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } },
      response: { status: 200, headers, body: statusBody },
    });
    assert.equal(result.values.GLADOS_COOKIE, ROTATED_COOKIE);
    assert.equal(result.values.GLADOS_USER_AGENT, MAC_UA);
    assert.match(result.text, /获取成功/);
    assert.equal(result.requests.length, 0);
  }
});

test('capture handles Expires commas and Max-Age precedence without saving cookie attributes', async () => {
  const result = await runScript({
    request: { url: 'https://glados.network/api/user/status', headers: { Cookie: `${COOKIE}; theme=dark`, 'User-Agent': MAC_UA } },
    response: { status: 200, body: statusBody, headers: { 'Set-Cookie':
      'gld:sess=rotated-session==; Domain=.glados.network; Path=/; Expires=Wed, 01 Jan 2099 00:00:00 GMT, gld:sess.sig=rotated-signature; Path=/; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT' } },
  });
  assert.equal(result.values.GLADOS_COOKIE, `${ROTATED_COOKIE}; theme=dark`);
});

test('response cookies outside the API scope leave the captured session unchanged', async () => {
  const result = await runScript({
    store: storedSession,
    request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } },
    response: { status: 200, body: statusBody, headers: { 'Set-Cookie': [
      'gld:sess=wrong-domain; Domain=glados.cloud; Path=/',
      'gld:sess=wrong-path; Path=/console',
      'gld:sess.sig=status-only; Path=/api/user/status',
      'tracking=unrelated; Path=/',
    ] } },
  });
  assert.deepEqual(result.values, storedSession);
  assert.equal(result.writes.length, 0);
});

test('an unauthenticated response cannot replace the stored session with Set-Cookie', async () => {
  const result = await runScript({
    store: storedSession,
    request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } },
    response: { status: 200, headers: rotatedHeaders, body: unauthenticatedStatusBody },
  });
  assert.deepEqual(result.values, storedSession);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
});

test('capture rejects a completely cleared or partially malformed response session', async () => {
  for (const headers of [
    { 'Set-Cookie': ['gld:sess=; Path=/; Max-Age=0', 'gld:sess.sig=; Path=/; Max-Age=0'] },
    { 'Set-Cookie': ['gld:sess=invalid\r\nvalue; Path=/', 'gld:sess.sig=new-signature; Path=/'] },
  ]) {
    const result = await runScript({
      store: storedSession,
      request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } },
      response: { status: 200, headers, body: statusBody },
    });
    assert.deepEqual(result.values, storedSession);
    assert.equal(result.writes.length, 0);
    assert.match(result.text, /获取失败/);
    assert.doesNotMatch(result.text, /获取成功/);
  }
});

test('a cleared or invalid response session never produces capture success', async () => {
  for (const cookie of [
    'gld:sess=; Path=/',
    'gld:sess=deleted; Path=/; Max-Age=0',
    'gld:sess.sig=deleted; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'gld:sess=invalid\r\nvalue; Path=/',
  ]) {
    const result = await runScript({
      store: storedSession,
      request: { url: 'https://glados.network/api/user/status', headers: { Cookie: COOKIE, 'User-Agent': MAC_UA } },
      response: { status: 200, headers: { 'Set-Cookie': cookie }, body: statusBody },
    });
    assert.deepEqual(result.values, storedSession);
    assert.equal(result.writes.length, 0);
    assert.doesNotMatch(result.text, /获取成功/);
    assert.match(result.text, /获取失败/);
  }
});

test('cron uses each rotated session in the next request and preserves the final rotation for tomorrow', async () => {
  const statusCookie = 'gld:sess=status-session; gld:sess.sig=status-signature';
  const finalCookie = 'gld:sess=points-session; gld:sess.sig=points-signature';
  const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints, values }) => {
    if (isPoints) assert.equal(values.GLADOS_COOKIE, statusCookie, 'the verified session must be saved before points are queried');
    return {
      status: 200,
      headers: isCheckin ? rotatedHeaders : { 'Set-Cookie': [
        `gld:sess=${isPoints ? 'points' : 'status'}-session; Path=/`,
        `gld:sess.sig=${isPoints ? 'points' : 'status'}-signature; Path=/`,
      ] },
      body: isCheckin ? successBody : isPoints ? pointsBody : statusBody,
    };
  } });
  assert.deepEqual(result.requests.map(request => request.headers.Cookie), [COOKIE, ROTATED_COOKIE, statusCookie]);
  assert.equal(result.values.GLADOS_COOKIE, finalCookie);
  assert.match(result.text, /成功 1，重复 0，失败 0/);
  const tomorrow = await runScript({ store: result.values });
  assert.equal(tomorrow.requests[0].headers.Cookie, finalCookie);
});

test('cron isolates its cookie jar from automatic cookies and redirects', async () => {
  const result = await runScript({ store: storedSession });
  for (const request of result.requests) {
    assert.equal(request['auto-cookie'], false);
    assert.equal(request['auto-redirect'], false);
    assert.equal(request['full-header-mode'], true);
  }
});

test('cron updates indexed and bulk cookies in their own slot without changing other accounts', async () => {
  for (const store of [
    { ...storedSession, GLADOS_COOKIE_1: COOKIE, GLADOS_USER_AGENT_1: MAC_UA, GLADOS_COOKIE_2: 'second-account-cookie', GLADOS_USER_AGENT_2: WINDOWS_UA },
    { ...storedSession, GLADOS_EMAILS: 'test@example.com,second@example.com', GLADOS_COOKIES: `${COOKIE},second-account-cookie`, GLADOS_USER_AGENT_1: MAC_UA, GLADOS_USER_AGENT_2: WINDOWS_UA },
  ]) {
    const result = await runScript({ store, reply: ({ request, isCheckin, isPoints }) => ({
      status: 200,
      headers: isCheckin && request.headers.Cookie === COOKIE ? rotatedHeaders : {},
      body: isCheckin ? successBody : isPoints ? pointsBody : statusBody,
    }) });
    assert.equal(result.values.GLADOS_COOKIE, COOKIE, 'automatic single-account capture is a separate slot');
    if (store.GLADOS_COOKIES) assert.equal(result.values.GLADOS_COOKIES, `${ROTATED_COOKIE},second-account-cookie`);
    else {
      assert.equal(result.values.GLADOS_COOKIE_1, ROTATED_COOKIE);
      assert.equal(result.values.GLADOS_COOKIE_2, 'second-account-cookie');
    }
    assert.equal(result.requests[1].headers.Cookie, ROTATED_COOKIE);
    assert.deepEqual(result.requests.slice(3).map(request => request.headers.Cookie), Array(3).fill('second-account-cookie'));
    assert.match(result.text, /成功 2，重复 0，失败 0/);
  }
});

test('cron keeps a verified rotation when the later points request fails', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => isPoints
    ? { error: 'Request timed out' }
    : { status: 200, headers: isCheckin ? rotatedHeaders : {}, body: isCheckin ? successBody : statusBody } });
  assert.equal(result.values.GLADOS_COOKIE, ROTATED_COOKIE);
  assert.match(result.text, /成功 1，重复 0，失败 0/);
  assert.match(result.text, /积分查询失败/);
});

test('an unverified rotated session is not persisted when status rejects the request', async () => {
  const result = await runScript({ store: storedSession, reply: ({ isCheckin }) => ({
    status: 200, headers: isCheckin ? rotatedHeaders : {}, body: isCheckin ? successBody : unauthenticatedStatusBody,
  }) });
  assert.deepEqual(result.values, storedSession);
  assert.equal(result.writes.length, 0);
  assert.match(result.text, /失败 1/);
});

test('a cookie persistence failure stays visible and stops before further requests', async () => {
  const result = await runScript({ store: storedSession, failWriteKey: 'GLADOS_COOKIE', reply: ({ isCheckin, isPoints }) => ({
    status: 200, headers: isCheckin ? rotatedHeaders : {}, body: isCheckin ? successBody : isPoints ? pointsBody : statusBody,
  }) });
  assert.deepEqual(result.values, storedSession);
  assert.match(result.text, /Cookie.*保存失败/);
  assert.match(result.text, /失败 1/);
  assert.equal(result.requests.length, 2);
});

test('cron never overwrites a session captured while requests were in flight', async () => {
  const newerCookie = 'gld:sess=new-browser-session; gld:sess.sig=new-browser-signature';
  const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints, values }) => {
    if (!isCheckin && !isPoints) values.GLADOS_COOKIE = newerCookie;
    return { status: 200, headers: isCheckin ? rotatedHeaders : {}, body: isCheckin ? successBody : isPoints ? pointsBody : statusBody };
  } });
  assert.equal(result.values.GLADOS_COOKIE, newerCookie);
  assert.equal(result.writes.length, 0);
  assert.match(result.text, /会话已被更新/);
});

test('a concurrent capture keeps the new device and origin paired with its cookie', async () => {
  for (const update of [
    { GLADOS_USER_AGENT: WINDOWS_UA },
    { GLADOS_API_BASE: 'https://glados.cloud' },
    { GLADOS_COOKIE: ROTATED_COOKIE, GLADOS_USER_AGENT: WINDOWS_UA },
  ]) {
    const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints, values }) => {
      if (!isCheckin && !isPoints) Object.assign(values, update);
      return { status: 200, headers: isCheckin ? rotatedHeaders : {}, body: isCheckin ? successBody : isPoints ? pointsBody : statusBody };
    } });
    assert.deepEqual(result.values, { ...storedSession, ...update });
    assert.equal(result.writes.length, 0);
    assert.match(result.text, /会话已被更新/);
  }
});

test('cleared session cookies stop cron without retrying checkin or destroying stored credentials', async () => {
  for (const name of ['gld:sess', 'gld:sess.sig']) {
    const result = await runScript({ store: storedSession, reply: () => ({
      status: 200, headers: { 'Set-Cookie': `${name}=; Path=/; Max-Age=0` }, body: successBody,
    }) });
    assert.deepEqual(result.values, storedSession);
    assert.equal(result.requests.length, 1);
    assert.match(result.text, /会话.*清除/);
    assert.match(result.text, /重新登录并抓取/);
    assert.match(result.text, /失败 1/);
  }
});

test('authentication rejection explicitly asks for login at every API stage', async () => {
  for (const endpoint of ['checkin', 'status', 'points']) {
    const result = await runScript({ store: storedSession, reply: ({ request, isCheckin, isPoints }) => {
      const target = request.url.endsWith(`/api/user/${endpoint}`);
      return { status: 200, body: target ? unauthenticatedStatusBody : isCheckin ? successBody : isPoints ? pointsBody : statusBody };
    } });
    assert.match(result.text, /登录会话已失效/);
    assert.match(result.text, /重新登录并抓取/);
    assert.match(result.text, endpoint === 'points' ? /积分查询失败/ : /失败 1/);
    assert.deepEqual(result.values, storedSession);
  }
});

test('a fully cleared or malformed response cookie stops cron before another request', async () => {
  for (const cookies of [
    ['gld:sess=; Path=/; Max-Age=0', 'gld:sess.sig=; Path=/; Max-Age=0'],
    ['gld:sess=invalid\r\nvalue; Path=/', 'gld:sess.sig=new-signature; Path=/'],
  ]) {
    const result = await runScript({ store: storedSession, reply: ({ isCheckin, isPoints }) => ({
      status: 200, headers: isCheckin ? { 'Set-Cookie': cookies } : {}, body: isCheckin ? successBody : isPoints ? pointsBody : statusBody,
    }) });
    assert.deepEqual(result.values, storedSession);
    assert.equal(result.requests.length, 1);
    assert.match(result.text, /失败 1/);
    assert.match(result.text, /会话.*(?:清除|无效)|无效.*会话/);
  }
});

test('bulk configuration retains original cookie slots when empty CSV items are present', async () => {
  const store = {
    ...storedSession, GLADOS_EMAILS: 'one@example.com,,two@example.com', GLADOS_COOKIES: `,${COOKIE},,second-account-cookie,`,
    GLADOS_USER_AGENT_1: MAC_UA, GLADOS_USER_AGENT_2: WINDOWS_UA,
  };
  const unchanged = await runScript({ store });
  assert.deepEqual(unchanged.values, store);
  assert.match(unchanged.text, /成功 2，重复 0，失败 0/);
  const rotated = await runScript({ store, reply: ({ request, isCheckin, isPoints }) => ({
    status: 200,
    headers: isCheckin && request.headers.Cookie === COOKIE ? rotatedHeaders : {},
    body: isCheckin ? successBody : isPoints ? pointsBody : statusBody,
  }) });
  assert.equal(rotated.values.GLADOS_COOKIES, `,${ROTATED_COOKIE},,second-account-cookie,`);
  assert.match(rotated.text, /成功 2，重复 0，失败 0/);
});
