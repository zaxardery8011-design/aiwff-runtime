// agent/mcp-server.js 測試：真的起子程序，走 stdio 講 JSON-RPC，新舊兩代協定都驗。
// 假 runtime 是同 process 內的 http server（只綁 127.0.0.1），不起真 runtime、不叫模型。
// server 用 __dirname 找 repo 根，所以每個情境把 mcp-server.js 複製到暫存 root，配一份假 .env；
// repo 真的 .env 碰不到，結束時整個暫存目錄清掉。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_SOURCE = path.join(ROOT_DIR, 'agent', 'mcp-server.js');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-mcp-test-'));
const TOKEN = 'mcp-test-fixed-token-should-never-leak';
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const KEY_VERSION = 'io.modelcontextprotocol/protocolVersion';
const KEY_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const KEY_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const MODERN_META = { [KEY_VERSION]: MODERN, [KEY_CAPS]: {} };
const TOOL_NAMES = ['aiwff_status', 'aiwff_new_task', 'aiwff_tasks', 'aiwff_task_result', 'aiwff_memory'];
const TASK_ID = '11111111-2222-4333-8444-555555555555';

let rootCounter = 0;
const clients = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

function makeRoot(envText, folder = 'root') {
  rootCounter += 1;
  const root = path.join(TMP_ROOT, `${folder}-${rootCounter}`, 'suite', 'aiwff-runtime');
  fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
  fs.copyFileSync(SERVER_SOURCE, path.join(root, 'agent', 'mcp-server.js'));
  if (envText !== null) {
    fs.writeFileSync(path.join(root, '.env'), envText);
  }
  return root;
}

class McpClient {
  constructor(root, extraEnv = {}) {
    // cwd 故意不是 root：client 起 server 時的 cwd 是使用者開的專案。
    this.child = spawn(process.execPath, [path.join(root, 'agent', 'mcp-server.js')], {
      cwd: os.tmpdir(),
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stdout = '';
    this.stderr = '';
    this.messages = [];
    this.waiters = new Map();
    this.nextId = 1;
    this.exited = new Promise((resolve) => this.child.once('close', (code, signal) => resolve({ code, signal })));
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    let pending = '';
    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        this.messages.push(message);
        const waiter = this.waiters.get(message.id);
        if (waiter) {
          this.waiters.delete(message.id);
          waiter(message);
        }
      }
    });
    clients.add(this);
  }

  writeRaw(text) {
    this.child.stdin.write(text);
  }

  waitFor(id, label = id) {
    const found = this.messages.find((message) => message.id === id);
    if (found) {
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply for ${label}; stdout=${this.stdout} stderr=${this.stderr}`)),
        8000
      );
      this.waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    this.writeRaw(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return this.waitFor(id, method);
  }

  notify(method, params) {
    this.writeRaw(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async callTool(name, args = {}) {
    const reply = await this.request('tools/call', { name, arguments: args });
    assert.equal(reply.error, undefined, `tools/call ${name} should not be a JSON-RPC error`);
    return reply.result;
  }

  async close() {
    clients.delete(this);
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    const exit = await this.exited;
    clearTimeout(timer);
    return exit;
  }
}

function resultText(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// 回應欄位照實跑過的 runtime：POST /api/tasks 是裸物件，其他是 {ok,…}。
function makeRuntime(state = {}) {
  const runtime = {
    requests: [],
    tasks: state.tasks || [],
    result: state.result || { ok: true, task_id: TASK_ID, status: 'done', format: 'md', content: '報告內容', truncated: false },
    memory: state.memory || [
      { file: 'facts.md', size_bytes: 12, truncated: false, updated_at: '2026-11-05T00:00:00.000Z', frontmatter: 'name: facts', content: '事實內文' },
      { file: 'preferences.md', size_bytes: 8, truncated: false, updated_at: '2026-11-04T00:00:00.000Z', frontmatter: '', content: '偏好內文' },
    ],
    workerMode: state.workerMode || 'claude',
    chatMode: state.chatMode || 'both',
    claudeTaskScope: state.claudeTaskScope || 'closed',
    postStatus: state.postStatus || 201,
  };
  runtime.server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      runtime.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw });
      const authorized = req.headers['x-aiwff-runtime-token'] === TOKEN;
      if (req.method === 'GET' && url.pathname === '/api/hud') {
        sendJson(res, 200, {
          ok: true,
          port: req.socket.localPort,
          uptime_sec: 42,
          worker_mode: runtime.workerMode,
          task_counts: { total: 9, pending: 2, running: 1, done: 3, blocked: 2, failed: 1, unknown: 0 },
          inbox_count: 0,
          memory_count: 2,
          latest_tasks: [],
          latest_events: [],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        sendJson(res, 200, { ok: true, worker_mode: runtime.workerMode, chat_mode: runtime.chatMode, claude_task_scope: runtime.claudeTaskScope });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        sendJson(res, 200, { ok: true, tasks: runtime.tasks });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        if (!authorized) {
          sendJson(res, 401, { ok: false, error: 'Missing or invalid runtime token' });
          return;
        }
        if (runtime.postStatus !== 201) {
          sendJson(res, runtime.postStatus, { ok: false, error: `壞掉了 ${TOKEN}` });
          return;
        }
        const payload = JSON.parse(raw);
        sendJson(res, 201, { id: TASK_ID, title: payload.title || '未命名任務', instruction: payload.instruction, status: 'pending' });
        return;
      }
      const resultMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/result$/);
      if (req.method === 'GET' && resultMatch) {
        if (!authorized) {
          sendJson(res, 401, { ok: false, error: 'Missing or invalid runtime token' });
          return;
        }
        sendJson(res, 200, runtime.result);
        return;
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === 'GET' && taskMatch) {
        const task = runtime.tasks.find((item) => item.id === decodeURIComponent(taskMatch[1]));
        if (task) {
          sendJson(res, 200, { ok: true, task });
        } else {
          sendJson(res, 404, { ok: false, error: '找不到任務' });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/memory') {
        sendJson(res, 200, { ok: true, source: 'memory/*.md', documents: runtime.memory });
        return;
      }
      const memoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (req.method === 'GET' && memoryMatch) {
        const document = runtime.memory.find((item) => item.file === decodeURIComponent(memoryMatch[1]));
        if (document) {
          sendJson(res, 200, { ok: true, document });
        } else {
          sendJson(res, 404, { ok: false, error: '找不到記憶文件' });
        }
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    });
  });
  runtime.listen = (port = 0) =>
    new Promise((resolve, reject) => {
      runtime.server.once('error', reject);
      runtime.server.listen(port, '127.0.0.1', () => {
        runtime.port = runtime.server.address().port;
        runtime.server.unref();
        resolve(runtime.port);
      });
    });
  runtime.close = () => new Promise((resolve) => runtime.server.close(resolve));
  return runtime;
}

async function withRuntime(state, body, extraEnvLines = '') {
  const runtime = makeRuntime(state);
  await runtime.listen();
  let client = null;
  try {
    client = new McpClient(makeRoot(`PORT=${runtime.port}\r\nAIWFF_RUNTIME_TOKEN=${TOKEN}\r\n${extraEnvLines}`));
    await body(client, runtime);
  } finally {
    if (client) {
      await client.close();
    }
    await runtime.close();
  }
}

test.after(() => {
  for (const client of clients) {
    client.child.kill();
  }
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test('舊代：initialize 回同版本、通知不回、ping 回空物件，回覆不帶新代欄位', async () => {
  await withRuntime({}, async (client) => {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.deepEqual(init.result, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'aiwff', version: '0.1.0' },
    });
    client.notify('notifications/initialized');

    const ping = await client.request('ping');
    assert.deepEqual(ping.result, {});
    assert.equal(client.messages.length, 2, '通知不可以有回覆');

    const list = await client.request('tools/list');
    assert.deepEqual(Object.keys(list.result), ['tools']);

    const call = await client.callTool('aiwff_status');
    assert.deepEqual(Object.keys(call).sort(), ['content', 'isError']);
    assert.equal(call.isError, false);
  });
});

test('舊代：請求的版本不認得時回最新舊代版本，不回新代版本', async () => {
  await withRuntime({}, async (client) => {
    for (const requested of ['1999-01-01', MODERN]) {
      const init = await client.request('initialize', { protocolVersion: requested, capabilities: {} });
      assert.equal(init.result.protocolVersion, LEGACY);
    }
  });
});

test('新代：server/discover 回完整欄位', async () => {
  await withRuntime({}, async (client) => {
    const reply = await client.request('server/discover', { _meta: MODERN_META });
    assert.deepEqual(reply.result, {
      resultType: 'complete',
      supportedVersions: [MODERN, LEGACY],
      capabilities: { tools: {} },
      _meta: { [KEY_SERVER_INFO]: { name: 'aiwff', version: '0.1.0' } },
      ttlMs: 0,
      cacheScope: 'public',
    });
  });
});

test('新代：tools/list 和 tools/call 帶 resultType、ttlMs、cacheScope、serverInfo', async () => {
  await withRuntime({}, async (client) => {
    const list = await client.request('tools/list', { _meta: MODERN_META });
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.ttlMs, 0);
    assert.equal(list.result.cacheScope, 'public');
    assert.deepEqual(list.result._meta[KEY_SERVER_INFO], { name: 'aiwff', version: '0.1.0' });

    const call = await client.request('tools/call', { name: 'aiwff_status', arguments: {}, _meta: MODERN_META });
    assert.equal(call.result.resultType, 'complete');
    assert.equal(call.result.isError, false);
    assert.deepEqual(call.result._meta[KEY_SERVER_INFO], { name: 'aiwff', version: '0.1.0' });
    assert.equal(call.result.ttlMs, undefined, 'tools/call 不是快取類回覆');
  });
});

test('新代：版本不支援回 -32022，缺必填 _meta 回 -32602', async () => {
  await withRuntime({}, async (client) => {
    const unsupported = await client.request('tools/list', { _meta: { [KEY_VERSION]: '1900-01-01', [KEY_CAPS]: {} } });
    assert.equal(unsupported.error.code, -32022);
    assert.deepEqual(unsupported.error.data, { supported: [MODERN, LEGACY], requested: '1900-01-01' });

    const noCaps = await client.request('tools/list', { _meta: { [KEY_VERSION]: MODERN } });
    assert.equal(noCaps.error.code, -32602);

    const discoverNoMeta = await client.request('server/discover');
    assert.equal(discoverNoMeta.error.code, -32602);
  });
});

test('新代請求不接受舊代才有的 initialize、ping', async () => {
  await withRuntime({}, async (client) => {
    for (const method of ['initialize', 'ping']) {
      const reply = await client.request(method, { _meta: MODERN_META });
      assert.equal(reply.error.code, -32601, method);
    }
  });
});

test('同一個程序可以新舊代交錯，不存連線狀態', async () => {
  await withRuntime({}, async (client) => {
    const modern = await client.request('tools/list', { _meta: MODERN_META });
    const legacy = await client.request('tools/list');
    assert.equal(modern.result.resultType, 'complete');
    assert.equal(legacy.result.resultType, undefined);
  });
});

test('工具清單固定順序，名稱合法，都有描述和 schema，new_task 講清楚會用額度', async () => {
  await withRuntime({}, async (client) => {
    const first = await client.request('tools/list');
    const second = await client.request('tools/list');
    assert.deepEqual(first.result, second.result);
    assert.deepEqual(first.result.tools.map((tool) => tool.name), TOOL_NAMES);
    for (const tool of first.result.tools) {
      assert.match(tool.name, /^[A-Za-z0-9_.-]+$/);
      assert.deepEqual(Object.keys(tool).sort(), ['annotations', 'description', 'inputSchema', 'name']);
      assert.ok(tool.description.length > 0);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const newTask = first.result.tools.find((tool) => tool.name === 'aiwff_new_task');
    assert.match(newTask.description, /額度/);
    assert.deepEqual(newTask.inputSchema.required, ['instruction']);
    // 模型看不到手冊，實際範圍要在描述裡。
    assert.match(newTask.description, /不要重開/);
    assert.match(newTask.description, /只能改自己的工作資料夾/);
    assert.match(newTask.description, /不能跑命令/);
    assert.match(newTask.description, /以回傳文字為準/);
    assert.doesNotMatch(newTask.description, /連結果檔都寫不了/);
    // client 靠這兩個旗標分得出哪個工具會花額度。
    assert.equal(newTask.annotations.destructiveHint, true);
    for (const tool of first.result.tools.filter((item) => item !== newTask)) {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    }
  });
});

test('協定錯誤：未知方法 -32601、未知工具 -32602、壞 JSON -32700 不帶 id、非物件 -32600', async () => {
  await withRuntime({}, async (client) => {
    assert.equal((await client.request('resources/list')).error.code, -32601);

    const unknownTool = await client.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
    assert.match(unknownTool.error.message, /Unknown tool: nope/);

    client.writeRaw('{broken json\n');
    client.writeRaw('[1,2]\n');
    client.writeRaw('{"jsonrpc":"2.0","id":null,"method":"tools/list"}\n');
    const after = await client.request('tools/list');
    assert.ok(after.result, '壞訊息之後還要能繼續服務');

    const noId = client.messages.filter((message) => message.error && !('id' in message));
    assert.deepEqual(noId.map((message) => message.error.code), [-32700, -32600, -32600]);
  });
});

test('client 回傳的 response 和未知通知都不回', async () => {
  await withRuntime({}, async (client) => {
    client.writeRaw('{"jsonrpc":"2.0","id":99,"result":{}}\n');
    client.notify('notifications/cancelled', { requestId: 1 });
    client.notify('notifications/some_future_thing');
    await client.request('tools/list');
    assert.equal(client.messages.length, 1);
  });
});

test('stdin 切半行、一包多行、CRLF、多位元組字切開都解得出來', async () => {
  await withRuntime({ tasks: [] }, async (client, runtime) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'split-1',
      method: 'tools/call',
      params: { name: 'aiwff_new_task', arguments: { instruction: '寫一份中文報告' } },
    });
    const bytes = Buffer.from(`${body}\r\n`, 'utf8');
    const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + 1;
    client.child.stdin.write(bytes.subarray(0, cut));
    await sleep(100);
    client.child.stdin.write(bytes.subarray(cut));
    const reply = await client.waitFor('split-1');
    assert.equal(reply.result.isError, false);
    assert.equal(JSON.parse(runtime.requests.find((item) => item.method === 'POST').body).instruction, '寫一份中文報告');

    const line = (id) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`;
    client.writeRaw(`${line('multi-1')}\n${line('multi-2')}`);
    assert.deepEqual((await client.waitFor('multi-1')).result, {});
    assert.deepEqual((await client.waitFor('multi-2')).result, {});
  });
});

test('stdout 每一行都是合法 JSON-RPC，log 走 stderr 只留方法名不留參數', async () => {
  await withRuntime({}, async (client) => {
    await client.request('initialize', { protocolVersion: LEGACY, capabilities: {} });
    await client.request('server/discover', { _meta: MODERN_META });
    await client.callTool('aiwff_new_task', { instruction: '這段參數內容不可以進 log' });
    client.writeRaw('not json\n');
    await client.request('ping');

    const lines = client.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 5);
    for (const line of lines) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0');
    }
    assert.ok(client.stdout.endsWith('\n'));
    assert.match(client.stderr, /initialize/);
    assert.match(client.stderr, /server\/discover/);
    assert.match(client.stderr, /tools\/call/);
    assert.doesNotMatch(client.stderr, /這段參數內容/);
  });
});

test('aiwff_status：回活著、大腦模式、進行中任務數', async () => {
  await withRuntime({}, async (client) => {
    const result = await client.callTool('aiwff_status');
    assert.equal(result.isError, false);
    const text = resultText(result);
    assert.match(text, /運作中/);
    assert.match(text, /claude/);
    assert.match(text, /進行中任務：3 件/);
  });
});

test('aiwff_status：mock 要講明是模擬，還沒接 AI', async () => {
  await withRuntime({ workerMode: 'mock' }, async (client) => {
    const text = resultText(await client.callTool('aiwff_status'));
    assert.match(text, /模擬.*還沒接 AI/);
    // 沒有安裝資料夾的 clone 沒有那支 .cmd，講 npm run connect。
    assert.match(text, /npm run connect/);
    assert.doesNotMatch(text, /connect-brain\.cmd/);
  });
});

test('裝好的 Root 有 connect-brain.cmd 時講雙擊：可攜版的 node 不在 PATH，npm run 跑不了', async () => {
  const runtime = makeRuntime({ workerMode: 'mock' });
  await runtime.listen();
  const root = makeRoot(`PORT=${runtime.port}\r\nAIWFF_RUNTIME_TOKEN=${TOKEN}\r\n`);
  const connector = path.resolve(root, '..', '..', 'connect-brain.cmd');
  fs.writeFileSync(connector, '@echo off\r\n');
  const client = new McpClient(root);
  try {
    const text = resultText(await client.callTool('aiwff_status'));
    assert.ok(text.includes(connector), text);
    assert.doesNotMatch(text, /npm run/);
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('runtime 沒開：五個工具都回 isError 和開法，server 不掛；開起來後同一個程序接得上', async () => {
  const port = await getOpenPort();
  const root = makeRoot(`PORT=${port}\nAIWFF_RUNTIME_TOKEN=${TOKEN}\n`);
  const launcher = path.resolve(root, '..', '..', 'start-runtime.cmd');
  fs.writeFileSync(launcher, '@echo off\r\n');
  const client = new McpClient(root);
  const runtime = makeRuntime();
  try {
    const calls = [
      ['aiwff_status', {}],
      ['aiwff_new_task', { instruction: '做事' }],
      ['aiwff_tasks', {}],
      ['aiwff_task_result', { task_id: TASK_ID }],
      ['aiwff_memory', {}],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool(name, args);
      assert.equal(result.isError, true, name);
      const text = resultText(result);
      assert.match(text, /沒有開/, name);
      assert.ok(text.includes(launcher), `${name} 要講開法：${text}`);
    }
    assert.equal(client.child.exitCode, null, 'server 不可以掛');

    await runtime.listen(port);
    const result = await client.callTool('aiwff_status');
    assert.equal(result.isError, false);
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('沒有 start-runtime.cmd 時開法改講 npm run web', async () => {
  const port = await getOpenPort();
  const client = new McpClient(makeRoot(`PORT=${port}\n`));
  try {
    assert.match(resultText(await client.callTool('aiwff_status')), /npm run web/);
  } finally {
    await client.close();
  }
});

test('runtime 卡住不回：逾時回 isError，不會一直等', async () => {
  const hanging = net.createServer((socket) => socket.resume());
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  hanging.unref();
  const client = new McpClient(makeRoot(`PORT=${hanging.address().port}\n`));
  try {
    const started = Date.now();
    const result = await client.callTool('aiwff_status');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /沒有回應/);
    assert.ok(Date.now() - started < 7500);
  } finally {
    await client.close();
    await new Promise((resolve) => hanging.close(resolve));
  }
});

test('port 上回的不是 JSON：回 isError，不會炸', async () => {
  const other = http.createServer((req, res) => res.end('<html>別的服務</html>'));
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  other.unref();
  const client = new McpClient(makeRoot(`PORT=${other.address().port}\n`));
  try {
    const result = await client.callTool('aiwff_status');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /不是小主腦/);
  } finally {
    await client.close();
    await new Promise((resolve) => other.close(resolve));
  }
});

test('.env 不存在：server 活著，要 token 的工具回白話錯誤', async () => {
  const client = new McpClient(makeRoot(null));
  try {
    const list = await client.request('tools/list');
    assert.equal(list.result.tools.length, 5);
    const result = await client.callTool('aiwff_new_task', { instruction: '做事' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /AIWFF_RUNTIME_TOKEN/);
  } finally {
    await client.close();
  }
});

test('.env 解析跟 runtime 同一套：首個非空值生效、去引號；不吃 client 帶進來的環境', async () => {
  const runtime = makeRuntime();
  await runtime.listen();
  const envText = [
    '# 註解',
    'PORT=',
    `PORT="${runtime.port}"`,
    'PORT=1',
    'AIWFF_RUNTIME_TOKEN=',
    `AIWFF_RUNTIME_TOKEN='${TOKEN}'`,
    'AIWFF_RUNTIME_TOKEN=second',
    '',
  ].join('\r\n');
  const client = new McpClient(makeRoot(envText), { PORT: '1', AIWFF_RUNTIME_TOKEN: 'decoy-from-client-env' });
  try {
    const result = await client.callTool('aiwff_new_task', { instruction: '做事' });
    assert.equal(result.isError, false, resultText(result));
    const post = runtime.requests.find((item) => item.method === 'POST');
    assert.equal(post.headers['x-aiwff-runtime-token'], TOKEN);
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('Root 含空白和中文：找得到 .env，工具照常', async () => {
  const runtime = makeRuntime();
  await runtime.listen();
  const client = new McpClient(makeRoot(`PORT=${runtime.port}
AIWFF_RUNTIME_TOKEN=${TOKEN}
`, '小 主腦'));
  try {
    const result = await client.callTool('aiwff_new_task', { instruction: '做事' });
    assert.equal(result.isError, false, resultText(result));
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('aiwff_new_task：走 POST /api/tasks、帶 token，解析裸物件', async () => {
  await withRuntime({}, async (client, runtime) => {
    const result = await client.callTool('aiwff_new_task', { instruction: '  整理這週的筆記  ', title: '週報' });
    assert.equal(result.isError, false);
    const text = resultText(result);
    assert.ok(text.includes(TASK_ID));
    assert.match(text, /pending/);
    const post = runtime.requests.find((item) => item.method === 'POST');
    assert.equal(post.path, '/api/tasks');
    assert.equal(post.headers['x-aiwff-runtime-token'], TOKEN);
    assert.deepEqual(JSON.parse(post.body), { instruction: '整理這週的筆記', title: '週報' });
  });
});

test('aiwff_new_task：AIWFF_MODE=chat 時拒絕，不比 WebUI 鬆', async () => {
  await withRuntime({ chatMode: 'chat' }, async (client, runtime) => {
    const result = await client.callTool('aiwff_new_task', { instruction: '做事' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /AIWFF_MODE=chat/);
    assert.equal(runtime.requests.some((item) => item.method === 'POST'), false);
  });
});

// .env 改了沒重開時 runtime 還是舊設定：範圍一律看 runtime 回報，.env 怎麼寫都不算。
const OPENED_IN_ENV_ONLY = 'AIWFF_CLAUDE_PERMISSION_MODE=acceptEdits\r\n';

test('aiwff_new_task：Claude 大腦回傳講 runtime 實際的範圍，沒開放講怎麼開，別的大腦不講', async () => {
  await withRuntime({ workerMode: 'claude', claudeTaskScope: 'workspace' }, async (client) => {
    const text = resultText(await client.callTool('aiwff_new_task', { instruction: '做事' }));
    assert.match(text, /只能改自己的工作資料夾/);
    assert.match(text, /不能跑命令/);
    assert.match(text, /不要重開/);
    assert.doesNotMatch(text, /連結果檔都寫不了/);
  });
  await withRuntime({ workerMode: 'claude', claudeTaskScope: 'closed' }, async (client) => {
    const text = resultText(await client.callTool('aiwff_new_task', { instruction: '做事' }));
    assert.match(text, /連結果檔都寫不了/);
    assert.match(text, /npm run connect/);
    assert.match(text, /不要重開/);
  }, OPENED_IN_ENV_ONLY);
  await withRuntime({ workerMode: 'claude', claudeTaskScope: 'unrestricted' }, async (client) => {
    const text = resultText(await client.callTool('aiwff_new_task', { instruction: '做事' }));
    assert.match(text, /跳過核可/);
    assert.doesNotMatch(text, /只能改自己的工作資料夾/);
  });
  await withRuntime({ workerMode: 'openai_compatible' }, async (client) => {
    assert.doesNotMatch(resultText(await client.callTool('aiwff_new_task', { instruction: '做事' })), /不要重開/);
  });
});

test('aiwff_new_task：空 instruction 自己擋，不打 runtime', async () => {
  await withRuntime({}, async (client, runtime) => {
    for (const args of [{}, { instruction: '' }, { instruction: '   ' }, { instruction: 123 }]) {
      const result = await client.callTool('aiwff_new_task', args);
      assert.equal(result.isError, true);
      assert.match(resultText(result), /instruction/);
    }
    assert.equal(runtime.requests.length, 0);
  });
});

test('aiwff_new_task：token 對不上回白話錯誤', async () => {
  const runtime = makeRuntime();
  await runtime.listen();
  const client = new McpClient(makeRoot(`PORT=${runtime.port}\nAIWFF_RUNTIME_TOKEN=wrong-value-here\n`));
  try {
    const result = await client.callTool('aiwff_new_task', { instruction: '做事' });
    assert.equal(result.isError, true);
    const text = resultText(result);
    assert.match(text, /token 對不上/);
    assert.doesNotMatch(text, /wrong-value-here/);
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('aiwff_tasks：預設 10 筆、可調、上限 50，不帶 instruction 全文', async () => {
  const tasks = Array.from({ length: 60 }, (_, index) => ({
    id: `task-${String(index).padStart(2, '0')}`,
    title: `第 ${index} 件`,
    instruction: `長長的指令全文 ${index}`,
    status: 'done',
    created_at: '2026-11-05T00:00:00.000Z',
  }));
  await withRuntime({ tasks }, async (client) => {
    const countRows = (text) => text.split('\n').filter((line) => line.startsWith('- ')).length;
    const byDefault = resultText(await client.callTool('aiwff_tasks'));
    assert.equal(countRows(byDefault), 10);
    assert.match(byDefault, /task-00/);
    assert.doesNotMatch(byDefault, /task-10/);
    assert.doesNotMatch(byDefault, /長長的指令全文/);
    assert.match(byDefault, /共 60 件/);

    assert.equal(countRows(resultText(await client.callTool('aiwff_tasks', { limit: 3 }))), 3);
    assert.equal(countRows(resultText(await client.callTool('aiwff_tasks', { limit: 500 }))), 50);
    assert.equal(countRows(resultText(await client.callTool('aiwff_tasks', { limit: 0 }))), 1);
    assert.equal(countRows(resultText(await client.callTool('aiwff_tasks', { limit: 'x' }))), 10);
  });
});

test('aiwff_tasks：沒有任務時講沒有', async () => {
  await withRuntime({ tasks: [] }, async (client) => {
    const result = await client.callTool('aiwff_tasks');
    assert.equal(result.isError, false);
    assert.match(resultText(result), /沒有任務/);
  });
});

test('aiwff_task_result：done 帶 token 讀結果', async () => {
  await withRuntime({ tasks: [{ id: TASK_ID, title: '報告', status: 'done' }] }, async (client, runtime) => {
    const result = await client.callTool('aiwff_task_result', { task_id: TASK_ID });
    assert.equal(result.isError, false);
    assert.match(resultText(result), /報告內容/);
    const read = runtime.requests.find((item) => item.path.endsWith('/result'));
    assert.equal(read.headers['x-aiwff-runtime-token'], TOKEN);
  });
});

test('aiwff_task_result：還在跑不讀 /result，不算錯', async () => {
  for (const status of ['pending', 'running']) {
    await withRuntime({ tasks: [{ id: TASK_ID, title: '報告', status }] }, async (client, runtime) => {
      const result = await client.callTool('aiwff_task_result', { task_id: TASK_ID });
      assert.equal(result.isError, false);
      assert.match(resultText(result), /還沒跑完/);
      assert.ok(resultText(result).includes(status));
      assert.equal(runtime.requests.some((item) => item.path.endsWith('/result')), false);
    });
  }
});

test('aiwff_task_result：failed、blocked 回原因，不是 result not ready', async () => {
  const cases = [
    [{ status: 'failed', error: '模型回了錯誤' }, /失敗.*模型回了錯誤/],
    [{ status: 'failed', last_error: '之前的原因' }, /失敗.*之前的原因/],
    [{ status: 'failed' }, /失敗/],
    [{ status: 'blocked', blocked_reason: 'timeout', last_error: '跑超過時間' }, /卡住.*timeout.*跑超過時間/],
    [{ status: 'blocked', blocked_reason: 'question', has_question: true }, /等使用者回答.*不要重開/],
  ];
  for (const [fields, pattern] of cases) {
    await withRuntime({ tasks: [{ id: TASK_ID, title: '報告', ...fields }] }, async (client, runtime) => {
      const result = await client.callTool('aiwff_task_result', { task_id: TASK_ID });
      assert.match(resultText(result), pattern);
      assert.equal(runtime.requests.some((item) => item.path.endsWith('/result')), false);
    });
  }
});

test('aiwff_task_result：等回答時分開放過和沒開放，開放過的不再講交不出結果', async () => {
  const task = { id: TASK_ID, title: '報告', status: 'blocked', blocked_reason: 'question', has_question: true };
  await withRuntime({ tasks: [task], claudeTaskScope: 'workspace' }, async (client) => {
    const text = resultText(await client.callTool('aiwff_task_result', { task_id: TASK_ID }));
    assert.match(text, /等使用者回答/);
    assert.match(text, /只能改自己的工作資料夾/);
    assert.doesNotMatch(text, /連結果檔都寫不了/);
  });
  await withRuntime({ tasks: [task], claudeTaskScope: 'closed' }, async (client) => {
    const text = resultText(await client.callTool('aiwff_task_result', { task_id: TASK_ID }));
    assert.match(text, /連結果檔都寫不了/);
    assert.match(text, /npm run connect/);
  }, OPENED_IN_ENV_ONLY);
});

test('aiwff_task_result：查無、空 id 回 isError；id 會編碼不能串路徑', async () => {
  await withRuntime({ tasks: [] }, async (client, runtime) => {
    const missing = await client.callTool('aiwff_task_result', { task_id: TASK_ID });
    assert.equal(missing.isError, true);
    assert.match(resultText(missing), /找不到任務/);

    const blank = await client.callTool('aiwff_task_result', {});
    assert.equal(blank.isError, true);

    runtime.requests.length = 0;
    await client.callTool('aiwff_task_result', { task_id: '../../api/hud' });
    assert.equal(runtime.requests.length, 1);
    assert.notEqual(runtime.requests[0].path, '/api/hud');
  });
});

test('aiwff_task_result：太長會截斷並講清楚', async () => {
  const result = { ok: true, task_id: TASK_ID, status: 'done', format: 'md', content: '字'.repeat(30000), truncated: false };
  await withRuntime({ tasks: [{ id: TASK_ID, title: '報告', status: 'done' }], result }, async (client) => {
    const text = resultText(await client.callTool('aiwff_task_result', { task_id: TASK_ID }));
    assert.ok(text.length < 9000, `length=${text.length}`);
    assert.match(text, /內容太長/);
    assert.match(text, /WebUI/);
  });
});

test('aiwff_memory：不帶 file 列清單不帶內文，帶 file 讀內文', async () => {
  await withRuntime({}, async (client) => {
    const list = resultText(await client.callTool('aiwff_memory'));
    assert.match(list, /facts\.md/);
    assert.match(list, /preferences\.md/);
    assert.doesNotMatch(list, /事實內文/);

    const read = await client.callTool('aiwff_memory', { file: 'facts.md' });
    assert.equal(read.isError, false);
    assert.match(resultText(read), /事實內文/);
  });
});

test('aiwff_memory：查無回 isError，file 會編碼不能串路徑，全程只有 GET', async () => {
  await withRuntime({}, async (client, runtime) => {
    const missing = await client.callTool('aiwff_memory', { file: 'nope.md' });
    assert.equal(missing.isError, true);
    assert.match(resultText(missing), /找不到記憶文件/);

    runtime.requests.length = 0;
    await client.callTool('aiwff_memory', { file: '../.env' });
    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.requests[0].path, '/api/memory/..%2F.env');
    assert.ok(runtime.requests.every((item) => item.method === 'GET'));
  });
});

test('token 絕不回傳：runtime 回的內容含 token 也要遮掉，stderr 也不留', async () => {
  const result = { ok: true, task_id: TASK_ID, status: 'done', format: 'md', content: `登入網址 http://127.0.0.1:3100/?token=${TOKEN} 結束`, truncated: false };
  const memory = [{ file: 'leak.md', size_bytes: 1, truncated: false, updated_at: '2026-11-05T00:00:00.000Z', frontmatter: '', content: `內文 ${TOKEN}` }];
  const tasks = [{ id: TASK_ID, title: `標題 ${TOKEN}`, status: 'done' }];
  await withRuntime({ tasks, result, memory, postStatus: 500 }, async (client) => {
    const outputs = [
      await client.callTool('aiwff_task_result', { task_id: TASK_ID }),
      await client.callTool('aiwff_memory', { file: 'leak.md' }),
      await client.callTool('aiwff_tasks'),
      await client.callTool('aiwff_new_task', { instruction: '做事' }),
      await client.callTool('aiwff_status'),
    ];
    assert.match(resultText(outputs[0]), /登入網址/);
    assert.match(resultText(outputs[1]), /內文/);
    assert.equal(outputs[3].isError, true);
    await client.request('tools/list');
    assert.equal(client.stdout.includes(TOKEN), false);
    assert.equal(client.stderr.includes(TOKEN), false);
  });
});

test('token 被截斷線切開時也不會漏出前半段', async () => {
  const content = `${'字'.repeat(7990)}${TOKEN}${'字'.repeat(100)}`;
  const result = { ok: true, task_id: TASK_ID, status: 'done', format: 'md', content, truncated: false };
  await withRuntime({ tasks: [{ id: TASK_ID, title: '報告', status: 'done' }], result }, async (client) => {
    await client.callTool('aiwff_task_result', { task_id: TASK_ID });
    assert.equal(client.stdout.includes(TOKEN.slice(0, 10)), false);
  });
});

test('stdin 關閉就結束：手上的請求回完才走，exit 0', async () => {
  await withRuntime({}, async (client) => {
    client.writeRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 'last', method: 'tools/call', params: { name: 'aiwff_status', arguments: {} } })}\n`);
    client.child.stdin.end();
    const exit = await client.exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(client.messages.find((message) => message.id === 'last').result.isError, false);
  });
});

test('最後一行沒有換行、stdin 就關了：照樣處理', async () => {
  await withRuntime({}, async (client) => {
    client.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 'tail', method: 'ping' }));
    client.child.stdin.end();
    await client.exited;
    assert.deepEqual(client.messages.find((message) => message.id === 'tail').result, {});
  });
});
