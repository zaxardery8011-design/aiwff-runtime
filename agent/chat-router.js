'use strict';
// 訊息路由：AIWFF_MODE = both | chat | task（規格：聊天模式 v0）。
// 純函式，不碰網路、不碰檔案；TG、POST /api/chat、webui 對話框共用這一份判斷。

const COMMANDS = new Set(['/start', '/tasks', '/help']);
// 「明確要做事」v0 只用保守規則：開頭是動作詞，且不是問句。寧可少判成任務。
const ACTION_PREFIX = /^(幫我|請幫|寫一個|建立|產生|做一個|整理|修改|刪除|執行|跑|create\b|write\b|make\b|run\b|fix\b|build\b)/i;
const QUESTION_END = /(\?|？|嗎|呢)$/;

function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return value === 'chat' || value === 'task' ? value : 'both';
}

// 回傳 { kind: 'command'|'task'|'chat', instruction, hint?, notice? }
// - hint：關鍵詞自動判成任務時帶上，回覆要多一行「不是要建任務？下次用 /chat 開頭」。
// - notice='task_disabled'：只聊天模式收到 /task，回覆說明不建任務，不呼叫模型。
function route(rawText, rawMode) {
  const text = String(rawText || '').trim();
  const mode = normalizeMode(rawMode);
  if (COMMANDS.has(text)) return { kind: 'command', instruction: text };

  const taskCmd = text.match(/^\/task(?:\s+([\s\S]*))?$/);
  const chatCmd = text.match(/^\/chat(?:\s+([\s\S]*))?$/);

  if (mode === 'task') {
    return { kind: 'task', instruction: taskCmd ? (taskCmd[1] || '').trim() : text };
  }
  if (mode === 'chat') {
    if (taskCmd) return { kind: 'chat', instruction: text, notice: 'task_disabled' };
    return { kind: 'chat', instruction: chatCmd ? (chatCmd[1] || '').trim() : text };
  }
  if (taskCmd) return { kind: 'task', instruction: (taskCmd[1] || '').trim() };
  if (chatCmd) return { kind: 'chat', instruction: (chatCmd[1] || '').trim() };
  if (ACTION_PREFIX.test(text) && !QUESTION_END.test(text)) {
    return { kind: 'task', instruction: text, hint: 'use /chat to just talk' };
  }
  return { kind: 'chat', instruction: text };
}

module.exports = { route, normalizeMode };
