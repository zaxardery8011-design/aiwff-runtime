// Telegram 聊天體驗（J2）測試：輸入中、人話錯誤、連發緩衝、完成通知帶內容、非文字訊息、設定模式找 chat id。
// 同一個 process 內起 runtime server 與假 Telegram（只綁 127.0.0.1）；不叫真 claude（用假的 CLI 腳本），不連真網路。
// 假 CLI 與對話檔都放系統暫存目錄，結束時清掉；自己建的任務檔在 after 裡清掉。
// 要驗先後順序的地方，都等前一則確實進到假 CLI（看 capture 檔）或假 Telegram 確實送出後才送下一則。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');
const WORKSPACES_DIR = path.join(ROOT_DIR, 'data', 'workspaces');
const REPO_CONVERSATIONS_DIR = path.join(ROOT_DIR, 'data', 'conversations');
const TOKEN = 'telegram-ux-fixed-token';
const AUTH = { 'x-aiwff-runtime-token': TOKEN };
const TG_CHAT_ID = '-100888';
const TG_CONVERSATION_ID = 'tg-m100888';
const OTHER_CHAT_ID = '424242';
const SETUP_CHAT_ID = '987654321';
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-telegram-ux-test-bin-'));
const CONVERSATIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-telegram-ux-test-conv-'));

const store = require(path.join(ROOT_DIR, 'agent', 'conversation-store.js'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
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

function request(port, method, route, { headers = {}, payload } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
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

// repo 的 data/conversations 快照：檔名加內容雜湊，前後比對有沒有新檔或被改過的檔。
function repoConversationsSnapshot() {
  try {
    return fs
      .readdirSync(REPO_CONVERSATIONS_DIR)
      .sort()
      .map((name) => {
        const content = fs.readFileSync(path.join(REPO_CONVERSATIONS_DIR, name));
        return `${name}:${crypto.createHash('sha256').update(content).digest('hex')}`;
      });
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

// 假 Claude CLI：每次呼叫一讀完 stdin 就把 argv / stdin 追加一行到 capture 檔，等 delayMs 後才回答。
function captureClaude(captureFile, delayMs = 0) {
  return `
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let count = 0;
  try { count = fs.readFileSync(${JSON.stringify(captureFile)}, 'utf8').split('\\n').filter(Boolean).length; } catch (_) {}
  const reply = '假回答第' + (count + 1) + '號';
  fs.appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), input, reply }) + '\\n');
  setTimeout(() => { console.log(reply); }, ${Number(delayMs)});
});
`;
}

function failingClaude(captureFile) {
  return `
const fs = require('fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(captureFile)}, 'called\\n');
  console.error('fake auth failure: secret-ish stderr detail');
  process.exit(3);
});
`;
}

function readCaptures(captureFile) {
  try {
    return fs
      .readFileSync(captureFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function useFakeClaude(name, script) {
  const captureFile = path.join(BIN_DIR, `${name}.capture.jsonl`);
  process.env.MOCK_WORKER = '';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '1';
  process.env.CLAUDE_CMD = writeFakeClaude(name, script(captureFile));
  return captureFile;
}

// 假 Telegram：getUpdates 每次吐一則排隊的訊息（字串是文字訊息，物件會併進 message）；
// sendMessage 與 sendChatAction 都記下來，附上收到的時間。
function startFakeTelegram() {
  const queue = [];
  const sent = [];
  const actions = [];
  let updateId = 9000;
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
        let result = [];
        if (next !== undefined) {
          const extra = typeof next === 'string' ? { text: next } : next;
          const message = { message_id: updateId, chat: { id: Number(TG_CHAT_ID) }, ...extra };
          result = [{ update_id: ++updateId, message }];
        }
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.url.endsWith('/sendMessage')) {
        sent.push({ ...JSON.parse(raw || '{}'), at: Date.now() });
      } else if (req.url.endsWith('/sendChatAction')) {
        actions.push({ ...JSON.parse(raw || '{}'), at: Date.now() });
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, queue, sent, actions }));
  });
}

let port;
let agent;
let server;
let fakeTg;
let initialTaskFiles;
let initialRepoConversations;
const ENV_KEYS = [
  'AIWFF_MODE',
  'AIWFF_CONVERSATIONS_DIR',
  'MOCK_WORKER',
  'ENABLE_REAL_CLAUDE_WORKER',
  'AIWFF_WORKER_PROVIDER',
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
  initialRepoConversations = repoConversationsSnapshot();
  process.env.AIWFF_CONVERSATIONS_DIR = CONVERSATIONS_DIR;
  fakeTg = await startFakeTelegram();
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.TG_API_BASE_URL = `http://127.0.0.1:${fakeTg.port}`;
  process.env.TG_POLL_BASE_MS = '200';
  process.env.AIWFF_CHAT_TIMEOUT_SEC = '30';
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
    fs.rmSync(path.join(TASKS_DIR, `${id}.progress.jsonl`), { force: true });
    fs.rmSync(path.join(ARTIFACTS_DIR, `${id}.result.md`), { force: true });
    fs.rmSync(path.join(ARTIFACTS_DIR, `${id}.result.json`), { force: true });
    fs.rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true });
  }
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
  fs.rmSync(CONVERSATIONS_DIR, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test.beforeEach(() => {
  process.env.AIWFF_MODE = 'both';
  process.env.MOCK_WORKER = '1';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '';
  process.env.AIWFF_WORKER_PROVIDER = '';
  process.env.CLAUDE_CMD = '';
  process.env.CLAUDE_BYPASS_APPROVALS = '';
  process.env.AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS = '';
  process.env.TG_BOT_TOKEN = 'fake-test-token';
  process.env.ADMIN_TG_CHAT_ID = TG_CHAT_ID;
  fakeTg.sent.length = 0;
  fakeTg.actions.length = 0;
  fakeTg.queue.length = 0;
});

// 起一次 poll 迴圈跑 body，結束一定停掉、還原 TG 環境變數。
async function withPolling(body, start = () => agent.startTelegramPolling()) {
  const stop = start();
  try {
    await body();
  } finally {
    if (stop) stop();
    process.env.TG_BOT_TOKEN = '';
    process.env.ADMIN_TG_CHAT_ID = '';
  }
}

function texts() {
  return fakeTg.sent.map((m) => m.text);
}

function repliesMatching(re) {
  return fakeTg.sent.filter((m) => re.test(m.text));
}

test('(a) 假 CLI 約 5 秒才回：期間至少 2 次 typing，回覆送出後 1.5 秒內不再出現 typing', async () => {
  const captureFile = useFakeClaude('claude-ux-a', (file) => captureClaude(file, 5000));
  await withPolling(async () => {
    fakeTg.queue.push('慢慢想也沒關係');
    await waitFor(() => repliesMatching(/假回答/).length >= 1, 30000, 'slow chat reply');
    const replyAt = repliesMatching(/假回答/)[0].at;
    const typingBefore = fakeTg.actions.filter((a) => a.at <= replyAt);
    assert.ok(typingBefore.length >= 2, `typing 次數不夠：${typingBefore.length}`);
    for (const action of typingBefore) {
      assert.equal(action.action, 'typing');
      assert.equal(String(action.chat_id), TG_CHAT_ID);
    }
    await sleep(1500);
    const typingAfter = fakeTg.actions.filter((a) => a.at > replyAt);
    assert.equal(typingAfter.length, 0, `回覆送出後還有 typing：${JSON.stringify(typingAfter)}`);
  });
  assert.equal(readCaptures(captureFile).length, 1);
});

test('(b) 假 CLI exit 3：使用者收到人話，不含 exit、code 3 或 stderr 原文', async () => {
  const captureFile = useFakeClaude('claude-ux-b', failingClaude);
  await withPolling(async () => {
    fakeTg.queue.push('這次會壞掉嗎');
    await waitFor(() => fakeTg.sent.length >= 1, 20000, 'error reply');
  });
  assert.ok(fs.existsSync(captureFile), '假 CLI 要真的被叫到');
  const [reply] = texts();
  assert.match(reply, /這則我沒能回出來（內部出了點狀況），你再說一次好嗎？要我動手做事請用 \/task 開頭。/);
  assert.doesNotMatch(reply, /exit/i);
  assert.doesNotMatch(reply, /code 3/);
  assert.doesNotMatch(reply, /fake auth failure|secret-ish|stderr/);
  assert.doesNotMatch(reply, /聊天回覆失敗/);
});

test('(c) 假 CLI 慢回時連傳 3 則：不叫人重傳，第 2、3 則合成一則送下一輪，紀錄跟模型看到的一致', async () => {
  const captureFile = useFakeClaude('claude-ux-c', (file) => captureClaude(file, 3000));
  await withPolling(async () => {
    fakeTg.queue.push('連發第一則');
    await waitFor(() => readCaptures(captureFile).length >= 1, 20000, 'first message reaches fake CLI');
    fakeTg.queue.push('連發第二則');
    await waitFor(() => repliesMatching(/收到，我回完上一則就接著看/).length >= 1, 10000, 'busy ack');
    fakeTg.queue.push('連發第三則');
    await waitFor(() => fakeTg.queue.length === 0, 10000, 'third message delivered');
    await waitFor(() => repliesMatching(/假回答/).length >= 2, 30000, 'two chat replies');
  });
  const all = texts();
  assert.ok(!all.some((t) => /請稍後再傳/.test(t)), JSON.stringify(all));
  assert.equal(repliesMatching(/收到，我回完上一則就接著看/).length, 1, '同一輪最多回一次「收到」');
  const captures = readCaptures(captureFile);
  assert.equal(captures.length, 2, JSON.stringify(all));
  assert.match(captures[0].input, /連發第一則/);
  assert.doesNotMatch(captures[0].input, /連發第二則/);
  const second = captures[1].input;
  assert.match(second, /使用者連發了 2 則/);
  assert.match(second, /1\. 連發第二則/);
  assert.match(second, /2\. 連發第三則/);
  // 寫進對話紀錄的 user 那一則，就是合併後送給模型的文字。
  const users = store.readRecent(TG_CONVERSATION_ID).filter((entry) => entry.role === 'user');
  const combined = users[users.length - 1].text;
  assert.equal(combined, '（使用者連發了 2 則，請逐則回應）\n1. 連發第二則\n2. 連發第三則');
  assert.ok(second.includes(combined), '模型看到的訊息要跟紀錄一致');
});

test('(d) mock 任務的完成通知帶產出內容片段，不只是路徑', async () => {
  const before = taskFileNames().length;
  await withPolling(async () => {
    fakeTg.queue.push('/task 寫一份 J2 測試報告');
    await waitFor(() => repliesMatching(/任務完成/).length >= 1, 20000, 'task done notice');
  });
  assert.equal(taskFileNames().length, before + 1);
  const [done] = repliesMatching(/任務完成/);
  assert.match(done.text, /^✅ 任務完成：寫一份 J2 測試報告\n/);
  assert.match(done.text, /Mock worker completed task: 寫一份 J2 測試報告/);
  assert.doesNotMatch(done.text, /結果：data\/artifacts/);
  assert.ok(done.text.length <= 4000);
});

test('(e) 只有 photo 的 update：管理員收到「只看得懂文字」，不建任務、不叫假 CLI；非管理員照舊忽略', async () => {
  const captureFile = useFakeClaude('claude-ux-e', (file) => captureClaude(file, 0));
  const before = taskFileNames().length;
  await withPolling(async () => {
    fakeTg.queue.push({ chat: { id: Number(OTHER_CHAT_ID) }, photo: [{ file_id: 'other-photo', width: 1, height: 1 }] });
    fakeTg.queue.push({ photo: [{ file_id: 'fake-photo', width: 1, height: 1 }], caption: '幫我寫一個報告' });
    await waitFor(() => fakeTg.sent.length >= 1 && fakeTg.queue.length === 0, 10000, 'text-only reply');
    await sleep(500);
  });
  assert.equal(fakeTg.sent.length, 1, JSON.stringify(texts()));
  assert.equal(String(fakeTg.sent[0].chat_id), TG_CHAT_ID);
  assert.match(fakeTg.sent[0].text, /只看得懂文字/);
  assert.equal(taskFileNames().length, before);
  assert.equal(readCaptures(captureFile).length, 0);
  assert.equal(fakeTg.actions.length, 0);
});

test('(f) 設定模式：沒設 ADMIN_TG_CHAT_ID 也能啟動，/start 在 stdout 印出 chat id，不回任何訊息、不建任務', async () => {
  const captureFile = useFakeClaude('claude-ux-f', (file) => captureClaude(file, 0));
  delete process.env.ADMIN_TG_CHAT_ID;
  const before = taskFileNames().length;
  const doctor = await request(port, 'GET', '/api/doctor', { headers: AUTH });
  assert.equal(doctor.status, 200, doctor.raw);
  const tgCheck = doctor.json.checks.find((check) => check.id === 'telegram');
  assert.ok(tgCheck, doctor.raw);
  assert.equal(tgCheck.ok, false);
  assert.match(tgCheck.detail, /設定模式/);
  assert.equal(doctor.json.ok, false);

  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logged.push(args.join(' '));
  };
  let stop;
  try {
    stop = agent.startTelegramIfConfigured();
    assert.equal(typeof stop, 'function', '設定模式要照常 poll，不能擋啟動');
    const setupChat = { chat: { id: Number(SETUP_CHAT_ID) } };
    fakeTg.queue.push(
      { ...setupChat, text: '你好' },
      { ...setupChat, text: '/task 寫一個 hello.txt' },
      { ...setupChat, text: '/start' },
      { ...setupChat, text: '/start' },
      { ...setupChat, photo: [{ file_id: 'setup-photo', width: 1, height: 1 }] },
    );
    await waitFor(() => fakeTg.queue.length === 0, 10000, 'setup-mode updates consumed');
    await sleep(800);
  } finally {
    console.log = originalLog;
    if (stop) stop();
    process.env.TG_BOT_TOKEN = '';
  }
  const idLines = logged.filter((line) => line.includes(SETUP_CHAT_ID));
  assert.equal(idLines.length, 1, JSON.stringify(logged));
  assert.match(idLines[0], /ADMIN_TG_CHAT_ID/);
  assert.match(idLines[0], /\.env/);
  assert.equal(fakeTg.sent.length, 0, JSON.stringify(texts()));
  assert.equal(fakeTg.actions.length, 0);
  assert.equal(taskFileNames().length, before);
  assert.equal(readCaptures(captureFile).length, 0);

  // 設了 ADMIN_TG_CHAT_ID 時 doctor 照舊 OK。
  process.env.TG_BOT_TOKEN = 'fake-test-token';
  process.env.ADMIN_TG_CHAT_ID = TG_CHAT_ID;
  try {
    const configured = await request(port, 'GET', '/api/doctor', { headers: AUTH });
    assert.equal(configured.json.checks.find((check) => check.id === 'telegram').ok, true, configured.raw);
  } finally {
    process.env.TG_BOT_TOKEN = '';
    process.env.ADMIN_TG_CHAT_ID = '';
  }
});

test('(g) 忙碌中 /new：/new 立刻回、緩衝被清掉，下一輪 stdin 不含 /new 之前緩衝的訊息', async () => {
  const captureFile = useFakeClaude('claude-ux-g', (file) => captureClaude(file, 3000));
  await withPolling(async () => {
    fakeTg.queue.push('忙碌第一則');
    await waitFor(() => readCaptures(captureFile).length >= 1, 20000, 'first message reaches fake CLI');
    fakeTg.queue.push('應該被清掉的那則');
    await waitFor(() => repliesMatching(/收到，我回完上一則就接著看/).length >= 1, 10000, 'busy ack');
    fakeTg.queue.push('/new');
    await waitFor(() => repliesMatching(/開新對話/).length >= 1, 10000, '/new reply');
    assert.equal(repliesMatching(/假回答/).length, 0, '/new 要比卡住那輪先回');
    fakeTg.queue.push('新對話的那則');
    await waitFor(() => fakeTg.queue.length === 0, 10000, 'last message delivered');
    await waitFor(() => repliesMatching(/假回答/).length >= 2, 30000, 'two chat replies');
  });
  const captures = readCaptures(captureFile);
  assert.equal(captures.length, 2, JSON.stringify(texts()));
  assert.match(captures[1].input, /新對話的那則/);
  assert.doesNotMatch(captures[1].input, /應該被清掉的那則/);
  assert.doesNotMatch(captures[1].input, /使用者連發了/);
  // 卡住那輪在 /new 之後才回來，不寫進新對話。
  assert.doesNotMatch(captures[1].input, /忙碌第一則/);
  const recent = store.readRecent(TG_CONVERSATION_ID);
  assert.deepEqual(
    recent.map((entry) => entry.role),
    ['user', 'assistant'],
  );
  assert.equal(recent[0].text, '新對話的那則');
});

test('(h) repo 的 data/conversations 沒有新檔、也沒有被改過的檔', () => {
  assert.deepEqual(repoConversationsSnapshot(), initialRepoConversations);
});
