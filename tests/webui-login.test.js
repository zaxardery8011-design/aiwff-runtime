// WebUI 一次性登入連結（Jupyter 模式）測試。
// 在同一個 process 內起 runtime server（不 spawn daemon），每個測試結束自己 close。
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXED_TOKEN = 'webui-login-fixed-token';

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.listen(0, '127.0.0.1');
  });
}

function request(port, method, route, { headers = {}, payload } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let port;
let agent;

// PORT / MOCK_WORKER 必須在 require 前設好（PORT 在模組載入時讀取，同源檢查會用到）。
test.before(async () => {
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.MOCK_WORKER = '1';
  process.env.AIWFF_WORKER_PROVIDER = '';
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
});

async function withServer(tokenEnv, fn) {
  if (tokenEnv == null) {
    delete process.env.AIWFF_RUNTIME_TOKEN;
  } else {
    process.env.AIWFF_RUNTIME_TOKEN = tokenEnv;
  }
  const init = agent.initRuntimeToken();
  const server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    await fn(init);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function cookieFrom(response) {
  const setCookie = response.headers['set-cookie'] || [];
  assert.equal(setCookie.length, 1, 'expected exactly one Set-Cookie');
  return setCookie[0].split(';')[0];
}

async function login(token) {
  const response = await request(port, 'GET', `/?token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 302);
  return cookieFrom(response);
}

async function waitForTaskDone(taskId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await request(port, 'GET', `/api/tasks/${taskId}`);
    if (response.json && response.json.task && ['done', 'failed', 'blocked'].includes(response.json.task.status)) {
      return response.json.task;
    }
    await sleep(200);
  }
  throw new Error(`task ${taskId} did not finish`);
}

test('未登入 POST /api/tasks → 401', async () => {
  await withServer(FIXED_TOKEN, async () => {
    const response = await request(port, 'POST', '/api/tasks', {
      payload: { title: 'no login', instruction: 'should be rejected' },
    });
    assert.equal(response.status, 401);
    assert.match(response.json.error, /token/i);

    const session = await request(port, 'GET', '/api/session');
    assert.equal(session.status, 200);
    assert.equal(session.json.loggedIn, false);
  });
});

test('錯的 ?token= 不發 cookie（回 401）', async () => {
  await withServer(FIXED_TOKEN, async () => {
    const response = await request(port, 'GET', '/?token=wrong-token');
    assert.equal(response.status, 401);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers.location, undefined);
  });
});

test('正確 ?token= → 302 + Set-Cookie HttpOnly SameSite=Strict，並去掉 token 保留其他參數', async () => {
  await withServer(FIXED_TOKEN, async () => {
    const response = await request(port, 'GET', `/?tab=chat&token=${FIXED_TOKEN}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/?tab=chat');
    const setCookie = response.headers['set-cookie'];
    assert.equal(setCookie.length, 1);
    assert.match(setCookie[0], new RegExp(`^${agent.RUNTIME_TOKEN_COOKIE}=${FIXED_TOKEN};`));
    assert.match(setCookie[0], /;\s*HttpOnly/i);
    assert.match(setCookie[0], /;\s*SameSite=Strict/i);
    assert.match(setCookie[0], /;\s*Path=\//);

    const session = await request(port, 'GET', '/api/session', { headers: { cookie: cookieFrom(response) } });
    assert.equal(session.json.loggedIn, true);
  });
});

test('cookie 名稱帶 port：兩個不同 port 的 cookie 互不覆蓋', async () => {
  const otherPort = port === 65535 ? port - 1 : port + 1;
  const mine = agent.runtimeTokenCookieName(port);
  const other = agent.runtimeTokenCookieName(otherPort);
  assert.equal(agent.RUNTIME_TOKEN_COOKIE, mine);
  assert.notEqual(mine, other);

  await withServer(FIXED_TOKEN, async () => {
    const cookie = await login(FIXED_TOKEN);
    assert.equal(cookie, `${mine}=${FIXED_TOKEN}`);

    // 瀏覽器同時帶著另一個 port 的 runtime cookie：不影響本 port 的登入。
    const both = await request(port, 'GET', '/api/session', {
      headers: { cookie: `${other}=other-runtime-token; ${cookie}` },
    });
    assert.equal(both.json.loggedIn, true);

    // 只帶另一個 port 的 cookie（即使值是本 port 的正確 token）不算登入。
    const otherOnly = await request(port, 'GET', '/api/session', {
      headers: { cookie: `${other}=${FIXED_TOKEN}` },
    });
    assert.equal(otherOnly.json.loggedIn, false);
  });
});

test('帶 cookie 的同源 POST /api/tasks → 通過授權（MOCK_WORKER=1）', async () => {
  await withServer(FIXED_TOKEN, async () => {
    const cookie = await login(FIXED_TOKEN);
    const response = await request(port, 'POST', '/api/tasks', {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
      payload: { title: 'cookie login', instruction: 'should be accepted' },
    });
    assert.equal(response.status, 201, response.raw);
    assert.match(response.json.id, /^[0-9a-f-]{36}$/i);
    await waitForTaskDone(response.json.id);
  });
});

test('帶 cookie 但跨來源 Origin → 403', async () => {
  await withServer(FIXED_TOKEN, async () => {
    const cookie = await login(FIXED_TOKEN);
    const response = await request(port, 'POST', '/api/tasks', {
      headers: { cookie, origin: 'https://example.invalid' },
      payload: { title: 'csrf', instruction: 'should be rejected' },
    });
    assert.equal(response.status, 403);
    assert.match(response.json.error, /Cross-origin/);
  });
});

test('未設 AIWFF_RUNTIME_TOKEN：自動產生 token，登入連結能用', async () => {
  await withServer(null, async (init) => {
    assert.equal(init.generated, true);
    const loginUrl = new URL(agent.runtimeLoginUrl());
    assert.equal(loginUrl.origin, `http://127.0.0.1:${port}`);
    const token = loginUrl.searchParams.get('token');
    assert.match(token, /^[0-9a-f]{48}$/);

    // 沒設 env 不再代表「全部拒絕」，但沒 token 仍然 401。
    const anonymous = await request(port, 'POST', '/api/tasks', {
      payload: { title: 'no login', instruction: 'should be rejected' },
    });
    assert.equal(anonymous.status, 401);

    const response = await request(port, 'GET', `${loginUrl.pathname}${loginUrl.search}`);
    assert.equal(response.status, 302);
    const cookie = cookieFrom(response);
    const created = await request(port, 'POST', '/api/tasks', {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
      payload: { title: 'auto token', instruction: 'should be accepted' },
    });
    assert.equal(created.status, 201, created.raw);
    await waitForTaskDone(created.json.id);
  });

  // 每次啟動換新 token：舊連結的 token 在下一次 init 後失效。
  await withServer(null, async () => {
    const first = new URL(agent.runtimeLoginUrl()).searchParams.get('token');
    agent.initRuntimeToken();
    const second = new URL(agent.runtimeLoginUrl()).searchParams.get('token');
    assert.notEqual(first, second);
    const stale = await request(port, 'GET', `/?token=${first}`);
    assert.equal(stale.status, 401);
  });
});
