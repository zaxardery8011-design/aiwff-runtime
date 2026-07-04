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
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const PORT = Number(process.env.PORT || 3100);
const DEFAULT_WORKER_TIMEOUT_SEC = 600;
const MAX_WORKER_TIMEOUT_SEC = 3600;
let tgOffset = 0;
const tgPendingNotify = {};

function envFlag(name) {
  return process.env[name] === '1' || String(process.env[name]).toLowerCase() === 'true';
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

function taskEventSummary(task) {
  if (task.status === 'blocked') {
    return task.blocked_reason ? `blocked: ${task.blocked_reason}` : 'blocked';
  }
  if (task.status === 'done') {
    return taskSummary(task) || task.artifact_path || 'done';
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
  writeJsonFile(inboxPath(task.id, eventName), event);
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
          title: 'Unreadable inbox event',
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

function renderHome() {
  return `<!doctype html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIWFF Runtime · JARVIS HUD</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-0: oklch(13% 0.018 250);
      --bg-1: oklch(17% 0.018 250);
      --bg-2: oklch(22% 0.02 250);
      --bg-3: oklch(28% 0.024 250);
      --fg-0: oklch(88% 0.025 250);
      --fg-1: oklch(70% 0.035 250);
      --fg-2: oklch(52% 0.035 250);
      --accent: oklch(72% 0.15 250);
      --accent-2: oklch(70% 0.16 278);
      --green: oklch(76% 0.16 160);
      --yellow: oklch(82% 0.14 78);
      --red: oklch(68% 0.17 24);
      --border-soft: oklch(30% 0.026 250 / .66);
      --grad: linear-gradient(135deg,#5fe6ff,#8b6eff);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: "Inter", -apple-system, "Segoe UI", "Noto Sans TC", sans-serif;
      background:
        radial-gradient(circle at 12% -8%, rgba(110,168,255,.14), transparent 34%),
        radial-gradient(circle at 92% 8%, rgba(139,110,255,.12), transparent 30%),
        var(--bg-0);
      color: var(--fg-0);
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
    }
    .topbar {
      background: color-mix(in oklch,var(--bg-1),transparent 8%);
      border-bottom: 1px solid var(--border-soft);
      padding: 10px 18px;
      display: flex;
      align-items: center;
      gap: 14px;
      flex-shrink: 0;
    }
    .topbar h1 {
      font-size: 14px;
      font-weight: 700;
      background: linear-gradient(135deg,var(--accent),var(--accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: .5px;
    }
    .stat {
      background: var(--bg-2);
      padding: 4px 10px;
      border-radius: 10px;
      font-size: 11px;
      color: var(--fg-1);
      border: 1px solid var(--border-soft);
      white-space: nowrap;
    }
    .stat .num { color: var(--accent); font-weight: 600; }
    .grow { flex: 1; }
    .ws-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 10px var(--green);
      animation: hudPulse 1.6s infinite;
    }
    .ws-dot.down {
      background: var(--yellow);
      box-shadow: 0 0 10px var(--yellow);
    }
    .tabs {
      display: flex;
      gap: 2px;
      padding: 0 14px;
      background: color-mix(in oklch,var(--bg-1),transparent 20%);
      border-bottom: 1px solid var(--border-soft);
      flex-shrink: 0;
    }
    .tab {
      padding: 9px 15px;
      font-size: 12px;
      color: var(--fg-1);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      user-select: none;
      white-space: nowrap;
    }
    .tab:hover { color: #bff3ff; }
    .tab.active {
      color: #bff3ff;
      border-bottom-color: #5fe6ff;
      text-shadow: 0 0 10px rgba(95,230,255,.4);
    }
    .tab-badge {
      display: inline-flex;
      min-width: 18px;
      height: 18px;
      margin-left: 6px;
      padding: 0 5px;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      background: var(--red);
      color: white;
      font-size: 10px;
      font-weight: 700;
      vertical-align: middle;
    }
    .tab-badge.empty { display: none; }
    .tab.locked {
      color: oklch(50% 0.03 250);
      cursor: not-allowed;
    }
    .tab.locked::after { content: " 🔒"; font-size: 9px; }
    main { flex: 1; position: relative; min-height: 0; }
    .pane { position: absolute; inset: 0; display: none; }
    .pane.active { display: block; }
    @keyframes hudPulse { 0%,100%{opacity:1} 50%{opacity:.4} }

    .jhud {
      position: absolute;
      inset: 0;
      padding: 14px;
      display: grid;
      gap: 12px;
      grid-template-columns: 300px 1fr 300px;
      grid-template-rows: 48px 1fr 1fr;
      grid-template-areas: "jt jt jt" "ja jc jl" "jq jc jr";
      font-family: "JetBrains Mono", "Consolas", monospace;
      color: #5fe6ff;
      background: radial-gradient(circle at 50% 48%,rgba(27,159,255,.10),transparent 44%),var(--bg-0);
    }
    .jhud::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background-image:
        linear-gradient(rgba(95,230,255,.06) 1px,transparent 1px),
        linear-gradient(90deg,rgba(95,230,255,.06) 1px,transparent 1px);
      background-size: 44px 44px;
      -webkit-mask: radial-gradient(circle at 50% 50%,#000 56%,transparent 94%);
      mask: radial-gradient(circle at 50% 50%,#000 56%,transparent 94%);
    }
    .jhud > * { position: relative; z-index: 1; }
    .jhud-top {
      grid-area: jt;
      display: flex;
      align-items: center;
      gap: 16px;
      border: 1px solid rgba(95,230,255,.14);
      border-radius: 8px;
      padding: 0 16px;
    }
    .jhud-brand {
      font-weight: 700;
      letter-spacing: 3px;
      font-size: 15px;
      color: #bff3ff;
      text-shadow: 0 0 16px rgba(95,230,255,.5);
    }
    .jhud-brand b { color: #ffb13b; }
    .jhud-sub { font-size: 11px; letter-spacing: 1px; color: #3f9fc4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .jhud-spacer { flex: 1; }
    .jhud-clock {
      font-size: 14px;
      letter-spacing: 2px;
      color: #5fe6ff;
      text-shadow: 0 0 12px rgba(95,230,255,.5);
      white-space: nowrap;
    }
    .jhud-panel {
      border: 1px solid rgba(95,230,255,.34);
      border-radius: 8px;
      position: relative;
      overflow: hidden;
      background: linear-gradient(180deg,rgba(8,26,46,.4),rgba(3,13,26,.26));
      box-shadow: inset 0 0 28px rgba(27,159,255,.06),0 0 14px rgba(95,230,255,.10);
      padding: 12px;
      display: flex;
      flex-direction: column;
    }
    .jhud-panel::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: 32px;
      height: 32px;
      border-top: 2px solid #5fe6ff;
      border-left: 2px solid #5fe6ff;
      border-top-left-radius: 8px;
      opacity: .85;
    }
    .jhud-panel::after {
      content: "";
      position: absolute;
      right: 0;
      bottom: 0;
      width: 32px;
      height: 32px;
      border-bottom: 2px solid #5fe6ff;
      border-right: 2px solid #5fe6ff;
      border-bottom-right-radius: 8px;
      opacity: .85;
    }
    .jhud-ph {
      font-size: 11px;
      letter-spacing: 2px;
      color: #9fe9ff;
      margin-bottom: 10px;
      flex-shrink: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      text-shadow: 0 0 8px rgba(95,230,255,.35);
    }
    .jhud-ph span:last-child { color: #3f9fc4; letter-spacing: 1px; font-size: 10px; }
    .jhud-agent { grid-area: ja; }
    .jhud-bl { grid-area: jq; }
    .jhud-log { grid-area: jl; }
    .jhud-br { grid-area: jr; }
    .jhud-scroll { flex: 1; overflow-y: auto; min-height: 0; }
    .hud-agent {
      display: grid;
      grid-template-columns: 11px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 8px 2px;
      border-bottom: 1px solid rgba(95,230,255,.08);
    }
    .hud-dot { width: 9px; height: 9px; border-radius: 50%; }
    .hud-dot.run { background: #5fe6ff; box-shadow: 0 0 10px #5fe6ff; animation: hudPulse 1.4s infinite; }
    .hud-dot.idle { background: #3f6f88; }
    .hud-dot.ok { background: #4dffb0; box-shadow: 0 0 10px #4dffb0; }
    .hud-dot.fail { background: #ff6b7d; box-shadow: 0 0 10px #ff6b7d; }
    .hud-agent-name { font-size: 12px; color: #cdf4ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hud-agent-meta { font-size: 10px; color: #3f9fc4; }
    .hud-agent-tag { font-size: 9px; color: #9fe9ff; letter-spacing: 1px; }
    .hud-log-stream { flex: 1; overflow: hidden; font-size: 11px; line-height: 1.85; min-height: 0; font-family: "JetBrains Mono", "Consolas", monospace; }
    .hud-log-line { white-space: nowrap; color: #7fd4ff; overflow: hidden; text-overflow: ellipsis; }
    .hud-log-line.warn { color: #ffd76a; }
    .hud-log-line.error { color: #ff6b7d; }
    .hud-log-line .lt { color: #3f9fc4; margin-right: 6px; }
    .jhud-core { grid-area: jc; position: relative; display: flex; align-items: center; justify-content: center; }
    #jhud-reactor { position: absolute; inset: 0; width: 100%; height: 100%; }
    .jhud-core-readout { position: relative; z-index: 2; text-align: center; pointer-events: none; }
    .jhud-core-light { width: 12px; height: 12px; border-radius: 50%; margin: 0 auto 10px; background: #4dffb0; box-shadow: 0 0 14px #4dffb0; }
    .jhud-core-light.waiting { background: #ffb13b; box-shadow: 0 0 14px #ffb13b; }
    .jhud-core-state { font-size: 30px; font-weight: 700; letter-spacing: 5px; color: #eafcff; text-shadow: 0 0 22px rgba(95,230,255,.7); }
    .jhud-core-meta { font-size: 11px; letter-spacing: 2px; color: #3f9fc4; margin-top: 8px; }
    .jhud-core-sched { margin-top: 16px; display: flex; flex-direction: column; gap: 4px; align-items: center; min-width: 220px; }
    .hud-readout-row { display: flex; gap: 8px; justify-content: space-between; width: 100%; font-size: 10px; letter-spacing: 1px; color: #5fe6ff; }
    .hud-readout-row b { color: #bff3ff; font-weight: 600; }
    .jhud-ring-body { flex: 1; display: flex; gap: 12px; align-items: center; min-height: 0; }
    .jhud-ring { width: 92px; height: 92px; position: relative; flex-shrink: 0; }
    .jhud-ring canvas { width: 100%; height: 100%; }
    .jhud-ring-c { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .jhud-ring-c > div { font-size: 19px; font-weight: 700; color: #eafcff; text-shadow: 0 0 12px rgba(95,230,255,.5); }
    .jhud-ring-c small { font-size: 9px; letter-spacing: 2px; color: #3f9fc4; }
    .jhud-readout { flex: 1; display: flex; flex-direction: column; gap: 5px; overflow-y: auto; min-height: 0; }
    .hud-bars { display: flex; align-items: flex-end; gap: 4px; height: 50px; margin-top: auto; }
    .hud-bar { flex: 1; background: linear-gradient(180deg,#5fe6ff,#1b9fff); border-radius: 2px; box-shadow: 0 0 8px rgba(95,230,255,.4); min-height: 4px; }
    .slot-note {
      position: absolute;
      right: 10px;
      top: 10px;
      z-index: 3;
      font-size: 8px;
      letter-spacing: 1px;
      color: #ffb13b;
      border: 1px dashed rgba(255,177,59,.5);
      border-radius: 5px;
      padding: 1px 5px;
    }
    .jov {
      position: absolute;
      left: 316px;
      right: 316px;
      bottom: 24px;
      z-index: 6;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 9px;
      pointer-events: none;
    }
    .jov-state {
      font-size: 11px;
      letter-spacing: 4px;
      color: #5fe6ff;
      text-shadow: 0 0 12px rgba(95,230,255,.6);
      display: flex;
      align-items: center;
      gap: 9px;
    }
    .jov-state::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: #4dffb0; box-shadow: 0 0 12px #4dffb0; }
    .jov-stream { display: flex; flex-direction: column; gap: 7px; width: 100%; align-items: center; max-height: 160px; overflow: hidden; }
    .jov-msg { font-size: 13px; letter-spacing: 1px; text-align: center; max-width: 90%; line-height: 1.5; }
    .jov-msg.you { color: #9fe9ff; }
    .jov-msg.you::before { content: "YOU · "; color: #3f9fc4; font-size: 10px; letter-spacing: 2px; }
    .jov-msg.ai { color: #eafcff; font-size: 15px; text-shadow: 0 0 16px rgba(95,230,255,.5); }
    .jov-msg.ai::before { content: "BRAIN · "; color: #ffb13b; font-size: 10px; letter-spacing: 2px; }
    .jov-input-box {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      margin-top: 2px;
      background: linear-gradient(180deg,rgba(8,28,48,.75),rgba(4,16,31,.55));
      border: 1px solid rgba(95,230,255,.55);
      border-radius: 26px;
      padding: 10px 20px;
      box-shadow: 0 0 22px rgba(95,230,255,.22),inset 0 0 18px rgba(27,159,255,.1);
    }
    .jov-input-box input {
      flex: 1;
      background: transparent;
      border: none;
      color: #cdf4ff;
      font-family: "JetBrains Mono", "Consolas", monospace;
      font-size: 13px;
      outline: none;
      letter-spacing: 1px;
      min-width: 0;
    }
    .jov-input-box input::placeholder { color: #3f6f88; }
    .jov-send { color: #5fe6ff; font-size: 16px; cursor: pointer; background: transparent; border: 0; }
    .jov-hint {
      pointer-events: auto;
      font-size: 11px;
      letter-spacing: 1px;
      color: #3f9fc4;
      cursor: pointer;
      border: 1px solid rgba(95,230,255,.22);
      border-radius: 20px;
      padding: 6px 16px;
      background: rgba(8,28,48,.5);
    }
    .jov-hint:hover { color: #9fe9ff; border-color: rgba(95,230,255,.5); }

    .chatgrid { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(380px,42%) 1fr; }
    .chat { border-right: 1px solid var(--border-soft); display: flex; flex-direction: column; background: rgba(10,14,20,.4); }
    .chat-h { padding: 13px 18px; font-weight: 600; color: var(--fg-1); font-size: 12px; letter-spacing: 1px; border-bottom: 1px solid var(--border-soft); }
    .msgs { flex: 1; overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
    .m { max-width: 88%; padding: 11px 14px; border-radius: 14px; line-height: 1.55; font-size: 13px; overflow-wrap: anywhere; }
    .m.u { align-self: flex-end; background: var(--grad); color: #06121f; font-weight: 500; border-bottom-right-radius: 4px; }
    .m.b { align-self: flex-start; background: var(--bg-3); border: 1px solid var(--border-soft); border-bottom-left-radius: 4px; }
    .m .who { font-size: 10px; opacity: .7; margin-bottom: 3px; }
    .typing { align-self: flex-start; color: var(--fg-2); font-size: 12px; display: flex; gap: 6px; align-items: center; }
    .typing .d { width: 6px; height: 6px; border-radius: 50%; background: #5fe6ff; box-shadow: 0 0 8px #5fe6ff; animation: hudPulse 1s infinite; }
    .inp { padding: 13px 16px; border-top: 1px solid var(--border-soft); display: flex; gap: 10px; align-items: center; }
    .inp input { flex: 1; background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: 12px; padding: 11px 14px; color: var(--fg-0); font-size: 13px; outline: none; min-width: 0; }
    .send { width: 40px; height: 40px; border-radius: 11px; border: none; background: var(--grad); color: #06121f; font-size: 16px; cursor: pointer; flex-shrink: 0; }
    .flow { overflow: auto; padding: 20px 24px; }
    .sec { font-size: 11px; letter-spacing: 1px; color: var(--fg-2); margin: 6px 2px 11px; text-transform: uppercase; }
    .sec:not(:first-child){ margin-top: 22px; }
    .pipe { display: flex; gap: 6px; }
    .stage { flex: 1; min-width: 0; text-align: center; padding: 10px 4px; border-radius: 10px; border: 1px solid var(--border-soft); background: var(--bg-2); }
    .stage .n { font-size: 12px; font-weight: 600; color: var(--fg-1); }
    .stage .s { font-size: 10px; color: var(--fg-2); margin-top: 3px; }
    .stage.done { border-color: rgba(77,255,176,.4); }
    .stage.done .n { color: var(--green); }
    .stage.act { border-color: #5fe6ff; background: linear-gradient(135deg,rgba(95,230,255,.16),rgba(139,110,255,.10)); box-shadow: 0 0 18px rgba(95,230,255,.18); }
    .stage.act .n { color: #5fe6ff; }
    .task { background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: 13px; padding: 14px 16px; margin-bottom: 11px; }
    .task .r { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 9px; }
    .task .t { font-weight: 600; font-size: 13px; color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 10px; padding: 3px 9px; border-radius: 20px; font-weight: 600; white-space: nowrap; }
    .badge.run { background: rgba(95,230,255,.15); color: #5fe6ff; }
    .badge.ok { background: rgba(77,255,176,.15); color: var(--green); }
    .badge.wait { background: rgba(255,177,59,.15); color: var(--yellow); }
    .badge.fail { background: rgba(255,107,125,.15); color: var(--red); }
    .bar { height: 7px; border-radius: 6px; background: var(--bg-3); overflow: hidden; }
    .bar > i { display: block; height: 100%; border-radius: 6px; background: var(--grad); }
    .bar.okb > i { background: linear-gradient(90deg,#4dffb0,#5fe6ff); }
    .bar.failb > i { background: linear-gradient(90deg,#ff6b7d,#ffb13b); }
    .desc { font-size: 12px; color: var(--fg-1); margin-top: 8px; line-height: 1.5; overflow-wrap: anywhere; }
    .tl { border-left: 2px solid var(--border-soft); margin-left: 6px; padding-left: 16px; }
    .tl .e { position: relative; padding: 7px 0; font-size: 12px; color: var(--fg-1); overflow-wrap: anywhere; }
    .tl .e::before { content: ""; position: absolute; left: -21px; top: 11px; width: 9px; height: 9px; border-radius: 50%; background: var(--fg-2); }
    .tl .e.ok::before { background: var(--green); }
    .tl .e.run::before { background: #5fe6ff; box-shadow: 0 0 8px #5fe6ff; }
    .tl .e.fail::before { background: var(--red); box-shadow: 0 0 8px var(--red); }
    .tl .e .tm { color: var(--fg-2); font-size: 11px; margin-right: 8px; }

    .console {
      position: absolute;
      inset: 0;
      overflow: auto;
      padding: 18px;
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(3,1fr);
      grid-auto-rows: min-content;
    }
    .card {
      background: linear-gradient(180deg,color-mix(in oklch,var(--bg-2),white 3%),var(--bg-2));
      border: 1px solid var(--border-soft);
      border-radius: 12px;
      padding: 14px 16px;
      box-shadow: 0 12px 34px rgba(0,0,0,.22);
      min-width: 0;
    }
    .card.span2 { grid-column: span 2; }
    .card-h { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; font-weight: 600; color: #bff3ff; letter-spacing: .5px; margin-bottom: 12px; }
    .card-h .ep { font-size: 10px; color: var(--fg-2); font-weight: 400; font-family: "JetBrains Mono", monospace; white-space: nowrap; }
    .kpis { display: flex; gap: 10px; }
    .kpi { flex: 1; background: var(--bg-3); border-radius: 9px; padding: 9px 10px; text-align: center; min-width: 0; }
    .kpi .v { font-size: 20px; font-weight: 700; color: #eafcff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kpi .v.run { color: #5fe6ff; }
    .kpi .v.ok { color: var(--green); }
    .kpi .v.wait { color: var(--yellow); }
    .kpi .v.fail { color: var(--red); }
    .kpi .l { font-size: 10px; color: var(--fg-2); margin-top: 2px; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(95,230,255,.06); font-size: 12px; }
    .row:last-child { border-bottom: none; }
    .row .nm { color: var(--fg-0); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .mt { color: var(--fg-2); font-size: 10px; }
    .pill-s { font-size: 9px; padding: 2px 7px; border-radius: 10px; white-space: nowrap; }
    .pill-s.done { background: rgba(77,255,176,.14); color: var(--green); }
    .pill-s.run { background: rgba(95,230,255,.14); color: #5fe6ff; }
    .pill-s.todo { background: rgba(255,177,59,.14); color: var(--yellow); }
    .pill-s.fail { background: rgba(255,107,125,.14); color: var(--red); }
    .wk { padding: 10px 0; border-bottom: 1px solid rgba(95,230,255,.06); }
    .wk:last-child { border-bottom: none; }
    .wk .wkr { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--fg-0); margin-bottom: 6px; }
    .wk .wkr span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .clog { font-family: "JetBrains Mono", monospace; font-size: 11px; line-height: 1.8; max-height: 150px; overflow: hidden; }
    .clog .ln { color: #7fd4ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .clog .ln.warn { color: var(--yellow); }
    .clog .ln.error { color: var(--red); }
    .clog .lt { color: var(--fg-2); margin-right: 6px; }
    .mini-bars { display: flex; align-items: flex-end; gap: 4px; height: 46px; margin-top: 6px; }
    .mini-bars i { flex: 1; background: linear-gradient(180deg,#4dffb0,#1b9fff); border-radius: 2px; min-height: 4px; }
    .empty { color: var(--fg-2); font-size: 11px; line-height: 1.6; padding: 8px 0; }
    @media (max-width: 980px) {
      html, body { overflow: auto; }
      body { min-height: 100%; }
      main { min-height: 920px; }
      .topbar { flex-wrap: wrap; }
      .jhud { grid-template-columns: 1fr; grid-template-rows: 48px 260px 360px 220px 220px; grid-template-areas: "jt" "jc" "ja" "jl" "jq" "jr"; overflow: auto; }
      .jhud-br { min-height: 220px; }
      .jov { left: 24px; right: 24px; bottom: 16px; }
      .chatgrid { grid-template-columns: 1fr; grid-template-rows: 420px 1fr; overflow: auto; }
      .console { grid-template-columns: 1fr; }
      .card.span2 { grid-column: auto; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>◆ AIWFF Runtime</h1>
    <span class="ws-dot" id="live-dot" title="live"></span>
    <span class="stat">active <span class="num" id="top-active">—</span></span>
    <span class="stat">todo <span class="num" id="top-todo">—</span></span>
    <span class="stat">inbox <span class="num" id="top-inbox">—</span></span>
    <span class="stat">runtime <span class="num" id="top-runtime">等待 daemon…</span></span>
    <span class="grow"></span>
    <span class="stat" style="color:#3f9fc4">open base · live endpoint</span>
  </div>

  <nav class="tabs">
    <div class="tab active" data-pane="hud">🛰 HUD</div>
    <div class="tab" data-pane="chat">對話</div>
    <div class="tab" data-pane="console">控制台<span class="tab-badge empty" id="nav-inbox-badge">0</span></div>
    <div class="tab locked">額度/成本</div>
    <div class="tab locked">擴充槽</div>
  </nav>

  <main>
    <div class="pane active" id="pane-hud">
      <div class="jhud" id="jhud">
        <div class="jhud-top">
          <div class="jhud-brand">◆ AIWFF <b>·</b> RUNTIME</div>
          <div class="jhud-sub" id="hud-sub">等待 daemon…</div>
          <div class="jhud-spacer"></div>
          <div class="jhud-clock" id="hud-clock">--:--:--</div>
        </div>
        <section class="jhud-panel jhud-agent">
          <div class="jhud-ph"><span>AGENT 狀態牆</span><span>/api/tasks</span></div>
          <div class="jhud-scroll" id="hud-agents"><div class="empty">等待 daemon…</div></div>
        </section>
        <div class="jhud-core">
          <canvas id="jhud-reactor"></canvas>
          <div class="jhud-core-readout">
            <div class="jhud-core-light waiting" id="core-light"></div>
            <div class="jhud-core-state" id="core-state">WAITING</div>
            <div class="jhud-core-meta" id="core-meta">uptime — · pid — · ERR 0 · FATAL 0</div>
            <div class="jhud-core-sched">
              <div class="hud-readout-row"><span>dispatch</span><b id="core-dispatch">—</b></div>
              <div class="hud-readout-row"><span>tasks</span><b id="core-tasks">—</b></div>
              <div class="hud-readout-row"><span>last event</span><b id="core-last-event">—</b></div>
            </div>
          </div>
        </div>
        <section class="jhud-panel jhud-log">
          <div class="jhud-ph"><span>即時 LOG</span><span>/api/events?since=</span></div>
          <div class="hud-log-stream log-stream" id="hud-log"><div class="empty">等待事件…</div></div>
        </section>
        <section class="jhud-panel jhud-bl">
          <div class="slot-note">SLOT 可插拔空槽</div>
          <div class="jhud-ph"><span>派工管線</span><span>/api/tasks</span></div>
          <div class="jhud-ring-body">
            <div class="jhud-ring">
              <canvas id="hud-pipe-ring"></canvas>
              <div class="jhud-ring-c"><div id="pipe-pct">—</div><small>完成率</small></div>
            </div>
            <div class="jhud-readout" id="dispatch-pipeline">
              <div class="empty">等待任務資料…</div>
            </div>
          </div>
        </section>
        <section class="jhud-panel jhud-br">
          <div class="slot-note">SLOT 可插拔空槽</div>
          <div class="jhud-ph"><span>近期完成</span><span>/api/events?since=</span></div>
          <div id="recent-done" style="font-size:11px"><div class="empty">等待完成事件…</div></div>
          <div class="hud-bars" id="hud-health-bars"></div>
        </section>
      </div>
      <div class="jov">
        <div class="jov-state" id="jov-state">WAITING · endpoint sync</div>
        <div class="jov-stream" id="jov-stream">
          <div class="jov-msg ai">等待 daemon…</div>
        </div>
        <div class="jov-hint" data-goto="chat">💬 展示總覽 · 要對話 / 派工請切到「對話」分頁 →</div>
      </div>
    </div>

    <div class="pane" id="pane-chat">
      <div class="chatgrid">
        <section class="chat">
          <div class="chat-h">對話</div>
          <div class="msgs" id="chat-msgs">
            <div class="m b"><div class="who">system</div>等待 daemon…</div>
          </div>
          <div class="inp">
            <input id="chat-input" placeholder="對主腦說話… Enter 送出">
            <button class="send" id="chat-send" type="button">➤</button>
          </div>
        </section>
        <section class="flow">
          <div class="sec">處理階段</div>
          <div class="pipe" id="stage-pipe"></div>
          <div class="sec">進行中的任務</div>
          <div id="running-tasks"><div class="empty">等待進行中任務…</div></div>
          <div class="sec">剛完成</div>
          <div id="chat-done"><div class="empty">等待完成任務…</div></div>
          <div class="sec">活動時間軸</div>
          <div class="tl" id="activity-timeline"><div class="empty">等待事件…</div></div>
        </section>
      </div>
    </div>

    <div class="pane" id="pane-console">
      <div class="console">
        <div class="card">
          <div class="card-h"><span>任務看板</span><span class="ep">/api/tasks</span></div>
          <div class="kpis">
            <div class="kpi"><div class="v run" id="kpi-run">—</div><div class="l">RUN</div></div>
            <div class="kpi"><div class="v wait" id="kpi-todo">—</div><div class="l">TODO</div></div>
            <div class="kpi"><div class="v ok" id="kpi-done">—</div><div class="l">DONE</div></div>
            <div class="kpi"><div class="v fail" id="kpi-fail">—</div><div class="l">ERR</div></div>
          </div>
          <div style="margin-top:12px" id="console-task-list"><div class="empty">等待任務資料…</div></div>
        </div>

        <div class="card">
          <div class="card-h"><span>進度監視</span><span class="ep">/api/tasks/:id/progress</span></div>
          <div id="progress-watch"><div class="empty">等待 progress log…</div></div>
        </div>

        <div class="card">
          <div class="card-h"><span>系統健康</span><span class="ep">/api/health</span></div>
          <div class="kpis">
            <div class="kpi"><div class="v ok" id="health-state">—</div><div class="l">狀態</div></div>
            <div class="kpi"><div class="v" id="health-uptime">—</div><div class="l">UPTIME</div></div>
          </div>
          <div class="mini-bars" id="console-bars"></div>
        </div>

        <div class="card span2">
          <div class="card-h"><span>即時 LOG</span><span class="ep">/api/events?since=</span></div>
          <div class="clog log-stream" id="console-log"><div class="empty">等待事件…</div></div>
        </div>

        <div class="card">
          <div class="card-h"><span>近期完成</span><span class="ep">/api/events?since=</span></div>
          <div id="console-done"><div class="empty">等待完成事件…</div></div>
        </div>
      </div>
    </div>
  </main>

  <script>
    var state = {
      health: null,
      tasks: [],
      events: [],
      inboxEvents: [],
      progress: {},
      lastEventTs: 0,
      endpoints: {
        health: false,
        tasks: false,
        events: false,
        inbox: false
      }
    };

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function taskTimeMs(task) {
      var value = task.updatedAt || task.updated_at || task.startedAt || task.started_at || task.createdAt || task.created_at;
      var ms = typeof value === 'number' ? value : Date.parse(value || '');
      return Number.isFinite(ms) ? ms : 0;
    }

    function fmtClock(ts) {
      var ms = typeof ts === 'number' ? ts : Date.parse(ts || '');
      if (!Number.isFinite(ms)) return '—';
      return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function fmtUptime(seconds) {
      var total = Math.max(0, Math.floor(Number(seconds) || 0));
      var hours = Math.floor(total / 3600);
      var minutes = Math.floor((total % 3600) / 60);
      var secs = total % 60;
      if (hours) return hours + 'h ' + minutes + 'm';
      if (minutes) return minutes + 'm ' + secs + 's';
      return secs + 's';
    }

    function normalizeStatus(status) {
      var value = String(status || '').toLowerCase();
      if (value === 'running' || value === 'doing' || value === 'active') return 'run';
      if (value === 'done' || value === 'completed' || value === 'success') return 'done';
      if (value === 'blocked' || value === 'timeout') return 'blocked';
      if (value === 'failed' || value === 'error' || value === 'fatal') return 'failed';
      return 'todo';
    }

    function statusLabel(status) {
      var value = normalizeStatus(status);
      if (value === 'run') return 'RUN';
      if (value === 'done') return 'OK';
      if (value === 'blocked') return 'BLOCK';
      if (value === 'failed') return 'ERR';
      return 'IDLE';
    }

    function pillClass(status) {
      var value = normalizeStatus(status);
      if (value === 'run') return 'run';
      if (value === 'done') return 'done';
      if (value === 'blocked') return 'fail';
      if (value === 'failed') return 'fail';
      return 'todo';
    }

    function badgeClass(status) {
      var value = normalizeStatus(status);
      if (value === 'run') return 'run';
      if (value === 'done') return 'ok';
      if (value === 'blocked') return 'fail';
      if (value === 'failed') return 'fail';
      return 'wait';
    }

    function dotClass(status) {
      var value = normalizeStatus(status);
      if (value === 'run') return 'run';
      if (value === 'done') return 'ok';
      if (value === 'blocked') return 'fail';
      if (value === 'failed') return 'fail';
      return 'idle';
    }

    function counts() {
      var result = { total: state.tasks.length, run: 0, todo: 0, done: 0, failed: 0, blocked: 0 };
      state.tasks.forEach(function(task) {
        var status = normalizeStatus(task.status);
        if (status === 'run') result.run += 1;
        else if (status === 'done') result.done += 1;
        else if (status === 'blocked') result.blocked += 1;
        else if (status === 'failed') result.failed += 1;
        else result.todo += 1;
      });
      return result;
    }

    function taskTitle(task) {
      return task.title || task.id || 'Untitled task';
    }

    function progressInfo(task) {
      var lines = state.progress[task.id] || [];
      var status = normalizeStatus(task.status);
      var parsed = null;
      for (var i = lines.length - 1; i >= 0; i -= 1) {
        var text = String(lines[i]);
        var fraction = text.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        if (fraction && Number(fraction[2]) > 0) {
          parsed = clamp(Math.round((Number(fraction[1]) / Number(fraction[2])) * 100), 0, 100);
          break;
        }
        var percent = text.match(/(\\d{1,3})\\s*%/);
        if (percent) {
          parsed = clamp(Number(percent[1]), 0, 100);
          break;
        }
      }
      if (parsed != null) return { pct: parsed, label: parsed + '%', lines: lines };
      if (status === 'done') return { pct: 100, label: 'done', lines: lines };
      if (status === 'blocked') return { pct: 100, label: 'blocked', lines: lines };
      if (status === 'failed') return { pct: 100, label: 'failed', lines: lines };
      if (status === 'run') return { pct: clamp(18 + lines.length * 12, 18, 92), label: lines.length ? 'log ' + lines.length : 'running', lines: lines };
      return { pct: lines.length ? clamp(lines.length * 12, 8, 60) : 0, label: lines.length ? 'log ' + lines.length : 'pending', lines: lines };
    }

    function latestTasks(limit) {
      return state.tasks.slice().sort(function(a, b) {
        return taskTimeMs(b) - taskTimeMs(a);
      }).slice(0, limit);
    }

    function latestDone(limit) {
      return state.tasks.filter(function(task) {
        return normalizeStatus(task.status) === 'done';
      }).sort(function(a, b) {
        return taskTimeMs(b) - taskTimeMs(a);
      }).slice(0, limit);
    }

    function latestRunning(limit) {
      return state.tasks.filter(function(task) {
        return normalizeStatus(task.status) === 'run';
      }).sort(function(a, b) {
        return taskTimeMs(b) - taskTimeMs(a);
      }).slice(0, limit);
    }

    function endpointText() {
      if (state.endpoints.health && state.endpoints.tasks && state.endpoints.events && state.endpoints.inbox) return 'online';
      if (state.endpoints.tasks || state.endpoints.events || state.endpoints.health || state.endpoints.inbox) return 'partial';
      return '等待 daemon…';
    }

    function setHtml(id, html) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    }

    function setText(id, text) {
      var el = document.getElementById(id);
      if (el) el.textContent = text;
    }

    function renderTopbar() {
      var c = counts();
      var inboxCount = state.inboxEvents.length;
      setText('top-active', String(c.run));
      setText('top-todo', String(c.todo));
      setText('top-inbox', String(inboxCount));
      setText('top-runtime', endpointText());
      var badge = document.getElementById('nav-inbox-badge');
      if (badge) {
        badge.textContent = String(inboxCount);
        badge.className = inboxCount ? 'tab-badge' : 'tab-badge empty';
      }
      var dot = document.getElementById('live-dot');
      if (dot) dot.className = state.endpoints.health ? 'ws-dot' : 'ws-dot down';
    }

    function renderHealth() {
      var healthOk = !!state.health;
      var c = counts();
      var coreLight = document.getElementById('core-light');
      if (coreLight) coreLight.className = healthOk ? 'jhud-core-light' : 'jhud-core-light waiting';
      setText('core-state', healthOk ? 'NOMINAL' : 'WAITING');
      setText('core-meta', healthOk ? 'uptime ' + fmtUptime(state.health.uptime) + ' · pid ' + state.health.pid + ' · ERR 0 · FATAL 0' : 'uptime — · pid — · ERR 0 · FATAL 0');
      setText('core-dispatch', c.run ? c.run + ' active' : 'ready');
      setText('core-tasks', c.total ? String(c.total) : '0');
      setText('core-last-event', state.events.length ? fmtClock(state.events[state.events.length - 1].ts) : '—');
      setText('health-state', healthOk ? 'NOMINAL' : 'WAIT');
      setText('health-uptime', healthOk ? fmtUptime(state.health.uptime) : '—');
      setText('hud-sub', c.run ? taskTitle(latestRunning(1)[0]) : (c.total ? '目前沒有 running task' : '等待任務資料…'));
      setText('jov-state', (c.run ? 'RUNNING' : 'IDLE') + ' · ' + endpointText());
    }

    function renderAgents() {
      var items = latestTasks(8);
      if (!items.length) {
        setHtml('hud-agents', '<div class="empty">等待 daemon…</div>');
        return;
      }
      setHtml('hud-agents', items.map(function(task) {
        var progress = progressInfo(task);
        var meta = statusLabel(task.status) + ' · ' + progress.label;
        return '<div class="hud-agent">' +
          '<span class="hud-dot ' + dotClass(task.status) + '"></span>' +
          '<div><div class="hud-agent-name">' + escapeHtml(taskTitle(task)) + '</div><div class="hud-agent-meta">' + escapeHtml(meta) + '</div></div>' +
          '<span class="hud-agent-tag">' + escapeHtml(statusLabel(task.status)) + '</span>' +
        '</div>';
      }).join(''));
    }

    function renderPipeline() {
      var c = counts();
      var pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      setText('pipe-pct', c.total ? pct + '%' : '—');
      drawPipeRing(c.total ? pct / 100 : 0);
      setHtml('dispatch-pipeline',
        '<div class="hud-readout-row"><span>收到</span><b>' + (c.total ? c.total : '—') + '</b></div>' +
        '<div class="hud-readout-row"><span>理解</span><b>—</b></div>' +
        '<div class="hud-readout-row"><span>建任務</span><b>' + (c.total ? c.total : '0') + '</b></div>' +
        '<div class="hud-readout-row" style="color:#bff3ff"><span>派工</span><b>' + c.run + ' 進行</b></div>' +
        '<div class="hud-readout-row"><span>產出</span><b>' + c.done + '</b></div>' +
        '<div class="hud-readout-row"><span>驗證</span><b>—</b></div>'
      );
      setHtml('stage-pipe',
        stageHtml('收到', c.total ? String(c.total) : '—', c.total ? 'done' : '') +
        stageHtml('理解', '—', '') +
        stageHtml('建任務', String(c.total), c.total ? 'done' : '') +
        stageHtml('派工', c.run ? '● ' + c.run : '0', c.run ? 'act' : '') +
        stageHtml('產出', String(c.done), c.done ? 'done' : '') +
        stageHtml('驗證', '—', '')
      );
    }

    function stageHtml(name, sub, cls) {
      return '<div class="stage ' + cls + '"><div class="n">' + escapeHtml(name) + '</div><div class="s">' + escapeHtml(sub) + '</div></div>';
    }

    function taskCardHtml(task) {
      var progress = progressInfo(task);
      var status = normalizeStatus(task.status);
      var barClass = status === 'done' ? ' okb' : status === 'failed' ? ' failb' : '';
      var desc = progress.lines.length ? progress.lines[progress.lines.length - 1] : (task.summary || task.result_summary || task.error || task.instruction || '');
      return '<div class="task">' +
        '<div class="r"><div class="t">' + escapeHtml(taskTitle(task)) + '</div><span class="badge ' + badgeClass(task.status) + '">' + escapeHtml(statusLabel(task.status)) + '</span></div>' +
        '<div class="bar' + barClass + '"><i style="width:' + progress.pct + '%"></i></div>' +
        '<div class="desc">' + escapeHtml(progress.label + (desc ? ' · ' + desc : '')) + '</div>' +
      '</div>';
    }

    function renderTaskLists() {
      var running = latestRunning(5);
      var done = latestDone(5);
      setHtml('running-tasks', running.length ? running.map(taskCardHtml).join('') : '<div class="empty">等待進行中任務…</div>');
      setHtml('chat-done', done.length ? done.slice(0, 2).map(taskCardHtml).join('') : '<div class="empty">等待完成任務…</div>');
      setHtml('recent-done', done.length ? done.map(function(task) {
        return '<div class="hud-readout-row" style="padding:4px 0"><span style="color:#cdf4ff">' + escapeHtml(taskTitle(task)) + '</span><b style="color:#4dffb0">✓ ' + escapeHtml(fmtClock(taskTimeMs(task))) + '</b></div>';
      }).join('') : '<div class="empty">等待完成事件…</div>');
      setHtml('console-done', done.length ? done.map(function(task) {
        return '<div class="row"><span class="nm">' + escapeHtml(taskTitle(task)) + '</span><span class="pill-s done">' + escapeHtml(fmtClock(taskTimeMs(task))) + '</span></div>';
      }).join('') : '<div class="empty">等待完成事件…</div>');
    }

    function renderConsoleTasks() {
      var c = counts();
      setText('kpi-run', String(c.run));
      setText('kpi-todo', String(c.todo));
      setText('kpi-done', String(c.done));
      setText('kpi-fail', String(c.failed + c.blocked));
      var items = latestTasks(8);
      setHtml('console-task-list', items.length ? items.map(function(task) {
        return '<div class="row"><span class="nm">' + escapeHtml(taskTitle(task)) + '</span><span class="pill-s ' + pillClass(task.status) + '">' + escapeHtml(normalizeStatus(task.status)) + '</span></div>';
      }).join('') : '<div class="empty">等待任務資料…</div>');
      setHtml('progress-watch', items.length ? items.slice(0, 4).map(function(task) {
        var progress = progressInfo(task);
        return '<div class="wk"><div class="wkr"><span>' + escapeHtml(taskTitle(task)) + '</span><span style="color:#5fe6ff">' + escapeHtml(progress.label) + '</span></div><div class="bar"><i style="width:' + progress.pct + '%"></i></div></div>';
      }).join('') : '<div class="empty">等待 progress log…</div>');
    }

    function eventClass(event) {
      var status = normalizeStatus(event.status);
      if (status === 'done') return 'ok';
      if (status === 'run') return 'run';
      if (status === 'blocked') return 'fail';
      if (status === 'failed') return 'fail';
      return '';
    }

    function eventMessage(event) {
      var title = event.title || event.id || event.type || 'event';
      var status = event.status ? ' · ' + event.status : '';
      var summary = event.summary ? ' · ' + event.summary : '';
      return title + status + summary;
    }

    function renderEvents() {
      var events = state.events.slice(-40);
      if (!events.length) {
        setHtml('hud-log', '<div class="empty">等待事件…</div>');
        setHtml('console-log', '<div class="empty">等待事件…</div>');
        setHtml('activity-timeline', '<div class="empty">等待事件…</div>');
        renderMiniBars(0);
        return;
      }
      var logHtml = events.slice(-12).map(function(event) {
        var cls = eventClass(event);
        var level = cls === 'fail' ? 'ERROR' : cls === 'run' ? 'RUN' : 'INFO';
        return '<div class="hud-log-line ' + (cls === 'fail' ? 'error' : '') + '"><span class="lt">' + escapeHtml(fmtClock(event.ts)) + '</span>[' + level + '] ' + escapeHtml(eventMessage(event)) + '</div>';
      }).join('');
      var clogHtml = events.slice(-7).map(function(event) {
        var cls = eventClass(event);
        var level = cls === 'fail' ? 'ERROR' : cls === 'run' ? 'RUN' : 'INFO';
        return '<div class="ln ' + (cls === 'fail' ? 'error' : '') + '"><span class="lt">' + escapeHtml(fmtClock(event.ts)) + '</span>[' + level + '] ' + escapeHtml(eventMessage(event)) + '</div>';
      }).join('');
      var timelineHtml = events.slice(-10).reverse().map(function(event) {
        var cls = eventClass(event);
        return '<div class="e ' + cls + '"><span class="tm">' + escapeHtml(fmtClock(event.ts)) + '</span>' + escapeHtml(eventMessage(event)) + '</div>';
      }).join('');
      setHtml('hud-log', logHtml);
      setHtml('console-log', clogHtml);
      setHtml('activity-timeline', timelineHtml);
      setText('core-last-event', fmtClock(events[events.length - 1].ts));
      renderMiniBars(events.length);
    }

    function renderMiniBars(eventCount) {
      var c = counts();
      var values = [c.todo, c.run, c.done, c.failed + c.blocked, eventCount, state.progressLineCount || 0, c.total, state.endpoints.health ? 1 : 0];
      var max = Math.max.apply(null, values.concat([1]));
      var html = values.map(function(value) {
        var h = clamp(Math.round((value / max) * 100), value ? 18 : 4, 100);
        return '<i style="height:' + h + '%"></i>';
      }).join('');
      setHtml('hud-health-bars', html);
      setHtml('console-bars', html);
    }

    function addChatMessage(who, text, kind) {
      var root = document.getElementById('chat-msgs');
      if (!root) return;
      if (root.children.length === 1 && root.textContent.indexOf('等待 daemon') !== -1) {
        root.innerHTML = '';
      }
      var div = document.createElement('div');
      div.className = 'm ' + (kind === 'user' ? 'u' : 'b');
      div.innerHTML = '<div class="who">' + escapeHtml(who) + '</div>' + escapeHtml(text);
      root.appendChild(div);
      while (root.children.length > 30) root.removeChild(root.firstElementChild);
      root.scrollTop = root.scrollHeight;
    }

    async function submitTask(rawText) {
      var text = String(rawText || '').trim();
      if (!text) return;
      addChatMessage('你', text, 'user');
      try {
        var res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: text.split(/\\r?\\n/)[0].slice(0, 80), instruction: text })
        });
        var data = await res.json().catch(function() { return {}; });
        if (!res.ok || !data.id) {
          throw new Error(data.error || 'POST /api/tasks failed');
        }
        addChatMessage('runtime', '已建立任務 ' + data.id.slice(0, 8) + '，狀態：' + (data.status || 'pending'), 'system');
        await pollTasks();
      } catch (error) {
        addChatMessage('runtime', '建立任務失敗：' + error.message, 'system');
      }
    }

    async function pollHealth() {
      try {
        var res = await fetch('/api/health');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        state.health = data;
        state.endpoints.health = true;
      } catch (error) {
        state.health = null;
        state.endpoints.health = false;
      }
    }

    async function pollTasks() {
      try {
        var res = await fetch('/api/tasks');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
        state.endpoints.tasks = true;
        await pollProgressForVisibleTasks();
      } catch (error) {
        state.endpoints.tasks = false;
      }
    }

    async function pollEvents() {
      try {
        var res = await fetch('/api/events?since=' + encodeURIComponent(state.lastEventTs || 0));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        var incoming = Array.isArray(data.events) ? data.events : [];
        incoming.forEach(function(event) {
          var ts = Number(event.ts) || Date.now();
          event.ts = ts;
          state.lastEventTs = Math.max(state.lastEventTs || 0, ts);
          if (!state.events.some(function(item) { return item.ts === event.ts && item.id === event.id && item.status === event.status; })) {
            state.events.push(event);
          }
        });
        state.events = state.events.slice(-80);
        state.endpoints.events = true;
      } catch (error) {
        state.endpoints.events = false;
      }
    }

    async function pollInbox() {
      try {
        var res = await fetch('/api/inbox');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        state.inboxEvents = Array.isArray(data.events) ? data.events : [];
        state.endpoints.inbox = true;
      } catch (error) {
        state.inboxEvents = [];
        state.endpoints.inbox = false;
      }
    }

    async function pollProgressForVisibleTasks() {
      var items = latestTasks(8);
      var totalLines = 0;
      await Promise.all(items.map(async function(task) {
        if (!task.id) return;
        try {
          var res = await fetch('/api/tasks/' + encodeURIComponent(task.id) + '/progress');
          if (!res.ok) {
            state.progress[task.id] = state.progress[task.id] || [];
            return;
          }
          var data = await res.json();
          state.progress[task.id] = Array.isArray(data.lines) ? data.lines : [];
        } catch (_) {
          state.progress[task.id] = state.progress[task.id] || [];
        }
      }));
      Object.keys(state.progress).forEach(function(id) {
        totalLines += (state.progress[id] || []).length;
      });
      state.progressLineCount = totalLines;
    }

    function renderAll() {
      renderTopbar();
      renderHealth();
      renderAgents();
      renderPipeline();
      renderTaskLists();
      renderConsoleTasks();
      renderEvents();
      var c = counts();
      var msg = c.run ? '目前有 ' + c.run + ' 個任務執行中。' : (c.total ? '目前沒有 running task。' : '等待 daemon…');
      setHtml('jov-stream', '<div class="jov-msg ai">' + escapeHtml(msg) + '</div>');
    }

    async function refresh() {
      await Promise.all([pollHealth(), pollTasks(), pollEvents(), pollInbox()]);
      renderAll();
    }

    document.querySelectorAll('.tab[data-pane]').forEach(function(tab) {
      tab.onclick = function() {
        document.querySelectorAll('.tab').forEach(function(item) { item.classList.remove('active'); });
        document.querySelectorAll('.pane').forEach(function(item) { item.classList.remove('active'); });
        tab.classList.add('active');
        var pane = document.getElementById('pane-' + tab.dataset.pane);
        if (pane) pane.classList.add('active');
      };
    });

    document.querySelectorAll('[data-goto]').forEach(function(el) {
      el.onclick = function() {
        var tab = document.querySelector('.tab[data-pane="' + el.dataset.goto + '"]');
        if (tab) tab.click();
      };
    });

    function wireSubmit(inputId, buttonId) {
      var input = document.getElementById(inputId);
      var button = document.getElementById(buttonId);
      if (!input || !button) return;
      var send = function() {
        var text = input.value;
        input.value = '';
        submitTask(text);
      };
      button.onclick = send;
      input.addEventListener('keydown', function(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      });
    }

    wireSubmit('chat-input', 'chat-send');

    function tickClock() {
      var c = document.getElementById('hud-clock');
      if (c) c.textContent = new Date().toTimeString().slice(0, 8);
    }
    tickClock();
    setInterval(tickClock, 1000);

    function drawPipeRing(pct) {
      var cv = document.getElementById('hud-pipe-ring');
      if (!cv) return;
      var ctx = cv.getContext('2d');
      var dpr = window.devicePixelRatio || 1;
      var s = 92;
      cv.width = s * dpr;
      cv.height = s * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var cx = s / 2;
      var cy = s / 2;
      var r = 36;
      ctx.clearRect(0, 0, s, s);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(95,230,255,.18)';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(pct, 0, 1));
      ctx.strokeStyle = '#5fe6ff';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.shadowColor = '#5fe6ff';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    (function() {
      var cv = document.getElementById('jhud-reactor');
      if (!cv) return;
      var ctx = cv.getContext('2d');
      var pane = document.getElementById('pane-hud');
      var ph = 0;
      function ring(cx, cy, r, o) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, o.a0 || 0, o.a1 || Math.PI * 2);
        ctx.strokeStyle = o.c;
        ctx.lineWidth = o.w || 1;
        ctx.globalAlpha = o.al == null ? 1 : o.al;
        ctx.setLineDash(o.dash || []);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
      function ticks(cx, cy, r, n, len, c, rot) {
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = .65;
        for (var i = 0; i < n; i += 1) {
          var a = rot + i / n * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          ctx.lineTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      function frame() {
        requestAnimationFrame(frame);
        if (!pane.classList.contains('active')) return;
        var rect = cv.getBoundingClientRect();
        if (!rect.width) return;
        var dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.round(rect.width * dpr) || cv.height !== Math.round(rect.height * dpr)) {
          cv.width = Math.round(rect.width * dpr);
          cv.height = Math.round(rect.height * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var w = rect.width;
        var h = rect.height;
        var cx = w / 2;
        var cy = h / 2;
        var R = Math.min(w, h) / 2 - 4;
        ctx.clearRect(0, 0, w, h);
        var main = '95,230,255';
        var hot = '190,247,255';
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * .72);
        g.addColorStop(0, 'rgba(' + main + ',.46)');
        g.addColorStop(.5, 'rgba(27,159,255,.15)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
        ring(cx, cy, R * .99, { c: 'rgba(' + main + ',.9)', w: 2.6 });
        ring(cx, cy, R * .95, { c: 'rgba(' + main + ',.4)', w: 1 });
        ticks(cx, cy, R * .99, 84, 11, 'rgba(130,238,255,.6)', ph * .3);
        ring(cx, cy, R * .82, { c: 'rgba(' + main + ',.62)', w: 1.8, a0: ph, a1: ph + Math.PI * 1.4 });
        ring(cx, cy, R * .7, { c: 'rgba(255,177,59,.6)', w: 1.6, a0: -ph * 1.6, a1: -ph * 1.6 + Math.PI * .7 });
        ticks(cx, cy, R * .66, 36, 13, 'rgba(' + main + ',.45)', -ph * .5);
        ring(cx, cy, R * .52, { c: 'rgba(' + main + ',.6)', w: 1.2, dash: [4, 8] });
        ring(cx, cy, R * .4, { c: 'rgba(' + main + ',.85)', w: 1.8, a0: ph * 2, a1: ph * 2 + Math.PI * 1.7 });
        var pr = R * .33 * (1 + Math.sin(ph * 3) * .05);
        ring(cx, cy, pr, { c: 'rgba(' + hot + ',.95)', w: 2.6 });
        var ig = ctx.createRadialGradient(cx, cy, 0, cx, cy, pr);
        ig.addColorStop(0, 'rgba(' + hot + ',.5)');
        ig.addColorStop(1, 'rgba(' + main + ',0)');
        ctx.fillStyle = ig;
        ctx.beginPath();
        ctx.arc(cx, cy, pr, 0, Math.PI * 2);
        ctx.fill();
        var sweep = (ph * .85) % (Math.PI * 2);
        var span = Math.PI / 3.2;
        var rad = R * .97;
        ctx.save();
        ctx.translate(cx, cy);
        for (var k = 0; k < span; k += .035) {
          var a = sweep - k;
          var al = (1 - k / span) * .26;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, rad, a, a + .045);
          ctx.closePath();
          ctx.fillStyle = 'rgba(' + main + ',' + al.toFixed(3) + ')';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(sweep) * rad, Math.sin(sweep) * rad);
        ctx.strokeStyle = 'rgba(' + hot + ',.92)';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(95,230,255,.95)';
        ctx.shadowBlur = 9;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.restore();
        ph += .012;
      }
      requestAnimationFrame(frame);
    })();

    drawPipeRing(0);
    refresh();
    setInterval(refresh, 4000);
  </script>
</body>
</html>`;
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
    writeJsonFile(taskPath(taskId), task);
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

function appendProgressText(taskId, line) {
  fs.appendFileSync(progressPath(taskId), `${JSON.stringify({ ts: Date.now(), text: line })}\n`);
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
  writeJsonFile(taskPath(task.id), nextTask);
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

function spawnClaudeWorker(task) {
  ensureDirectories();
  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const fullPrompt = buildClaudePrompt(task);
  const runningTask = updateTaskStatus(task, 'running');
  const timeoutMs = normalizeWorkerTimeoutSec(task) * 1000;
  const args = ['--print'];
  if (envFlag('CLAUDE_BYPASS_APPROVALS')) {
    args.unshift('--dangerously-skip-permissions');
  }
  const child = spawnClaudeProcess(claudeCmd, args);
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
    let nextTask;
    if (spawnError) {
      nextTask = updateTaskStatus(currentTask, 'failed', { error: spawnError.message });
    } else if (code !== 0) {
      const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
      const tail = stderr.trim().slice(-1000);
      nextTask = updateTaskStatus(currentTask, 'failed', {
        error: `Claude exited with ${exitReason}${tail ? `: ${tail}` : ''}`,
      });
    } else if (fs.existsSync(artifactResultPath(task.id))) {
      nextTask = updateTaskStatus(currentTask, 'done', { artifact_path: artifactResultRef(task.id) });
    } else {
      nextTask = updateTaskStatus(currentTask, 'failed', { error: 'no artifact produced' });
    }
    notifyTelegramTaskDone(nextTask);
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

  writeJsonFile(taskPath(task.id), task);
  startTaskWorker(task);
  return task;
}

function createTaskFromTg({ title, instruction }) {
  const safeTitle = typeof title === 'string' && title.trim() ? title.trim() : 'Untitled task';
  const safeInstruction =
    typeof instruction === 'string' && instruction.trim() ? instruction.trim() : 'Run the task lifecycle.';
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

  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Untitled task';
  const instruction =
    typeof payload.instruction === 'string' && payload.instruction.trim()
      ? payload.instruction.trim()
      : 'Run the mock worker lifecycle.';
  const task = createTaskObject(title, instruction, { timeout_sec: payload.timeout_sec });
  sendJson(res, 201, task);
}

async function tgRequest(token, method, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
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

  if (req.method === 'GET' && url.pathname === '/api/inbox') {
    const events = listInboxEvents();
    sendJson(res, 200, { ok: true, unread: events.length, events });
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

  if (process.env.TG_BOT_TOKEN && !process.env.ADMIN_TG_CHAT_ID) {
    console.error('Refusing Telegram polling: ADMIN_TG_CHAT_ID is required when TG_BOT_TOKEN is set.');
  } else if (process.env.TG_BOT_TOKEN) {
    setInterval(() => pollTelegram().catch(() => {}), 2000);
  }
}

if (require.main === module) {
  main();
}
