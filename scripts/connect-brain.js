const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
// install.ps1 把 repo 放在 <Root>\suite\aiwff-runtime；開發環境的 clone 不在 suite 底下，這時是 null。
const INSTALL_ROOT = path.basename(path.dirname(ROOT_DIR)) === 'suite' ? path.resolve(ROOT_DIR, '..', '..') : null;
const OLLAMA_URL = process.env.AIWFF_OLLAMA_URL || 'http://127.0.0.1:11434';
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// 模型名來自 HTTP 回應，會寫進 .env，只收這些字元。
const SAFE_MODEL_NAME = /^[\w.:/-]+$/;
// claude auth status 的 authMethod 裡走 API 計費的值，其他是訂閱或沒登入。
const API_BILLED_AUTH = ['api_key', 'api_key_helper', 'third_party'];
// 第一句驗證等 120 秒，但 runtime 的聊天逾時預設 30 秒，不拉長的話 runtime 會先回 502。
const REAL_CHAT_TIMEOUT_SEC = '120';
const CLAUDE_CODE_URL = 'https://code.claude.com/docs/en/setup';
const CLAUDE_DESKTOP_URL = 'https://claude.com/download';
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
const SMALL_OLLAMA_MODEL = 'qwen2.5:3b';
// 可攜版的 node 不在 PATH，npm run connect 只有開發環境跑得動，所以兩條路都講。
const RECONNECT = '雙擊安裝資料夾的 connect-brain.cmd（開發環境跑 npm run connect）';

const unquote = (value) => value.replace(/^['"]|['"]$/g, '');

// 解析規則要跟 agent/index.js 的 loadDotEnv 一樣：同名取第一個非空值、頭尾引號各去一個。
function parseEnvText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.trim().match(ENV_LINE);
    if (match && String(values[match[1]] ?? '').trim() === '') {
      values[match[1]] = unquote(match[2]);
    }
  }
  return values;
}

// runtime 看到的值：程序環境變數的非空值優先於 .env。
function readEnvFile(envFile, env = process.env) {
  const values = fs.existsSync(envFile) ? parseEnvText(fs.readFileSync(envFile, 'utf8')) : {};
  for (const key of Object.keys(values)) {
    if (String(env[key] ?? '').trim() !== '') {
      values[key] = env[key];
    }
  }
  return values;
}

// 同名的每一行都要改：runtime 取第一個非空值，只改第一行的話後面的舊值會活過來。
// 換行符跟著 split 留在陣列裡接回去，沒動到的行逐字不變。清空一個本來就沒有的鍵不加行。
function applyEnvUpdates(text, updates) {
  // 一個換行就能多塞一行：CLAUDE_BYPASS_APPROVALS 這類鍵不能有機會被帶進來。
  for (const [key, value] of Object.entries(updates)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} 的值含換行，不寫進 .env。`);
    }
  }
  const parts = text.split(/(\r?\n)/);
  const seen = new Set();
  for (let i = 0; i < parts.length; i += 2) {
    const match = parts[i].trim().match(ENV_LINE);
    if (match && Object.hasOwn(updates, match[1])) {
      seen.add(match[1]);
      if (unquote(match[2]) !== updates[match[1]]) {
        parts[i] = `${match[1]}=${updates[match[1]]}`;
      }
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const missing = Object.keys(updates).filter((key) => !seen.has(key) && updates[key] !== '');
  let result = parts.join('');
  if (missing.length && result && !result.endsWith('\n')) {
    result += eol;
  }
  return result + missing.map((key) => `${key}=${updates[key]}${eol}`).join('');
}

function writeEnvFile(envFile, text) {
  const tmpPath = `${envFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, text);
    fs.renameSync(tmpPath, envFile);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function findOnPath(name, env) {
  const exts = process.platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"(.*)"$/, '$1'), `${name}${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (_) {
    return [];
  }
}

// MSIX 版的真資料夾在 LocalCache：一般 shell 看不到 %APPDATA%\Claude，所以先找 LocalCache。
function claudeDataDirs(env) {
  const packages = path.join(env.LOCALAPPDATA || '', 'Packages');
  const cached = listDirs(packages)
    .filter((name) => name.startsWith('Claude_'))
    .map((name) => path.join(packages, name, 'LocalCache', 'Roaming', 'Claude'));
  return [...cached, path.join(env.APPDATA || '', 'Claude')];
}

// 結構是 claude-code\<版本>\<雜湊>\claude.exe，雜湊每版不同，不能寫死。
function findBundledClaude(env = process.env) {
  for (const dataDir of claudeDataDirs(env)) {
    const base = path.join(dataDir, 'claude-code');
    const versions = listDirs(base).filter((name) => /^\d+(\.\d+)*$/.test(name)).sort(compareVersions).reverse();
    for (const version of versions) {
      for (const hash of listDirs(path.join(base, version))) {
        const exe = path.join(base, version, hash, 'claude.exe');
        if (fs.existsSync(exe)) {
          return exe;
        }
      }
    }
  }
  return null;
}

function runClaude(command, args, options) {
  const isScript = /\.(cmd|bat)$/i.test(command);
  return spawnSync(isScript ? `"${command}"` : command, args, { shell: isScript, ...options });
}

// 沒登入時 exit 1 但 stdout 一樣是 JSON，要解析不能當失敗。只拿兩個欄位：
// 回傳物件裡有 email、orgId，不能原樣轉出。讀不出來時 loggedIn 是 null（不知道）。
function readAuthStatus(command, env) {
  const result = runClaude(command, ['auth', 'status', '--json'], { encoding: 'utf8', env, timeout: 15000, windowsHide: true });
  try {
    const status = JSON.parse(result.stdout);
    return { loggedIn: status.loggedIn === true, apiKeyLogin: API_BILLED_AUTH.includes(status.authMethod) };
  } catch (_) {
    return { loggedIn: null, apiKeyLogin: false };
  }
}

// dotenv 是 .env 的值：runtime 啟動時把它灌進 process.env，所以裡面的 key 一樣會讓 claude 走 API 計費。
function detectClaude(env = process.env, dotenv = {}) {
  const onPath = findOnPath('claude', env);
  const found = onPath || findBundledClaude(env);
  const keyBilling = Boolean(env.ANTHROPIC_API_KEY || dotenv.ANTHROPIC_API_KEY);
  if (!found) {
    return { found: false, path: null, source: null, loggedIn: false, apiBilling: keyBilling };
  }
  const { loggedIn, apiKeyLogin } = readAuthStatus(found, env);
  return {
    found: true,
    path: found,
    source: onPath ? 'path' : 'desktop-bundled',
    loggedIn,
    apiBilling: keyBilling || apiKeyLogin,
  };
}

function isChatModel(model) {
  if (Array.isArray(model.capabilities)) {
    return model.capabilities.includes('completion');
  }
  return !/embed|bge|minilm/i.test(model.name);
}

function ollamaInstalled(env) {
  return Boolean(findOnPath('ollama', env)) || fs.existsSync(path.join(env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'));
}

async function detectOllama(env = process.env) {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const { models } = await response.json();
    const names = models.filter(isChatModel).map((model) => model.name).filter((name) => SAFE_MODEL_NAME.test(name));
    return { found: true, installed: true, url: OLLAMA_URL, models: names };
  } catch (_) {
    return { found: false, installed: ollamaInstalled(env), url: OLLAMA_URL, models: [] };
  }
}

async function detectAll(envFile) {
  return { claude: detectClaude(process.env, readEnvFile(envFile, {})), ollama: await detectOllama() };
}

// 內附 exe 的路徑要帶引號，PowerShell 貼上去是語法錯誤；一行安裝的人多半就是在 PowerShell，所以給雙擊。
function claudeLoginHint(claude) {
  if (INSTALL_ROOT) {
    return `Claude 還沒登入。雙擊 ${path.join(INSTALL_ROOT, 'claude-login.cmd')} 登入，再${RECONNECT}。`;
  }
  const command = claude.source === 'path' ? 'claude auth login' : `& "${claude.path}" auth login`;
  return `Claude 還沒登入。先在 PowerShell 跑 ${command}，登入後再${RECONNECT}。`;
}

function planClaude(claude, current) {
  if (!claude.found) {
    return { error: `這台電腦沒裝 Claude。到 ${CLAUDE_CODE_URL} 裝 Claude Code，或到 ${CLAUDE_DESKTOP_URL} 裝 Claude 桌面端，裝好再${RECONNECT}。` };
  }
  if (claude.loggedIn === false) {
    return { error: claudeLoginHint(claude) };
  }
  return {
    label: 'Claude',
    updates: {
      AIWFF_MODE: 'both',
      MOCK_WORKER: '',
      ENABLE_REAL_CLAUDE_WORKER: '1',
      // 內附 exe 也寫 claude：runtime 用 cmd /d /s /c 起它，含空白的完整路徑會被切斷，版本資料夾更新後也會過期。
      // start-runtime.cmd 每次啟動用 --claude-dir 找最新的資料夾補進 PATH。
      CLAUDE_CMD: 'claude',
      AIWFF_WORKER_PROVIDER: '',
      AIWFF_CHAT_TIMEOUT_SEC: current.AIWFF_CHAT_TIMEOUT_SEC || REAL_CHAT_TIMEOUT_SEC,
    },
  };
}

function planOllama(ollama, model, current) {
  if (!ollama.found && !ollama.installed) {
    return { error: `這台電腦沒裝 Ollama。到 ${OLLAMA_DOWNLOAD_URL} 裝好，跑 ollama pull ${SMALL_OLLAMA_MODEL} 下載模型，再${RECONNECT}。` };
  }
  if (!ollama.found) {
    return { error: `Ollama 裝了但沒開（連不到 ${ollama.url}）。先把 Ollama 打開，再${RECONNECT}。` };
  }
  if (!ollama.models.length) {
    return { error: `Ollama 開著但沒有聊天模型。先跑 ollama pull ${SMALL_OLLAMA_MODEL}，再${RECONNECT}。` };
  }
  if (model && !ollama.models.includes(model)) {
    return { error: `Ollama 裡沒有 ${model}。現在有：${ollama.models.join('、')}` };
  }
  // 重跑不指定模型時留著現在用的，不要蓋回清單第一個。
  const chosen = model || (ollama.models.includes(current.AIWFF_OPENAI_MODEL) ? current.AIWFF_OPENAI_MODEL : ollama.models[0]);
  return {
    label: `Ollama 本機模型 ${chosen}`,
    updates: {
      AIWFF_MODE: 'both',
      MOCK_WORKER: '',
      AIWFF_WORKER_PROVIDER: 'openai_compatible',
      AIWFF_OPENAI_BASE_URL: `${ollama.url}/v1`,
      AIWFF_OPENAI_MODEL: chosen,
      AIWFF_CHAT_TIMEOUT_SEC: current.AIWFF_CHAT_TIMEOUT_SEC || REAL_CHAT_TIMEOUT_SEC,
    },
  };
}

function planMock() {
  return {
    label: '模擬回覆（還沒接 AI）',
    updates: {
      AIWFF_MODE: 'both',
      MOCK_WORKER: '1',
      ENABLE_REAL_CLAUDE_WORKER: '',
      CLAUDE_CMD: 'claude',
      AIWFF_WORKER_PROVIDER: '',
      AIWFF_OPENAI_BASE_URL: '',
      AIWFF_OPENAI_MODEL: '',
      AIWFF_CHAT_TIMEOUT_SEC: '',
    },
  };
}

function restartHint() {
  if (INSTALL_ROOT) {
    return `要重開小主腦才會生效：雙擊 ${path.join(INSTALL_ROOT, 'restart-runtime.cmd')}`;
  }
  return '要重開小主腦才會生效：在跑 npm run web 的視窗按 Ctrl+C，再跑一次 npm run web。';
}

function applyBrain(mode, detected, { envFile, model, restart, reasonFile }) {
  // install.ps1 要把原因放進收尾畫面：exit 1 只說得出沒接上。
  const fail = (reason) => {
    console.error(reason);
    if (reasonFile) {
      fs.writeFileSync(reasonFile, reason);
    }
    return 1;
  };
  if (!fs.existsSync(envFile)) {
    return fail(`找不到 ${envFile}。先跑 install.ps1，或把 .env.example 複製成 .env。`);
  }
  const raw = fs.readFileSync(envFile);
  const text = raw.toString('utf8');
  // 用 utf8 讀不是 UTF-8 的檔再寫回，中文會永久變成 U+FFFD。
  if (!Buffer.from(text, 'utf8').equals(raw)) {
    return fail(`${envFile} 不是 UTF-8 編碼，沒有動它。用記事本另存新檔，編碼選 UTF-8，再跑一次。`);
  }
  const current = parseEnvText(text);
  const plans = {
    claude: () => planClaude(detected.claude, current),
    ollama: () => planOllama(detected.ollama, model, current),
    mock: () => planMock(),
  };
  const plan = plans[mode]();
  if (plan.error) {
    return fail(plan.error);
  }
  if (mode === 'claude' && detected.claude.apiBilling) {
    console.log('注意：這台電腦設了 API key，claude 會改走 API 計費，不是訂閱額度。');
  }
  for (const key of Object.keys(plan.updates)) {
    if (String(process.env[key] ?? '').trim() !== '' && process.env[key] !== plan.updates[key]) {
      console.log(`注意：環境變數 ${key} 有值，runtime 會優先用它，改 .env 不會生效。`);
    }
  }
  const updated = applyEnvUpdates(text, plan.updates);
  if (updated !== text) {
    fs.copyFileSync(envFile, `${envFile}.bak`);
    writeEnvFile(envFile, updated);
  }
  console.log(`大腦設定好了：${plan.label}`);
  if (mode === 'claude' && detected.claude.source === 'desktop-bundled' && !INSTALL_ROOT) {
    console.log(`注意：claude 不在 PATH。跑 npm run web 之前，先把 ${path.dirname(detected.claude.path)} 加進 PATH。`);
  }
  if (restart) {
    console.log(restartHint());
  }
  return 0;
}

function ollamaLabel(ollama) {
  if (ollama.found) {
    return 'Ollama（開著但沒有聊天模型）';
  }
  return ollama.installed ? 'Ollama（裝了但沒開）' : 'Ollama（這台電腦沒裝）';
}

function menuOptions({ claude, ollama }, current = {}) {
  const billing = claude.apiBilling ? '會走 API 計費' : '會用掉你的訂閱額度';
  const claudeLabel = !claude.found
    ? 'Claude（這台電腦沒裝）'
    : claude.loggedIn === false
      ? 'Claude（還沒登入）'
      : `Claude（${billing}）`;
  // 現在用的模型排第一：它是這一組裡最先被建議的。
  const models = [...ollama.models].sort((a, b) => (b === current.AIWFF_OPENAI_MODEL) - (a === current.AIWFF_OPENAI_MODEL));
  const ollamaOptions = models.length
    ? models.map((model) => ({ mode: 'ollama', model, label: `Ollama 本機模型 ${model}（跑在這台電腦，不花額度）`, ready: true }))
    : [{ mode: 'ollama', label: ollamaLabel(ollama), ready: false }];
  const options = [
    { mode: 'claude', label: claudeLabel, ready: claude.found && claude.loggedIn !== false },
    ...ollamaOptions,
    { mode: 'mock', label: '先用模擬回覆，之後再接', ready: true },
  ];
  return { options, suggested: options.findIndex((option) => option.ready) };
}

function notReadyReason(option, detected) {
  return option.mode === 'claude' ? planClaude(detected.claude, {}).error : planOllama(detected.ollama, null, {}).error;
}

// 選到不能用的項目就講原因再問一次，每輪重新偵測：使用者可能剛裝好或剛登入。
async function runMenu(options) {
  const current = readEnvFile(options.envFile, {});
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  try {
    for (;;) {
      const detected = await detectAll(options.envFile);
      const menu = menuOptions(detected, current);
      console.log('要讓小主腦接哪一個大腦？');
      menu.options.forEach((option, index) => {
        console.log(`  ${index + 1}) ${option.label}${index === menu.suggested ? '  ← 建議' : ''}`);
      });
      process.stdout.write(`請輸入編號，直接按 Enter 選建議項 [${menu.suggested + 1}]：`);
      const { value, done } = await lines.next();
      if (done) {
        console.log('沒有輸入，不改設定。');
        return 0;
      }
      const answer = value.trim();
      const option = menu.options[answer ? Number(answer) - 1 : menu.suggested];
      if (option?.ready) {
        return applyBrain(option.mode, detected, { ...options, model: option.model });
      }
      console.log(option ? notReadyReason(option, detected) : `只能輸入 1 到 ${menu.options.length}。`);
    }
  } finally {
    rl.close();
  }
}

// claude-login.cmd 走這裡：內附 exe 不在 PATH，使用者沒辦法自己打 claude。
function runLogin() {
  const command = findOnPath('claude', process.env) || findBundledClaude();
  if (!command) {
    console.error(planClaude({ found: false }, {}).error);
    return 1;
  }
  const result = runClaude(command, ['auth', 'login'], { stdio: 'inherit' });
  console.log(`登入完成後，${RECONNECT}。`);
  return result.status ?? 1;
}

// start-runtime.cmd 用：PATH 上沒有 claude 又有內附版時，印出內附版的資料夾。
function bundledClaudeDir(env = process.env) {
  const exe = findOnPath('claude', env) ? null : findBundledClaude(env);
  return exe ? path.dirname(exe) : '';
}

// 不叫 --env-file：Node 22 連腳本後面的參數也會掃這個旗標，把檔案灌進 process.env。
function parseArgs(argv) {
  const args = { envFile: path.join(ROOT_DIR, '.env'), restart: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--detect') args.detect = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--no-restart-hint') args.restart = false;
    else if (argv[i] === '--login') args.login = true;
    else if (argv[i] === '--claude-dir') args.claudeDir = true;
    else if (argv[i] === '--reason-file') args.reasonFile = argv[(i += 1)];
    else if (argv[i] === '--use') args.use = argv[(i += 1)];
    else if (argv[i] === '--model') args.model = argv[(i += 1)];
    else if (argv[i] === '--env-path') args.envFile = argv[(i += 1)];
    else args.bad = argv[i];
  }
  if (args.use !== undefined && !['claude', 'ollama', 'mock'].includes(args.use)) {
    args.bad = `--use ${args.use}`;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad) {
    console.error(`看不懂的參數：${args.bad}。用法：connect-brain.js [--detect --json] [--use claude|ollama|mock [--model <名>]]`);
    return 2;
  }
  if (args.detect) {
    console.log(JSON.stringify(await detectAll(args.envFile), null, 2));
    return 0;
  }
  if (args.claudeDir) {
    console.log(bundledClaudeDir());
    return 0;
  }
  if (args.login) {
    return runLogin();
  }
  if (args.use) {
    return applyBrain(args.use, args.use === 'mock' ? {} : await detectAll(args.envFile), args);
  }
  return runMenu(args);
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  RECONNECT,
  applyEnvUpdates,
  bundledClaudeDir,
  claudeLoginHint,
  compareVersions,
  detectClaude,
  findBundledClaude,
  parseEnvText,
  readEnvFile,
};
