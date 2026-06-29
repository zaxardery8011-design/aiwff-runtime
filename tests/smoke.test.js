const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForHealth(port, daemon) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`Daemon exited early with code ${daemon.exitCode}`);
    }
    try {
      const health = await requestJson(port, 'GET', '/api/health');
      if (health.ok) {
        return health;
      }
    } catch (_) {
      await sleep(200);
    }
  }
  throw new Error('daemon health check timed out');
}

async function waitForTaskDone(port, taskId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await requestJson(port, 'GET', `/api/tasks/${taskId}`);
    if (response.task.status === 'done') {
      return response.task;
    }
    if (response.task.status === 'failed') {
      throw new Error(`task failed: ${response.task.error || 'unknown error'}`);
    }
    await sleep(500);
  }
  throw new Error(`task ${taskId} timed out`);
}

async function main() {
  const port = await getOpenPort();
  const daemon = spawn('node', ['agent/index.js'], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  daemon.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  daemon.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  try {
    await waitForHealth(port, daemon);
    const created = await requestJson(port, 'POST', '/api/tasks', {
      title: 'Smoke test task',
      instruction: 'Verify the mock worker lifecycle end to end.',
    });
    assert.match(created.id, /^[0-9a-f-]{36}$/i);

    const task = await waitForTaskDone(port, created.id);
    assert.strictEqual(task.status, 'done');

    const artifactPath = path.join(ROOT_DIR, 'data', 'artifacts', `${task.id}.result.json`);
    assert.ok(fs.existsSync(artifactPath), `artifact missing: ${artifactPath}`);
    assert.ok(fs.statSync(artifactPath).size > 0, `artifact empty: ${artifactPath}`);

    console.log(`PASS smoke test completed for task ${task.id}`);
  } catch (error) {
    console.error(logs.join(''));
    throw error;
  } finally {
    daemon.kill();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`FAIL smoke test: ${error.stack || error.message}`);
    process.exit(1);
  });

