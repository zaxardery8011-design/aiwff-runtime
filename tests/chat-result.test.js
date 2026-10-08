// GET /api/tasks/:id/result（對話分頁顯示回答）測試。
// 在同一個 process 內起 runtime server（不 spawn daemon），每個測試結束自己 close；
// 自己種的 data/tasks、data/artifacts 檔案在 after 裡清掉。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');
const FIXED_TOKEN = 'chat-result-fixed-token';
const MAX_BYTES = 64 * 1024;

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
        res.setEncoding('utf8');
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
const createdFiles = [];

// PORT / MOCK_WORKER 必須在 require 前設好（PORT 在模組載入時讀取）。
test.before(async () => {
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.MOCK_WORKER = '1';
  process.env.AIWFF_WORKER_PROVIDER = '';
  process.env.AIWFF_RUNTIME_TOKEN = FIXED_TOKEN;
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
});

test.after(() => {
  for (const file of createdFiles) {
    fs.rmSync(file, { force: true });
  }
});

async function withServer(fn) {
  agent.initRuntimeToken();
  const server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    await fn();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function track(file) {
  createdFiles.push(file);
  return file;
}

// 直接種一筆任務（不跑 worker），可選擇一併寫產出檔。
function seedTask(status, artifact) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  fs.writeFileSync(
    track(path.join(TASKS_DIR, `${id}.json`)),
    `${JSON.stringify({ id, title: 'seed', instruction: 'seed', status, created_at: now, updated_at: now }, null, 2)}\n`,
  );
  if (artifact) {
    fs.writeFileSync(track(path.join(ARTIFACTS_DIR, `${id}.result.${artifact.ext}`)), artifact.content);
  }
  return id;
}

const authHeader = { 'x-aiwff-runtime-token': FIXED_TOKEN };

async function login() {
  const response = await request(port, 'GET', `/?token=${encodeURIComponent(FIXED_TOKEN)}`);
  assert.equal(response.status, 302);
  return response.headers['set-cookie'][0].split(';')[0];
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

test('未帶 token → 401', async () => {
  const id = seedTask('done', { ext: 'md', content: 'secret answer\n' });
  await withServer(async () => {
    const response = await request(port, 'GET', `/api/tasks/${id}/result`);
    assert.equal(response.status, 401);
    assert.equal(response.json.ok, false);
    assert.doesNotMatch(response.raw, /secret answer/);
  });
});

test('錯 token（header / Bearer / cookie）→ 401', async () => {
  const id = seedTask('done', { ext: 'md', content: 'secret answer\n' });
  await withServer(async () => {
    for (const headers of [
      { 'x-aiwff-runtime-token': 'wrong-token' },
      { authorization: 'Bearer wrong-token' },
      { cookie: `${agent.RUNTIME_TOKEN_COOKIE}=wrong-token` },
    ]) {
      const response = await request(port, 'GET', `/api/tasks/${id}/result`, { headers });
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.doesNotMatch(response.raw, /secret answer/);
    }
  });
});

test('id 格式不符（含路徑穿越）→ 400', async () => {
  await withServer(async () => {
    for (const badId of ['not-a-uuid', '..%2F..%2Fpackage', '..%5C..%5Cpackage', '%2e%2e%2fpackage', 'abc.json']) {
      const response = await request(port, 'GET', `/api/tasks/${badId}/result`, { headers: authHeader });
      assert.equal(response.status, 400, `${badId} → ${response.status} ${response.raw}`);
      assert.equal(response.json.ok, false);
    }
  });
});

test('progress：id 字元不符、超長、%XX 壞掉 → 400', async () => {
  await withServer(async () => {
    for (const badId of ['..%2F..%2Fpackage', '%E0%A4%A', 'a'.repeat(129)]) {
      const response = await request(port, 'GET', `/api/tasks/${badId}/progress`, { headers: authHeader });
      assert.equal(response.status, 400, `${badId.slice(0, 20)} → ${response.status} ${response.raw}`);
      assert.equal(response.json.ok, false);
    }
    const missing = await request(port, 'GET', `/api/tasks/${crypto.randomUUID()}/progress`, { headers: authHeader });
    assert.equal(missing.status, 404);
  });
});

test('不存在的 id → 404', async () => {
  await withServer(async () => {
    const response = await request(port, 'GET', `/api/tasks/${crypto.randomUUID()}/result`, { headers: authHeader });
    assert.equal(response.status, 404);
    assert.equal(response.json.ok, false);
  });
});

test('任務未完成 → 404 result not ready（即使已有產出檔）', async () => {
  const running = seedTask('running', { ext: 'md', content: 'partial\n' });
  const doneWithoutArtifact = seedTask('done');
  await withServer(async () => {
    for (const id of [running, doneWithoutArtifact]) {
      const response = await request(port, 'GET', `/api/tasks/${id}/result`, { headers: authHeader });
      assert.equal(response.status, 404);
      assert.deepEqual(response.json, { ok: false, error: 'result not ready' });
    }
  });
});

test('.result.md 內容原樣回傳（format md），Bearer 也可讀', async () => {
  const content = '# 標題\n\n<script>alert(1)</script>\n第二行\nDONE: 完成\n';
  const id = seedTask('done', { ext: 'md', content });
  await withServer(async () => {
    for (const headers of [authHeader, { authorization: `Bearer ${FIXED_TOKEN}` }]) {
      const response = await request(port, 'GET', `/api/tasks/${id}/result`, { headers });
      assert.equal(response.status, 200, response.raw);
      assert.deepEqual(response.json, { ok: true, task_id: id, status: 'done', format: 'md', content, truncated: false });
    }
  });
});

test('.result.json 回 summary；沒有 summary 回整份 JSON 字串', async () => {
  const withSummary = seedTask('done', {
    ext: 'json',
    content: JSON.stringify({ task_id: 'x', summary: 'Mock summary 中文', completed_at: 'now' }),
  });
  const noSummaryRaw = JSON.stringify({ task_id: 'y', note: 'no summary here' });
  const noSummary = seedTask('done', { ext: 'json', content: noSummaryRaw });
  await withServer(async () => {
    const first = await request(port, 'GET', `/api/tasks/${withSummary}/result`, { headers: authHeader });
    assert.equal(first.status, 200, first.raw);
    assert.equal(first.json.format, 'json');
    assert.equal(first.json.content, 'Mock summary 中文');
    assert.equal(first.json.truncated, false);

    const second = await request(port, 'GET', `/api/tasks/${noSummary}/result`, { headers: authHeader });
    assert.equal(second.status, 200, second.raw);
    assert.equal(second.json.format, 'json');
    assert.equal(second.json.content, noSummaryRaw);
  });
});

test('超過 64KB 截斷且 truncated:true，不切出半個中文字', async () => {
  // 'ab' 開頭讓 3-byte 中文字跨在 64KB 邊界上（65536 落在字中間，應退到 65534）。
  const content = `ab${'回答'.repeat(20000)}`;
  const id = seedTask('done', { ext: 'md', content });
  await withServer(async () => {
    const response = await request(port, 'GET', `/api/tasks/${id}/result`, { headers: authHeader });
    assert.equal(response.status, 200);
    assert.equal(response.json.truncated, true);
    const bytes = Buffer.byteLength(response.json.content, 'utf8');
    assert.ok(bytes <= MAX_BYTES, `content ${bytes} bytes`);
    assert.equal(bytes, MAX_BYTES - 2);
    assert.ok(content.startsWith(response.json.content));
    assert.doesNotMatch(response.json.content, /�/);
  });
});

test('cookie 登入後可讀 mock 任務的回答（端到端，MOCK_WORKER=1）', async () => {
  await withServer(async () => {
    const cookie = await login();
    const created = await request(port, 'POST', '/api/tasks', {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
      payload: { title: 'chat answer e2e', instruction: 'show the answer' },
    });
    assert.equal(created.status, 201, created.raw);
    const id = created.json.id;
    track(path.join(TASKS_DIR, `${id}.json`));
    track(path.join(TASKS_DIR, `${id}.progress.jsonl`));
    track(path.join(ARTIFACTS_DIR, `${id}.result.json`));
    const task = await waitForTaskDone(id);
    assert.equal(task.status, 'done');

    const response = await request(port, 'GET', `/api/tasks/${id}/result`, { headers: { cookie } });
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.json.format, 'json');
    assert.equal(response.json.content, 'Mock worker completed task: chat answer e2e');
    assert.equal(response.json.truncated, false);
  });
});
