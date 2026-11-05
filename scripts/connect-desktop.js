#!/usr/bin/env node

// 把 mcpServers.aiwff 併進 Claude 桌面端設定，或拿掉它。
// 這份設定同時餵 Chat 分頁和 local Code 分頁（官方文件明寫），一筆就夠，不用另接 .mcp.json。
// 只碰自己的鍵；不關、不重啟使用者的 App，只提示要重開。token 不進設定檔，server 自己讀 .env。
//
// aiwff 這個鍵只有一個，同一台電腦可能有好幾個 Root：只動指向這個 Root 的那一筆。
//
// 用法：node scripts/connect-desktop.js [--remove] [--dry-run] [--force] [--status]
//   --force   aiwff 接著別的 Root 時蓋掉它
//   --status  只讀設定，印一個字：connected｜other｜no｜absent
// 結束碼：0 完成或不用動｜1 設定檔壞掉或寫不進去（原檔沒動）｜2 參數錯｜3 找不到桌面端｜4 aiwff 接著別的 Root，沒動

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT_DIR, 'agent', 'mcp-server.js');
const CONFIG_NAME = 'claude_desktop_config.json';
const SERVER_KEY = 'aiwff';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NO_DESKTOP = 3;
const EXIT_OTHER_ROOT = 4;

class ConfigError extends Error {
  constructor(message, exitCode = EXIT_FAILED) {
    super(message);
    this.exitCode = exitCode;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// MSIX 版的真檔在 LocalCache；官方文件寫的 %APPDATA% 路徑從一般 shell 看不到，照寫會建一份 App 不讀的檔。
// LocalCache 在 Desktop 程序樹內外都看得到，所以先查它，判斷結果不受從哪裡跑影響。
function desktopDirs(env) {
  const dirs = [];
  if (env.LOCALAPPDATA) {
    const packages = path.join(env.LOCALAPPDATA, 'Packages');
    const names = listDir(packages).filter((name) => name.toLowerCase().startsWith('claude_'));
    for (const name of names.sort()) {
      dirs.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude'));
    }
  }
  if (env.APPDATA) {
    dirs.push(path.join(env.APPDATA, 'Claude'));
  }
  return dirs;
}

function resolveConfigPath(env = process.env) {
  if (env.CLAUDE_DESKTOP_CONFIG) {
    return path.resolve(env.CLAUDE_DESKTOP_CONFIG);
  }
  const dirs = desktopDirs(env);
  const existingFile = dirs.map((dir) => path.join(dir, CONFIG_NAME)).find((file) => fs.existsSync(file));
  if (existingFile) {
    return existingFile;
  }
  const existingDir = dirs.find((dir) => fs.existsSync(dir));
  return existingDir ? path.join(existingDir, CONFIG_NAME) : null;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { exists: false, config: {} };
  }
  let config;
  try {
    // PS 5.1 的 Set-Content -Encoding UTF8 會留 BOM，JSON.parse 不吃。
    config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`設定檔不是合法 JSON，沒有動它：${configPath}（${error.message}）`);
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new ConfigError(`設定檔最外層不是物件，沒有動它：${configPath}`);
  }
  const servers = config.mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    throw new ConfigError(`設定檔的 mcpServers 不是物件，沒有動它：${configPath}`);
  }
  return { exists: true, config };
}

function serverEntry() {
  // 可攜版 node 不在 PATH，一定要寫絕對路徑。
  return { command: process.execPath, args: [SERVER_PATH] };
}

function entryServerPath(entry) {
  const first = entry?.args?.[0];
  return typeof first === 'string' ? path.resolve(first) : null;
}

function isThisRoot(entry) {
  const target = entryServerPath(entry);
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return target !== null && fold(target) === fold(SERVER_PATH);
}

function planConnect(config, force) {
  const servers = config.mcpServers || {};
  const current = servers[SERVER_KEY];
  const ours = isThisRoot(current);
  // 同一個 Root 只更新 command、args：使用者手動加的 env 這類欄位要留著。
  const entry = ours ? { ...current, ...serverEntry() } : serverEntry();
  if (JSON.stringify(current) === JSON.stringify(entry)) {
    return { changed: false };
  }
  // 指到已經不存在的檔案就是舊的接線，換掉不會斷任何人。
  const target = entryServerPath(current);
  const stale = target !== null && !fs.existsSync(target);
  if (current !== undefined && !ours && !stale && !force) {
    return { changed: false, otherRoot: target || JSON.stringify(current.command) };
  }
  return {
    changed: true,
    action: SERVER_KEY in servers ? '更新' : '新增',
    next: { ...config, mcpServers: { ...servers, [SERVER_KEY]: entry } },
  };
}

function planRemove(config) {
  const servers = config.mcpServers || {};
  if (!(SERVER_KEY in servers)) {
    return { changed: false };
  }
  if (!isThisRoot(servers[SERVER_KEY])) {
    return { changed: false, otherRoot: entryServerPath(servers[SERVER_KEY]) || JSON.stringify(servers[SERVER_KEY].command) };
  }
  const rest = { ...servers };
  delete rest[SERVER_KEY];
  const next = { ...config, mcpServers: rest };
  // 原本沒有這個鍵的設定檔（App 自己寫的就是這樣），移除後要回到一樣的形狀。
  if (Object.keys(rest).length === 0) {
    delete next.mcpServers;
  }
  return { changed: true, action: '拿掉', next };
}

function backupPath(configPath) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `${configPath}.aiwff-bak-${stamp}`;
}

function writeConfig(configPath, next, exists) {
  let backup = null;
  const tmpPath = `${configPath}.aiwff-tmp-${process.pid}`;
  try {
    if (exists) {
      backup = backupPath(configPath);
      fs.copyFileSync(configPath, backup);
    }
    // 同資料夾暫存再改名：寫到一半斷掉時，原檔還是完整的。
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw new ConfigError(`設定檔寫不進去（${error.code || error.message}），原檔沒有動：${configPath}。Claude 可能正在用這個檔，完全結束 Claude 後再跑一次。`);
  }
  return backup;
}

function parseArgs(argv) {
  const options = { remove: false, dryRun: false, force: false, status: false };
  for (const arg of argv) {
    if (arg === '--remove') {
      options.remove = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--status') {
      options.status = true;
    } else {
      throw new ConfigError(`不認得的參數：${arg}（只有 --remove、--dry-run、--force、--status）`, EXIT_USAGE);
    }
  }
  return options;
}

function reportDone(options, backup) {
  if (backup) {
    console.log(`備份：${backup}`);
  }
  if (options.remove) {
    console.log('已拿掉 aiwff。重開 Claude 桌面端才算完全斷開。');
    return;
  }
  console.log(`已接上 aiwff：${SERVER_PATH}`);
  console.log('從系統匣完全結束 Claude 再開才會生效，關視窗不算。接不上就再雙擊一次安裝資料夾的 connect-desktop.cmd（開發環境跑 npm run connect:desktop）。');
}

function reportStatus() {
  const configPath = resolveConfigPath();
  if (!configPath || !fs.existsSync(path.dirname(configPath))) {
    return 'absent';
  }
  const entry = readConfig(configPath).config.mcpServers?.[SERVER_KEY];
  if (entry === undefined) {
    return 'no';
  }
  return isThisRoot(entry) ? 'connected' : 'other';
}

function run(options) {
  if (options.status) {
    console.log(reportStatus());
    return 0;
  }
  const configPath = resolveConfigPath();
  if (!configPath || !fs.existsSync(path.dirname(configPath))) {
    if (options.remove) {
      console.log('沒有找到 Claude 桌面端設定，不用移除。');
      return 0;
    }
    console.error('沒有找到 Claude 桌面端設定。請先開一次 Claude 桌面端再試。');
    return EXIT_NO_DESKTOP;
  }

  console.log(`設定檔：${configPath}`);
  const { exists, config } = readConfig(configPath);
  const plan = options.remove ? planRemove(config) : planConnect(config, options.force);
  if (plan.otherRoot && options.remove) {
    console.log(`aiwff 接的是別的小主腦（${plan.otherRoot}），不是這個資料夾的，沒有動它。`);
    return 0;
  }
  if (plan.otherRoot) {
    console.error(`aiwff 已經接著別的小主腦（${plan.otherRoot}），沒有動它。要換成這個資料夾：先雙擊那邊的 uninstall.cmd，再跑一次；或帶 --force 直接蓋掉。`);
    return EXIT_OTHER_ROOT;
  }
  if (!plan.changed) {
    console.log(options.remove ? '本來就沒接 aiwff，不用改。' : '已經接好了，不用改。');
    return 0;
  }
  if (options.dryRun) {
    // 印設定檔裡真正會變動的那筆，不是自己算出來的。env 可能放金鑰，不上畫面。
    const { command, args } = (options.remove ? config : plan.next).mcpServers[SERVER_KEY];
    console.log(`試跑，沒有寫入。會${plan.action} mcpServers.aiwff：${JSON.stringify({ command, args })}`);
    return 0;
  }
  reportDone(options, writeConfig(configPath, plan.next, exists));
  return 0;
}

function main() {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    console.error(error.message);
    process.exitCode = error.exitCode;
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveConfigPath };
