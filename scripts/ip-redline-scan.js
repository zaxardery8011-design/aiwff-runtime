#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// 吃根路徑的入口一律要求明示參數：掃描根的 override 只認呼叫端當場給的 `--root=<dir>`。
// 繼承來的 IP_SCAN_ROOT 不算明示——殘留在 shell／CI job 裡的舊值會讓正式閘
// （npm run scan:ip）靜默掃到別的樹，而且因為 files_checked>=1 還會印出 PASS，
// 等於拿一份掃錯對象的綠燈蓋掉真正的 repo。缺明示參數就 fail closed，不猜呼叫端的意圖。
const DEFAULT_ROOT = path.join(__dirname, '..');
// 模組層常數只從 __dirname 推導，載入時不讀任何 ambient 狀態。
const ROOT_DIR = path.resolve(DEFAULT_ROOT);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'logs']);

const ROOT_FLAG = '--root';

function parseRootFlag(argv) {
  for (const arg of argv) {
    if (arg === ROOT_FLAG) {
      return { present: true, value: '' };
    }
    if (arg.startsWith(`${ROOT_FLAG}=`)) {
      return { present: true, value: arg.slice(ROOT_FLAG.length + 1) };
    }
  }
  return { present: false, value: '' };
}

// 純函式回傳 { ok, reason, root, declared }，讓測試能直接驗這條判準本身而不是驗 spawn 的副作用。
function resolveRootDir(argv = process.argv.slice(2), env = process.env) {
  const flag = parseRootFlag(argv);
  if (flag.present) {
    // 給了旗標卻沒給值 ＝ 參數沒填好，不是「用預設」。
    if (flag.value.trim() === '') {
      return { ok: false, reason: 'empty_explicit_root', root: null, declared: ROOT_FLAG };
    }
    return {
      ok: true,
      reason: 'explicit_flag',
      root: path.resolve(flag.value),
      declared: `${ROOT_FLAG}=${flag.value}`,
    };
  }
  const inherited = typeof env.IP_SCAN_ROOT === 'string' ? env.IP_SCAN_ROOT.trim() : '';
  if (inherited !== '') {
    return {
      ok: false,
      reason: 'inherited_root_without_flag',
      root: null,
      declared: `IP_SCAN_ROOT=${inherited}`,
    };
  }
  return { ok: true, reason: 'default_repo_root', root: path.resolve(DEFAULT_ROOT), declared: '__dirname/..' };
}

// 根路徑被拒有專屬 exit code 5，跟「掃壞了」(3)、「掃到了」(1)、「空掃」(2) 在 rc 層分得開。
function refuseRootVerdict(resolution) {
  const lines = {
    inherited_root_without_flag:
      `FAIL IP redline scan refused: inherited ${resolution.declared} is not an explicit root — ` +
      `pass ${ROOT_FLAG}=<dir> at the call site or unset it ` +
      '(a stale ambient root scans the wrong tree and still prints PASS)',
    empty_explicit_root:
      `FAIL IP redline scan refused: ${ROOT_FLAG} was given without a directory — ` +
      'an empty root is a missing parameter, not the repo root',
  };
  return {
    code: 5,
    stream: 'error',
    lines: [
      lines[resolution.reason] ||
        `FAIL IP redline scan refused: unusable scan root (reason=${resolution.reason})`,
    ],
  };
}

const ENCODED_KEYWORD_TERMS = [
  'U09VTA==',
  'c291bF9iYXNlbGluZQ==',
  'YmFzZWxpbmUuanNvbg==',
  'Ymxlc3M=',
  'U291bEludGVncml0eQ==',
  'UHJlVG9vbFVzZQ==',
  'TG9uZWx5Ym8=',
  'bG9uZWx5Ym8=',
  '5a+C5a+e5Lyv',
  '6ZqK6ZW3',
  '6Ie75a6J6ZGr',
  '6Z+T',
  'QUlXRkZf5ryU6K6K5Y+y',
  '5LiJ6Zec',
  'ZGlzcGF0Y2ggdGllcg==',
  'bm9kZV9yZXBvcnQ=',
  'cGVlcl9pbmJveA==',
  'b3V0Ym94X3F1ZXVl',
  'QlBD',
  'ZmFjdG9yeV9zdHJlYW0=',
  '5bel5bug55u05pKt',
  '5ZCN5YaK',
  'Z292ZXJuYW5jZV9odWI=',
  'WkFYLUNPUkU=',
  'dGFpbHNjYWxl',
  'dGFpbG5ldA==',
];

function decodeBase64(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildKeywordRegex() {
  const terms = ENCODED_KEYWORD_TERMS.map(decodeBase64).map(escapeRegExp);
  const scopedIpv4 = `${decodeBase64('MTAw')}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}`;
  return new RegExp([...terms, scopedIpv4].join('|'), 'i');
}

const REDLINE_PATTERNS = [
  {
    id: 'internal-keyword',
    regex: buildKeywordRegex(),
  },
  {
    id: 'secret-token',
    regex:
      /([0-9]{8,10}:[A-Za-z0-9_-]{35,})|(sk-ant-[A-Za-z0-9_-]{20,})|(ghp_[A-Za-z0-9_]{20,})|(xox[baprs]-[A-Za-z0-9-]{20,})|(AIza[0-9A-Za-z_-]{20,})|(AKIA[0-9A-Z]{16})|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  },
];

const ALLOWLIST = [
  {
    file: null,
    regex: /zaxardery8011-design\/aiwff-runtime/i,
    reason: 'public repository URL',
  },
  {
    file: null,
    regex: /TG_BOT_TOKEN=(|<your_bot_token>|你的 Telegram Bot Token.*)$/i,
    reason: 'documented Telegram placeholder',
  },
];

function toRepoPath(filePath, rootDir = ROOT_DIR) {
  return path.relative(rootDir, filePath).replaceAll(path.sep, '/');
}

// 白名單條目是「豁免 redline」的權力，所以判準要 fail closed：寫壞的條目一律不匹配，
// 不得因為欄位是空值而退化成 match-all，把整支偵測器靜默變成放行全部。
function isUsableAllowEntry(entry) {
  if (!entry || !(entry.regex instanceof RegExp)) {
    return false;
  }
  // 空 pattern（//、new RegExp('')）與 /.*/ 這類能匹配空字串的式子，對每一行都成立＝match-all。
  if (entry.regex.test('')) {
    return false;
  }
  // file 只有兩種合法值：null/undefined＝明示涵蓋全部檔案；非空字串＝限定該檔。
  // 空字串或空白字串是「scope 欄位沒填好」，不是 wildcard。
  if (entry.file === null || entry.file === undefined) {
    return true;
  }
  return typeof entry.file === 'string' && entry.file.trim() !== '';
}

// 偵測清單的條目只要「認得出是誰」＋「是個真的 RegExp」就算可用。這裡刻意不把 match-all
// 當成不可用：match-all 的偵測式子是吵，不是漏，方向跟白名單相反。
function isUsablePattern(entry) {
  return (
    Boolean(entry) &&
    typeof entry.id === 'string' &&
    entry.id.trim() !== '' &&
    entry.regex instanceof RegExp
  );
}

// 清單型判準的「空」在啟動時就已經確定，不該等到掃第一個檔才發作。兩份清單的空各有各的後果：
// - REDLINE_PATTERNS 一條可用的都沒有 ＝ 偵測器什麼都測不到，之後的零命中是假的 → 走拒絕分支。
// - ALLOWLIST 有效條目為 0 ＝ 不會有任何豁免，掃描本身仍安全，但那通常是條目被 fail closed
//   掉的靜默後果 → 啟動時就具名警告一次，不等某條 redline 被誤報才有人發現。
function checkListPredicates(patterns = REDLINE_PATTERNS, allowlist = ALLOWLIST) {
  const patternList = Array.isArray(patterns) ? patterns : [];
  const allowEntries = Array.isArray(allowlist) ? allowlist : [];
  const usablePatterns = patternList.filter(isUsablePattern).length;
  const usableAllow = allowEntries.filter(isUsableAllowEntry).length;
  const warnings = [];
  if (usableAllow === 0) {
    warnings.push(
      `WARN IP redline scan allowlist has no usable entry (declared=${allowEntries.length} usable=0) — nothing will be exempted`,
    );
  }
  return {
    ok: usablePatterns > 0,
    declared_patterns: patternList.length,
    usable_patterns: usablePatterns,
    declared_allow: allowEntries.length,
    usable_allow: usableAllow,
    warnings,
  };
}

function isAllowed(repoPath, line, allowlist = ALLOWLIST) {
  return allowlist.some((entry) => {
    if (!isUsableAllowEntry(entry)) {
      return false;
    }
    if (entry.file && entry.file !== repoPath) {
      return false;
    }
    return entry.regex.test(line);
  });
}

function isBinary(buffer) {
  return buffer.includes(0);
}

// 射程對帳：SKIP_DIRS 排掉的目錄是「沒驗到」，不是「驗過且乾淨」。掃的時候照實際目錄樹
// （不是照宣告清單）把真的遇到、真的被排掉的目錄逐個記下來，收尾才講得出這張 PASS 沒涵蓋哪裡。
// 閘沒射到的地方一定會漂，而一份不揭露射程的 PASS 會被讀成「整棵樹都乾淨」。
function listFiles(dir, rootDir = ROOT_DIR, skipped = []) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        skipped.push(toRepoPath(path.join(dir, entry.name), rootDir));
        continue;
      }
      result.push(...listFiles(path.join(dir, entry.name), rootDir, skipped));
      continue;
    }
    if (entry.isFile()) {
      result.push(path.join(dir, entry.name));
    }
  }
  return result;
}

function scanFile(filePath, rootDir = ROOT_DIR, counters = null) {
  const repoPath = toRepoPath(filePath, rootDir);
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    // 偵測器自己讀不到一個檔，不得把整趟收尾一起吞掉：記成具名的 read error，
    // 讓 main() 仍印得出 checked 計數，並用專屬 exit code 跟「真的掃到 redline」分開。
    if (counters) {
      counters.read_errors.push({
        file: repoPath,
        code: error.code || 'UNKNOWN',
        message: error.message,
      });
    }
    return [];
  }
  if (isBinary(buffer)) {
    if (counters) {
      counters.binary_skipped += 1;
    }
    return [];
  }

  const findings = [];
  const lines = buffer.toString('utf8').split(/\r?\n/);
  if (counters) {
    counters.files_checked += 1;
    counters.lines_checked += lines.length;
  }
  lines.forEach((line, index) => {
    if (isAllowed(repoPath, line)) {
      return;
    }
    for (const pattern of REDLINE_PATTERNS) {
      const match = line.match(pattern.regex);
      if (match) {
        findings.push({
          file: repoPath,
          line: index + 1,
          id: pattern.id,
          match: pattern.id === 'secret-token' ? '<redacted secret pattern>' : match[0],
        });
      }
    }
  });
  return findings;
}

// 回傳 findings + 實際檢查量。零命中只有在 files_checked >= 1 時才有意義。
function scanTree(rootDir = ROOT_DIR, listCheck = checkListPredicates()) {
  const counters = {
    files_checked: 0,
    lines_checked: 0,
    binary_skipped: 0,
    read_errors: [],
    skipped_dirs: [],
  };
  // 判準清單空掉時連掃都不掃：掃完再說「零命中」只是多產一份沒有意義的通過證據。
  if (!listCheck.ok) {
    return { findings: [], ...counters, list_check: listCheck };
  }
  const findings = listFiles(rootDir, rootDir, counters.skipped_dirs).flatMap((filePath) =>
    scanFile(filePath, rootDir, counters),
  );
  return { findings, ...counters, list_check: listCheck };
}

// 收尾判決是一個純函式：main() 只負責印與 exit，測試才能直接驗判準本身。
// 五態各自一個 exit code，否則「判準空了」「掃壞了」「掃到了」在 rc 層無法區分。
// 第六態（根路徑拿不到明示參數）在讀 argv 時就判掉、不進這裡，見 refuseRootVerdict。
function decideExit(result, rootDir = ROOT_DIR) {
  const readErrors = result.read_errors || [];
  const listCheck = result.list_check || checkListPredicates();
  const skippedDirs = result.skipped_dirs || [];
  const checked =
    `files_checked=${result.files_checked} lines_checked=${result.lines_checked} ` +
    `binary_skipped=${result.binary_skipped} read_errors=${readErrors.length} ` +
    `usable_patterns=${listCheck.usable_patterns}/${listCheck.declared_patterns} ` +
    `skipped_dirs=${skippedDirs.length}`;

  // 判準清單一條可用的都沒有 → 走拒絕分支。這在讀任何檔之前就能斷定，不必等掃完才說零命中。
  if (!listCheck.ok) {
    return {
      code: 4,
      stream: 'error',
      lines: [
        `FAIL IP redline scan has no usable detection pattern — refused before reading any file (${checked})`,
      ],
    };
  }

  // 偵測器自己讀失敗 → fail closed，但收尾照印：講得出是哪個檔、什麼 errno。
  if (readErrors.length) {
    return {
      code: 3,
      stream: 'error',
      lines: [
        `FAIL IP redline scan could not read ${readErrors.length} file(s) — scan is incomplete (${checked}):`,
        ...readErrors.map((entry) => `${entry.file} [read-error] ${entry.code}: ${entry.message}`),
      ],
    };
  }

  // checked>=1 才算過：掃了 0 個檔的「零命中」不是通過，是閘沒跑到。
  if (result.files_checked === 0) {
    return {
      code: 2,
      stream: 'error',
      lines: [`FAIL IP redline scan checked 0 files under ${rootDir} — zero hits proves nothing (${checked})`],
    };
  }

  if (result.findings.length) {
    return {
      code: 1,
      stream: 'error',
      lines: [
        `FAIL IP redline scan found private markers or token-shaped secrets (${checked}):`,
        ...result.findings.map((finding) => `${finding.file}:${finding.line} [${finding.id}] ${finding.match}`),
      ],
    };
  }

  // 通過也要交代射程：射程外的目錄一律具名列成「未驗」，不讓 PASS 被讀成整棵樹都掃過。
  const passLines = [`PASS IP redline scan: no redline hits (${checked})`];
  if (skippedDirs.length) {
    passLines.push(
      `NOTE out of scan scope, counted as unverified (not as clean): ${skippedDirs.join(', ')}`,
    );
  }
  return { code: 0, stream: 'log', lines: passLines };
}

function main(argv = process.argv.slice(2), env = process.env) {
  // 掃描根先判：拿不到明示的根就連掃都不掃。掃完再說「零命中」只是產一份掃錯對象的通過證據。
  const resolution = resolveRootDir(argv, env);
  if (!resolution.ok) {
    const refusal = refuseRootVerdict(resolution);
    console[refusal.stream](refusal.lines[0]);
    process.exit(refusal.code);
  }
  const rootDir = resolution.root;
  // 啟動時就把清單型判準檢一次並把警告吼出來，不等第一個檔被讀進來。
  const listCheck = checkListPredicates();
  for (const warning of listCheck.warnings) {
    console.error(warning);
  }
  const verdict = decideExit(scanTree(rootDir, listCheck), rootDir);
  for (const line of verdict.lines) {
    console[verdict.stream](line);
  }
  if (verdict.code !== 0) {
    process.exit(verdict.code);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  scanTree,
  scanFile,
  decideExit,
  resolveRootDir,
  refuseRootVerdict,
  isAllowed,
  isUsableAllowEntry,
  isUsablePattern,
  checkListPredicates,
  ALLOWLIST,
  REDLINE_PATTERNS,
};
