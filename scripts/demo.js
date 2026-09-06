const fs = require('fs');
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
        let settled = false;
        // 回應在 body 中途被砍時（node v22 實測）res 依序發 'aborted' → 'error' ECONNRESET → 'close'，
        // 從頭到尾不發 'end'，req 的 'error' 也不觸發：只掛 'end' 的寫法會讓這個 Promise 永遠不 settle，
        // 呼叫端無聲卡死到 deadline 都跑不完。中途中斷一律 signal 成具名 abort，且空 body 不得
        // 折成 `{}` 當成功回應——那是把「連線收在半路」報成 clean EOF。
        const fail = (reason) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(new Error(`${method} ${route}: ${reason}`));
        };
        res.on('aborted', () => {
          fail(`response stream aborted after ${raw.length} bytes — the body was never completed`);
        });
        res.on('error', (error) => {
          fail(`response stream failed after ${raw.length} bytes — ${error.code || error.message}`);
        });
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          if (!raw) {
            reject(new Error(`${method} ${route}: HTTP ${res.statusCode} closed with an empty body — no JSON to read`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
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

// 「任務回報 done」不等於「檔案真的落地」：把 demo 宣告的 artifact 讀回來實檢，
// 缺檔／空檔／壞 JSON／內容對不上任務都必須讓 demo 以非 0 收場，不得只憑 API 回 done 判成功。
function readBackArtifact(artifactPath, taskId) {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`task reported done but no artifact was written at ${artifactPath}`);
  }
  const buffer = fs.readFileSync(artifactPath);
  if (buffer.length === 0) {
    throw new Error(`artifact was written but is empty (0 bytes) at ${artifactPath}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`artifact is not valid JSON at ${artifactPath}: ${error.message}`);
  }
  if (artifact.task_id && artifact.task_id !== taskId) {
    throw new Error(`artifact task_id mismatch at ${artifactPath}: expected ${taskId}, found ${artifact.task_id}`);
  }
  if (!artifact.completed_at) {
    throw new Error(`artifact completed_at is missing at ${artifactPath}`);
  }
  return { bytes: buffer.length, completed_at: artifact.completed_at };
}

async function main() {
  const port = await choosePort();
  const daemon = spawn('node', ['agent/index.js'], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port), MOCK_WORKER: '1' },
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
    const readback = readBackArtifact(artifactPath, task.id);

    console.log(`Task ID: ${task.id}`);
    console.log(`Artifact: ${artifactPath}`);
    console.log(`Artifact readback: bytes=${readback.bytes} completed_at=${readback.completed_at}`);
    console.log(`Status: ${task.status}`);
    console.log('✓ Demo completed — task lifecycle verified');
  } finally {
    daemon.kill();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`FAIL demo: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { readBackArtifact, requestJson };
