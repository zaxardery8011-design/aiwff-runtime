// worker 失敗時判斷是不是環境問題：登入過期、找不到 worker 程式、權限不足、網路不通，
// 以及「不是環境問題」。環境問題停成 blocked（blocked_reason=environment）並給看得懂的原因，
// 不燒重試額度（網路例外：先照常重試，用完才停）；不是環境問題的照原本流程標 failed。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RUNTIME_TOKEN = 'test-runtime-token';
const AUTH_HEADERS = { 'x-aiwff-runtime-token': RUNTIME_TOKEN };
const agentModule = require(path.join(ROOT_DIR, 'agent', 'index.js'));
const { requestJson } = require(path.join(ROOT_DIR, 'scripts', 'demo.js'));
const { classifyEnvFailure } = agentModule;

const AUTH_OUTPUT =
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}';
const PERMISSION_OUTPUT = "Error: EACCES: permission denied, open '/srv/worker/output.md'";
const NETWORK_OUTPUT = 'API Error: Connection error. (cause: getaddrinfo ENOTFOUND api.example.invalid)';
const TASK_BUG_OUTPUT = "TypeError: Cannot read properties of undefined (reading 'rows')";

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

async function startDaemon(env = {}) {
  const port = await getOpenPort();
  const daemon = spawn(process.execPath, [path.join('agent', 'index.js')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      TG_BOT_TOKEN: '',
      ADMIN_TG_CHAT_ID: '',
      CLAUDE_BYPASS_APPROVALS: '',
      MOCK_WORKER: '',
      ENABLE_REAL_CLAUDE_WORKER: '1',
      AIWFF_WORKER_PROVIDER: '',
      AIWFF_RUNTIME_TOKEN: RUNTIME_TOKEN,
      RETRY_BACKOFF_MS: '50',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { stdout: '', stderr: '' };
  daemon.stdout.on('data', (chunk) => { logs.stdout += chunk.toString(); });
  daemon.stderr.on('data', (chunk) => { logs.stderr += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`daemon exited early with code ${daemon.exitCode}: ${logs.stderr}`);
    }
    try {
      if ((await requestJson(port, 'GET', '/api/health')).ok) {
        return { daemon, logs, port };
      }
    } catch (_) {
      await sleep(100);
    }
  }
  daemon.kill();
  throw new Error('daemon health check timed out');
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

async function waitForTaskStatus(port, taskId, statuses, timeoutMs = 15000) {
  const wanted = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await requestJson(port, 'GET', `/api/tasks/${taskId}`);
    if (wanted.has(task.status)) {
      return task;
    }
    await sleep(150);
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

// 一支假 worker 依任務指令裡的 MODE=... 決定怎麼失敗，每跑一次在 runs.log 記一行 mode，
// 測試才數得出「有沒有被重試」。auth 模式在 stateDir 出現 logged-in 檔後改成正常完成（模擬重新登入）。
function modalClaudeScript(stateDir) {
  return `
const fs = require('fs');
const path = require('path');
const stateDir = ${JSON.stringify(stateDir)};
const OUT = ${JSON.stringify({ auth: AUTH_OUTPUT, permission: PERMISSION_OUTPUT, network: NETWORK_OUTPUT, bug: TASK_BUG_OUTPUT })};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.mkdirSync(stateDir, { recursive: true });
  const mode = (input.match(/MODE=([a-z]+)/) || [])[1] || 'none';
  fs.appendFileSync(path.join(stateDir, 'runs.log'), mode + '\\n');
  if (mode === 'auth' && fs.existsSync(path.join(stateDir, 'logged-in'))) {
    fs.writeFileSync(input.match(/結果請寫到: (.+)/)[1].trim(), 'DONE: ran after login\\n');
    process.exit(0);
  }
  if (mode === 'auth') { console.log(OUT.auth); process.exit(1); }
  console.error(OUT[mode] || 'unknown mode');
  process.exit(1);
});
`;
}

function runsOf(stateDir, mode) {
  const file = path.join(stateDir, 'runs.log');
  if (!fs.existsSync(file)) {
    return 0;
  }
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line === mode).length;
}

test('classify: login expired / bad key is auth and not worth retrying', () => {
  for (const output of [AUTH_OUTPUT, 'Invalid API key · Please run /login', 'Error: not logged in']) {
    const result = classifyEnvFailure(output);
    assert.equal(result && result.cause, 'auth', output);
    assert.equal(result.retryable, false);
    assert.match(result.hint, /登入/);
  }
});

test('classify: worker CLI that cannot be found is missing_tool, whatever the OS language', () => {
  const cases = [
    { output: "'claude' is not recognized as an internal or external command,\r\noperable program or batch file." },
    { output: "'claude' 不是內部或外部命令、可執行的程式或批次檔。" },
    { output: 'sh: 1: claude: command not found' },
    // 中文版 Windows 從管道讀到的是亂碼，只剩「單引號包住的指令名」這個形狀可認。
    { output: "'my-claude' ��O��\r\n", command: 'my-claude' },
    { output: '', spawnError: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) },
  ];
  for (const { output, command, spawnError } of cases) {
    const result = classifyEnvFailure(output, { command, spawnError });
    assert.equal(result && result.cause, 'missing_tool', output || spawnError.message);
    assert.equal(result.retryable, false);
    assert.match(result.hint, /PATH|CLAUDE_CMD/);
  }
  // 指令名的形狀只認這支 worker 自己的名字，別的單引號開頭的行不算。
  assert.equal(classifyEnvFailure("'other-thing' failed", { command: 'my-claude' }), null);
});

test('classify: OS-level permission refusal is permission', () => {
  for (const [output, spawnError] of [
    [PERMISSION_OUTPUT, null],
    ['Access is denied.', null],
    ['', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })],
  ]) {
    const result = classifyEnvFailure(output, { spawnError });
    assert.equal(result && result.cause, 'permission', output || 'EPERM');
    assert.equal(result.retryable, false);
    assert.match(result.hint, /權限/);
  }
});

test('classify: unreachable service is network, and network is the one cause worth retrying', () => {
  for (const output of [NETWORK_OUTPUT, 'Error: connect ECONNREFUSED 127.0.0.1:443', 'TypeError: fetch failed']) {
    const result = classifyEnvFailure(output);
    assert.equal(result && result.cause, 'network', output);
    assert.equal(result.retryable, true);
    assert.match(result.hint, /網路/);
  }
});

test('classify: an ordinary task failure is not an environment problem', () => {
  for (const output of [TASK_BUG_OUTPUT, 'Claude exited with code 3: no stderr or stdout output', '', 'task asked about 401 status pages']) {
    assert.equal(classifyEnvFailure(output), null, output);
  }
});

test('inbox summary names the environment problem in words, not just a code', () => {
  const summary = agentModule.taskEventSummary({
    status: 'blocked',
    blocked_reason: 'environment',
    env_cause: 'auth',
    env_hint: '登入過期或金鑰無效',
  });
  assert.equal(summary, '卡住（環境問題）：登入過期或金鑰無效');
  assert.equal(agentModule.taskEventSummary({ status: 'blocked', blocked_reason: 'timeout' }), '卡住：timeout');
});

test('real worker: auth / permission / network failures stop as blocked environment, a task bug still fails', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const stateDir = path.join(DATA_DIR, 'modal-state');
  const claudeCmd = writeFakeClaude('modal-claude', modalClaudeScript(stateDir));
  const runtime = await startDaemon({ CLAUDE_CMD: claudeCmd, MAX_TASK_RETRIES: '1' });

  try {
    const create = (mode) =>
      requestJson(runtime.port, 'POST', '/api/tasks', { title: mode, instruction: `MODE=${mode}`, timeout_sec: 20 }, AUTH_HEADERS);
    const auth = await create('auth');
    const permission = await create('permission');
    const network = await create('network');
    const bug = await create('bug');

    const authTask = await waitForTaskStatus(runtime.port, auth.id, ['blocked', 'failed']);
    assert.equal(authTask.status, 'blocked');
    assert.equal(authTask.blocked_reason, 'environment');
    assert.equal(authTask.env_cause, 'auth');
    assert.match(authTask.env_hint, /登入/);
    assert.match(authTask.last_error, /Failed to authenticate/);
    assert.equal(authTask.retry_count, 0);
    assert.equal(authTask.error, undefined);
    const inbox = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'inbox', `${auth.id}.blocked.json`), 'utf8'));
    assert.match(inbox.summary, /^卡住（環境問題）：/);

    const permissionTask = await waitForTaskStatus(runtime.port, permission.id, ['blocked', 'failed']);
    assert.equal(permissionTask.status, 'blocked');
    assert.equal(permissionTask.env_cause, 'permission');
    assert.equal(permissionTask.retry_count, 0);

    const networkTask = await waitForTaskStatus(runtime.port, network.id, ['blocked', 'failed']);
    assert.equal(networkTask.status, 'blocked');
    assert.equal(networkTask.env_cause, 'network');
    assert.equal(networkTask.retry_count, 1, 'network gets the normal retry before it stops');

    const bugTask = await waitForTaskStatus(runtime.port, bug.id, ['blocked', 'failed']);
    assert.equal(bugTask.status, 'failed');
    assert.equal(bugTask.env_cause, undefined);
    assert.equal(bugTask.blocked_reason, undefined);
    assert.match(bugTask.error, /TypeError/);
    assert.equal(bugTask.retry_count, 1);

    // 重試次數：auth、permission 各只跑 1 次（沒燒額度），network 與一般錯誤都跑滿 2 次。
    assert.equal(runsOf(stateDir, 'auth'), 1);
    assert.equal(runsOf(stateDir, 'permission'), 1);
    assert.equal(runsOf(stateDir, 'network'), 2);
    assert.equal(runsOf(stateDir, 'bug'), 2);

    // 修好機器（重新登入）後續跑：環境欄位清掉、任務完成。
    fs.writeFileSync(path.join(stateDir, 'logged-in'), 'yes');
    await requestJson(runtime.port, 'POST', `/api/tasks/${auth.id}/resume`, {}, AUTH_HEADERS);
    const resumed = await waitForTaskStatus(runtime.port, auth.id, ['done', 'blocked', 'failed']);
    assert.equal(resumed.status, 'done');
    assert.equal(resumed.env_cause, undefined);
    assert.equal(resumed.env_hint, undefined);
    assert.match(resumed.last_error, /^resumed after blocked: environment/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('real worker: a worker CLI that is not installed stops as blocked missing_tool without retries', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const runtime = await startDaemon({ CLAUDE_CMD: 'aiwff-no-such-worker-cli', MAX_TASK_RETRIES: '2' });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'missing cli',
      instruction: 'worker binary is not installed',
      timeout_sec: 20,
    }, AUTH_HEADERS);
    const task = await waitForTaskStatus(runtime.port, created.id, ['blocked', 'failed']);
    assert.equal(task.status, 'blocked');
    assert.equal(task.blocked_reason, 'environment');
    assert.equal(task.env_cause, 'missing_tool');
    assert.equal(task.retry_count, 0);
    const progress = fs.readFileSync(path.join(DATA_DIR, 'tasks', `${created.id}.progress.jsonl`), 'utf8');
    assert.match(progress, /Environment problem \(missing_tool\)/);
    assert.doesNotMatch(progress, /retrying/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

// ---- 審查回補（F3/F4）----

test('classify: task text in the output is not an environment problem; the first error line decides (F4)', () => {
  const crashes = [
    "Error: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\nNote: the deploy script fails with 'permission denied'",
    'TypeError: x is not a function\nThe page says: please log in to continue',
    'RangeError: Maximum call stack size exceeded\n    at f (worker.js:1:1)\nTypeError: fetch failed',
    "Error: Unexpected end of JSON input ... the deploy script fails with 'permission denied'",
  ];
  for (const output of crashes) {
    assert.equal(classifyEnvFailure(output), null, output);
    assert.equal(classifyEnvFailure({ stderr: '', stdout: output }), null, output);
  }
  // 模型回答裡提到登入、權限的句子（不在行首的錯誤形狀）不算。
  assert.equal(classifyEnvFailure({ stderr: '', stdout: 'Step 2: if the user is not logged in, show the login page.\nPermission denied pages return 403.' }), null);
  // worker 自己的崩潰在 stderr，stdout 裡的任務內容不能蓋過它。
  assert.equal(classifyEnvFailure({ stderr: "TypeError: Cannot read properties of undefined (reading 'x')", stdout: 'Invalid API key · Please run /login' }), null);
  // CLI 自己的錯誤訊息在 stdout 最後幾行時照樣認得（Claude --print 把 API 錯誤印在 stdout）。
  assert.equal(classifyEnvFailure({ stderr: '', stdout: `some earlier answer text\n${AUTH_OUTPUT}` }).cause, 'auth');
  // stdout 只看最後幾行：很前面出現的錯誤形狀不算。
  const longAnswer = ['Error: EACCES: permission denied, open /quoted/in/answer', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
  assert.equal(classifyEnvFailure({ stderr: '', stdout: longAnswer }), null);
  // 英文版 cmd 找不到路徑也算找不到 worker。
  assert.equal(classifyEnvFailure('The system cannot find the path specified.').cause, 'missing_tool');
});

test('worker command lookup: full paths are checked on disk, bare names on PATH (F3)', () => {
  const { workerCommandExists } = agentModule;
  assert.equal(workerCommandExists(process.execPath), true);
  assert.equal(workerCommandExists(`"${process.execPath}"`), true);
  assert.equal(workerCommandExists(path.join(DATA_DIR, 'aiwff no such dir', 'claude.cmd')), false);
  assert.equal(workerCommandExists(path.join(DATA_DIR, 'aiwff-no-such-dir', 'claude.cmd')), false);
  assert.equal(workerCommandExists('aiwff-no-such-worker-cli'), false);
  assert.equal(workerCommandExists(''), false);
  // 測試本身就是用 PATH 上的 node 跑起來的：裸指令名要找得到（Windows 靠 PATHEXT 補 .exe）。
  assert.equal(workerCommandExists('node'), true);
});

test('real worker: CLAUDE_CMD set to a full path that does not exist stops as blocked missing_tool, with or without spaces (F3)', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const missing = [
    path.join(DATA_DIR, 'aiwff no such dir', 'claude.cmd'),
    path.join(DATA_DIR, 'aiwff-no-such-dir', 'claude.cmd'),
  ];
  for (const claudeCmd of missing) {
    const runtime = await startDaemon({ CLAUDE_CMD: claudeCmd, MAX_TASK_RETRIES: '2' });
    try {
      const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
        title: 'bad full path',
        instruction: 'worker path is wrong',
        timeout_sec: 20,
      }, AUTH_HEADERS);
      const task = await waitForTaskStatus(runtime.port, created.id, ['blocked', 'failed']);
      assert.equal(task.status, 'blocked', claudeCmd);
      assert.equal(task.env_cause, 'missing_tool', claudeCmd);
      assert.equal(task.retry_count, 0, claudeCmd);
      assert.ok(task.last_error.includes(claudeCmd), task.last_error);
    } finally {
      await stopDaemon(runtime.daemon);
    }
  }
});
