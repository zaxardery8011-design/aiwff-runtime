#!/usr/bin/env node

// IP redline scan — 推上 public repo 之前的閘。
//
// 私有詞的來源只有一份：本機的 .ip-redline-terms.local.json（sha256 hash 清單，不進版控）。
// 檔案內容與 git metadata（commit author／email／subject、分支名、tag 名、當前 identity）
// 都用同一份 hash 比對；原始碼裡不內嵌任何詞（明文或編碼都不放）。
//
// 用法：
//   node scripts/ip-redline-scan.js [--root=<dir>] [--terms=<hash-file>]
//   node scripts/ip-redline-scan.js <dir>          （舊版位置參數，等同 --root=<dir>，只收一個）
//
// exit code 對照（每一種失敗各自一個碼，不共用）：
//   0  PASS：掃了 >=1 個檔，檔案內容與 metadata 都零命中
//   1  命中：檔案內容或 git metadata 掃到私有詞／token 形狀的 secret／非公開 IPv4
//   2  空掃：掃了 0 個檔——零命中什麼都證明不了
//   3  讀檔錯誤：有檔讀不到，掃描不完整（具名列出檔案與 errno）
//   4  判準清單空：REDLINE_PATTERNS 沒有任何可用條目，讀檔前就拒絕
//   5  掃描根被拒：沿用繼承來的 IP_SCAN_ROOT、--root 沒給值、或位置參數不只一個
//   6  詞表不可用：私有詞 hash 檔不存在、無法解析、為空或格式不對——私有詞比對沒執行

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 吃根路徑的入口一律要求明示參數：掃描根的 override 只認呼叫端當場給的 `--root=<dir>`
// （或舊版的單一位置參數）。繼承來的 IP_SCAN_ROOT 不算明示——殘留在 shell／CI job 裡的舊值會讓正式閘
// （npm run scan:ip）靜默掃到別的樹，而且因為 files_checked>=1 還會印出 PASS，
// 等於拿一份掃錯對象的綠燈蓋掉真正的 repo。缺明示參數就 fail closed，不猜呼叫端的意圖。
const DEFAULT_ROOT = path.join(__dirname, '..');
// 模組層常數只從 __dirname 推導，載入時不讀任何 ambient 狀態。
const ROOT_DIR = path.resolve(DEFAULT_ROOT);
// 詞表預設跟著 scanner 所在的 repo 走，不跟著掃描根走：worktree／暫存解壓目錄裡沒有詞表，
// 要用別份就明示 --terms=<file>。
const LOCAL_TERMS_FILE = path.join(ROOT_DIR, '.ip-redline-terms.local.json');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'logs']);
const SKIP_FILES = new Set(['.bak_iptermfix_20260824_0006']);
const MAX_HASH_CANDIDATE_CHARS = 80;
const BASE64_TOKEN_REGEX = /[A-Za-z0-9+/_-]{4,}={0,2}/g;

const ROOT_FLAG = '--root';
const TERMS_FLAG = '--terms';

function parseFlag(argv, flag) {
  for (const arg of argv) {
    if (arg === flag) {
      return { present: true, value: '' };
    }
    if (arg.startsWith(`${flag}=`)) {
      return { present: true, value: arg.slice(flag.length + 1) };
    }
  }
  return { present: false, value: '' };
}

function parseRootFlag(argv) {
  return parseFlag(argv, ROOT_FLAG);
}

function positionalArgs(argv) {
  return argv.filter((arg) => !arg.startsWith('--'));
}

// 純函式回傳 { ok, reason, root, declared }，讓測試能直接驗這條判準本身而不是驗 spawn 的副作用。
function resolveRootDir(argv = process.argv.slice(2), env = process.env) {
  const flag = parseRootFlag(argv);
  const positional = positionalArgs(argv);
  if (flag.present) {
    // 給了旗標卻沒給值 ＝ 參數沒填好，不是「用預設」。
    if (flag.value.trim() === '') {
      return { ok: false, reason: 'empty_explicit_root', root: null, declared: ROOT_FLAG };
    }
    if (positional.length) {
      return { ok: false, reason: 'ambiguous_root', root: null, declared: `${ROOT_FLAG}=${flag.value} ${positional.join(' ')}` };
    }
    return {
      ok: true,
      reason: 'explicit_flag',
      root: path.resolve(flag.value),
      declared: `${ROOT_FLAG}=${flag.value}`,
    };
  }
  // 舊版呼叫法（master 的 pre-push hook 解 git archive 後傳目錄）相容保留：單一位置參數等同 --root。
  if (positional.length > 1) {
    return { ok: false, reason: 'ambiguous_root', root: null, declared: positional.join(' ') };
  }
  if (positional.length === 1) {
    return { ok: true, reason: 'explicit_positional', root: path.resolve(positional[0]), declared: positional[0] };
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

// 根路徑被拒有專屬 exit code 5，跟「掃壞了」(3)、「掃到了」(1)、「空掃」(2)、「詞表不可用」(6) 在 rc 層分得開。
function refuseRootVerdict(resolution) {
  const lines = {
    inherited_root_without_flag:
      `FAIL IP redline scan refused: inherited ${resolution.declared} is not an explicit root — ` +
      `pass ${ROOT_FLAG}=<dir> at the call site or unset it ` +
      '(a stale ambient root scans the wrong tree and still prints PASS)',
    empty_explicit_root:
      `FAIL IP redline scan refused: ${ROOT_FLAG} was given without a directory — ` +
      'an empty root is a missing parameter, not the repo root',
    ambiguous_root:
      `FAIL IP redline scan refused: more than one scan root given (${resolution.declared}) — ` +
      `pass exactly one ${ROOT_FLAG}=<dir>`,
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

function resolveTermsFile(argv = process.argv.slice(2)) {
  const flag = parseFlag(argv, TERMS_FLAG);
  if (flag.present) {
    if (flag.value.trim() === '') {
      return { ok: false, reason: 'empty_explicit_terms', file: null };
    }
    return { ok: true, reason: 'explicit_flag', file: path.resolve(flag.value) };
  }
  return { ok: true, reason: 'default_local_file', file: LOCAL_TERMS_FILE };
}

// 私有詞 hash 只放在不進版控的本機檔。純函式回傳 { ok, reason, hashes, file }，
// 拿不到就由 main() 走 code 6——跟「空掃」(2) 分開：空掃是射程問題，缺詞表是判準問題。
function loadLocalTermHashes(termsFile = LOCAL_TERMS_FILE) {
  const fail = (reason, detail) => ({ ok: false, reason, detail, hashes: null, file: termsFile });
  if (!termsFile || !fs.existsSync(termsFile)) {
    return fail('terms_file_missing', 'file does not exist');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(termsFile, 'utf8'));
  } catch (error) {
    return fail('terms_file_unparseable', error.message);
  }
  const hashes = Array.isArray(parsed) ? parsed : parsed && parsed.hashes;
  if (!Array.isArray(hashes) || hashes.length === 0) {
    return fail('terms_file_empty', 'no hash entries');
  }
  if (!hashes.every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))) {
    return fail('terms_file_invalid', 'every entry must be a 64-char sha256 hex string');
  }
  return { ok: true, reason: 'ok', detail: '', hashes: new Set(hashes.map((value) => value.toLowerCase())), file: termsFile };
}

function refuseTermsVerdict(load) {
  return {
    code: 6,
    stream: 'error',
    lines: [
      `FAIL IP redline scan refused: private term hash list unusable (reason=${load.reason}: ${load.detail}) ` +
        `at ${load.file ? path.basename(load.file) : TERMS_FLAG} — private term matching was not executed`,
    ],
  };
}

function normalizeTerm(value) {
  return value.normalize('NFKC').toLowerCase();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(normalizeTerm(value), 'utf8').digest('hex');
}

function hasPrivateTermHash(value, termHashes) {
  if (!termHashes || termHashes.size === 0) {
    return false;
  }
  const chars = [...value];
  for (let start = 0; start < chars.length; start += 1) {
    const maxEnd = Math.min(chars.length, start + MAX_HASH_CANDIDATE_CHARS);
    for (let end = start + 1; end <= maxEnd; end += 1) {
      if (termHashes.has(sha256Hex(chars.slice(start, end).join('')))) {
        return true;
      }
    }
  }
  return false;
}

function decodeBase64Token(token) {
  const padded = token.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(token.length / 4) * 4, '=');
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    if (!decoded || decoded.includes('�') || /[\u0000-\u0008\u000E-\u001F]/.test(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function hasEncodedPrivateTermHash(line, termHashes) {
  if (!termHashes || termHashes.size === 0) {
    return false;
  }
  for (const match of line.matchAll(BASE64_TOKEN_REGEX)) {
    const decoded = decodeBase64Token(match[0]);
    if (decoded && hasPrivateTermHash(decoded, termHashes)) {
      return true;
    }
  }
  return false;
}

function isNonPublicIpv4(value) {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const REDLINE_PATTERNS = [
  {
    id: 'secret-token',
    regex:
      /([0-9]{8,10}:[A-Za-z0-9_-]{35,})|(sk-ant-[A-Za-z0-9_-]{20,})|(ghp_[A-Za-z0-9_]{20,})|(xox[baprs]-[A-Za-z0-9-]{20,})|(AIza[0-9A-Za-z_-]{20,})|(AKIA[0-9A-Z]{16})|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  },
  {
    id: 'non-public-ipv4',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    predicate: isNonPublicIpv4,
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
// 回傳 null＝這條可用；回傳字串＝具名的拒絕理由。
function allowEntryRejectReason(entry) {
  if (!entry) {
    return 'entry is not an object';
  }
  if (!(entry.regex instanceof RegExp)) {
    return 'regex is not a RegExp';
  }
  // 空 pattern（//、new RegExp('')）與 /.*/ 這類能匹配空字串的式子，對每一行都成立＝match-all。
  if (entry.regex.test('')) {
    return 'regex matches the empty string (match-all)';
  }
  // file 只有兩種合法值：null/undefined＝明示涵蓋全部檔案；非空字串＝限定該檔。
  // 空字串或空白字串是「scope 欄位沒填好」，不是 wildcard。
  if (entry.file === null || entry.file === undefined) {
    return null;
  }
  if (typeof entry.file !== 'string') {
    return 'file is neither null nor a string';
  }
  return entry.file.trim() === '' ? 'file is an empty string (not a wildcard)' : null;
}

// 被 fail closed 掉的條目要能對回「是哪一條」，不然只知道少了幾條、不知道少了誰。
// 原文逐字落帳（regex source 與 file scope），不做摘要。
function describeAllowEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return String(entry);
  }
  const file = entry.file === null || entry.file === undefined ? '*' : JSON.stringify(entry.file);
  const regex = entry.regex instanceof RegExp ? String(entry.regex) : JSON.stringify(entry.regex);
  const reason = entry.reason ? ` reason=${JSON.stringify(entry.reason)}` : '';
  return `file=${file} regex=${regex}${reason}`;
}

function isUsableAllowEntry(entry) {
  return allowEntryRejectReason(entry) === null;
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
  // 「幾條被 fail closed 掉」只有計數時，部分被拒是完全靜默的（2 條掉 1 條仍 usable>0）。
  // 把每一條被拒的原文＋具名理由落帳，攔截才有分母可對。
  const rejectedAllow = [];
  let usableAllow = 0;
  allowEntries.forEach((entry, index) => {
    const reason = allowEntryRejectReason(entry);
    if (reason === null) {
      usableAllow += 1;
      return;
    }
    rejectedAllow.push({ index, reason, definition: describeAllowEntry(entry) });
  });
  const warnings = rejectedAllow.map(
    (rejected) =>
      `WARN IP redline scan allowlist entry #${rejected.index} refused (${rejected.reason}): ${rejected.definition}`,
  );
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
    rejected_allow: rejectedAllow,
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

// 一個字串（一行檔案內容或一個 metadata 欄位）的共用判準：先過白名單，再比私有詞 hash
// （明文＋base64 解碼後），最後逐條 pattern。所有命中一律遮蔽，不讓偵測器的輸出自己變成第二個外洩點。
function matchValue(scope, value, termHashes) {
  const hits = [];
  if (typeof value !== 'string' || value === '' || isAllowed(scope, value)) {
    return hits;
  }
  if (hasPrivateTermHash(value, termHashes)) {
    hits.push({ id: 'private-term-hash', match: '<redacted private term hash match>' });
  }
  if (hasEncodedPrivateTermHash(value, termHashes)) {
    hits.push({ id: 'encoded-private-term-hash', match: '<redacted encoded private term hash match>' });
  }
  for (const pattern of REDLINE_PATTERNS) {
    const match = value.match(pattern.regex);
    if (match && (!pattern.predicate || pattern.predicate(match[0]))) {
      hits.push({
        id: pattern.id,
        match: pattern.id === 'secret-token' ? '<redacted secret pattern>' : '<redacted redline pattern>',
      });
    }
  }
  return hits;
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
    if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      result.push(path.join(dir, entry.name));
    }
  }
  return result;
}

// 掃描域綁「git 追蹤域」而不是「目錄樹」：這道閘要防的是「推上 public repo 的內容外洩」，
// 而會被推上去的就是 git 追蹤的那些檔。用目錄樹當射程會把整棵本地工作樹（暫存檔、輸出、
// state）一起算進來，閘因此恆紅，而恆紅的閘等於沒有閘。改綁追蹤域還有一個好處：排除清單
// 與 .gitignore 不必再各維護一份，「被 git add 進來就自動進射程」，反向失明檢查內生成立。
const GIT_TIMEOUT_MS = 30000;

function runGit(rootDir, args) {
  const res = spawnSync('git', ['-C', rootDir, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    return { ok: false, reason: `git_spawn_${res.error.code || 'ERROR'}`, stdout: '' };
  }
  if (res.status !== 0) {
    return { ok: false, reason: `git_exit_${res.status}`, stdout: '' };
  }
  return { ok: true, reason: 'ok', stdout: res.stdout || '' };
}

function splitNul(stdout) {
  return stdout.split('\0').filter((value) => value !== '');
}

// 拿不到追蹤域就 fail closed 退回全樹掃 + WARN：寧可多掃一堆本地檔（吵），也不要因為
// 「這裡不是 git checkout」就靜默縮小射程去掃 0 個檔然後印綠燈（漏）。
function resolveScanDomain(rootDir = ROOT_DIR) {
  const inside = runGit(rootDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    return { ok: false, mode: 'full_tree', reason: inside.reason, files: null, unverified: [] };
  }
  if (inside.stdout.trim() !== 'true') {
    return { ok: false, mode: 'full_tree', reason: 'not_a_work_tree', files: null, unverified: [] };
  }
  const tracked = runGit(rootDir, ['ls-files', '-z']);
  if (!tracked.ok) {
    return { ok: false, mode: 'full_tree', reason: tracked.reason, files: null, unverified: [] };
  }
  // --directory 讓整個未追蹤目錄收斂成一個條目，未驗清單才具名得起來而不是攤成幾百行。
  const others = runGit(rootDir, ['ls-files', '--others', '--exclude-standard', '--directory', '-z']);
  const unverified = others.ok ? splitNul(others.stdout) : [];
  const files = [];
  // 追蹤但工作樹裡不存在（git rm 尚未 commit）＝沒得掃，具名列成未驗，不丟進 read_errors
  // 把整趟判成 code 3。
  for (const rel of splitNul(tracked.stdout)) {
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs)) {
      files.push(abs);
    } else {
      unverified.push(`${rel} [tracked-but-absent]`);
    }
  }
  return { ok: true, mode: 'git_tracked', reason: 'git_tracked', files, unverified, unverified_ok: others.ok };
}

// --- git metadata 射程 ---
// 檔案內容型的閘只掃 blob，但推上 public repo 的不只 blob：commit 的 author 名／email／
// subject、分支名、tag 名，GitHub 的 /commits 頁面一行一行公開印出來。閘在工作樹層綠了，
// 不代表推出去的東西乾淨——這是射程問題，不是 pattern 不夠多的問題。
// 這一段拿同一份本機 hash 詞表（不另開一份，免得兩份清單各漂各的）去掃四類 metadata。
const METADATA_FIELD_SEP = '\x1f';

function matchMetadata(scope, ref, field, value, termHashes = null) {
  return matchValue(scope, value, termHashes).map((hit) => ({ scope, ref, field, ...hit }));
}

function scanGitMetadata(rootDir = ROOT_DIR, termHashes = null) {
  const empty = { findings: [], commits_checked: 0, refs_checked: 0, unverified: [] };
  const inside = runGit(rootDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    return { ok: false, reason: inside.reason, ...empty };
  }
  if (inside.stdout.trim() !== 'true') {
    return { ok: false, reason: 'not_a_work_tree', ...empty };
  }

  const findings = [];
  const unverified = [];
  let commitsChecked = 0;
  let refsChecked = 0;

  // (1) commit author／email／subject —— 全歷史，不只 HEAD 那一顆。
  const log = runGit(rootDir, [
    'log',
    `--format=%H${METADATA_FIELD_SEP}%an${METADATA_FIELD_SEP}%ae${METADATA_FIELD_SEP}%s`,
  ]);
  if (!log.ok) {
    unverified.push(`commit history [${log.reason}]`);
  } else {
    for (const row of log.stdout.split(/\r?\n/)) {
      if (row === '') {
        continue;
      }
      const [sha, authorName, authorEmail, subject] = row.split(METADATA_FIELD_SEP);
      commitsChecked += 1;
      const short = (sha || '').slice(0, 7) || '<unknown>';
      findings.push(...matchMetadata('commit', short, 'author_name', authorName, termHashes));
      findings.push(...matchMetadata('commit', short, 'author_email', authorEmail, termHashes));
      findings.push(...matchMetadata('commit', short, 'subject', subject, termHashes));
    }
  }

  // HEAD 走不到的 ref 不在上面那趟射程裡：它們自己的 commit 一旦被 push 就整串上去。
  // 具名列成未驗，不讓「HEAD 全歷史零命中」被讀成「這個 repo 的所有 commit 都乾淨」。
  const unmerged = runGit(rootDir, [
    'for-each-ref',
    '--format=%(refname)',
    '--no-merged',
    'HEAD',
    'refs/heads',
    'refs/remotes',
  ]);
  if (!unmerged.ok) {
    unverified.push(`refs unreachable from HEAD [${unmerged.reason}]`);
  } else {
    for (const ref of unmerged.stdout.split(/\r?\n/).filter((value) => value.trim() !== '')) {
      unverified.push(`${ref.trim()} [commits unreachable from HEAD]`);
    }
  }

  // (2) 分支名 (3) tag 名 —— 名字本身就會跟著 push 上去。
  const refSources = [
    { scope: 'branch', args: ['branch', '-a', '--format=%(refname)'] },
    { scope: 'tag', args: ['tag', '-l'] },
  ];
  for (const source of refSources) {
    const res = runGit(rootDir, source.args);
    if (!res.ok) {
      unverified.push(`${source.scope} names [${res.reason}]`);
      continue;
    }
    for (const name of res.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      refsChecked += 1;
      findings.push(...matchMetadata(source.scope, name, 'name', name, termHashes));
    }
  }

  // (4) 當前 identity —— 下一顆 commit 會蓋上去的那組值，趁還沒 commit 就攔。
  for (const key of ['user.name', 'user.email']) {
    const res = runGit(rootDir, ['config', '--get', key]);
    if (!res.ok) {
      unverified.push(`${key} [unset]`);
      continue;
    }
    refsChecked += 1;
    findings.push(...matchMetadata('config', key, 'value', res.stdout.trim(), termHashes));
  }

  return {
    ok: true,
    reason: 'git_metadata',
    findings,
    commits_checked: commitsChecked,
    refs_checked: refsChecked,
    unverified,
  };
}

function scanFile(filePath, rootDir = ROOT_DIR, counters = null, termHashes = null) {
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

  const lines = buffer.toString('utf8').split(/\r?\n/);
  if (counters) {
    counters.files_checked += 1;
    counters.lines_checked += lines.length;
  }
  return lines.flatMap((line, index) =>
    matchValue(repoPath, line, termHashes).map((hit) => ({ file: repoPath, line: index + 1, ...hit })),
  );
}

// 回傳 findings + 實際檢查量。零命中只有在 files_checked >= 1 時才有意義。
function scanTree(rootDir = ROOT_DIR, listCheck = checkListPredicates(), termHashes = null) {
  const counters = {
    files_checked: 0,
    lines_checked: 0,
    binary_skipped: 0,
    read_errors: [],
    skipped_dirs: [],
  };
  // 判準清單空掉時連掃都不掃：掃完再說「零命中」只是多產一份沒有意義的通過證據。
  if (!listCheck.ok) {
    return {
      findings: [],
      ...counters,
      list_check: listCheck,
      scan_domain: 'unknown',
      domain_warnings: [],
      metadata: null,
    };
  }
  const domain = resolveScanDomain(rootDir);
  const domainWarnings = [];
  // metadata 拿不到（不是 git checkout／git 叫不動）不得靜默：那代表 commit author、
  // 分支名、tag 名這一整塊射程這趟完全沒驗到，要當場吼出來並列進未驗清單。
  const metadata = scanGitMetadata(rootDir, termHashes);
  if (!metadata.ok) {
    domainWarnings.push(
      `WARN IP redline scan could not bind to the git metadata domain (reason=${metadata.reason}) — ` +
        'commit authors/emails/subjects, branch names, tag names and the current identity are UNVERIFIED for this run',
    );
  }
  let files;
  if (domain.ok) {
    files = domain.files;
    counters.skipped_dirs = domain.unverified;
    if (!domain.unverified_ok) {
      domainWarnings.push(
        'WARN IP redline scan could not list untracked entries — the unverified list below is incomplete',
      );
    }
  } else {
    domainWarnings.push(
      `WARN IP redline scan could not bind to the git tracked domain (reason=${domain.reason}) — ` +
        `fail closed to a full-tree scan of ${rootDir}; hits may include files that will never be published`,
    );
    files = listFiles(rootDir, rootDir, counters.skipped_dirs);
  }
  const findings = files.flatMap((filePath) => scanFile(filePath, rootDir, counters, termHashes));
  return {
    findings,
    ...counters,
    list_check: listCheck,
    scan_domain: domain.mode,
    domain_warnings: domainWarnings,
    metadata,
  };
}

// 收尾判決是一個純函式：main() 只負責印與 exit，測試才能直接驗判準本身。
// 五態各自一個 exit code，否則「判準空了」「掃壞了」「掃到了」在 rc 層無法區分。
// 根路徑被拒 (5) 與詞表不可用 (6) 在讀 argv／詞表時就判掉、不進這裡，見 refuseRootVerdict／refuseTermsVerdict。
function decideExit(result, rootDir = ROOT_DIR) {
  const readErrors = result.read_errors || [];
  const listCheck = result.list_check || checkListPredicates();
  const skippedDirs = result.skipped_dirs || [];
  // metadata 三態要分得開：沒掃（欄位不在）／掃不到（git 叫不動）／掃了。
  // 合成一個數字會讓「這趟根本沒驗 metadata」長得跟「驗了、零命中」一模一樣。
  const metadata = result.metadata || null;
  const metaFindings = (metadata && metadata.findings) || [];
  const metaUnverified = (metadata && metadata.unverified) || [];
  const metaDomain = metadata
    ? (metadata.ok ? 'git_metadata' : `unavailable:${metadata.reason}`)
    : 'not_scanned';
  const checked =
    `files_checked=${result.files_checked} lines_checked=${result.lines_checked} ` +
    `binary_skipped=${result.binary_skipped} read_errors=${readErrors.length} ` +
    `usable_patterns=${listCheck.usable_patterns}/${listCheck.declared_patterns} ` +
    `usable_allow=${listCheck.usable_allow}/${listCheck.declared_allow} ` +
    `skipped_dirs=${skippedDirs.length} scan_domain=${result.scan_domain || 'unknown'} ` +
    `metadata_domain=${metaDomain} metadata_commits=${(metadata && metadata.commits_checked) || 0} ` +
    `metadata_refs=${(metadata && metadata.refs_checked) || 0} metadata_hits=${metaFindings.length}`;

  // 射程揭露是每一種收尾都欠的帳，不是 PASS 的附贈品。以前這行只寫在 code 0 分支，
  // 結果閘一旦恆紅（走 code 1）就永遠印不出來——揭露只在「不需要它的時候」出現。
  // 這裡把它抽成共用行，五個分支一律附上。
  // metadata 命中也走同一條共用尾巴：不論這趟是因為哪一種理由收尾，只要 metadata 有命中，
  // 就一定講得出是哪顆 commit／哪個分支。塞進某一個分支等於讓另外四種收尾靜默吞掉它。
  const metaHitLines = metaFindings.map(
    (finding) => `git-metadata ${finding.scope}:${finding.ref} [${finding.id}] ${finding.field}=${finding.match}`,
  );
  const scopeLines = [
    ...metaHitLines,
    ...(skippedDirs.length
      ? [`NOTE out of scan scope, counted as unverified (not as clean): ${skippedDirs.join(', ')}`]
      : []),
    ...(metaUnverified.length
      ? [`NOTE out of git-metadata scan scope, counted as unverified (not as clean): ${metaUnverified.join(', ')}`]
      : []),
  ];

  // 判準清單一條可用的都沒有 → 走拒絕分支。這在讀任何檔之前就能斷定，不必等掃完才說零命中。
  if (!listCheck.ok) {
    return {
      code: 4,
      stream: 'error',
      lines: [
        `FAIL IP redline scan has no usable detection pattern — refused before reading any file (${checked})`,
        ...scopeLines,
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
        ...scopeLines,
      ],
    };
  }

  // checked>=1 才算過：掃了 0 個檔的「零命中」不是通過，是閘沒跑到。
  if (result.files_checked === 0) {
    return {
      code: 2,
      stream: 'error',
      lines: [
        `FAIL IP redline scan checked 0 files under ${rootDir} — zero hits proves nothing (${checked})`,
        ...scopeLines,
      ],
    };
  }

  // 檔案內容命中與 metadata 命中同屬 code 1：外洩就是外洩，差別只在載體是 blob 還是 commit 頭。
  if (result.findings.length || metaFindings.length) {
    return {
      code: 1,
      stream: 'error',
      lines: [
        `FAIL IP redline scan found private markers or token-shaped secrets (${checked}):`,
        ...result.findings.map((finding) => `${finding.file}:${finding.line} [${finding.id}] ${finding.match}`),
        ...scopeLines,
      ],
    };
  }

  // 通過也要交代射程：射程外的目錄一律具名列成「未驗」，不讓 PASS 被讀成整棵樹都掃過。
  return { code: 0, stream: 'log', lines: [`PASS IP redline scan: no redline hits (${checked})`, ...scopeLines] };
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
  // 詞表拿不到就連掃都不掃：沒有私有詞判準的零命中，跟空掃一樣什麼都證明不了，但原因不同、碼不同。
  const termsResolution = resolveTermsFile(argv);
  const termsLoad = termsResolution.ok
    ? loadLocalTermHashes(termsResolution.file)
    : { ok: false, reason: termsResolution.reason, detail: `${TERMS_FLAG} was given without a file`, file: null };
  if (!termsLoad.ok) {
    const refusal = refuseTermsVerdict(termsLoad);
    console[refusal.stream](refusal.lines[0]);
    process.exit(refusal.code);
  }
  // 啟動時就把清單型判準檢一次並把警告吼出來，不等第一個檔被讀進來。
  const listCheck = checkListPredicates();
  for (const warning of listCheck.warnings) {
    console.error(warning);
  }
  const result = scanTree(rootDir, listCheck, termsLoad.hashes);
  // 掃描域退化（非 git checkout / git 叫不動）也要當場吼出來，不能只留在收尾那串計數裡。
  for (const warning of result.domain_warnings || []) {
    console.error(warning);
  }
  const verdict = decideExit(result, rootDir);
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
  resolveScanDomain,
  scanGitMetadata,
  matchMetadata,
  matchValue,
  resolveRootDir,
  refuseRootVerdict,
  resolveTermsFile,
  loadLocalTermHashes,
  refuseTermsVerdict,
  sha256Hex,
  isAllowed,
  isUsableAllowEntry,
  allowEntryRejectReason,
  describeAllowEntry,
  isUsablePattern,
  checkListPredicates,
  ALLOWLIST,
  REDLINE_PATTERNS,
};
