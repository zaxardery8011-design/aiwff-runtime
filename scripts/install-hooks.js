#!/usr/bin/env node

// hook 裝在 .git/hooks/ 裡，而 .git/ 不進版控——所以「我這台裝好了」不等於「clone 下來就有」。
// 正本放在追蹤得到的 scripts/git-hooks/，這支負責把它複製進去，並且回讀確認真的落地。
//
// 為什麼用複製而不是 core.hooksPath：hooksPath 給相對路徑時，不同 git 版本對「相對於誰」
// 的解讀不一致（cwd vs 工作樹頂層），裝了卻沒生效是靜默的——而一道靜默沒生效的 push 閘
// 比沒有閘更糟，因為它會讓人以為有。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'scripts', 'git-hooks');

function gitDir() {
  const res = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    return null;
  }
  return res.stdout.trim();
}

function install() {
  const dir = gitDir();
  if (!dir) {
    console.error('FAIL install-hooks: not a git checkout — nothing to install');
    return 1;
  }
  const target = path.join(dir, 'hooks');
  fs.mkdirSync(target, { recursive: true });

  const names = fs.readdirSync(SOURCE_DIR).filter((name) => !name.endsWith('.sample'));
  if (names.length === 0) {
    console.error(`FAIL install-hooks: no hook found under ${SOURCE_DIR}`);
    return 1;
  }

  for (const name of names) {
    const from = path.join(SOURCE_DIR, name);
    const to = path.join(target, name);
    // hook 交給 sh 跑：CRLF 會讓 shebang 帶著 \r 而執行失敗，而失敗的樣子是「沒擋住」。
    // .gitattributes 已把正本釘成 LF，這裡再正規化一次——裝進去的那份不靠 checkout 設定吃飯。
    const body = fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(to, body, 'utf8');
    fs.chmodSync(to, 0o755);
    // 存在不等於裝對：回讀比對內容，對不上就當場失敗，不留一份「看起來裝好了」的舊 hook。
    const back = fs.readFileSync(to, 'utf8');
    if (back !== body) {
      console.error(`FAIL install-hooks: ${to} readback does not match the tracked source`);
      return 1;
    }
    console.log(`installed ${name} -> ${to} (${Buffer.byteLength(body)} bytes)`);
  }
  console.log(`PASS install-hooks: ${names.length} hook(s) installed from scripts/git-hooks`);
  return 0;
}

if (require.main === module) {
  process.exit(install());
}

module.exports = { install, SOURCE_DIR };
