// scripts/connect-desktop.js 測試。所有寫入都在系統暫存目錄，子程序一律帶 CLAUDE_DESKTOP_CONFIG，
// 同時把 LOCALAPPDATA、APPDATA 指到暫存，就算 override 沒生效也碰不到真的設定檔。
// 找檔順序用傳假 env 的純函式測：在 Desktop session 裡 %APPDATA%\Claude 看得到，
// 使用者的 PowerShell 看不到，靠真環境測會過不代表使用者那邊通。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT_DIR, 'scripts', 'connect-desktop.js');
const SERVER_PATH = path.join(ROOT_DIR, 'agent', 'mcp-server.js');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-connect-desktop-test-'));
const CONFIG_NAME = 'claude_desktop_config.json';
const EXPECTED_ENTRY = { command: process.execPath, args: [SERVER_PATH] };

const { resolveConfigPath } = require(SCRIPT);

let dirCounter = 0;

function makeDir() {
  dirCounter += 1;
  const dir = path.join(TMP_ROOT, `case-${dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(content) {
  const file = path.join(makeDir(), CONFIG_NAME);
  if (content !== undefined) {
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return file;
}

function run(configPath, ...args) {
  assert.ok(path.resolve(configPath).startsWith(TMP_ROOT), `測試只准碰暫存目錄：${configPath}`);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_DESKTOP_CONFIG: configPath,
      LOCALAPPDATA: path.join(TMP_ROOT, 'no-localappdata'),
      APPDATA: path.join(TMP_ROOT, 'no-appdata'),
    },
  });
  assert.equal(result.error, undefined);
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function siblings(file) {
  return fs.readdirSync(path.dirname(file)).filter((name) => name !== path.basename(file));
}

function backups(file) {
  return siblings(file).filter((name) => name.includes('.aiwff-bak-'));
}

// 真檔的形狀：沒有 mcpServers 這個鍵，只有 App 自己的設定。
function appShape() {
  return { coworkUserFilesPath: 'C:\\Users\\someone\\Documents', preferences: { theme: 'dark', nested: { list: [1, 2, { a: null }] } } };
}

test.after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test('併入：沒有 mcpServers 的設定檔加上 aiwff，其他鍵深度相等，先備份', () => {
  const original = appShape();
  const file = makeConfig(original);
  const rawBefore = fs.readFileSync(file);

  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(file), '要印出實際用的路徑');
  assert.match(result.stdout, /完全結束/);

  const after = readJson(file);
  assert.deepEqual(after.mcpServers, { aiwff: EXPECTED_ENTRY });
  const { mcpServers, ...rest } = after;
  assert.deepEqual(rest, original);

  const baks = backups(file);
  assert.equal(baks.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), baks[0])), rawBefore);
  assert.deepEqual(siblings(file), baks, '不可以留暫存檔');
});

test('寫入內容：node 絕對路徑、mcp-server 絕對路徑，不放 env 也不放 token，UTF-8 無 BOM', () => {
  const file = makeConfig(appShape());
  assert.equal(run(file).status, 0);
  const entry = readJson(file).mcpServers.aiwff;
  assert.ok(path.isAbsolute(entry.command));
  assert.ok(path.isAbsolute(entry.args[0]));
  assert.deepEqual(Object.keys(entry).sort(), ['args', 'command']);
  assert.notEqual(fs.readFileSync(file)[0], 0xef);
});

test('寫入走暫存再改名：原檔是整個換掉，不是就地改寫', () => {
  const file = makeConfig(appShape());
  const before = fs.statSync(file, { bigint: true }).ino;
  assert.equal(run(file).status, 0);
  assert.notEqual(fs.statSync(file, { bigint: true }).ino, before);
});

test('冪等：重跑檔案一個位元組都不變，不多備份', () => {
  const file = makeConfig(appShape());
  assert.equal(run(file).status, 0);
  const rawAfterFirst = fs.readFileSync(file);
  const mtimeAfterFirst = fs.statSync(file).mtimeMs;
  const baksAfterFirst = backups(file);

  const second = run(file);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /不用改/);
  assert.deepEqual(fs.readFileSync(file), rawAfterFirst);
  assert.equal(fs.statSync(file).mtimeMs, mtimeAfterFirst);
  assert.deepEqual(backups(file), baksAfterFirst);
});

test('已有別的 server：併入不動它；aiwff 指到已經不存在的檔案時換成這個 Root', () => {
  const other = { command: 'other', args: ['x'], env: { KEY: 'value' } };
  const file = makeConfig({ mcpServers: { other, aiwff: { command: 'old', args: ['old.js'] } }, preferences: {} });
  assert.equal(run(file).status, 0);
  const after = readJson(file);
  assert.deepEqual(after.mcpServers.other, other);
  assert.deepEqual(after.mcpServers.aiwff, EXPECTED_ENTRY);
  assert.deepEqual(after.preferences, {});
});

// 同一台電腦兩個 Root：另一個 Root 的 mcp-server.js 真的存在。
function otherRootEntry() {
  const server = path.join(makeDir(), 'agent', 'mcp-server.js');
  fs.mkdirSync(path.dirname(server));
  fs.writeFileSync(server, '');
  return { command: 'node', args: [server] };
}

test('兩個 Root：移除不動別的 Root 的接線', () => {
  const entry = otherRootEntry();
  const file = makeConfig({ mcpServers: { aiwff: entry } });
  const raw = fs.readFileSync(file);
  const result = run(file, '--remove');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(entry.args[0]), '要講現在接的是哪個');
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(siblings(file), []);

  const dry = run(file, '--remove', '--dry-run');
  assert.equal(dry.status, 0);
  assert.doesNotMatch(dry.stdout, /會拿掉/);
});

test('兩個 Root：接線遇到別的 Root 就停下來，--force 才蓋掉', () => {
  const entry = otherRootEntry();
  const file = makeConfig({ mcpServers: { aiwff: entry } });
  const raw = fs.readFileSync(file);
  for (const args of [[], ['--dry-run']]) {
    const result = run(file, ...args);
    assert.equal(result.status, 4, args.join(' '));
    assert.ok(result.stderr.includes(entry.args[0]));
    assert.match(result.stderr, /--force/);
    assert.deepEqual(fs.readFileSync(file), raw);
  }
  assert.deepEqual(siblings(file), []);

  const forced = run(file, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(readJson(file).mcpServers.aiwff, EXPECTED_ENTRY);
  assert.equal(backups(file).length, 1, '蓋掉前要備份');
});

test('同一個 Root 重接：更新 command、留下使用者手動加的 env', () => {
  const file = makeConfig({ mcpServers: { aiwff: { command: 'old-node', args: [SERVER_PATH], env: { KEY: 'value' } } } });
  assert.equal(run(file).status, 0);
  assert.deepEqual(readJson(file).mcpServers.aiwff, { ...EXPECTED_ENTRY, env: { KEY: 'value' } });
  const again = run(file);
  assert.match(again.stdout, /不用改/);
});

test('Windows 路徑不分大小寫：大小寫不同還是這個 Root', { skip: process.platform !== 'win32' }, () => {
  const file = makeConfig({ mcpServers: { aiwff: { command: process.execPath, args: [SERVER_PATH.toUpperCase()] } } });
  assert.equal(run(file, '--status').stdout.trim(), 'connected');
  assert.equal(run(file, '--remove').status, 0);
  assert.deepEqual(readJson(file), {});
});

test('--dry-run --remove 印設定檔裡真的那筆，env 不上畫面', () => {
  const file = makeConfig({ mcpServers: { aiwff: { command: 'old-node', args: [SERVER_PATH], env: { KEY: 'secret-value' } } } });
  const result = run(file, '--remove', '--dry-run');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /old-node/);
  assert.doesNotMatch(result.stdout, /secret-value/);
});

test('--status 只讀設定：connected、other、no、absent，壞 JSON exit 1', () => {
  const file = makeConfig(appShape());
  const raw = fs.readFileSync(file);
  assert.equal(run(file, '--status').stdout.trim(), 'no');
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.equal(run(file).status, 0);
  assert.equal(run(file, '--status').stdout.trim(), 'connected');
  assert.equal(run(makeConfig({ mcpServers: { aiwff: otherRootEntry() } }), '--status').stdout.trim(), 'other');
  assert.equal(run(path.join(makeDir(), 'gone', CONFIG_NAME), '--status').stdout.trim(), 'absent');
  assert.equal(run(makeConfig('{,}'), '--status').status, 1);
});

test('移除：原本沒有 mcpServers 的，移除後連鍵一起拿掉，跟原本深度相等', () => {
  const original = appShape();
  const file = makeConfig(original);
  assert.equal(run(file).status, 0);
  const removed = run(file, '--remove');
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /重開/);
  assert.deepEqual(readJson(file), original);
  assert.equal(backups(file).length, 2, '移除前也要備份');
});

test('移除：原本有別的 server 時只拿自己的鍵', () => {
  const original = { mcpServers: { other: { command: 'other', args: [] } }, preferences: { a: 1 } };
  const file = makeConfig(original);
  assert.equal(run(file).status, 0);
  assert.equal(run(file, '--remove').status, 0);
  assert.deepEqual(readJson(file), original);
});

test('移除：本來就沒接時不寫不備份；設定檔不存在也 exit 0', () => {
  const file = makeConfig(appShape());
  const raw = fs.readFileSync(file);
  const result = run(file, '--remove');
  assert.equal(result.status, 0);
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(siblings(file), []);

  const missing = makeConfig();
  assert.equal(run(missing, '--remove').status, 0);
  assert.equal(fs.existsSync(missing), false);
});

test('JSON 壞掉：中止不寫，連移除和試跑都一樣', () => {
  for (const args of [[], ['--remove'], ['--dry-run']]) {
    const broken = '{"preferences": {"a": 1},,}';
    const file = makeConfig(broken);
    const result = run(file, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /JSON/);
    assert.ok(result.stderr.includes(file));
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
    assert.deepEqual(siblings(file), [], '不可以留備份或暫存檔');
  }
});

test('空檔、頂層不是物件、mcpServers 不是物件：中止不寫', () => {
  for (const content of ['', '[]', '123', '{"mcpServers":[]}', '{"mcpServers":"x"}', '{"mcpServers":null}']) {
    const file = makeConfig(content);
    const result = run(file);
    assert.equal(result.status, 1, content);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.deepEqual(siblings(file), []);
  }
});

test('帶 BOM 的設定檔：解得開，寫回無 BOM', () => {
  const file = makeConfig(`\uFEFF${JSON.stringify(appShape())}`);
  assert.equal(run(file).status, 0);
  assert.notEqual(fs.readFileSync(file)[0], 0xef);
  assert.deepEqual(readJson(file).mcpServers, { aiwff: EXPECTED_ENTRY });
});

test('--dry-run：印路徑和會做的事，不寫不備份', () => {
  const file = makeConfig(appShape());
  const raw = fs.readFileSync(file);
  const result = run(file, '--dry-run');
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(file));
  assert.match(result.stdout, /沒有寫入/);
  assert.match(result.stdout, /會新增/);
  assert.ok(result.stdout.includes('mcp-server.js'));
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(siblings(file), []);

  assert.equal(run(file).status, 0);
  const rawConnected = fs.readFileSync(file);
  const baks = backups(file);
  const removeDry = run(file, '--remove', '--dry-run');
  assert.equal(removeDry.status, 0);
  assert.match(removeDry.stdout, /會拿掉/);
  assert.deepEqual(fs.readFileSync(file), rawConnected);
  assert.deepEqual(backups(file), baks);
});

test('設定檔不存在但資料夾在：新建，不用備份；--dry-run 不建', () => {
  const file = makeConfig();
  const dry = run(file, '--dry-run');
  assert.equal(dry.status, 0);
  assert.ok(dry.stdout.includes(file));
  assert.equal(fs.existsSync(file), false);

  assert.equal(run(file).status, 0);
  assert.deepEqual(readJson(file), { mcpServers: { aiwff: EXPECTED_ENTRY } });
  assert.deepEqual(siblings(file), []);
});

test('資料夾不在：exit 3 請使用者先開一次，不自己建資料夾', () => {
  const dir = path.join(makeDir(), 'no-such-folder');
  const file = path.join(dir, CONFIG_NAME);
  for (const args of [[], ['--dry-run']]) {
    const result = run(file, ...args);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /先開一次 Claude 桌面端/);
    assert.equal(fs.existsSync(dir), false);
  }
  assert.equal(run(file, '--remove').status, 0, '沒有桌面端時移除不算失敗');
});

test('參數打錯：exit 2，不會當成接上去寫檔', () => {
  const file = makeConfig(appShape());
  const raw = fs.readFileSync(file);
  const result = run(file, '--remov');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--remov/);
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(siblings(file), []);
});

test('改名失敗：清掉暫存檔，原檔不變，白話回報', { skip: process.platform !== 'win32' && '唯讀檔只有 Windows 會讓 rename 失敗' }, () => {
  const file = makeConfig(appShape());
  const raw = fs.readFileSync(file);
  fs.chmodSync(file, 0o444);
  try {
    const result = run(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /寫不進去/);
    assert.deepEqual(fs.readFileSync(file), raw);
    assert.equal(siblings(file).some((name) => name.includes('.aiwff-tmp-')), false);
  } finally {
    fs.chmodSync(file, 0o666);
  }
});

test('設定檔路徑含空白和中文：照常併入、移除', () => {
  const dir = path.join(makeDir(), '小 主腦 設定');
  fs.mkdirSync(dir);
  const file = path.join(dir, CONFIG_NAME);
  const original = appShape();
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(run(file).status, 0);
  assert.deepEqual(readJson(file).mcpServers, { aiwff: EXPECTED_ENTRY });
  assert.equal(run(file, '--remove').status, 0);
  assert.deepEqual(readJson(file), original);
});

test('找檔順序：CLAUDE_DESKTOP_CONFIG 最優先，相對路徑轉絕對', () => {
  const file = path.join(makeDir(), 'custom.json');
  assert.equal(resolveConfigPath({ CLAUDE_DESKTOP_CONFIG: file, LOCALAPPDATA: 'x', APPDATA: 'y' }), file);
  assert.equal(resolveConfigPath({ CLAUDE_DESKTOP_CONFIG: 'rel.json' }), path.resolve('rel.json'));
});

function fakeProfile({ packages = [], appData = false, files = [] }) {
  const base = makeDir();
  const env = { LOCALAPPDATA: path.join(base, 'Local'), APPDATA: path.join(base, 'Roaming') };
  fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Packages'), { recursive: true });
  fs.mkdirSync(env.APPDATA, { recursive: true });
  const localCache = packages.map((name) => path.join(env.LOCALAPPDATA, 'Packages', name, 'LocalCache', 'Roaming', 'Claude'));
  const roaming = path.join(env.APPDATA, 'Claude');
  for (const dir of localCache) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (appData) {
    fs.mkdirSync(roaming, { recursive: true });
  }
  for (const dir of files) {
    const target = dir === 'roaming' ? roaming : localCache[dir];
    fs.writeFileSync(path.join(target, CONFIG_NAME), '{}');
  }
  return { env, localCache, roaming };
}

test('找檔順序：只有 LocalCache（MSIX，從一般 PowerShell 看到的樣子）', () => {
  const { env, localCache } = fakeProfile({ packages: ['Claude_pzs8sxrjxfjjc'], files: [0] });
  assert.equal(resolveConfigPath(env), path.join(localCache[0], CONFIG_NAME));
});

test('找檔順序：雜湊不寫死，別的套件不算', () => {
  const { env, localCache } = fakeProfile({ packages: ['Claude_otherhash123', 'ClaudeHelper_abc', 'Microsoft.Foo_1'], files: [0] });
  assert.equal(resolveConfigPath(env), path.join(localCache[0], CONFIG_NAME));

  const helperOnly = fakeProfile({ packages: ['ClaudeHelper_abc'], files: [0] });
  assert.equal(resolveConfigPath(helperOnly.env), null);
});

test('找檔順序：只有 %APPDATA%（非 MSIX 或舊機器）', () => {
  const { env, roaming } = fakeProfile({ appData: true, files: ['roaming'] });
  assert.equal(resolveConfigPath(env), path.join(roaming, CONFIG_NAME));
});

test('找檔順序：兩邊都有檔時 LocalCache 優先', () => {
  const { env, localCache } = fakeProfile({ packages: ['Claude_abc'], appData: true, files: [0, 'roaming'] });
  assert.equal(resolveConfigPath(env), path.join(localCache[0], CONFIG_NAME));
});

test('找檔順序：LocalCache 只有資料夾、%APPDATA% 有檔時用有檔的', () => {
  const { env, roaming } = fakeProfile({ packages: ['Claude_abc'], appData: true, files: ['roaming'] });
  assert.equal(resolveConfigPath(env), path.join(roaming, CONFIG_NAME));
});

test('找檔順序：檔都沒有時先在 LocalCache 資料夾新建，再看 %APPDATA%', () => {
  const both = fakeProfile({ packages: ['Claude_abc'], appData: true });
  assert.equal(resolveConfigPath(both.env), path.join(both.localCache[0], CONFIG_NAME));

  const roamingOnly = fakeProfile({ appData: true });
  assert.equal(resolveConfigPath(roamingOnly.env), path.join(roamingOnly.roaming, CONFIG_NAME));
});

test('找檔順序：都沒有回 null，不建資料夾', () => {
  const { env, roaming } = fakeProfile({});
  assert.equal(resolveConfigPath(env), null);
  assert.equal(fs.existsSync(roaming), false);
  assert.equal(resolveConfigPath({}), null);
});
