const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const agentModule = require(path.join(ROOT_DIR, 'agent', 'index.js'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startFakeTelegram(failTimes) {
  let getUpdatesCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url.includes('/getUpdates')) {
      getUpdatesCount += 1;
      if (getUpdatesCount <= failTimes) {
        req.socket.destroy();
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, getCount: () => getUpdatesCount });
    });
  });
}

function retryClaudeScript(counterFile, failTimes) {
  return `
const fs = require('fs');
const path = require('path');
const counter = ${JSON.stringify(counterFile)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch (_) {}
  n += 1;
  fs.writeFileSync(counter, String(n));
  if (n <= ${failTimes}) {
    console.error('attempt ' + n + ' intentional failure');
    process.exit(1);
  }
  const match = input.match(/結果請寫到: (.+)/);
  const outPath = path.resolve(__dirname, '..', '..', match[1].trim().replace(/\\//g, path.sep));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'DONE ok attempt ' + n);
  console.log('attempt ' + n + ' wrote artifact');
});
`;
}

function resetDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
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

// 這支 harness 以前也自己抄了一份 requestJson。三份同源副本代表「中途斷線要 signal 成 abort」
// 得修三次、還會各自漂走；改成共用 demo.js 那一份，修一次三邊同時生效。
const { readBackArtifact, requestJson } = require(path.join(ROOT_DIR, 'scripts', 'demo.js'));

async function startDaemon(env = {}) {
  const port = await getOpenPort();
  const daemon = spawn(process.execPath, ['agent/index.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      TG_BOT_TOKEN: '',
      ADMIN_TG_CHAT_ID: '',
      CLAUDE_BYPASS_APPROVALS: '',
      MOCK_WORKER: '1',
      ENABLE_REAL_CLAUDE_WORKER: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { stdout: '', stderr: '' };
  daemon.stdout.on('data', (chunk) => {
    logs.stdout += chunk.toString();
  });
  daemon.stderr.on('data', (chunk) => {
    logs.stderr += chunk.toString();
  });
  await waitForHealth(port, daemon);
  return { daemon, logs, port };
}

async function stopDaemon(daemon) {
  if (!daemon || daemon.exitCode != null) {
    return;
  }
  daemon.kill();
  const deadline = Date.now() + 3000;
  while (daemon.exitCode == null && Date.now() < deadline) {
    await sleep(50);
  }
}

async function waitForHealth(port, daemon) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`daemon exited early with code ${daemon.exitCode}`);
    }
    try {
      const health = await requestJson(port, 'GET', '/api/health');
      if (health.ok) {
        return health;
      }
    } catch (_) {
      await sleep(100);
    }
  }
  throw new Error('daemon health check timed out');
}

async function waitForTaskStatus(port, taskId, statuses, timeoutMs = 15000) {
  const wanted = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await requestJson(port, 'GET', `/api/tasks/${taskId}`);
    if (wanted.has(response.task.status)) {
      return response.task;
    }
    await sleep(200);
  }
  throw new Error(`task ${taskId} did not reach ${statuses.join('/')} within ${timeoutMs}ms`);
}

function writeFakeClaude(name, scriptBody) {
  const binDir = path.join(DATA_DIR, 'test-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, `${name}.js`);
  fs.writeFileSync(scriptPath, scriptBody);

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, `${name}.cmd`);
    fs.writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return commandPath;
  }

  const commandPath = path.join(binDir, name);
  fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

const CAPTURE_CLAUDE = `
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const required = ["single ' quote", 'backtick \` mark', '- dash-leading line', '繁中 payload'];
  for (const token of required) {
    if (!input.includes(token)) {
      console.error('missing token: ' + token);
      process.exit(2);
    }
  }
  const outMatch = input.match(/結果請寫到: (.+)/);
  if (!outMatch) {
    console.error('missing artifact path');
    process.exit(3);
  }
  const outPath = path.resolve(__dirname, '..', '..', outMatch[1].trim().replace(/\\//g, path.sep));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'DONE: captured stdin payload\\\\n');
  console.log('received stdin bytes ' + Buffer.byteLength(input));
});
`;

const NO_ARTIFACT_CLAUDE = `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log('completed without artifact');
});
`;

test('real worker receives special-character and long zh-TW task text through stdin', async () => {
  resetDataDir();
  const claudeCmd = writeFakeClaude('capture-claude', CAPTURE_CLAUDE);
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    ENABLE_REAL_CLAUDE_WORKER: '1',
    CLAUDE_CMD: claudeCmd,
  });

  try {
    const instruction = [
      '- dash-leading line',
      "single ' quote",
      'backtick ` mark',
      `繁中 payload ${'這是一段很長的繁體中文內容。'.repeat(160)}`,
    ].join('\n');
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'stdin reliability',
      instruction,
      timeout_sec: 10,
    });
    const task = await waitForTaskStatus(runtime.port, created.id, ['done']);
    assert.equal(task.status, 'done');
    assert.match(task.artifact_path, /\.result\.md$/);
    assert.ok(fs.existsSync(path.join(ROOT_DIR, task.artifact_path)));
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('timeout marks task blocked and writes an inbox event', async () => {
  resetDataDir();
  const runtime = await startDaemon({ MOCK_WORKER: '1' });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'timeout reliability',
      instruction: 'mock worker should be stopped by timeout',
      timeout_sec: 2,
    });
    const task = await waitForTaskStatus(runtime.port, created.id, ['blocked'], 8000);
    assert.equal(task.blocked_reason, 'timeout');
    const inboxFile = path.join(DATA_DIR, 'inbox', `${created.id}.blocked.json`);
    assert.ok(fs.existsSync(inboxFile), `missing inbox event: ${inboxFile}`);
    const event = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(event.event, 'blocked');
    assert.equal(event.summary, '卡住：timeout');
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('real worker success without artifact fails clearly', async () => {
  resetDataDir();
  const claudeCmd = writeFakeClaude('no-artifact-claude', NO_ARTIFACT_CLAUDE);
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    ENABLE_REAL_CLAUDE_WORKER: '1',
    CLAUDE_CMD: claudeCmd,
  });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'missing artifact',
      instruction: 'exit zero but do not write the result file',
      timeout_sec: 10,
    });
    const task = await waitForTaskStatus(runtime.port, created.id, ['failed']);
    assert.equal(task.error, 'no artifact produced');
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('Telegram token without admin chat id refuses polling', async () => {
  resetDataDir();
  const runtime = await startDaemon({
    TG_BOT_TOKEN: 'placeholder-token',
    ADMIN_TG_CHAT_ID: '',
  });

  try {
    const deadline = Date.now() + 3000;
    while (!runtime.logs.stderr.includes('Refusing Telegram polling') && Date.now() < deadline) {
      await sleep(100);
    }
    assert.match(runtime.logs.stderr, /Refusing Telegram polling/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

// --- (0) 硬閘截斷：按 code point 邊界切 ---
const TRUNCATION_DIR = path.join(DATA_DIR, 'truncation-fixture');

function writeTruncationFixture(name, text) {
  fs.mkdirSync(TRUNCATION_DIR, { recursive: true });
  const filePath = path.join(TRUNCATION_DIR, name);
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

test('truncation: head limit never splits a multi-byte character', () => {
  const text = '這是一段繁體中文內容'; // 每字 3 bytes，共 30 bytes
  const filePath = writeTruncationFixture('head-multibyte.md', text);

  // 正向 fixture：上限 10 落在第 4 個字（bytes 9..11）中間。
  const cut = agentModule.readUtf8WithinLimit(filePath, 10);
  assert.ok(!cut.text.includes('�'), `切點壞字: ${JSON.stringify(cut.text)}`);
  assert.equal(cut.text, '這是一');
  assert.ok(text.startsWith(cut.text));
  assert.equal(cut.truncated, true);
  assert.equal(cut.size_bytes, 30);

  // 負向 fixture：上限 9 本來就落在邊界上，行為不得被本次修正改掉。
  const aligned = agentModule.readUtf8WithinLimit(filePath, 9);
  assert.equal(aligned.text, '這是一');
  assert.equal(aligned.truncated, true);

  // 未超過上限時整份回傳、truncated=false。
  const whole = agentModule.readUtf8WithinLimit(filePath, 1024);
  assert.equal(whole.text, text);
  assert.equal(whole.truncated, false);
});

test('truncation: head limit never splits a 4-byte emoji', () => {
  const filePath = writeTruncationFixture('head-emoji.md', 'ab🙂cd');
  const cut = agentModule.readUtf8WithinLimit(filePath, 4); // 落在 emoji 的 4 bytes 中間
  assert.ok(!cut.text.includes('�'), `切點壞字: ${JSON.stringify(cut.text)}`);
  assert.equal(cut.text, 'ab');
  assert.equal(cut.truncated, true);
});

test('truncation: tail limit never splits a multi-byte character', () => {
  const text = '這是一段繁體中文內容';
  const filePath = writeTruncationFixture('tail-multibyte.md', text);

  // 正向 fixture：30-10=20 落在「中」（bytes 18..20）中間。
  const tail = agentModule.readUtf8Tail(filePath, 10);
  assert.ok(!tail.text.includes('�'), `切點壞字: ${JSON.stringify(tail.text)}`);
  assert.equal(tail.text, '文內容');
  assert.ok(text.endsWith(tail.text));
  assert.equal(tail.truncated, true);

  // 負向 fixture：30-12=18 剛好是邊界，回傳不得被本次修正改掉。
  const alignedTail = agentModule.readUtf8Tail(filePath, 12);
  assert.equal(alignedTail.text, '中文內容');
  assert.equal(alignedTail.truncated, true);

  // 未超過上限時整份回傳、truncated=false。
  const whole = agentModule.readUtf8Tail(filePath, 1024);
  assert.equal(whole.text, text);
  assert.equal(whole.truncated, false);
});

// --- (1) 崩潰護欄 ---
test('crash guardrail: installProcessGuards adds survivor handlers that do not rethrow', () => {
  const beforeUncaught = process.listeners('uncaughtException').slice();
  const beforeUnhandled = process.listeners('unhandledRejection').slice();

  agentModule.installProcessGuards();

  const addedUncaught = process.listeners('uncaughtException').filter((fn) => !beforeUncaught.includes(fn));
  const addedUnhandled = process.listeners('unhandledRejection').filter((fn) => !beforeUnhandled.includes(fn));

  try {
    assert.equal(addedUncaught.length, 1);
    assert.equal(addedUnhandled.length, 1);
    // 直接叫用 handler：確認它吞掉例外、只記 stderr，不把例外重拋出去。
    assert.doesNotThrow(() => addedUncaught[0](new Error('boom')));
    assert.doesNotThrow(() => addedUnhandled[0]('rejected reason'));
  } finally {
    for (const fn of addedUncaught) {
      process.removeListener('uncaughtException', fn);
    }
    for (const fn of addedUnhandled) {
      process.removeListener('unhandledRejection', fn);
    }
  }
});

test('crash guardrail: safeWriteJsonFile survives an unwritable path and reports failure', () => {
  resetDataDir();
  const dir = path.join(DATA_DIR, 'safe-write');
  fs.mkdirSync(dir, { recursive: true });

  const goodPath = path.join(dir, 'ok.json');
  assert.equal(agentModule.safeWriteJsonFile(goodPath, { value: 1 }), true);
  assert.ok(fs.existsSync(goodPath));

  // 用「檔案當父層」製造寫入失敗：blocker 是檔案，寫 blocker/child.json 必失敗。
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const badPath = path.join(blocker, 'child.json');
  let result;
  assert.doesNotThrow(() => {
    result = agentModule.safeWriteJsonFile(badPath, { value: 2 });
  });
  assert.equal(result, false);
});

// --- (2) 任務失敗基本 retry ---
test('task retry: real worker recovers on a later attempt and records retry_count', async () => {
  resetDataDir();
  const counterFile = path.join(DATA_DIR, 'test-bin', 'retry-recover.attempts');
  const claudeCmd = writeFakeClaude('retry-recover-claude', retryClaudeScript(counterFile, 1));
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    ENABLE_REAL_CLAUDE_WORKER: '1',
    CLAUDE_CMD: claudeCmd,
    MAX_TASK_RETRIES: '2',
    RETRY_BACKOFF_MS: '50',
  });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'retry recover',
      instruction: 'fail once then succeed',
      timeout_sec: 20,
    });
    const task = await waitForTaskStatus(runtime.port, created.id, ['done'], 20000);
    assert.equal(task.status, 'done');
    assert.equal(task.retry_count, 1);
    const progress = await requestJson(runtime.port, 'GET', `/api/tasks/${created.id}/progress`);
    assert.ok(
      progress.lines.some((line) => /retrying \(1\/2\)/.test(line)),
      `expected retry progress line, got: ${JSON.stringify(progress.lines)}`,
    );
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('task retry: real worker gives up as failed after retries are exhausted', async () => {
  resetDataDir();
  const counterFile = path.join(DATA_DIR, 'test-bin', 'retry-exhaust.attempts');
  const claudeCmd = writeFakeClaude('retry-exhaust-claude', retryClaudeScript(counterFile, 99));
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    ENABLE_REAL_CLAUDE_WORKER: '1',
    CLAUDE_CMD: claudeCmd,
    MAX_TASK_RETRIES: '1',
    RETRY_BACKOFF_MS: '50',
  });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'retry exhaust',
      instruction: 'always fail',
      timeout_sec: 20,
    });
    const task = await waitForTaskStatus(runtime.port, created.id, ['failed'], 20000);
    assert.equal(task.status, 'failed');
    assert.equal(task.retry_count, 1);
    assert.match(task.error, /exited with code 1/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

// --- (3) Telegram 斷線重連 ---
test('telegram reconnect: polling backs off then recovers after transient disconnects', async () => {
  resetDataDir();
  const fake = await startFakeTelegram(2);
  const runtime = await startDaemon({
    TG_BOT_TOKEN: 'test-token',
    ADMIN_TG_CHAT_ID: '123456',
    TG_API_BASE_URL: `http://127.0.0.1:${fake.port}`,
    TG_POLL_BASE_MS: '100',
    TG_POLL_MAX_BACKOFF_MS: '300',
    TG_REQUEST_TIMEOUT_MS: '2000',
  });

  try {
    const deadline = Date.now() + 8000;
    while (!/recovered after/.test(runtime.logs.stderr) && Date.now() < deadline) {
      await sleep(100);
    }
    assert.match(runtime.logs.stderr, /reconnecting, attempt/);
    assert.match(runtime.logs.stderr, /recovered after/);
    // 斷線後 daemon 仍存活、健康檢查正常。
    const health = await requestJson(runtime.port, 'GET', '/api/health');
    assert.equal(health.ok, true);
  } finally {
    await stopDaemon(runtime.daemon);
    fake.server.close();
  }
});

// --- (4) 讀取端遇未知 row type 跳筆、不整條凍結 ---
test('ledger reader: a task row that parses but is not an object does not freeze the whole list', () => {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const fixtures = {
    'ossship-good.json': JSON.stringify({
      id: 'ossship-good',
      status: 'done',
      title: '正常 row',
      created_at: '2026-08-29T00:00:00.000Z',
      updated_at: '2026-08-29T00:00:00.000Z',
    }),
    'ossship-row-null.json': 'null',
    'ossship-row-array.json': '[{"id":"nested"}]',
  };
  for (const [name, text] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(TASKS_DIR, name), text);
  }

  try {
    const tasks = agentModule.listTasks();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    // 正常 row 仍要吐出來——這是「跳該筆」與「整條凍結」的分界。
    assert.ok(byId.has('ossship-good'), '正常 row 必須仍在清單裡');
    for (const unknownId of ['ossship-row-null', 'ossship-row-array']) {
      const row = byId.get(unknownId);
      assert.ok(row, `${unknownId} 要留下佔位 row`);
      assert.equal(row.status, 'failed');
      assert.match(String(row.instruction), /unknown row type/);
    }
  } finally {
    for (const name of Object.keys(fixtures)) {
      fs.rmSync(path.join(TASKS_DIR, name), { force: true });
    }
  }
});

// --- (5) 閘類改動的耦合 regression：checked>=1 才算過 ---
const SCAN_SCRIPT = path.join(ROOT_DIR, 'scripts', 'ip-redline-scan.js');

// token 形狀的字串一律用拼接建出來，避免這支測試檔自己變成 redline 命中。
const FAKE_TOKEN = ['ghp', '_', 'A'.repeat(24)].join('');

function makeScanRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-redline-'));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), text, 'utf8');
  }
  return root;
}

function runScan(rootDir) {
  const result = spawnSync(process.execPath, [SCAN_SCRIPT], {
    env: { ...process.env, IP_SCAN_ROOT: rootDir },
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function readChecked(output) {
  const match = output.match(/files_checked=(\d+) lines_checked=(\d+)/);
  assert.ok(match, `輸出未帶 checked 計數: ${JSON.stringify(output)}`);
  return { files: Number(match[1]), lines: Number(match[2]) };
}

test('ip redline guard: zero files checked fails closed instead of printing PASS', () => {
  const roots = {
    clean: makeScanRoot({ 'readme.md': 'nothing sensitive here\n' }),
    dirty: makeScanRoot({ 'leak.md': `token: ${FAKE_TOKEN}\n` }),
    empty: makeScanRoot({}),
  };

  try {
    // 正向：有東西可掃且乾淨 → PASS，且 checked 計數必須是活的（>=1）。
    const clean = runScan(roots.clean);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /^PASS /m);
    const cleanChecked = readChecked(clean.out);
    assert.equal(cleanChecked.files, 1);
    assert.ok(cleanChecked.lines >= 1, `lines_checked 應 >=1，實得 ${cleanChecked.lines}`);

    // 負向一（偵測力）：同一支腳本仍抓得到 redline，證明 PASS 不是因為它瞎了。
    const dirty = runScan(roots.dirty);
    assert.equal(dirty.code, 1, dirty.out);
    assert.match(dirty.out, /found private markers or token-shaped secrets/);
    assert.equal(readChecked(dirty.out).files, 1);

    // 負向二（本次修正的判準）：掃到 0 個檔時，零命中不得判過。
    const empty = runScan(roots.empty);
    assert.equal(readChecked(empty.out).files, 0);
    assert.notEqual(empty.code, 0, `checked 0 檔卻回 exit 0: ${empty.out}`);
    assert.equal(empty.code, 2, empty.out);
    assert.match(empty.out, /checked 0 files/);
    assert.doesNotMatch(empty.out, /^PASS /m);

    // 三態必須互不相同，否則三個 fixture 全綠也不證明有鑑別力。
    assert.deepEqual(
      [clean.code, dirty.code, empty.code],
      [0, 1, 2],
      '乾淨／命中／空掃三態的 exit code 必須可區分',
    );
  } finally {
    for (const root of Object.values(roots)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

// 直接 require 正式腳本匯出的函式，讓測試驗的是產品碼本身的判準。
const scanModule = require(SCAN_SCRIPT);

test('ip redline guard: a read error is its own state and never swallows the scan summary', () => {
  const roots = [];
  const newRoot = (files) => {
    const root = makeScanRoot(files);
    roots.push(root);
    return root;
  };

  try {
    const root = newRoot({ 'readme.md': 'nothing sensitive here\n' });
    fs.mkdirSync(path.join(root, 'sub'));

    // 真實 fs 錯誤、不是注入的假物件：對目錄 readFileSync 在 win32 與 POSIX 都拋 EISDIR。
    const counters = { files_checked: 0, lines_checked: 0, binary_skipped: 0, read_errors: [] };
    const findings = scanModule.scanFile(path.join(root, 'sub'), root, counters);
    assert.deepEqual(findings, [], '讀不到的檔不得偽造成命中');
    assert.equal(counters.files_checked, 0, '讀失敗的檔不得被算進 checked');
    assert.equal(counters.read_errors.length, 1);
    assert.equal(counters.read_errors[0].file, 'sub');
    assert.match(counters.read_errors[0].code, /^E[A-Z]+$/, `errno 應具名: ${counters.read_errors[0].code}`);

    // 收尾沒被吞掉：判決仍帶得出 checked 計數與具名事由。
    const base = { files_checked: 1, lines_checked: 1, binary_skipped: 0, read_errors: [] };
    const broken = scanModule.decideExit({ ...base, findings: [], read_errors: counters.read_errors }, root);
    assert.equal(broken.code, 3);
    assert.match(broken.lines[0], /could not read 1 file\(s\)/);
    assert.match(broken.lines[0], /files_checked=1 lines_checked=1 binary_skipped=0 read_errors=1/);
    assert.match(broken.lines[1], /^sub \[read-error\] E[A-Z]+: /);

    // 四態的 exit code 必須互不相同，否則「掃壞了」在 rc 層等同「掃到了」。
    const clean = scanModule.decideExit({ ...base, findings: [] }, root);
    const dirty = scanModule.decideExit(
      { ...base, findings: [{ file: 'leak.md', line: 1, id: 'secret-token', match: '<redacted secret pattern>' }] },
      root,
    );
    const empty = scanModule.decideExit({ ...base, files_checked: 0, findings: [] }, root);
    assert.deepEqual(
      [clean.code, dirty.code, empty.code, broken.code],
      [0, 1, 2, 3],
      '乾淨／命中／空掃／讀不到四態的 exit code 必須可區分',
    );

    // 遮蔽能力要有可跑測試：偵測器抓到 token 之後，輸出不得把 token 原文再吐一次。
    const leaked = runScan(newRoot({ 'leak.md': `token: ${FAKE_TOKEN}\n` }));
    assert.equal(leaked.code, 1, leaked.out);
    assert.ok(!leaked.out.includes(FAKE_TOKEN), `偵測器輸出洩漏了它抓到的 token: ${leaked.out}`);
    assert.match(leaked.out, /<redacted secret pattern>/);
  } finally {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

// --- (6) 落地類命令的 exit 0 必須綁「實際寫了什麼」的回讀 ---
// 直接 require 正式腳本匯出的函式（不抄一份判準到測試裡），避免測試與產品碼脫鉤。readBackArtifact
// 已在檔頭與 requestJson 一起 require 進來。

function makeArtifactRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'demo-artifact-'));
}

function catchMessage(fn) {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return null;
}

test('demo readback: task reported done never counts as shipped without an artifact readback', () => {
  const root = makeArtifactRoot();
  const taskId = '11111111-2222-3333-4444-555555555555';
  const artifactPath = path.join(root, `${taskId}.result.json`);

  try {
    // 負向一：任務回 done 但檔根本沒寫 → 必須有錯，不得靜默放行。
    const missing = catchMessage(() => readBackArtifact(artifactPath, taskId));

    // 負向二：檔在但 0 bytes（寫入失敗最常見的殘骸形狀）。
    fs.writeFileSync(artifactPath, '');
    const empty = catchMessage(() => readBackArtifact(artifactPath, taskId));

    // 負向三：檔非空但不是合法 JSON（寫到一半被砍）。
    fs.writeFileSync(artifactPath, '{"task_id": ');
    const broken = catchMessage(() => readBackArtifact(artifactPath, taskId));

    // 負向四：合法 JSON 但內容對不上這次的任務（回讀到別人的 artifact）。
    fs.writeFileSync(
      artifactPath,
      JSON.stringify({ task_id: 'other-task', completed_at: '2026-09-01T00:00:00.000Z' }),
    );
    const mismatch = catchMessage(() => readBackArtifact(artifactPath, taskId));

    // 負向五：task_id 對得上但缺 completed_at → 存在＋非空仍不算完成。
    fs.writeFileSync(artifactPath, JSON.stringify({ task_id: taskId }));
    const incomplete = catchMessage(() => readBackArtifact(artifactPath, taskId));

    for (const [label, message] of Object.entries({ missing, empty, broken, mismatch, incomplete })) {
      assert.ok(message, `${label} 應該讓 demo 失敗，實際卻通過了`);
    }
    assert.match(missing, /no artifact was written/);
    assert.match(empty, /is empty \(0 bytes\)/);
    assert.match(broken, /not valid JSON/);
    assert.match(mismatch, /task_id mismatch/);
    assert.match(incomplete, /completed_at is missing/);

    // 五種失敗訊息必須互不相同，否則「有擋」不等於「擋得出是哪一種」。
    const messages = [missing, empty, broken, mismatch, incomplete];
    assert.equal(new Set(messages).size, messages.length, `失敗訊息無鑑別力: ${JSON.stringify(messages)}`);

    // 正向：真的寫好了才回讀成功，且回讀量測是活的（bytes = 實際位元組數）。
    const good = { task_id: taskId, completed_at: '2026-09-01T00:00:00.000Z', output: 'ok' };
    fs.writeFileSync(artifactPath, JSON.stringify(good));
    const receipt = readBackArtifact(artifactPath, taskId);
    assert.equal(receipt.completed_at, good.completed_at);
    assert.equal(receipt.bytes, Buffer.byteLength(JSON.stringify(good)));
    assert.ok(receipt.bytes > 0, 'bytes 應為實際位元組數');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- (7) 串流中途出錯要 signal 成 abort，不得回報 clean EOF ---
// 用裸 socket 當假伺服器，才能製造「送了 header、body 送一半就砍線」這種 http.createServer 做不出來的收場。
function withRawServer(handler, run) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {}); // 我們就是故意砍線，socket 這頭的 ECONNRESET 不該把測試打掛
      handler(sock);
    });
    server.listen(0, '127.0.0.1', async () => {
      let outcome;
      try {
        outcome = { ok: await run(server.address().port) };
      } catch (error) {
        outcome = { error };
      }
      // net.Server 沒有 closeAllConnections()（那是 http.Server 才有）：keep-alive 的連線會讓
      // server.close() 等不到回呼，測試就掛在收尾而不是判準上。手動把 socket 收乾淨。
      for (const sock of sockets) {
        sock.destroy();
      }
      server.close(() => (outcome.error ? reject(outcome.error) : resolve(outcome.ok)));
    });
  });
}

// 舊寫法只掛 'end'，而中途被砍的回應根本不發 'end'（node v22 實測只發 aborted/error/close），
// 所以 Promise 會永遠不 settle。這裡的 2 秒上限就是「不再無聲卡死」的判準本身。
async function settleWithin(promise, ms, label) {
  let timer;
  const verdict = await Promise.race([
    promise.then((value) => ({ kind: 'resolved', value }), (error) => ({ kind: 'rejected', error })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'hung' }), ms);
    }),
  ]);
  clearTimeout(timer);
  assert.notEqual(verdict.kind, 'hung', `${label}: requestJson 在 ${ms}ms 內沒有 settle（等同無聲卡死）`);
  return verdict;
}

test('stream abort: 回應中途被砍要具名 reject，不得無聲卡死也不得當成 clean EOF', async () => {
  // A. 宣告 Content-Length 100 卻只送 10 bytes 就砍線
  const truncated = await withRawServer(
    (sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n');
      sock.write('{"ok":true');
      setTimeout(() => sock.destroy(), 30);
    },
    (port) => settleWithin(requestJson(port, 'GET', '/api/health'), 2000, 'truncated'),
  );
  assert.equal(truncated.kind, 'rejected', '半截 body 不得被當成成功回應');
  assert.match(truncated.error.message, /aborted after 10 bytes/);
  assert.match(truncated.error.message, /GET \/api\/health/, '錯誤訊息要指得出是哪一個請求');

  // B. header 之後一個 body byte 都沒送就砍線 —— 舊寫法連 raw 都是空的，最像「乾淨結束」
  const zeroByte = await withRawServer(
    (sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n');
      setTimeout(() => sock.destroy(), 30);
    },
    (port) => settleWithin(requestJson(port, 'GET', '/api/tasks'), 2000, 'zero-byte abort'),
  );
  assert.equal(zeroByte.kind, 'rejected', '零位元組的中斷不得回報成功');
  assert.match(zeroByte.error.message, /aborted after 0 bytes/);

  // C. 合法收尾但 body 是空的：這條走 'end'，舊寫法會 resolve({}) —— 正是「回報 clean EOF」
  const emptyBody = await withRawServer(
    (sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    },
    (port) => settleWithin(requestJson(port, 'GET', '/api/health'), 2000, 'empty body'),
  );
  assert.equal(emptyBody.kind, 'rejected', '空 body 不得折成 {} 當成功 JSON 回應');
  assert.match(emptyBody.error.message, /closed with an empty body/);

  // 三種收場的訊息必須互不相同，否則「有擋」不等於「擋得出是哪一種」。
  const messages = [truncated.error.message, zeroByte.error.message, emptyBody.error.message];
  assert.equal(new Set(messages).size, 3, `中斷訊息無鑑別力: ${JSON.stringify(messages)}`);

  // 正向對照：完整回應照樣 resolve，上面三條不是靠「全部都 reject」過關的。
  const good = await withRawServer(
    (sock) => {
      const payload = JSON.stringify({ ok: true, note: 'complete' });
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n`);
      sock.end(payload);
    },
    (port) => settleWithin(requestJson(port, 'GET', '/api/health'), 2000, 'complete body'),
  );
  assert.equal(good.kind, 'resolved', '完整回應不得被誤判成中斷');
  assert.deepEqual(good.value, { ok: true, note: 'complete' });

  // 錯誤碼路徑仍要吃 body 裡的具名 error，中斷處理沒有把它蓋掉。
  const failed = await withRawServer(
    (sock) => {
      const payload = JSON.stringify({ error: 'task not found' });
      sock.write(`HTTP/1.1 404 Not Found\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n`);
      sock.end(payload);
    },
    (port) => settleWithin(requestJson(port, 'GET', '/api/tasks/x'), 2000, 'http 404'),
  );
  assert.equal(failed.kind, 'rejected');
  assert.equal(failed.error.message, 'task not found');
});
