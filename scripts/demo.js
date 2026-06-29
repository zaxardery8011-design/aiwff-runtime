const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PREFERRED_PORT = Number(process.env.PORT || 3100);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function choosePort() {
  if (await probePort(PREFERRED_PORT)) {
    return PREFERRED_PORT;
  }
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
  throw new Error('Daemon did not become ready within 5 seconds');
}

async function waitForTaskDone(port, taskId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await requestJson(port, 'GET', `/api/tasks/${taskId}`);
    if (response.task.status === 'done') {
      return response.task;
    }
    if (response.task.status === 'failed') {
      throw new Error(`Task failed: ${response.task.error || 'unknown error'}`);
    }
    await sleep(500);
  }
  throw new Error(`Task ${taskId} did not finish within 30 seconds`);
}

async function main() {
  const port = await choosePort();
  const daemon = spawn('node', ['agent/index.js'], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  daemon.stdout.on('data', (chunk) => process.stdout.write(chunk));
  daemon.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForHealth(port, daemon);
    const created = await requestJson(port, 'POST', '/api/tasks', {
      title: 'Demo task',
      instruction: 'Run the mock task lifecycle from scripts/demo.js',
    });
    const task = await waitForTaskDone(port, created.id);
    const artifactPath = path.join(ROOT_DIR, 'data', 'artifacts', `${task.id}.result.json`);

    console.log(`Task ID: ${task.id}`);
    console.log(`Artifact: ${artifactPath}`);
    console.log(`Status: ${task.status}`);
    console.log('✓ Demo completed — task lifecycle verified');
  } finally {
    daemon.kill();
  }
}

main().catch((error) => {
  console.error(`FAIL demo: ${error.message}`);
  process.exit(1);
});

