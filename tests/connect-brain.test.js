const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT_DIR, 'scripts', 'connect-brain.js');
const INSTALLER = path.join(ROOT_DIR, 'install.ps1');
const { applyEnvUpdates, compareVersions, findBundledClaude, parseEnvText } = require('../scripts/connect-brain');

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'leak-me@example.com',
  orgId: 'org-leak-id',
  orgName: 'Leaky Org',
  subscriptionType: 'max',
});
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });

const ENV_SAMPLE = [
  '# Runtime environment variables',
  'PORT=3100',
  'AIWFF_RUNTIME_TOKEN=test-token-value',
  'TG_BOT_TOKEN=',
  '# 聊天模式：both 是一般訊息直接聊天',
  'AIWFF_MODE=both',
  'CLAUDE_CMD=claude',
  'MOCK_WORKER=1',
  'ENABLE_REAL_CLAUDE_WORKER=',
  'CLAUDE_BYPASS_APPROVALS=',
  'AIWFF_WORKER_PROVIDER=',
  'AGY_CMD=agy',
  '',
].join('\r\n');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-connect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFakeClaude(dir, json, exitCode = 0) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), json);
  // Windows 找 claude.cmd，其他平台找沒副檔名的 claude（CI 是 ubuntu）。
  // 內容全 ASCII，路徑走 %~dp0：暫存目錄有中文時，寫絕對路徑會被 cmd 的 code page 讀壞。
  fs.writeFileSync(path.join(dir, 'claude.cmd'), `@echo off\r\ntype "%~dp0auth.json"\r\nexit /b ${exitCode}\r\n`);
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\ncat "\${0%/*}/auth.json"\nexit ${exitCode}\n`, { mode: 0o755 });
}

function writeFakeOllamaBinary(tmp) {
  fs.writeFileSync(path.join(tmp, 'bin', 'ollama.exe'), '');
  fs.writeFileSync(path.join(tmp, 'bin', 'ollama'), '');
}

// 子程序只看得到暫存的 PATH／APPDATA：測試機真的 claude、真的桌面端資料夾都不能被讀到。
function childEnv(tmp, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(path|anthropic_api_key|mock_worker|enable_real_claude_worker|aiwff_.*|claude_cmd)$/i.test(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    PATH: path.join(tmp, 'bin'),
    LOCALAPPDATA: path.join(tmp, 'local'),
    APPDATA: path.join(tmp, 'roaming'),
    AIWFF_OLLAMA_URL: 'http://127.0.0.1:9',
    ...overrides,
  };
}

function runScript(args, { env, input, script = SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    child.stdin.end(input || '');
  });
}

function startFakeOllama(t, models) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

const QWEN = { name: 'qwen2.5:3b', capabilities: ['completion', 'tools'], details: { family: 'qwen2' } };
const EMBED = { name: 'nomic-embed-text:latest', capabilities: ['embedding'], details: { family: 'nomic-bert' } };

function setupEnvFile(tmp, text = ENV_SAMPLE) {
  const envFile = path.join(tmp, '.env');
  fs.writeFileSync(envFile, text);
  return envFile;
}

test('detect reports a logged-in CLI on PATH and never prints account identity', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const result = await runScript(['--detect', '--json'], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  const detected = JSON.parse(result.stdout);
  assert.equal(detected.claude.found, true);
  assert.equal(detected.claude.source, 'path');
  assert.equal(detected.claude.loggedIn, true);
  assert.equal(path.dirname(detected.claude.path), path.join(tmp, 'bin'));
  assert.doesNotMatch(result.all, /leak-me|org-leak-id|Leaky Org|subscriptionType|email/i);
});

test('detect treats auth status exit 1 as logged out, not as a failure', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_OUT, 1);
  const result = await runScript(['--detect', '--json'], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  const detected = JSON.parse(result.stdout);
  assert.equal(detected.claude.found, true);
  assert.equal(detected.claude.loggedIn, false);
});

test('detect finds nothing on an empty machine', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const result = await runScript(['--detect', '--json'], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  const detected = JSON.parse(result.stdout);
  assert.deepEqual(detected.claude, { found: false, path: null, source: null, loggedIn: false, apiBilling: false });
  assert.equal(detected.ollama.found, false);
  assert.deepEqual(detected.ollama.models, []);
});

test('version compare is numeric, not lexical', () => {
  assert.ok(compareVersions('2.1.293', '2.1.50') > 0);
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0);
  assert.equal(compareVersions('2.1.3', '2.1.3'), 0);
});

function bundledExe(claudeDir, version, hash) {
  const dir = path.join(claudeDir, 'claude-code', version, hash);
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'claude.exe');
  fs.writeFileSync(exe, '');
  return exe;
}

test('bundled claude: LocalCache beats %APPDATA%, newest version wins, hash folder is walked', (t) => {
  const tmp = tempDir(t);
  const local = path.join(tmp, 'local');
  const roaming = path.join(tmp, 'roaming');
  const cache = path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  bundledExe(cache, '2.1.50', 'aaaa');
  const newest = bundledExe(cache, '2.1.293', '83cb0bd7fed4');
  bundledExe(path.join(roaming, 'Claude'), '9.9.9', 'bbbb');
  assert.equal(findBundledClaude({ LOCALAPPDATA: local, APPDATA: roaming }), newest);
});

test('bundled claude: falls back to %APPDATA% when there is no LocalCache copy', (t) => {
  const tmp = tempDir(t);
  const roaming = path.join(tmp, 'roaming');
  const exe = bundledExe(path.join(roaming, 'Claude'), '2.1.289', 'e1f0154146bb');
  assert.equal(findBundledClaude({ LOCALAPPDATA: path.join(tmp, 'local'), APPDATA: roaming }), exe);
  assert.equal(findBundledClaude({ LOCALAPPDATA: path.join(tmp, 'none'), APPDATA: path.join(tmp, 'none') }), null);
});

test('detect reports a bundled exe with source desktop-bundled when PATH has no claude', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const exe = bundledExe(path.join(tmp, 'roaming', 'Claude'), '2.1.293', 'hash');
  const result = await runScript(['--detect', '--json'], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  const detected = JSON.parse(result.stdout);
  assert.equal(detected.claude.found, true);
  assert.equal(detected.claude.path, exe);
  assert.equal(detected.claude.source, 'desktop-bundled');
  assert.notEqual(detected.claude.loggedIn, true);
});

test('detect lists ollama models without embedding models', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const url = await startFakeOllama(t, [EMBED, QWEN, { name: 'old-model:7b' }, { name: 'mxbai-embed-large:latest' }]);
  const result = await runScript(['--detect', '--json'], { env: childEnv(tmp, { AIWFF_OLLAMA_URL: url }) });
  assert.equal(result.code, 0, result.all);
  const detected = JSON.parse(result.stdout);
  assert.equal(detected.ollama.found, true);
  assert.equal(detected.ollama.url, url);
  assert.deepEqual(detected.ollama.models, ['qwen2.5:3b', 'old-model:7b']);
});

test('--use claude changes only its keys, keeps every other line byte for byte, keeps CRLF', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  const text = fs.readFileSync(envFile, 'utf8');
  const lines = text.split('\r\n');
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  assert.ok(lines.includes('MOCK_WORKER='));
  assert.ok(lines.includes('ENABLE_REAL_CLAUDE_WORKER=1'));
  assert.ok(lines.includes('CLAUDE_CMD=claude'));
  assert.ok(lines.includes('AIWFF_WORKER_PROVIDER='));
  assert.ok(lines.includes('AIWFF_MODE=both'));
  // 背景任務沒有人按允許，不開這個連結果檔都寫不了。
  assert.ok(lines.includes('AIWFF_CLAUDE_PERMISSION_MODE=acceptEdits'));
  // runtime 的聊天逾時預設 30 秒，比第一句驗證的 120 秒短；接真大腦時要一起拉長。
  assert.ok(lines.includes('AIWFF_CHAT_TIMEOUT_SEC=120'));
  for (const kept of ['PORT=3100', 'AIWFF_RUNTIME_TOKEN=test-token-value', 'CLAUDE_BYPASS_APPROVALS=', 'AGY_CMD=agy', '# 聊天模式：both 是一般訊息直接聊天']) {
    assert.ok(lines.includes(kept), kept);
  }
  assert.doesNotMatch(result.all, /test-token-value/);
  assert.match(result.all, /重開/);
});

test('--use claude keeps CLAUDE_CMD=claude for the bundled exe: a full path with a space cannot start', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const exe = bundledExe(path.join(tmp, 'John Smith', 'Claude'), '2.1.293', 'hash');
  const envFile = setupEnvFile(tmp);
  // 0 byte 的假 exe 跑不起來，loggedIn 是「不知道」：不擋，交給第一句驗證判。
  const env = childEnv(tmp, { APPDATA: path.join(tmp, 'John Smith') });
  const result = await runScript(['--use', 'claude', '--env-path', envFile], { env });
  assert.equal(result.code, 0, result.all);
  assert.ok(fs.readFileSync(envFile, 'utf8').split('\r\n').includes('CLAUDE_CMD=claude'));
  // 沒有 launcher 的開發環境要自己加 PATH，不能什麼都不講。
  assert.ok(result.stdout.includes(path.dirname(exe)));
});

test('--claude-dir prints the bundled folder for the launcher, nothing when PATH has claude', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const exe = bundledExe(path.join(tmp, 'roaming', 'Claude'), '2.1.293', 'hash');
  const bundled = await runScript(['--claude-dir'], { env: childEnv(tmp) });
  assert.equal(bundled.code, 0, bundled.all);
  assert.equal(bundled.stdout.trim(), path.dirname(exe));
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const onPath = await runScript(['--claude-dir'], { env: childEnv(tmp) });
  assert.equal(onPath.code, 0, onPath.all);
  assert.equal(onPath.stdout.trim(), '');
});

test('--login runs claude auth login; with no claude it gives the download pages', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const missing = await runScript(['--login'], { env: childEnv(tmp) });
  assert.equal(missing.code, 1);
  assert.match(missing.all, /https:\/\/code\.claude\.com/);
  writeFakeClaude(path.join(tmp, 'bin'), 'FAKE-LOGIN-RAN');
  const result = await runScript(['--login'], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  assert.match(result.stdout, /FAKE-LOGIN-RAN/);
});

// connect-brain.js 用自己的位置判斷是不是一行安裝：放到 <Root>\suite\aiwff-runtime 底下跑。
function installedScript(tmp) {
  const dir = path.join(tmp, 'Root', 'suite', 'aiwff-runtime', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'connect-brain.js'));
  return path.join(dir, 'connect-brain.js');
}

test('installed layout: login and restart hints are double-clicks, not a line to paste into PowerShell', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_OUT, 1);
  const script = installedScript(tmp);
  const envFile = setupEnvFile(tmp);
  const out = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp), script });
  assert.equal(out.code, 1);
  assert.ok(out.all.includes(path.join(tmp, 'Root', 'claude-login.cmd')));
  const mock = await runScript(['--use', 'mock', '--env-path', envFile], { env: childEnv(tmp), script });
  assert.ok(mock.all.includes(path.join(tmp, 'Root', 'restart-runtime.cmd')));
  assert.doesNotMatch(mock.all, /powershell/i);
});

test('dev layout: a bundled, logged-out claude hint is valid PowerShell', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const exe = bundledExe(path.join(tmp, 'roaming', 'Claude'), '2.1.293', 'hash');
  const { claudeLoginHint } = require('../scripts/connect-brain');
  assert.ok(claudeLoginHint({ source: 'desktop-bundled', path: exe }).includes(`& "${exe}" auth login`));
  assert.match(claudeLoginHint({ source: 'path', path: 'claude' }), /跑 claude auth login/);
});

test('--use claude refuses when logged out and leaves .env untouched', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_OUT, 1);
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 1);
  assert.equal(fs.readFileSync(envFile, 'utf8'), ENV_SAMPLE);
  assert.match(result.all, /auth login/);
});

test('--use claude refuses when no claude exists and says where to get it', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 1);
  assert.equal(fs.readFileSync(envFile, 'utf8'), ENV_SAMPLE);
  assert.match(result.all, /https:\/\/code\.claude\.com\/docs\/en\/setup/);
  assert.match(result.all, /https:\/\/claude\.com\/download/);
});

test('--reason-file keeps the plain reason for the final screen', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp);
  const reasonFile = path.join(tmp, 'reason.txt');
  const result = await runScript(['--use', 'ollama', '--env-path', envFile, '--reason-file', reasonFile], { env: childEnv(tmp) });
  assert.equal(result.code, 1);
  assert.match(fs.readFileSync(reasonFile, 'utf8'), /Ollama/);
});

test('--use ollama adds the missing keys once and re-running changes nothing', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const url = await startFakeOllama(t, [EMBED, QWEN]);
  const envFile = setupEnvFile(tmp);
  const env = childEnv(tmp, { AIWFF_OLLAMA_URL: url });
  const first = await runScript(['--use', 'ollama', '--env-path', envFile], { env });
  assert.equal(first.code, 0, first.all);
  const text = fs.readFileSync(envFile, 'utf8');
  const lines = text.split('\r\n');
  assert.ok(lines.includes('MOCK_WORKER='));
  assert.ok(lines.includes('AIWFF_WORKER_PROVIDER=openai_compatible'));
  assert.ok(lines.includes(`AIWFF_OPENAI_BASE_URL=${url}/v1`));
  assert.ok(lines.includes('AIWFF_OPENAI_MODEL=qwen2.5:3b'));
  assert.ok(lines.includes('AIWFF_MODE=both'));
  assert.ok(lines.includes('AIWFF_CHAT_TIMEOUT_SEC=120'));
  const second = await runScript(['--use', 'ollama', '--env-path', envFile], { env });
  assert.equal(second.code, 0, second.all);
  assert.equal(fs.readFileSync(envFile, 'utf8'), text);
});

test('--use ollama --model picks a named model and rejects an unknown one', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const url = await startFakeOllama(t, [QWEN, { name: 'llama3:8b', capabilities: ['completion'] }]);
  const envFile = setupEnvFile(tmp);
  const env = childEnv(tmp, { AIWFF_OLLAMA_URL: url });
  const ok = await runScript(['--use', 'ollama', '--model', 'llama3:8b', '--env-path', envFile], { env });
  assert.equal(ok.code, 0, ok.all);
  assert.ok(fs.readFileSync(envFile, 'utf8').split('\r\n').includes('AIWFF_OPENAI_MODEL=llama3:8b'));
  const before = fs.readFileSync(envFile, 'utf8');
  const bad = await runScript(['--use', 'ollama', '--model', 'nope:1b', '--env-path', envFile], { env });
  assert.equal(bad.code, 1);
  assert.equal(fs.readFileSync(envFile, 'utf8'), before);
  assert.match(bad.all, /qwen2\.5:3b/);
});

test('--use ollama fails in plain words when ollama is not running or has no model', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp);
  const down = await runScript(['--use', 'ollama', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(down.code, 1);
  assert.match(down.all, /沒裝 Ollama/);
  assert.match(down.all, /https:\/\/ollama\.com\/download/);
  assert.match(down.all, /ollama pull/);
  // 裝了沒開：不要叫人再去下載一次。
  writeFakeOllamaBinary(tmp);
  const stopped = await runScript(['--use', 'ollama', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(stopped.code, 1);
  assert.match(stopped.all, /裝了但沒開/);
  assert.doesNotMatch(stopped.all, /ollama\.com/);
  const url = await startFakeOllama(t, [EMBED]);
  const empty = await runScript(['--use', 'ollama', '--env-path', envFile], { env: childEnv(tmp, { AIWFF_OLLAMA_URL: url }) });
  assert.equal(empty.code, 1);
  assert.match(empty.all, /ollama pull/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), ENV_SAMPLE);
});

test('--use ollama without --model keeps the model already in .env', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const url = await startFakeOllama(t, [QWEN, { name: 'llama3:8b', capabilities: ['completion'] }]);
  const envFile = setupEnvFile(tmp, 'MOCK_WORKER=\nAIWFF_OPENAI_MODEL=llama3:8b\n');
  const result = await runScript(['--use', 'ollama', '--env-path', envFile], { env: childEnv(tmp, { AIWFF_OLLAMA_URL: url }) });
  assert.equal(result.code, 0, result.all);
  assert.equal(parseEnvText(fs.readFileSync(envFile, 'utf8')).AIWFF_OPENAI_MODEL, 'llama3:8b');
});

test('a model name with a newline never reaches .env', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const url = await startFakeOllama(t, [{ name: 'x\nCLAUDE_BYPASS_APPROVALS=1', capabilities: ['completion'] }]);
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--use', 'ollama', '--env-path', envFile], { env: childEnv(tmp, { AIWFF_OLLAMA_URL: url }) });
  assert.equal(result.code, 1);
  assert.equal(fs.readFileSync(envFile, 'utf8'), ENV_SAMPLE);
  // 名字不合格的模型當成沒有，第二道換行檢查才不用出來擋。
  assert.match(result.all, /沒有聊天模型/);
  assert.throws(() => applyEnvUpdates('A=1\n', { A: 'x\nCLAUDE_BYPASS_APPROVALS=1' }), /換行/);
  assert.throws(() => applyEnvUpdates('A=1\n', { A: 'x\rB=1' }), /換行/);
});

test('a .env that is not UTF-8 is refused byte for byte, in plain words', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = path.join(tmp, '.env');
  // Big5 的「設定」。
  const raw = Buffer.concat([Buffer.from('# '), Buffer.from([0xb3, 0x5d, 0xa9, 0x77]), Buffer.from('\r\nMOCK_WORKER=1\r\n')]);
  fs.writeFileSync(envFile, raw);
  const result = await runScript(['--use', 'mock', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 1);
  assert.match(result.all, /UTF-8/);
  assert.deepEqual(fs.readFileSync(envFile), raw);
});

test('a change leaves .env.bak with the old text; no change leaves no backup', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp, 'MOCK_WORKER=1\nAIWFF_MODE=both\nENABLE_REAL_CLAUDE_WORKER=\nCLAUDE_CMD=claude\nAIWFF_OPENAI_MODEL=mine\n');
  const before = fs.readFileSync(envFile, 'utf8');
  assert.equal((await runScript(['--use', 'mock', '--env-path', envFile], { env: childEnv(tmp) })).code, 0);
  assert.equal(fs.readFileSync(`${envFile}.bak`, 'utf8'), before);
  fs.rmSync(`${envFile}.bak`);
  assert.equal((await runScript(['--use', 'mock', '--env-path', envFile], { env: childEnv(tmp) })).code, 0);
  assert.equal(fs.existsSync(`${envFile}.bak`), false);
});

test('--use mock restores the defaults after ollama', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const url = await startFakeOllama(t, [QWEN]);
  const envFile = setupEnvFile(tmp);
  const env = childEnv(tmp, { AIWFF_OLLAMA_URL: url });
  assert.equal((await runScript(['--use', 'ollama', '--env-path', envFile], { env })).code, 0);
  const back = await runScript(['--use', 'mock', '--env-path', envFile], { env });
  assert.equal(back.code, 0, back.all);
  const parsed = parseEnvText(fs.readFileSync(envFile, 'utf8'));
  assert.equal(parsed.MOCK_WORKER, '1');
  assert.equal(parsed.ENABLE_REAL_CLAUDE_WORKER, '');
  assert.equal(parsed.AIWFF_WORKER_PROVIDER, '');
  assert.equal(parsed.AIWFF_OPENAI_BASE_URL, '');
  assert.equal(parsed.AIWFF_OPENAI_MODEL, '');
  assert.equal(parsed.AIWFF_CHAT_TIMEOUT_SEC, '');
  assert.equal(parsed.CLAUDE_CMD, 'claude');
  assert.equal(parsed.AIWFF_MODE, 'both');
});

test('only claude gets the permission mode: an old .env gains it once, ollama and mock clear it', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const url = await startFakeOllama(t, [QWEN]);
  const envFile = setupEnvFile(tmp);
  const env = childEnv(tmp, { AIWFF_OLLAMA_URL: url });
  const mode = () => parseEnvText(fs.readFileSync(envFile, 'utf8')).AIWFF_CLAUDE_PERMISSION_MODE;
  assert.equal((await runScript(['--use', 'claude', '--env-path', envFile], { env })).code, 0);
  assert.equal(mode(), 'acceptEdits');
  assert.equal((await runScript(['--use', 'claude', '--env-path', envFile], { env })).code, 0);
  assert.equal(fs.readFileSync(envFile, 'utf8').match(/^AIWFF_CLAUDE_PERMISSION_MODE=/gm).length, 1);
  assert.equal((await runScript(['--use', 'ollama', '--env-path', envFile], { env })).code, 0);
  assert.equal(mode(), '');
  assert.equal((await runScript(['--use', 'claude', '--env-path', envFile], { env })).code, 0);
  assert.equal(mode(), 'acceptEdits');
  assert.equal((await runScript(['--use', 'mock', '--env-path', envFile], { env })).code, 0);
  assert.equal(mode(), '');
});

test('every mode ensures AIWFF_MODE=both, even when the key is missing or only commented out', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp, '# AIWFF_MODE=task\nMOCK_WORKER=1\n');
  const result = await runScript(['--use', 'mock', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  assert.equal(lines[0], '# AIWFF_MODE=task');
  assert.ok(lines.includes('AIWFF_MODE=both'));
  assert.equal(lines.filter((line) => line.startsWith('MOCK_WORKER=')).length, 1);
});

test('env parsing and editing follow loadDotEnv: every duplicate line is rewritten', () => {
  // runtime 取「第一個非空值」：只改第一行的話，第二行的 1 會活過來。
  const text = 'MOCK_WORKER=1\r\n  MOCK_WORKER=1\r\nX="quoted"\r\n';
  assert.deepEqual(parseEnvText('A=\nA=2\nA=3\nB=\'q\'\n#C=1\nD = 1\n'), { A: '2', B: 'q' });
  const edited = applyEnvUpdates(text, { MOCK_WORKER: '', X: 'quoted' });
  assert.equal(edited, 'MOCK_WORKER=\r\nMOCK_WORKER=\r\nX="quoted"\r\n');
  assert.equal(parseEnvText(edited).MOCK_WORKER, '');
  assert.equal(applyEnvUpdates('A=1', { B: '2' }), 'A=1\nB=2\n');
  assert.equal(applyEnvUpdates('A=1\n', { B: '' }), 'A=1\n', 'clearing a key that is not there adds nothing');
});

test('the .env being edited does not leak into process.env and fake a shadow warning', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--use', 'mock', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  assert.doesNotMatch(result.all, /環境變數/);
  const second = await runScript(['--use', 'mock', '--env-path', envFile], { env: childEnv(tmp) });
  assert.doesNotMatch(second.all, /環境變數/);
});

test('ANTHROPIC_API_KEY triggers the billing warning without printing the value', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const envFile = setupEnvFile(tmp);
  const env = childEnv(tmp, { ANTHROPIC_API_KEY: 'sk-ant-secret-value' });
  const result = await runScript(['--use', 'claude', '--env-path', envFile], { env });
  assert.equal(result.code, 0, result.all);
  assert.match(result.all, /API 計費/);
  assert.doesNotMatch(result.all, /sk-ant-secret-value/);
  const detect = await runScript(['--detect', '--json'], { env });
  assert.doesNotMatch(detect.all, /sk-ant-secret-value/);
  assert.equal(JSON.parse(detect.stdout).claude.apiBilling, true);
});

for (const authMethod of ['api_key', 'api_key_helper', 'third_party']) {
  test(`authMethod=${authMethod} also triggers the billing warning`, async (t) => {
    const tmp = tempDir(t);
    writeFakeClaude(path.join(tmp, 'bin'), JSON.stringify({ loggedIn: true, authMethod }));
    const envFile = setupEnvFile(tmp);
    const result = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp) });
    assert.equal(result.code, 0, result.all);
    assert.match(result.all, /API 計費/);
  });
}

test('subscription logins do not trigger the billing warning', async (t) => {
  for (const authMethod of ['claude.ai', 'oauth_token']) {
    const tmp = tempDir(t);
    writeFakeClaude(path.join(tmp, 'bin'), JSON.stringify({ loggedIn: true, authMethod }));
    const envFile = setupEnvFile(tmp);
    const result = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp) });
    assert.doesNotMatch(result.all, /API 計費/, authMethod);
  }
});

test('ANTHROPIC_API_KEY in .env counts too: the runtime loads it into the worker', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const envFile = setupEnvFile(tmp, `${ENV_SAMPLE}ANTHROPIC_API_KEY=sk-ant-in-dotenv\r\n`);
  const result = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  assert.match(result.all, /API 計費/);
  assert.doesNotMatch(result.all, /sk-ant-in-dotenv/);
  const menu = await runScript(['--env-path', envFile], { env: childEnv(tmp) });
  assert.match(menu.all, /會走 API 計費/);
  assert.doesNotMatch(menu.all, /訂閱額度/);
});

test('a shell variable that would override .env gets a warning without its value', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--use', 'claude', '--env-path', envFile], { env: childEnv(tmp, { MOCK_WORKER: '1' }) });
  assert.equal(result.code, 0, result.all);
  assert.match(result.all, /MOCK_WORKER/);
  assert.match(result.all, /環境變數/);
});

test('menu: Enter takes the suggested Claude and says it uses the subscription', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const url = await startFakeOllama(t, [QWEN]);
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--env-path', envFile], { env: childEnv(tmp, { AIWFF_OLLAMA_URL: url }), input: '\n' });
  assert.equal(result.code, 0, result.all);
  assert.match(result.all, /額度/);
  assert.match(result.all, /建議/);
  assert.match(result.all, /重開/);
  assert.doesNotMatch(result.all, /leak-me/);
  assert.equal(parseEnvText(fs.readFileSync(envFile, 'utf8')).ENABLE_REAL_CLAUDE_WORKER, '1');
});

test('menu: suggestion falls to ollama, then to mock', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_OUT, 1);
  const url = await startFakeOllama(t, [QWEN]);
  const envFile = setupEnvFile(tmp);
  const viaOllama = await runScript(['--env-path', envFile], { env: childEnv(tmp, { AIWFF_OLLAMA_URL: url }), input: '\n' });
  assert.equal(viaOllama.code, 0, viaOllama.all);
  assert.equal(parseEnvText(fs.readFileSync(envFile, 'utf8')).AIWFF_WORKER_PROVIDER, 'openai_compatible');
  const viaMock = await runScript(['--env-path', envFile], { env: childEnv(tmp), input: '\n' });
  assert.equal(viaMock.code, 0, viaMock.all);
  assert.equal(parseEnvText(fs.readFileSync(envFile, 'utf8')).MOCK_WORKER, '1');
});

test('menu: picking something unusable explains why and asks again, it does not end the install', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_OUT, 1);
  const envFile = setupEnvFile(tmp);
  const stopped = await runScript(['--env-path', envFile], { env: childEnv(tmp), input: '1\n' });
  assert.equal(stopped.code, 0, stopped.all);
  assert.match(stopped.all, /auth login/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), ENV_SAMPLE);

  // 1 還沒登入、2 Ollama 沒裝、9 沒這項，最後 Enter 落到建議的模擬。
  const picked = await runScript(['--env-path', envFile], { env: childEnv(tmp), input: '1\n2\n9\n\n' });
  assert.equal(picked.code, 0, picked.all);
  assert.match(picked.all, /https:\/\/ollama\.com\/download/);
  assert.match(picked.all, /只能輸入 1 到 3/);
  assert.equal(picked.all.match(/要讓小主腦接哪一個大腦/g).length, 4);
  assert.match(picked.all, /大腦設定好了：模擬/);
});

test('menu: says not installed and not running apart, and lists every model', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp);
  const none = await runScript(['--env-path', envFile], { env: childEnv(tmp) });
  assert.match(none.all, /Claude（這台電腦沒裝）/);
  assert.match(none.all, /Ollama（這台電腦沒裝）/);
  writeFakeOllamaBinary(tmp);
  assert.match((await runScript(['--env-path', envFile], { env: childEnv(tmp) })).all, /Ollama（裝了但沒開）/);

  const url = await startFakeOllama(t, [QWEN, { name: 'llama3:8b', capabilities: ['completion'] }]);
  const env = childEnv(tmp, { AIWFF_OLLAMA_URL: url });
  const picked = await runScript(['--env-path', envFile], { env, input: '3\n' });
  assert.equal(picked.code, 0, picked.all);
  assert.match(picked.all, /qwen2\.5:3b/);
  assert.equal(parseEnvText(fs.readFileSync(envFile, 'utf8')).AIWFF_OPENAI_MODEL, 'llama3:8b');
  // 重跑時現在用的模型排前面，Enter 不會把它蓋回清單第一個。
  const again = await runScript(['--env-path', envFile], { env, input: '\n' });
  assert.equal(again.code, 0, again.all);
  assert.equal(parseEnvText(fs.readFileSync(envFile, 'utf8')).AIWFF_OPENAI_MODEL, 'llama3:8b');
});

test('menu: closed stdin changes nothing', async (t) => {
  const tmp = tempDir(t);
  writeFakeClaude(path.join(tmp, 'bin'), LOGGED_IN);
  const envFile = setupEnvFile(tmp);
  const result = await runScript(['--env-path', envFile], { env: childEnv(tmp) });
  assert.equal(result.code, 0, result.all);
  assert.equal(fs.readFileSync(envFile, 'utf8'), ENV_SAMPLE);
});

test('--no-restart-hint drops the hint, a bad --use is a usage error, a missing .env is plain', async (t) => {
  const tmp = tempDir(t);
  fs.mkdirSync(path.join(tmp, 'bin'));
  const envFile = setupEnvFile(tmp);
  const quiet = await runScript(['--use', 'mock', '--env-path', envFile, '--no-restart-hint'], { env: childEnv(tmp) });
  assert.equal(quiet.code, 0, quiet.all);
  assert.doesNotMatch(quiet.all, /重開/);
  assert.equal((await runScript(['--use', 'gpt', '--env-path', envFile], { env: childEnv(tmp) })).code, 2);
  const missing = await runScript(['--use', 'mock', '--env-path', path.join(tmp, 'nope.env')], { env: childEnv(tmp) });
  assert.equal(missing.code, 1);
  assert.match(missing.all, /\.env/);
});

test('install.ps1 stays pure ASCII so PS 5.1 can read it without a BOM', () => {
  const bytes = fs.readFileSync(INSTALLER);
  assert.equal(bytes.findIndex((byte) => byte > 127), -1);
});

// PS 5.1 才是使用者的環境，pwsh 不算數。-DryRun 不建任何東西，所以 Root 給不存在的暫存路徑。
function dryRun(root, args, extraEnv = {}) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, '-Root', root, '-DryRun', ...args],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('install.ps1 -DryRun plans every new switch', { skip: process.platform !== 'win32' }, (t) => {
  const tmp = tempDir(t);
  const root = path.join(tmp, 'plan root');
  const desk = { AIWFF_DESKTOP_DIR: path.join(tmp, 'desk') };

  const base = dryRun(root, ['-SkipAutostart', '-UseSystemTools', '-Unattended'], desk);
  assert.equal(base.code, 0, base.out);
  assert.match(base.out, /brain stays mock/i);
  assert.match(base.out, /desktop: not connected/i);
  assert.match(base.out, /open-webui\.cmd/);
  // 只比 ASCII 那段：PowerShell 的輸出不是 UTF-8，暫存目錄有中文時整條路徑比不到。
  assert.match(base.out, new RegExp(path.join(path.basename(tmp), 'desk').replace(/\\/g, '\\\\')));
  assert.match(base.out, /first-reply/);
  assert.match(base.out, /exit 5/);

  const claude = dryRun(root, ['-SkipAutostart', '-UseSystemTools', '-Unattended', '-Brain', 'claude'], desk);
  assert.equal(claude.code, 0, claude.out);
  assert.match(claude.out, /connect-brain\.js --use claude/);

  const source = dryRun(root, ['-SkipAutostart', '-UseSystemTools', '-Unattended', '-Source', 'C:\\src\\repo'], desk);
  assert.equal(source.code, 0, source.out);
  assert.match(source.out, /clone aiwff-runtime from C:\\src\\repo/);
  assert.doesNotMatch(source.out, /soplint/);

  const connect = dryRun(root, ['-SkipAutostart', '-UseSystemTools', '-Unattended', '-ConnectDesktop'], desk);
  assert.equal(connect.code, 0, connect.out);
  assert.match(connect.out, /connect-desktop\.js/);

  const replace = dryRun(root, ['-SkipAutostart', '-UseSystemTools', '-Unattended', '-ReplaceDesktop'], desk);
  assert.equal(replace.code, 0, replace.out);
  assert.match(replace.out, /would run scripts\\connect-desktop\.js/);

  const none = dryRun(root, ['-SkipAutostart', '-UseSystemTools', '-NoDesktop', '-NoShortcut', '-Unattended'], desk);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /no desktop shortcut/i);
  assert.match(none.out, /-NoDesktop/);

  const bad = dryRun(root, ['-Brain', 'gpt'], desk);
  assert.notEqual(bad.code, 0);

  // 開頭是 - 的值，git clone 會當成選項。
  const option = dryRun(root, ['-SkipAutostart', '-UseSystemTools', '-Unattended', '-Source', '--upload-pack=x'], desk);
  assert.equal(option.code, 1, option.out);
  assert.match(option.out, /-Source cannot start/);
  assert.equal(fs.existsSync(root), false);
});

test('install.ps1 -Branch is planned for aiwff-runtime only and -DryRun shows it', { skip: process.platform !== 'win32' }, (t) => {
  const tmp = tempDir(t);
  const root = path.join(tmp, 'try root');
  const flags = ['-SkipAutostart', '-UseSystemTools', '-Unattended'];
  const desk = { AIWFF_DESKTOP_DIR: path.join(tmp, 'desk') };

  const plain = dryRun(root, flags, desk);
  assert.equal(plain.code, 0, plain.out);
  assert.doesNotMatch(plain.out, /branch/i);

  const github = dryRun(root, [...flags, '-Branch', 'feat/oneclick-v0-20261105'], desk);
  assert.equal(github.code, 0, github.out);
  assert.match(github.out, /branch=feat\/oneclick-v0-20261105/);
  assert.match(github.out, /aiwff-runtime from branch feat\/oneclick-v0-20261105/);
  // 另外兩個 repo 照舊走預設分支。
  assert.match(github.out, /soplint, execution-proofs \(default branch/);

  const source = dryRun(root, [...flags, '-Source', 'C:\\src\\repo', '-Branch', 'try-1.2_a'], desk);
  assert.equal(source.code, 0, source.out);
  assert.match(source.out, /clone aiwff-runtime from C:\\src\\repo, branch try-1\.2_a/);
  assert.equal(fs.existsSync(root), false);
});

test('install.ps1 refuses a -Branch git would misread, before anything is created', { skip: process.platform !== 'win32' }, (t) => {
  const tmp = tempDir(t);
  const root = path.join(tmp, 'bad branch root');
  const flags = ['-SkipAutostart', '-UseSystemTools', '-Unattended'];
  const refused = [
    '--upload-pack=x', 'a b', 'a..b', 'a/', '/a', 'a//b', '.a', 'a/.b', 'a.lock', 'a.lock/b', 'a.', 'a@{b', 'a~1', 'a^', 'a:b', 'a?b', 'a*', 'a[b', 'a\\b', 'a;b', '中文',
  ];
  for (const name of refused) {
    const result = dryRun(root, [...flags, '-Branch', name]);
    assert.equal(result.code, 1, `${name}: ${result.out}`);
    assert.match(result.out, /-Branch/, name);
    assert.equal(fs.existsSync(root), false, name);
  }
  // PowerShell 的 -File 會把單一個 - 開頭的值當成參數名字，要走 -Command 才到得了我們的檢查。
  const command = `& '${INSTALLER}' -Root '${root}' -DryRun -SkipAutostart -UseSystemTools -Unattended -Branch '-x'; exit $LASTEXITCODE`;
  const dash = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
  assert.equal(dash.status, 1, `${dash.stdout}${dash.stderr}`);
  assert.match(dash.stdout, /-Branch/);
  assert.equal(fs.existsSync(root), false);
});

test('install.ps1 limits a new Root but leaves a folder with other files alone', { skip: process.platform !== 'win32' }, (t) => {
  const tmp = tempDir(t);
  const desk = { AIWFF_DESKTOP_DIR: path.join(tmp, 'desk') };
  const args = ['-SkipAutostart', '-UseSystemTools', '-Unattended'];
  assert.match(dryRun(path.join(tmp, 'new'), args, desk).out, /would limit .*this account/);
  const mine = path.join(tmp, 'mine');
  fs.mkdirSync(mine);
  assert.match(dryRun(mine, args, desk).out, /would limit /, 'an empty folder is fine');
  fs.writeFileSync(path.join(mine, 'notes.txt'), 'x');
  assert.match(dryRun(mine, args, desk).out, /would leave the permissions/);
});

test('install.ps1 treats powershell -NonInteractive like a session that cannot answer', { skip: process.platform !== 'win32' }, (t) => {
  const tmp = tempDir(t);
  const out = path.join(tmp, 'out.txt');
  // 要在真主控台跑：stdin 被導向時走的是另一條判斷，測不到這一條。
  const inner = `& '${INSTALLER}' -Root '${path.join(tmp, 'r')}' -DryRun -SkipAutostart -UseSystemTools *> '${out}'`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const launcher = `Start-Process powershell.exe -WindowStyle Hidden -Wait -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', launcher], {
    encoding: 'utf8',
    env: { ...process.env, AIWFF_DESKTOP_DIR: path.join(tmp, 'desk') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(out, 'utf16le'), /brain=keep\/ask desktop=skip/);
});

test('install.ps1 -Mode uninstall -DryRun refuses a folder with no install and changes nothing', { skip: process.platform !== 'win32' }, (t) => {
  const tmp = tempDir(t);
  const root = path.join(tmp, 'nothing here');
  const result = dryRun(root, ['-Mode', 'uninstall'], { AIWFF_DESKTOP_DIR: path.join(tmp, 'desk') });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /no AIWFF install/i);
  assert.equal(fs.existsSync(root), false);
});

test('install.ps1 -Mode uninstall -DryRun lists the plan and keeps the data', { skip: process.platform !== 'win32' }, (t) => {
  const tmp = tempDir(t);
  const root = path.join(tmp, 'has install');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'start-runtime.cmd'), '@echo off\r\n');
  const result = dryRun(root, ['-Mode', 'uninstall', '-NoDesktop'], { AIWFF_DESKTOP_DIR: path.join(tmp, 'desk') });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /would stop 0 process/i);
  assert.match(result.out, /would remove 0 scheduled task/i);
  assert.match(result.out, /would remove 0 desktop shortcut/i);
  assert.match(result.out, /-NoDesktop/);
  assert.match(result.out, /data stays/i);
  assert.equal(fs.existsSync(path.join(root, 'start-runtime.cmd')), true);
});
