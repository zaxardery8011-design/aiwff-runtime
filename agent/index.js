const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const PORT = Number(process.env.PORT || 3100);

function ensureDirectories() {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function taskPath(taskId) {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readTask(taskId) {
  const filePath = taskPath(taskId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJsonFile(filePath);
}

function listTasks() {
  ensureDirectories();
  return fs
    .readdirSync(TASKS_DIR)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.progress.json'))
    .map((name) => {
      try {
        return readJsonFile(path.join(TASKS_DIR, name));
      } catch (error) {
        return {
          id: name.replace(/\.json$/, ''),
          status: 'failed',
          title: 'Unreadable task file',
          instruction: error.message,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
      }
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHome() {
  const rows = listTasks()
    .map(
      (task) => `<tr>
  <td><code>${htmlEscape(task.id)}</code></td>
  <td>${htmlEscape(task.title)}</td>
  <td><span class="status ${htmlEscape(task.status)}">${htmlEscape(task.status)}</span></td>
  <td>${htmlEscape(task.updated_at)}</td>
</tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>AIWFF Runtime</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1e293b; }
    main { max-width: 1040px; margin: 0 auto; padding: 32px 20px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h1 { font-size: 28px; margin: 0; }
    p { margin: 6px 0 0; color: #475569; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9e0ea; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #e5eaf0; text-align: left; vertical-align: top; }
    th { font-size: 12px; letter-spacing: 0; text-transform: uppercase; color: #526173; background: #eef2f6; }
    code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; }
    .empty { padding: 28px; background: #fff; border: 1px solid #d9e0ea; }
    .status { display: inline-block; min-width: 64px; padding: 2px 8px; border-radius: 4px; font-size: 12px; text-align: center; background: #e2e8f0; color: #1e293b; }
    .running { background: #dbeafe; color: #1d4ed8; }
    .done { background: #dcfce7; color: #166534; }
    .failed { background: #fee2e2; color: #991b1b; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      p { color: #a8b3c5; }
      table, .empty { background: #172033; border-color: #344055; }
      th, td { border-color: #2d374d; }
      th { background: #202b3d; color: #a8b3c5; }
      .status { background: #334155; color: #e2e8f0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>AIWFF Runtime</h1>
        <p>Local task queue and mock worker lifecycle. Refreshes every 5 seconds.</p>
      </div>
      <p>PID ${process.pid}</p>
    </header>
    ${
      rows
        ? `<table>
      <thead><tr><th>Task ID</th><th>Title</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
        : '<div class="empty">No tasks yet. POST to <code>/api/tasks</code> to start a mock worker.</div>'
    }
  </main>
</body>
</html>`;
}

function spawnMockWorker(taskId) {
  const child = spawn('node', ['examples/mock-worker/worker.js', taskId], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
  });

  child.on('error', (error) => {
    const task = readTask(taskId);
    if (!task) {
      return;
    }
    task.status = 'failed';
    task.error = error.message;
    task.updated_at = nowIso();
    writeJsonFile(taskPath(taskId), task);
  });

  child.unref();
}

async function createTask(req, res) {
  let payload;
  try {
    const rawBody = await readBody(req);
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `Invalid JSON: ${error.message}` });
    return;
  }

  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Untitled task';
  const instruction =
    typeof payload.instruction === 'string' && payload.instruction.trim()
      ? payload.instruction.trim()
      : 'Run the mock worker lifecycle.';
  const timestamp = nowIso();
  const task = {
    id: crypto.randomUUID(),
    title,
    instruction,
    status: 'pending',
    created_at: timestamp,
    updated_at: timestamp,
  };

  writeJsonFile(taskPath(task.id), task);
  spawnMockWorker(task.id);
  sendJson(res, 201, task);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, 200, renderHome());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, pid: process.pid, uptime: process.uptime() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    sendJson(res, 200, { ok: true, tasks: listTasks() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    await createTask(req, res);
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && taskMatch) {
    const task = readTask(taskMatch[1]);
    if (!task) {
      sendJson(res, 404, { ok: false, error: 'Task not found' });
      return;
    }
    sendJson(res, 200, { ok: true, task });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}

function main() {
  ensureDirectories();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`AIWFF Runtime listening on http://127.0.0.1:${PORT}`);
  });
}

if (require.main === module) {
  main();
}

