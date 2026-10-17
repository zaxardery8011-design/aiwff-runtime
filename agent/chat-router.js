'use strict';
// 訊息路由：AIWFF_MODE = both | chat | task（規格：聊天模式 v0）。
// 純函式，不碰網路、不碰檔案；TG、POST /api/chat、webui 對話框共用這一份判斷。

// 指令：不分大小寫、可帶 @bot（TG 群組裡會送 /tasks@MyBot）。
const COMMAND_RE = /^\/(start|tasks|help)(?:@[A-Za-z0-9_]+)?$/i;
// /task、/chat：不分大小寫、可帶 @bot、可省略後面的空格（/task寫一個…）；
// 後面緊接英數字就不算（/tasks、/taskforce 不是 /task）。
const TASK_CMD_RE = /^\/task(?:@[A-Za-z0-9_]+)?(?![A-Za-z0-9_])\s*([\s\S]*)$/i;
const CHAT_CMD_RE = /^\/chat(?:@[A-Za-z0-9_]+)?(?![A-Za-z0-9_])\s*([\s\S]*)$/i;

// 「明確要做事」v0 只用保守規則（規格 §2：動作詞＋受詞、寧可少判成任務）：
// 1. 明講請託＋動作詞：「（請|麻煩）（幫我|幫忙|替我）寫/建立/整理/…」。
//    「幫我解釋一下」「幫我看看」這類請託後面不是動作詞，不算。
// 2. 動作詞＋數量詞＋受詞：「（請）寫一個…」「建立一份…」「做個…」。
//    單獨的「跑步、跑車、執行長、建立關係、整理房間好累」不會中。
// 3. 「請」＋動作詞：「請整理今天的筆記」「請執行測試」。
// 4. 英文：（please）＋動作動詞＋受詞（冠詞/代名詞或檔名）：「write a script」「run the tests」
//    「please write hello.txt」；「make sense」「Run time error…」不中。
// 句子裡有問句記號（？、嗎、呢、什麼、怎麼、為什麼、是誰、多少、如何…）一律不算，交給聊天。
const ZH_VERBS = '寫|建立|產生|生成|做|整理|修改|修正|修|改|刪除|刪|執行|跑|新增|建|重構|翻譯|下載|上傳|部署|安裝';
const ZH_MEASURE = '一個|一份|一支|一篇|一張|一段|一則|一些|個|份|支|篇|張|段';
const ZH_REQUEST_RE = new RegExp(`^(?:請|麻煩)?(?:你)?(?:幫我|幫忙|替我)\\s*(?:${ZH_VERBS})`);
const ZH_MEASURE_RE = new RegExp(`^(?:請)?(?:寫|建立|產生|生成|做|新增|建)\\s*(?:${ZH_MEASURE})\\s*\\S`);
const ZH_PLEASE_RE = new RegExp(`^請(?:${ZH_VERBS})\\s*\\S`);
const EN_ACTION_RE =
  /^(?:please\s+)?(?:create|write|make|build|generate|fix|run|delete|update|refactor)\s+(?:(?:a|an|the|me|my|this|that|these|those|some|all|our)\b|\S+\.[A-Za-z0-9]{1,8}\b)/i;
const QUESTION_RE = /(\?|？|嗎|呢|什麼|甚麼|怎麼|怎樣|為什麼|為何|是誰|多少|如何|哪裡|哪個|哪些|能不能|可不可以|要不要|是不是)/;
const EN_QUESTION_START = /^(?:what|why|how|who|when|where|which|is|are|does|do|can|could|should|would)\b/i;

// 沒設或值不認得一律當 task（跟加聊天模式前一樣，每則訊息建任務）；聊天要使用者自己設 both 或 chat。
function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return value === 'chat' || value === 'both' ? value : 'task';
}

function looksLikeAction(text) {
  if (QUESTION_RE.test(text) || EN_QUESTION_START.test(text)) {
    return false;
  }
  return ZH_REQUEST_RE.test(text) || ZH_MEASURE_RE.test(text) || ZH_PLEASE_RE.test(text) || EN_ACTION_RE.test(text);
}

// 回傳 { kind: 'command'|'task'|'chat', instruction, hint?, notice? }
// - hint：關鍵詞自動判成任務時帶上，回覆要多一行「不是要建任務？下次用 /chat 開頭」。
// - notice='task_disabled'：只聊天模式收到 /task，回覆說明不建任務，不呼叫模型。
function route(rawText, rawMode) {
  const text = String(rawText || '').trim();
  const mode = normalizeMode(rawMode);
  const command = text.match(COMMAND_RE);
  if (command) return { kind: 'command', instruction: `/${command[1].toLowerCase()}` };

  const taskCmd = text.match(TASK_CMD_RE);
  const chatCmd = text.match(CHAT_CMD_RE);

  if (mode === 'task') {
    return { kind: 'task', instruction: taskCmd ? (taskCmd[1] || '').trim() : text };
  }
  if (mode === 'chat') {
    if (taskCmd) return { kind: 'chat', instruction: text, notice: 'task_disabled' };
    return { kind: 'chat', instruction: chatCmd ? (chatCmd[1] || '').trim() : text };
  }
  if (taskCmd) return { kind: 'task', instruction: (taskCmd[1] || '').trim() };
  if (chatCmd) return { kind: 'chat', instruction: (chatCmd[1] || '').trim() };
  if (looksLikeAction(text)) {
    return { kind: 'task', instruction: text, hint: 'use /chat to just talk' };
  }
  return { kind: 'chat', instruction: text };
}

module.exports = { route, normalizeMode };
