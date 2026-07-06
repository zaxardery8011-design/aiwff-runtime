#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
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

function toRepoPath(filePath) {
  return path.relative(ROOT_DIR, filePath).replaceAll(path.sep, '/');
}

function isAllowed(repoPath, line) {
  return ALLOWLIST.some((entry) => {
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

function scanFile(filePath) {
  const repoPath = toRepoPath(filePath);
  const buffer = fs.readFileSync(filePath);
  if (isBinary(buffer)) {
    return [];
  }

  const findings = [];
  const lines = buffer.toString('utf8').split(/\r?\n/);
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

function main() {
  const findings = listFiles(ROOT_DIR).flatMap(scanFile);
  if (findings.length) {
    console.error('FAIL IP redline scan found private markers or token-shaped secrets:');
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.id}] ${finding.match}`);
    }
    process.exit(1);
  }

  console.log('PASS IP redline scan: no redline hits');
}

main();
