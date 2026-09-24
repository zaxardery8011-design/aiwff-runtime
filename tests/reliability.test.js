const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RUNTIME_TOKEN = 'test-runtime-token';
const AUTH_HEADERS = { 'x-aiwff-runtime-token': RUNTIME_TOKEN };
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

function requestJson(port, method, route, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (res.statusCode >= 400) {
              const error = new Error(parsed.error || `HTTP ${res.statusCode}`);
              error.statusCode = res.statusCode;
              error.body = parsed;
              reject(error);
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

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
      AIWFF_WORKER_PROVIDER: '',
      AIWFF_RUNTIME_TOKEN: RUNTIME_TOKEN,
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

function captureSpawnClaudeScript(captureFile) {
  return `
const fs = require('fs');
const path = require('path');
const captureFile = ${JSON.stringify(captureFile)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const outMatch = input.match(/結果請寫到: (.+)/);
  if (!outMatch) {
    console.error('missing artifact path');
    process.exit(3);
  }
  fs.mkdirSync(path.dirname(captureFile), { recursive: true });
  fs.writeFileSync(captureFile, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }, null, 2));
  const outPath = path.resolve(__dirname, '..', '..', outMatch[1].trim().replace(/\\//g, path.sep));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'DONE: captured spawn boundary\\\\n');
});
`;
}

test('POST /api/tasks requires runtime token and accepts the correct token', async () => {
  resetDataDir();
  const runtime = await startDaemon({ AIWFF_RUNTIME_TOKEN: RUNTIME_TOKEN, MOCK_WORKER: '1' });

  try {
    await assert.rejects(
      () =>
        requestJson(runtime.port, 'POST', '/api/tasks', {
          title: 'missing token',
          instruction: 'should be rejected',
        }),
      (error) => error.statusCode === 401 && /token/i.test(error.message),
    );

    const created = await requestJson(
      runtime.port,
      'POST',
      '/api/tasks',
      {
        title: 'authorized task',
        instruction: 'should be accepted',
      },
      AUTH_HEADERS,
    );
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('POST /api/tasks rejects writes when runtime token is not configured', async () => {
  resetDataDir();
  const runtime = await startDaemon({ AIWFF_RUNTIME_TOKEN: '', MOCK_WORKER: '1' });

  try {
    await assert.rejects(
      () =>
        requestJson(
          runtime.port,
          'POST',
          '/api/tasks',
          {
            title: 'missing configured token',
            instruction: 'should be rejected',
          },
          AUTH_HEADERS,
        ),
      (error) => error.statusCode === 401 && /AIWFF_RUNTIME_TOKEN/.test(error.message),
    );
    assert.match(runtime.logs.stderr, /AIWFF_RUNTIME_TOKEN is not set/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('POST /api/tasks rejects cross-origin browser writes', async () => {
  resetDataDir();
  const runtime = await startDaemon({ AIWFF_RUNTIME_TOKEN: RUNTIME_TOKEN, MOCK_WORKER: '1' });

  try {
    await assert.rejects(
      () =>
        requestJson(
          runtime.port,
          'POST',
          '/api/tasks',
          {
            title: 'csrf',
            instruction: 'should be rejected',
          },
          { ...AUTH_HEADERS, origin: 'https://example.invalid' },
        ),
      (error) => error.statusCode === 403 && /Cross-origin/.test(error.message),
    );
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('real worker spawn is scoped to a per-task workspace and logs args/cwd', async () => {
  resetDataDir();
  const captureFile = path.join(DATA_DIR, 'spawn-capture.json');
  const claudeCmd = writeFakeClaude('spawn-capture-claude', captureSpawnClaudeScript(captureFile));
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    ENABLE_REAL_CLAUDE_WORKER: '1',
    CLAUDE_CMD: claudeCmd,
    CLAUDE_BYPASS_APPROVALS: '1',
    AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS: '',
  });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'spawn boundary',
      instruction: 'capture args and cwd',
      timeout_sec: 10,
    }, AUTH_HEADERS);
    const task = await waitForTaskStatus(runtime.port, created.id, ['done']);
    assert.equal(task.status, 'done');

    const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.equal(capture.cwd, path.join(DATA_DIR, 'workspaces', created.id));
    assert.notEqual(capture.cwd, ROOT_DIR);
    assert.deepEqual(capture.argv, [
      '--print',
      '--add-dir',
      path.join(DATA_DIR, 'artifacts'),
      '--disallowedTools',
      'Bash,PowerShell',
    ]);
    assert.match(runtime.logs.stderr, /CLAUDE_BYPASS_APPROVALS ignored/);

    const progress = await requestJson(runtime.port, 'GET', `/api/tasks/${created.id}/progress`);
    assert.ok(
      progress.lines.some((line) => line.includes('"--add-dir"') && line.includes(' cwd=')),
      `expected spawn args/cwd progress line, got: ${JSON.stringify(progress.lines)}`,
    );
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('dangerous Claude bypass requires explicit double opt-in and emits a warning', async () => {
  resetDataDir();
  const captureFile = path.join(DATA_DIR, 'spawn-dangerous-capture.json');
  const claudeCmd = writeFakeClaude('spawn-dangerous-claude', captureSpawnClaudeScript(captureFile));
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    ENABLE_REAL_CLAUDE_WORKER: '1',
    CLAUDE_CMD: claudeCmd,
    CLAUDE_BYPASS_APPROVALS: '1',
    AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS: '1',
  });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'dangerous spawn boundary',
      instruction: 'capture dangerous args',
      timeout_sec: 10,
    }, AUTH_HEADERS);
    await waitForTaskStatus(runtime.port, created.id, ['done']);

    const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.deepEqual(capture.argv, [
      '--dangerously-skip-permissions',
      '--print',
      '--add-dir',
      path.join(DATA_DIR, 'artifacts'),
      '--disallowedTools',
      'Bash,PowerShell',
    ]);
    assert.equal(capture.cwd, path.join(DATA_DIR, 'workspaces', created.id));
    assert.match(runtime.logs.stderr, /--dangerously-skip-permissions/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

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
    }, AUTH_HEADERS);
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
    }, AUTH_HEADERS);
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
    }, AUTH_HEADERS);
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
    }, AUTH_HEADERS);
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
    }, AUTH_HEADERS);
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

// --- (4) OpenAI 相容端點插槽 ---
function startFakeOpenAI() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ url: req.url, authorization: req.headers.authorization, body });
      const userText = (body.messages || []).map((m) => m.content).join('\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `分類：${/退款/.test(userText) ? 'refund' : 'other'}` }, finish_reason: 'stop' }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

test('openai_compatible provider: task is answered by the configured endpoint and written as artifact', async () => {
  resetDataDir();
  const fake = await startFakeOpenAI();
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    AIWFF_WORKER_PROVIDER: 'openai_compatible',
    AIWFF_OPENAI_BASE_URL: `http://127.0.0.1:${fake.port}/v1/`,
    AIWFF_OPENAI_MODEL: 'qwen3-32b-test',
    AIWFF_OPENAI_API_KEY: 'sk-test',
  });

  try {
    const settings = await requestJson(runtime.port, 'GET', '/api/settings');
    assert.equal(settings.worker_mode, 'openai_compatible');
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: '客服分類',
      instruction: '把這句分類：我要退款',
    }, AUTH_HEADERS);
    const task = await waitForTaskStatus(runtime.port, created.id, ['done', 'failed'], 10000);
    assert.equal(task.status, 'done', `task error: ${task.error}`);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].url, '/v1/chat/completions');
    assert.equal(fake.requests[0].authorization, 'Bearer sk-test');
    assert.equal(fake.requests[0].body.model, 'qwen3-32b-test');
    assert.match(fake.requests[0].body.messages[1].content, /我要退款/);
    const artifact = fs.readFileSync(path.join(ROOT_DIR, task.artifact_path), 'utf8');
    assert.equal(artifact, '分類：refund\n');
  } finally {
    await stopDaemon(runtime.daemon);
    fake.server.close();
  }
});

test('openai_compatible provider: missing base_url/model fails clearly without calling anything', async () => {
  resetDataDir();
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    AIWFF_WORKER_PROVIDER: 'openai_compatible',
    AIWFF_OPENAI_BASE_URL: '',
    AIWFF_OPENAI_MODEL: '',
    MAX_TASK_RETRIES: '0',
  });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'no config',
      instruction: 'should fail',
    }, AUTH_HEADERS);
    const task = await waitForTaskStatus(runtime.port, created.id, ['failed'], 10000);
    assert.match(task.error, /AIWFF_OPENAI_BASE_URL and AIWFF_OPENAI_MODEL are required/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});
