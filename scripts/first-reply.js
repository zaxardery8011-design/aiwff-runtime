const fs = require('fs');
const path = require('path');
const { RECONNECT, detectClaude, readEnvFile } = require('./connect-brain');

const ROOT_DIR = path.resolve(__dirname, '..');
// 這句實跑是 kind:"chat"；像指令的句子會被判成任務、跳確認卡，驗不到聊天。
const QUESTION = '你好，用一句話介紹你自己。';
// 跟 agent/index.js 的 MOCK_CHAT_REPLY 同一句。
const MOCK_CHAT_REPLY = '（mock）收到你的訊息。這是 MOCK_WORKER 模式的固定回覆；接上真的模型後，這裡會直接回答。';
const EXIT_CODES = { real: 0, fail: 1, mock: 3, skipped: 4 };

// runtime 的錯誤字來自 CLI 或 HTTP client，openai 路徑逾時也沒有 chat_timeout，所以比內文不只看 code。
const PLAIN_REASONS = [
  [/chat_timeout|timed? ?out|aborted/i, '大腦太久沒回。再試一次，或換小一點的模型。'],
  [/not logged in|\/login|invalid api key|authentication/i, `Claude 還沒登入。雙擊安裝資料夾的 claude-login.cmd（開發環境跑 claude auth login），再${RECONNECT}。`],
  [/usage limit|rate limit|quota|\b429\b/i, '額度用完了，等額度恢復再試。'],
  [/ECONNREFUSED|fetch failed/i, '連不到 Ollama。先把 Ollama 打開再試。'],
  [/model .*not found|\b404\b/i, `找不到這個模型。${RECONNECT}，重選一個。`],
  // Claude 桌面端更新後舊版資料夾會消失：cmd 這時回的是 cannot find the path，不是 not recognized。
  [/ENOENT|not recognized|cannot find the path|系統找不到/i, `找不到 claude 程式，路徑可能過期了。${RECONNECT}，重接一次，再重開小主腦。`],
];

const fail = (reason) => ({ result: 'fail', reason });
const scrub = (text, token) => (token ? text.split(token).join('***') : text);

function plainReason(body) {
  const detail = `${body?.code || ''} ${body?.error || ''}`;
  const known = PLAIN_REASONS.find(([pattern]) => pattern.test(detail));
  return known ? known[1] : `大腦回了錯誤：${String(body?.error || '沒有內容').slice(0, 200)}`;
}

function judge(status, body) {
  if (status === 401) {
    return fail('這個 port 上的 runtime 不認得 .env 的 token，可能是別的安裝佔著 port。');
  }
  if (status === 200 && body?.kind === 'chat') {
    const reply = String(body.reply || '').trim();
    if (body.backend === 'mock' || reply === MOCK_CHAT_REPLY) {
      return { result: 'mock' };
    }
    return reply
      ? { result: 'real', backend: body.backend, elapsed_ms: body.elapsed_ms, reply: reply.slice(0, 200) }
      : fail('大腦回了空白。再試一次，或換一個模型。');
  }
  return body?.ok ? fail(`收到的不是聊天回覆（kind=${body.kind}）。`) : fail(plainReason(body));
}

async function checkFirstReply({ port, token, timeoutSec, noModel, noApiBilling, apiBilling }) {
  const base = `http://127.0.0.1:${port}`;
  let settings;
  try {
    settings = await (await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(5000) })).json();
  } catch (_) {
    return fail(`http://127.0.0.1:${port} 沒有回應，小主腦可能沒開起來。`);
  }
  if (settings.worker_mode === 'mock') {
    return { result: 'mock' };
  }
  // task 模式下 POST /api/chat 會建真任務、花額度，第一句驗證不該這樣做。
  if (settings.chat_mode === 'task') {
    return { result: 'skipped', reason: `.env 沒有 AIWFF_MODE=both，現在每句話都會建任務。${RECONNECT}，補上。` };
  }
  if (noModel) {
    return { result: 'skipped', reason: '這次沒有人在場同意用額度，沒問大腦。' };
  }
  if (noApiBilling && settings.worker_mode === 'claude' && apiBilling()) {
    return { result: 'skipped', reason: '這台電腦的 Claude 走 API 計費，沒有人在場同意花錢，沒問大腦。' };
  }
  // token 空白是 runtime 支援的設定（啟動時自己產生），只是這裡沒辦法問，不算大腦沒回話。
  if (!token) {
    return { result: 'skipped', reason: '.env 的 AIWFF_RUNTIME_TOKEN 是空的，沒辦法問大腦。' };
  }
  try {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aiwff-runtime-token': token },
      // 不帶 conversation_id：帶了會寫進使用者的對話紀錄。
      body: JSON.stringify({ text: QUESTION }),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    const body = await response.json().catch(() => null);
    // 要在 plainReason 截斷之前遮：截斷線切在 token 中間時，前半段就比對不到了。
    if (body?.error) {
      body.error = scrub(String(body.error), token);
    }
    return judge(response.status, body);
  } catch (error) {
    return error.name === 'TimeoutError' ? fail(`等了 ${timeoutSec} 秒大腦都沒回。`) : fail(`問大腦時連線斷了：${error.message}`);
  }
}

function humanLine(verdict) {
  if (verdict.result === 'real') {
    return `第一句收到真回覆：${verdict.reply}`;
  }
  if (verdict.result === 'mock') {
    return '現在是模擬，還沒接 AI。';
  }
  return verdict.result === 'skipped' ? `略過第一句驗證：${verdict.reason}` : `大腦沒回話：${verdict.reason}`;
}

function parseArgs(argv) {
  const args = { envFile: path.join(ROOT_DIR, '.env'), timeoutSec: 120 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--env-path') args.envFile = argv[(i += 1)];
    else if (argv[i] === '--out') args.out = argv[(i += 1)];
    else if (argv[i] === '--timeout-sec') args.timeoutSec = Number(argv[(i += 1)]);
    else if (argv[i] === '--no-model') args.noModel = true;
    else if (argv[i] === '--no-api-billing') args.noApiBilling = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnvFile(args.envFile);
  const token = env.AIWFF_RUNTIME_TOKEN || '';
  const verdict = await checkFirstReply({
    port: env.PORT || process.env.PORT || 3100,
    token,
    timeoutSec: args.timeoutSec,
    noModel: args.noModel,
    noApiBilling: args.noApiBilling,
    apiBilling: () => detectClaude(process.env, env).apiBilling,
  });
  // 錯誤字可能把請求內容帶回來，token 不能跟著落檔或上畫面。
  if (verdict.reason) {
    verdict.reason = scrub(verdict.reason, token);
  }
  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(verdict, null, 2)}\n`);
  }
  console.log(args.json ? JSON.stringify(verdict) : humanLine(verdict));
  return EXIT_CODES[verdict.result];
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { QUESTION };
