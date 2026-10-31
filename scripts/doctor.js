const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const HEALTH_DIR = path.join(DATA_DIR, 'health');
const HEALTH_RECORD_PATH = path.join(HEALTH_DIR, 'last-run.json');
const PORT = Number(process.env.PORT || 3100);
const JSON_MODE = process.argv.includes('--json');

const UNSAFE_FLAGS = new Set(['CLAUDE_BYPASS_APPROVALS']);

// 「Doctor passed」的分母必須是**實際跑過的檢查**，不是名目上的「doctor」。
// 預設的 text 模式只跑得動下面三項，其餘五項（含攔 CLAUDE_BYPASS_APPROVALS 的 env_valid）
// 只有 --json 會跑；沒有分母時，一個 ✓ 會被讀成「環境全驗過了」。
// DOCTOR_CHECK_IDS 是這支腳本宣告的完整檢查集，兩種模式共用同一份分母來源；
// 未涵蓋清單用差集算出來，新增檢查時 text 模式的揭露會自己長出來。
// （這份宣告與 runJsonDoctor 實際建出來的 checks 可能漂移，所以 regression 直接把
//  text 模式印出的分母釘死等於 --json 的 checks 筆數，漂了就紅。）
const DOCTOR_CHECK_IDS = [
  'node_version',
  'npm_available',
  'git_available',
  'port_available',
  'data_dir_writable',
  'env_valid',
  'claude_cli_optional',
  'tg_config_valid',
];

// text 模式實跑的三項（建 data/tasks 同時證明 data 目錄可寫，故記為 data_dir_writable）。
const TEXT_MODE_CHECK_IDS = ['node_version', 'data_dir_writable', 'port_available'];

// Every load/deny failure must name the rule that produced it, so the reader
// can tell WHICH rule fired instead of getting one merged sentence.
const RULE = {
  ENV_LOAD_FAILED: 'env.load_failed',
  ENV_INVALID_ASSIGNMENT: 'env.parse.invalid_assignment',
  ENV_UNMATCHED_QUOTE: 'env.parse.unmatched_quote',
  ENV_UNSAFE_FLAG: 'env.unsafe_flag',
  DOCTOR_RUNTIME: 'doctor.runtime_error',
  CHECK_TIMEOUT: 'doctor.check_timeout',
};

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// 一項檢查卡住不能讓整個 doctor 跟著掛住：每項各有逾時上限、整體也有總時長上限。
// 卡住的那項記成 timeout（附耗時）然後繼續下一項；總預算用完時剩下的項目直接記 timeout、不再啟動。
const CHECK_TIMEOUT_MS = positiveIntEnv('AIWFF_DOCTOR_CHECK_TIMEOUT_MS', 5000);
const TOTAL_TIMEOUT_MS = positiveIntEnv('AIWFF_DOCTOR_TOTAL_TIMEOUT_MS', 30000);
// 會啟動使用者自訂外部程式（CLAUDE_CMD）的探測改成要明確開啟；npm／git 是固定命令，照常跑。
const PROBE_CLI = process.argv.includes('--probe-cli') || process.env.AIWFF_DOCTOR_PROBE_CLI === '1';
// 測試用：指定的檢查 id 會被換成永遠不回的假檢查，用來驗逾時路徑。
const TEST_HANG_CHECK = process.env.AIWFF_DOCTOR_TEST_HANG_CHECK || '';

function createBudget(totalMs) {
  const deadline = Date.now() + totalMs;
  return { remaining: () => Math.max(0, deadline - Date.now()) };
}

function timeoutCheck(id, detail) {
  const check = makeCheck(id, false, detail, [makeReason(RULE.CHECK_TIMEOUT, detail)]);
  check.timeout = true;
  return check;
}

async function runBounded(id, budget, run) {
  const started = Date.now();
  const limit = Math.min(CHECK_TIMEOUT_MS, budget.remaining());
  if (limit <= 0) {
    const check = timeoutCheck(id, `timeout: not started, doctor total budget ${TOTAL_TIMEOUT_MS}ms exhausted`);
    check.elapsed_ms = 0;
    return check;
  }
  let timer;
  const work = id === TEST_HANG_CHECK ? new Promise(() => {}) : Promise.resolve().then(() => run(limit));
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), limit);
  });
  let check;
  try {
    check = await Promise.race([work, expired]);
  } catch (error) {
    check = makeCheck(id, false, error.message);
  } finally {
    clearTimeout(timer);
  }
  if (!check) {
    check = timeoutCheck(id, `timeout: no result after ${limit}ms`);
  }
  check.elapsed_ms = Date.now() - started;
  return check;
}

function coverage(ranIds, declaredIds = DOCTOR_CHECK_IDS) {
  const ran = declaredIds.filter((id) => ranIds.includes(id));
  return {
    ran: ran.length,
    declared: declaredIds.length,
    not_run: declaredIds.filter((id) => !ranIds.includes(id)),
  };
}

function formatCoverage(value) {
  return `checks_run=${value.ran}/${value.declared} not_run=${value.not_run.join(',') || 'none'}`;
}

function envFlagValue(value) {
  return value === '1' || String(value).toLowerCase() === 'true';
}

// text 模式的三項檢查原本只回 boolean／狀態字串，失敗原因印完就只活在那一行 stdout 上。
// 紅燈要落存「為什麼紅」就得先留得住原因，所以這三支改回 { ok/status, detail }，
// 印出來的字面一個字都沒變，多出來的只是給 recordHealthRun 用的 detail。
function checkNodeVersionText() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    const detail = `Node.js version ${process.version} >= 18`;
    console.log(`PASS ${detail}`);
    return { ok: true, detail };
  }
  const detail = `Node.js version ${process.version} is below 18`;
  console.log(`FAIL ${detail}`);
  return { ok: false, detail };
}

function checkTasksDirectoryText() {
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.accessSync(TASKS_DIR, fs.constants.R_OK | fs.constants.W_OK);
    const detail = `data/tasks can be created at ${path.relative(ROOT_DIR, TASKS_DIR)}`;
    console.log(`PASS ${detail}`);
    return { ok: true, detail };
  } catch (error) {
    const detail = `data/tasks cannot be created: ${error.message}`;
    console.log(`FAIL ${detail}`);
    return { ok: false, detail };
  }
}

function checkPortAvailableText(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        const detail = `port ${port} is already in use`;
        console.log(`WARN ${detail}`);
        resolve({ status: 'warn', detail });
        return;
      }
      const detail = `port ${port} check failed: ${error.message}`;
      console.log(`FAIL ${detail}`);
      resolve({ status: 'fail', detail });
    });
    server.once('listening', () => {
      server.close(() => {
        const detail = `port ${port} is available`;
        console.log(`PASS ${detail}`);
        resolve({ status: 'pass', detail });
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

function makeReason(ruleId, reason) {
  return { rule_id: String(ruleId), reason: String(reason) };
}

function formatReasons(reasons) {
  return reasons.map((item) => `[${item.rule_id}] ${item.reason}`).join('; ');
}

function makeCheck(id, ok, detail, reasons) {
  return {
    id,
    ok: Boolean(ok),
    detail: String(detail || ''),
    reasons: Array.isArray(reasons) ? reasons : [],
  };
}

function quoteCommandPart(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

// spawnSync 會擋住 event loop，runBounded 的計時器搶不到；所以逾時要交給 spawnSync 自己的 timeout 砍子程序。
function commandVersion(command, timeoutMs) {
  let result;
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true };
  if (process.platform === 'win32') {
    const commandLine = [quoteCommandPart(command), '--version'].join(' ');
    result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], options);
  } else {
    result = spawnSync(command, ['--version'], options);
  }
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { ok: false, timeout: true, detail: `timeout: ${command} --version gave no result after ${timeoutMs}ms` };
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/)[0] || 'no version output';
  return {
    ok: result.status === 0,
    detail: result.error ? result.error.message : output,
  };
}

function commandCheck(id, command, timeoutMs) {
  const result = commandVersion(command, timeoutMs);
  return result.timeout ? timeoutCheck(id, result.detail) : makeCheck(id, result.ok, result.detail);
}

function parseDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  const values = {};
  const errors = [];
  if (!fs.existsSync(envPath)) {
    return { exists: false, values, errors };
  }

  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    // The file is there but unreadable: say why it did not load instead of
    // crashing into the generic runtime error.
    errors.push(makeReason(RULE.ENV_LOAD_FAILED, `.env exists but could not be read: ${error.message}`));
    return { exists: true, values, errors };
  }

  const lines = raw.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      errors.push(makeReason(RULE.ENV_INVALID_ASSIGNMENT, `line ${index + 1}: invalid assignment`));
      return;
    }
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] !== quote) {
      errors.push(makeReason(RULE.ENV_UNMATCHED_QUOTE, `line ${index + 1}: unmatched quote`));
      return;
    }
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  });

  return { exists: true, values, errors };
}

function envValue(parsedEnv, name) {
  if (process.env[name] != null && process.env[name] !== '') {
    return process.env[name];
  }
  return parsedEnv.values[name] || '';
}

async function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      resolve({
        ok: false,
        detail: error.code === 'EADDRINUSE' ? `port ${port} is already in use` : error.message,
      });
    });
    server.once('listening', () => {
      server.close(() => resolve({ ok: true, detail: `port ${port} is available` }));
    });
    server.listen(port, '127.0.0.1');
  });
}

// 寫入探針的綠燈必須是「位元組真的落地了」，不是「write 沒有丟例外」。
// writeFileSync 正常返回只證明 syscall 被接受：配額滿、delayed allocation 的滿碟、
// 只把寫入吞掉的同步/掛載層，都能讓呼叫端拿到一個乾淨的返回卻沒有任何位元組落地，
// 於是 doctor 發出綠燈、真正的失敗延到第一個任務寫 data/ 時才炸。
// 所以探針寫完要讀回自己的位元組才算數，且 readback 失敗與 write 失敗分開具名，
// 讀的人看得出斷在哪一半。（同一條紀律已在 examples/mock-worker/worker.js 的
// authoritative write 落地，這裡是把它補到發綠燈的健檢閘上。）
const WRITE_PROBE_PAYLOAD = 'ok';

function checkDataDirWritable() {
  const relDir = path.relative(ROOT_DIR, DATA_DIR);
  let probePath = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    probePath = path.join(DATA_DIR, `.doctor-write-test-${process.pid}`);
    fs.writeFileSync(probePath, WRITE_PROBE_PAYLOAD);
    const readback = fs.readFileSync(probePath, 'utf8');
    if (readback !== WRITE_PROBE_PAYLOAD) {
      return makeCheck(
        'data_dir_writable',
        false,
        `write_readback_mismatch: probe wrote ${WRITE_PROBE_PAYLOAD.length} byte(s) to ${relDir} ` +
          `but read back ${readback.length} — the write was accepted without landing`,
      );
    }
    return makeCheck('data_dir_writable', true, `data directory is writable at ${relDir} (probe bytes read back)`);
  } catch (error) {
    return makeCheck('data_dir_writable', false, error.message);
  } finally {
    // 清理是 best-effort：刪不掉探針檔是留了一個髒檔，不是「目錄不可寫」，
    // 不得讓它翻掉上面已經讀回位元組驗證過的判決。
    if (probePath) {
      try {
        fs.unlinkSync(probePath);
      } catch (cleanupError) {
        console.error(`WARN doctor_write_probe_not_removed: ${probePath} (${cleanupError.code || cleanupError.name})`);
      }
    }
  }
}

function checkEnvValid(parsedEnv) {
  const unsafe = [];
  for (const name of UNSAFE_FLAGS) {
    if (envFlagValue(envValue(parsedEnv, name))) {
      unsafe.push(name);
    }
  }
  if (parsedEnv.errors.length || unsafe.length) {
    const reasons = []
      .concat(parsedEnv.errors)
      .concat(unsafe.map((name) => makeReason(RULE.ENV_UNSAFE_FLAG, `${name} is unsafe for default runs`)));
    return makeCheck('env_valid', false, formatReasons(reasons), reasons);
  }
  return makeCheck('env_valid', true, parsedEnv.exists ? '.env parsed without unsafe flags' : '.env absent; environment is safe');
}

function checkTelegramConfig(parsedEnv) {
  const token = envValue(parsedEnv, 'TG_BOT_TOKEN');
  const adminId = envValue(parsedEnv, 'ADMIN_TG_CHAT_ID');
  if (token && !adminId) {
    return makeCheck('tg_config_valid', false, 'ADMIN_TG_CHAT_ID is required when TG_BOT_TOKEN is set');
  }
  return makeCheck('tg_config_valid', true, token ? 'Telegram token and admin chat id are both set' : 'Telegram token is not set');
}

// 健康紅燈不能只翻一個旗標（exit code）就算交代完：exit 1 說得出「紅了」，說不出
// 哪一項紅、為什麼紅、什麼時候紅的。原因目前只活在 stdout，排程／CI 事後回來看時
// 那段輸出通常已經被沖掉，讀的人只剩一個布林值可以翻。
// 所以每次 doctor 收尾都把判決與具名失敗原因連同 UTC 時戳落成一份記錄。
//
// 為什麼綠燈也寫：只在紅燈寫，恢復成綠燈之後磁碟上那份紅會原地留著，下一個讀的人
// 會把過期的紅當現況——那等於把「翻旗標」的毛病搬到檔案裡。每次覆寫，記錄就永遠
// 是最後一次實跑的結果，checked_at 自己說得出它有多新。
function healthFailuresFromChecks(checks) {
  return checks
    .filter((check) => !check.ok)
    .map((check) => ({
      id: check.id,
      detail: check.detail,
      rule_ids: check.reasons.map((item) => item.rule_id),
    }));
}

function recordHealthRun({ mode, ok, coverage: coverageValue, failures }) {
  const record = {
    checked_at: new Date().toISOString(),
    mode,
    ok: Boolean(ok),
    // 收尾走的是 text 模式時，分母要一起落存：沒有它，一筆 ok:true 會被讀成
    // 「八項全過」，而 text 模式其實只跑得動三項。
    coverage: coverageValue || null,
    failures: Array.isArray(failures) ? failures : [],
  };
  // 落存是 best-effort：寫不出記錄是少了一份證據，不是「健康檢查失敗」，
  // 不得翻掉上面已經算出來的判決（同 doctor_write_probe_not_removed 的分寸）。
  const tempPath = `${HEALTH_RECORD_PATH}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(HEALTH_DIR, { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tempPath, HEALTH_RECORD_PATH);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      void cleanupError;
    }
    console.error(
      `WARN doctor_health_record_not_written: ${HEALTH_RECORD_PATH} (${error.code || error.name}: ${error.message})`,
    );
    return null;
  }
  return record;
}

async function runJsonDoctor() {
  const parsedEnv = parseDotEnv();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const claudeCmd = envValue(parsedEnv, 'CLAUDE_CMD') || 'claude';
  const budget = createBudget(TOTAL_TIMEOUT_MS);

  const plan = [
    ['node_version', () => makeCheck('node_version', nodeMajor >= 18, `${process.version} ${nodeMajor >= 18 ? '>=' : '<'} 18`)],
    ['npm_available', (limit) => commandCheck('npm_available', 'npm', limit)],
    ['git_available', (limit) => commandCheck('git_available', 'git', limit)],
    ['port_available', async () => {
      const port = await probePort(PORT);
      return makeCheck('port_available', port.ok, port.detail);
    }],
    ['data_dir_writable', () => checkDataDirWritable()],
    ['env_valid', () => checkEnvValid(parsedEnv)],
    ['claude_cli_optional', (limit) => {
      if (!PROBE_CLI) {
        return makeCheck('claude_cli_optional', true, `skipped: ${claudeCmd} probe is opt-in (pass --probe-cli)`);
      }
      const claude = commandVersion(claudeCmd, limit);
      return makeCheck('claude_cli_optional', true, claude.ok ? claude.detail : `optional CLI not found: ${claude.detail}`);
    }],
    ['tg_config_valid', () => checkTelegramConfig(parsedEnv)],
  ];
  const checks = [];
  for (const [id, run] of plan) {
    checks.push(await runBounded(id, budget, run));
  }
  const nextActions = [];

  for (const check of checks) {
    if (!check.ok) {
      if (check.reasons.length) {
        // Named reason wins over the generic one-liner: the action says which
        // rule fired, not just which check failed.
        for (const item of check.reasons) {
          nextActions.push(`Fix ${check.id} [${item.rule_id}]: ${item.reason}`);
        }
      } else if (check.id === 'port_available') {
        nextActions.push(`Free port ${PORT} or set PORT to another value.`);
      } else if (check.id === 'tg_config_valid') {
        nextActions.push('Set ADMIN_TG_CHAT_ID or clear TG_BOT_TOKEN.');
      } else {
        nextActions.push(`Fix ${check.id}: ${check.detail}`);
      }
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    next_actions: nextActions,
  };
}

async function runTextDoctor() {
  const node = checkNodeVersionText();
  const dir = checkTasksDirectoryText();
  const portLimit = Math.min(CHECK_TIMEOUT_MS, TOTAL_TIMEOUT_MS);
  let portTimer;
  const port = await Promise.race([
    TEST_HANG_CHECK === 'port_available' ? new Promise(() => {}) : checkPortAvailableText(PORT),
    new Promise((resolve) => {
      portTimer = setTimeout(() => {
        const detail = `port ${PORT} check timeout: no result after ${portLimit}ms`;
        console.log(`FAIL ${detail}`);
        resolve({ status: 'fail', detail });
      }, portLimit);
    }),
  ]);
  clearTimeout(portTimer);
  // 三種收尾都要帶著分母走：PASS 沒帶分母最危險，但 WARN／FAIL 同樣會被當成「doctor 全跑過」。
  const coverageValue = coverage(TEXT_MODE_CHECK_IDS);
  const covered = formatCoverage(coverageValue);
  // WARN 不是紅燈（收場仍是 exit 0），所以不記進 failures；只有真的翻成 FAIL 的才算。
  const failures = [
    { id: 'node_version', ...node },
    { id: 'data_dir_writable', ...dir },
    { id: 'port_available', ok: port.status !== 'fail', detail: port.detail },
  ]
    .filter((item) => !item.ok)
    .map((item) => ({ id: item.id, detail: item.detail, rule_ids: [] }));

  if (node.ok && dir.ok && port.status === 'pass') {
    recordHealthRun({ mode: 'text', ok: true, coverage: coverageValue, failures });
    console.log(
      `✓ Doctor passed — ready to run demo (${covered}; run \`npm run doctor -- --json\` for the checks text mode skips)`,
    );
    return;
  }

  if (node.ok && dir.ok && port.status === 'warn') {
    recordHealthRun({ mode: 'text', ok: true, coverage: coverageValue, failures });
    console.log(
      `Doctor completed with warnings — stop the process using the port before running the default demo (${covered})`,
    );
    return;
  }

  recordHealthRun({ mode: 'text', ok: false, coverage: coverageValue, failures });
  console.log(`FAIL Doctor did not pass (${covered})`);
  process.exitCode = 1;
}

async function main() {
  if (JSON_MODE) {
    const report = await runJsonDoctor();
    recordHealthRun({
      mode: 'json',
      ok: report.ok,
      coverage: coverage(report.checks.map((check) => check.id)),
      failures: healthFailuresFromChecks(report.checks),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  await runTextDoctor();
}

main().catch((error) => {
  // 崩掉是最紅的紅燈，卻也是最容易只留下一個 exit code 的一種：把它一起落存。
  // 這條路徑跑了哪幾項檢查無從得知，coverage 就誠實留 null，不要編一個分母出來。
  recordHealthRun({
    mode: JSON_MODE ? 'json' : 'text',
    ok: false,
    coverage: null,
    failures: [{ id: 'doctor_runtime', detail: error.message, rule_ids: [RULE.DOCTOR_RUNTIME] }],
  });
  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checks: [
            makeCheck('doctor_runtime', false, error.message, [makeReason(RULE.DOCTOR_RUNTIME, error.message)]),
          ],
          next_actions: ['Fix the doctor runtime error and re-run npm run doctor -- --json.'],
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  console.error(`FAIL doctor crashed: ${error.message}`);
  process.exit(1);
});

