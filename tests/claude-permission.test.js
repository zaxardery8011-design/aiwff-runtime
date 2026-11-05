// Claude worker 的權限邊界：AIWFF_CLAUDE_PERMISSION_MODE 只收 acceptEdits，開了它就不帶 --add-dir、工具走白名單，
// 結果由 runtime 從工作資料夾搬進 data/artifacts；聊天那條完全不受影響；
// Windows 上工作資料夾裡的 claude.cmd 不能被當成 claude 跑，也不能騙過「指令找不找得到」。
// 同一個 process 內起 runtime，假 CLI 靠 PATH 找到，不叫真 claude。worker 都是跑完自己結束。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');
const WORKSPACES_DIR = path.join(ROOT_DIR, 'data', 'workspaces');
const TOKEN = 'claude-permission-fixed-token';
const AUTH = { 'x-aiwff-runtime-token': TOKEN };
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-claude-permission-'));
const BIN_DIR = path.join(TEMP_DIR, 'bin');
const WINDOWS_ONLY = { skip: process.platform !== 'win32' };
const BOUNDARY_TAIL = ['--disallowedTools', 'Bash,PowerShell'];
const EDITS_ARGS = ['--permission-mode', 'acceptEdits', '--tools', 'Read,Write,Edit,Glob,Grep', '--strict-mcp-config', ...BOUNDARY_TAIL];
const ENV_KEYS = [
  'AIWFF_CLAUDE_PERMISSION_MODE',
  'AIWFF_CLAUDE_ALLOWED_TOOLS',
  'AIWFF_CLAUDE_DISALLOWED_TOOLS',
  'AIWFF_MODE',
  'AIWFF_WORKER_PROVIDER',
  'CLAUDE_BYPASS_APPROVALS',
  'AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS',
  'CLAUDE_CMD',
  'ENABLE_REAL_CLAUDE_WORKER',
  'MOCK_WORKER',
  'NoDefaultCurrentDirectoryInExePath',
  'PATH',
];

let agent;
let server;
let port;
let initialTaskFiles;
const savedEnv = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.once('listening', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
    probe.listen(0, '127.0.0.1');
  });
}

function request(method, route, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...AUTH },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null, raw }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForTaskStatus(taskId, statuses, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { task } = (await request('GET', `/api/tasks/${taskId}`)).json;
    if (statuses.includes(task.status)) {
      return task;
    }
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} stayed ${task.status}, wanted ${statuses.join('/')}`);
    }
    await sleep(100);
  }
}

function taskFileNames() {
  try {
    return fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch (_) {
    return [];
  }
}

// 假 CLI 一律叫 claude、靠 PATH 找到：暫存目錄有空白時，CLAUDE_CMD 寫完整路徑會被 cmd 切斷；
// 暫存目錄有中文時，.cmd 裡寫絕對路徑會被 cmd 的 code page 讀壞，所以內容全 ASCII，路徑走 %~dp0。
function writeFakeClaude(name, scriptBody) {
  const dir = path.join(BIN_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fake-claude.js'), scriptBody);
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n');
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexec node "${0%/*}/fake-claude.js" "$@"\n', { mode: 0o755 });
  process.env.CLAUDE_CMD = 'claude';
  process.env.PATH = systemPath(dir, path.dirname(process.execPath));
}

// stdin 讀完後把 argv、cwd 落到 capture 檔，照 prompt 指定的路徑寫結果檔。
function captureClaude(captureFile) {
  return `
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const out = input.match(/結果請寫到: (.+)/);
  fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), resultPath: out ? out[1].trim() : null }));
  if (out) {
    const target = path.resolve(${JSON.stringify(ROOT_DIR)}, out[1].trim());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'DONE: captured\\n');
  }
  console.log('DONE: captured');
});
`;
}

// 種下去的 .cmd 被跑到時，在自己旁邊留一個 planted.log。
const PLANTED_CMD = '@echo off\r\necho planted>>"%~dp0planted.log"\r\n';

// 模擬一棒能寫 workspace 的 worker：第一棒在 cwd 種 claude.cmd 再問問題，下一棒才交結果。
function plantingClaude(runsFile) {
  return `
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(runsFile)}, 'real\\n');
  const plantedPath = path.join(process.cwd(), 'claude.cmd');
  if (!fs.existsSync(plantedPath)) {
    fs.writeFileSync(plantedPath, ${JSON.stringify(PLANTED_CMD)});
    console.log('BLOCKED: 可以繼續嗎？');
    return;
  }
  const target = path.resolve(${JSON.stringify(ROOT_DIR)}, input.match(/結果請寫到: (.+)/)[1].trim());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'DONE: second run\\n');
  console.log('DONE: second run');
});
`;
}

// 把結果路徑做成 junction 再問問題：一般帳號建得起 junction，lstat 看到的不是一般檔案。
function linkingClaude(target) {
  return `
const fs = require('fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.symlinkSync(${JSON.stringify(target)}, 'RESULT.md', 'junction');
  console.log('BLOCKED: 檔案放好了');
});
`;
}

// 第一棒先寫半成品再失敗；續跑那棒什麼都不寫，只問問題，順便記下 prompt 講的舊結果路徑。
function staleResultClaude(runsFile) {
  return `
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(runsFile)}, input);
  if (input.includes('已改名為')) {
    console.log('BLOCKED: 還要繼續嗎？');
    return;
  }
  fs.writeFileSync(input.match(/結果請寫到: (.+)/)[1].trim(), 'half done\\n');
  process.exit(3);
});
`;
}

function boundaryArgs() {
  const args = [];
  agent.appendClaudeBoundaryArgs(args);
  return args;
}

function captureStderr(run) {
  const original = process.stderr.write;
  let text = '';
  process.stderr.write = (chunk) => {
    text += chunk;
    return true;
  };
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return text;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
    child.stdin.end();
  });
}

// PATH 只留系統資料夾和指定的 bin：這台機器上真的 claude 不能混進來。
function systemPath(...dirs) {
  return [...dirs, path.dirname(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe')].join(path.delimiter);
}

test.before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.AIWFF_CHAT_TIMEOUT_SEC = '10';
  process.env.AIWFF_RUNTIME_TOKEN = TOKEN;
  process.env.AIWFF_CONFIRM_AUTO_TASK = '0';
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
  agent.initRuntimeToken();
  initialTaskFiles = new Set(taskFileNames());
  server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
});

test.beforeEach(() => {
  process.env.PATH = savedEnv.PATH;
  process.env.MOCK_WORKER = '';
  process.env.ENABLE_REAL_CLAUDE_WORKER = '1';
  process.env.AIWFF_WORKER_PROVIDER = '';
  process.env.AIWFF_MODE = 'both';
  process.env.CLAUDE_BYPASS_APPROVALS = '';
  process.env.AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS = '';
  delete process.env.AIWFF_CLAUDE_PERMISSION_MODE;
  delete process.env.AIWFF_CLAUDE_ALLOWED_TOOLS;
  delete process.env.AIWFF_CLAUDE_DISALLOWED_TOOLS;
  // Claude Code 自己的 shell 會帶這個變數，從它裡面跑測試時不拿掉，沒修也是綠的。一般使用者的環境沒有它。
  delete process.env.NoDefaultCurrentDirectoryInExePath;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const name of taskFileNames()) {
    if (initialTaskFiles.has(name)) continue;
    const id = name.replace(/\.json$/, '');
    fs.rmSync(path.join(TASKS_DIR, name), { force: true });
    fs.rmSync(path.join(ARTIFACTS_DIR, id), { recursive: true, force: true });
    fs.rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true });
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test('boundary args: nothing set means no --permission-mode and no warning', () => {
  let args;
  const stderr = captureStderr(() => {
    args = boundaryArgs();
  });
  assert.deepEqual(args, ['--add-dir', ARTIFACTS_DIR, ...BOUNDARY_TAIL]);
  assert.equal(stderr, '');
});

test('boundary args: acceptEdits drops the shared --add-dir and limits the tools, MCP included', () => {
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'acceptEdits';
  let args;
  const stderr = captureStderr(() => {
    args = boundaryArgs();
  });
  assert.deepEqual(args, EDITS_ARGS);
  assert.equal(stderr, '');
});

test('boundary args: every other value is ignored with a warning, bypassPermissions above all', () => {
  const refused = [
    'bypassPermissions',
    'BYPASSPERMISSIONS',
    'dontAsk',
    'plan',
    'default',
    'auto',
    'acceptedits',
    'ACCEPTEDITS',
    'acceptEdits bypassPermissions',
    'acceptEdits --dangerously-skip-permissions',
    '--dangerously-skip-permissions',
  ];
  for (const value of refused) {
    process.env.AIWFF_CLAUDE_PERMISSION_MODE = value;
    let args;
    const stderr = captureStderr(() => {
      args = boundaryArgs();
    });
    assert.deepEqual(args, ['--add-dir', ARTIFACTS_DIR, ...BOUNDARY_TAIL], value);
    assert.match(stderr, /AIWFF_CLAUDE_PERMISSION_MODE/, value);
    assert.match(stderr, /acceptEdits/, value);
  }
});

test('real worker: with acceptEdits the result is written in the workspace and the runtime moves it', async () => {
  const captureFile = path.join(TEMP_DIR, 'accept-edits.json');
  writeFakeClaude('capture-accept-edits', captureClaude(captureFile));
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'acceptEdits';
  const created = (await request('POST', '/api/tasks', { title: 'mode', instruction: 'capture', timeout_sec: 10 })).json;
  const task = await waitForTaskStatus(created.id, ['done']);
  const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  const workspace = path.join(WORKSPACES_DIR, created.id);
  assert.deepEqual(capture.argv, ['--print', ...EDITS_ARGS]);
  assert.equal(path.resolve(capture.cwd), workspace);
  assert.equal(path.resolve(capture.resultPath), path.join(workspace, 'RESULT.md'));
  assert.equal(fs.existsSync(path.join(workspace, 'RESULT.md')), false);
  assert.equal(task.artifact_path, `data/artifacts/${created.id}.result.md`);
  const result = await request('GET', `/api/tasks/${created.id}/result`);
  assert.equal(result.status, 200, result.raw);
  assert.match(result.json.content, /DONE: captured/);
});

test('real worker: without acceptEdits the result path stays in data/artifacts', async () => {
  const captureFile = path.join(TEMP_DIR, 'no-mode.json');
  writeFakeClaude('capture-no-mode', captureClaude(captureFile));
  const created = (await request('POST', '/api/tasks', { title: 'mode', instruction: 'capture', timeout_sec: 10 })).json;
  await waitForTaskStatus(created.id, ['done']);
  const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  assert.deepEqual(capture.argv, ['--print', '--add-dir', ARTIFACTS_DIR, ...BOUNDARY_TAIL]);
  assert.equal(path.resolve(capture.resultPath), path.join(ARTIFACTS_DIR, `${created.id}.result.md`));
});

test('real worker: a link named RESULT.md never becomes the task result', async () => {
  const target = path.join(TEMP_DIR, 'link-target');
  fs.mkdirSync(target, { recursive: true });
  writeFakeClaude('link-result', linkingClaude(target));
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'acceptEdits';
  const created = (await request('POST', '/api/tasks', { title: 'link', instruction: 'link', timeout_sec: 10 })).json;
  const task = await waitForTaskStatus(created.id, ['blocked', 'done', 'failed']);
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocked_reason, 'question');
  assert.equal(fs.lstatSync(path.join(WORKSPACES_DIR, created.id, 'RESULT.md')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(ARTIFACTS_DIR, `${created.id}.result.md`)), false);
  assert.equal((await request('GET', `/api/tasks/${created.id}/result`)).status, 404);
});

test('resume: a result the last run left in the workspace is set aside, not counted as done', async () => {
  const runsFile = path.join(TEMP_DIR, 'stale-runs.log');
  writeFakeClaude('stale-result', staleResultClaude(runsFile));
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'acceptEdits';
  const created = (await request('POST', '/api/tasks', { title: 'stale', instruction: 'stale', timeout_sec: 10 })).json;
  const workspace = path.join(WORKSPACES_DIR, created.id);
  await waitForTaskStatus(created.id, ['failed'], 30000);
  assert.ok(fs.existsSync(path.join(workspace, 'RESULT.md')));

  const resumed = await request('POST', `/api/tasks/${created.id}/resume`, { answer: '繼續' });
  assert.equal(resumed.status, 202, resumed.raw);
  const task = await waitForTaskStatus(created.id, ['done', 'failed', 'blocked'], 30000);
  // 下一棒什麼都沒寫就問問題：舊結果留在原位的話，這裡會被當成完成。
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocked_reason, 'question');
  assert.equal(fs.readFileSync(path.join(workspace, 'RESULT.prev.md'), 'utf8'), 'half done\n');
  assert.match(fs.readFileSync(runsFile, 'utf8'), /RESULT\.prev\.md/);
});

test('settings: claude_task_scope reports what this runtime runs with', async () => {
  const scope = async () => (await request('GET', '/api/settings')).json.claude_task_scope;
  assert.equal(await scope(), 'closed');
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'bypassPermissions';
  assert.equal(await scope(), 'closed');
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'acceptEdits';
  assert.equal(await scope(), 'workspace');
  process.env.CLAUDE_BYPASS_APPROVALS = '1';
  assert.equal(await scope(), 'workspace', 'one bypass flag alone is ignored');
  process.env.AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS = '1';
  assert.equal(await scope(), 'unrestricted');
});

test('real worker: bypassPermissions never reaches the CLI', async () => {
  const captureFile = path.join(TEMP_DIR, 'bypass.json');
  writeFakeClaude('capture-bypass', captureClaude(captureFile));
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'bypassPermissions';
  const created = (await request('POST', '/api/tasks', { title: 'mode', instruction: 'capture', timeout_sec: 10 })).json;
  await waitForTaskStatus(created.id, ['done']);
  const { argv } = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  assert.deepEqual(argv, ['--print', '--add-dir', ARTIFACTS_DIR, ...BOUNDARY_TAIL]);
});

test('chat: the argv is the same with the permission mode on', async () => {
  const captureFile = path.join(TEMP_DIR, 'chat.json');
  writeFakeClaude('capture-chat', captureClaude(captureFile));
  process.env.AIWFF_CLAUDE_PERMISSION_MODE = 'acceptEdits';
  const res = await request('POST', '/api/chat', { text: '你好' });
  assert.equal(res.status, 200, res.raw);
  const { argv } = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  assert.deepEqual(argv, ['--print', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--no-session-persistence']);
});

test('Windows: claude.cmd and claude.bat in the working folder do not run, the one on PATH does', WINDOWS_ONLY, async () => {
  const workdir = fs.mkdtempSync(path.join(TEMP_DIR, 'cwd-'));
  for (const name of ['claude.cmd', 'claude.bat']) {
    fs.writeFileSync(path.join(workdir, name), PLANTED_CMD);
  }
  writeFakeClaude(
    'guard',
    `console.log(JSON.stringify({ guard: process.env.NoDefaultCurrentDirectoryInExePath, token: process.env.AIWFF_RUNTIME_TOKEN || null }));`,
  );
  const { code, stdout } = await waitForChild(agent.spawnClaudeProcess('claude', [], { cwd: workdir }));
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(workdir, 'planted.log')), false, 'cmd.exe ran the file planted in the working folder');
  // 加這個變數不能蓋掉 buildWorkerEnv：runtime 的 token 還是不能給 worker。
  assert.deepEqual(JSON.parse(stdout), { guard: '1', token: null });
});

test('Windows: a worker that plants claude.cmd in its workspace does not get it run on resume', WINDOWS_ONLY, async () => {
  const runsFile = path.join(TEMP_DIR, 'runs.log');
  writeFakeClaude('plant-resume', plantingClaude(runsFile));
  const created = (await request('POST', '/api/tasks', { title: 'plant', instruction: 'plant', timeout_sec: 10 })).json;
  const blocked = await waitForTaskStatus(created.id, ['blocked', 'failed', 'done']);
  assert.equal(blocked.blocked_reason, 'question');
  assert.ok(fs.existsSync(path.join(WORKSPACES_DIR, created.id, 'claude.cmd')));

  const resumed = await request('POST', `/api/tasks/${created.id}/resume`, { answer: '可以' });
  assert.equal(resumed.status, 202, resumed.raw);
  const task = await waitForTaskStatus(created.id, ['done', 'failed', 'blocked']);
  assert.equal(fs.existsSync(path.join(WORKSPACES_DIR, created.id, 'planted.log')), false, 'resume ran the claude.cmd from the workspace');
  assert.equal(task.status, 'done');
  assert.equal(fs.readFileSync(runsFile, 'utf8').trim().split(/\r?\n/).length, 2);
});

test('Windows: claude.cmd in the workspace does not count as finding claude', WINDOWS_ONLY, async () => {
  const runsFile = path.join(TEMP_DIR, 'runs-missing.log');
  writeFakeClaude('plant-missing', plantingClaude(runsFile));
  const created = (await request('POST', '/api/tasks', { title: 'plant', instruction: 'plant', timeout_sec: 10 })).json;
  await waitForTaskStatus(created.id, ['blocked', 'failed', 'done']);

  // 真的 claude 不見了，workspace 裡只剩種下去的那支：要照「找不到」收，不能當成找到再交給 cmd。
  process.env.PATH = systemPath();
  const workspace = path.join(WORKSPACES_DIR, created.id);
  assert.equal(agent.workerCommandExists('claude', workspace, { searchCwd: false }), false);
  const resumed = await request('POST', `/api/tasks/${created.id}/resume`, { answer: '可以' });
  assert.equal(resumed.status, 202, resumed.raw);
  const task = await waitForTaskStatus(created.id, ['done', 'failed', 'blocked']);
  assert.equal(fs.existsSync(path.join(workspace, 'planted.log')), false);
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocked_reason, 'environment');
  assert.equal(task.env_cause, 'missing_tool');
});

test('agy keeps the lookup it had: a bare name in the given folder counts by default', WINDOWS_ONLY, () => {
  const workdir = fs.mkdtempSync(path.join(TEMP_DIR, 'agy-'));
  fs.writeFileSync(path.join(workdir, 'agy-only-here.cmd'), '@echo off\r\n');
  assert.equal(agent.workerCommandExists('agy-only-here', workdir), true);
});
