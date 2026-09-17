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

// 掃描根一律用明示參數交給腳本；ambient IP_SCAN_ROOT 先清掉，要測繼承行為的測項自己塞回去。
function runScan(rootDir, { explicit = true, ambientRoot = null } = {}) {
  const env = { ...process.env };
  delete env.IP_SCAN_ROOT;
  if (ambientRoot !== null) {
    env.IP_SCAN_ROOT = ambientRoot;
  }
  const args = explicit ? [SCAN_SCRIPT, `--root=${rootDir}`] : [SCAN_SCRIPT];
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
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

test('ip redline guard: skipped directories are disclosed as unverified instead of hidden behind PASS', () => {
  // in-scope 有東西可掃（PASS 才有意義），out-of-scope 的 logs/ 裡放一顆真的會被抓到的 token。
  const scoped = makeScanRoot({ 'readme.md': 'nothing sensitive here\n' });
  fs.mkdirSync(path.join(scoped, 'logs'));
  fs.writeFileSync(path.join(scoped, 'logs', 'leak.md'), `token: ${FAKE_TOKEN}\n`, 'utf8');

  // 控制組：同一顆 token 放在射程內的子目錄 → 必須被抓到，證明上面的 PASS 是射程造成的，不是瞎了。
  const inScope = makeScanRoot({ 'readme.md': 'nothing sensitive here\n' });
  fs.mkdirSync(path.join(inScope, 'notlogs'));
  fs.writeFileSync(path.join(inScope, 'notlogs', 'leak.md'), `token: ${FAKE_TOKEN}\n`, 'utf8');

  // 對照組：整棵樹都在射程內 → 不得有任何「未驗」揭露，否則揭露行變成每次都印的噪音。
  const noSkip = makeScanRoot({ 'readme.md': 'nothing sensitive here\n' });

  try {
    const skipped = runScan(scoped);
    assert.equal(skipped.code, 0, skipped.out);
    assert.match(skipped.out, /^PASS /m);
    // 本次修正的判準：射程外的目錄要對帳實際目錄樹、逐個具名，並在 checked 計數裡留下分母。
    assert.match(skipped.out, /skipped_dirs=1\b/, `PASS 未揭露射程外目錄數: ${skipped.out}`);
    assert.match(
      skipped.out,
      /counted as unverified \(not as clean\): logs$/m,
      `PASS 未具名射程外目錄: ${skipped.out}`,
    );

    const caught = runScan(inScope);
    assert.equal(caught.code, 1, caught.out);
    assert.match(caught.out, /notlogs\/leak\.md:\d+ \[secret-token\]/);

    const clean = runScan(noSkip);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /skipped_dirs=0\b/, clean.out);
    assert.doesNotMatch(clean.out, /counted as unverified/, `射程全覆蓋時不該印揭露行: ${clean.out}`);
  } finally {
    for (const root of [scoped, inScope, noSkip]) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

// 直接 require 正式腳本匯出的函式，讓測試驗的是產品碼本身的判準。
const scanModule = require(SCAN_SCRIPT);

test('ip redline guard: an inherited scan root without --root fails closed instead of scanning it', () => {
  const wrongTree = makeScanRoot({ 'readme.md': 'nothing sensitive here\n' });
  const staleRoot = path.join(os.tmpdir(), 'ip-redline-stale-root-does-not-exist');

  try {
    // 主判準：只有繼承來的 IP_SCAN_ROOT、呼叫端沒宣告 --root → 拒掃。
    // 舊行為會直接吃下這個值、掃 fixture 樹、還因為 files_checked>=1 印出 PASS。
    const inherited = runScan(wrongTree, { explicit: false, ambientRoot: wrongTree });
    assert.equal(inherited.code, 5, inherited.out);
    assert.doesNotMatch(inherited.out, /^PASS /m, `繼承來的根不得產出通過證據: ${inherited.out}`);
    assert.match(inherited.out, /inherited IP_SCAN_ROOT=/);

    // 負向控制（證明拒的是「沒宣告」不是「有 ambient 值」）：同一個殘留值在明示參數在場時
    // 完全不參與判斷，掃的是 --root 指的那棵樹。
    const explicit = runScan(wrongTree, { ambientRoot: staleRoot });
    assert.equal(explicit.code, 0, explicit.out);
    assert.match(explicit.out, /^PASS /m);
    assert.equal(readChecked(explicit.out).files, 1);

    // 旗標在場但沒帶目錄 ＝ 參數沒填好，不得退化成 repo root。
    const emptyFlag = runScan('', { ambientRoot: null });
    assert.equal(emptyFlag.code, 5, emptyFlag.out);
    assert.match(emptyFlag.out, /--root was given without a directory/);

    // 三個 rc 要跟既有四態分得開，否則「根拿不到」在 rc 層等同「掃到了」。
    assert.ok(![0, 1, 2, 3, 4].includes(inherited.code), `root 拒絕態的 rc 撞到既有態: ${inherited.code}`);
  } finally {
    fs.rmSync(wrongTree, { recursive: true, force: true });
  }
});

test('ip redline guard: resolveRootDir names every branch and never reads ambient state as a declaration', () => {
  // 明示旗標 → 用它，且殘留的 ambient 值不參與判斷。
  const explicit = scanModule.resolveRootDir(['--root=/tmp/x'], { IP_SCAN_ROOT: '/tmp/stale' });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.reason, 'explicit_flag');
  assert.equal(explicit.root, path.resolve('/tmp/x'));

  // 只有繼承值、沒有旗標 → fail closed，且事由與繼承來的值都要具名。
  const inherited = scanModule.resolveRootDir([], { IP_SCAN_ROOT: '/tmp/stale' });
  assert.equal(inherited.ok, false);
  assert.equal(inherited.reason, 'inherited_root_without_flag');
  assert.equal(inherited.root, null);
  const refusal = scanModule.refuseRootVerdict(inherited);
  assert.equal(refusal.code, 5);
  assert.match(refusal.lines[0], /IP_SCAN_ROOT=/);

  // 旗標在場但沒帶目錄的三種寫法都算「參數沒填好」。
  for (const argv of [['--root'], ['--root='], ['--root=   ']]) {
    const empty = scanModule.resolveRootDir(argv, {});
    assert.equal(empty.ok, false, `${JSON.stringify(argv)} 應判參數沒填好`);
    assert.equal(empty.reason, 'empty_explicit_root');
  }

  // 兩者都沒有 → 預設 repo root，而它只從 __dirname 推導、不含 ambient 成分。
  const fallback = scanModule.resolveRootDir([], {});
  assert.equal(fallback.ok, true);
  assert.equal(fallback.reason, 'default_repo_root');
  assert.equal(fallback.root, ROOT_DIR);
  // 空字串／全空白的 ambient 值不是宣告，不得把預設路徑擠掉。
  for (const blank of ['', '   ']) {
    assert.equal(scanModule.resolveRootDir([], { IP_SCAN_ROOT: blank }).reason, 'default_repo_root');
  }
});

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

test('ip redline guard: an empty allowlist scope or pattern never becomes match-all', () => {
  const LEAK_LINE = `token: ${FAKE_TOKEN}`;
  const REAL = { file: null, regex: /token: gh/, reason: '對照組：填好的條目確實會豁免' };

  // 正向對照：條目填好時豁免真的生效——證明後面的 false 不是因為 isAllowed 整支瞎了。
  assert.equal(scanModule.isAllowed('leak.md', LEAK_LINE, [REAL]), true);
  assert.equal(scanModule.isUsableAllowEntry(REAL), true);

  // 每一種空值／空 wildcard 都必須走拒絕分支（不匹配），而不是放行全部。
  const rejected = {
    'empty pattern': { file: null, regex: new RegExp('') },
    'literal empty regex': { file: null, regex: /(?:)/ },
    'dot-star wildcard': { file: null, regex: /.*/ },
    'empty file scope': { file: '', regex: /token: gh/ },
    'blank file scope': { file: '   ', regex: /token: gh/ },
    'missing regex': { file: null },
    'string instead of regex': { file: null, regex: 'token: gh' },
  };
  for (const [label, entry] of Object.entries(rejected)) {
    assert.equal(scanModule.isUsableAllowEntry(entry), false, `${label} 不該被當成可用條目`);
    assert.equal(scanModule.isAllowed('leak.md', LEAK_LINE, [entry]), false, `${label} 被當成 match-all 放行`);
    // 壞條目不得連帶把同一份清單裡填好的條目一起廢掉。
    assert.equal(scanModule.isAllowed('leak.md', LEAK_LINE, [entry, REAL]), true, `${label} 汙染了同清單的好條目`);
  }

  // scope 的三態要可區分：null＝全檔、對得上的檔名＝該檔、對不上的檔名＝不匹配。
  assert.equal(scanModule.isAllowed('other.md', LEAK_LINE, [{ file: 'leak.md', regex: /token: gh/ }]), false);
  assert.equal(scanModule.isAllowed('leak.md', LEAK_LINE, [{ file: 'leak.md', regex: /token: gh/ }]), true);

  // 正式清單自己必須全數合規，否則線上那份就是壞的。
  for (const entry of scanModule.ALLOWLIST) {
    assert.equal(scanModule.isUsableAllowEntry(entry), true, `正式白名單有不合規條目: ${entry.reason}`);
  }

  // 端到端：壞條目不得讓真的 redline 靜默消失。
  const root = makeScanRoot({ 'leak.md': `${LEAK_LINE}\n` });
  try {
    const leaked = runScan(root);
    assert.equal(leaked.code, 1, leaked.out);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ip redline guard: an empty predicate list is refused at startup, not scanned into a fake PASS', () => {
  const GOOD = { id: 'good', regex: /token: gh/ };

  // 正向對照：線上那兩份清單自己必須合規且不觸發警告，否則後面的 false 只是整支判準瞎了。
  const live = scanModule.checkListPredicates();
  assert.equal(live.ok, true, '正式偵測清單判成不可用');
  assert.equal(live.usable_patterns, scanModule.REDLINE_PATTERNS.length);
  assert.equal(live.usable_allow, scanModule.ALLOWLIST.length);
  assert.deepEqual(live.warnings, [], `正式清單不該有啟動警告: ${live.warnings}`);

  // 偵測清單這一側：空清單與「宣告了但一條可用的都沒有」都要走拒絕分支。
  const refused = {
    'empty list': [],
    'not an array': null,
    'missing id': [{ regex: /token: gh/ }],
    'blank id': [{ id: '   ', regex: /token: gh/ }],
    'string instead of regex': [{ id: 'bad', regex: 'token: gh' }],
    'null entry': [null],
  };
  for (const [label, patterns] of Object.entries(refused)) {
    const check = scanModule.checkListPredicates(patterns, [GOOD]);
    assert.equal(check.ok, false, `${label} 不該被當成可用的偵測清單`);
    assert.equal(check.usable_patterns, 0, `${label} 的 usable 計數對不上`);
    // 壞條目不得連帶把同清單裡填好的條目一起廢掉。
    const mixed = scanModule.checkListPredicates([...(patterns || []), GOOD], [GOOD]);
    assert.equal(mixed.ok, true, `${label} 汙染了同清單的好條目`);
    assert.equal(mixed.usable_patterns, 1);
  }

  // 判準不可用時，一個檔都不准讀就得收手——「不等第一筆請求」講的就是這個順序。
  const root = makeScanRoot({ 'leak.md': `token: ${FAKE_TOKEN}\n` });
  try {
    const dead = scanModule.checkListPredicates([], scanModule.ALLOWLIST);
    const result = scanModule.scanTree(root, dead);
    assert.equal(result.files_checked, 0, '判準已空還去讀檔');
    assert.deepEqual(result.findings, []);
    const verdict = scanModule.decideExit(result, root);
    assert.equal(verdict.code, 4, JSON.stringify(verdict));
    assert.equal(verdict.stream, 'error');
    assert.match(verdict.lines[0], /^FAIL /);
    assert.match(verdict.lines[0], /refused before reading any file/);
    assert.match(verdict.lines[0], /usable_patterns=0\/0/, '拒絕訊息要講得出分母');

    // 正向對照：同一個 root 在判準健全時確實掃得到東西，證明 files_checked=0 是被拒絕擋下的。
    const alive = scanModule.scanTree(root);
    assert.ok(alive.files_checked >= 1, '健全判準下仍掃 0 個檔，對照組不成立');
    assert.equal(alive.findings.length, 1);

    // 五態的 exit code 必須互不相同，否則「判準空了」在 rc 層等同「掃到了」。
    const base = { files_checked: 1, lines_checked: 1, binary_skipped: 0, read_errors: [] };
    const codes = [
      scanModule.decideExit({ ...base, findings: [] }, root).code,
      scanModule.decideExit(
        { ...base, findings: [{ file: 'leak.md', line: 1, id: 'secret-token', match: '<redacted secret pattern>' }] },
        root,
      ).code,
      scanModule.decideExit({ ...base, files_checked: 0, findings: [] }, root).code,
      scanModule.decideExit(
        { ...base, findings: [], read_errors: [{ file: 'sub', code: 'EISDIR', message: 'is a directory' }] },
        root,
      ).code,
      verdict.code,
    ];
    assert.deepEqual(codes, [0, 1, 2, 3, 4], '乾淨／命中／空掃／讀不到／判準空五態的 exit code 必須可區分');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 白名單這一側：空清單不擋掃描，但要在啟動時就具名警告，而且講得出分母。
  const emptyAllow = scanModule.checkListPredicates(scanModule.REDLINE_PATTERNS, []);
  assert.equal(emptyAllow.ok, true, '白名單空不該擋下掃描');
  assert.equal(emptyAllow.warnings.length, 1, JSON.stringify(emptyAllow.warnings));
  assert.match(emptyAllow.warnings[0], /^WARN /);
  assert.match(emptyAllow.warnings[0], /declared=0 usable=0/);

  // 宣告了兩條卻全被 fail closed 掉，是最該被吼出來的那一種空：declared 與 usable 對不上。
  const allBad = scanModule.checkListPredicates(scanModule.REDLINE_PATTERNS, [
    { file: '', regex: /token: gh/ },
    { file: null, regex: /.*/ },
  ]);
  assert.equal(allBad.usable_allow, 0);
  assert.equal(allBad.warnings.length, 1);
  assert.match(allBad.warnings[0], /declared=2 usable=0/);

  // 有一條可用就不該再警告，否則警告本身沒有鑑別力。
  assert.deepEqual(scanModule.checkListPredicates(scanModule.REDLINE_PATTERNS, [GOOD, { file: '' }]).warnings, []);
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

// --- (8) 通過宣告的分母必須是實跑過的檢查，不是名目上的「doctor」 ---
const DOCTOR_SCRIPT = path.join(ROOT_DIR, 'scripts', 'doctor.js');

function runDoctor(args, env) {
  const result = spawnSync(process.execPath, [DOCTOR_SCRIPT, ...args], {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}

function readDoctorCoverage(output) {
  const match = output.match(/checks_run=(\d+)\/(\d+) not_run=([^;)]*)/);
  assert.ok(match, `doctor 收尾未帶檢查分母: ${JSON.stringify(output)}`);
  return {
    ran: Number(match[1]),
    declared: Number(match[2]),
    not_run: match[3] === 'none' ? [] : match[3].split(','),
  };
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function withOccupiedPort(run) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      let outcome;
      try {
        outcome = { ok: await run(port) };
      } catch (error) {
        outcome = { error };
      }
      server.close(() => (outcome.error ? reject(outcome.error) : resolve(outcome.ok)));
    });
  });
}

test('doctor coverage: the pass line names how many checks actually ran, not the nominal "doctor"', async () => {
  // --json 建出來的 checks 是「這支腳本到底有幾項檢查」的唯一事實來源。
  const json = runDoctor(['--json'], {});
  const report = JSON.parse(json.stdout);
  const jsonIds = report.checks.map((check) => check.id);
  assert.ok(jsonIds.length >= 2, `--json 只回了 ${jsonIds.length} 項檢查，對照組不成立`);
  assert.equal(new Set(jsonIds).size, jsonIds.length, `--json 的 check id 有重複: ${jsonIds}`);

  // 正向：預設 text 模式在 PASS 時就要把分母印出來（挑一個沒人佔的 port，避免走到 WARN）。
  const passOut = runDoctor([], { PORT: String(await freePort()) });
  assert.match(passOut.out, /✓ Doctor passed/, passOut.out);
  const passed = readDoctorCoverage(passOut.out);

  // 分母漂移釘死：宣告的總數必須等於 --json 實際跑的檢查數。
  // 之後有人往 runJsonDoctor 加第 9 項卻忘了更新宣告清單，這一條會紅，而不是讓揭露靜默過時。
  assert.equal(
    passed.declared,
    jsonIds.length,
    `text 模式宣告的分母 ${passed.declared} 對不上 --json 的 ${jsonIds.length} 項檢查`,
  );

  // 分子與未涵蓋清單要湊得回分母，否則這個比值只是兩個無關的數字擺在一起。
  assert.equal(passed.ran + passed.not_run.length, passed.declared, JSON.stringify(passed));
  assert.ok(passed.ran >= 1 && passed.ran < passed.declared, `text 模式應覆蓋部分而非全部: ${JSON.stringify(passed)}`);

  // 未涵蓋的每一項都要是真的存在的檢查 id，不能是寫錯字的幽靈名字。
  for (const id of passed.not_run) {
    assert.ok(jsonIds.includes(id), `not_run 列了不存在的檢查 id: ${id}`);
  }

  // 具名點出這次修正最在意的那個缺口：攔 CLAUDE_BYPASS_APPROVALS 的 env_valid 預設不會跑，
  // 沒有這行揭露時，一個 ✓ 會被讀成「不安全旗標也驗過了」。
  assert.ok(passed.not_run.includes('env_valid'), `未涵蓋清單漏了 env_valid: ${JSON.stringify(passed)}`);

  // 分母要跟著每一種收尾走，不是只有 PASS 那行才帶：占住 port 讓它走 WARN。
  const warnOut = await withOccupiedPort(async (busyPort) => runDoctor([], { PORT: String(busyPort) }));
  assert.match(warnOut.out, /Doctor completed with warnings/, warnOut.out);
  const warned = readDoctorCoverage(warnOut.out);
  assert.deepEqual(warned, passed, 'WARN 收尾的分母與 PASS 不一致');

  // 鑑別力：PASS 與 WARN 是兩種真的不同的收場，不是同一句話被比對兩次。
  assert.notEqual(passOut.out, warnOut.out);
  assert.doesNotMatch(warnOut.out, /✓ Doctor passed/);
});

// --- (9) 狀態有歧義時不寫權威標記：磁碟上已有別人的終局判決就拒寫並具名診斷 ---
const MOCK_WORKER_SCRIPT = path.join(ROOT_DIR, 'examples', 'mock-worker', 'worker.js');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');

function runMockWorker(taskId) {
  const result = spawnSync(process.execPath, [MOCK_WORKER_SCRIPT, taskId], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function fixtureTaskPath(taskId) {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function writeTaskFixture(taskId, status, extra = {}) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const stamp = new Date().toISOString();
  const task = { id: taskId, title: `fixture ${taskId}`, instruction: 'noop', status, created_at: stamp, updated_at: stamp, ...extra };
  fs.writeFileSync(fixtureTaskPath(taskId), `${JSON.stringify(task, null, 2)}\n`);
  return task;
}

function readTaskFixture(taskId) {
  return JSON.parse(fs.readFileSync(fixtureTaskPath(taskId), 'utf8'));
}

test('mock worker: an authoritative status already on disk is never overwritten, the refusal is named', () => {
  const blockedId = 'fixture-terminal-owned-on-disk';
  const ambiguousId = 'fixture-status-unreadable';
  const okId = 'fixture-status-writable';
  const created = [blockedId, ambiguousId, okId];
  try {
    // daemon 的 timeout 路徑就是這樣落的：先把任務標成 blocked(timeout)、再砍 worker。
    // 這一棒若還活著跑完，舊行為會把別人的終局判決蓋成 done——而且行程內的
    // terminalStatusOwner 在新行程裡是 null，看不到磁碟上已經有人擁有。
    const before = writeTaskFixture(blockedId, 'blocked', { blocked_reason: 'timeout' });
    const refused = runMockWorker(blockedId);
    assert.notEqual(refused.code, 0, `拒寫權威標記時必須非零收場: ${JSON.stringify(refused)}`);
    assert.match(refused.out, /terminal_status_owned_on_disk/, refused.out);
    assert.match(refused.out, new RegExp(`${blockedId} is already blocked on disk`), refused.out);
    // 拒絕要帶著具名理由回到呼叫端，不是一個 null deref 的 TypeError。
    assert.match(refused.out, /status_write_refused/, refused.out);
    assert.doesNotMatch(refused.out, /Cannot read propert/, refused.out);
    // 最硬的證據：磁碟上那份判決一個欄位都沒被動到（連 updated_at 都沒刷新）。
    assert.deepEqual(readTaskFixture(blockedId), before, '磁碟上的 blocked 判決被覆寫了');
    assert.equal(fs.existsSync(path.join(ARTIFACTS_DIR, `${blockedId}.result.json`)), false);

    // 判不出來也算歧義：status 欄空著時不得當成「沒人擁有」而放行覆寫。
    const ambiguousBefore = writeTaskFixture(ambiguousId, '');
    const ambiguous = runMockWorker(ambiguousId);
    assert.notEqual(ambiguous.code, 0, JSON.stringify(ambiguous));
    assert.match(ambiguous.out, /unreadable\(missing_status\)/, ambiguous.out);
    assert.deepEqual(readTaskFixture(ambiguousId), ambiguousBefore);

    // 鑑別力：沒有歧義的 pending 任務照跑到 done，這條閘不是把 worker 一律鎖死。
    writeTaskFixture(okId, 'pending');
    const shipped = runMockWorker(okId);
    assert.equal(shipped.code, 0, shipped.out);
    assert.doesNotMatch(shipped.out, /terminal_status_owned_on_disk/, shipped.out);
    assert.equal(readTaskFixture(okId).status, 'done');
    assert.equal(fs.existsSync(path.join(ARTIFACTS_DIR, `${okId}.result.json`)), true);
  } finally {
    for (const id of created) {
      fs.rmSync(fixtureTaskPath(id), { force: true });
      fs.rmSync(path.join(TASKS_DIR, `${id}.progress.jsonl`), { force: true });
      fs.rmSync(path.join(ARTIFACTS_DIR, `${id}.result.json`), { force: true });
    }
  }
});

// --- (10) 健康紅燈要落存失敗原因與時戳，不是只翻一個 exit code ---
const HEALTH_RECORD_PATH = path.join(DATA_DIR, 'health', 'last-run.json');

function runDoctorAndReadHealth(args, env) {
  // 先砍掉舊記錄，這樣「檔案在」本身就證明是這一輪寫的，不是上一輪留下來的。
  fs.rmSync(HEALTH_RECORD_PATH, { force: true });
  const run = runDoctor(args, env);
  assert.ok(fs.existsSync(HEALTH_RECORD_PATH), `doctor 收尾沒落存健康記錄: ${run.out}`);
  return { run, record: JSON.parse(fs.readFileSync(HEALTH_RECORD_PATH, 'utf8')) };
}

test('doctor health record: a red verdict persists the named reason and a UTC timestamp, not just the exit code', async () => {
  const before = Date.now();

  // 紅燈：CLAUDE_BYPASS_APPROVALS=1 會讓 env_valid 翻紅，而且帶著具名 rule。
  const red = runDoctorAndReadHealth(['--json'], { CLAUDE_BYPASS_APPROVALS: '1' });
  assert.notEqual(red.run.code, 0, `不安全旗標下應收非零: ${red.run.out}`);
  assert.equal(red.record.ok, false, JSON.stringify(red.record));
  assert.equal(red.record.mode, 'json');

  // 時戳要是 UTC 帶 Z、而且真的是這一輪寫的，不是抄來的字串。
  assert.match(red.record.checked_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, red.record.checked_at);
  const stamp = Date.parse(red.record.checked_at);
  assert.ok(stamp >= before && stamp <= Date.now() + 1000, `checked_at 不在本輪窗口內: ${red.record.checked_at}`);

  // 核心：讀記錄的人要看得出「哪一項紅、哪條規則觸發的」，而不是只拿到一個布林值。
  const envFailure = red.record.failures.find((item) => item.id === 'env_valid');
  assert.ok(envFailure, `紅燈記錄沒點名 env_valid: ${JSON.stringify(red.record.failures)}`);
  assert.ok(envFailure.rule_ids.includes('env.unsafe_flag'), JSON.stringify(envFailure));
  assert.match(envFailure.detail, /CLAUDE_BYPASS_APPROVALS/, envFailure.detail);

  // 恢復後要覆寫，否則磁碟上那份過期的紅會被下一個讀的人當現況——
  // 那等於把「只翻旗標」的毛病原封不動搬進檔案裡。
  const after = runDoctorAndReadHealth(['--json'], { CLAUDE_BYPASS_APPROVALS: '0' });
  assert.equal(
    after.record.failures.some((item) => item.id === 'env_valid'),
    false,
    `旗標移除後記錄還留著舊的 env_valid 紅燈: ${JSON.stringify(after.record.failures)}`,
  );
  assert.ok(Date.parse(after.record.checked_at) >= stamp, '記錄的時戳沒有跟著這一輪往前走');

  // text 模式也要落存，而且要把分母一起帶進記錄：沒有它，一筆 ok:true 會被讀成「八項全過」，
  // 而 text 模式其實只跑得動三項。
  const text = runDoctorAndReadHealth([], { PORT: String(await freePort()) });
  assert.match(text.run.out, /✓ Doctor passed/, text.run.out);
  assert.equal(text.record.mode, 'text');
  assert.equal(text.record.ok, true, JSON.stringify(text.record));
  assert.deepEqual(text.record.failures, []);
  assert.ok(text.record.coverage, `text 模式的健康記錄沒帶分母: ${JSON.stringify(text.record)}`);
  assert.equal(text.record.coverage.ran, 3, JSON.stringify(text.record.coverage));
  assert.ok(
    text.record.coverage.ran < text.record.coverage.declared,
    `text 模式的分母應小於宣告總數: ${JSON.stringify(text.record.coverage)}`,
  );
  assert.ok(text.record.coverage.not_run.includes('env_valid'), JSON.stringify(text.record.coverage));
});

// --- (11) 截斷揭露 + 進度時間戳：這一包 API 之前零測試覆蓋，連入口都沒開 ---
// 分界說清楚：collect* 回「未切過的全量」，list* 回「切過上限的畫面用量」，
// 兩者分得開，dropped 才有分母。以下每條測的都是「上限砍掉的東西有沒有被誠實講出來」。
const INBOX_DIR = path.join(DATA_DIR, 'inbox');

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('truncationInfo: dropped 是實際計數；total 拿不到時回 null，不准拿 0 充數', () => {
  const { truncationInfo } = agentModule;

  const cut = truncationInfo(137, 50, 'events_list_cap', 50, '事件清單上限 50 筆');
  assert.equal(cut.truncated, true);
  assert.equal(cut.dropped, 87, JSON.stringify(cut));
  assert.equal(cut.total, 137);
  assert.equal(cut.limit, 50);
  assert.equal(cut.limit_name, 'events_list_cap');
  assert.equal(cut.reason, '事件清單上限 50 筆');

  const whole = truncationInfo(12, 12, 'events_list_cap', 50, 'r');
  assert.equal(whole.truncated, false);
  assert.equal(whole.dropped, 0, JSON.stringify(whole));

  // total 不可得、而且 returned 已經頂到上限 → 是「不知道有沒有被砍」，不是「沒被砍」。
  // 這裡如果退化成 false 或 dropped=0，畫面就會把一份可能缺資料的清單顯示成完整的。
  const unknownAtCap = truncationInfo(null, 50, 'events_list_cap', 50, 'r');
  assert.equal(unknownAtCap.truncated, null, JSON.stringify(unknownAtCap));
  assert.equal(unknownAtCap.dropped, null);
  assert.equal(unknownAtCap.total, null);

  // total 不可得但沒頂到上限 → 可以斷定不是上限砍的，這時 false 是真的。
  const unknownBelowCap = truncationInfo(undefined, 3, 'events_list_cap', 50, 'r');
  assert.equal(unknownBelowCap.truncated, false, JSON.stringify(unknownBelowCap));
  assert.equal(unknownBelowCap.dropped, null);
});

test('normalizeProgressLimit: 壞值一律退回 30，合法值收在 1..500，不讓 querystring 決定讀多大一份檔', () => {
  const { normalizeProgressLimit } = agentModule;
  assert.equal(normalizeProgressLimit(undefined), 30);
  assert.equal(normalizeProgressLimit(null), 30);
  assert.equal(normalizeProgressLimit(''), 30);
  assert.equal(normalizeProgressLimit('abc'), 30);
  assert.equal(normalizeProgressLimit(0), 30);
  assert.equal(normalizeProgressLimit(-5), 30);
  assert.equal(normalizeProgressLimit(1.5), 30);
  assert.equal(normalizeProgressLimit('50'), 50);
  assert.equal(normalizeProgressLimit(500), 500);
  assert.equal(normalizeProgressLimit(100000), 500);
});

test('parseProgressTs: 兩種寫入端格式都認得，認不出就回 null 而不是丟一個假時戳', () => {
  const { parseProgressTs } = agentModule;
  // appendProgressText 寫 ts（毫秒數）
  assert.equal(parseProgressTs(JSON.stringify({ ts: 1700000000000, text: 'x' })), 1700000000000);
  // mock worker 寫 at（ISO 字串）
  assert.equal(parseProgressTs(JSON.stringify({ at: '2026-09-17T06:00:00.000Z', message: 'x' })), Date.parse('2026-09-17T06:00:00.000Z'));
  // 認不出來的一律 null：時間軸寧可少畫一個點，也不要畫在錯的位置
  assert.equal(parseProgressTs(JSON.stringify({ at: 'not-a-date' })), null);
  assert.equal(parseProgressTs(JSON.stringify({ text: 'no timestamp' })), null);
  assert.equal(parseProgressTs('"plain string line"'), null);
  assert.equal(parseProgressTs('{ not json'), null);
  assert.equal(parseProgressTs(''), null);
});

test('readProgressEntries / countProgressLines: entries 切上限、count 數整份檔，兩個數字合起來才算得出 dropped', () => {
  const { readProgressEntries, countProgressLines, truncationInfo } = agentModule;
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  const taskId = `trunc-probe-${uniqueSuffix()}`;
  const progressFile = path.join(TASKS_DIR, `${taskId}.progress.jsonl`);
  const total = 7;
  const lines = [];
  for (let i = 0; i < total; i += 1) {
    lines.push(JSON.stringify({ ts: 1700000000000 + i * 1000, text: `step ${i}` }));
  }
  // 中間夾一行空行：count 數的是「非空行」，空行不該把分母灌水。
  fs.writeFileSync(progressFile, `${lines.join('\n')}\n\n`);

  try {
    const entries = readProgressEntries(taskId, 3);
    assert.equal(entries.length, 3, JSON.stringify(entries));
    // 切的是尾巴（最近的 3 筆），不是頭
    assert.deepEqual(entries.map((e) => e.text), ['step 4', 'step 5', 'step 6']);
    assert.equal(entries[0].ts, 1700000000000 + 4000);

    // count 必須看整份檔，否則 dropped 永遠是 0——這正是截斷揭露最容易失效的地方
    assert.equal(countProgressLines(taskId), total);
    const info = truncationInfo(countProgressLines(taskId), entries.length, 'progress_load_cap', 3, 'r');
    assert.equal(info.truncated, true);
    assert.equal(info.dropped, 4, JSON.stringify(info));

    // limit 夠大時就沒有截斷，dropped 要真的是 0 而不是沿用上一次的值
    const all = readProgressEntries(taskId, 30);
    assert.equal(all.length, total);
    assert.equal(truncationInfo(countProgressLines(taskId), all.length, 'progress_load_cap', 30, 'r').dropped, 0);
  } finally {
    fs.rmSync(progressFile, { force: true });
  }

  // 不安全的 id 與不存在的檔都回 null（不是 [] / 0）：讓上層顯示「不可得」而不是「空的」
  assert.equal(readProgressEntries('../etc/passwd', 30), null);
  assert.equal(countProgressLines('../etc/passwd'), null);
  assert.equal(readProgressEntries(`missing-${uniqueSuffix()}`, 30), null);
  assert.equal(countProgressLines(`missing-${uniqueSuffix()}`), null);
});

test('collectInboxEvents: 回未切上限的全量並依 ts 新到舊排序，壞檔降級成具名 unreadable 而不是整趟炸掉', () => {
  const { collectInboxEvents, INBOX_LIST_CAP } = agentModule;
  fs.mkdirSync(INBOX_DIR, { recursive: true });

  const tag = uniqueSuffix();
  const written = [
    { name: `probe-${tag}-old.done.json`, body: JSON.stringify({ task_id: `probe-${tag}-old`, event: 'done', ts: 1700000000000 }) },
    { name: `probe-${tag}-new.done.json`, body: JSON.stringify({ task_id: `probe-${tag}-new`, event: 'done', ts: 1700000009000 }) },
    { name: `probe-${tag}-broken.done.json`, body: '{ not json' },
  ];
  for (const item of written) {
    fs.writeFileSync(path.join(INBOX_DIR, item.name), item.body);
  }

  try {
    const events = collectInboxEvents();
    const mine = events.filter((event) => String(event.file).includes(tag));
    assert.equal(mine.length, 3, JSON.stringify(mine));

    // 壞掉的那筆要被具名列出來，不能靜默消失——收件匣少一筆比報錯更難發現
    const broken = mine.find((event) => event.file === `probe-${tag}-broken.done.json`);
    assert.ok(broken, JSON.stringify(mine));
    assert.equal(broken.event, 'unreadable');
    assert.equal(broken.status, 'blocked');

    // 全量排序：新的在前
    const ordered = mine.map((event) => Number(event.ts) || Date.parse(event.timestamp || '') || 0);
    assert.deepEqual(ordered, [...ordered].sort((a, b) => b - a), JSON.stringify(ordered));

    // collect* 不切上限，切上限是 list* 的事；這裡釘住那條分界
    assert.equal(INBOX_LIST_CAP, 100);
    assert.ok(events.length >= mine.length);
  } finally {
    for (const item of written) {
      fs.rmSync(path.join(INBOX_DIR, item.name), { force: true });
    }
  }
});

test('collectTaskEvents: sinceMs 之前的不進來，回未切上限的全量並依 ts 舊到新排序', () => {
  const { collectTaskEvents, EVENT_LIST_CAP } = agentModule;
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  const tag = uniqueSuffix();
  const base = 1700000000000;
  const rows = [
    { id: `evt-${tag}-a`, title: 'A', status: 'done', updated_at: new Date(base + 2000).toISOString(), summary: 'sa' },
    { id: `evt-${tag}-b`, title: 'B', status: 'running', updated_at: new Date(base + 1000).toISOString(), summary: 'sb' },
    { id: `evt-${tag}-stale`, title: 'S', status: 'done', updated_at: new Date(base - 5000).toISOString(), summary: 'ss' },
  ];
  const files = rows.map((row) => path.join(TASKS_DIR, `${row.id}.json`));
  rows.forEach((row, i) => fs.writeFileSync(files[i], JSON.stringify(row)));

  try {
    const events = collectTaskEvents(base);
    const mine = events.filter((event) => String(event.id).includes(tag));

    // sinceMs 是嚴格大於：base 之前的那筆不該出現
    assert.deepEqual(mine.map((event) => event.id), [`evt-${tag}-b`, `evt-${tag}-a`], JSON.stringify(mine));
    assert.equal(mine[0].ts, base + 1000);
    assert.equal(mine[1].status, 'done');
    assert.equal(mine[1].summary, 'sa');

    // 全量排序：舊到新（list* 才會 slice(-cap) 取尾巴，所以排序方向不能反）
    const ordered = events.map((event) => event.ts);
    assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
    assert.equal(EVENT_LIST_CAP, 50);
  } finally {
    for (const file of files) {
      fs.rmSync(file, { force: true });
    }
  }
});
