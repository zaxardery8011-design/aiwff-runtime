// 連建 3 張單，要照建單順序開跑。
// 用 openai_compatible worker 接一個假的 chat completions 端點：每張單開跑時會帶 x-aiwff-task-id
// 打過來，假端點記下到達順序，就是 runtime 實際放出 worker 的順序。
// 現在每張單建好當下就開跑；以後若改成排隊、限流，這支測試仍要求先建的先跑。
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXED_TOKEN = 'submit-order-fixed-token';

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

function startFakeOpenAI() {
  const arrivals = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      arrivals.push(req.headers['x-aiwff-task-id']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, arrivals }));
  });
}

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-aiwff-runtime-token': FIXED_TOKEN,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let port;
let server;
let fake;

test.before(async () => {
  fake = await startFakeOpenAI();
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.MOCK_WORKER = '';
  process.env.AIWFF_WORKER_PROVIDER = 'openai_compatible';
  process.env.AIWFF_OPENAI_BASE_URL = `http://127.0.0.1:${fake.port}/v1`;
  process.env.AIWFF_OPENAI_MODEL = 'submit-order-test';
  process.env.AIWFF_RUNTIME_TOKEN = FIXED_TOKEN;
  const agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
  agent.initRuntimeToken();
  server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fake.server.close(resolve));
});

test('連建 3 張單：worker 開跑順序＝建單順序，3 張都做完', async () => {
  const ids = [];
  for (const n of [1, 2, 3]) {
    const created = await request(port, 'POST', '/api/tasks', { title: `order-${n}`, instruction: `第 ${n} 張` });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    ids.push(created.json.id);
  }

  await waitFor(() => fake.arrivals.length >= 3, 5000, '3 worker requests');
  assert.deepEqual(fake.arrivals, ids, 'workers must start in the order the tasks were submitted');

  const tasks = [];
  for (const id of ids) {
    tasks.push(
      await waitFor(
        async () => {
          const res = await request(port, 'GET', `/api/tasks/${id}`);
          const task = res.json && (res.json.task || res.json);
          return task && ['done', 'failed', 'blocked'].includes(task.status) ? task : null;
        },
        5000,
        `task ${id} to finish`,
      ),
    );
  }
  assert.deepEqual(
    tasks.map((task) => task.status),
    ['done', 'done', 'done'],
    tasks.map((task) => task.error || '').join(' | '),
  );

  const createdAt = tasks.map((task) => task.created_at);
  assert.deepEqual([...createdAt].sort(), createdAt, 'created_at must not go backwards in submit order');
});
