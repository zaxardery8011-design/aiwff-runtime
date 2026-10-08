// install.ps1 的登入連結：Get-LoginLink 對「真的 runtime server」的行為。
// 做法：用 PowerShell 的語法樹把 Get-LoginLink 從 install.ps1 原樣取出來跑（不是複製一份邏輯），
// 對象是同一個 process 內起的 runtime server（和 webui-login.test.js 同款），不下載、不碰網路。
// 只在 Windows 有 powershell.exe 時跑；其他平台整檔略過。
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const INSTALL_PS1 = path.join(ROOT_DIR, 'install.ps1');
const FIXED_TOKEN = 'login-link-fixed-token-0123456789';

function hasPowerShell() {
  if (process.platform !== 'win32') {
    return false;
  }
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true });
  return probe.status === 0;
}
const SKIP = hasPowerShell() ? false : 'needs Windows PowerShell (powershell.exe)';

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

// 把 Get-LoginLink 的原文從 install.ps1 取出來，連同呼叫放在同一個 scriptblock 裡跑
// （函式和 $script:LoginWhy 才在同一個 script scope）。檔案、port 用環境變數傳，不進命令列。
const DRIVER = `
$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:LB_INSTALL_PS1, [ref]$t, [ref]$e)
$fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-LoginLink' }, $true)
if (-not $fn) { 'NOFUNC'; exit 3 }
$call = '$r = Get-LoginLink $env:LB_FILE ([int]$env:LB_PORT); if ($r) { "RESULT=link" } else { "RESULT=empty" }; "WHY=" + $script:LoginWhy'
& ([scriptblock]::Create($fn.Extent.Text + [Environment]::NewLine + $call))
`;

let tmpDir;
let driverPath;
let port;
let agent;

test.before(async () => {
  if (SKIP) {
    return;
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-login-link-'));
  driverPath = path.join(tmpDir, 'driver.ps1');
  fs.writeFileSync(driverPath, DRIVER, 'utf8');
  port = await getOpenPort();
  // PORT 在模組載入時讀取，要在 require 前設好。
  process.env.PORT = String(port);
  process.env.MOCK_WORKER = '1';
  process.env.AIWFF_WORKER_PROVIDER = '';
  process.env.AIWFF_RUNTIME_TOKEN = FIXED_TOKEN;
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
});

test.after(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function withRuntime(fn) {
  agent.initRuntimeToken();
  const server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    await fn();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// 必須非同步 spawn：同一個 process 內的 runtime server 要靠事件迴圈才答得了 PowerShell 的探測，
// spawnSync 會把它卡死。
function runGetLoginLink(file, linkPort) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driverPath],
      {
        windowsHide: true,
        env: { ...process.env, LB_INSTALL_PS1: INSTALL_PS1, LB_FILE: file, LB_PORT: String(linkPort) },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      try {
        resolve(parseDriverOutput(status, stdout, stderr));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function parseDriverOutput(status, stdout, stderr) {
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  const out = stdout.replace(/\r/g, '');
  assert.ok(!out.includes(FIXED_TOKEN), 'Get-LoginLink must never print the token');
  return {
    result: (out.match(/^RESULT=(.*)$/m) || [])[1],
    why: (out.match(/^WHY=(.*)$/m) || [])[1] || '',
  };
}

function writeLinkFile(name, text) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

test('runtime 寫的登入連結：回傳可用，且預抓（多開幾次）不會用掉它', { skip: SKIP }, async () => {
  await withRuntime(async () => {
    const file = writeLinkFile('good.txt', `${agent.runtimeLoginUrl()}\n`);
    assert.equal((await runGetLoginLink(file, port)).result, 'link');
    // 瀏覽器或防毒預抓 = 多打幾次同一條連結；token 不是一次性，之後照樣可用。
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(agent.runtimeLoginUrl(), { redirect: 'manual' });
      assert.equal(res.status, 302);
    }
    assert.equal((await runGetLoginLink(file, port)).result, 'link');
  });
});

test('連結檔是舊的（token 已換）：不回傳、原因講 401', { skip: SKIP }, async () => {
  await withRuntime(async () => {
    const file = writeLinkFile('stale.txt', `http://127.0.0.1:${port}/?token=an-older-start-token\n`);
    const got = await runGetLoginLink(file, port);
    assert.equal(got.result, 'empty');
    assert.match(got.why, /401/);
  });
});

test('連結檔還不存在：不回傳、原因講 runtime 還沒寫', { skip: SKIP }, async () => {
  await withRuntime(async () => {
    const got = await runGetLoginLink(path.join(tmpDir, 'nope.txt'), port);
    assert.equal(got.result, 'empty');
    assert.match(got.why, /not written/);
  });
});

test('連結檔內容不是這個 port 的 runtime 連結：不回傳（檔案內容不能讓安裝器開任意東西）', { skip: SKIP }, async () => {
  await withRuntime(async () => {
    const otherPort = port === 65535 ? port - 1 : port + 1;
    const wrongPort = writeLinkFile('wrong-port.txt', `http://127.0.0.1:${otherPort}/?token=${FIXED_TOKEN}\n`);
    assert.equal((await runGetLoginLink(wrongPort, port)).result, 'empty');
    const otherHost = writeLinkFile('other-host.txt', `http://example.invalid:${port}/?token=${FIXED_TOKEN}\n`);
    assert.equal((await runGetLoginLink(otherHost, port)).result, 'empty');
    const notHttp = writeLinkFile('not-http.txt', 'file:///C:/Windows/System32/calc.exe\n');
    assert.equal((await runGetLoginLink(notHttp, port)).result, 'empty');
    const empty = writeLinkFile('empty.txt', '');
    assert.equal((await runGetLoginLink(empty, port)).result, 'empty');
  });
});

test('install.ps1 不自己拼 ?token= 連結（連結只讀 runtime 寫的檔）', () => {
  const source = fs.readFileSync(INSTALL_PS1, 'utf8');
  assert.ok(!/\?token=\$/.test(source), 'no ?token=$... interpolation');
  assert.ok(!/\?token=['"]\s*\+/.test(source), 'no ?token=" + ... concatenation');
  assert.ok(source.includes('webui_login_url.txt'), 'reads the runtime login link file');
});
