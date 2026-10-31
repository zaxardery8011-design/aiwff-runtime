const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RUNTIME_TOKEN = 'test-runtime-token-not-real';
const AUTH_HEADERS = { 'x-aiwff-runtime-token': RUNTIME_TOKEN };
const FAKE_SECRETS = {
  AIWFF_RUNTIME_TOKEN: RUNTIME_TOKEN,
  TG_BOT_TOKEN: 'test-tg-bot-token-not-real',
  AIWFF_OPENAI_API_KEY: 'test-openai-key-not-real',
};
const PLAIN_VAR = 'AIWFF_WORKER_ENV_TEST_PLAIN';
const agentModule = require(path.join(ROOT_DIR, 'agent', 'index.js'));
const { requestJson } = require(path.join(ROOT_DIR, 'scripts', 'demo.js'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function writeFakeCli(name, scriptBody) {
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

// 假 worker 只把收到的環境變數「名稱」寫進暫存檔，值一律不落地。
function envNamesCaptureLines(captureFile) {
  return `
const fs = require('fs');
const path = require('path');
const captureFile = ${JSON.stringify(captureFile)};
fs.mkdirSync(path.dirname(captureFile), { recursive: true });
fs.writeFileSync(captureFile, JSON.stringify(Object.keys(process.env)));
`;
}

function captureEnvClaudeScript(captureFile) {
  return `${envNamesCaptureLines(captureFile)}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const outMatch = input.match(/結果請寫到: (.+)/);
  if (!outMatch) {
    console.error('missing artifact path');
    process.exit(3);
  }
  const outPath = path.resolve(__dirname, '..', '..', outMatch[1].trim().replace(/\\//g, path.sep));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'DONE: captured env names\\\\n');
});
`;
}

// agy worker 的 stdin 是 ignore；exit 0 時 runtime 會拿 stdout 補成 artifact。
function captureEnvAgyScript(captureFile) {
  return `${envNamesCaptureLines(captureFile)}
console.log('DONE: captured env names');
`;
}

async function startDaemon(env = {}) {
  const port = await getOpenPort();
  const daemon = spawn(process.execPath, ['agent/index.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_TG_CHAT_ID: '',
      CLAUDE_BYPASS_APPROVALS: '',
      MOCK_WORKER: '',
      ENABLE_REAL_CLAUDE_WORKER: '',
      AIWFF_WORKER_PROVIDER: '',
      ...FAKE_SECRETS,
      [PLAIN_VAR]: 'plain-value',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(port, daemon);
  return { daemon, port };
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

function assertWorkerEnvNames(names) {
  for (const key of Object.keys(FAKE_SECRETS)) {
    assert.ok(!names.includes(key), `worker env must not include ${key}`);
  }
  assert.ok(names.includes(PLAIN_VAR), `worker env must keep ${PLAIN_VAR}`);
}

test('buildWorkerEnv drops runtime secrets and keeps every other variable', () => {
  const keys = [...Object.keys(FAKE_SECRETS), PLAIN_VAR];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, FAKE_SECRETS, { [PLAIN_VAR]: 'plain-value' });
    const env = agentModule.buildWorkerEnv();
    for (const key of Object.keys(FAKE_SECRETS)) {
      assert.ok(!Object.prototype.hasOwnProperty.call(env, key), `buildWorkerEnv must drop ${key}`);
    }
    assert.equal(env[PLAIN_VAR], 'plain-value');
    assert.equal(env.PATH, process.env.PATH);
    // 回傳的是複本：runtime 自己的 process.env 不能被動到。
    assert.equal(process.env.TG_BOT_TOKEN, FAKE_SECRETS.TG_BOT_TOKEN);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
});

test('Claude task worker does not inherit runtime secrets', async () => {
  resetDataDir();
  const captureFile = path.join(DATA_DIR, 'test-capture', 'claude-env-names.json');
  const claudeCmd = writeFakeCli('env-capture-claude', captureEnvClaudeScript(captureFile));
  const runtime = await startDaemon({ ENABLE_REAL_CLAUDE_WORKER: '1', CLAUDE_CMD: claudeCmd });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'worker env',
      instruction: 'capture env names',
      timeout_sec: 10,
    }, AUTH_HEADERS);
    const task = await waitForTaskStatus(runtime.port, created.id, ['done']);
    assert.equal(task.status, 'done');
    assertWorkerEnvNames(JSON.parse(fs.readFileSync(captureFile, 'utf8')));
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

// agy 直接 spawn、沒走 cmd.exe，Windows 上叫不起 .cmd 假 worker，所以只在非 Windows 驗。
test('agy worker does not inherit runtime secrets', { skip: process.platform === 'win32' }, async () => {
  resetDataDir();
  const captureFile = path.join(DATA_DIR, 'test-capture', 'agy-env-names.json');
  const agyCmd = writeFakeCli('env-capture-agy', captureEnvAgyScript(captureFile));
  const runtime = await startDaemon({ AIWFF_WORKER_PROVIDER: 'agy', AGY_CMD: agyCmd });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'agy worker env',
      instruction: 'capture env names',
      timeout_sec: 10,
    }, AUTH_HEADERS);
    const task = await waitForTaskStatus(runtime.port, created.id, ['done']);
    assert.equal(task.status, 'done');
    assertWorkerEnvNames(JSON.parse(fs.readFileSync(captureFile, 'utf8')));
  } finally {
    await stopDaemon(runtime.daemon);
    resetDataDir();
  }
});
