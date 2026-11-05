const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIRST_REPLY = path.join(ROOT_DIR, 'scripts', 'first-reply.js');
const SUMMARY = path.join(ROOT_DIR, 'scripts', 'install-summary.js');
const { buildSummaryLines, buildUninstallLines } = require('../scripts/install-summary');

const TOKEN = 'first-reply-test-token';
const MOCK_REPLY = '（mock）收到你的訊息。這是 MOCK_WORKER 模式的固定回覆；接上真的模型後，這裡會直接回答。';
const QUESTION = '你好，用一句話介紹你自己。';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-first-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 假 runtime：欄位照實跑過的 /api/settings、/api/chat 形狀；chat 的回應由各測試給。
function startFakeRuntime(t, { settings = {}, chat } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, value) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/settings') {
        send(200, { ok: true, worker_mode: 'claude', chat_mode: 'both', ...settings });
      } else if (req.url === '/api/chat' && chat !== 'hang') {
        const { status, body: reply } = chat || { status: 200, body: { ok: true, kind: 'chat', reply: '我是你的小主腦。', backend: 'claude', elapsed_ms: 900 } };
        send(status, reply);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      resolve({ port: server.address().port, calls });
    });
  });
}

function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function writeEnv(dir, port, token = TOKEN) {
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `PORT=${port}\r\nAIWFF_RUNTIME_TOKEN=${token}\r\n`);
  return envFile;
}

function run(script, args, { input } = {}) {
  const env = { ...process.env };
  delete env.PORT;
  delete env.AIWFF_RUNTIME_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    child.stdin.end(input || '');
  });
}

async function firstReply(t, fake, extra = []) {
  const dir = tempDir(t);
  const envFile = writeEnv(dir, fake.port);
  const result = await run(FIRST_REPLY, ['--env-path', envFile, '--json', ...extra]);
  return { ...result, json: JSON.parse(result.stdout) };
}

const chatPosts = (fake) => fake.calls.filter((call) => call.url === '/api/chat');

test('real: one POST with the token, the fixed question and no conversation_id', async (t) => {
  const fake = await startFakeRuntime(t);
  const result = await firstReply(t, fake);
  assert.equal(result.code, 0, result.all);
  assert.equal(result.json.result, 'real');
  assert.equal(result.json.backend, 'claude');
  const posts = chatPosts(fake);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].headers['x-aiwff-runtime-token'], TOKEN);
  // 帶 conversation_id 會寫進使用者的對話紀錄；第一句驗證不該留痕。
  assert.deepEqual(JSON.parse(posts[0].body), { text: QUESTION });
  assert.doesNotMatch(result.all, new RegExp(TOKEN));
});

test('real also counts for openai_compatible', async (t) => {
  const fake = await startFakeRuntime(t, {
    settings: { worker_mode: 'openai_compatible' },
    chat: { status: 200, body: { ok: true, kind: 'chat', reply: '你好。', backend: 'openai_compatible' } },
  });
  const result = await firstReply(t, fake);
  assert.equal(result.code, 0, result.all);
  assert.equal(result.json.result, 'real');
});

test('mock mode never calls the model', async (t) => {
  const fake = await startFakeRuntime(t, { settings: { worker_mode: 'mock' } });
  const result = await firstReply(t, fake);
  assert.equal(result.code, 3, result.all);
  assert.equal(result.json.result, 'mock');
  assert.equal(chatPosts(fake).length, 0);
});

test('a mock reply from a runtime that claims a real brain is still mock', async (t) => {
  const byBackend = await startFakeRuntime(t, { chat: { status: 200, body: { ok: true, kind: 'chat', reply: '嗨', backend: 'mock' } } });
  assert.equal((await firstReply(t, byBackend)).json.result, 'mock');
  const byText = await startFakeRuntime(t, { chat: { status: 200, body: { ok: true, kind: 'chat', reply: MOCK_REPLY, backend: 'claude' } } });
  assert.equal((await firstReply(t, byText)).json.result, 'mock');
});

test('chat_mode=task is skipped: POST /api/chat would create a real task and spend quota', async (t) => {
  const fake = await startFakeRuntime(t, { settings: { chat_mode: 'task' } });
  const result = await firstReply(t, fake);
  assert.equal(result.code, 4, result.all);
  assert.equal(result.json.result, 'skipped');
  assert.match(result.json.reason, /AIWFF_MODE/);
  assert.equal(chatPosts(fake).length, 0);
});

test('ok:true without a chat reply is a failure, not a real reply', async (t) => {
  const confirm = await startFakeRuntime(t, { chat: { status: 200, body: { ok: true, kind: 'confirm', proposal_id: 'a'.repeat(24) } } });
  const asConfirm = await firstReply(t, confirm);
  assert.equal(asConfirm.code, 1);
  assert.equal(asConfirm.json.result, 'fail');
  const empty = await startFakeRuntime(t, { chat: { status: 200, body: { ok: true, kind: 'chat', reply: '   ', backend: 'claude' } } });
  assert.equal((await firstReply(t, empty)).json.result, 'fail');
  // 建任務的回應也有 reply：只看「有字」會把花額度的任務當成真回覆。
  const task = await startFakeRuntime(t, { chat: { status: 200, body: { ok: true, kind: 'task', reply: '好，開工了。', task: { id: 'x' } } } });
  assert.equal((await firstReply(t, task)).json.result, 'fail');
});

const failures = [
  ['claude timeout', { error: 'chat reply failed: chat reply timed out after 30s', code: 'chat_timeout' }, /太久/],
  ['openai timeout with no chat_timeout code', { error: 'chat reply failed: The operation was aborted due to timeout', code: null }, /太久/],
  ['claude logged out', { error: 'chat reply failed: Claude chat exited with code 1: Not logged in · Please run /login', code: null }, /登入/],
  ['usage limit', { error: 'chat reply failed: Claude chat exited with code 1: Claude usage limit reached', code: null }, /額度/],
  ['ollama down', { error: 'chat reply failed: fetch failed ECONNREFUSED 127.0.0.1:11434', code: null }, /Ollama/],
  ['model missing', { error: 'chat reply failed: model "qwen" not found, try pulling it first', code: null }, /模型/],
  ['claude binary gone', { error: 'chat reply failed: spawn claude ENOENT', code: 'ENOENT' }, /connect-brain\.cmd/],
  // 桌面端更新後舊版資料夾消失時，cmd 實際回的字。
  ['stale bundled path', { error: 'chat reply failed: Claude chat exited with code 1: The system cannot find the path specified.', code: null }, /路徑可能過期/],
  ['stale bundled path, zh-TW Windows', { error: 'chat reply failed: Claude chat exited with code 1: 系統找不到指定的路徑。', code: null }, /路徑可能過期/],
];

for (const [name, body, reason] of failures) {
  test(`502 becomes a plain reason: ${name}`, async (t) => {
    const fake = await startFakeRuntime(t, { chat: { status: 502, body: { ok: false, kind: 'chat', ...body } } });
    const result = await firstReply(t, fake);
    assert.equal(result.code, 1, result.all);
    assert.equal(result.json.result, 'fail');
    assert.match(result.json.reason, reason);
  });
}

test('an unknown failure keeps a short cause and scrubs the token', async (t) => {
  const fake = await startFakeRuntime(t, {
    chat: { status: 502, body: { ok: false, error: `chat reply failed: weird thing ${TOKEN} happened` } },
  });
  const result = await firstReply(t, fake);
  assert.equal(result.json.result, 'fail');
  assert.match(result.json.reason, /weird thing/);
  assert.doesNotMatch(result.all, new RegExp(TOKEN));
});

test('a token cut by the 200-character limit does not leave its first half behind', async (t) => {
  const fake = await startFakeRuntime(t, {
    chat: { status: 502, body: { ok: false, error: `${'x'.repeat(190)}${TOKEN} tail` } },
  });
  const result = await firstReply(t, fake);
  assert.equal(result.json.result, 'fail');
  assert.doesNotMatch(result.all, new RegExp(TOKEN.slice(0, 10)));
});

test('401 says the port answers with a different token', async (t) => {
  const fake = await startFakeRuntime(t, { chat: { status: 401, body: { ok: false, error: 'Missing or invalid runtime token' } } });
  const result = await firstReply(t, fake);
  assert.equal(result.json.result, 'fail');
  assert.match(result.json.reason, /token/);
});

test('a dead runtime is a plain failure', async (t) => {
  const dir = tempDir(t);
  const envFile = writeEnv(dir, await closedPort());
  const result = await run(FIRST_REPLY, ['--env-path', envFile, '--json']);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result, 'fail');
  assert.match(parsed.reason, /沒有回應/);
});

test('a hanging brain times out on the client side', async (t) => {
  const fake = await startFakeRuntime(t, { chat: 'hang' });
  const result = await firstReply(t, fake, ['--timeout-sec', '1']);
  assert.equal(result.code, 1, result.all);
  assert.equal(result.json.result, 'fail');
  assert.match(result.json.reason, /1 秒/);
});

test('an empty token is skipped, not a silent brain: the runtime supports it, this check just cannot ask', async (t) => {
  const fake = await startFakeRuntime(t);
  const dir = tempDir(t);
  const envFile = writeEnv(dir, fake.port, '');
  const result = await run(FIRST_REPLY, ['--env-path', envFile, '--json']);
  assert.equal(result.code, 4);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.result, 'skipped');
  assert.match(verdict.reason, /AIWFF_RUNTIME_TOKEN/);
  assert.equal(chatPosts(fake).length, 0);
});

test('--no-model never asks a real brain, and still says mock when it is mock', async (t) => {
  const fake = await startFakeRuntime(t);
  const result = await firstReply(t, fake, ['--no-model']);
  assert.equal(result.code, 4, result.all);
  assert.equal(result.json.result, 'skipped');
  assert.match(result.json.reason, /額度/);
  assert.equal(chatPosts(fake).length, 0);
  const mocked = await startFakeRuntime(t, { settings: { worker_mode: 'mock' } });
  assert.equal((await firstReply(t, mocked, ['--no-model'])).json.result, 'mock');
});

test('--no-api-billing skips a Claude that bills the API, not one on a subscription or Ollama', async (t) => {
  const billed = await startFakeRuntime(t);
  const dir = tempDir(t);
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `PORT=${billed.port}\r\nAIWFF_RUNTIME_TOKEN=${TOKEN}\r\nANTHROPIC_API_KEY=sk-ant-in-dotenv\r\n`);
  const skipped = await run(FIRST_REPLY, ['--env-path', envFile, '--json', '--no-api-billing']);
  assert.equal(skipped.code, 4, skipped.all);
  assert.match(JSON.parse(skipped.stdout).reason, /API 計費/);
  assert.equal(chatPosts(billed).length, 0);
  assert.doesNotMatch(skipped.all, /sk-ant-in-dotenv/);

  const local = await startFakeRuntime(t, {
    settings: { worker_mode: 'openai_compatible' },
    chat: { status: 200, body: { ok: true, kind: 'chat', reply: '你好。', backend: 'openai_compatible' } },
  });
  fs.writeFileSync(envFile, `PORT=${local.port}\r\nAIWFF_RUNTIME_TOKEN=${TOKEN}\r\nANTHROPIC_API_KEY=sk-ant-in-dotenv\r\n`);
  const asked = await run(FIRST_REPLY, ['--env-path', envFile, '--json', '--no-api-billing']);
  assert.equal(asked.code, 0, asked.all);
  assert.equal(chatPosts(local).length, 1);
});

test('--out writes the verdict for the summary, without the token', async (t) => {
  const fake = await startFakeRuntime(t);
  const dir = tempDir(t);
  const envFile = writeEnv(dir, fake.port);
  const out = path.join(dir, 'first_reply.json');
  const result = await run(FIRST_REPLY, ['--env-path', envFile, '--out', out]);
  assert.equal(result.code, 0, result.all);
  assert.match(result.stdout, /真回覆/);
  const text = fs.readFileSync(out, 'utf8');
  assert.equal(JSON.parse(text).result, 'real');
  assert.doesNotMatch(text, new RegExp(TOKEN));
});

// 假 runtime 的欄位是照抄的，runtime 改欄位時它不會紅；這個測試走真的 runtime，模型才用假端點。
// runtime 以 agent/ 的上一層當根目錄：複製到暫存資料夾再啟動，不碰 repo 自己的 data/。
async function startRealRuntime(t, env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-first-'));
  fs.cpSync(path.join(ROOT_DIR, 'agent'), path.join(root, 'agent'), { recursive: true });
  const port = await closedPort();
  const runtime = spawn(process.execPath, [path.join('agent', 'index.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), AIWFF_RUNTIME_TOKEN: TOKEN, AIWFF_MODE: 'both', TG_BOT_TOKEN: '', ...env },
    stdio: 'ignore',
  });
  // Windows 上 runtime 的 cwd 佔著資料夾：先等它真的結束再刪，順序反過來會 EBUSY，kill 也跑不到。
  const closed = new Promise((resolve) => runtime.once('close', resolve));
  t.after(async () => {
    runtime.kill();
    await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((res) => res.ok, () => false)) {
      return { root, port };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('runtime did not start');
}

test('real runtime with a fake OpenAI-compatible model is real, with MOCK_WORKER is mock', async (t) => {
  const modelCalls = [];
  const model = http.createServer((req, res) => {
    modelCalls.push(req.url);
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '我是假模型。' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    model.closeAllConnections();
    model.close();
  });

  const brain = await startRealRuntime(t, {
    MOCK_WORKER: '',
    AIWFF_WORKER_PROVIDER: 'openai_compatible',
    AIWFF_OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
    AIWFF_OPENAI_MODEL: 'fake-model',
  });
  const real = await run(FIRST_REPLY, ['--env-path', writeEnv(brain.root, brain.port), '--json']);
  assert.equal(real.code, 0, real.all);
  const verdict = JSON.parse(real.stdout);
  assert.equal(verdict.result, 'real');
  assert.equal(verdict.backend, 'openai_compatible');
  assert.equal(verdict.reply, '我是假模型。');
  assert.equal(modelCalls.length, 1);

  const mock = await startRealRuntime(t, { MOCK_WORKER: '1', AIWFF_WORKER_PROVIDER: '' });
  const mocked = await run(FIRST_REPLY, ['--env-path', writeEnv(mock.root, mock.port), '--json']);
  assert.equal(mocked.code, 3, mocked.all);
  assert.equal(JSON.parse(mocked.stdout).result, 'mock');
  assert.equal(modelCalls.length, 1, 'mock must not reach the model');
});

const BASE_STATE = {
  root: 'C:\\AIWFF-demo',
  port: 3100,
  env: { MOCK_WORKER: '1' },
  reply: { result: 'mock' },
  started: true,
  autostart: true,
  shortcut: true,
  desktop: 'no',
};

test('summary states the mock plainly and stays within 8 lines in every state', () => {
  const lines = buildSummaryLines(BASE_STATE);
  assert.match(lines.join('\n'), /現在是模擬，還沒接 AI/);
  assert.match(lines.join('\n'), /connect-brain\.cmd/);
  assert.match(lines.join('\n'), /http:\/\/127\.0\.0\.1:3100\//);
  assert.match(lines.join('\n'), /uninstall\.cmd/);
  assert.match(lines.join('\n'), /對話 \/ 新任務/);

  const envs = [
    BASE_STATE.env,
    { ENABLE_REAL_CLAUDE_WORKER: '1' },
    { AIWFF_WORKER_PROVIDER: 'openai_compatible', AIWFF_OPENAI_MODEL: 'qwen2.5:3b' },
  ];
  const replies = [{ result: 'real', backend: 'claude' }, { result: 'mock' }, { result: 'skipped', reason: '略過' }, { result: 'fail', reason: '原因' }, null];
  for (const env of envs) {
    for (const reply of replies) {
      for (const desktop of ['connected', 'kept', 'other', 'failed', 'no', 'absent']) {
        for (const started of [true, false]) {
          for (const failure of ['', 'port-busy', 'no-health', 'doctor']) {
            for (const autostart of [true, false]) {
              for (const brainFailed of [false, true]) {
                const state = { ...BASE_STATE, env, reply, desktop, started, failure, autostart, brainFailed };
                assert.ok(buildSummaryLines(state).length <= 8, JSON.stringify(state));
                assert.ok(buildSummaryLines(state).every(Boolean), JSON.stringify(state));
              }
            }
          }
        }
      }
    }
  }
});

test('summary names the real brain and the desktop state', () => {
  const claude = buildSummaryLines({ ...BASE_STATE, env: { ENABLE_REAL_CLAUDE_WORKER: '1' }, reply: { result: 'real' }, desktop: 'connected' }).join('\n');
  assert.match(claude, /Claude/);
  assert.match(claude, /額度/);
  assert.doesNotMatch(claude, /模擬/);
  assert.match(claude, /完全結束/);
  // 聊天能回，但任務做不完：不講的話使用者交了任務才發現。
  assert.match(claude, /背景任務/);
  const ollamaEnv = { AIWFF_WORKER_PROVIDER: 'OpenAI_Compatible', AIWFF_OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', AIWFF_OPENAI_MODEL: 'qwen2.5:3b' };
  const ollama = buildSummaryLines({ ...BASE_STATE, env: ollamaEnv, reply: { result: 'real' } }).join('\n');
  assert.match(ollama, /Ollama/);
  assert.match(ollama, /qwen2\.5:3b/);
  const endpoint = buildSummaryLines({ ...BASE_STATE, env: { ...ollamaEnv, AIWFF_OPENAI_BASE_URL: 'https://llm.example.com/v1' } }).join('\n');
  assert.match(endpoint, /OpenAI 相容端點/);
  assert.doesNotMatch(endpoint, /Ollama/);
  // MOCK_WORKER 優先於一切：provider 有值但 mock 開著，接的就是模擬。
  const shadowed = buildSummaryLines({ ...BASE_STATE, env: { MOCK_WORKER: '1', AIWFF_WORKER_PROVIDER: 'openai_compatible' } }).join('\n');
  assert.match(shadowed, /現在是模擬/);
});

test('summary says API billing when that is what Claude will do', () => {
  const lines = buildSummaryLines({ ...BASE_STATE, env: { ENABLE_REAL_CLAUDE_WORKER: '1' }, apiBilling: true, reply: { result: 'real' } }).join('\n');
  assert.match(lines, /API 計費/);
  assert.doesNotMatch(lines, /會用掉你的訂閱額度/);
});

test('summary: a brain that did not connect gives the reason and names the brain still in use', () => {
  const lines = buildSummaryLines({
    ...BASE_STATE,
    env: { ENABLE_REAL_CLAUDE_WORKER: '1' },
    reply: { result: 'real' },
    brainFailed: true,
    brainReason: 'Ollama 裝了但沒開',
  }).join('\n');
  assert.match(lines, /你選的大腦沒接上：Ollama 裝了但沒開/);
  assert.match(lines, /大腦：Claude/);
});

test('summary tells other Root and kept wiring apart from not connected', () => {
  assert.match(buildSummaryLines({ ...BASE_STATE, desktop: 'kept' }).join('\n'), /桌面端：接著/);
  assert.match(buildSummaryLines({ ...BASE_STATE, desktop: 'other' }).join('\n'), /別的小主腦/);
});

test('summary explains a failed first reply, a busy port, a stopped runtime and a manual start', () => {
  const failed = buildSummaryLines({ ...BASE_STATE, env: { ENABLE_REAL_CLAUDE_WORKER: '1' }, reply: { result: 'fail', reason: 'Claude 還沒登入' } }).join('\n');
  assert.match(failed, /Claude 還沒登入/);
  const busy = buildSummaryLines({ ...BASE_STATE, failure: 'port-busy' }).join('\n');
  assert.match(busy, /3100/);
  assert.match(busy, /別的程式/);
  assert.match(busy, /PORT/);
  const notStarted = buildSummaryLines({ ...BASE_STATE, started: false, autostart: false, reply: null }).join('\n');
  assert.match(notStarted, /start-runtime\.cmd/);
  const manual = buildSummaryLines({ ...BASE_STATE, autostart: false }).join('\n');
  assert.match(manual, /start-runtime\.cmd/);
});

test('summary never suggests a first question that opens a confirm card', () => {
  const text = buildSummaryLines({ ...BASE_STATE, reply: { result: 'real' }, env: { ENABLE_REAL_CLAUDE_WORKER: '1' } }).join('\n');
  assert.ok(text.includes(QUESTION));
});

function installedRoot(t, reply) {
  const root = path.join(tempDir(t), '根 目錄');
  const rt = path.join(root, 'suite', 'aiwff-runtime');
  fs.mkdirSync(rt, { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(rt, '.env'), `PORT=3456\r\nAIWFF_RUNTIME_TOKEN=${TOKEN}\r\nMOCK_WORKER=1\r\n`);
  const replyFile = path.join(root, 'logs', 'first_reply.json');
  if (reply) {
    fs.writeFileSync(replyFile, JSON.stringify(reply));
  }
  return { root, replyFile };
}

test('summary CLI reads .env for port and brain and never prints the token', async (t) => {
  const { root, replyFile } = installedRoot(t, { result: 'mock' });
  const result = await run(SUMMARY, ['--root', root, '--reply-file', replyFile, '--started', '1', '--autostart', 'off', '--shortcut', 'on', '--desktop', 'absent']);
  assert.equal(result.code, 0, result.all);
  assert.match(result.stdout, /3456/);
  assert.match(result.stdout, /現在是模擬/);
  assert.ok(result.stdout.includes(root));
  assert.doesNotMatch(result.all, new RegExp(TOKEN));
  assert.ok(result.stdout.trim().split(/\r?\n/).length <= 8);
});

test('summary CLI without a reply file does not invent a verdict', async (t) => {
  const { root } = installedRoot(t);
  const result = await run(SUMMARY, ['--root', root, '--started', '0', '--autostart', 'off', '--shortcut', 'off', '--desktop', 'no']);
  assert.equal(result.code, 0, result.all);
  assert.match(result.stdout, /還沒啟動/);
});

test('--ask-desktop: Enter and y mean yes, n means no, Chinese counts, anything else asks again', async () => {
  for (const input of ['\n', 'Y\n', '好\n', '要\n', 'ｙ\n']) {
    assert.equal((await run(SUMMARY, ['--ask-desktop'], { input })).code, 0, input);
  }
  for (const input of ['n\n', '不要\n', '否\n', 'ｎ\n']) {
    assert.equal((await run(SUMMARY, ['--ask-desktop'], { input })).code, 10, input);
  }
  const question = await run(SUMMARY, ['--ask-desktop'], { input: 'no\n' });
  assert.equal(question.code, 10);
  assert.match(question.stdout, /要接上 Claude 桌面端嗎？\[Y\/n\]/);
  // 動的是別的 App 的設定：聽不懂不算同意，沒答案就是不接。
  const unclear = await run(SUMMARY, ['--ask-desktop'], { input: 'no thanks\n' });
  assert.equal(unclear.code, 10);
  assert.match(unclear.stdout, /請打 y 或 n/);
  assert.equal((await run(SUMMARY, ['--ask-desktop'], { input: 'no thanks\ny\n' })).code, 0);
});

test('uninstall lines keep the data, give the folder and the Desktop restart hint', async (t) => {
  const lines = buildUninstallLines({ root: 'C:\\AIWFF-demo', desktopTouched: true }).join('\n');
  assert.match(lines, /C:\\AIWFF-demo/);
  assert.match(lines, /資料/);
  assert.match(lines, /自己刪/);
  assert.match(lines, /完全結束/);
  const { root } = installedRoot(t);
  const result = await run(SUMMARY, ['--uninstall', '--root', root, '--desktop', 'no']);
  assert.equal(result.code, 0, result.all);
  assert.ok(result.stdout.includes(root));
  assert.doesNotMatch(result.stdout, /完全結束/);
});
