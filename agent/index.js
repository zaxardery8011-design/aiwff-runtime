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

function progressPath(taskId) {
  return path.join(TASKS_DIR, `${taskId}.progress.jsonl`);
}

function isSafeTaskId(taskId) {
  return /^[A-Za-z0-9._-]+$/.test(taskId);
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

function taskTimeMs(task) {
  const value = task.updatedAt || task.updated_at || task.startedAt || task.started_at || task.createdAt || task.created_at;
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function taskSummary(task) {
  if (task.result && typeof task.result.summary === 'string') {
    return task.result.summary;
  }
  if (typeof task.result_summary === 'string') {
    return task.result_summary;
  }
  if (typeof task.summary === 'string') {
    return task.summary;
  }
  const artifactRef = task.artifact_path || task.artifactPath;
  if (typeof artifactRef !== 'string' || !artifactRef) {
    return '';
  }

  const artifactFile = path.resolve(ROOT_DIR, artifactRef);
  const artifactRoot = path.resolve(ARTIFACTS_DIR);
  if (artifactFile !== artifactRoot && !artifactFile.startsWith(`${artifactRoot}${path.sep}`)) {
    return '';
  }

  try {
    const artifact = readJsonFile(artifactFile);
    return typeof artifact.summary === 'string' ? artifact.summary : '';
  } catch (_) {
    return '';
  }
}

function parseProgressLine(line) {
  try {
    const value = JSON.parse(line);
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object') {
      if (value.message != null) {
        return String(value.message);
      }
      if (value.text != null) {
        return String(value.text);
      }
      if (value.raw != null) {
        return String(value.raw);
      }
      return JSON.stringify(value);
    }
    return String(value);
  } catch (_) {
    return line;
  }
}

function readProgressLines(taskId, limit = 30) {
  if (!isSafeTaskId(taskId)) {
    return null;
  }
  const filePath = progressPath(taskId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map(parseProgressLine);
}

function listTaskEvents(sinceMs) {
  return listTasks()
    .map((task) => {
      const ts = taskTimeMs(task);
      if (!ts || ts <= sinceMs) {
        return null;
      }
      return {
        ts,
        type: 'task_update',
        id: task.id,
        title: task.title || task.id,
        status: task.status || 'unknown',
        summary: taskSummary(task),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts)
    .slice(-50);
}

function renderHome() {
  return `<!doctype html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIWFF Runtime — Cockpit</title>
  <style>
    :root { color-scheme: dark; font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; background: #1e1e2e; color: #cdd6f4; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: #1e1e2e; color: #cdd6f4; }
    #shell { display: grid; grid-template-columns: 240px 1fr 320px; height: 100vh; min-width: 860px; }
    .panel { min-height: 0; overflow: hidden; background: #181825; border-right: 1px solid #313244; display: flex; flex-direction: column; }
    .panel:last-child { border-right: 0; }
    .panel-head { min-height: 48px; padding: 12px 14px; border-bottom: 1px solid #313244; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .panel-title { margin: 0; color: #89b4fa; font-size: 12px; line-height: 1.2; text-transform: uppercase; letter-spacing: 0; }
    .panel-sub { color: #6c7086; font-size: 11px; white-space: nowrap; }
    .scroll { min-height: 0; flex: 1; overflow-y: auto; padding: 10px; }
    .task-group { margin-bottom: 12px; }
    .group-title { color: #6c7086; font-size: 10px; margin: 0 0 5px; text-transform: uppercase; letter-spacing: 0; }
    .task-card { width: 100%; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; min-height: 36px; padding: 7px 8px; margin-bottom: 5px; border: 1px solid #313244; border-radius: 6px; background: #1e1e2e; color: #cdd6f4; cursor: pointer; font: inherit; text-align: left; }
    .task-card:hover, .task-card.selected { border-color: #89b4fa; background: #242438; }
    .badge { font-size: 10px; line-height: 1; }
    .badge.doing { color: #f9e2af; }
    .badge.pending { color: #89b4fa; }
    .badge.done { color: #a6e3a1; }
    .badge.failed { color: #f38ba8; }
    .task-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .task-elapsed { color: #6c7086; font-size: 10px; white-space: nowrap; }
    .feed-panel { background: #1e1e2e; }
    .runtime-title { display: flex; align-items: baseline; gap: 10px; }
    .runtime-title h1 { margin: 0; color: #cdd6f4; font-size: 14px; line-height: 1.2; letter-spacing: 0; }
    #active-state { font-size: 11px; color: #6c7086; white-space: nowrap; }
    #active-state.active { color: #a6e3a1; }
    #event-feed { padding: 12px 14px; }
    .event-line { display: grid; grid-template-columns: 90px 86px 1fr; gap: 8px; align-items: baseline; min-height: 21px; color: #cdd6f4; font-size: 12px; line-height: 1.45; }
    .evt-time { color: #6c7086; white-space: nowrap; }
    .evt-src { white-space: nowrap; }
    .src-system { color: #89b4fa; }
    .src-task { color: #a6e3a1; }
    .src-task.failed { color: #f38ba8; }
    .src-worker { color: #94e2d5; }
    .src-error { color: #f38ba8; }
    .evt-msg { min-width: 0; overflow-wrap: anywhere; }
    #log-title { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cdd6f4; font-size: 12px; }
    #log-body { padding: 12px; }
    .log-line { min-height: 21px; color: #cdd6f4; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
    .log-line.ok { color: #a6e3a1; }
    .log-line.err { color: #f38ba8; }
    .empty { color: #6c7086; font-size: 11px; line-height: 1.5; padding: 8px 0; }
    .summary { color: #cdd6f4; font-size: 11px; line-height: 1.55; margin-bottom: 10px; overflow-wrap: anywhere; }
    .artifact { color: #89b4fa; font-size: 10px; line-height: 1.55; border: 1px solid #313244; border-radius: 6px; padding: 8px; overflow-wrap: anywhere; user-select: all; }
    @media (max-width: 920px) {
      #shell { grid-template-columns: 220px 1fr 280px; min-width: 760px; }
    }
  </style>
</head>
<body>
  <div id="shell">
    <aside id="panel-tasks" class="panel tasks-panel">
      <div class="panel-head">
        <h2 class="panel-title">控制台</h2>
        <span class="panel-sub">PID ${process.pid}</span>
      </div>
      <div id="task-list" class="scroll"></div>
    </aside>
    <main id="panel-feed" class="panel feed-panel">
      <div class="panel-head">
        <div class="runtime-title">
          <h1>AIWFF Runtime</h1>
          <span id="active-state">○ idle</span>
        </div>
        <span class="panel-sub">Cockpit</span>
      </div>
      <div id="event-feed" class="scroll"></div>
    </main>
    <aside id="panel-log" class="panel log-panel">
      <div class="panel-head">
        <h2 id="log-title" class="panel-title">Select a task →</h2>
      </div>
      <div id="log-body" class="scroll"><div class="empty">Select a task to inspect progress.</div></div>
    </aside>
  </div>
  <script>
    let lastEventTs = Date.now() - 300000;
    let selectedTaskId = null;
    let tasks = [];
    const progressSeen = {};

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function normalizeStatus(status) {
      const value = String(status || '').toLowerCase();
      return value === 'running' ? 'doing' : value || 'pending';
    }

    function statusClass(status) {
      const value = normalizeStatus(status);
      return ['doing', 'pending', 'done', 'failed'].includes(value) ? value : 'pending';
    }

    function isActiveTask(task) {
      return ['doing', 'pending', 'running'].includes(String(task.status || '').toLowerCase());
    }

    function timeMs(task) {
      const value = task.updatedAt || task.updated_at || task.startedAt || task.started_at || task.createdAt || task.created_at;
      const ms = typeof value === 'number' ? value : Date.parse(value || '');
      return Number.isFinite(ms) ? ms : 0;
    }

    function elapsed(task) {
      const value = task.startedAt || task.started_at || task.createdAt || task.created_at || task.updatedAt || task.updated_at;
      const start = typeof value === 'number' ? value : Date.parse(value || '');
      if (!Number.isFinite(start)) return '';
      const minutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
      if (minutes < 1) return '<1m';
      if (minutes < 60) return minutes + 'm';
      return Math.floor(minutes / 60) + 'h';
    }

    function fmtTime(ts) {
      return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function selectedTask() {
      return tasks.find(function(task) { return task.id === selectedTaskId; });
    }

    function setActiveState() {
      const activeCount = tasks.filter(isActiveTask).length;
      const el = document.getElementById('active-state');
      el.textContent = activeCount ? '● ' + activeCount + ' active' : '○ idle';
      el.className = activeCount ? 'active' : '';
    }

    function renderTasks() {
      const root = document.getElementById('task-list');
      const latest = tasks.slice().sort(function(a, b) { return timeMs(b) - timeMs(a); }).slice(0, 20);
      const groups = ['doing', 'pending', 'done', 'failed'];
      root.innerHTML = '';

      groups.forEach(function(group) {
        const items = latest.filter(function(task) { return statusClass(task.status) === group; });
        if (!items.length) return;
        const section = document.createElement('section');
        section.className = 'task-group';
        const title = document.createElement('h3');
        title.className = 'group-title';
        title.textContent = group;
        section.appendChild(title);

        items.forEach(function(task) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'task-card' + (task.id === selectedTaskId ? ' selected' : '');
          button.setAttribute('data-id', task.id);
          button.addEventListener('click', function() {
            selectedTaskId = task.id;
            renderTasks();
            renderLogShell();
            pollLog(task.id);
          });

          const badge = document.createElement('span');
          badge.className = 'badge ' + statusClass(task.status);
          badge.textContent = '[' + statusClass(task.status) + ']';
          const titleEl = document.createElement('span');
          titleEl.className = 'task-title';
          const rawTitle = task.title || task.id;
          titleEl.textContent = rawTitle.length > 32 ? rawTitle.slice(0, 31) + '…' : rawTitle;
          const age = document.createElement('span');
          age.className = 'task-elapsed';
          age.textContent = elapsed(task);

          button.appendChild(badge);
          button.appendChild(titleEl);
          button.appendChild(age);
          section.appendChild(button);
        });
        root.appendChild(section);
      });

      if (!latest.length) {
        root.innerHTML = '<div class="empty">No tasks yet. POST to /api/tasks to start a mock worker.</div>';
      }
      setActiveState();
    }

    function appendEvent(type, message, ts, status) {
      const feed = document.getElementById('event-feed');
      const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      const row = document.createElement('div');
      row.className = 'event-line';
      const time = document.createElement('span');
      time.className = 'evt-time';
      time.textContent = '[' + fmtTime(ts || Date.now()) + ']';
      const src = document.createElement('span');
      src.className = 'evt-src src-' + type + (statusClass(status) === 'failed' ? ' failed' : '');
      src.textContent = '[' + type + ']';
      const msg = document.createElement('span');
      msg.className = 'evt-msg';
      msg.textContent = message;
      row.appendChild(time);
      row.appendChild(src);
      row.appendChild(msg);
      feed.appendChild(row);
      while (feed.children.length > 500) {
        feed.removeChild(feed.firstElementChild);
      }
      if (nearBottom) {
        feed.scrollTop = feed.scrollHeight;
      }
    }

    function renderLogShell() {
      const task = selectedTask();
      const title = document.getElementById('log-title');
      const body = document.getElementById('log-body');
      if (!task) {
        title.textContent = 'Select a task →';
        body.innerHTML = '<div class="empty">Select a task to inspect progress.</div>';
        return;
      }

      title.textContent = task.title || task.id;
      if (!isActiveTask(task)) {
        const summary = task.result_summary || task.summary || task.error || 'No result summary recorded.';
        const artifact = task.artifact_path || task.artifactPath || '';
        body.innerHTML =
          '<div class="summary">' + escapeHtml(summary) + '</div>' +
          (artifact ? '<div class="artifact">' + escapeHtml(artifact) + '</div>' : '<div class="empty">No artifact path recorded.</div>');
      }
    }

    function renderLogLines(lines) {
      const body = document.getElementById('log-body');
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      body.innerHTML = '';
      lines.slice(-100).forEach(function(line) {
        const div = document.createElement('div');
        const text = String(line);
        const lower = text.toLowerCase();
        div.className = 'log-line' + (lower.includes('fail') || lower.includes('error') || text.includes('✗') ? ' err' : lower.includes('pass') || lower.includes('ok') || text.includes('✓') ? ' ok' : '');
        div.textContent = '> ' + text;
        body.appendChild(div);
      });
      if (!lines.length) {
        body.innerHTML = '<div class="empty">Waiting for progress...</div>';
      }
      if (nearBottom) {
        body.scrollTop = body.scrollHeight;
      }
    }

    async function pollTasks() {
      try {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        tasks = Array.isArray(data.tasks) ? data.tasks : [];
        renderTasks();
        if (selectedTaskId && !selectedTask()) {
          selectedTaskId = null;
        }
        renderLogShell();
      } catch (error) {
        appendEvent('error', 'GET /api/tasks failed: ' + error.message, Date.now());
      }
    }

    async function pollEvents() {
      try {
        const res = await fetch('/api/events?since=' + encodeURIComponent(lastEventTs));
        const data = await res.json();
        const events = Array.isArray(data.events) ? data.events : [];
        events.forEach(function(event) {
          const icon = statusClass(event.status) === 'done' ? '✅ ' : statusClass(event.status) === 'failed' ? '✗ ' : statusClass(event.status) === 'doing' ? '⏳ ' : '';
          const msg = icon + (event.title || event.id) + ' ' + (event.status || '') + (event.summary ? ' — ' + event.summary : '');
          appendEvent('task', msg, event.ts, event.status);
          lastEventTs = Math.max(lastEventTs, Number(event.ts) || lastEventTs);
        });
      } catch (error) {
        appendEvent('error', 'GET /api/events failed: ' + error.message, Date.now());
      }
    }

    async function pollProgressIntoFeed(task) {
      if (statusClass(task.status) !== 'doing') return;
      progressSeen[task.id] = progressSeen[task.id] || new Set();
      try {
        const res = await fetch('/api/tasks/' + encodeURIComponent(task.id) + '/progress');
        if (!res.ok) return;
        const data = await res.json();
        const lines = Array.isArray(data.lines) ? data.lines : [];
        lines.forEach(function(line) {
          const key = String(line);
          if (progressSeen[task.id].has(key)) return;
          progressSeen[task.id].add(key);
          appendEvent('worker', '[' + task.id.slice(0, 8) + '] > ' + key, Date.now());
        });
      } catch (_) {
        // Progress is optional while a worker is starting.
      }
    }

    async function pollLog(taskId) {
      const task = selectedTask();
      if (!task || task.id !== taskId || !isActiveTask(task)) return;
      try {
        const res = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/progress');
        if (!res.ok) {
          renderLogLines([]);
          return;
        }
        const data = await res.json();
        renderLogLines(Array.isArray(data.lines) ? data.lines : []);
      } catch (error) {
        renderLogLines(['GET /api/tasks/' + taskId + '/progress failed: ' + error.message]);
      }
    }

    async function tick() {
      await pollTasks();
      await pollEvents();
      tasks.filter(isActiveTask).forEach(function(task) {
        pollProgressIntoFeed(task);
      });
      if (selectedTaskId) {
        pollLog(selectedTaskId);
      }
    }

    appendEvent('system', 'cockpit ready', Date.now());
    tick();
    setInterval(tick, 4000);
    setInterval(function() {
      if (selectedTaskId) pollLog(selectedTaskId);
    }, 2000);
  </script>
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

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const rawSince = url.searchParams.get('since');
    const parsedSince = rawSince == null ? NaN : Number(rawSince);
    const sinceMs = Number.isFinite(parsedSince) ? parsedSince : Date.now() - 30 * 60 * 1000;
    sendJson(res, 200, { ok: true, events: listTaskEvents(sinceMs) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    await createTask(req, res);
    return;
  }

  const progressMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/progress$/);
  if (req.method === 'GET' && progressMatch) {
    const id = decodeURIComponent(progressMatch[1]);
    const lines = readProgressLines(id, 30);
    if (!lines) {
      sendJson(res, 404, { ok: false, error: 'Progress not found' });
      return;
    }
    sendJson(res, 200, { ok: true, id, lines });
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
