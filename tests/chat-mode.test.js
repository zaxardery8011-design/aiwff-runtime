// 聊天模式（AIWFF_MODE）測試：路由表、POST /api/chat、TG 路由、webui 對話框、Claude 聊天參數。
// 同一個 process 內起 runtime server 與假 Telegram（只綁 127.0.0.1）；不叫真 claude（用假的 CLI 腳本），
// 不連真 Telegram。假 CLI 放系統暫存目錄，結束時清掉；自己建的任務檔在 after 裡清掉。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');
const TOKEN = 'chat-mode-fixed-token';
const AUTH = { 'x-aiwff-runtime-token': TOKEN };
const ADMIN_CHAT_ID = '4242';
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-chat-mode-test-'));

const { route } = require(path.join(ROOT_DIR, 'agent', 'chat-router.js'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function request(port, method, route_, { headers = {}, payload } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route_,
        method,
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
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
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function taskFileNames() {
  try {
    return fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch (_) {
    return [];
  }
}

function writeFakeClaude(name, scriptBody) {
  const scriptPath = path.join(BIN_DIR, `${name}.js`);
  fs.writeFileSync(scriptPath, scriptBody);
  if (process.platform === 'win32') {
    const commandPath = path.join(BIN_DIR, `${name}.cmd`);
    fs.writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return commandPath;
  }
  const commandPath = path.join(BIN_DIR, name);
  fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

// 假 Claude CLI：把 argv / cwd / stdin 落到 capture 檔，回一句固定答案。
function captureChatClaude(captureFile) {
  return `
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }));
  console.log('假 claude 的回答：你好！');
});
`;
}

const FAILING_CLAUDE = `
process.stdin.resume();
process.stdin.on('end', () => { console.error('fake auth failure'); process.exit(3); });
`;

const HANGING_CLAUDE = `
process.stdin.resume();
setTimeout(() => {}, 120000);
`;

// 假 Telegram：getUpdates 每次吐一則排隊的訊息；sendMessage 全部記下來。
function startFakeTelegram() {
  const queue = [];
  const sent = [];
  let updateId = 1000;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/getUpdates')) {
        const next = queue.shift();
        const result = next ? [{ update_id: ++updateId, message: { chat: { id: Number(ADMIN_CHAT_ID) }, text: next } }] : [];
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.url.endsWith('/sendMessage')) {
        sent.push(JSON.parse(raw || '{}'));
      }
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, queue, sent }));
  });
}

let port;
let agent;
let server;
let fakeTg;
let initialTaskFiles;
const ENV_KEYS = [
  'AIWFF_MODE',
  'MOCK_WORKER',
  'ENABLE_REAL_CLAUDE_WORKER',
  'AIWFF_WORKER_PROVIDER',
  'AGY_CMD',
  'CLAUDE_CMD',
  'CLAUDE_BYPASS_APPROVALS',
  'AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS',
  'TG_BOT_TOKEN',
  'ADMIN_TG_CHAT_ID',
];
const savedEnv = {};

// PORT / TG_API_BASE_URL / AIWFF_CHAT_TIMEOUT_SEC 在模組載入時讀，必須 require 前設好。
test.before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  fakeTg = await startFakeTelegram();
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.TG_API_BASE_URL = `http://127.0.0.1:${fakeTg.port}`;
  process.env.TG_POLL_BASE_MS = '200';
  process.env.AIWFF_CHAT_TIMEOUT_SEC = '2';
  process.env.AIWFF_RUNTIME_TOKEN = TOKEN;
  process.env.MOCK_WORKER = '1';
  process.env.AIWFF_WORKER_PROVIDER = '';
  delete process.env.AIWFF_MODE;
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
  agent.initRuntimeToken();
  initialTaskFiles = new Set(taskFileNames());
  server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fakeTg) await new Promise((resolve) => fakeTg.server.close(resolve));
  // 等 mock worker 收尾後再清自己建的任務檔與產出。
  await sleep(300);
  for (const name of taskFileNames()) {
    if (initialTaskFiles.has(name)) continue;
    const id = name.replace(/\.json$/, '');
    fs.rmSync(path.join(TASKS_DIR, name), { force: true });
    fs.rmSync(path.join(TASKS_DIR, `${id}.progress.log`), { force: true });
    fs.rmSync(path.join(ARTIFACTS_DIR, `${id}.result.md`), { force: true });
  }
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test.beforeEach(() => {
  delete process.env.AIWFF_MODE;
  process.env.MOCK_WORKER = '1';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '';
  process.env.AIWFF_WORKER_PROVIDER = '';
  process.env.AGY_CMD = '';
  process.env.CLAUDE_CMD = '';
  process.env.CLAUDE_BYPASS_APPROVALS = '';
  process.env.AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS = '';
});

async function waitForTaskStatus(taskId, statuses, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(port, 'GET', `/api/tasks/${taskId}`);
    if (res.json && res.json.task && statuses.includes(res.json.task.status)) return res.json.task;
    await sleep(150);
  }
  throw new Error(`task ${taskId} did not reach ${statuses.join('/')}`);
}

test('router: PoC 路由表（含兩條驗收的路由部分與負向對照）', () => {
  const cases = [
    ['你好', 'both', 'chat', '你好'],
    ['/task 寫一個 hello.txt', 'both', 'task', '寫一個 hello.txt'],
    ['你好', 'task', 'task', '你好'],
    // F4：沒設、空字串、值不認得都當 task（跟加聊天模式前一樣，每則訊息建任務）；要聊天得自己設 both。
    ['你好', undefined, 'task', '你好'],
    ['你好', '', 'task', '你好'],
    ['你好', 'bogus', 'task', '你好'],
    ['幫我看這樣對嗎？', undefined, 'task'],
    ['幫我整理今天的筆記', 'both', 'task'],
    ['可以幫我整理筆記嗎', 'both', 'chat'],
    ['幫我看這樣對嗎？', 'both', 'chat'],
    ['/chat 寫一個 hello.txt', 'both', 'chat', '寫一個 hello.txt'],
    ['/task 寫一個 hello.txt', 'chat', 'chat'],
    ['/tasks', 'both', 'command'],
    ['/start', 'chat', 'command'],
    ['run the tests', 'both', 'task'],
    ['running late today', 'both', 'chat'],
    ['/help', 'task', 'command'],
    ['  你好  ', 'CHAT', 'chat', '你好'],
    // 審查 F1：沒有受詞的動作詞、複合詞、問句，both 模式下都要是聊天（寧可少判成任務）。
    ['跑步好累', 'both', 'chat'],
    ['跑車多少錢', 'both', 'chat'],
    ['執行長是誰', 'both', 'chat'],
    ['建立關係很重要', 'both', 'chat'],
    ['整理房間好累喔', 'both', 'chat'],
    ['make sense', 'both', 'chat'],
    ['fix 是什麼意思', 'both', 'chat'],
    ['Run time error 是什麼意思', 'both', 'chat'],
    ['幫我解釋一下 closure 是什麼', 'both', 'chat'],
    ['幫我看看這樣對嗎？謝謝', 'both', 'chat'],
    ['請問現在幾點', 'both', 'chat'],
    ['/taskforce go', 'both', 'chat'],
    // 審查 F1 反方向：/task 不分大小寫、可省略空格、可帶 @bot；明講請託或動作詞＋受詞要判成任務。
    ['/task寫一個 hello.txt', 'both', 'task', '寫一個 hello.txt'],
    ['/TASK 寫一個 hello.txt', 'both', 'task', '寫一個 hello.txt'],
    ['/task@MyBot 寫一個 hello.txt', 'both', 'task', '寫一個 hello.txt'],
    ['/chat@MyBot 寫一個 hello.txt', 'both', 'chat', '寫一個 hello.txt'],
    ['/tasks@MyBot', undefined, 'command', '/tasks'],
    ['/Start', undefined, 'command', '/start'],
    ['請寫一個 hello.txt', 'both', 'task'],
    ['please write hello.txt', 'both', 'task'],
    ['寫一個 hello.txt', 'both', 'task'],
    ['請整理今天的筆記', 'both', 'task'],
  ];
  for (const [text, mode, kind, instruction] of cases) {
    const result = route(text, mode);
    assert.equal(result.kind, kind, `${JSON.stringify(text)} mode=${mode}`);
    if (instruction !== undefined) assert.equal(result.instruction, instruction);
  }
  assert.ok(route('幫我整理今天的筆記', 'both').hint, '自動判成任務要帶 hint');
  assert.equal(route('/task 寫一個 hello.txt', 'both').hint, undefined, '明講 /task 不帶 hint');
  assert.equal(route('/task 寫一個 hello.txt', 'chat').notice, 'task_disabled');
});

test('F4：沒設 AIWFF_MODE 時預設 task（跟舊版一樣）：「你好」建任務；設 both 才直接聊天', async () => {
  assert.equal(agent.runtimeChatMode(), 'task');
  const before = taskFileNames().length;
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.json.kind, 'task');
  assert.equal(res.json.mode, 'task');
  assert.equal(res.json.task.instruction, '你好');
  assert.equal(res.json.auto_detected, false);
  assert.equal(taskFileNames().length, before + 1);
  await waitForTaskStatus(res.json.task.id, ['done', 'failed', 'blocked']);
  const doctor = await request(port, 'GET', '/api/doctor');
  const check = doctor.json.checks.find((item) => item.id === 'chat_mode');
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.match(check.detail, /^task（AIWFF_MODE 未設，用預設）/);
  const settings = await request(port, 'GET', '/api/settings');
  assert.equal(settings.json.chat_mode, 'task');

  process.env.AIWFF_MODE = 'both';
  const chat = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  assert.equal(chat.status, 200, chat.raw);
  assert.equal(chat.json.kind, 'chat');
  assert.equal(chat.json.mode, 'both');
  assert.equal(taskFileNames().length, before + 1, '設 both 後「你好」不建任務');
});

test('F4：TG 沒設 AIWFF_MODE 時「你好」建任務（跟舊版一樣）', async () => {
  process.env.TG_BOT_TOKEN = 'fake-test-token';
  process.env.ADMIN_TG_CHAT_ID = ADMIN_CHAT_ID;
  const before = taskFileNames().length;
  fakeTg.sent.length = 0;
  fakeTg.queue.push('你好');
  const stop = agent.startTelegramPolling();
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fakeTg.sent.some((m) => /任務完成/.test(m.text))) {
      await sleep(100);
    }
    assert.ok(fakeTg.sent.some((m) => /任務建立：你好/.test(m.text)), JSON.stringify(fakeTg.sent));
    assert.ok(fakeTg.sent.some((m) => /任務完成/.test(m.text)), JSON.stringify(fakeTg.sent));
    assert.equal(taskFileNames().length, before + 1);
  } finally {
    stop();
    process.env.TG_BOT_TOKEN = '';
    process.env.ADMIN_TG_CHAT_ID = '';
  }
});

test('POST /api/chat「你好」：10 秒內有回答，而且不建任務（mock）', async () => {
  process.env.AIWFF_MODE = 'both';
  const before = taskFileNames();
  const startedAt = Date.now();
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.json.kind, 'chat');
  assert.equal(res.json.mode, 'both');
  assert.equal(res.json.backend, 'mock');
  assert.ok(res.json.reply.trim().length > 0);
  assert.ok(elapsedMs <= 10000, `took ${elapsedMs}ms`);
  assert.deepEqual(taskFileNames(), before, 'data/tasks 不能多檔');
});

test('POST /api/chat「/task 寫一個 hello.txt」：建任務、回覆含「任務建立」與 ID，跑完 done', async () => {
  process.env.AIWFF_MODE = 'both';
  const before = taskFileNames().length;
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '/task 寫一個 hello.txt' } });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.json.kind, 'task');
  assert.equal(res.json.task.instruction, '寫一個 hello.txt');
  assert.match(res.json.reply, /任務建立/);
  assert.ok(res.json.reply.includes(res.json.task.id.slice(0, 8)));
  assert.ok(!res.json.reply.includes(agent.CHAT_TASK_HINT), '明講 /task 不加誤判提示');
  assert.equal(taskFileNames().length, before + 1);
  const task = await waitForTaskStatus(res.json.task.id, ['done', 'failed', 'blocked']);
  assert.equal(task.status, 'done');
});

test('POST /api/chat：關鍵詞自動判成任務時，回覆多一行 /chat 提示', async () => {
  process.env.AIWFF_MODE = 'both';
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '幫我整理今天的筆記' } });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.json.auto_detected, true);
  assert.ok(res.json.reply.includes(agent.CHAT_TASK_HINT));
  await waitForTaskStatus(res.json.task.id, ['done', 'failed', 'blocked']);
});

test('負向對照：AIWFF_MODE=task 下「你好」要建任務', async () => {
  process.env.AIWFF_MODE = 'task';
  const before = taskFileNames().length;
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.json.kind, 'task');
  assert.equal(res.json.mode, 'task');
  assert.equal(taskFileNames().length, before + 1);
  await waitForTaskStatus(res.json.task.id, ['done', 'failed', 'blocked']);
});

test('AIWFF_MODE=chat：/task 回「只開聊天模式」，不建任務也不叫模型', async () => {
  process.env.AIWFF_MODE = 'chat';
  const before = taskFileNames();
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '/task 寫一個 hello.txt' } });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.json.notice, 'task_disabled');
  assert.match(res.json.reply, /只開聊天模式/);
  assert.equal(res.json.backend, undefined);
  assert.deepEqual(taskFileNames(), before);
});

test('POST /api/chat：/start 依模式改文字，/help 說明 /task；沒 token 401、空字串 400', async () => {
  process.env.AIWFF_MODE = 'both';
  const start = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '/start' } });
  assert.equal(start.json.kind, 'command');
  assert.match(start.json.reply, /\/task 開頭/);
  const help = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '/help' } });
  assert.match(help.json.reply, /\/task <內容>/);
  const noToken = await request(port, 'POST', '/api/chat', { payload: { text: '你好' } });
  assert.equal(noToken.status, 401);
  const emptyText = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '   ' } });
  assert.equal(emptyText.status, 400);
  const usage = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '/task' } });
  assert.equal(usage.json.kind, 'usage');
});

test('/api/doctor 與 /api/settings 顯示目前聊天模式；值不認得時說用預設', async () => {
  process.env.AIWFF_MODE = 'weird';
  const doctor = await request(port, 'GET', '/api/doctor');
  const check = doctor.json.checks.find((item) => item.id === 'chat_mode');
  assert.ok(check, 'doctor 要有 chat_mode');
  assert.match(check.detail, /^task（AIWFF_MODE=weird 不認得/);
  process.env.AIWFF_MODE = 'chat';
  const settings = await request(port, 'GET', '/api/settings');
  assert.equal(settings.json.chat_mode, 'chat');
});

test('Claude 聊天參數：無工具、單輪、不吃 bypass，cwd 不在 repo 裡，也不建任務（假 CLI）', async () => {
  const captureFile = path.join(BIN_DIR, 'capture.json');
  process.env.AIWFF_MODE = 'both';
  process.env.MOCK_WORKER = '';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '1';
  process.env.CLAUDE_BYPASS_APPROVALS = '1';
  process.env.AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS = '1';
  process.env.CLAUDE_CMD = writeFakeClaude('capture-chat-claude', captureChatClaude(captureFile));
  const before = taskFileNames();
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.json.backend, 'claude');
  assert.equal(res.json.reply, '假 claude 的回答：你好！');
  const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  const toolsAt = captured.argv.indexOf('--tools');
  assert.ok(toolsAt >= 0, `argv=${JSON.stringify(captured.argv)}`);
  assert.equal(captured.argv[toolsAt + 1], '', '--tools 後面要是空字串（關掉全部工具）');
  assert.ok(captured.argv.includes('--print'));
  assert.ok(captured.argv.includes('--strict-mcp-config'));
  assert.ok(!captured.argv.includes('--dangerously-skip-permissions'), '聊天不能吃 bypass');
  assert.ok(!captured.argv.includes('--add-dir'), '聊天不給寫入目錄');
  assert.ok(!path.resolve(captured.cwd).startsWith(ROOT_DIR), `cwd=${captured.cwd}`);
  assert.match(captured.input, /## 訊息\n你好/);
  assert.match(captured.input, /沒有工具/);
  assert.deepEqual(taskFileNames(), before);
  // 審查 F6：拿寫死的預期陣列比，不拿函式自己的輸出比；少了 dontAsk 或 --no-session-persistence 要失敗。
  assert.deepEqual(captured.argv, [
    '--print',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
  ]);
});

test('Claude 聊天失敗：回 502 與具名原因，不建任務（假 CLI exit 3）', async () => {
  process.env.AIWFF_MODE = 'both';
  process.env.MOCK_WORKER = '';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '1';
  process.env.CLAUDE_CMD = writeFakeClaude('failing-chat-claude', FAILING_CLAUDE);
  const before = taskFileNames();
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  assert.equal(res.status, 502, res.raw);
  assert.match(res.json.error, /code 3: fake auth failure/);
  assert.deepEqual(taskFileNames(), before);
});

test('Claude 聊天逾時：到時間就回 chat_timeout，不會一直掛著（假 CLI 不回）', async () => {
  process.env.AIWFF_MODE = 'both';
  process.env.MOCK_WORKER = '';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '1';
  process.env.CLAUDE_CMD = writeFakeClaude('hanging-chat-claude', HANGING_CLAUDE);
  const startedAt = Date.now();
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(res.status, 502, res.raw);
  assert.equal(res.json.code, 'chat_timeout');
  assert.ok(elapsedMs < 8000, `took ${elapsedMs}ms`);
});

test('審查 F2：agy provider 沒設 AIWFF_MODE 時是 task（一般訊息建任務、不回錯誤）；明講 both 時 doctor 標 ok:false', async () => {
  process.env.MOCK_WORKER = '';
  process.env.AIWFF_WORKER_PROVIDER = 'agy';
  // 不叫真 agy：指向不存在的執行檔，spawn 回 ENOENT，任務跑到 failed 就好。
  process.env.AGY_CMD = path.join(BIN_DIR, 'no-such-agy.exe');
  assert.equal(agent.runtimeChatMode(), 'task');
  const before = taskFileNames().length;
  const res = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好' } });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.json.kind, 'task');
  assert.equal(res.json.mode, 'task');
  assert.equal(taskFileNames().length, before + 1);
  await waitForTaskStatus(res.json.task.id, ['done', 'failed', 'blocked']);
  const doctor = await request(port, 'GET', '/api/doctor');
  const check = doctor.json.checks.find((item) => item.id === 'chat_mode');
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.match(check.detail, /^task（AIWFF_MODE 未設，用預設）/);

  process.env.AIWFF_MODE = 'both';
  const doctorBoth = await request(port, 'GET', '/api/doctor');
  const checkBoth = doctorBoth.json.checks.find((item) => item.id === 'chat_mode');
  assert.equal(checkBoth.ok, false, JSON.stringify(checkBoth));
  assert.match(checkBoth.detail, /不支援聊天/);
  assert.equal(doctorBoth.json.ok, false);
});

test('審查 F3：8000 字上限只管聊天；/task 長指令照樣建任務', async () => {
  process.env.AIWFF_MODE = 'both';
  const before = taskFileNames().length;
  const longTask = await request(port, 'POST', '/api/chat', {
    headers: AUTH,
    payload: { text: `/task ${'整理'.repeat(4500)}` },
  });
  assert.equal(longTask.status, 201, longTask.raw.slice(0, 300));
  assert.equal(longTask.json.kind, 'task');
  assert.equal(taskFileNames().length, before + 1);
  await waitForTaskStatus(longTask.json.task.id, ['done', 'failed', 'blocked']);
  const longChat = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '你好'.repeat(4001) } });
  assert.equal(longChat.status, 413, longChat.raw);
  assert.equal(taskFileNames().length, before + 1);
});

test('審查 F5：TG 聊天回覆不擋輪詢迴圈，後面的 /tasks 先回（假 CLI 不回）', async () => {
  process.env.AIWFF_MODE = 'both';
  process.env.TG_BOT_TOKEN = 'fake-test-token';
  process.env.ADMIN_TG_CHAT_ID = ADMIN_CHAT_ID;
  process.env.MOCK_WORKER = '';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '1';
  process.env.CLAUDE_CMD = writeFakeClaude('hanging-tg-chat-claude', HANGING_CLAUDE);
  fakeTg.sent.length = 0;
  fakeTg.queue.push('你好', '/tasks');
  const stop = agent.startTelegramPolling();
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !fakeTg.sent.some((m) => /這則我想太久先停了/.test(m.text))) {
      await sleep(50);
    }
    const texts = fakeTg.sent.map((m) => m.text);
    const chatAt = texts.findIndex((t) => /這則我想太久先停了/.test(t));
    const tasksAt = texts.findIndex((t) => !/這則我想太久先停了/.test(t));
    assert.ok(chatAt >= 0, `chat timeout reply missing: ${JSON.stringify(texts)}`);
    assert.ok(tasksAt >= 0 && tasksAt < chatAt, `/tasks 要比聊天逾時先回：${JSON.stringify(texts)}`);
  } finally {
    stop();
    process.env.TG_BOT_TOKEN = '';
    process.env.ADMIN_TG_CHAT_ID = '';
  }
});

test('TG：both 模式「你好」直接回答不建任務；/task 建任務並收到完成通知；task 模式「你好」建任務', async () => {
  process.env.AIWFF_MODE = 'both';
  process.env.TG_BOT_TOKEN = 'fake-test-token';
  process.env.ADMIN_TG_CHAT_ID = ADMIN_CHAT_ID;
  const before = taskFileNames().length;
  fakeTg.sent.length = 0;
  fakeTg.queue.push('你好', '/task 寫一個 hello.txt');
  const stop = agent.startTelegramPolling();
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fakeTg.sent.some((m) => /任務完成/.test(m.text))) {
      await sleep(100);
    }
    const texts = fakeTg.sent.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes('（mock）')), `chat reply missing: ${JSON.stringify(texts)}`);
    assert.ok(texts.some((t) => /任務建立：寫一個 hello\.txt/.test(t)), JSON.stringify(texts));
    assert.ok(texts.some((t) => /任務完成/.test(t)), JSON.stringify(texts));
    assert.ok(fakeTg.sent.every((m) => String(m.chat_id) === ADMIN_CHAT_ID));
    assert.equal(taskFileNames().length, before + 1, '只有 /task 那則建任務');

    process.env.AIWFF_MODE = 'task';
    fakeTg.sent.length = 0;
    fakeTg.queue.push('你好');
    const deadline2 = Date.now() + 10000;
    while (Date.now() < deadline2 && !fakeTg.sent.some((m) => /任務建立/.test(m.text))) {
      await sleep(100);
    }
    assert.ok(fakeTg.sent.some((m) => /任務建立：你好/.test(m.text)), JSON.stringify(fakeTg.sent));
    assert.equal(taskFileNames().length, before + 2);
  } finally {
    stop();
    process.env.TG_BOT_TOKEN = '';
    process.env.ADMIN_TG_CHAT_ID = '';
  }
});

// webui 對話框：把主 inline script 丟進 node:vm，配最小假 DOM；fetch 轉到同 process 的 server。
function fakeElement() {
  const classes = new Set();
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    closest: () => null,
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

function loadWebui(calls) {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'agent', 'webui.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const main = scripts.find((source) => source.includes('async function sendChatTask()'));
  assert.ok(main, 'webui.html 找不到 sendChatTask');
  const elements = new Map();
  const document = {
    documentElement: fakeElement(),
    getElementById(id) {
      if (id === 'jhud-reactor') return null;
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => fakeElement(),
  };
  const context = {
    document,
    window: { addEventListener() {} },
    location: { hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (route_, options = {}) => {
      calls.push({ route: route_, method: options.method || 'GET', body: options.body });
      // 假 DOM 沒有 cookie：登入狀態直接回已登入，寫入授權改用 header 帶 token。
      if (route_ === '/api/session') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, loggedIn: true }), { status: 200 }));
      }
      const headers = { ...(options.headers || {}), ...AUTH };
      return fetch(`http://127.0.0.1:${port}${route_}`, { ...options, headers });
    },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    console,
    Date,
    Promise,
    JSON,
    Math,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(main, context, { filename: 'webui.html#main-script' });
  return { context, document };
}

test('webui 對話框：送 POST /api/chat；「你好」顯示回答不建任務，「/task …」顯示任務已建立', async () => {
  process.env.AIWFF_MODE = 'both';
  const calls = [];
  const ui = loadWebui(calls);
  const input = ui.document.getElementById('task-chat-text');
  const before = taskFileNames().length;

  input.value = '你好';
  await ui.context.sendChatTask();
  const chatPost = calls.find((call) => call.method === 'POST');
  assert.equal(chatPost.route, '/api/chat');
  assert.deepEqual(JSON.parse(chatPost.body), { text: '你好', conversation_id: 'webui' });
  assert.ok(!calls.some((call) => call.method === 'POST' && call.route === '/api/tasks'), '不能再打 POST /api/tasks');
  const answer = ui.context.state.chatMessages.find((message) => message.answer);
  assert.ok(answer && answer.text.includes('（mock）'), JSON.stringify(ui.context.state.chatMessages));
  assert.equal(taskFileNames().length, before);

  input.value = '/task 寫一個 hello.txt';
  await ui.context.sendChatTask();
  assert.ok(
    ui.context.state.chatMessages.some((message) => /任務已建立：[0-9a-f-]{36}/.test(message.text)),
    JSON.stringify(ui.context.state.chatMessages),
  );
  assert.equal(Object.keys(ui.context.state.chatTasks).length, 1);
  assert.equal(taskFileNames().length, before + 1);
  await waitForTaskStatus(Object.keys(ui.context.state.chatTasks)[0], ['done', 'failed', 'blocked']);
});

// 對話記憶（J1）：這支測試的 TG 與 webui 入口會帶對話 id，對話檔一律寫到系統暫存目錄，結束時清掉。
// 對話目錄每次呼叫都重讀環境變數，所以在這裡（任何測試開跑前）設好就生效。
const CONVERSATIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-chat-mode-conv-'));
const savedConversationsDir = process.env.AIWFF_CONVERSATIONS_DIR;
process.env.AIWFF_CONVERSATIONS_DIR = CONVERSATIONS_DIR;

test.after(() => {
  fs.rmSync(CONVERSATIONS_DIR, { recursive: true, force: true });
  if (savedConversationsDir === undefined) delete process.env.AIWFF_CONVERSATIONS_DIR;
  else process.env.AIWFF_CONVERSATIONS_DIR = savedConversationsDir;
});

test('對話記憶：webui 對話框的聊天寫進 webui 對話；/new 與 /reset 是指令', async () => {
  process.env.AIWFF_MODE = 'both';
  assert.deepEqual(route('/new', 'both'), { kind: 'command', instruction: '/new' });
  assert.deepEqual(route('/RESET@MyBot', 'task'), { kind: 'command', instruction: '/new' });
  assert.equal(route('/newbie', 'both').kind, 'chat');
  const calls = [];
  const ui = loadWebui(calls);
  ui.document.getElementById('task-chat-text').value = '記得我叫小明嗎';
  await ui.context.sendChatTask();
  const lines = fs
    .readFileSync(path.join(CONVERSATIONS_DIR, 'webui.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const [userLine, assistantLine] = lines.slice(-2);
  assert.deepEqual([userLine.role, userLine.text], ['user', '記得我叫小明嗎']);
  assert.equal(assistantLine.role, 'assistant');
  assert.match(assistantLine.text, /（mock）/);
  const help = await request(port, 'POST', '/api/chat', { headers: AUTH, payload: { text: '/help' } });
  assert.match(help.json.reply, /\/new/);
});
