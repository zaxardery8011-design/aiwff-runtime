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
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const PORT = Number(process.env.PORT || 3100);
const DEFAULT_WORKER_TIMEOUT_SEC = 600;
const MAX_WORKER_TIMEOUT_SEC = 3600;
const MAX_MEMORY_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 128 * 1024;
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

function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] != null) {
      continue;
    }
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function ensureDirectories() {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(INBOX_DIR, { recursive: true });
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
      { name: '對話 / 新任務', route: 'POST /api/tasks' },
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
  // stdio 是 ignore，沒有輸出可以再細分；只能誠實說「已 detach、之後看不見」。
  phaseTracker.enter('detached_no_stdio');
  const timer = setTimeout(() => {
    timedOut = true;
    markTaskBlockedByTimeout(taskId, task, phaseTracker);
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

  child.on('close', () => {
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
  appendProgressText(
    taskId,
    `Worker timed out after ${timeoutSec} seconds (kind=${kind}, phase=${phase}${stuckDetail}${idleDetail}${timelineDetail})`,
  );
  // blocked_reason 維持 'timeout'（收件匣摘要與既有契約照舊），phase / kind 走新欄位另外具名。
  // stuck 秒數量不到時整個欄位不寫：task.schema.json 的 integer 欄位不收 null，
  // 硬塞會讓落檔驗不過、連 blocked 收據都寫不進去。idle 秒同理。
  const patch = { blocked_reason: 'timeout', timeout_phase: phase, timeout_kind: kind };
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

結果請寫到: ${artifactResultRef(task.id)}
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

function spawnClaudeProcess(claudeCmd, args) {
  const options = {
    cwd: ROOT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  if (process.platform !== 'win32') {
    return spawn(claudeCmd, args, options);
  }

  const commandLine = [quoteWindowsCommand(claudeCmd), ...args].join(' ');
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
  const args = ['--print'];
  if (envFlag('CLAUDE_BYPASS_APPROVALS')) {
    args.unshift('--dangerously-skip-permissions');
  }
  const phaseTracker = createWorkerPhaseTracker('spawn');
  const child = spawnClaudeProcess(claudeCmd, args);
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
    child.kill();
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

function startTaskWorker(task) {
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
    await createTask(req, res);
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

function main() {
  installProcessGuards();
  ensureDirectories();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`AIWFF Runtime listening on http://127.0.0.1:${PORT}`);
  });

  if (process.env.TG_BOT_TOKEN && !process.env.ADMIN_TG_CHAT_ID) {
    console.error('Refusing Telegram polling: ADMIN_TG_CHAT_ID is required when TG_BOT_TOKEN is set.');
  } else if (process.env.TG_BOT_TOKEN) {
    startTelegramPolling();
  }
}

if (require.main === module) {
  main();
}

// 測試用曝面：僅在被 require 時提供純函式，不改變 daemon 執行行為。
module.exports = {
  readUtf8WithinLimit,
  readUtf8Tail,
  safeWriteJsonFile,
  // 存檔當下驗 schema 這一包：violation 是純函式（好驗具名 cause），
  // safeWriteTaskFile 是實際的落檔口（好驗「拒絕時目標檔不被動到」）。
  taskSchemaViolation,
  safeWriteTaskFile,
  readTaskSafely,
  appendProgressText,
  listTasks,
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
  MAX_TASK_RETRIES,
  RETRY_BACKOFF_MS,
  TG_API_BASE_URL,
  TG_POLL_BASE_MS,
  TG_POLL_MAX_BACKOFF_MS,
};
