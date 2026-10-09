// /api/health 點名沒就緒元件：缺目錄時 components 點名元件與原因、ready=false，
// 但 ok 仍是「process 活著」的語意（install.ps1 / smoke test 靠它等啟動），不能跟著翻。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');

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

let port;
let agent;
let server;
let tmpDir;

test.before(async () => {
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.MOCK_WORKER = '1';
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
  agent.initRuntimeToken();
  server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-health-'));
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('目錄缺了 → 點名該元件與原因，ready=false，ok 不變', () => {
  const missing = path.join(tmpDir, 'no-such-dir');
  const snapshot = agent.getHealthSnapshot([
    { name: 'tasks_dir', dir: tmpDir, mode: fs.constants.W_OK },
    { name: 'inbox_dir', dir: missing, mode: fs.constants.W_OK },
  ]);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.ready, false);
  assert.deepEqual(snapshot.components[0], { name: 'tasks_dir', ok: true, reason: null });
  const bad = snapshot.components[1];
  assert.equal(bad.name, 'inbox_dir');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /不可寫/);
  assert.match(bad.reason, /ENOENT/);
});

test('目錄補回 → 全部 ok，ready=true', () => {
  const restored = path.join(tmpDir, 'restored');
  fs.mkdirSync(restored);
  const snapshot = agent.getHealthSnapshot([{ name: 'inbox_dir', dir: restored, mode: fs.constants.W_OK }]);
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.components, [{ name: 'inbox_dir', ok: true, reason: null }]);
});

test('GET /api/health 保留原欄位，並帶 ready 與 components', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.pid, 'number');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(body.ready, true, JSON.stringify(body.components));
  assert.deepEqual(
    body.components.map((component) => component.name),
    ['tasks_dir', 'artifacts_dir', 'inbox_dir', 'memory_dir'],
  );
});
