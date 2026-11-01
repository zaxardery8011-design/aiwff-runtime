'use strict';
// 多個 bot（規格：聊天 J3）：每個 bot 是 bots/ 底下的一個 Markdown 檔，像通訊軟體的聯絡人。
// 檔名去掉 .md 就是 id；開頭的 frontmatter 只認 name、description、model 三個單行鍵，內文就是聊天人設。
// 只用 node 內建模組；不 require index.js（會循環依賴）。不從 bot 檔讀任何金鑰、token 或環境變數。
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// 第一個字不能是 -：避免被 CLI 當成參數（例如 --add-dir）。不收空白和引號。
const BOT_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;
const MAX_BOT_FILE_BYTES = 64 * 1024;
const MAX_NAME_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 200;

// 沒設定任何 bot 時唯一的內建 bot：人設就是加 bot 之前 chatSystemPrompt 開頭那一句，行為不變。
const BUILTIN_PERSONA = '你是用戶的本地 AI 助理，現在是聊天模式：直接回答用戶這一則訊息。';
const BUILTIN_BOT = Object.freeze({
  id: 'assistant',
  name: '助理',
  description: '',
  model: null,
  persona: BUILTIN_PERSONA,
  builtin: true,
});

function logStderr(context, detail) {
  const message = detail && detail.stack ? detail.stack : detail;
  process.stderr.write(`[${new Date().toISOString()}] ${context}: ${message}\n`);
}

// 每次呼叫都重讀環境變數：測試在 require 之後才把目錄指到系統暫存目錄也有效。
function botsDir() {
  const custom = String(process.env.AIWFF_BOTS_DIR || '').trim();
  return custom ? path.resolve(custom) : path.join(ROOT_DIR, 'bots');
}

function chatStateFile() {
  const custom = String(process.env.AIWFF_CHAT_STATE_FILE || '').trim();
  return custom ? path.resolve(custom) : path.join(ROOT_DIR, 'data', 'chat_state.json');
}

function isValidBotId(id) {
  return typeof id === 'string' && BOT_ID_RE.test(id);
}

function isValidBotModel(value) {
  return typeof value === 'string' && BOT_MODEL_RE.test(value);
}

// 極簡 frontmatter：只認開頭 --- 到 --- 之間的單行「key: value」。
// 不支援多行、巢狀或引號跳脫；值裡的引號原樣保留（model 會因此不合法而被忽略）。
function parseFrontmatter(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    return { fields: {}, body: text };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) {
    return { fields: {}, body: text };
  }
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      fields[key] = match[2].trim();
    }
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

function clipLine(value, maxChars) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxChars);
}

// 讀一個 bot 檔：回 { bot, warnings }；bot 為 null 表示略過。
function readBotFile(dir, fileName) {
  const id = fileName.slice(0, -3);
  const warnings = [];
  if (!isValidBotId(id)) {
    warnings.push(`略過 ${fileName.slice(0, 80)}：檔名要符合 ${BOT_ID_RE}`);
    return { bot: null, warnings };
  }
  const filePath = path.join(dir, fileName);
  let raw;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { bot: null, warnings };
    }
    if (stat.size > MAX_BOT_FILE_BYTES) {
      warnings.push(`略過 ${fileName}：超過 64KB（${stat.size} bytes）`);
      return { bot: null, warnings };
    }
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    warnings.push(`略過 ${fileName}：讀不到（${error.code || error.message}）`);
    return { bot: null, warnings };
  }
  const { fields, body } = parseFrontmatter(raw);
  // 只認 name、description、model，其他鍵一律忽略，也不放進任何回應或 prompt。
  const name = clipLine(fields.name, MAX_NAME_CHARS) || id;
  const description = clipLine(fields.description, MAX_DESCRIPTION_CHARS);
  let model = null;
  if (fields.model !== undefined && fields.model !== '') {
    if (isValidBotModel(fields.model)) {
      model = fields.model;
    } else {
      warnings.push(`${fileName} 的 model 不合法，已忽略（只收英數字和 . _ : / -，第一個字不能是 -）`);
    }
  }
  let persona = body.trim();
  if (!persona) {
    warnings.push(`${fileName} 沒有內文，人設改用內建助理那一句`);
    persona = BUILTIN_PERSONA;
  }
  return { bot: { id, name, description, model, persona, builtin: false }, warnings };
}

// 每次呼叫都重讀目錄：改了 bot 檔不用重開。回 { bots, defaultBot, warnings, dir, source }。
// 目錄不存在、或沒有任何合法檔時，只有內建的 assistant。預設 bot 是依檔名排序的第一個。
function loadBots() {
  const dir = botsDir();
  const warnings = [];
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.push(`bot 目錄讀不到（${error.code || error.message}），只用內建助理`);
    }
  }
  const bots = [];
  for (const fileName of names) {
    if (!fileName.endsWith('.md')) {
      warnings.push(`略過 ${fileName.slice(0, 80)}：副檔名要是小寫 .md`);
      continue;
    }
    const result = readBotFile(dir, fileName);
    warnings.push(...result.warnings);
    if (result.bot) {
      bots.push(result.bot);
    }
  }
  if (!bots.length) {
    return { bots: [BUILTIN_BOT], defaultBot: BUILTIN_BOT, warnings, dir, source: 'builtin' };
  }
  return { bots, defaultBot: bots[0], warnings, dir, source: 'dir' };
}

// 找 bot：id 沒給回預設 bot；給了但不存在回 null。
function findBot(id, catalog = loadBots()) {
  if (id === undefined || id === null || id === '') {
    return catalog.defaultBot;
  }
  return catalog.bots.find((bot) => bot.id === id) || null;
}

// 給 API 用的公開欄位：不含人設內文。
function publicBot(bot, catalog) {
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description,
    model: bot.model,
    is_default: bot.id === catalog.defaultBot.id,
  };
}

// 對話 id：預設 bot 沿用原本的 id；其他 bot 加後綴 -<botId>。組出來的 id 要符合 conversation-store 的格式。
function conversationIdFor(baseId, bot, catalog = loadBots()) {
  if (!bot || bot.id === catalog.defaultBot.id) {
    return baseId;
  }
  const id = `${baseId}-${bot.id}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw Object.assign(new Error('conversation id with bot suffix is too long or invalid'), { code: 'invalid_conversation_id' });
  }
  return id;
}

// 聊天選擇存在 data/chat_state.json：{ telegram: { "<chat id>": "<bot id>" } }。
// 檔案不存在是正常的；寫壞或讀不到就當成空的（退回預設 bot），並記 stderr。
function readChatState() {
  const filePath = chatStateFile();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logStderr('chat-state read', error);
    }
    return { telegram: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    const telegram = parsed.telegram && typeof parsed.telegram === 'object' && !Array.isArray(parsed.telegram) ? parsed.telegram : {};
    return { ...parsed, telegram };
  } catch (error) {
    logStderr('chat-state read', `${filePath} is corrupted, falling back to the default bot: ${error.message}`);
    return { telegram: {} };
  }
}

function writeChatState(value) {
  const filePath = chatStateFile();
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (error) {
    logStderr('chat-state write', error);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (_) {}
    return false;
  }
}

// TG 這個 chat 目前的 bot：沒選過、選的 bot 已經不在了，都退回預設 bot。
function telegramBot(chatId, catalog = loadBots()) {
  const selected = readChatState().telegram[String(chatId)];
  return (isValidBotId(selected) && findBot(selected, catalog)) || catalog.defaultBot;
}

function setTelegramBot(chatId, botId) {
  const state = readChatState();
  state.telegram = { ...state.telegram, [String(chatId)]: botId };
  return writeChatState(state);
}

module.exports = {
  BOT_ID_RE,
  BOT_MODEL_RE,
  MAX_BOT_FILE_BYTES,
  BUILTIN_BOT,
  BUILTIN_PERSONA,
  botsDir,
  chatStateFile,
  isValidBotId,
  isValidBotModel,
  parseFrontmatter,
  loadBots,
  findBot,
  publicBot,
  conversationIdFor,
  readChatState,
  writeChatState,
  telegramBot,
  setTelegramBot,
};
