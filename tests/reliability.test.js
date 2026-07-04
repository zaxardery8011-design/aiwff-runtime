const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

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

function requestJson(port, method, route, payload) {
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
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
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
    assert.equal(event.summary, 'blocked: timeout');
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
