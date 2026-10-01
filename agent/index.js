const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
loadDotEnv();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const INBOX_DIR = path.join(DATA_DIR, 'inbox');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const PORT = Number(process.env.PORT || 3100);
const RUNTIME_TOKEN_HEADER = 'x-aiwff-runtime-token';
// cookie 只綁 host、不分 port：名稱帶 port，同一台機器開多個 runtime 時才不會互相覆蓋。
function runtimeTokenCookieName(port = PORT) {
  return `aiwff_runtime_token_${port}`;
}
const RUNTIME_TOKEN_COOKIE = runtimeTokenCookieName();
// 寫入授權用的 runtime token：只存在記憶體。
// 有設 AIWFF_RUNTIME_TOKEN 就沿用（固定 token，給腳本 / curl 用）；沒設則啟動時自動產生（Jupyter 模式）。
let runtimeToken = '';
const DEFAULT_WORKER_TIMEOUT_SEC = 600;
const MAX_WORKER_TIMEOUT_SEC = 3600;
const MAX_MEMORY_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 128 * 1024;
const DEFAULT_CLAUDE_DISALLOWED_TOOLS = 'Bash,PowerShell';
let tgOffset = 0;
const tgPendingNotify = {};

function envFlag(name) {
  return process.env[name] === '1' || String(process.env[name]).toLowerCase() === 'true';
}

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

// 失敗任務基本 retry：預設重試 2 次（共 3 次嘗試），可用環境變數覆蓋。
const MAX_TASK_RETRIES = envInt('MAX_TASK_RETRIES', 2, { min: 0, max: 10 });
const RETRY_BACKOFF_MS = envInt('RETRY_BACKOFF_MS', 500, { min: 0, max: 60000 });

// Telegram 斷線重連：poll 迴圈用自排程 + 指數退避，單一請求加逾時避免卡死。
const TG_API_BASE_URL = process.env.TG_API_BASE_URL || 'https://api.telegram.org';
const TG_REQUEST_TIMEOUT_MS = envInt('TG_REQUEST_TIMEOUT_MS', 20000, { min: 1000, max: 120000 });
const TG_POLL_BASE_MS = envInt('TG_POLL_BASE_MS', 2000, { min: 200, max: 60000 });
const TG_POLL_MAX_BACKOFF_MS = envInt('TG_POLL_MAX_BACKOFF_MS', 60000, { min: TG_POLL_BASE_MS, max: 600000 });

// 崩潰韌性護欄：把裸露例外/rejection 與非同步回呼裡的 fs 寫入導向 stderr，
// 讓單一失敗只留紀錄、不整隻 runtime 崩掉。設計取捨＝韌性優先於嚴格中止。
function logStderr(context, detail) {
  const message = detail && detail.stack ? detail.stack : detail;
  process.stderr.write(`[${nowIso()}] ${context}: ${message}\n`);
}

function installProcessGuards() {
  process.on('uncaughtException', (err) => {
    logStderr('uncaughtException (survived)', err);
  });
  process.on('unhandledRejection', (reason) => {
    logStderr('unhandledRejection (survived)', reason);
  });
}

function loadDotEnv(envPath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    // 空白值＝未設定：shell 裡留一個空的 X= 不該把 .env 的值蓋掉。
    if (!match || String(process.env[match[1]] ?? '').trim() !== '') {
      continue;
    }
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function ensureDirectories() {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
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

function inboxPath(taskId, eventName) {
  return path.join(INBOX_DIR, `${taskId}.${eventName}.json`);
}

function isSafeTaskId(taskId) {
  return /^[A-Za-z0-9._-]+$/.test(taskId);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8').trim();
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// 給非同步回呼（worker close / timeout / 進度管線）用的容錯寫入：
// 寫失敗只導向 stderr 並回傳 false，不讓例外冒泡成 uncaughtException。
function safeWriteJsonFile(filePath, value) {
  try {
    writeJsonFile(filePath, value);
    return true;
  } catch (error) {
    logStderr(`fs write failed (${filePath})`, error);
    return false;
  }
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
          title: '任務檔無法讀取',
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

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getRequestToken(req) {
  const headerToken = req.headers[RUNTIME_TOKEN_HEADER];
  if (Array.isArray(headerToken)) {
    return headerToken[0] || '';
  }
  if (typeof headerToken === 'string' && headerToken) {
    return headerToken;
  }

  const auth = req.headers.authorization || '';
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  if (match) {
    return match[1];
  }

  // WebUI 用登入連結換到的 HttpOnly cookie（見 handleLoginLink）。
  return readCookie(req, RUNTIME_TOKEN_COOKIE);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) {
    return '';
  }
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch (_) {
      return '';
    }
  }
  return '';
}

// 啟動時決定 runtime token；回傳 generated 讓啟動訊息說明 token 來源。
function initRuntimeToken() {
  const configuredToken = process.env.AIWFF_RUNTIME_TOKEN || '';
  runtimeToken = configuredToken || crypto.randomBytes(24).toString('hex');
  return { generated: !configuredToken };
}

function runtimeLoginUrl() {
  return `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(runtimeToken)}`;
}

function hasValidRuntimeToken(token) {
  return Boolean(runtimeToken) && timingSafeStringEqual(token, runtimeToken);
}

// GET ?token=：正確 → 發 HttpOnly cookie 並 302 到去掉 token 的同一路徑；錯誤 → 401、不發 cookie。
function handleLoginLink(req, res, url) {
  const token = url.searchParams.get('token') || '';
  if (!hasValidRuntimeToken(token)) {
    sendHtml(
      res,
      401,
      '<!doctype html><meta charset="utf-8"><title>登入連結無效</title>' +
        '<p>登入連結無效。runtime 每次重啟（未設固定 AIWFF_RUNTIME_TOKEN 時）都會換新 token，' +
        '請回到跑 <code>npm run web</code> 的終端機，點最新印出的登入連結。</p>',
    );
    return;
  }
  const next = new URLSearchParams(url.searchParams);
  next.delete('token');
  const query = next.toString();
  res.writeHead(302, {
    location: `${url.pathname}${query ? `?${query}` : ''}`,
    'set-cookie': `${RUNTIME_TOKEN_COOKIE}=${encodeURIComponent(runtimeToken)}; HttpOnly; SameSite=Strict; Path=/`,
    'cache-control': 'no-store',
  });
  res.end();
}

function sameOriginWriteRequest(req) {
  const allowed = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  for (const name of ['origin', 'referer']) {
    const value = req.headers[name];
    if (!value) {
      continue;
    }
    let parsed;
    try {
      parsed = new URL(Array.isArray(value) ? value[0] : value);
    } catch (_) {
      return false;
    }
    if (!allowed.has(parsed.origin)) {
      return false;
    }
  }
  return true;
}

function verifyWriteAccess(req) {
  const configuredToken = runtimeToken;
  if (!configuredToken) {
    return { ok: false, status: 401, error: 'AIWFF_RUNTIME_TOKEN is required for write requests' };
  }
  if (!timingSafeStringEqual(getRequestToken(req), configuredToken)) {
    return { ok: false, status: 401, error: 'Missing or invalid runtime token' };
  }
  if (!sameOriginWriteRequest(req)) {
    return { ok: false, status: 403, error: 'Cross-origin write request rejected' };
  }
  return { ok: true };
}

// 需要 token 的讀取（目前只有任務產出內容）：同 getRequestToken 三種來源；GET 不做 Origin 檢查。
function verifyReadAccess(req) {
  if (!hasValidRuntimeToken(getRequestToken(req))) {
    return { ok: false, status: 401, error: 'Missing or invalid runtime token' };
  }
  return { ok: true };
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

function taskEventSummary(task) {
  if (task.status === 'blocked') {
    return task.blocked_reason ? `卡住：${task.blocked_reason}` : '卡住';
  }
  if (task.status === 'done') {
    return taskSummary(task) || task.artifact_path || '完成';
  }
  return taskSummary(task) || task.error || task.instruction || '';
}

function writeInboxEvent(task, eventName) {
  if (!task || !isSafeTaskId(task.id) || !isSafeTaskId(eventName)) {
    return;
  }
  ensureDirectories();
  const event = {
    task_id: task.id,
    event: eventName,
    status: task.status,
    title: task.title || task.id,
    timestamp: nowIso(),
    ts: Date.now(),
    summary: taskEventSummary(task),
  };
  safeWriteJsonFile(inboxPath(task.id, eventName), event);
}

function listInboxEvents() {
  ensureDirectories();
  return fs
    .readdirSync(INBOX_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        const event = readJsonFile(path.join(INBOX_DIR, name));
        return { ...event, file: name };
      } catch (error) {
        return {
          file: name,
          event: 'unreadable',
          status: 'blocked',
          title: '收件匣事件無法讀取',
          timestamp: nowIso(),
          ts: Date.now(),
          summary: error.message,
        };
      }
    })
    .sort((a, b) => {
      const left = Number(a.ts) || Date.parse(a.timestamp || '') || 0;
      const right = Number(b.ts) || Date.parse(b.timestamp || '') || 0;
      return right - left;
    })
    .slice(0, 100);
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

function isSafeMarkdownFileName(name) {
  return /^[A-Za-z0-9._-]+\.md$/i.test(name);
}

function isSafeLogFileName(name) {
  return /^[A-Za-z0-9._-]+\.(log|txt|jsonl|md)$/i.test(name);
}

function readUtf8WithinLimit(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath);
  const sliced = raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw;
  return {
    text: sliced.toString('utf8'),
    size_bytes: stat.size,
    truncated: raw.length > maxBytes,
  };
}

function readUtf8Tail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return {
    text: buffer.toString('utf8'),
    size_bytes: stat.size,
    truncated: start > 0,
  };
}

function splitFrontmatter(rawText) {
  const match = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: '', content: rawText };
  }
  return {
    frontmatter: match[1],
    content: rawText.slice(match[0].length),
  };
}

function readMemoryDocument(name) {
  if (!isSafeMarkdownFileName(name)) {
    return null;
  }
  const filePath = path.resolve(MEMORY_DIR, name);
  const memoryRoot = path.resolve(MEMORY_DIR);
  if (filePath !== memoryRoot && !filePath.startsWith(`${memoryRoot}${path.sep}`)) {
    return null;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  const limited = readUtf8WithinLimit(filePath, MAX_MEMORY_BYTES);
  const parts = splitFrontmatter(limited.text);
  return {
    file: name,
    size_bytes: limited.size_bytes,
    truncated: limited.truncated,
    updated_at: fs.statSync(filePath).mtime.toISOString(),
    frontmatter: parts.frontmatter,
    content: parts.content,
  };
}

function listMemoryDocuments() {
  if (!fs.existsSync(MEMORY_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MEMORY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSafeMarkdownFileName(entry.name))
    .map((entry) => readMemoryDocument(entry.name))
    .filter(Boolean)
    .sort((a, b) => a.file.localeCompare(b.file));
}

function listLogFiles() {
  if (!fs.existsSync(LOGS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSafeLogFileName(entry.name))
    .map((entry) => {
      const filePath = path.join(LOGS_DIR, entry.name);
      const tail = readUtf8Tail(filePath, MAX_LOG_BYTES);
      return {
        file: entry.name,
        size_bytes: tail.size_bytes,
        truncated: tail.truncated,
        tail: tail.text,
        updated_at: fs.statSync(filePath).mtime.toISOString(),
      };
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function listProgressLogLines() {
  return listTasks()
    .slice(0, 20)
    .flatMap((task) => {
      const lines = readProgressLines(task.id, 10) || [];
      return lines.map((line) => ({
        task_id: task.id,
        title: task.title || task.id,
        status: task.status || 'unknown',
        text: line,
      }));
    });
}

function countTasksByStatus(tasks) {
  const counts = {
    total: tasks.length,
    pending: 0,
    running: 0,
    done: 0,
    blocked: 0,
    failed: 0,
    unknown: 0,
  };
  for (const task of tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, task.status)) {
      counts[task.status] += 1;
    } else {
      counts.unknown += 1;
    }
  }
  return counts;
}

function runtimeWorkerMode() {
  if (shouldUseOpenAICompatibleWorker()) {
    return 'openai_compatible';
  }
  return shouldUseMockWorker() ? 'mock' : 'claude';
}

function getHudSnapshot() {
  const tasks = listTasks();
  return {
    ok: true,
    port: PORT,
    uptime_sec: Math.round(process.uptime()),
    worker_mode: runtimeWorkerMode(),
    task_counts: countTasksByStatus(tasks),
    inbox_count: listInboxEvents().length,
    memory_count: listMemoryDocuments().length,
    latest_tasks: tasks.slice(0, 5),
    latest_events: listTaskEvents(0).slice(-5),
  };
}

function checkPathReadable(id, dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.R_OK);
    return { id, ok: true, detail: `${path.relative(ROOT_DIR, dirPath) || '.'} 可讀取` };
  } catch (error) {
    return { id, ok: false, detail: error.message };
  }
}

function getDoctorReport() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks = [
    { id: 'node_version', ok: nodeMajor >= 18, detail: `${process.version} ${nodeMajor >= 18 ? '>=' : '<'} 18` },
    checkPathReadable('tasks_dir', TASKS_DIR),
    checkPathReadable('inbox_dir', INBOX_DIR),
    checkPathReadable('memory_dir', MEMORY_DIR),
    { id: 'worker_mode', ok: true, detail: runtimeWorkerMode() },
    { id: 'port', ok: true, detail: String(PORT) },
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    next_actions: checks.filter((check) => !check.ok).map((check) => `修正 ${check.id}: ${check.detail}`),
  };
}

function getSettingsSnapshot() {
  return {
    ok: true,
    port: PORT,
    worker_mode: runtimeWorkerMode(),
    default_worker_timeout_sec: DEFAULT_WORKER_TIMEOUT_SEC,
    max_worker_timeout_sec: MAX_WORKER_TIMEOUT_SEC,
    memory_source: 'memory/*.md',
    writable_data_dirs: ['data/tasks', 'data/artifacts', 'data/inbox'],
    endpoints: [
      { name: 'HUD', route: 'GET /api/hud + GET /api/health' },
      { name: '對話 / 新任務', route: 'POST /api/tasks, GET /api/tasks/:id/result' },
      { name: '任務', route: 'GET /api/tasks, GET /api/tasks/:id' },
      { name: '進度 / 事件', route: 'GET /api/events, GET /api/tasks/:id/progress' },
      { name: '收件匣 / 卡住', route: 'GET /api/inbox, GET /api/tasks?status=blocked' },
      { name: '記憶', route: 'GET /api/memory, GET /api/memory/:file' },
      { name: '紀錄', route: 'GET /api/logs' },
      { name: '診斷 / 設定', route: 'GET /api/doctor, GET /api/settings' },
    ],
  };
}

function renderHome() {
  return fs.readFileSync(path.join(__dirname, 'webui.html'), 'utf8');
}

function spawnMockWorker(task) {
  const taskId = task.id;
  const timeoutMs = normalizeWorkerTimeoutSec(task) * 1000;
  let timedOut = false;
  const child = spawn('node', ['examples/mock-worker/worker.js', taskId], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
  });
  const timer = setTimeout(() => {
    timedOut = true;
    markTaskBlockedByTimeout(taskId, task);
    child.kill();
  }, timeoutMs);

  child.on('error', (error) => {
    clearTimeout(timer);
    const task = readTask(taskId);
    if (!task) {
      return;
    }
    task.status = 'failed';
    task.error = error.message;
    task.updated_at = nowIso();
    safeWriteJsonFile(taskPath(taskId), task);
  });

  child.on('close', () => {
    clearTimeout(timer);
    if (timedOut) {
      return;
    }
    const latestTask = readTask(taskId);
    if (!latestTask) {
      return;
    }
    if (latestTask.status === 'done' || latestTask.status === 'blocked') {
      writeInboxEvent(latestTask, latestTask.status);
      notifyTelegramTaskDone(latestTask);
    }
  });

  child.unref();
}

function artifactResultPath(taskId) {
  return path.join(ARTIFACTS_DIR, `${taskId}.result.md`);
}

function artifactResultRef(taskId) {
  return path.relative(ROOT_DIR, artifactResultPath(taskId)).replaceAll(path.sep, '/');
}

// 讀取任務產出給 WebUI 對話分頁顯示。task id 必須是 UUID（createTask 用 crypto.randomUUID）；
// 路徑只由程式組出 data/artifacts/<id>.result.md 或 .result.json，不接受使用者給的路徑。
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULT_CONTENT_BYTES = 64 * 1024;

function isUuidTaskId(taskId) {
  return TASK_ID_PATTERN.test(String(taskId));
}

// 依 UTF-8 位元組截斷，切點退到字元開頭，避免切出半個中文字。
function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) {
    return { content: buffer.toString('utf8'), truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { content: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

function readTaskResult(taskId) {
  const artifactRoot = path.resolve(ARTIFACTS_DIR);
  const candidates = [
    { format: 'md', file: path.resolve(ARTIFACTS_DIR, `${taskId}.result.md`) },
    { format: 'json', file: path.resolve(ARTIFACTS_DIR, `${taskId}.result.json`) },
  ];
  for (const candidate of candidates) {
    // 防路徑穿越的第二道：組出來的檔案必須直接落在 data/artifacts 底下。
    if (path.dirname(candidate.file) !== artifactRoot || !fs.existsSync(candidate.file)) {
      continue;
    }
    const raw = fs.readFileSync(candidate.file, 'utf8');
    if (candidate.format === 'md') {
      return { format: 'md', ...truncateUtf8(raw, MAX_RESULT_CONTENT_BYTES) };
    }
    let text = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.summary === 'string') {
        text = parsed.summary;
      }
    } catch (_) {
      // JSON 壞掉就回原文字串。
    }
    return { format: 'json', ...truncateUtf8(text, MAX_RESULT_CONTENT_BYTES) };
  }
  return null;
}

function handleTaskResult(req, res, rawId) {
  const readAccess = verifyReadAccess(req);
  if (!readAccess.ok) {
    sendJson(res, readAccess.status, { ok: false, error: readAccess.error });
    return;
  }
  if (!isUuidTaskId(rawId)) {
    sendJson(res, 400, { ok: false, error: 'invalid task id' });
    return;
  }
  const task = readTask(rawId);
  if (!task) {
    sendJson(res, 404, { ok: false, error: '找不到任務' });
    return;
  }
  const result = task.status === 'done' ? readTaskResult(rawId) : null;
  if (!result) {
    sendJson(res, 404, { ok: false, error: 'result not ready' });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    task_id: task.id || rawId,
    status: task.status,
    format: result.format,
    content: result.content,
    truncated: result.truncated,
  });
}

function appendProgressText(taskId, line) {
  // 進度是 best-effort：寫失敗（如磁碟滿）只記 stderr，不炸掉 stdout 事件回呼。
  try {
    fs.appendFileSync(progressPath(taskId), `${JSON.stringify({ ts: Date.now(), text: line })}\n`);
  } catch (error) {
    logStderr(`progress append failed (${taskId})`, error);
  }
}

function normalizeWorkerTimeoutSec(task) {
  const value = Number(task && task.timeout_sec);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_WORKER_TIMEOUT_SEC;
  }
  return Math.min(value, MAX_WORKER_TIMEOUT_SEC);
}

function normalizeOptionalTimeoutSec(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, MAX_WORKER_TIMEOUT_SEC);
}

function markTaskBlockedByTimeout(taskId, fallbackTask) {
  const currentTask = readTask(taskId) || fallbackTask;
  if (!currentTask || currentTask.status === 'done' || currentTask.status === 'blocked') {
    return currentTask;
  }
  appendProgressText(taskId, `Worker timed out after ${normalizeWorkerTimeoutSec(currentTask)} seconds`);
  return updateTaskStatus(currentTask, 'blocked', { blocked_reason: 'timeout' });
}

function pipeStdoutProgress(taskId, stream) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line) {
        appendProgressText(taskId, line);
      }
    }
  });
  stream.on('end', () => {
    if (buffer) {
      appendProgressText(taskId, buffer);
    }
  });
}

function notifyTelegramTaskDone(task) {
  const chatId = tgPendingNotify[task.id];
  if (!chatId || !process.env.TG_BOT_TOKEN) {
    return;
  }
  let resultText;
  if (task.status === 'done') {
    resultText = `✅ 任務完成：${task.title}\n結果：${task.artifact_path}`;
  } else if (task.status === 'blocked') {
    resultText = `⚠️ 任務卡住：${task.title}\n原因：${task.blocked_reason || '未知'}`;
  } else {
    resultText = `❌ 任務失敗：${task.title}\n原因：${task.error || '未知'}`;
  }
  tgRequest(process.env.TG_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: resultText }).catch(() => {});
  delete tgPendingNotify[task.id];
}

function buildClaudePrompt(task) {
  const systemPrompt = readTextFileIfExists(path.join(ROOT_DIR, 'CLAUDE.md'));
  const facts = readTextFileIfExists(path.join(MEMORY_DIR, 'facts.md'));
  const preferences = readTextFileIfExists(path.join(MEMORY_DIR, 'preferences.md'));

  return `${systemPrompt}

## 記憶
${facts}
${preferences}

## 任務
標題: ${task.title}
指令: ${task.instruction}
任務ID: ${task.id}

結果請寫到: ${artifactResultPath(task.id)}
最後一行必須寫: DONE: <一句話說你完成了什麼>
`;
}

function updateTaskStatus(task, status, extra = {}) {
  const previousStatus = task.status;
  const nextTask = {
    ...task,
    ...extra,
    status,
    updated_at: nowIso(),
  };
  safeWriteJsonFile(taskPath(task.id), nextTask);
  if ((status === 'done' || status === 'blocked') && previousStatus !== status) {
    writeInboxEvent(nextTask, status);
  }
  return nextTask;
}

function quoteWindowsCommand(command) {
  const value = String(command).trim();
  if (!value || (value.startsWith('"') && value.endsWith('"')) || !/\s/.test(value)) {
    return value || '""';
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function taskWorkspacePath(taskId) {
  return path.join(WORKSPACES_DIR, taskId);
}

function shouldUseDangerousClaudeBypass() {
  return envFlag('CLAUDE_BYPASS_APPROVALS') && envFlag('AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS');
}

function appendClaudeBoundaryArgs(args) {
  args.push('--add-dir', ARTIFACTS_DIR);

  const allowedTools = String(process.env.AIWFF_CLAUDE_ALLOWED_TOOLS || '').trim();
  if (allowedTools) {
    args.push('--allowedTools', allowedTools);
  }

  const disallowedTools = String(process.env.AIWFF_CLAUDE_DISALLOWED_TOOLS || DEFAULT_CLAUDE_DISALLOWED_TOOLS).trim();
  if (disallowedTools) {
    args.push('--disallowedTools', disallowedTools);
  }
}

function spawnClaudeProcess(claudeCmd, args, optionsOverride = {}) {
  const options = {
    cwd: optionsOverride.cwd || ROOT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  if (process.platform !== 'win32') {
    return spawn(claudeCmd, args, options);
  }

  const commandLine = [quoteWindowsCommand(claudeCmd), ...args.map(quoteWindowsCommand)].join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function spawnClaudeWorker(task, attempt = 1) {
  ensureDirectories();
  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const fullPrompt = buildClaudePrompt(task);
  const runningTask = updateTaskStatus(task, 'running');
  const timeoutMs = normalizeWorkerTimeoutSec(task) * 1000;
  const workerCwd = taskWorkspacePath(task.id);
  fs.mkdirSync(workerCwd, { recursive: true });
  const args = ['--print'];
  appendClaudeBoundaryArgs(args);
  if (shouldUseDangerousClaudeBypass()) {
    args.unshift('--dangerously-skip-permissions');
    const warning =
      'SECURITY WARNING: Claude worker is running with --dangerously-skip-permissions because both CLAUDE_BYPASS_APPROVALS and AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS are enabled.';
    logStderr(warning, `task=${task.id}`);
    appendProgressText(task.id, warning);
  } else if (envFlag('CLAUDE_BYPASS_APPROVALS')) {
    const warning =
      'SECURITY WARNING: CLAUDE_BYPASS_APPROVALS ignored; set AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS=1 to explicitly opt in.';
    logStderr(warning, `task=${task.id}`);
    appendProgressText(task.id, warning);
  }
  appendProgressText(task.id, `Claude spawn args=${JSON.stringify(args)} cwd=${workerCwd}`);
  const child = spawnClaudeProcess(claudeCmd, args, { cwd: workerCwd });
  let spawnError = null;
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const blockedTask = markTaskBlockedByTimeout(task.id, runningTask);
    if (blockedTask) {
      notifyTelegramTaskDone(blockedTask);
    }
    child.kill();
  }, timeoutMs);

  pipeStdoutProgress(task.id, child.stdout);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.on('error', (error) => {
    spawnError = error;
  });

  child.stdin.on('error', (error) => {
    stderr += `\nstdin error: ${error.message}`;
  });
  child.stdin.end(fullPrompt);

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (timedOut) {
      return;
    }
    const currentTask = readTask(task.id) || runningTask;

    let failureReason = null;
    if (spawnError) {
      failureReason = spawnError.message;
    } else if (code !== 0) {
      const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
      const tail = stderr.trim().slice(-1000);
      failureReason = `Claude exited with ${exitReason}${tail ? `: ${tail}` : ''}`;
    } else if (!fs.existsSync(artifactResultPath(task.id))) {
      failureReason = 'no artifact produced';
    }

    if (!failureReason) {
      const doneTask = updateTaskStatus(currentTask, 'done', { artifact_path: artifactResultRef(task.id) });
      notifyTelegramTaskDone(doneTask);
      return;
    }

    // 失敗任務基本 retry：還沒用完重試額度就退避後重跑，用完才標 failed。
    if (attempt <= MAX_TASK_RETRIES) {
      appendProgressText(
        task.id,
        `Worker attempt ${attempt} failed (${failureReason}); retrying (${attempt}/${MAX_TASK_RETRIES}) in ${RETRY_BACKOFF_MS}ms`,
      );
      updateTaskStatus(currentTask, 'running', { retry_count: attempt, last_error: failureReason });
      setTimeout(() => {
        spawnClaudeWorker(readTask(task.id) || currentTask, attempt + 1);
      }, RETRY_BACKOFF_MS);
      return;
    }

    const failedTask = updateTaskStatus(currentTask, 'failed', {
      error: failureReason,
      retry_count: attempt - 1,
    });
    notifyTelegramTaskDone(failedTask);
  });
}

function shouldUseMockWorker() {
  return envFlag('MOCK_WORKER') || !envFlag('ENABLE_REAL_CLAUDE_WORKER');
}

// OpenAI 相容端點插槽（vLLM / ollama / LM Studio 等）：預設關閉，AIWFF_WORKER_PROVIDER=openai_compatible 才啟用。
// 這條路徑沒有工具，只把任務當一次 chat completion 送出、由 runtime 把回覆寫成 artifact，
// 適合分類／短摘要／封閉抽取這類純文字任務；要動檔案或跑工具的任務請維持 Claude worker。
function shouldUseOpenAICompatibleWorker() {
  return (
    !envFlag('MOCK_WORKER') &&
    String(process.env.AIWFF_WORKER_PROVIDER || '').trim().toLowerCase() === 'openai_compatible'
  );
}

function openAICompatibleConfig() {
  return {
    baseUrl: String(process.env.AIWFF_OPENAI_BASE_URL || '').trim().replace(/\/+$/, ''),
    model: String(process.env.AIWFF_OPENAI_MODEL || '').trim(),
    apiKey: String(process.env.AIWFF_OPENAI_API_KEY || '').trim(),
  };
}

function buildOpenAICompatibleMessages(task) {
  const facts = readTextFileIfExists(path.join(MEMORY_DIR, 'facts.md'));
  const preferences = readTextFileIfExists(path.join(MEMORY_DIR, 'preferences.md'));
  return [
    {
      role: 'system',
      content: `你是用戶的本地 AI 助理。這條路徑沒有工具可用，請直接輸出任務結果本身。\n\n## 記憶\n${facts}\n${preferences}`.trim(),
    },
    { role: 'user', content: `標題: ${task.title}\n指令: ${task.instruction}` },
  ];
}

async function requestOpenAICompatibleCompletion(task, timeoutMs) {
  const config = openAICompatibleConfig();
  if (!config.baseUrl || !config.model) {
    throw new Error('AIWFF_OPENAI_BASE_URL and AIWFF_OPENAI_MODEL are required when AIWFF_WORKER_PROVIDER=openai_compatible');
  }
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, messages: buildOpenAICompatibleMessages(task) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }
  const content = JSON.parse(raw)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('empty completion content');
  }
  return content;
}

function runOpenAICompatibleWorker(task, attempt = 1) {
  ensureDirectories();
  const runningTask = updateTaskStatus(task, 'running');
  const { baseUrl, model } = openAICompatibleConfig();
  appendProgressText(task.id, `OpenAI-compatible request base_url=${baseUrl} model=${model} attempt=${attempt}`);

  requestOpenAICompatibleCompletion(task, normalizeWorkerTimeoutSec(task) * 1000)
    .then((content) => {
      fs.writeFileSync(artifactResultPath(task.id), `${content.trim()}\n`);
      const doneTask = updateTaskStatus(readTask(task.id) || runningTask, 'done', {
        artifact_path: artifactResultRef(task.id),
      });
      notifyTelegramTaskDone(doneTask);
    })
    .catch((error) => {
      const currentTask = readTask(task.id) || runningTask;
      if (error && error.name === 'TimeoutError') {
        const blockedTask = markTaskBlockedByTimeout(task.id, currentTask);
        if (blockedTask) {
          notifyTelegramTaskDone(blockedTask);
        }
        return;
      }
      const failureReason = `OpenAI-compatible request failed: ${error && error.message}`;
      if (attempt <= MAX_TASK_RETRIES) {
        appendProgressText(
          task.id,
          `Worker attempt ${attempt} failed (${failureReason}); retrying (${attempt}/${MAX_TASK_RETRIES}) in ${RETRY_BACKOFF_MS}ms`,
        );
        updateTaskStatus(currentTask, 'running', { retry_count: attempt, last_error: failureReason });
        setTimeout(() => {
          runOpenAICompatibleWorker(readTask(task.id) || currentTask, attempt + 1);
        }, RETRY_BACKOFF_MS);
        return;
      }
      const failedTask = updateTaskStatus(currentTask, 'failed', {
        error: failureReason,
        retry_count: attempt - 1,
      });
      notifyTelegramTaskDone(failedTask);
    });
}

function startTaskWorker(task) {
  if (shouldUseOpenAICompatibleWorker()) {
    runOpenAICompatibleWorker(task);
    return;
  }
  if (shouldUseMockWorker()) {
    spawnMockWorker(task);
    return;
  }
  spawnClaudeWorker(task);
}

function createTaskObject(title, instruction, options = {}) {
  const timestamp = nowIso();
  const timeoutSec = normalizeOptionalTimeoutSec(options.timeout_sec);
  const task = {
    id: crypto.randomUUID(),
    title,
    instruction,
    status: 'pending',
    created_at: timestamp,
    updated_at: timestamp,
  };
  if (timeoutSec != null) {
    task.timeout_sec = timeoutSec;
  }

  writeJsonFile(taskPath(task.id), task);
  startTaskWorker(task);
  return task;
}

function createTaskFromTg({ title, instruction }) {
  const safeTitle = typeof title === 'string' && title.trim() ? title.trim() : '未命名任務';
  const safeInstruction =
    typeof instruction === 'string' && instruction.trim() ? instruction.trim() : '執行任務生命週期。';
  return createTaskObject(safeTitle, safeInstruction);
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

  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : '未命名任務';
  const instruction =
    typeof payload.instruction === 'string' && payload.instruction.trim()
      ? payload.instruction.trim()
      : '執行 mock worker 生命週期。';
  const task = createTaskObject(title, instruction, { timeout_sec: payload.timeout_sec });
  sendJson(res, 201, task);
}

async function tgRequest(token, method, body) {
  const payload = JSON.stringify(body || {});
  const base = new URL(TG_API_BASE_URL);
  const transport = base.protocol === 'http:' ? http : https;
  const basePath = base.pathname.replace(/\/$/, '');
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        path: `${basePath}/bot${token}/${method}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    // 逾時護欄：卡住的連線會被主動中斷，讓 poll 迴圈得以重連而非無限等待。
    req.setTimeout(TG_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Telegram request timed out after ${TG_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function pollTelegram() {
  const token = process.env.TG_BOT_TOKEN;
  const adminId = process.env.ADMIN_TG_CHAT_ID;
  if (!token) {
    return;
  }

  const data = await tgRequest(token, 'getUpdates', { offset: tgOffset, timeout: 1, limit: 10 });
  if (!data.ok || !Array.isArray(data.result) || !data.result.length) {
    return;
  }

  for (const update of data.result) {
    tgOffset = update.update_id + 1;
    const msg = update.message;
    if (!msg || !msg.text) {
      continue;
    }
    if (adminId && String(msg.chat.id) !== String(adminId)) {
      continue;
    }

    const text = msg.text.trim();
    if (text === '/start') {
      await tgRequest(token, 'sendMessage', { chat_id: msg.chat.id, text: '主腦已上線。傳任何指令給我，我會自主執行。' });
      continue;
    }
    if (text === '/tasks') {
      const tasks = listTasks().slice(0, 5);
      const lines = tasks.map((task) => `[${task.status}] ${task.title}`).join('\n') || '（無任務）';
      await tgRequest(token, 'sendMessage', { chat_id: msg.chat.id, text: lines });
      continue;
    }

    const title = text.split(/\r?\n/)[0].slice(0, 60);
    const task = createTaskFromTg({ title, instruction: text });
    tgPendingNotify[task.id] = msg.chat.id;
    await tgRequest(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `✅ 收到，任務建立：${title}\nID: ${task.id.slice(0, 8)}...\n執行中，完成後通知你。`,
    });
  }
}

// Telegram 斷線重連迴圈：以 setTimeout 自排程（不重疊請求），
// 連續失敗時指數退避並記 stderr；成功一次即重置退避。回傳 stop() 供關閉。
function startTelegramPolling() {
  let failures = 0;
  let stopped = false;
  let timer = null;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    const delay = failures === 0 ? TG_POLL_BASE_MS : Math.min(TG_POLL_BASE_MS * 2 ** failures, TG_POLL_MAX_BACKOFF_MS);
    timer = setTimeout(tick, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  };

  async function tick() {
    if (stopped) {
      return;
    }
    try {
      await pollTelegram();
      if (failures > 0) {
        logStderr('telegram-polling', `recovered after ${failures} failed attempt(s)`);
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      logStderr('telegram-polling', `error (reconnecting, attempt ${failures}): ${error.message}`);
    }
    scheduleNext();
  }

  tick();

  return function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.searchParams.has('token')) {
    handleLoginLink(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    sendJson(res, 200, { ok: true, loggedIn: hasValidRuntimeToken(readCookie(req, RUNTIME_TOKEN_COOKIE)) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, 200, renderHome());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, pid: process.pid, uptime: process.uptime() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/hud') {
    sendJson(res, 200, getHudSnapshot());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    sendJson(res, 200, getSettingsSnapshot());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/doctor') {
    sendJson(res, 200, getDoctorReport());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/memory') {
    sendJson(res, 200, { ok: true, source: 'memory/*.md', documents: listMemoryDocuments() });
    return;
  }

  const memoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
  if (req.method === 'GET' && memoryMatch) {
    const document = readMemoryDocument(decodeURIComponent(memoryMatch[1]));
    if (!document) {
      sendJson(res, 404, { ok: false, error: '找不到記憶文件' });
      return;
    }
    sendJson(res, 200, { ok: true, document });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    sendJson(res, 200, { ok: true, files: listLogFiles(), task_progress: listProgressLogLines() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const status = url.searchParams.get('status');
    const tasks = status ? listTasks().filter((task) => task.status === status) : listTasks();
    sendJson(res, 200, { ok: true, tasks });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const rawSince = url.searchParams.get('since');
    const parsedSince = rawSince == null ? NaN : Number(rawSince);
    const sinceMs = Number.isFinite(parsedSince) ? parsedSince : Date.now() - 30 * 60 * 1000;
    sendJson(res, 200, { ok: true, events: listTaskEvents(sinceMs) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/inbox') {
    const events = listInboxEvents();
    sendJson(res, 200, { ok: true, unread: events.length, events });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const writeAccess = verifyWriteAccess(req);
    if (!writeAccess.ok) {
      sendJson(res, writeAccess.status, { ok: false, error: writeAccess.error });
      return;
    }
    await createTask(req, res);
    return;
  }

  // 不 decode：合法 id 是 UUID，不會含編碼字元；%2F 之類原樣進格式驗證被擋成 400。
  const resultMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/result$/);
  if (req.method === 'GET' && resultMatch) {
    handleTaskResult(req, res, resultMatch[1]);
    return;
  }

  const progressMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/progress$/);
  if (req.method === 'GET' && progressMatch) {
    const id = decodeURIComponent(progressMatch[1]);
    const lines = readProgressLines(id, 30);
    if (!lines) {
      sendJson(res, 404, { ok: false, error: '找不到進度紀錄' });
      return;
    }
    sendJson(res, 200, { ok: true, id, lines });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && taskMatch) {
    const task = readTask(taskMatch[1]);
    if (!task) {
      sendJson(res, 404, { ok: false, error: '找不到任務' });
      return;
    }
    sendJson(res, 200, { ok: true, task });
    return;
  }

  sendJson(res, 404, { ok: false, error: '找不到路徑' });
}

function createRuntimeServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
  });
}

function main() {
  installProcessGuards();
  ensureDirectories();
  const { generated } = initRuntimeToken();
  const server = createRuntimeServer();

  server.once('error', (err) => {
    logStderr(
      'server-listen',
      `failed to bind http://127.0.0.1:${PORT}: ${err.code || err.message}. Set PORT to a free port and retry.`,
    );
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`AIWFF Runtime listening on http://127.0.0.1:${PORT}`);
    console.log(`登入 WebUI：${runtimeLoginUrl()}`);
    if (generated) {
      console.log('（AIWFF_RUNTIME_TOKEN 未設：token 為本次啟動自動產生、只存在記憶體，重啟後會換新連結。）');
    }

    if (process.env.TG_BOT_TOKEN && !process.env.ADMIN_TG_CHAT_ID) {
      console.error('Refusing Telegram polling: ADMIN_TG_CHAT_ID is required when TG_BOT_TOKEN is set.');
    } else if (process.env.TG_BOT_TOKEN) {
      startTelegramPolling();
    }
  });
}

if (require.main === module) {
  main();
}

// 測試用曝面：僅在被 require 時提供純函式，不改變 daemon 執行行為。
module.exports = {
  loadDotEnv,
  safeWriteJsonFile,
  appendProgressText,
  installProcessGuards,
  startTelegramPolling,
  tgRequest,
  envInt,
  ensureDirectories,
  initRuntimeToken,
  runtimeLoginUrl,
  createRuntimeServer,
  RUNTIME_TOKEN_COOKIE,
  runtimeTokenCookieName,
  MAX_TASK_RETRIES,
  RETRY_BACKOFF_MS,
  TG_API_BASE_URL,
  TG_POLL_BASE_MS,
  TG_POLL_MAX_BACKOFF_MS,
};
