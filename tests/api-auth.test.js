// 每條 /api 路由的授權清單測試。
// 路由從 agent/index.js 的 handleRequest 原始碼掃出來，跟下面 ROUTES 表逐條對：
// 新加一條 /api 路由卻沒在表上標「要登入／不用登入」，這個測試就會紅。
// 不用登入的路由全部明列在 PUBLIC 白名單；其餘每條不帶 token 都要回 401。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXED_TOKEN = 'api-auth-fixed-token';
const FAKE_ID = '00000000-0000-4000-8000-000000000000';

// key＝原始碼裡的寫法（固定路徑或 match 的 regex 原文）；sample＝實打用的路徑。
const ROUTES = [
  { method: 'POST', key: '/api/tasks', sample: '/api/tasks', auth: 'required' },
  { method: 'POST', key: '/^\\/api\\/tasks\\/([^/]+)\\/resume$/', sample: `/api/tasks/${FAKE_ID}/resume`, auth: 'required' },
  { method: 'POST', key: '/api/chat', sample: '/api/chat', auth: 'required' },
  { method: 'GET', key: '/^\\/api\\/tasks\\/([^/]+)\\/result$/', sample: `/api/tasks/${FAKE_ID}/result`, auth: 'required' },

  // PUBLIC 白名單：只讀、只綁 127.0.0.1 的狀態查詢，不帶 token 也回資料。
  { method: 'GET', key: '/api/session', sample: '/api/session', auth: 'public' },
  { method: 'GET', key: '/api/health', sample: '/api/health', auth: 'public' },
  { method: 'GET', key: '/api/hud', sample: '/api/hud', auth: 'public' },
  { method: 'GET', key: '/api/settings', sample: '/api/settings', auth: 'public' },
  { method: 'GET', key: '/api/doctor', sample: '/api/doctor', auth: 'public' },
  { method: 'GET', key: '/api/memory', sample: '/api/memory', auth: 'public' },
  { method: 'GET', key: '/^\\/api\\/memory\\/([^/]+)$/', sample: '/api/memory/not-there.md', auth: 'public' },
  { method: 'GET', key: '/api/logs', sample: '/api/logs', auth: 'public' },
  { method: 'GET', key: '/api/tasks', sample: '/api/tasks', auth: 'public' },
  { method: 'GET', key: '/api/events', sample: '/api/events', auth: 'public' },
  { method: 'GET', key: '/api/inbox', sample: '/api/inbox', auth: 'public' },
  { method: 'GET', key: '/^\\/api\\/tasks\\/([^/]+)\\/progress$/', sample: `/api/tasks/${FAKE_ID}/progress`, auth: 'public' },
  { method: 'GET', key: '/^\\/api\\/tasks\\/([0-9a-f-]{36})$/i', sample: `/api/tasks/${FAKE_ID}`, auth: 'public' },
];

function routeId(method, key) {
  return `${method} ${key}`;
}

// 掃 handleRequest：`req.method === 'X' && url.pathname === '/api/...'` 和
// `const fooMatch = url.pathname.match(/^\/api.../)` + `req.method === 'X' && fooMatch` 兩種寫法。
function scanApiRoutes() {
  const source = fs.readFileSync(path.join(ROOT_DIR, 'agent', 'index.js'), 'utf8');
  const start = source.indexOf('async function handleRequest(');
  const end = source.indexOf('function createRuntimeServer(', start);
  assert.ok(start >= 0 && end > start, 'handleRequest not found in agent/index.js');
  const body = source.slice(start, end);

  const found = new Set();
  for (const m of body.matchAll(/req\.method === '([A-Z]+)' && url\.pathname === '([^']+)'/g)) {
    if (m[2].startsWith('/api')) {
      found.add(routeId(m[1], m[2]));
    }
  }
  for (const m of body.matchAll(/const (\w+) = url\.pathname\.match\((\/\^.*?\$\/[a-z]*)\);/g)) {
    if (!m[2].startsWith('/^\\/api')) {
      continue;
    }
    const methods = [...body.matchAll(new RegExp(`req\\.method === '([A-Z]+)' && ${m[1]}\\b`, 'g'))];
    assert.ok(methods.length > 0, `no method check found for ${m[1]}`);
    for (const mm of methods) {
      found.add(routeId(mm[1], m[2]));
    }
  }
  return found;
}

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

function request(port, method, route) {
  return new Promise((resolve, reject) => {
    const body = method === 'POST' ? JSON.stringify({ title: 'no login', instruction: 'should be rejected', message: 'hi' }) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

let port;
let agent;
let server;

test.before(async () => {
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.MOCK_WORKER = '1';
  process.env.AIWFF_WORKER_PROVIDER = '';
  process.env.AIWFF_RUNTIME_TOKEN = FIXED_TOKEN;
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
  agent.initRuntimeToken();
  server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('原始碼裡每條 /api 路由都在 ROUTES 表上，表上也沒有已經不存在的路由', () => {
  const found = scanApiRoutes();
  const listed = new Set(ROUTES.map((r) => routeId(r.method, r.key)));
  const unlisted = [...found].filter((id) => !listed.has(id));
  const stale = [...listed].filter((id) => !found.has(id));
  assert.deepEqual(unlisted, [], 'new /api route(s) not classified in ROUTES (mark auth: required or add to PUBLIC)');
  assert.deepEqual(stale, [], 'ROUTES lists route(s) no longer in handleRequest');
});

for (const route of ROUTES.filter((r) => r.auth === 'required')) {
  test(`未登入 ${route.method} ${route.sample} → 401`, async () => {
    const response = await request(port, route.method, route.sample);
    assert.equal(response.status, 401, response.raw);
  });
}

for (const route of ROUTES.filter((r) => r.auth === 'public')) {
  test(`白名單 ${route.method} ${route.sample} 不登入也不回 401`, async () => {
    const response = await request(port, route.method, route.sample);
    assert.notEqual(response.status, 401, response.raw);
  });
}
