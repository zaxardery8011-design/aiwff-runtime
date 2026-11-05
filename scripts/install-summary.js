const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { RECONNECT, detectClaude, readEnvFile } = require('./connect-brain');
const { QUESTION } = require('./first-reply');

const isOn = (value) => value === '1' || String(value).toLowerCase() === 'true';
const provider = (env) => String(env.AIWFF_WORKER_PROVIDER || '').trim().toLowerCase();
const usesClaude = (env) => !isOn(env.MOCK_WORKER) && provider(env) !== 'openai_compatible' && isOn(env.ENABLE_REAL_CLAUDE_WORKER);

function claudeTaskLine(env) {
  if (isOn(env.CLAUDE_BYPASS_APPROVALS) && isOn(env.AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS)) {
    return '開了跳過核可，背景任務動得到這個帳號的所有檔案。';
  }
  // 既有 .env 沒帶 -Brain 時不改，這種人只有這裡看得到要怎麼開。
  return env.AIWFF_CLAUDE_PERMISSION_MODE === 'acceptEdits'
    ? '背景任務只能改自己的工作資料夾，不能跑命令。'
    : `背景任務還沒開放寫檔，交不出結果。要開：${RECONNECT}，選 Claude，再重開小主腦。`;
}

// 判定順序跟 runtime 一樣：MOCK_WORKER 優先於一切，再來 openai_compatible，最後 claude。
function brainLine({ env, root, apiBilling }) {
  if (!isOn(env.MOCK_WORKER) && provider(env) === 'openai_compatible') {
    const isOllama = /:11434\b/.test(env.AIWFF_OPENAI_BASE_URL || '');
    return `大腦：${isOllama ? 'Ollama 本機模型' : 'OpenAI 相容端點，模型'} ${env.AIWFF_OPENAI_MODEL}`;
  }
  if (usesClaude(env)) {
    const billing = apiBilling ? '會走 API 計費，不是訂閱額度' : '會用掉你的訂閱額度';
    return `大腦：Claude（${billing}）。${claudeTaskLine(env)}`;
  }
  return `大腦：現在是模擬，還沒接 AI。要接上：雙擊 ${path.join(root, 'connect-brain.cmd')}`;
}

// 選的大腦沒接上時，要講原因；下一行的 brainLine 講現在實際用的是哪個。
function brainFailedLine({ brainFailed, brainReason }) {
  return brainFailed ? `你選的大腦沒接上：${brainReason || '原因看上面幾行。'}` : null;
}

function replyLine({ reply }) {
  if (reply?.result === 'real') {
    return '第一句測試：收到真回覆。';
  }
  if (reply?.result === 'fail') {
    return `第一句測試：大腦沒回話。${reply.reason}`;
  }
  return reply?.result === 'skipped' ? `第一句測試：略過。${reply.reason}` : null;
}

function failureLine({ failure, port, root }) {
  if (failure === 'port-busy') {
    const envFile = path.join(root, 'suite', 'aiwff-runtime', '.env');
    return `沒開起來：${port} 這個 port 被別的程式佔著。把 ${envFile} 的 PORT 改成別的（例如 3200）再跑一次安裝。`;
  }
  if (failure === 'doctor') {
    return `沒通過健康檢查，原因看 ${path.join(root, 'logs', 'doctor.log')}`;
  }
  return failure ? `沒開起來：小主腦 20 秒內沒回應，原因看 ${path.join(root, 'logs', 'runtime.log')}` : null;
}

function urlLine({ failure, started, port, root, shortcut }) {
  if (failure) {
    return null;
  }
  const opener = path.join(root, 'open-webui.cmd');
  if (!started) {
    return `還沒啟動：雙擊 ${path.join(root, 'start-runtime.cmd')}，再雙擊 ${opener} 打開 http://127.0.0.1:${port}/`;
  }
  return `網址：http://127.0.0.1:${port}/（${shortcut ? '用桌面的 AIWFF 捷徑，或' : ''}雙擊 ${opener} 才會自動登入）`;
}

function desktopLine({ desktop, root }) {
  const connector = path.join(root, 'connect-desktop.cmd');
  return {
    connected: `桌面端：接好了。從系統匣完全結束 Claude 再開才生效；接不上就雙擊 ${connector}`,
    failed: `桌面端：沒接成。再試一次：雙擊 ${connector}`,
    kept: '桌面端：接著。',
    other: `桌面端：接著別的小主腦，這個沒接上。要換成這個：雙擊 ${connector}，照畫面做。`,
    no: `桌面端：沒接。要接上：雙擊 ${connector}`,
    absent: '桌面端：這台電腦沒偵測到 Claude 桌面端。',
  }[desktop];
}

// 最多 8 行。token 不上畫面：登入靠捷徑和 open-webui.cmd，它們自己讀 .env。
function buildSummaryLines(state) {
  const { root, autostart, failure } = state;
  return [
    failureLine(state),
    brainFailedLine(state),
    brainLine(state),
    replyLine(state),
    urlLine(state),
    desktopLine(state),
    autostart ? '開機自動啟動：開。' : `開機自動啟動：關。重開機後雙擊 ${path.join(root, 'start-runtime.cmd')} 再開。`,
    failure ? null : `第一句可以問：到瀏覽器的「對話 / 新任務」分頁打 ${QUESTION}`,
    `移除：雙擊 ${path.join(root, 'uninstall.cmd')}（資料不會刪）`,
  ].filter(Boolean);
}

function buildUninstallLines({ root, desktopTouched, stopped }) {
  return [
    stopped ? '已停掉小主腦，開機排程和桌面捷徑都拿掉了。' : '沒有找到在跑的小主腦，沒有停任何程式。開機排程和桌面捷徑都拿掉了。',
    `資料都還在：${root}。要全部刪掉，請自己刪這個資料夾。`,
    desktopTouched ? '如果 Claude 桌面端開著，要從系統匣完全結束再開，才算完全斷開。' : null,
  ].filter(Boolean);
}

// install.ps1 只能放 ASCII，中文問句放這裡。結束碼 0＝要接、10＝不接。
// 這題會動別的 App 的設定：只有明講要才算要，聽不懂就再問，不當成同意。全形字先轉半形。
async function askDesktop() {
  const rl = readline.createInterface({ input: process.stdin });
  process.stdout.write('要接上 Claude 桌面端嗎？[Y/n] ');
  for await (const line of rl) {
    const answer = line.normalize('NFKC').trim().toLowerCase();
    if (/^(|y|yes|好|要|是)$/.test(answer)) {
      rl.close();
      return 0;
    }
    if (/^(n|no|不|不要|否)$/.test(answer)) {
      rl.close();
      return 10;
    }
    process.stdout.write('請打 y 或 n：');
  }
  return 10;
}

function readReply(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readReason(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ask-desktop') args.askDesktop = true;
    else if (argv[i] === '--uninstall') args.uninstall = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[(i += 1)];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.askDesktop) {
    return askDesktop();
  }
  if (args.uninstall) {
    buildUninstallLines({ root: args.root, desktopTouched: args.desktop === 'touched', stopped: Number(args.stopped) > 0 }).forEach((line) => console.log(line));
    return 0;
  }
  const env = readEnvFile(path.join(args.root, 'suite', 'aiwff-runtime', '.env'));
  const lines = buildSummaryLines({
    root: args.root,
    port: env.PORT || 3100,
    env,
    apiBilling: usesClaude(env) && detectClaude(process.env, env).apiBilling,
    reply: args['reply-file'] ? readReply(args['reply-file']) : null,
    started: args.started === '1',
    autostart: args.autostart === 'on',
    shortcut: args.shortcut === 'on',
    desktop: args.desktop,
    failure: args.failure || '',
    brainFailed: Boolean(args['brain-reason-file']),
    brainReason: args['brain-reason-file'] ? readReason(args['brain-reason-file']) : '',
  });
  lines.forEach((line) => console.log(line));
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { buildSummaryLines, buildUninstallLines };
