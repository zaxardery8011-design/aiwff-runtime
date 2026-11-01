// worker 一啟動就退出（還沒讀題目、什麼都沒寫）時，任務要在 5 秒內變 failed 並寫出退出碼，
// 不能停在 running 等 timeout_sec 到期才被收掉。參考：paseo #8384。
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
const { requestJson } = require(path.join(ROOT_DIR, 'scripts', 'demo.js'));

// 不讀 stdin、不寫產物，一起來就以 7 退出。
const STARTUP_EXIT_CLAUDE = 'process.exit(7);\n';

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

async function startDaemon(env) {
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
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`daemon exited early with code ${daemon.exitCode}: ${stderr}`);
    }
    try {
      if ((await requestJson(port, 'GET', '/api/health')).ok) {
        return { daemon, port };
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

test('real worker: a worker that exits at startup turns the task failed within 5 seconds', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const claudeCmd = writeFakeClaude('startup-exit-claude', STARTUP_EXIT_CLAUDE);
  const runtime = await startDaemon({ CLAUDE_CMD: claudeCmd, MAX_TASK_RETRIES: '0' });

  try {
    const createdAt = Date.now();
    // timeout_sec 給得很長：任務若是靠逾時才收掉，5 秒內一定等不到 failed。
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'startup exit',
      instruction: 'worker exits before reading the prompt',
      timeout_sec: 600,
    }, AUTH_HEADERS);

    let task = null;
    while (Date.now() - createdAt < 5000) {
      ({ task } = await requestJson(runtime.port, 'GET', `/api/tasks/${created.id}`));
      if (task.status !== 'queued' && task.status !== 'running') {
        break;
      }
      await sleep(100);
    }
    const elapsedMs = Date.now() - createdAt;

    assert.equal(task.status, 'failed', `status after ${elapsedMs}ms: ${task.status}`);
    assert.ok(elapsedMs < 5000, `took ${elapsedMs}ms`);
    assert.match(task.error, /exited with code 7/);
    assert.equal(task.blocked_reason, undefined);
    assert.equal(task.retry_count, 0);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});
