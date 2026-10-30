const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const { route: routeConversationMessage, normalizeMode: normalizeChatMode } = require('./chat-router');

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

// 「卡住不恢復」與「只是慢」要分得開：無進展時間超過這個門檻才判 stalled，
// 沒超過就只是撞到總預算的 slow。門檻會再被該 task 自己的 timeout_sec 夾住，
// 否則短預算任務（例如 5 秒）永遠達不到門檻，兩種卡法又會被壓回同一個名字。
const WORKER_STALL_IDLE_SEC = envInt('WORKER_STALL_IDLE_SEC', 120, { min: 1, max: 3600 });

// 失敗任務基本 retry：預設重試 2 次（共 3 次嘗試），可用環境變數覆蓋。
const MAX_TASK_RETRIES = envInt('MAX_TASK_RETRIES', 2, { min: 0, max: 10 });
const RETRY_BACKOFF_MS = envInt('RETRY_BACKOFF_MS', 500, { min: 0, max: 60000 });

// Telegram 斷線重連：poll 迴圈用自排程 + 指數退避，單一請求加逾時避免卡死。
const TG_API_BASE_URL = process.env.TG_API_BASE_URL || 'https://api.telegram.org';
const TG_REQUEST_TIMEOUT_MS = envInt('TG_REQUEST_TIMEOUT_MS', 20000, { min: 1000, max: 120000 });
const TG_POLL_BASE_MS = envInt('TG_POLL_BASE_MS', 2000, { min: 200, max: 60000 });
const TG_POLL_MAX_BACKOFF_MS = envInt('TG_POLL_MAX_BACKOFF_MS', 60000, { min: TG_POLL_BASE_MS, max: 600000 });
const TG_MAX_MESSAGE_CHARS = 4000;
// TG 聊天回覆不擋輪詢迴圈；同時在跑的聊天模型呼叫最多幾則，超過就請用戶稍後再傳。
const TG_MAX_CONCURRENT_CHATS = 2;
let tgChatsInFlight = 0;

// 聊天模式（AIWFF_MODE）：聊天呼叫唯讀、無工具、單輪，逾時預設 30 秒。
const CHAT_TIMEOUT_MS = envInt('AIWFF_CHAT_TIMEOUT_SEC', 30, { min: 1, max: 300 }) * 1000;
const MAX_CHAT_INPUT_CHARS = 8000;
const MAX_CHAT_REPLY_CHARS = 16000;
const MOCK_CHAT_REPLY = '（mock）收到你的訊息。這是 MOCK_WORKER 模式的固定回覆；接上真的模型後，這裡會直接回答。';
const CHAT_TASK_HINT = '不是要建任務？下次用 /chat 開頭';

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

// 直寫目標檔的話，程序在寫到一半被砍（worker timeout kill、當機、Windows 關機）
// 會留下截斷的 JSON，下一次 readJsonFile 直接 parse 失敗，該 task 狀態就此救不回。
// 改成 同目錄 temp → rename 原子換檔：rename 之前目標檔一直是上一份完整內容。
// rename 在目標被別的程序開著時（Windows 常見）可能 EPERM/EBUSY，這時退回直寫，
// 最差也只是回到原本的行為，不會比修之前差。
function writeJsonFile(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, text);
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      // temp 沒建成或已被搬走，忽略
    }
    fs.writeFileSync(filePath, text);
  }
}

// schemas/task.schema.json 從 Phase 1 就宣告了 task 的必填欄位與 status 列舉，
// 但在這次之前全 repo 沒有任何一行程式讀它——契約只躺在檔案裡，落檔端想寫什麼都寫得進去。
// 讀取端已經在替壞 row 擦屁股（下面的 isTaskRow / unreadableTaskRow），代價是失敗要等到
// 讀的時候才發現，而那時目標檔早就被那份壞內容覆蓋掉、原本的好內容救不回來。
// 改成存檔當下就對著同一份 schema 驗：驗不過就不換檔，磁碟上留的仍是上一份完整內容，
// 並且吐一個具名 cause（缺哪個欄位／status 是什麼值），不讓讀取端去猜。
// 這裡只實作 task.schema.json 實際用到的關鍵字（required / type / enum / minLength /
// minimum / maximum / additionalProperties），不為了這件事引入 ajv——本 repo 目前零相依。
const TASK_SCHEMA_PATH = path.join(ROOT_DIR, 'schemas', 'task.schema.json');
let taskSchemaCache = null;

function loadTaskSchema() {
  if (!taskSchemaCache) {
    taskSchemaCache = readJsonFile(TASK_SCHEMA_PATH);
  }
  return taskSchemaCache;
}

function typeViolation(key, value, expected) {
  if (expected === 'integer') {
    return Number.isInteger(value) ? null : `type:${key} expected integer got ${typeof value}`;
  }
  if (expected === 'string') {
    return typeof value === 'string' ? null : `type:${key} expected string got ${typeof value}`;
  }
  return null;
}

// 回傳 null＝這份 task 可以落檔；回傳字串＝具名 cause，呼叫端據此拒絕換檔。
function taskSchemaViolation(value) {
  let schema;
  try {
    schema = loadTaskSchema();
  } catch (error) {
    // 契約本身讀不到就不放行：fail-closed。寧可這一次不換檔，也不要在沒有契約的狀態下亂寫。
    return `schema_unreadable:${error.message}`;
  }
  if (!isTaskRow(value)) {
    return `not_an_object:${unknownRowTypeOf(value)}`;
  }
  for (const key of schema.required || []) {
    if (!(key in value)) {
      return `missing_required:${key}`;
    }
  }
  const properties = schema.properties || {};
  for (const [key, entry] of Object.entries(value)) {
    const rule = properties[key];
    if (!rule) {
      if (schema.additionalProperties === false) {
        return `unknown_property:${key}`;
      }
      continue;
    }
    const mismatch = typeViolation(key, entry, rule.type);
    if (mismatch) {
      return mismatch;
    }
    if (rule.enum && !rule.enum.includes(entry)) {
      return `enum:${key}=${String(entry)}`;
    }
    if (rule.minLength != null && String(entry).length < rule.minLength) {
      return `too_short:${key}`;
    }
    if (rule.minimum != null && entry < rule.minimum) {
      return `below_minimum:${key}=${entry}`;
    }
    if (rule.maximum != null && entry > rule.maximum) {
      return `above_maximum:${key}=${entry}`;
    }
  }
  return null;
}

// task 檔唯一的落檔口：先驗 schema 再換檔。驗不過回傳 false 並在 stderr 留具名 cause，
// 目標檔維持上一份內容不動——「拒絕寫壞」優先於「一定要寫進去」。
function safeWriteTaskFile(filePath, task) {
  const violation = taskSchemaViolation(task);
  if (violation) {
    logStderr(`task schema violation, write refused (${filePath})`, violation);
    return false;
  }
  return safeWriteJsonFile(filePath, task);
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

// readTask 在 JSON 壞掉時是會拋的（只擋 existsSync，不擋 parse）。從 worker 的
// error / close 回呼裡呼叫它，一拋就直接衝去 uncaughtException——那一趟回呼剩下的事
// 全不會發生，連「worker 為什麼掛掉」這張失敗收據都跟著消失，現場只剩一行
// uncaughtException，看不出成因。收據不得消失：讀不動就回 null 並留具名 cause，
// 讓呼叫端自己決定退回哪份 fallback，而不是整趟被吃掉。
function readTaskSafely(taskId, context) {
  try {
    return readTask(taskId);
  } catch (error) {
    logStderr(`task file unreadable (${context}, ${taskId})`, error.message);
    return null;
  }
}

// 任務清單的每一筆都是獨立的 row：一筆讀不動不該讓整份清單消失。
// 原本的 try/catch 只擋得住「parse 失敗」，擋不住「parse 成功但不是預期形狀」的
// row（null／陣列／字串——舊版格式、或別的工具塞進來的檔）。這種 row 會一路流到
// 下面的 sort，String(b.created_at) 對 null 直接 TypeError，一筆未知型別就讓
// GET /api/tasks 與 webui 首頁整條凍結。改成跳該筆、留一個同形的佔位 row。
function isTaskRow(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknownRowTypeOf(value) {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function unreadableTaskRow(name, reason) {
  return {
    id: name.replace(/\.json$/, ''),
    status: 'failed',
    title: '任務檔無法讀取',
    instruction: reason,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function listTasks() {
  ensureDirectories();
  return fs
    .readdirSync(TASKS_DIR)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.progress.json'))
    .map((name) => {
      let row;
      try {
        row = readJsonFile(path.join(TASKS_DIR, name));
      } catch (error) {
        return unreadableTaskRow(name, error.message);
      }
      if (!isTaskRow(row)) {
        return unreadableTaskRow(name, `unknown row type: ${unknownRowTypeOf(row)}`);
      }
      return row;
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// 篩選查詢回 0 筆時，光一個空陣列分不出三件事：庫裡本來就沒東西／有東西但這個
// status 剛好沒人／status 根本拼錯所以這個查詢永遠不可能命中。三種的下一步動作
// 完全不同（去建任務／去等／去改查詢），回裸 0 等於把判斷成本推給呼叫端。
function taskStatusVocabulary() {
  try {
    const rule = loadTaskSchema().properties.status;
    return Array.isArray(rule.enum) ? rule.enum : [];
  } catch (error) {
    // 契約讀不到就不宣稱知道合法值有哪些，寧可少講一個分支也不要編出一份清單。
    return [];
  }
}

function taskQueryZeroReason(status, totalTasks) {
  if (totalTasks === 0) {
    return { code: 'no_tasks_at_all', detail: '任務庫沒有任何 task 檔，不是篩選條件的問題' };
  }
  const vocabulary = taskStatusVocabulary();
  if (vocabulary.length && !vocabulary.includes(status)) {
    return {
      code: 'unsearchable_status',
      detail: `status=${status} 不在合法值內，這個查詢永遠不可能命中；合法值：${vocabulary.join(' / ')}`,
    };
  }
  return { code: 'no_match_for_status', detail: `庫內共 ${totalTasks} 筆，沒有 status=${status} 的` };
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

const LOGIN_URL_FILE = path.join(DATA_DIR, 'webui_login_url.txt');

function maskedRuntimeLoginUrl() {
  return `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(runtimeToken.slice(0, 4))}…`;
}

// 互動終端機照舊印完整登入連結；stdout 被導到檔案（daemon log）時只印遮罩版，
// 完整連結改寫進 data/webui_login_url.txt，免得 token 留在 log 裡。
function startupLoginLines(isTTY) {
  if (isTTY) {
    return [`登入 WebUI：${runtimeLoginUrl()}`];
  }
  return [
    `登入 WebUI（token 已遮罩）：${maskedRuntimeLoginUrl()}`,
    `完整登入連結在：${LOGIN_URL_FILE}`,
  ];
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
    if (task.env_hint) {
      return `卡住（環境問題）：${task.env_hint}`;
    }
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

// 凡因上限而被砍掉的資料，都要能講出「被砍幾筆、因為哪個上限」。
// total 拿不到時 dropped 回 null（由畫面顯示「截斷筆數不可得」），不准填 0 充數。
function truncationInfo(total, returned, limitName, limit, reason) {
  if (!Number.isInteger(total)) {
    return {
      truncated: returned >= limit ? null : false,
      dropped: null,
      total: null,
      limit,
      limit_name: limitName,
      reason,
    };
  }
  const dropped = Math.max(0, total - returned);
  return { truncated: dropped > 0, dropped, total, limit, limit_name: limitName, reason };
}

const INBOX_LIST_CAP = 100;
const EVENT_LIST_CAP = 50;

function collectInboxEvents() {
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
    });
}

function listInboxEvents() {
  return collectInboxEvents().slice(0, INBOX_LIST_CAP);
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

// 進度行的時間戳本來就寫在檔裡（appendProgressText 寫 ts、mock worker 寫 at），
// 是 parseProgressLine 只取文字把它丟掉的。trace timeline 要畫時間軸就得拿回來。
// 這是純讀取端解析：寫入端格式一字未動，既有 lines 回傳也一字未動（加性相容）。
function parseProgressTs(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (Number.isFinite(value.ts)) {
      return Number(value.ts);
    }
    if (typeof value.at === 'string') {
      const parsed = Date.parse(value.at);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function readProgressEntries(taskId, limit = 30) {
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
    .map((line) => ({ ts: parseProgressTs(line), text: parseProgressLine(line) }));
}

// 截斷筆數要是實際計數，不是估計：這裡數的是同一份檔案裡真正的非空行數。
// 讀不到就回 null，讓上層誠實顯示「截斷筆數不可得」。
function countProgressLines(taskId) {
  if (!isSafeTaskId(taskId)) {
    return null;
  }
  const filePath = progressPath(taskId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch (_) {
    return null;
  }
}

function normalizeProgressLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 30;
  }
  return Math.min(parsed, 500);
}

function collectTaskEvents(sinceMs) {
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
    .sort((a, b) => a.ts - b.ts);
}

function listTaskEvents(sinceMs) {
  return collectTaskEvents(sinceMs).slice(-EVENT_LIST_CAP);
}

function isSafeMarkdownFileName(name) {
  return /^[A-Za-z0-9._-]+\.md$/i.test(name);
}

function isSafeLogFileName(name) {
  return /^[A-Za-z0-9._-]+\.(log|txt|jsonl|md)$/i.test(name);
}

// UTF-8 續接位元組固定是 0b10xxxxxx。切在位元組數上會把繁中／emoji 從中間剖開，
// 讀出來是 U+FFFD 亂碼。以下兩個 helper 把切點退／進到最近的 code point 邊界。
function utf8SafeEnd(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return buffer.length;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}

function utf8SafeStart(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return start;
}

function readUtf8WithinLimit(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath);
  const sliced = raw.subarray(0, utf8SafeEnd(raw, maxBytes));
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
  // 檔尾這一段的開頭可能落在某個字的中間，往後推到下一個字的起頭再解碼。
  const aligned = start > 0 ? buffer.subarray(utf8SafeStart(buffer)) : buffer;
  return {
    text: aligned.toString('utf8'),
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

// health 只回「活著」時，failed 的任務沉在底下沒人看見。這裡數出還停在 failed
// 的任務數與最舊一筆的時間；不參與 ok 判定（ok 仍是 liveness 語意）。
function failedTaskBacklog(tasks) {
  const failed = tasks.filter((task) => task.status === 'failed');
  let oldestAt = null;
  for (const task of failed) {
    const at = String(task.updated_at || task.created_at || '');
    if (at && (oldestAt === null || at < oldestAt)) {
      oldestAt = at;
    }
  }
  return { count: failed.length, oldest_at: oldestAt };
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
    { id: 'chat_mode', ...chatModeCheck() },
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
    chat_mode: runtimeChatMode(),
    default_worker_timeout_sec: DEFAULT_WORKER_TIMEOUT_SEC,
    max_worker_timeout_sec: MAX_WORKER_TIMEOUT_SEC,
    memory_source: 'memory/*.md',
    writable_data_dirs: ['data/tasks', 'data/artifacts', 'data/inbox'],
    endpoints: [
      { name: 'HUD', route: 'GET /api/hud + GET /api/health' },
      { name: '對話 / 新任務', route: 'POST /api/chat, POST /api/tasks, GET /api/tasks/:id/result' },
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
  const phaseTracker = createWorkerPhaseTracker('spawn');
  const child = spawn('node', ['examples/mock-worker/worker.js', taskId], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
  });
  trackWorker(taskId, child);
  // stdio 是 ignore，沒有輸出可以再細分；只能誠實說「已 detach、之後看不見」。
  phaseTracker.enter('detached_no_stdio');
  const timer = setTimeout(() => {
    timedOut = true;
    markTaskBlockedByTimeout(taskId, task, phaseTracker);
    // mock worker 是直接 spawn 的 node、自己不再開子行程，child.kill() 就是整棵樹；
    // 不走 taskkill 是為了讓它當場結束，續跑時不必等外部指令收尾。
    child.kill();
  }, timeoutMs);

  child.on('error', (error) => {
    clearTimeout(timer);
    // 先留收據再談落檔：task 檔可能已經不見或壞掉，那時下面整段都做不成，
    // 但「worker 起不來、成因是什麼」這件事不該跟著一起消失。
    logStderr(`mock worker spawn failed (${taskId})`, error.message);
    const task = readTaskSafely(taskId, 'mock worker spawn error');
    if (!task) {
      return;
    }
    task.status = 'failed';
    task.error = error.message;
    task.updated_at = nowIso();
    safeWriteTaskFile(taskPath(taskId), task);
  });

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (timedOut) {
      return;
    }
    const latestTask = readTaskSafely(taskId, 'mock worker close');
    if (!latestTask) {
      return;
    }
    if (latestTask.status === 'done' || latestTask.status === 'blocked') {
      writeInboxEvent(latestTask, latestTask.status);
      notifyTelegramTaskDone(latestTask);
      return;
    }
    // worker 沒寫完結狀態就退出（例如一啟動就掛）：當場具名標 failed，不讓任務停在 running 等逾時。
    if (latestTask.status !== 'failed') {
      const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
      const failedTask = updateTaskStatus(latestTask, 'failed', {
        error: `Mock worker exited with ${exitReason} before finishing (status was ${latestTask.status})`,
      });
      notifyTelegramTaskDone(failedTask);
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

// 逾時只吐一個聚合總時長時，「根本沒起來」「起來了一個位元組都沒回」「講到一半停住」
// 三種卡法在帳上長得一模一樣，下一棒只能整支重跑一次才知道要修哪段。
// 追蹤器記住「現在在哪個 phase、在這個 phase 待了多久」，讓逾時收據點得出名字。
// stuck_sec 是「進這個 phase 多久了」，一路穩定吐字的 worker 也會一直長大；
// 要分「卡住不恢復」和「只是慢」得另外記最後一次有進展的時刻（idle_sec）。
//
// 但只記「當下這個 phase」時，它之前那幾段在帳上等於不存在：收據寫
// phase=streaming stuck=540s、預算 600s，中間那 60s 花在 spawn 還是 prompt_sent
// 讀不出來——時間軸有洞，而洞的大小剛好是「還沒被點名的那幾段」。
// 改成記 span：每次換 phase 就把上一段收起來，讓 tracker 起點到 now 這條線
// 被連續切完，沒有任何一秒沒有歸屬（相鄰兩段共用同一個時間點）。
function createWorkerPhaseTracker(initialPhase) {
  const startedAt = Date.now();
  // phases[i] 是第 i 段的名字，boundaries[i] 是它的起點；第 i 段的終點就是
  // boundaries[i+1]（最後一段的終點是 snapshot 當下的 now）。邊界只存一份，
  // 「上一段結束 === 下一段開始」就不是靠事後對帳維持的，而是資料結構本身。
  const phases = [initialPhase];
  const boundaries = [startedAt];
  let lastProgressAt = startedAt;
  return {
    enter(nextPhase) {
      // 每次呼叫都算一次進展（stdout/stderr 每個 chunk 都會打進來），
      // 相同 phase 時只更新 lastProgressAt，邊界留給「這個 phase 待多久」。
      lastProgressAt = Date.now();
      if (phases[phases.length - 1] === nextPhase) {
        return;
      }
      phases.push(nextPhase);
      boundaries.push(lastProgressAt);
    },
    snapshot() {
      const now = Date.now();
      const since = boundaries[boundaries.length - 1];
      // 每個邊界只換算一次秒數再由前後兩段共用：各自 round 的話，同一個時間點
      // 會被算出兩個值，湊出 1 秒的假空隙或假重疊——無 gap 就又變成近似的。
      const edgeSec = [...boundaries, now].map((ms) => Math.round((ms - startedAt) / 1000));
      return {
        phase: phases[phases.length - 1],
        stuck_sec: Math.round((now - since) / 1000),
        idle_sec: Math.round((now - lastProgressAt) / 1000),
        // 相對 tracker 起點的秒數；span[i].end_sec === span[i+1].start_sec。
        phase_spans: phases.map((name, i) => ({
          phase: name,
          start_sec: edgeSec[i],
          end_sec: edgeSec[i + 1],
        })),
      };
    },
  };
}

// 收據上的時間軸：`spawn 0-3s > prompt_sent 3-5s > streaming 5-600s`。
// 落檔只留這個字串而不是 span 陣列——task.schema.json 的驗證器（見上面
// taskSchemaViolation）只實作 string / integer 的 type 檢查，塞一個 array 欄位進去
// 會是「schema 宣告了、驗證器不管」的空頭契約，反而多開一個沒人擋的落檔面。
function formatPhaseSpans(spans) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return null;
  }
  return spans.map((span) => `${span.phase} ${span.start_sec}-${span.end_sec}s`).join(' > ');
}

// 逾時的兩種具名判定（第三種是誠實的「看不到」）：
//   stalled — 無進展時間超標，是真的卡住不恢復
//   slow    — 一直有進展，只是總時長撞到預算
//   unknown — 這條路沒有進展管道（stdio ignore / 沒帶追蹤器），觀測不到就不准硬判
// 沒有 idle 訊號時判 stalled 等於拿「我沒看」當「它卡住」，那是偽造而不是判定。
function classifyTimeout(phase, idleSec, timeoutSec) {
  if (phase === 'unknown' || phase === 'detached_no_stdio' || !Number.isFinite(idleSec)) {
    return 'unknown';
  }
  const threshold = Math.min(WORKER_STALL_IDLE_SEC, timeoutSec);
  return idleSec >= threshold ? 'stalled' : 'slow';
}

function markTaskBlockedByTimeout(taskId, fallbackTask, phaseTracker) {
  // 這裡是「worker 被砍」那條路：從 setTimeout 進來，一拋就沒人接，
  // 連 blocked_reason=timeout 這張收據都不會產生。讀不動就退回 fallbackTask。
  const currentTask = readTaskSafely(taskId, 'worker timeout kill') || fallbackTask;
  if (!currentTask || currentTask.status === 'done' || currentTask.status === 'blocked') {
    return currentTask;
  }
  // 沒帶追蹤器的呼叫端寧可標 unknown，也不要讓帳上看起來像是查過了才沒寫。
  const { phase, stuck_sec: stuckSec, idle_sec: idleSec, phase_spans: phaseSpans } = phaseTracker
    ? phaseTracker.snapshot()
    : { phase: 'unknown', stuck_sec: null, idle_sec: null, phase_spans: null };
  const timeoutSec = normalizeWorkerTimeoutSec(currentTask);
  const kind = classifyTimeout(phase, idleSec, timeoutSec);
  const stuckDetail = stuckSec == null ? '' : `, stuck ${stuckSec}s`;
  const idleDetail = kind === 'unknown' ? '' : `, idle ${idleSec}s`;
  const timeline = formatPhaseSpans(phaseSpans);
  const timelineDetail = timeline ? `, timeline ${timeline}` : '';
  const timeoutText = `Worker timed out after ${timeoutSec} seconds (kind=${kind}, phase=${phase}${stuckDetail}${idleDetail}${timelineDetail})`;
  appendProgressText(taskId, timeoutText);
  // blocked_reason 維持 'timeout'（收件匣摘要與既有契約照舊），phase / kind 走新欄位另外具名。
  // stuck 秒數量不到時整個欄位不寫：task.schema.json 的 integer 欄位不收 null，
  // 硬塞會讓落檔驗不過、連 blocked 收據都寫不進去。idle 秒同理。
  // last_error 換成這一次逾時的說明：不寫的話，續跑過的任務帳上還會掛著上一棒的原因。
  const patch = { blocked_reason: 'timeout', timeout_phase: phase, timeout_kind: kind, last_error: timeoutText };
  if (stuckSec != null) {
    patch.timeout_phase_stuck_sec = stuckSec;
  }
  // 沒帶追蹤器的呼叫端量不到 span，整個欄位不寫——空字串會讓「沒量到」
  // 看起來像「量到了一條空的時間軸」。
  if (timeline) {
    patch.timeout_phase_timeline = timeline;
  }
  if (kind !== 'unknown') {
    patch.timeout_idle_sec = idleSec;
  }
  return updateTaskStatus(currentTask, 'blocked', patch);
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
    resultText = `⚠️ 任務卡住：${task.title}\n原因：${task.env_hint ? `環境問題，${task.env_hint}` : task.blocked_reason || '未知'}`;
  } else {
    resultText = `❌ 任務失敗：${task.title}\n原因：${task.error || '未知'}`;
  }
  tgRequest(process.env.TG_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: resultText }).catch(() => {});
  delete tgPendingNotify[task.id];
}

// 失敗重試時放在指令最前面的說明：講明這是第幾次嘗試，附上次留下的進度與產物路徑，
// 讓 worker 先核對已做到哪，不把做過的重做、也不把沒做完的當做完。首次嘗試回空字串，指令一字不變。
const RETRY_PROGRESS_LINES = 20;
const RETRY_PROGRESS_MAX_CHARS = 1500;

// 摘要會原樣交給 worker：先把疑似 token 的長字串遮掉（32 字以上不含空白的英數／符號串）。
function maskTokenLikeStrings(text) {
  return String(text).replace(/[A-Za-z0-9_\-+/=.:]{32,}/g, (value) => `${value.slice(0, 4)}…[masked ${value.length} chars]`);
}

function listPriorAttemptArtifacts(taskId) {
  const found = [];
  for (const [suffix] of PREVIOUS_ARTIFACT_SUFFIXES) {
    const file = path.join(ARTIFACTS_DIR, `${taskId}${suffix}`);
    if (fs.existsSync(file)) {
      found.push(file);
    }
  }
  try {
    for (const name of fs.readdirSync(taskWorkspacePath(taskId))) {
      if (name !== AGY_PROMPT_FILENAME) {
        found.push(path.join(taskWorkspacePath(taskId), name));
      }
    }
  } catch (_) {
    // workspace 還沒建就是沒有產物。
  }
  return found;
}

function buildRetryPreamble(task, attempt) {
  // /resume 放下去的那一棒 attempt 從 1 重算（重試額度要重新給），但它一樣是接在失敗的上一棒後面。
  const resumed = Number.isInteger(task.resume_count) && task.resume_count > 0;
  if (!(attempt > 1) && !resumed) {
    return '';
  }
  const progress = (readProgressLines(task.id, RETRY_PROGRESS_LINES) || []).join('\n');
  const summary = maskTokenLikeStrings(progress).slice(0, RETRY_PROGRESS_MAX_CHARS);
  const artifacts = listPriorAttemptArtifacts(task.id);
  const lastError = maskTokenLikeStrings(task.last_error || '原因未記錄');
  return [
    '## 重試說明',
    attempt > 1
      ? `這是第 ${attempt} 次嘗試（上一次失敗：${lastError}）。`
      : `這是第 ${task.resume_count} 次續跑（上一棒：${lastError}）。`,
    '先查上次已經做到哪：做過且確認完成的不要重做；上次寫了一半或沒驗過的不要當成已完成。',
    '上次進度摘要（progress 最後幾筆）：',
    summary || '（沒有進度紀錄）',
    '上次已落的產物路徑：',
    artifacts.length ? artifacts.map((file) => `- ${file}`).join('\n') : '（沒有）',
    '',
    '',
  ].join('\n');
}

function buildClaudePrompt(task, attempt = 1) {
  const systemPrompt = readTextFileIfExists(path.join(ROOT_DIR, 'CLAUDE.md'));
  const facts = readTextFileIfExists(path.join(MEMORY_DIR, 'facts.md'));
  const preferences = readTextFileIfExists(path.join(MEMORY_DIR, 'preferences.md'));

  return `${buildRetryPreamble(task, attempt)}${systemPrompt}

## 記憶
${facts}
${preferences}

## 任務
標題: ${task.title}
指令: ${task.instruction}
任務ID: ${task.id}

${buildCheckpointPromptSection(task)}

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
  safeWriteTaskFile(taskPath(task.id), nextTask);
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

// 斷點續傳：worker 每做完一步，就在自己 workspace 的 CHECKPOINT.txt 追加一行步驟名稱。
// 放在 workspace（worker 的 cwd）是因為 Claude worker 本來就能寫那裡，不用多開目錄權限；
// 一行一步、只追加：被砍在寫到一半時最多壞最後一行，前面已記下的步驟都還在。
// 任務中斷後用 POST /api/tasks/<id>/resume 重跑，同一個 workspace 的這份檔會被帶進下一棒。
const CHECKPOINT_FILENAME = 'CHECKPOINT.txt';

function checkpointPath(taskId) {
  return path.join(taskWorkspacePath(taskId), CHECKPOINT_FILENAME);
}

// 讀 checkpoint：回傳 { steps, rejected, partial }。
// - steps：已完成的步驟（去重、保留先後）；檔不在就是空陣列，等於從頭做。
// - 只採用「以換行結尾」的行：最後一行沒換行，代表上一棒寫到一半被砍，那一步不算做完（partial 記下它）。
// - 檔裡有 NUL 或 UTF-16 BOM（PS5.1 的 >>、Out-File 預設就會寫成這樣）時整份不採用，rejected 寫具名原因；
//   硬讀會讀出夾 \u0000 的亂碼，被當成「已完成步驟」交給下一棒。UTF-8 BOM 照常去掉。
function readCheckpoint(taskId) {
  const empty = { steps: [], rejected: null, partial: null };
  if (!isSafeTaskId(taskId)) {
    return empty;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(checkpointPath(taskId));
  } catch (_) {
    return empty;
  }
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    return { ...empty, rejected: 'utf16_encoding' };
  }
  if (buffer.includes(0)) {
    return { ...empty, rejected: 'nul_bytes' };
  }
  const lines = buffer.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const tail = lines.pop().trim();
  const steps = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line && !line.startsWith('#') && !steps.includes(line)) {
      steps.push(line);
    }
  }
  return { steps, rejected: null, partial: tail || null };
}

function readCheckpointSteps(taskId) {
  return readCheckpoint(taskId).steps;
}

// 續跑時把上一棒留下的產出改名放旁邊：done 的判定只看結果檔在不在，
// 舊的半成品留在原位的話，下一棒什麼都沒做、exit 0 也會被當成完成。
const PREVIOUS_ARTIFACT_SUFFIXES = [
  ['.result.md', '.result.prev.md'],
  ['.result.json', '.result.prev.json'],
];

function previousArtifactPath(taskId, prevSuffix = '.result.prev.md') {
  return path.join(ARTIFACTS_DIR, `${taskId}${prevSuffix}`);
}

function setAsidePreviousArtifacts(taskId) {
  const moved = [];
  for (const [suffix, prevSuffix] of PREVIOUS_ARTIFACT_SUFFIXES) {
    const current = path.join(ARTIFACTS_DIR, `${taskId}${suffix}`);
    if (!fs.existsSync(current)) {
      continue;
    }
    const previous = previousArtifactPath(taskId, prevSuffix);
    fs.renameSync(current, previous);
    moved.push(previous);
  }
  return moved;
}

function buildCheckpointPromptSection(task) {
  const lines = [
    '## 斷點續傳',
    `每做完一個步驟，就在 ${checkpointPath(task.id)} 追加一行，寫那個步驟的名稱（一行一步，每行結尾要換行，不要改舊的行）。`,
  ];
  const steps = readCheckpointSteps(task.id);
  if (steps.length) {
    lines.push('這是中斷後接續的一棒。下面這些步驟上一棒已經做完，不要重做，從還沒做的地方接著做：');
    for (const step of steps) {
      lines.push(`- ${step}`);
    }
  }
  const previous = previousArtifactPath(task.id);
  if (fs.existsSync(previous)) {
    lines.push(`上一棒留下的結果檔（可能沒寫完）已改名為 ${previous}，可以參考；這一棒要把完整結果重新寫到下面的結果路徑。`);
  }
  return lines.join('\n');
}

// worker 失敗時先判斷是不是「環境」的問題：登入過期、找不到 worker 程式、權限不足、網路不通。
// 這幾種重跑同一棒也不會好（網路除外），而且要人去修的是機器，不是任務本身；
// 跟任務自己做錯混在 failed 裡，看帳的人會去改任務內容，白忙一場。
// 只看 worker 非 0 退出（或根本起不來）時的輸出；exit 0 沒產出那條不判，那是任務層的事。
//
// 規則一律錨在「行首」的錯誤形狀（CLI／系統自己印的錯誤開頭），不做整段字串的任意比對：
// worker 的輸出裡常有任務本身的內容（agy 的 stdout 就是模型的回答），
// 「the deploy script fails with 'permission denied'」這種句子不能被當成機器的權限問題。
// 判定時逐行看，第一個「像錯誤的行」說了算：先出現的是一般程式錯誤（TypeError、RangeError…），
// 就不是環境問題，照一般失敗流程走；見 classifyEnvFailure。
const ENV_FAILURE_RULES = [
  {
    cause: 'missing_tool',
    retryable: false,
    hint: '找不到 worker 程式：確認 CLI 已安裝、在 PATH 上，或把 CLAUDE_CMD／AGY_CMD 設成完整路徑',
    pattern: /^'[^']+' is not recognized as an internal or external command|^'[^']+' 不是內部或外部命令|: command not found$|^The system cannot find the path specified\.?$|not found in PATH\.?$/i,
  },
  {
    cause: 'auth',
    retryable: false,
    hint: '登入過期或金鑰無效：重新登入 worker CLI（例如在終端機跑 claude 再 /login）或更新金鑰，再續跑這個任務',
    pattern: /^(?:Error: )?Failed to authenticate\b|^API Error: 401\b|^API Error: .*authentication_error|^(?:Error: )?Invalid[ _-]?(?:x-)?api[ _-]?key\b|^(?:Error: )?(?:OAuth token (?:has )?expired|token has expired)|^(?:Error: )?not logged in\b/i,
  },
  {
    cause: 'permission',
    retryable: false,
    hint: '權限不足：worker 讀寫檔案或執行時被系統擋下，檢查資料夾權限或防毒／安全軟體設定',
    pattern: /^(?:Error: )?(?:EACCES|EPERM)\b|^(?:Error: )?(?:spawn \S+ )?(?:EACCES|EPERM)$|^Access is denied\.?$|: permission denied$|^存取被拒/i,
  },
  {
    cause: 'network',
    retryable: true,
    hint: '網路不通：worker 連不到服務端，檢查網路、代理或防火牆設定',
    pattern: /^(?:\w*Error: )?(?:connect |read |write |getaddrinfo )?(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|^API Error: Connection error\b|^(?:TypeError: )?fetch failed$|^(?:Error: )?socket hang up$|^(?:Error: )?network is unreachable\b|^curl: \(\d+\) Could not resolve host\b/i,
  },
];

// 「像錯誤的行」：Node／JS 的錯誤標頭（TypeError: …、Error: …、xxxException）與常見 CLI 的 fatal／error 開頭。
// 第一個出現的錯誤行若不是環境規則認得的，整次失敗就不算環境問題。
const ERROR_HEADER_PATTERN = /^(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\b|^API Error:|^(?:fatal|panic|error)\b[:\s]/;
// stdout 只看最後這幾行：CLI 自己的錯誤訊息在最後，前面多半是任務內容。
const ENV_STDOUT_TAIL_LINES = 20;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function envFailureOf(cause) {
  const rule = ENV_FAILURE_RULES.find((entry) => entry.cause === cause);
  return { cause: rule.cause, retryable: rule.retryable, hint: rule.hint };
}

// 回傳 { cause, retryable, hint } 或 null（null＝不是環境問題，照原本的失敗流程走）。
// output 可以是字串（整段當 stderr 看），或 { stderr, stdout }：stderr 整段看、stdout 只看最後幾行，
// 而且 stderr 的行排在前面——worker 自己的崩潰訊息優先於它印出來的任務內容。
function classifyEnvFailure(output, { spawnError = null, command = '' } = {}) {
  const errorCode = spawnError && spawnError.code;
  if (errorCode === 'ENOENT') {
    return envFailureOf('missing_tool');
  }
  if (errorCode === 'EACCES' || errorCode === 'EPERM') {
    return envFailureOf('permission');
  }
  const streams = output && typeof output === 'object' ? output : { stderr: output, stdout: '' };
  const stdoutTail = String(streams.stdout || '').split(/\r?\n/).filter((line) => line.trim()).slice(-ENV_STDOUT_TAIL_LINES);
  const lines = [
    ...(spawnError ? String(spawnError.message).split(/\r?\n/) : []),
    ...String(streams.stderr || '').split(/\r?\n/),
    ...stdoutTail,
  ]
    .map((line) => line.trim())
    .filter(Boolean);
  // Windows 的 cmd 找不到指令時，訊息跟著系統語系走（中文版在管道裡還會是亂碼），
  // 但開頭一定是用單引號包起來的指令名稱，這個形狀不受語系影響。
  const commandShape = command ? new RegExp(`^'${escapeRegExp(String(command).replace(/^"|"$/g, ''))}' `) : null;
  for (const line of lines) {
    if (commandShape && commandShape.test(line)) {
      return envFailureOf('missing_tool');
    }
    const rule = ENV_FAILURE_RULES.find((entry) => entry.pattern.test(line));
    if (rule) {
      return envFailureOf(rule.cause);
    }
    if (ERROR_HEADER_PATTERN.test(line)) {
      return null;
    }
  }
  return null;
}

// spawn 前先確認 worker 指令找得到。CLAUDE_CMD 設成打錯的完整路徑時，Windows 的 cmd.exe
// 回的是跟著語系走的錯誤字（中文版在管道裡是亂碼、含空白的路徑還會被切斷），靠錯誤字判不出來；
// 所以含路徑分隔符的就直接看檔案在不在，裸指令名就照 cmd／shell 的規則在 PATH（Windows 再加 PATHEXT 與 cwd）上找。
// 只回答「找不找得到」；找得到但跑不起來的，照舊交給 spawn 的錯誤與 classifyEnvFailure。
function workerCommandExists(command, cwd = ROOT_DIR) {
  const name = String(command || '').trim().replace(/^"(.*)"$/, '$1');
  if (!name) {
    return false;
  }
  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  const isFile = (candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  };
  const existsWithExtensions = (base) => extensions.some((ext) => isFile(`${base}${ext}`));
  if (/[\\/]/.test(name) || path.isAbsolute(name)) {
    return existsWithExtensions(path.resolve(cwd, name));
  }
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  if (isWindows) {
    dirs.unshift(cwd);
  }
  return dirs.some((dir) => existsWithExtensions(path.join(dir, name)));
}

// 環境問題的收尾：能重試的（網路）先交回一般 retry；其餘直接停成 blocked，
// 不燒重試額度、不算任務失敗。回傳 true＝已經處理掉，呼叫端不要再往下走。
function settleEnvFailure(currentTask, failureReason, envFailure, attempt) {
  if (!envFailure || (envFailure.retryable && attempt <= MAX_TASK_RETRIES)) {
    return false;
  }
  appendProgressText(currentTask.id, `Environment problem (${envFailure.cause}): ${envFailure.hint}`);
  const blockedTask = updateTaskStatus(currentTask, 'blocked', {
    blocked_reason: 'environment',
    env_cause: envFailure.cause,
    env_hint: envFailure.hint,
    last_error: failureReason,
    retry_count: attempt - 1,
  });
  notifyTelegramTaskDone(blockedTask);
  return true;
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
  const fullPrompt = buildClaudePrompt(task, attempt);
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
  if (!workerCommandExists(claudeCmd, workerCwd)) {
    settleEnvFailure(runningTask, `worker command not found: ${claudeCmd}`, envFailureOf('missing_tool'), attempt);
    return;
  }
  const phaseTracker = createWorkerPhaseTracker('spawn');
  appendProgressText(task.id, `Claude spawn args=${JSON.stringify(args)} cwd=${workerCwd}`);
  const child = spawnClaudeProcess(claudeCmd, args, { cwd: workerCwd });
  trackWorker(task.id, child);
  let spawnError = null;
  let stderr = '';
  let stdout = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const blockedTask = markTaskBlockedByTimeout(task.id, runningTask, phaseTracker);
    if (blockedTask) {
      notifyTelegramTaskDone(blockedTask);
    }
    // Windows 上 child 是包在外面的 cmd.exe，只殺它的話真正的 worker 會留下來繼續寫同一個 workspace。
    killProcessTree(child);
  }, timeoutMs);

  pipeStdoutProgress(task.id, child.stdout);
  // headless 棒「內部錯誤後無輸出地掛住」時，stdout/stderr 兩邊都是空的；
  // 不留 stdout 就無法把「全程沒講過話」跟「講了話但沒寫產物」分成兩個具名 cause。
  child.stdout.on('data', (chunk) => {
    // 收到第一個位元組就換 phase：之後再逾時，就是「講過話但停住」而不是「從沒講過話」。
    phaseTracker.enter('streaming');
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    phaseTracker.enter('streaming');
    stderr += chunk;
  });

  child.on('error', (error) => {
    spawnError = error;
  });

  child.stdin.on('error', (error) => {
    stderr += `\nstdin error: ${error.message}`;
  });
  child.stdin.end(fullPrompt);
  // prompt 已交出去：卡在這裡代表對面收了題目但一個字都還沒回。
  phaseTracker.enter('prompt_sent');

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (timedOut) {
      return;
    }
    // `|| runningTask` 原本只接得住「檔不見了」；檔還在但壞掉時 readTask 是拋的，
    // 整條失敗判定（含 retry 與 failed 收據）會被那一拋整段跳過。
    const currentTask = readTaskSafely(task.id, 'claude worker close') || runningTask;

    let failureReason = null;
    if (spawnError) {
      failureReason = spawnError.message;
    } else if (code !== 0) {
      const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
      // stderr 空的時候，光一句 `exited with code 1` 不算具名；先退 stdout 尾巴，
      // 兩邊都空就明講「兩條管道都沒輸出」，別讓帳上只剩一個數字。
      const tail = stderr.trim().slice(-1000) || stdout.trim().slice(-1000);
      failureReason = `Claude exited with ${exitReason}: ${tail || 'no stderr or stdout output'}`;
    } else if (!fs.existsSync(artifactResultPath(task.id))) {
      failureReason = stdout.trim()
        ? 'no artifact produced'
        : 'headless worker exited 0 with no output and no artifact (silent internal error)';
    }

    if (!failureReason) {
      const doneTask = updateTaskStatus(currentTask, 'done', { artifact_path: artifactResultRef(task.id) });
      notifyTelegramTaskDone(doneTask);
      return;
    }

    // 環境問題（登入、找不到程式、權限、網路）先分出來：不算任務失敗，停成 blocked 讓人去修機器。
    const envFailure =
      spawnError || code !== 0
        ? classifyEnvFailure({ stderr: stderr.slice(-4000), stdout: stdout.slice(-4000) }, { spawnError, command: claudeCmd })
        : null;
    if (settleEnvFailure(currentTask, failureReason, envFailure, attempt)) {
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
        spawnClaudeWorker(readTaskSafely(task.id, 'retry respawn') || currentTask, attempt + 1);
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

// Antigravity CLI（agy）插槽：預設關閉，AIWFF_WORKER_PROVIDER=agy 才啟用（ENABLE_AGY_WORKER=1 為舊名相容）。
function shouldUseAgyWorker() {
  if (envFlag('MOCK_WORKER')) {
    return false;
  }
  const provider = String(process.env.AIWFF_WORKER_PROVIDER || '').trim().toLowerCase();
  return provider === 'agy' || envFlag('ENABLE_AGY_WORKER');
}

const AGY_PROMPT_FILENAME = 'AGY_PROMPT.md';

// 完整 prompt（CLAUDE.md＋記憶＋任務）可能超過 Windows 命令列 32767 字上限，
// 所以整段寫進 workspace 的檔案，-p 只放一句「讀這個檔照做」。
function buildAgyArgs(promptFilePath) {
  const args = [];
  if (envFlag('AGY_SKIP_PERMISSIONS')) {
    args.push('--dangerously-skip-permissions');
  }
  const model = String(process.env.AGY_MODEL || '').trim();
  if (model) {
    args.push('--model', model);
  }
  args.push('--add-dir', ARTIFACTS_DIR);
  args.push(
    '-p',
    `Read the file ${promptFilePath} and carry out the instructions in it exactly. Its contents are the full task.`,
  );
  return args;
}

function writeAgyPromptFile(task, workerCwd, attempt = 1) {
  const promptFilePath = path.join(workerCwd, AGY_PROMPT_FILENAME);
  fs.writeFileSync(promptFilePath, buildClaudePrompt(task, attempt), 'utf8');
  return promptFilePath;
}

// 每個任務目前還活著的 worker 行程。逾時只是把帳標成 blocked，行程本身要等 close（stdio 全關）才算真的結束；
// 續跑前看這張表和 workspace 裡的 WORKER.pid，上一棒還沒結束就不放下一棒，
// 免得兩棒在同一個 workspace 並行、把已記進 CHECKPOINT 的步驟再做一次。
// WORKER.pid 是給「runtime 重啟過、記憶體裡的表已經沒了」那種情況用的：舊 runtime 的 worker 可能還活著。
const liveWorkers = new Map();
const WORKER_PID_FILENAME = 'WORKER.pid';

function workerPidPath(taskId) {
  return path.join(taskWorkspacePath(taskId), WORKER_PID_FILENAME);
}

function trackWorker(taskId, child) {
  if (!child || !child.pid) {
    return;
  }
  liveWorkers.set(taskId, child);
  try {
    fs.mkdirSync(taskWorkspacePath(taskId), { recursive: true });
    fs.writeFileSync(workerPidPath(taskId), `${child.pid}\n`);
  } catch (error) {
    logStderr(`worker pid file write failed (${taskId})`, error);
  }
  child.once('close', () => {
    if (liveWorkers.get(taskId) !== child) {
      return;
    }
    liveWorkers.delete(taskId);
    try {
      fs.rmSync(workerPidPath(taskId), { force: true });
    } catch (error) {
      logStderr(`worker pid file remove failed (${taskId})`, error);
    }
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// 回傳上一棒還活著的 pid；沒有就回 null。
function liveWorkerPid(taskId) {
  const child = liveWorkers.get(taskId);
  if (child) {
    return child.pid;
  }
  let raw;
  try {
    raw = fs.readFileSync(workerPidPath(taskId), 'utf8');
  } catch (_) {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return null;
  }
  return isPidAlive(pid) ? pid : null;
}

// child.kill() 在 Windows 只殺最上層行程，agy 生出的子行程會變孤兒；逾時要殺整棵樹。
function killProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill();
}

function spawnAgyWorker(task, attempt = 1) {
  ensureDirectories();
  const agyCmd = process.env.AGY_CMD || 'agy';
  const runningTask = updateTaskStatus(task, 'running');
  const timeoutMs = normalizeWorkerTimeoutSec(task) * 1000;
  const workerCwd = taskWorkspacePath(task.id);
  fs.mkdirSync(workerCwd, { recursive: true });
  const args = buildAgyArgs(writeAgyPromptFile(task, workerCwd, attempt));
  if (envFlag('AGY_SKIP_PERMISSIONS')) {
    const warning = 'SECURITY WARNING: agy worker is running with --dangerously-skip-permissions (AGY_SKIP_PERMISSIONS=1).';
    logStderr(warning, `task=${task.id}`);
    appendProgressText(task.id, warning);
  }

  if (!workerCommandExists(agyCmd, workerCwd)) {
    settleEnvFailure(runningTask, `worker command not found: ${agyCmd}`, envFailureOf('missing_tool'), attempt);
    return;
  }

  const phaseTracker = createWorkerPhaseTracker('spawn');
  appendProgressText(task.id, `AGY spawn args=${JSON.stringify(args)} cwd=${workerCwd}`);

  const child = spawn(agyCmd, args, {
    cwd: workerCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trackWorker(task.id, child);

  let spawnError = null;
  let stderr = '';
  let stdout = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const blockedTask = markTaskBlockedByTimeout(task.id, runningTask, phaseTracker);
    if (blockedTask) {
      notifyTelegramTaskDone(blockedTask);
    }
    killProcessTree(child);
  }, timeoutMs);

  pipeStdoutProgress(task.id, child.stdout);
  child.stdout.on('data', (chunk) => {
    phaseTracker.enter('streaming');
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    phaseTracker.enter('streaming');
    stderr += chunk;
  });

  child.on('error', (error) => {
    spawnError = error;
  });

  phaseTracker.enter('prompt_sent');

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (timedOut) {
      return;
    }
    const currentTask = readTaskSafely(task.id, 'agy worker close') || runningTask;
    const artifactPath = artifactResultPath(task.id);

    // agy 有時只把答案印在 stdout、沒自己寫檔；exit 0 時用 stdout 補成 artifact。
    if (!spawnError && code === 0 && !fs.existsSync(artifactPath) && stdout.trim()) {
      try {
        fs.writeFileSync(artifactPath, `${stdout.trim()}\n`, 'utf8');
      } catch (err) {
        logStderr('failed to write agy fallback artifact', err);
      }
    }

    let failureReason = null;
    if (spawnError) {
      failureReason = spawnError.message;
    } else if (code !== 0) {
      const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
      const tail = stderr.trim().slice(-1000) || stdout.trim().slice(-1000);
      failureReason = `AGY exited with ${exitReason}: ${tail || 'no stderr or stdout output'}`;
    } else if (!fs.existsSync(artifactPath)) {
      failureReason = 'headless agy exited 0 with no output and no artifact';
    }

    if (!failureReason) {
      const doneTask = updateTaskStatus(currentTask, 'done', { artifact_path: artifactResultRef(task.id) });
      notifyTelegramTaskDone(doneTask);
      return;
    }

    const envFailure =
      spawnError || code !== 0
        ? classifyEnvFailure({ stderr: stderr.slice(-4000), stdout: stdout.slice(-4000) }, { spawnError, command: agyCmd })
        : null;
    if (settleEnvFailure(currentTask, failureReason, envFailure, attempt)) {
      return;
    }

    if (attempt <= MAX_TASK_RETRIES) {
      appendProgressText(
        task.id,
        `Worker attempt ${attempt} failed (${failureReason}); retrying (${attempt}/${MAX_TASK_RETRIES}) in ${RETRY_BACKOFF_MS}ms`,
      );
      updateTaskStatus(currentTask, 'running', { retry_count: attempt, last_error: failureReason });
      setTimeout(() => {
        spawnAgyWorker(readTaskSafely(task.id, 'retry respawn') || currentTask, attempt + 1);
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

function buildOpenAICompatibleMessages(task, attempt = 1) {
  const facts = readTextFileIfExists(path.join(MEMORY_DIR, 'facts.md'));
  const preferences = readTextFileIfExists(path.join(MEMORY_DIR, 'preferences.md'));
  return [
    {
      role: 'system',
      content: `你是用戶的本地 AI 助理。這條路徑沒有工具可用，請直接輸出任務結果本身。\n\n## 記憶\n${facts}\n${preferences}`.trim(),
    },
    { role: 'user', content: `${buildRetryPreamble(task, attempt)}標題: ${task.title}\n指令: ${task.instruction}` },
  ];
}

// messages 不給就用任務版；聊天模式傳自己的 messages（同一條無工具、單次 completion 路徑）。
async function requestOpenAICompatibleCompletion(task, timeoutMs, messages = buildOpenAICompatibleMessages(task)) {
  const config = openAICompatibleConfig();
  if (!config.baseUrl || !config.model) {
    throw Object.assign(new Error('AIWFF_OPENAI_BASE_URL and AIWFF_OPENAI_MODEL are required when AIWFF_WORKER_PROVIDER=openai_compatible'), { retryable: false });
  }
  // 帶上 task_id，讓 gateway／代理能把同一個任務的多次往返（含 retry）分成一組計算。
  const headers = { 'content-type': 'application/json', 'x-aiwff-task-id': String(task.id) };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`), {
      status: response.status,
      retryable: !(response.status >= 400 && response.status < 500) || response.status === 408 || response.status === 429,
    });
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

  requestOpenAICompatibleCompletion(task, normalizeWorkerTimeoutSec(task) * 1000, buildOpenAICompatibleMessages(task, attempt))
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
      if (error?.retryable !== false && attempt <= MAX_TASK_RETRIES) {
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
  if (shouldUseAgyWorker()) {
    spawnAgyWorker(task);
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

  // 建檔這一路徑沿用原本「寫不成就拋」的語意：任務根本沒落檔就不該把 worker 放出去。
  const violation = taskSchemaViolation(task);
  if (violation) {
    throw new Error(`task schema violation at create: ${violation}`);
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

// 斷點續傳的入口：卡住（逾時、runtime 重啟中斷）或失敗的任務，用同一個 id 再跑一棒。
// 同一個 workspace 和 CHECKPOINT.txt 會被帶進下一棒，prompt 會列出已完成的步驟要它別重做。
// 上一棒的收據欄位（逾時細節、error）在重跑前清掉，免得新的一棒做完後帳上還掛著舊原因；
// 舊原因留在 last_error，resume_count 記第幾次續跑。
const RESUMABLE_STATUSES = new Set(['blocked', 'failed']);
const RUN_RECEIPT_FIELDS = [
  'error',
  'blocked_reason',
  'timeout_phase',
  'timeout_phase_stuck_sec',
  'timeout_phase_timeline',
  'timeout_kind',
  'timeout_idle_sec',
  'retry_count',
  'env_cause',
  'env_hint',
  'error_origin',
];
// last_error 只留最近一次的原因（第幾次續跑看 resume_count），而且限長，不會一棒一棒越包越長。
const MAX_RESUME_REASON_CHARS = 500;
// 續跑的煞車：主判準是進展。每次續跑記下當下 checkpoint 去重步數（resume_checkpoint_steps），
// 下一次續跑時步數沒增加就把 resume_no_progress_count 加 1，連續 NO_PROGRESS_LIMIT 次沒增加回 409 no_progress。
// 第一次續跑沒有基準，不算；從沒寫過 checkpoint 的 task 也不算（見 resumeTask）。
// MAX_TASK_RESUMES 是寬鬆的最後保險，給「每棒都多記一步、卻永遠做不完」和「根本不寫 checkpoint」的情況。
const NO_PROGRESS_LIMIT = 2;
const MAX_TASK_RESUMES = envInt('MAX_TASK_RESUMES', 20, { min: 1, max: 1000 });

function resumeRefusal(statusCode, cause, error, extra = {}) {
  return { statusCode, payload: { ok: false, cause, error, ...extra } };
}

function resumeTask(taskId) {
  if (!isUuidTaskId(taskId)) {
    return { statusCode: 400, payload: { ok: false, error: 'invalid task id' } };
  }
  let task;
  try {
    task = readTask(taskId);
  } catch (error) {
    // 檔在但讀不動：清單上會顯示成「任務檔無法讀取」，這裡不能回「找不到任務」。
    logStderr(`resume refused, task file unreadable (${taskId})`, error);
    return resumeRefusal(409, 'task_file_unreadable', `任務檔讀不動，不能續跑：${error.message}`);
  }
  if (!task) {
    return { statusCode: 404, payload: { ok: false, error: '找不到任務' } };
  }
  if (!RESUMABLE_STATUSES.has(task.status)) {
    return {
      statusCode: 409,
      payload: { ok: false, error: `status=${task.status} 不能續跑；只有 blocked 或 failed 的任務可以續跑`, status: task.status },
    };
  }
  // 上一棒（逾時被砍中、或舊 runtime 留下的）還沒真的結束就不放下一棒：兩棒會在同一個 workspace 並行。
  const alivePid = liveWorkerPid(taskId);
  if (alivePid) {
    return resumeRefusal(
      409,
      'previous_worker_alive',
      `上一棒 worker（pid ${alivePid}）還沒結束，等它結束再續跑；確定那個 pid 已經不是這個任務的 worker，可以刪掉 ${workerPidPath(taskId)}`,
      { pid: alivePid },
    );
  }
  const resumeCount = Number.isInteger(task.resume_count) ? task.resume_count : 0;
  if (resumeCount >= MAX_TASK_RESUMES) {
    return resumeRefusal(
      409,
      'max_resumes',
      `已續跑 ${resumeCount} 次，到上限 ${MAX_TASK_RESUMES}（MAX_TASK_RESUMES），不再續跑；請檢查任務本身或拆小再重開`,
      { resume_count: resumeCount, max_resumes: MAX_TASK_RESUMES },
    );
  }
  const checkpoint = readCheckpoint(taskId);
  const steps = checkpoint.steps;
  // 從沒寫過 checkpoint 的 worker（例如 OpenAI 相容那條）步數恆為 0，用步數判進展會誤擋正常長任務；
  // 這種 task 只套 MAX_TASK_RESUMES。曾經出現過步數 >0（現在或上次續跑記下的）才套 no_progress。
  const everCheckpointed = steps.length > 0 || task.resume_checkpoint_steps > 0;
  let noProgressCount = 0;
  if (everCheckpointed && Number.isInteger(task.resume_checkpoint_steps) && steps.length <= task.resume_checkpoint_steps) {
    noProgressCount = (Number.isInteger(task.resume_no_progress_count) ? task.resume_no_progress_count : 0) + 1;
  }
  if (noProgressCount >= NO_PROGRESS_LIMIT) {
    return resumeRefusal(
      409,
      'no_progress',
      `連續 ${noProgressCount} 次續跑 checkpoint 步數都沒增加（停在 ${steps.length} 步），不再續跑；請檢查 worker 為什麼沒有往下做`,
      { checkpoint_steps: steps.length, no_progress_count: noProgressCount },
    );
  }
  const lastError = typeof task.last_error === 'string' && !task.last_error.startsWith('resumed after ') ? task.last_error : '';
  const previousReason = (
    task.blocked_reason
      ? `blocked: ${task.blocked_reason}${lastError ? ` (${lastError})` : ''}`
      : `failed: ${task.error || lastError || 'unknown'}`
  ).slice(0, MAX_RESUME_REASON_CHARS);
  const next = { ...task };
  for (const field of RUN_RECEIPT_FIELDS) {
    delete next[field];
  }
  next.last_error = `resumed after ${previousReason}`;
  next.resume_count = resumeCount + 1;
  next.resume_checkpoint_steps = steps.length;
  next.resume_no_progress_count = noProgressCount;
  const pendingTask = { ...next, status: 'pending', updated_at: nowIso() };
  // 先確認寫得回去才放 worker：寫不成的話磁碟上還是 blocked／failed，worker 的結果也寫不回來，
  // 而且 409 防重入失效（連發兩次就是兩棒並行）。做法跟 createTaskObject 一樣，寫不成就不放。
  const violation = taskSchemaViolation(pendingTask);
  if (violation) {
    logStderr(`resume refused, task file rejected by schema (${taskId})`, violation);
    return resumeRefusal(409, 'task_file_rejected', `任務檔有這一版不認得或不合規的內容（${violation}），寫不回去，不能續跑`, {
      detail: violation,
    });
  }
  let movedArtifacts;
  try {
    movedArtifacts = setAsidePreviousArtifacts(taskId);
  } catch (error) {
    logStderr(`resume refused, previous artifact could not be set aside (${taskId})`, error);
    return resumeRefusal(500, 'artifact_set_aside_failed', `上一棒的結果檔改名失敗，不能續跑：${error.message}`);
  }
  if (!safeWriteJsonFile(taskPath(taskId), pendingTask)) {
    return resumeRefusal(500, 'task_write_failed', '任務狀態寫不進去，不能續跑');
  }
  appendProgressText(
    taskId,
    `Resume #${pendingTask.resume_count}: ${steps.length} checkpoint step(s) carried over${steps.length ? ` (${steps.join(', ')})` : ''}`,
  );
  if (checkpoint.rejected) {
    appendProgressText(taskId, `Checkpoint ignored (${checkpoint.rejected}): ${checkpointPath(taskId)} is not plain UTF-8 text; this run starts from the first step`);
  }
  if (checkpoint.partial) {
    appendProgressText(taskId, `Checkpoint last line has no line ending, treated as unfinished: ${checkpoint.partial}`);
  }
  for (const moved of movedArtifacts) {
    appendProgressText(taskId, `Previous run's artifact set aside: ${moved}`);
  }
  startTaskWorker(pendingTask);
  return { statusCode: 202, payload: { ok: true, task: pendingTask, checkpoint_steps: steps } };
}

// ── 聊天模式 ──────────────────────────────────────────────
// AIWFF_MODE：task（預設）＝每則訊息都建任務，跟加聊天模式前一樣；
// both＝一般訊息直接回答、明確要做事或 /task 才建任務；chat＝只聊天。
// 未設或值不認得一律當 task，聊天要使用者自己設 both 或 chat。
function runtimeChatMode() {
  return normalizeChatMode(process.env.AIWFF_MODE);
}

// doctor 的 chat_mode：provider 不支援聊天（agy）、又設了 both 或 chat 時標 ok:false。
function chatModeCheck() {
  const mode = runtimeChatMode();
  const raw = String(process.env.AIWFF_MODE || '').trim();
  const unsupported = chatBackend() === 'unsupported';
  if (unsupported && mode !== 'task') {
    return {
      ok: false,
      detail: `${mode}（這個 worker provider 不支援聊天，一般訊息會回錯誤；改設 AIWFF_MODE=task 或換 provider）`,
    };
  }
  if (!raw) {
    return { ok: true, detail: `${mode}（AIWFF_MODE 未設，用預設）` };
  }
  if (raw.toLowerCase() !== mode) {
    return { ok: true, detail: `${mode}（AIWFF_MODE=${raw.slice(0, 40)} 不認得，用預設）` };
  }
  return { ok: true, detail: mode };
}

// 聊天用哪一條模型路徑：順序跟 startTaskWorker 一致。agy 在 v0 沒有聊天路徑，具名回報。
function chatBackend() {
  if (shouldUseOpenAICompatibleWorker()) {
    return 'openai_compatible';
  }
  if (shouldUseAgyWorker()) {
    return 'unsupported';
  }
  return shouldUseMockWorker() ? 'mock' : 'claude';
}

function chatSystemPrompt() {
  const facts = readTextFileIfExists(path.join(MEMORY_DIR, 'facts.md'));
  const preferences = readTextFileIfExists(path.join(MEMORY_DIR, 'preferences.md'));
  return `你是用戶的本地 AI 助理，現在是聊天模式：直接回答用戶這一則訊息。
這條路徑沒有工具、不能讀寫檔案，也不會建立任務；不要假裝做了任何事。用戶要你動手做事時，請他改用 /task 開頭。

## 記憶
${facts}
${preferences}`.trim();
}

// 唯讀、無工具、單輪：--tools "" 關掉全部內建工具、不載 MCP、不存 session；
// 不帶 --add-dir，也不吃 CLAUDE_BYPASS_APPROVALS（聊天永遠不跳過權限）。
function buildClaudeChatArgs() {
  return ['--print', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--no-session-persistence'];
}

function runClaudeChat(text) {
  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const prompt = `${chatSystemPrompt()}\n\n## 訊息\n${text}\n`;
  return new Promise((resolve, reject) => {
    // cwd 放系統暫存目錄：不在 repo 裡，也就不會載入任務用的 CLAUDE.md（那份要求「動手執行」）。
    const child = spawnClaudeProcess(claudeCmd, buildClaudeChatArgs(), { cwd: os.tmpdir() });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(Object.assign(new Error(`chat reply timed out after ${CHAT_TIMEOUT_MS / 1000}s`), { code: 'chat_timeout' }));
    }, CHAT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CHAT_REPLY_CHARS * 2) {
        stdout += chunk;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', (error) => finish(error));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
        const tail = stderr.trim().slice(-500) || stdout.trim().slice(-500);
        finish(new Error(`Claude chat exited with ${exitReason}: ${tail || 'no stderr or stdout output'}`));
        return;
      }
      const reply = stdout.trim();
      if (!reply) {
        finish(new Error('Claude chat exited 0 with an empty reply'));
        return;
      }
      finish(null, reply);
    });
  });
}

async function generateChatReply(text) {
  const backend = chatBackend();
  const startedAt = Date.now();
  let reply;
  if (backend === 'mock') {
    reply = MOCK_CHAT_REPLY;
  } else if (backend === 'openai_compatible') {
    const chatId = `chat-${crypto.randomUUID()}`;
    const messages = [
      { role: 'system', content: chatSystemPrompt() },
      { role: 'user', content: text },
    ];
    reply = (await requestOpenAICompatibleCompletion({ id: chatId }, CHAT_TIMEOUT_MS, messages)).trim();
  } else if (backend === 'claude') {
    reply = await runClaudeChat(text);
  } else {
    throw Object.assign(new Error('chat mode is not available for this worker provider yet; use /task to create a task'), {
      code: 'chat_unsupported_provider',
    });
  }
  if (reply.length > MAX_CHAT_REPLY_CHARS) {
    reply = `${reply.slice(0, MAX_CHAT_REPLY_CHARS)}\n…（回答過長，已截斷）`;
  }
  return { reply, backend, elapsed_ms: Date.now() - startedAt };
}

function commandReplyText(command, mode) {
  if (command === '/start') {
    if (mode === 'task') {
      return '主腦已上線。傳任何指令給我，我會自主執行。';
    }
    if (mode === 'chat') {
      return '主腦已上線（只聊天模式）。直接傳訊息給我就好。';
    }
    return '主腦已上線。直接聊天就好；要我動手做事，用 /task 開頭。';
  }
  if (command === '/tasks') {
    const tasks = listTasks().slice(0, 5);
    return tasks.map((task) => `[${task.status}] ${task.title}`).join('\n') || '（無任務）';
  }
  // /help
  const lines = [`目前模式：${mode}`];
  if (mode === 'task') {
    lines.push('每則訊息都會建成任務。', '/tasks 看最近 5 筆任務');
  } else if (mode === 'chat') {
    lines.push('直接傳訊息就會回答，不建任務。', '/tasks 看最近 5 筆任務');
  } else {
    lines.push(
      '直接傳訊息就會回答。',
      '/task <內容>：建任務，讓我動手做',
      '/chat <內容>：強制只聊天（例如「幫我…」開頭但只想聊）',
      '「幫我…」「寫一個…」這類明確要做事、又不是問句的訊息，會自動建任務。',
      '/tasks 看最近 5 筆任務',
    );
  }
  return lines.join('\n');
}

function taskCreatedReplyText(task, title, hint) {
  const lines = [`✅ 收到，任務建立：${title}`, `ID: ${task.id.slice(0, 8)}...`, '執行中，完成後通知你。'];
  if (hint) {
    lines.push(CHAT_TASK_HINT);
  }
  return lines.join('\n');
}

// TG、POST /api/chat、webui 對話框共用：依 AIWFF_MODE 路由，回 { ok, kind, mode, reply, ... }。
// 聊天模型呼叫失敗會拋（由各入口轉成自己的錯誤回覆）；判成任務才會寫 data/tasks。
async function handleConversationMessage(rawText) {
  const text = String(rawText || '').trim();
  const mode = runtimeChatMode();
  const routed = routeConversationMessage(text, mode);

  if (routed.kind === 'command') {
    return { ok: true, kind: 'command', mode, command: routed.instruction, reply: commandReplyText(routed.instruction, mode) };
  }

  if (routed.kind === 'task') {
    if (!routed.instruction) {
      return { ok: true, kind: 'usage', mode, reply: '用法：/task <要我做的事>' };
    }
    const title = routed.instruction.split(/\r?\n/)[0].slice(0, 60);
    const task = createTaskFromTg({ title, instruction: routed.instruction });
    return {
      ok: true,
      kind: 'task',
      mode,
      task,
      auto_detected: Boolean(routed.hint),
      hint: routed.hint ? CHAT_TASK_HINT : null,
      reply: taskCreatedReplyText(task, title, routed.hint),
    };
  }

  if (routed.notice === 'task_disabled') {
    return { ok: true, kind: 'chat', mode, notice: 'task_disabled', reply: '此安裝只開聊天模式（AIWFF_MODE=chat），不建任務；直接傳訊息就好。' };
  }
  if (!routed.instruction) {
    return { ok: true, kind: 'usage', mode, reply: '用法：/chat <想聊的內容>' };
  }
  const result = await generateChatReply(routed.instruction);
  return { ok: true, kind: 'chat', mode, reply: result.reply, backend: result.backend, elapsed_ms: result.elapsed_ms };
}

async function handleChatRequest(req, res) {
  let payload;
  try {
    const rawBody = await readBody(req);
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `Invalid JSON: ${error.message}` });
    return;
  }
  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    sendJson(res, 400, { ok: false, error: 'text is required' });
    return;
  }
  // 8000 字上限只管會送進聊天模型的訊息；判成任務的沿用 POST /api/tasks 的上限（readBody 1MB）。
  if (text.length > MAX_CHAT_INPUT_CHARS && routeConversationMessage(text, runtimeChatMode()).kind === 'chat') {
    sendJson(res, 413, { ok: false, error: `text is longer than ${MAX_CHAT_INPUT_CHARS} characters` });
    return;
  }
  let result;
  try {
    result = await handleConversationMessage(text);
  } catch (error) {
    sendJson(res, 502, { ok: false, kind: 'chat', mode: runtimeChatMode(), error: `chat reply failed: ${error.message}`, code: error.code || null });
    return;
  }
  sendJson(res, result.kind === 'task' ? 201 : 200, result);
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

    // 路由依 AIWFF_MODE：指令照舊；task（預設）每則建任務；both 時 /task 或明確要做事才建任務、其他直接聊天回答。
    // 會叫模型的聊天回覆不 await：輪詢迴圈不被聊天卡住，後面的 /tasks、/task 馬上處理；同時最多 TG_MAX_CONCURRENT_CHATS 則。
    const routed = routeConversationMessage(String(msg.text).trim(), runtimeChatMode());
    const callsModel = routed.kind === 'chat' && !routed.notice && Boolean(routed.instruction);
    if (!callsModel) {
      await replyTelegramConversation(token, msg.chat.id, msg.text);
      continue;
    }
    if (tgChatsInFlight >= TG_MAX_CONCURRENT_CHATS) {
      await tgRequest(token, 'sendMessage', { chat_id: msg.chat.id, text: '前面的訊息還在回答中，請稍後再傳。' });
      continue;
    }
    tgChatsInFlight += 1;
    replyTelegramConversation(token, msg.chat.id, msg.text)
      .catch((error) => logStderr('telegram-chat-send', error))
      .finally(() => {
        tgChatsInFlight -= 1;
      });
  }
}

async function replyTelegramConversation(token, chatId, text) {
  let result;
  try {
    result = await handleConversationMessage(text);
  } catch (error) {
    logStderr('telegram-chat', error);
    await tgRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: `⚠️ 聊天回覆失敗：${String(error.message).slice(0, 500)}\n要我動手做事，請用 /task 開頭。`,
    });
    return;
  }
  if (result.kind === 'task') {
    tgPendingNotify[result.task.id] = chatId;
  }
  const replyText =
    result.reply.length > TG_MAX_MESSAGE_CHARS ? `${result.reply.slice(0, TG_MAX_MESSAGE_CHARS)}\n…（已截斷）` : result.reply;
  await tgRequest(token, 'sendMessage', { chat_id: chatId, text: replyText });
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
    // 積壓數讀不到（任務目錄壞掉）也不能讓 health 失敗：回 null 加原因，ok 不變。
    let failedBacklog;
    try {
      failedBacklog = failedTaskBacklog(listTasks());
    } catch (error) {
      failedBacklog = { count: null, oldest_at: null, error: error.message };
    }
    sendJson(res, 200, { ok: true, pid: process.pid, uptime: process.uptime(), failed_backlog: failedBacklog });
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
    const allTasks = listTasks();
    const tasks = status ? allTasks.filter((task) => task.status === status) : allTasks;
    const payload = { ok: true, tasks };
    if (tasks.length === 0) {
      payload.zero_reason = taskQueryZeroReason(status, allTasks.length);
    }
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const rawSince = url.searchParams.get('since');
    const parsedSince = rawSince == null ? NaN : Number(rawSince);
    const sinceMs = Number.isFinite(parsedSince) ? parsedSince : Date.now() - 30 * 60 * 1000;
    const allEvents = collectTaskEvents(sinceMs);
    const events = allEvents.slice(-EVENT_LIST_CAP);
    sendJson(res, 200, {
      ok: true,
      events,
      truncation: truncationInfo(
        allEvents.length,
        events.length,
        'events_list_cap',
        EVENT_LIST_CAP,
        '事件清單上限 ' + EVENT_LIST_CAP + ' 筆'
      ),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/inbox') {
    const allEvents = collectInboxEvents();
    const events = allEvents.slice(0, INBOX_LIST_CAP);
    sendJson(res, 200, {
      ok: true,
      unread: events.length,
      events,
      truncation: truncationInfo(
        allEvents.length,
        events.length,
        'inbox_list_cap',
        INBOX_LIST_CAP,
        '收件匣清單上限 ' + INBOX_LIST_CAP + ' 筆'
      ),
    });
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

  const resumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
  if (req.method === 'POST' && resumeMatch) {
    const writeAccess = verifyWriteAccess(req);
    if (!writeAccess.ok) {
      sendJson(res, writeAccess.status, { ok: false, error: writeAccess.error });
      return;
    }
    const { statusCode, payload } = resumeTask(resumeMatch[1]);
    sendJson(res, statusCode, payload);
    return;
  }

  // 聊天入口：跟 TG 同一套路由。會花模型呼叫、也可能建任務，所以跟 POST /api/tasks 一樣要寫入授權。
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const writeAccess = verifyWriteAccess(req);
    if (!writeAccess.ok) {
      sendJson(res, writeAccess.status, { ok: false, error: writeAccess.error });
      return;
    }
    await handleChatRequest(req, res);
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
    const limit = normalizeProgressLimit(url.searchParams.get('limit'));
    const lines = readProgressLines(id, limit);
    if (!lines) {
      sendJson(res, 404, { ok: false, error: '找不到進度紀錄' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      id,
      lines,
      entries: readProgressEntries(id, limit) || [],
      truncation: truncationInfo(
        countProgressLines(id),
        lines.length,
        'progress_load_cap',
        limit,
        '進度載入上限 limit=' + limit
      ),
    });
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

// 上一個 process 留下的 running 任務已沒有 worker 在跑：啟動時改成 blocked，不自動重跑。
// 不收的話它會永遠掛在 running，帳上看起來像還有人在做。
function sweepOrphanRunningTasks() {
  const swept = [];
  for (const task of listTasks()) {
    if (task.status !== 'running' || !isSafeTaskId(task.id)) {
      continue;
    }
    updateTaskStatus(task, 'blocked', {
      blocked_reason: 'interrupted',
      last_error: `runtime restarted while task was running; not retried automatically (resume with POST /api/tasks/${task.id}/resume)`,
    });
    swept.push(task.id);
  }
  if (swept.length) {
    logStderr('startup-sweep', `marked ${swept.length} interrupted running task(s) as blocked: ${swept.join(', ')}`);
  }
  return swept;
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
    if (err.code === 'EADDRINUSE') {
      process.stderr.write('  PowerShell: $env:PORT=3200; npm run web\n');
      process.stderr.write('  bash / macOS / Linux: PORT=3200 npm run web\n');
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    // 綁定成功才收殘留任務：同一資料夾誤開第二個 runtime 時，它會先撞 EADDRINUSE 結束，
    // 不會把第一個實例正在跑的任務誤標成中斷。listening callback 在處理任何連線之前執行。
    sweepOrphanRunningTasks();
    console.log(`AIWFF Runtime listening on http://127.0.0.1:${PORT}`);
    const isTTY = Boolean(process.stdout.isTTY);
    if (!isTTY) {
      try {
        fs.writeFileSync(LOGIN_URL_FILE, `${runtimeLoginUrl()}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        logStderr('failed to write login url file', err.message);
      }
    }
    for (const line of startupLoginLines(isTTY)) {
      console.log(line);
    }
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
  readUtf8WithinLimit,
  readUtf8Tail,
  loadDotEnv,
  safeWriteJsonFile,
  // 存檔當下驗 schema 這一包：violation 是純函式（好驗具名 cause），
  // safeWriteTaskFile 是實際的落檔口（好驗「拒絕時目標檔不被動到」）。
  taskSchemaViolation,
  safeWriteTaskFile,
  readTaskSafely,
  appendProgressText,
  listTasks,
  failedTaskBacklog,
  // 0 筆的具名理由是純函式，開出入口才驗得到「三種 0 分得開」。
  taskQueryZeroReason,
  installProcessGuards,
  startTelegramPolling,
  tgRequest,
  envInt,
  // 「卡住不恢復 vs 只是慢」這一包：追蹤器負責量 idle，classifyTimeout 是純函式判定。
  // 兩個都開出入口，才驗得到「一路吐字的 worker 不會被判 stalled」。
  createWorkerPhaseTracker,
  classifyTimeout,
  // 收據上那條無 gap 的時間軸怎麼被算出來的，要驗得到。
  formatPhaseSpans,
  WORKER_STALL_IDLE_SEC,
  // 截斷揭露 + 進度時間戳這一包：collect* 是「未截斷的全量」，list* 是「切過上限的畫面用量」，
  // 兩者要分得開才講得出 dropped。這些函式在既有 tests 裡一條都沒有覆蓋，先開出入口。
  truncationInfo,
  collectInboxEvents,
  collectTaskEvents,
  parseProgressTs,
  readProgressEntries,
  countProgressLines,
  normalizeProgressLimit,
  INBOX_LIST_CAP,
  EVENT_LIST_CAP,
  ensureDirectories,
  initRuntimeToken,
  runtimeLoginUrl,
  startupLoginLines,
  LOGIN_URL_FILE,
  // agy provider：args 組裝與 prompt 落檔都開出入口，才驗得到旗標開關與「長 prompt 不進命令列」。
  shouldUseAgyWorker,
  buildAgyArgs,
  writeAgyPromptFile,
  killProcessTree,
  createRuntimeServer,
  // 聊天模式：模式讀法與 Claude 聊天參數開出入口，才驗得到「無工具、不吃 bypass」。
  runtimeChatMode,
  buildClaudeChatArgs,
  CHAT_TASK_HINT,
  RUNTIME_TOKEN_COOKIE,
  runtimeTokenCookieName,
  // 斷點續傳：checkpoint 讀取與 prompt 段落開出入口，才驗得到「已完成的步驟被帶進下一棒」。
  readCheckpointSteps,
  readCheckpoint,
  checkpointPath,
  buildClaudePrompt,
  // worker 失敗的環境判定是純函式：四類環境原因加「不是環境問題」都要驗得到。
  classifyEnvFailure,
  workerCommandExists,
  taskEventSummary,
  MAX_TASK_RETRIES,
  RETRY_BACKOFF_MS,
  TG_API_BASE_URL,
  TG_POLL_BASE_MS,
  TG_POLL_MAX_BACKOFF_MS,
};
