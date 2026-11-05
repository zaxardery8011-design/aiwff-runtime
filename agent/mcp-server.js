#!/usr/bin/env node

// 給 Claude 桌面端和 Claude Code 用的本機 MCP server：stdio、手寫 JSON-RPC、零相依。
// stdout 只放協定訊息，一行一則；log 全走 stderr。
// 新舊兩代協定都答：2026-07-28 沒有握手，版本放在每個請求的 _meta；2025-11-25 以前要 initialize。
// 桌面端 Chat 分頁走哪一代沒有證據，只做一代都有風險，所以逐請求判斷，不存連線狀態。
// 這支只走本機 HTTP API，不 require agent/index.js：載入它就等於起一顆 runtime。

const fs = require('fs');
const http = require('http');
const path = require('path');

// 用 __dirname 找 repo 根：client 起這支時的 cwd 是使用者開的專案，不是這個 Root。
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');
// install.ps1 把 repo 放在 <Root>\suite\aiwff-runtime，launcher 在 <Root>。
const LAUNCHER_PATH = path.resolve(ROOT_DIR, '..', '..', 'start-runtime.cmd');
const CONNECT_BRAIN_PATH = path.resolve(ROOT_DIR, '..', '..', 'connect-brain.cmd');

const SERVER_INFO = { name: 'aiwff', version: '0.1.0' };
const MODERN_VERSION = '2026-07-28';
const LATEST_LEGACY_VERSION = '2025-11-25';
const SUPPORTED_VERSIONS = [MODERN_VERSION, LATEST_LEGACY_VERSION];
const LEGACY_VERSIONS = [LATEST_LEGACY_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'];
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_UNSUPPORTED_VERSION = -32022;

const RUNTIME_TOKEN_HEADER = 'x-aiwff-runtime-token';
const HTTP_TIMEOUT_MS = 5000;
const DEFAULT_TASK_LIMIT = 10;
const MAX_TASK_LIMIT = 50;
const MAX_TITLE_CHARS = 80;
// Claude Code 工具輸出超過 10,000 token 會警告；中文一個字約一到兩個 token。
const MAX_OUTPUT_CHARS = 8000;
const REDACTED = '[已遮蔽]';

const NO_ARGUMENTS_SCHEMA = { type: 'object', additionalProperties: false };

const BRAIN_LABELS = {
  claude: 'claude（Claude CLI）',
  openai_compatible: 'openai_compatible（OpenAI 相容端點，例如本機 Ollama）',
};

// 模型看不到手冊，所以 Claude 大腦的實際範圍要寫在工具描述和回傳文字裡，不然它會重開一件再花一次。
const CLAUDE_TASK_LIMIT =
  '背景任務只能改自己的工作資料夾，不能跑命令、程式或腳本，也不能上網。做不到的工作會停下來問使用者，問的是開放權限時回答解不開，同一件不要重開。';
const CLAUDE_TASK_UNRESTRICTED = '這個小主腦開了跳過核可，背景任務動得到這個帳號的所有檔案。要交辦什麼，先跟使用者確認過。';

// 協定層的錯：走 JSON-RPC error。
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// 工具層的錯：走 isError:true，client 才會把文字交給模型轉述給使用者。
class ToolError extends Error {}

function log(message) {
  process.stderr.write(`[aiwff-mcp] ${message}\n`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 跟 agent/index.js 的 loadDotEnv 同一套解析（首個非空值生效、頭尾引號各去一個），
// 差在不看 process.env：client 帶進來的環境跟 runtime 無關。每次現讀，改了 .env 不用重開 client。
function readDotEnv() {
  const values = {};
  let text = '';
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return values;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || String(values[match[1]] ?? '').trim() !== '') {
      continue;
    }
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function runtimeConfig() {
  const env = readDotEnv();
  return { port: Number(env.PORT || 3100), token: env.AIWFF_RUNTIME_TOKEN || '' };
}

function launchHint() {
  return fs.existsSync(LAUNCHER_PATH) ? `雙擊 ${LAUNCHER_PATH}` : `在 ${ROOT_DIR} 跑 npm run web`;
}

function connectHint() {
  return fs.existsSync(CONNECT_BRAIN_PATH) ? `雙擊 ${CONNECT_BRAIN_PATH}` : `在 ${ROOT_DIR} 跑 npm run connect`;
}

function brainLabel(mode) {
  if (mode === 'mock') {
    return `mock（模擬，還沒接 AI，任務不會真的做事；要接 AI 就${connectHint()}）`;
  }
  return BRAIN_LABELS[mode] || mode;
}

// 看 runtime 回報的值，不看 .env：改了 .env 沒重開時，任務跑的還是舊設定。
function claudeTaskNote(scope) {
  if (scope === 'workspace') {
    return CLAUDE_TASK_LIMIT;
  }
  if (scope === 'unrestricted') {
    return CLAUDE_TASK_UNRESTRICTED;
  }
  // 既有 .env 沒帶 -Brain 時安裝不會改它，這種小主腦的任務還是交不出結果。
  return `這個小主腦還沒開放寫檔：背景任務沒有人按允許，連結果檔都寫不了，多半停在等使用者回答，也可能重試 3 次才停，都會用掉額度。同一件不要重開。要開放：${connectHint()}，選 Claude，再重開小主腦。`;
}

function callRuntime(method, route, { body, auth = false } = {}) {
  const { port, token } = runtimeConfig();
  if (auth && !token) {
    throw new ToolError(`${ENV_PATH} 裡沒有 AIWFF_RUNTIME_TOKEN，這個工具用不了。在 .env 設好這個值、重開小主腦再試。`);
  }
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (auth) {
    headers[RUNTIME_TOKEN_HEADER] = token;
  }
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    // agent:false 用完就關連線，stdin 關掉時才不會被閒置 socket 拖住不結束。
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers, agent: false }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          reject(new ToolError(`http://127.0.0.1:${port} 回的不是小主腦的資料，可能是別的程式占著這個 port。`));
        }
      });
    });
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      timedOut = true;
      req.destroy();
    });
    req.on('error', () => {
      if (timedOut) {
        reject(new ToolError(`小主腦沒有回應（等了 ${HTTP_TIMEOUT_MS / 1000} 秒），可能正在忙。等一下再試。`));
        return;
      }
      reject(new ToolError(`小主腦（AIWFF runtime）現在沒有開，連不上 http://127.0.0.1:${port}。開法：${launchHint()}。開好再試一次。`));
    });
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

function assertOk(response) {
  if (response.status === 401) {
    throw new ToolError('runtime token 對不上：.env 改過但小主腦沒重開，或這個 port 上是別顆小主腦。重開小主腦再試。');
  }
  if (response.status < 200 || response.status >= 300) {
    const reason = isPlainObject(response.data) && response.data.error ? response.data.error : '沒有附原因';
    throw new ToolError(`小主腦回了錯誤（HTTP ${response.status}）：${reason}`);
  }
  return response.data;
}

async function toolStatus() {
  const hud = assertOk(await callRuntime('GET', '/api/hud'));
  const counts = hud.task_counts || {};
  const pending = counts.pending || 0;
  const running = counts.running || 0;
  return [
    `小主腦運作中（http://127.0.0.1:${hud.port}，已開 ${hud.uptime_sec} 秒）`,
    `大腦模式：${brainLabel(hud.worker_mode)}`,
    `進行中任務：${pending + running} 件（排隊 ${pending}、執行中 ${running}）`,
    `其他任務：卡住 ${counts.blocked || 0}、失敗 ${counts.failed || 0}、完成 ${counts.done || 0}`,
  ].join('\n');
}

async function toolNewTask(args) {
  const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';
  if (!instruction) {
    // runtime 收到空的 instruction 不會擋，會用預設字串真的跑一件。
    throw new ToolError('instruction 不能是空的，要寫清楚這件工作要做什麼。');
  }
  // POST /api/tasks 沒有 AIWFF_MODE 這道閘：只聊天的安裝要在這裡擋，不然比 WebUI 還鬆。
  const settings = assertOk(await callRuntime('GET', '/api/settings', { auth: true }));
  if (settings.chat_mode === 'chat') {
    throw new ToolError('這個小主腦設成只聊天（AIWFF_MODE=chat），不接任務。要交辦任務，把 .env 的 AIWFF_MODE 改成 both 再重開小主腦。');
  }
  const body = { instruction };
  if (typeof args.title === 'string' && args.title.trim()) {
    body.title = args.title.trim();
  }
  // POST /api/tasks 回裸任務物件，不像其他端點包 {ok,…}。
  const task = assertOk(await callRuntime('POST', '/api/tasks', { body, auth: true }));
  const accepted = `已交給小主腦背景跑。任務 id：${task.id}，狀態：${task.status}。跑完用 aiwff_task_result 帶這個 id 讀結果。`;
  return settings.worker_mode === 'claude' ? `${accepted}\n${claudeTaskNote(settings.claude_task_scope)}` : accepted;
}

async function toolTasks(args) {
  const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), MAX_TASK_LIMIT) : DEFAULT_TASK_LIMIT;
  const { tasks } = assertOk(await callRuntime('GET', '/api/tasks'));
  if (tasks.length === 0) {
    return '目前沒有任務。';
  }
  // /api/tasks 沒有筆數上限，還帶 instruction 全文，這裡只留一行摘要。
  const rows = tasks
    .slice(0, limit)
    .map((task) => `- ${task.id}｜${task.status}｜${String(task.title).slice(0, MAX_TITLE_CHARS)}｜${task.updated_at || task.created_at}`);
  return [`最近 ${rows.length} 件任務（共 ${tasks.length} 件，新到舊）：`, ...rows].join('\n');
}

async function unfinishedTaskText(task) {
  if (task.status === 'failed') {
    return `任務失敗：${task.error || task.last_error || '沒有記錄原因'}`;
  }
  if (task.status === 'blocked') {
    if (task.has_question) {
      const settings = assertOk(await callRuntime('GET', '/api/settings'));
      return `任務在等使用者回答，請到 WebUI 回答後才會續跑。如果它問的是開放權限，回答解不開。${claudeTaskNote(settings.claude_task_scope)}`;
    }
    return `任務卡住了（${task.blocked_reason || '沒有記錄原因'}）${task.last_error ? `：${task.last_error}` : ''}`;
  }
  return `任務還沒跑完（狀態：${task.status}），等一下再查。`;
}

async function toolTaskResult(args) {
  const id = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  if (!id) {
    throw new ToolError('task_id 不能是空的，先用 aiwff_tasks 查任務 id。');
  }
  const route = `/api/tasks/${encodeURIComponent(id)}`;
  const taskResponse = await callRuntime('GET', route);
  if (taskResponse.status === 404) {
    throw new ToolError(`找不到任務 ${id}，用 aiwff_tasks 看現有的任務 id。`);
  }
  const { task } = assertOk(taskResponse);
  // failed、blocked 的 /result 只回 result not ready，原因要從任務本身讀。
  if (task.status !== 'done') {
    return await unfinishedTaskText(task);
  }
  const result = assertOk(await callRuntime('GET', `${route}/result`, { auth: true }));
  return String(result.content);
}

async function toolMemory(args) {
  const file = typeof args.file === 'string' ? args.file.trim() : '';
  if (!file) {
    const { documents } = assertOk(await callRuntime('GET', '/api/memory'));
    if (documents.length === 0) {
      return '目前沒有記憶文件。';
    }
    const rows = documents.map((doc) => `- ${doc.file}（${doc.size_bytes} bytes，更新於 ${doc.updated_at}）`);
    return [`記憶文件 ${rows.length} 份：`, ...rows].join('\n');
  }
  const response = await callRuntime('GET', `/api/memory/${encodeURIComponent(file)}`);
  if (response.status === 404) {
    throw new ToolError(`找不到記憶文件 ${file}，不帶 file 呼叫可以列出現有的。`);
  }
  const { document } = assertOk(response);
  return document.frontmatter ? `---\n${document.frontmatter}\n---\n${document.content}` : String(document.content);
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false };

const TOOLS = [
  {
    name: 'aiwff_status',
    description: '看小主腦（本機 AIWFF runtime）活著沒、現在接的大腦模式、進行中的任務數。',
    annotations: READ_ONLY,
    inputSchema: NO_ARGUMENTS_SCHEMA,
    run: toolStatus,
  },
  {
    name: 'aiwff_new_task',
    description:
      `把一件工作交給小主腦在背景跑，跟 WebUI 建任務同一條路。會用掉使用者接的大腦額度（Claude 訂閱或 API 用量），只在使用者明確要交辦時才呼叫，不要拿來試跑。立刻回任務 id，不等結果；結果用 aiwff_task_result 讀。大腦是 Claude 時，範圍以回傳文字為準，一般是：${CLAUDE_TASK_LIMIT}`,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '要小主腦做的事，寫清楚完成的樣子。' },
        title: { type: 'string', description: '任務標題，選填，顯示在任務清單上。' },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
    run: toolNewTask,
  },
  {
    name: 'aiwff_tasks',
    description: '列出小主腦最近的任務，新到舊：任務 id、狀態、標題、時間。',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: MAX_TASK_LIMIT, description: `最多幾筆，預設 ${DEFAULT_TASK_LIMIT}。` },
      },
      additionalProperties: false,
    },
    run: toolTasks,
  },
  {
    name: 'aiwff_task_result',
    description: '讀一件任務的結果。還沒跑完會回目前狀態，失敗或卡住會回原因。',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任務 id，從 aiwff_new_task 或 aiwff_tasks 拿。' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    run: toolTaskResult,
  },
  {
    name: 'aiwff_memory',
    description: '唯讀看小主腦的記憶文件（memory/*.md）。不帶 file 列清單，帶 file 讀內文。',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '檔名，例如 facts.md。' },
      },
      additionalProperties: false,
    },
    run: toolMemory,
  },
];

// token 絕不回給模型：runtime 回的內容（任務結果、記憶文件）也可能夾著它，所以在出口統一遮。
// 要先遮再截：截斷線切在 token 中間時，前半段就比對不到了。
function outputText(text) {
  const { token } = runtimeConfig();
  const safe = token ? text.split(token).join(REDACTED) : text;
  if (safe.length <= MAX_OUTPUT_CHARS) {
    return safe;
  }
  return `${safe.slice(0, MAX_OUTPUT_CHARS)}\n\n（內容太長，只顯示前 ${MAX_OUTPUT_CHARS} 字，全文 ${safe.length} 字，到 WebUI 看完整內容。）`;
}

async function callTool(params) {
  const tool = TOOLS.find((item) => item.name === params.name);
  if (!tool) {
    throw new RpcError(RPC_INVALID_PARAMS, `Unknown tool: ${params.name}`);
  }
  log(`tool=${tool.name}`);
  const args = isPlainObject(params.arguments) ? params.arguments : {};
  try {
    const text = await tool.run(args);
    return { content: [{ type: 'text', text: outputText(text) }], isError: false };
  } catch (error) {
    if (!(error instanceof ToolError)) {
      log(`tool=${tool.name} failed: ${error.name}`);
    }
    const text = error instanceof ToolError ? error.message : '小主腦回的資料跟預期不同，這個工具處理不了。';
    return { content: [{ type: 'text', text: outputText(text) }], isError: true };
  }
}

function initializeResult(params) {
  const requested = params.protocolVersion;
  return {
    protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LATEST_LEGACY_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
}

function toolList() {
  return { tools: TOOLS.map(({ name, description, annotations, inputSchema }) => ({ name, description, annotations, inputSchema })) };
}

function modernResult(result) {
  return { resultType: 'complete', ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } };
}

function cacheableResult(result) {
  return modernResult({ ...result, ttlMs: 0, cacheScope: 'public' });
}

function assertModernMeta(meta) {
  const requested = meta[META_PROTOCOL_VERSION];
  if (!SUPPORTED_VERSIONS.includes(requested)) {
    throw new RpcError(RPC_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested });
  }
  if (!isPlainObject(meta[META_CLIENT_CAPABILITIES])) {
    throw new RpcError(RPC_INVALID_PARAMS, `Missing ${META_CLIENT_CAPABILITIES} in _meta`);
  }
}

async function handleModernRequest(method, params) {
  assertModernMeta(params._meta);
  if (method === 'server/discover') {
    return cacheableResult({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} } });
  }
  if (method === 'tools/list') {
    return cacheableResult(toolList());
  }
  if (method === 'tools/call') {
    return modernResult(await callTool(params));
  }
  throw new RpcError(RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

async function handleLegacyRequest(method, params) {
  if (method === 'initialize') {
    return initializeResult(params);
  }
  if (method === 'ping') {
    return {};
  }
  if (method === 'tools/list') {
    return toolList();
  }
  if (method === 'tools/call') {
    return callTool(params);
  }
  if (method === 'server/discover') {
    throw new RpcError(RPC_INVALID_PARAMS, `Missing ${META_PROTOCOL_VERSION} in _meta`);
  }
  throw new RpcError(RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function handleMessage(message) {
  if (!isPlainObject(message)) {
    send({ error: { code: RPC_INVALID_REQUEST, message: 'Invalid request' } });
    return;
  }
  const { id, method } = message;
  if (typeof method !== 'string') {
    // 我們不對 client 發請求，收到的 response 一律略過。
    if (!('result' in message) && !('error' in message)) {
      send({ error: { code: RPC_INVALID_REQUEST, message: 'Invalid request' } });
    }
    return;
  }
  log(`method=${method.slice(0, 64)}`);
  if (id === undefined) {
    return;
  }
  if (typeof id !== 'string' && typeof id !== 'number') {
    send({ error: { code: RPC_INVALID_REQUEST, message: 'Invalid request id' } });
    return;
  }
  const params = isPlainObject(message.params) ? message.params : {};
  const modern = isPlainObject(params._meta) && META_PROTOCOL_VERSION in params._meta;
  try {
    const result = await (modern ? handleModernRequest(method, params) : handleLegacyRequest(method, params));
    send({ id, result });
  } catch (error) {
    if (error instanceof RpcError) {
      send({ id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
      return;
    }
    log(`internal error: ${error.name}`);
    send({ id, error: { code: RPC_INTERNAL_ERROR, message: 'Internal error' } });
  }
}

function handleLine(rawLine) {
  const line = rawLine.trim();
  if (!line) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ error: { code: RPC_PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  handleMessage(message).catch((error) => log(`unhandled: ${error.name}`));
}

function main() {
  log(`started pid=${process.pid} cwd=${process.cwd()}`);
  let buffer = '';
  // setEncoding 會把切在多位元組字中間的 chunk 接好；一個 chunk 可能是半行或好幾行。
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });
  // stdin 關閉是主要的關機訊號。不呼叫 process.exit：POSIX 的 pipe 是非同步寫，
  // 手上的回覆會寫不完；這裡讓事件迴圈清空後自然結束。
  process.stdin.on('end', () => {
    handleLine(buffer);
    buffer = '';
    log('stdin closed');
  });
  process.stdin.on('error', (error) => log(`stdin error: ${error.code}`));
  process.stdout.on('error', (error) => log(`stdout error: ${error.code}`));
}

main();
