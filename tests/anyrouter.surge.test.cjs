const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = process.env.ANYROUTER_SCRIPT || path.resolve(__dirname, '../Surge/anyrouter.surge.js');
const modulePath = process.env.ANYROUTER_MODULE || path.resolve(__dirname, '../Surge/AnyRouter自动签到.sgmodule');
const source = fs.readFileSync(scriptPath, 'utf8');
const KEY = 'ANYROUTER_ACCOUNTS';
const BASE = 'https://anyrouter.top';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const SESSION = 'test-session-value==';
const ACCOUNT = { id: 123, session: SESSION, userAgent: UA };
const ARG = '152EAAA776AB045C5B3169B48740D76FC4AB7EEB';
const SOLVED = '6ad4db7e67b3d49d86bfea4476f43eae7da044ce';
const WAF = fs.readFileSync(path.resolve(__dirname, 'fixtures/anyrouter-waf.html'), 'utf8').replace(/arg1='[A-F0-9]+'/i, `arg1='${ARG}'`);
const OK = { success: true, message: '签到成功，获得 $25 额度' };
const STATUS = { success: true, message: '', data: { quota_per_unit: 500000 } };
const authBody = id => ({ success: true, message: '', data: { id, username: `test_${id}`, quota: 62500000, used_quota: 25000000 } });
const stored = (accounts = [ACCOUNT]) => ({ [KEY]: JSON.stringify({ version: 1, accounts }) });
const request = (headers = {}, url = `${BASE}/api/user/self`) => ({ url, method: 'GET', headers: { Cookie: `session=${SESSION}; acw_sc__v2=old-waf`, 'User-Agent': UA, 'New-API-User': '123', ...headers } });

async function run(options = {}) {
  const values = { ...options.store };
  const requests = [], writes = [], notifications = [], logs = [], doneResults = [];
  let doneCalls = 0, finish;
  let now = options.now ?? Date.now();
  const complete = new Promise(resolve => { finish = resolve; });
  const respond = (method, req, callback) => {
    requests.push({ method, ...req });
    const reply = options.reply ? options.reply({ method, request: req, index: requests.length - 1 }) : {
      status: 200,
      body: req.url.endsWith('/api/status') ? STATUS : req.url.endsWith('/api/user/self') ? authBody(Number(req.headers['New-API-User'])) : OK,
    };
    if (options.elapseMs) now += Math.min(options.elapseMs, (req.timeout || 4) * 1000);
    queueMicrotask(() => callback(reply.error || null, { status: reply.status, headers: reply.headers || {} }, typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)));
  };
  const context = {
    $persistentStore: {
      read: key => values[key] ?? null,
      write: (value, key) => { writes.push({ key, value }); if (options.throwWrite) throw new Error('disk error'); if (options.failWrite) return false; values[key] = value; return true; },
    },
    $httpClient: { get: (req, cb) => respond('GET', req, cb), post: (req, cb) => respond('POST', req, cb) },
    $notification: { post: (...args) => notifications.push(args) },
    $done: value => { doneCalls++; doneResults.push(value); finish(); },
    console: { log: (...args) => logs.push(args.join(' ')) },
  };
  if (options.elapseMs) context.Date = class extends Date { static now() { return now; } };
  if (options.request) {
    context.$request = options.request;
    const response = options.response === undefined ? { status: 200, body: authBody(123) } : options.response;
    if (response) context.$response = { ...response, body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
  }
  vm.runInNewContext(source, context, { filename: scriptPath, timeout: 1000 });
  await complete;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doneCalls, 1);
  return { values, requests, writes, notifications, logs, doneResults, now, text: notifications.flat().join('\n') };
}

test('authenticated capture atomically saves only the verified account, session and actual UA', async () => {
  const r = await run({ request: request() });
  assert.deepEqual(JSON.parse(r.values[KEY]), { version: 1, accounts: [ACCOUNT] });
  assert.equal(r.writes.length, 1);
  assert.equal(r.requests.length, 0);
  assert.match(r.text, /已验证登录/);
  assert.deepEqual(JSON.parse(JSON.stringify(r.doneResults)), [{}]);
});

test('capture stores the server-issued session when the response rotates it', async () => {
  const r = await run({
    request: request({ Cookie: 'session=request-session' }),
    response: { status: 200, headers: { 'Set-Cookie': 'session=response-session; Path=/; HttpOnly' }, body: authBody(123) },
  });
  assert.deepEqual(JSON.parse(r.values[KEY]).accounts, [{ id: 123, session: 'response-session', userAgent: UA }]);
});

test('capture supports case insensitive and full-mode request headers', async () => {
  for (const headers of [
    { cOOkie: `session=${SESSION}`, 'uSer-Agent': UA, 'new-api-user': '123' },
    [{ field: 'cookie', value: `session=${SESSION}` }, { field: 'user-agent', value: UA }, { field: 'new-api-user', value: '123' }],
  ]) {
    const r = await run({ request: { url: `${BASE}/api/user/self?source=console`, method: 'GET', headers } });
    assert.deepEqual(JSON.parse(r.values[KEY]).accounts, [ACCOUNT]);
  }
});

for (const [name, response] of Object.entries({
  'not logged in': { status: 401, body: { success: false, message: '未登录' } },
  'HTTP200 business denial': { status: 200, body: { success: false, data: { id: 123 } } },
  'missing success': { status: 200, body: { data: { id: 123 } } },
  'string success': { status: 200, body: { success: 'true', data: { id: 123 } } },
  'missing data': { status: 200, body: { success: true } },
  'invalid id': { status: 200, body: authBody(0) },
  'wrong account': { status: 200, body: authBody(456) },
  'WAF HTML': { status: 200, body: WAF },
  'server error': { status: 500, body: authBody(123) },
  'no response': null,
})) {
  test(`capture silently preserves the previous session for ${name}`, async () => {
    const old = stored();
    const r = await run({ store: old, request: request({ Cookie: 'session=new-session' }), response });
    assert.equal(r.values[KEY], old[KEY]);
    assert.equal(r.writes.length, 0);
    assert.equal(r.notifications.length, 0);
    assert.equal(r.requests.length, 0);
  });
}

test('capture rejects missing session, missing UA, invalid/missing id and duplicate session cookies', async () => {
  for (const hdrs of [{ Cookie: 'acw_sc__v2=waf' }, { 'User-Agent': '' }, { 'New-API-User': '' }, { 'New-API-User': '123junk' }, { Cookie: 'session=one; session=two' }, { Cookie: 'session=bad\r\nvalue' }]) {
    const r = await run({ store: stored(), request: request(hdrs) });
    assert.equal(r.writes.length, 0);
    assert.equal(r.notifications.length, 0);
  }
});

test('unchanged session stays silent even when WAF cookie values or order change', async () => {
  const r = await run({ store: stored(), request: request({ Cookie: `cdn_sec_tc=new; session=${SESSION}; acw_sc__v2=rotated` }) });
  assert.equal(r.writes.length, 0);
  assert.equal(r.notifications.length, 0);
});

test('refreshing a session updates that account while preserving other accounts', async () => {
  const other = { id: 456, session: 'other-session', userAgent: 'other-UA' };
  const r = await run({ store: stored([ACCOUNT, other]), request: request({ Cookie: 'session=refreshed', 'User-Agent': 'new-UA' }) });
  assert.deepEqual(JSON.parse(r.values[KEY]).accounts, [{ ...ACCOUNT, session: 'refreshed', userAgent: 'new-UA' }, other]);
  assert.equal(r.notifications.length, 1);
});

test('a newly verified account is appended using its server id without a digit-length assumption', async () => {
  const r = await run({ store: stored(), request: request({ 'New-API-User': '7' }), response: { status: 200, body: authBody(7) } });
  assert.deepEqual(JSON.parse(r.values[KEY]).accounts.map(a => a.id), [123, 7]);
});

test('storage errors cannot produce a capture success or replace the previous record', async () => {
  for (const option of [{ failWrite: true }, { throwWrite: true }]) {
    const before = stored();
    const r = await run({ ...option, store: before, request: request({ Cookie: 'session=new-session' }) });
    assert.equal(r.values[KEY], before[KEY]);
    assert.match(r.text, /保存失败/);
    assert.doesNotMatch(r.text, /获取成功/);
  }
});

test('corrupt stored accounts are reported and preserved instead of overwritten or ignored', async () => {
  for (const value of ['{bad json', JSON.stringify({ version: 2, accounts: [ACCOUNT] }), JSON.stringify({ version: 1, accounts: [ACCOUNT, ACCOUNT] }), JSON.stringify({ version: 1, accounts: [{ ...ACCOUNT, userAgent: '' }] })]) {
    const r = await run({ store: { [KEY]: value }, request: request() });
    assert.equal(r.values[KEY], value);
    assert.equal(r.writes.length, 0);
    assert.match(r.text, /存储|配置/);
    assert.doesNotMatch(r.text, /获取成功/);
  }
});

test('capture is limited to GET self on the official HTTPS origin', async () => {
  for (const url of ['http://anyrouter.top/api/user/self', 'https://anyrouter.top.evil.test/api/user/self', 'https://anyrouter.top@evil.test/api/user/self', `${BASE}/api/user/self/extra`, `${BASE}/api/user/sign_in`, `${BASE}/console`]) {
    const r = await run({ request: request({}, url) });
    assert.equal(r.writes.length, 0, url);
  }
  const r = await run({ request: { ...request(), method: 'PUT' } });
  assert.equal(r.writes.length, 0);
});

test('cron verifies identity before signing in and preserves the captured request identity', async () => {
  const r = await run({ store: stored() });
  assert.deepEqual(r.requests.map(req => [req.method, req.url]), [['GET', `${BASE}/api/user/self`], ['POST', `${BASE}/api/user/sign_in`], ['GET', `${BASE}/api/user/self`], ['GET', `${BASE}/api/status`]]);
  for (const req of r.requests) {
    assert.equal(req.headers.Cookie, `session=${SESSION}`);
    assert.equal(req.headers['User-Agent'], UA);
    assert.equal(req.headers['New-API-User'], '123');
    assert.equal(req['auto-cookie'], false);
    assert.equal(req['auto-redirect'], false);
    assert.equal(req['full-header-mode'], true);
    assert.equal(req.timeout, 4);
    assert.notEqual(req.insecure, true);
  }
  assert.equal(r.requests[1].body, '');
  assert.match(r.text, /成功 1，已签到 0，失败 0/);
  assert.match(r.text, /获得 \$25/);
});

test('cron persists server-rotated sessions before using them for later requests', async () => {
  const r = await run({ store: stored(), reply: ({ index, request: req }) => {
    if (index === 0) return { status: 200, headers: { 'Set-Cookie': 'session=rotated-session; Path=/; HttpOnly' }, body: authBody(123) };
    return { status: 200, body: req.url.endsWith('/self') ? authBody(123) : req.url.endsWith('/status') ? STATUS : OK };
  } });
  assert.deepEqual(JSON.parse(r.values[KEY]).accounts, [{ ...ACCOUNT, session: 'rotated-session' }]);
  assert.equal(r.requests[1].headers.Cookie, 'session=rotated-session');
  assert.equal(r.requests[2].headers.Cookie, 'session=rotated-session');
  assert.match(r.text, /成功 1，已签到 0，失败 0/);
});

test('an empty successful message means already signed in, without invented reward', async () => {
  const r = await run({ store: stored(), reply: ({ request: req }) => ({ status: 200, body: req.url.endsWith('/self') ? authBody(123) : { success: true, message: '' } }) });
  assert.match(r.text, /成功 0，已签到 1，失败 0/);
  assert.match(r.text, /今日已签到/);
  assert.doesNotMatch(r.text, /获得|\$25/);
});

for (const [name, response] of Object.entries({
  '401': { status: 401, body: { success: false } },
  '403': { status: 403, body: 'Forbidden' },
  '429': { status: 429, body: 'Too Many Requests' },
  'HTTP200 HTML': { status: 200, body: '<html>please log in</html>' },
  'missing success': { status: 200, body: { message: 'OK' } },
  'string success': { status: 200, body: { success: 'true', message: 'OK' } },
  'denied': { status: 200, body: { success: false, message: '业务拒绝' } },
  'missing message': { status: 200, body: { success: true } },
  'malformed message': { status: 200, body: { success: true, message: 1 } },
  'network error': { error: 'connection failed' },
  'redirect': { status: 302, headers: { Location: 'https://other.example/' }, body: '' },
})) {
  test(`cron reports ${name} as a failure without retrying an ambiguous POST`, async () => {
    const r = await run({ store: stored(), reply: ({ request: req }) => req.url.endsWith('/self') ? { status: 200, body: authBody(123) } : response });
    assert.equal(r.requests.length, 2);
    assert.match(r.text, /成功 0，已签到 0，失败 1/);
    assert.doesNotMatch(r.text, /签到成功|获得 \$25/);
    if (name === '403') assert.match(r.text, /签到 HTTP 403：Forbidden/);
  });
}

test('HTTP errors include a sanitized response reason and gateway hint', async () => {
  const r = await run({ store: stored(), reply: ({ request: req }) => req.url.endsWith('/self') ? {
    status: 403,
    headers: { server: 'ESA', 'x-tengine-error': 'denied by http_custom' },
    body: 'Forbidden',
  } : { status: 200, body: OK } });
  assert.match(r.text, /账号验证 HTTP 403：Forbidden/);
  assert.match(r.text, /网关: denied by http_custom/);
});

test('JSON HTTP errors expose the server message', async () => {
  const r = await run({ store: stored(), reply: ({ request: req }) => req.url.endsWith('/self') ? {
    status: 401,
    body: { success: false, message: '无权进行此操作，未登录且未提供 access token' },
  } : { status: 200, body: OK } });
  assert.match(r.text, /账号验证 HTTP 401：无权进行此操作，未登录且未提供 access token/);
});

test('a mismatched or denied preflight identity never submits a sign-in POST', async () => {
  for (const body of [authBody(456), { success: false, message: '未登录' }, { success: true, data: {} }]) {
    const r = await run({ store: stored(), reply: () => ({ status: 200, body }) });
    assert.equal(r.requests.length, 1);
    assert.match(r.text, /失败 1/);
  }
});

test('real WAF HTML is solved locally and challenge cookies are merged into the retry', async () => {
  const r = await run({ store: stored(), reply: ({ index, request: req }) => index === 0 ? {
    status: 200,
    headers: [{ field: 'Set-Cookie', value: 'acw_tc=first; Path=/' }, { field: 'set-cookie', value: 'cdn_sec_tc=second; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/' }],
    body: WAF,
  } : { status: 200, body: req.url.endsWith('/self') ? authBody(123) : OK } });
  assert.equal(r.requests.length, 5);
  assert.equal(r.requests[0].method, 'GET');
  assert.equal(r.requests[1].method, 'GET');
  for (const req of r.requests.slice(1)) {
    assert.match(req.headers.Cookie, new RegExp(`acw_sc__v2=${SOLVED}`));
    assert.match(req.headers.Cookie, /acw_tc=first/);
    assert.match(req.headers.Cookie, /cdn_sec_tc=second/);
    assert.match(req.headers.Cookie, /session=test-session-value==/);
  }
  assert.equal(r.writes.length, 0, 'ephemeral WAF cookies must not rewrite persistent login state');
  assert.match(r.text, /成功 1/);
});

test('a WAF page on POST retries only that rejected challenge and keeps the empty body', async () => {
  const r = await run({ store: stored(), reply: ({ index, request: req }) => ({ status: 200, body: index === 1 ? WAF : req.url.endsWith('/self') ? authBody(123) : OK }) });
  assert.deepEqual(r.requests.map(req => req.method), ['GET', 'POST', 'POST', 'GET', 'GET']);
  assert.equal(r.requests[2].body, '');
  assert.match(r.requests[2].headers.Cookie, new RegExp(`acw_sc__v2=${SOLVED}`));
  assert.match(r.text, /成功 1/);
});

test('repeated WAF challenges stop after two retries with a clear failure', async () => {
  const r = await run({ store: stored(), reply: () => ({ status: 200, body: WAF }) });
  assert.equal(r.requests.length, 3);
  assert.match(r.text, /动态验证.*失败|动态验证.*上限/);
  assert.match(r.text, /失败 1/);
});

test('an unsupported challenge is never evaluated or treated as a success', async () => {
  const r = await run({ store: stored(), reply: () => ({ status: 200, body: WAF.replace('0xf,0x23', '0x23,0xf') }) });
  assert.equal(r.requests.length, 1);
  assert.match(r.text, /验证.*格式/);
});

test('combined Set-Cookie headers handle expiry commas and delete expired cookies', async () => {
  const r = await run({ store: stored(), reply: ({ index, request: req }) => index === 0 ? {
    status: 403, headers: { 'sEt-CoOkIe': 'acw_tc=valid; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/, cdn_sec_tc=removed; Max-Age=0; Path=/' }, body: WAF,
  } : { status: 200, body: req.url.endsWith('/self') ? authBody(123) : OK } });
  assert.match(r.requests[1].headers.Cookie, /acw_tc=valid/);
  assert.doesNotMatch(r.requests[1].headers.Cookie, /cdn_sec_tc/);
  assert.match(r.text, /成功 1/);
});

test('multiple accounts have isolated sessions, UA values, headers and WAF jars', async () => {
  const other = { id: 456, session: 'different-session', userAgent: 'second-device-UA' };
  let seen = false;
  const r = await run({ store: stored([ACCOUNT, other]), reply: ({ request: req }) => {
    const id = Number(req.headers['New-API-User']);
    if (id === 123 && !seen) { seen = true; return { status: 200, body: WAF }; }
    return { status: 200, body: req.url.endsWith('/self') ? authBody(id) : id === 456 ? { success: true, message: '' } : OK };
  } });
  const second = r.requests.filter(req => req.headers['New-API-User'] === '456');
  assert.equal(second.length, 3);
  for (const req of second) {
    assert.equal(req.headers.Cookie, 'session=different-session');
    assert.equal(req.headers['User-Agent'], 'second-device-UA');
  }
  assert.match(r.text, /成功 1，已签到 1，失败 0/);
});

test('a broken account does not stop another account from checking in', async () => {
  const other = { id: 456, session: 'different-session', userAgent: 'second-UA' };
  const r = await run({ store: stored([ACCOUNT, other]), reply: ({ request: req }) => req.headers['New-API-User'] === '123' ? { status: 401, body: {} } : { status: 200, body: req.url.endsWith('/self') ? authBody(456) : OK } });
  assert.match(r.text, /成功 1，已签到 0，失败 1/);
});

test('empty, malformed or excessive account configuration never sends a request', async () => {
  for (const store of [{}, { [KEY]: '{' }, stored(Array.from({ length: 11 }, (_, i) => ({ ...ACCOUNT, id: i + 1 })))]) {
    const r = await run({ store });
    assert.equal(r.requests.length, 0);
    assert.match(r.text, /登录|存储|配置/);
  }
});

test('legacy Telegram settings never send a push or change the local check-in result', async () => {
  for (const settings of [{ TG_BOT_TOKEN: '123456:test-bot-token', TG_CHAT_ID: '-1234' }, { TG_BOT_TOKEN: '123456:test-bot-token' }, { TG_CHAT_ID: '-1234' }]) {
    const store = { ...stored(), ...settings };
    const r = await run({ store });
    assert.deepEqual(r.requests.map(req => req.url), [`${BASE}/api/user/self`, `${BASE}/api/user/sign_in`, `${BASE}/api/user/self`, `${BASE}/api/status`]);
    assert.match(r.text, /成功 1，已签到 0，失败 0/);
    assert.doesNotMatch(r.text, /Telegram|test-bot-token/);
    assert.equal(r.notifications.length, 1);
    assert.deepEqual(r.values, store);
  }
});

test('local notifications redact the stored session while preserving unrelated business text', async () => {
  const r = await run({ store: stored(), reply: ({ request: req }) => ({ status: 200, body: req.url.endsWith('/self') ? authBody(123) : { success: false, message: `denied session=${SESSION}; reference=123456:request-id` } }) });
  const visible = r.text + r.logs.join('\n');
  assert.equal(visible.includes(SESSION), false);
  assert.match(r.text, /reference=123456:request-id/);
  assert.match(r.text, /成功 0，已签到 0，失败 1/);
});

test('module matches only authenticated self responses and schedules one daily run', () => {
  const module = fs.readFileSync(modulePath, 'utf8');
  const capture = module.split('\n').find(line => line.startsWith('AnyRouter_Capture'));
  assert.match(capture, /type=http-response(?:,|$)/);
  assert.match(capture, /requires-body=true(?:,|$)/);
  const pattern = new RegExp(capture.match(/pattern=([^,]+)/)[1]);
  assert.equal(pattern.test(`${BASE}/api/user/self`), true);
  assert.equal(pattern.test(`${BASE}/api/user/self?source=console`), true);
  for (const url of ['http://anyrouter.top/api/user/self', 'https://anyrouter.top.evil.test/api/user/self', `${BASE}/api/user/self/more`, `${BASE}/console`]) assert.equal(pattern.test(url), false, url);
  const cron = module.split('\n').filter(line => /type=cron(?:,|$)/.test(line));
  assert.equal(cron.length, 1);
  assert.match(cron[0], /cronexp="30 9 \* \* \*"/);
  assert.match(cron[0], /timeout=\d+(?:,|$)/);
  assert.match(module, /hostname\s*=\s*%APPEND% anyrouter\.top/);
  const paths = [...module.matchAll(/script-path=([^,\n]+)/g)].map(m => m[1]);
  assert.equal(paths.length, 2);
  assert.equal(paths[0], paths[1]);
  assert.match(paths[0], /^https:\/\/raw\.githubusercontent\.com\/zxc-1\/Scripts\/(?:refs\/heads\/main|[a-f0-9]{40})\/Surge\/anyrouter\.surge\.js$/);
});


test('the module timeout covers ten slow accounts with two challenges on each API', async () => {
  const accounts = Array.from({ length: 10 }, (_, index) => ({ ...ACCOUNT, id: index + 1, session: `synthetic-session-${index + 1}` }));
  const r = await run({ store: stored(accounts), now: 0, elapseMs: 4000, reply: ({ request: req, index }) => ({
    status: 200,
    body: index % 3 < 2 ? WAF : req.url.endsWith('/status') ? STATUS : req.url.endsWith('/self') ? authBody(Number(req.headers['New-API-User'])) : OK,
  }) });
  assert.equal(r.requests.length, 93);
  assert.equal(r.now, 372000);
  assert.ok(r.requests.every(req => req.timeout === 4));
  assert.match(r.text, /成功 10，已签到 0，失败 0/);
  assert.doesNotMatch(r.text, /时间预算|未发送/);
  const module = fs.readFileSync(modulePath, 'utf8');
  const cron = module.split('\n').find(line => line.startsWith('AnyRouter_Checkin'));
  const timeoutSeconds = Number(cron.match(/timeout=(\d+)(?:,|$)/)?.[1]);
  assert.ok(timeoutSeconds * 1000 > r.now, `${timeoutSeconds}s module timeout cannot cover ${r.now}ms of requests plus script work`);
});

test('accounts are checked sequentially to avoid bursts against the WAF', async () => {
  const r = await run({ store: stored([ACCOUNT, { ...ACCOUNT, id: 456, session: 'other-session' }]) });
  assert.deepEqual(r.requests.map(req => req.headers['New-API-User']), ['123', '123', '123', '123', '456', '456', '456']);
});


test('notification shows fresh post-check-in quota using the server conversion rate', async () => {
  let selfCalls = 0;
  const r = await run({ store: stored(), reply: ({ request: req }) => {
    if (req.url.endsWith('/status')) return { status: 200, body: { ...STATUS, data: { quota_per_unit: 100 } } };
    if (req.url.endsWith('/self')) {
      selfCalls++;
      return { status: 200, body: { ...authBody(123), data: { id: 123, quota: selfCalls === 1 ? 10000 : 12500, used_quota: 5000 } } };
    }
    return { status: 200, body: OK };
  } });
  assert.deepEqual(r.notifications[0], [
    '[AnyRouter] 签到成功（1 个账号）', '成功 1，已签到 0，失败 0',
    '✅ 账号 123\n签到成功，获得 $25 额度\n剩余额度: $125.00｜已用: $50.00｜总额度: $175.00',
  ]);
  assert.equal(selfCalls, 2);
  assert.equal(r.requests.filter(req => req.method === 'POST').length, 1);
});

test('multi-account notification separates accounts and totals fresh balances before rounding', async () => {
  const r = await run({ store: stored([ACCOUNT, { ...ACCOUNT, id: 456, session: 'other-session' }]), reply: ({ request: req }) => {
    const id = Number(req.headers['New-API-User']);
    if (req.url.endsWith('/status')) return { status: 200, body: STATUS };
    if (req.url.endsWith('/self')) return { status: 200, body: id === 123 ? authBody(id) : { ...authBody(id), data: { id, quota: 37500000, used_quota: 12500000 } } };
    return { status: 200, body: id === 123 ? OK : { success: true, message: '' } };
  } });
  assert.equal(r.notifications[0][0], '[AnyRouter] 签到完成（2 个账号）');
  assert.match(r.text, /成功 1，已签到 1，失败 0/);
  assert.match(r.text, /剩余额度: \$125.00｜已用: \$50.00｜总额度: \$175.00\n\n🟡 账号 456\n今日已签到\n剩余额度: \$75.00｜已用: \$25.00｜总额度: \$100.00/);
  assert.match(r.text, /📊 2 个账号合计\n剩余额度: \$200.00｜已用: \$75.00｜总额度: \$275.00/);
  assert.equal(r.requests.filter(req => req.url.endsWith('/status')).length, 1);
});

test('zero and overdrawn balances are displayed without inventing credits', async () => {
  for (const quota of [0, -500000]) {
    const r = await run({ store: stored(), reply: ({ request: req }) => ({ status: 200,
      body: req.url.endsWith('/status') ? STATUS : req.url.endsWith('/self') ? { ...authBody(123), data: { id: 123, quota, used_quota: 1000000 } } : OK,
    }) });
    assert.match(r.text, new RegExp(`剩余额度: \\\$${quota === 0 ? '0.00' : '-1.00'}｜已用: \\\$2.00｜总额度: \\\$${quota === 0 ? '2.00' : '1.00'}`));
  }
});

test('aggregate rounds the underlying quota instead of adding rounded account amounts', async () => {
  const r = await run({ store: stored([ACCOUNT, { ...ACCOUNT, id: 456 }]), reply: ({ request: req }) => ({ status: 200,
    body: req.url.endsWith('/status') ? { ...STATUS, data: { quota_per_unit: 3 } } : req.url.endsWith('/self') ? { success: true, data: { id: Number(req.headers['New-API-User']), quota: 1, used_quota: 1 } } : OK,
  }) });
  assert.match(r.text, /📊 2 个账号合计\n剩余额度: \$0.67｜已用: \$0.67｜总额度: \$1.33/);
});

test('failed login uses the failure icon and never shows an account balance', async () => {
  const r = await run({ store: stored(), reply: () => ({ status: 401, body: {} }) });
  assert.equal(r.notifications[0][0], '[AnyRouter] 签到失败（1 个账号）');
  assert.match(r.text, /❌ 账号 123\n.*401.*\n账户额度: 未获取/);
  assert.doesNotMatch(r.text, /剩余额度|签到成功/);
  assert.equal(r.requests.length, 1);
});

test('a failed balance refresh preserves the confirmed check-in and does not reuse preflight quota', async () => {
  for (const response of [
    { status: 401, body: {} }, { error: 'network failed' },
    { status: 200, body: authBody(456) }, { status: 200, body: { success: false, message: 'denied' } },
    { status: 200, body: '<html>not JSON</html>' },
  ]) {
    const r = await run({ store: stored(), reply: ({ request: req, index }) => index > 1 ? response : { status: 200, body: req.url.endsWith('/self') ? authBody(123) : OK } });
    assert.match(r.text, /成功 1，已签到 0，失败 0/);
    assert.match(r.text, /✅ 账号 123\n签到成功/);
    assert.match(r.text, /额度查询失败:/);
    assert.doesNotMatch(r.text, /剩余额度|\$125.00/);
    assert.equal(r.requests.filter(req => req.method === 'POST').length, 1);
  }
});

test('missing or malformed quota fields report an explicit query failure', async () => {
  for (const fields of [
    { quota: null, used_quota: 0 }, { quota: '', used_quota: 0 }, { used_quota: 0 },
    { quota: '500000', used_quota: 0 }, { quota: 500000 }, { quota: 0, used_quota: -1 },
    { quota: 0.5, used_quota: 0 }, { quota: Number.MAX_SAFE_INTEGER + 1, used_quota: 0 },
  ]) {
    const r = await run({ store: stored(), reply: ({ request: req }) => ({ status: 200,
      body: req.url.endsWith('/status') ? STATUS : req.url.endsWith('/self') ? { success: true, data: { id: 123, ...fields } } : OK,
    }) });
    assert.match(r.text, /成功 1，已签到 0，失败 0/);
    assert.match(r.text, /额度查询失败:.*额度/);
    assert.doesNotMatch(r.text, /剩余额度|NaN|Infinity/);
  }
});

test('invalid conversion configuration never invents a dollar conversion or prevents checking in', async () => {
  for (const response of [
    { status: 200, body: { success: false, data: { quota_per_unit: 500000 } } },
    { status: 200, body: { success: true, data: { quota_per_unit: null } } },
    { status: 200, body: { success: true, data: { quota_per_unit: 0 } } },
    { status: 200, body: { success: true, data: {} } }, { status: 500, body: '' },
  ]) {
    const r = await run({ store: stored(), reply: ({ request: req }) => req.url.endsWith('/status') ? response : { status: 200, body: req.url.endsWith('/self') ? authBody(123) : OK } });
    assert.match(r.text, /成功 1，已签到 0，失败 0/);
    assert.match(r.text, /额度查询失败:/);
    assert.doesNotMatch(r.text, /剩余额度|NaN|Infinity/);
    assert.equal(r.requests.filter(req => req.method === 'POST').length, 1);
  }
});

test('partial quota totals identify only the accounts whose latest balance was obtained', async () => {
  let firstSelf = 0;
  const r = await run({ store: stored([ACCOUNT, { ...ACCOUNT, id: 456 }]), reply: ({ request: req }) => {
    const id = Number(req.headers['New-API-User']);
    if (req.url.endsWith('/status')) return { status: 200, body: STATUS };
    if (req.url.endsWith('/self')) {
      if (id === 123 && ++firstSelf === 2) return { status: 500, body: '' };
      return { status: 200, body: authBody(id) };
    }
    return { status: 200, body: OK };
  } });
  assert.match(r.text, /成功 2，已签到 0，失败 0/);
  assert.match(r.text, /额度查询失败:/);
  assert.match(r.text, /📊 1\/2 个账号合计（已获取额度）\n剩余额度: \$125.00｜已用: \$50.00｜总额度: \$175.00/);
  assert.doesNotMatch(r.text, /📊 2 个账号合计/);
});
