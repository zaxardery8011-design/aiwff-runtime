#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// 掃描根目錄可用 IP_SCAN_ROOT 覆寫——讓 regression 測項能把同一支正式腳本指向
// 受控 fixture 目錄，證明 checked 計數與 fail-closed 分支真的有鑑別力。
const ROOT_DIR = path.resolve(process.env.IP_SCAN_ROOT || path.join(__dirname, '..'));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'logs']);

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

function listFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        result.push(...listFiles(path.join(dir, entry.name)));
      }
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
function scanTree(rootDir = ROOT_DIR) {
  const counters = { files_checked: 0, lines_checked: 0, binary_skipped: 0, read_errors: [] };
  const findings = listFiles(rootDir).flatMap((filePath) => scanFile(filePath, rootDir, counters));
  return { findings, ...counters };
}

// 收尾判決是一個純函式：main() 只負責印與 exit，測試才能直接驗判準本身。
// 四態各自一個 exit code，否則「掃壞了」與「掃到了」在 rc 層無法區分。
function decideExit(result, rootDir = ROOT_DIR) {
  const readErrors = result.read_errors || [];
  const checked =
    `files_checked=${result.files_checked} lines_checked=${result.lines_checked} ` +
    `binary_skipped=${result.binary_skipped} read_errors=${readErrors.length}`;

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

  return { code: 0, stream: 'log', lines: [`PASS IP redline scan: no redline hits (${checked})`] };
}

function main() {
  const verdict = decideExit(scanTree(ROOT_DIR), ROOT_DIR);
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

module.exports = { scanTree, scanFile, decideExit, isAllowed, isUsableAllowEntry, ALLOWLIST };
