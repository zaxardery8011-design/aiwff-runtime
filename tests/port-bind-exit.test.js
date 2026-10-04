const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function startRuntime(port) {
  return new Promise((resolve, reject) => {
    const runtime = spawn(process.execPath, ['agent/index.js'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        TG_BOT_TOKEN: '',
        ADMIN_TG_CHAT_ID: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    runtime.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      runtime.kill();
      reject(new Error(`runtime did not exit after listen failure; stderr: ${stderr}`));
    }, 5000);
    runtime.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    runtime.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}

test('runtime exits 1 and reports EADDRINUSE when its port is occupied', async () => {
  const holder = net.createServer();
  await listen(holder);
  const { port } = holder.address();

  try {
    const result = await startRuntime(port);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /EADDRINUSE/);
    // 光說 EADDRINUSE 新手不知道下一步；兩種 shell 的換 port 指令都要印出來。
    assert.match(result.stderr, /PowerShell: \$env:PORT=3200; npm run web/);
    assert.match(result.stderr, /bash \/ macOS \/ Linux: PORT=3200 npm run web/);
  } finally {
    await close(holder);
  }
});

test('second runtime that fails to bind does not sweep the first instance\'s running tasks', async () => {
  const fs = require('node:fs');
  const tasksDir = path.join(ROOT_DIR, 'data', 'tasks');
  const taskId = '00000000-0000-4000-8000-0000000000b1';
  const taskFile = path.join(tasksDir, `${taskId}.json`);
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    taskFile,
    JSON.stringify({ id: taskId, title: 'live', instruction: 'x', status: 'running', created_at: now, updated_at: now }),
  );
  const holder = net.createServer();
  await listen(holder);
  const { port } = holder.address();

  try {
    const result = await startRuntime(port);
    assert.equal(result.code, 1);
    // 綁不上 port 代表另一個實例還活著；它正在跑的任務不能被標成中斷。
    assert.equal(JSON.parse(fs.readFileSync(taskFile, 'utf8')).status, 'running');
    assert.doesNotMatch(result.stderr, /startup-sweep/);
  } finally {
    await close(holder);
    fs.rmSync(taskFile, { force: true });
    fs.rmSync(path.join(ROOT_DIR, 'data', 'inbox', `${taskId}.blocked.json`), { force: true });
  }
});
