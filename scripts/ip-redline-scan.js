#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOCAL_TERMS_FILE = path.join(ROOT_DIR, '.ip-redline-terms.local.json');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'logs']);
const SKIP_FILES = new Set(['.bak_iptermfix_20260824_0006']);
const MAX_HASH_CANDIDATE_CHARS = 80;
const BASE64_TOKEN_REGEX = /[A-Za-z0-9+/_-]{4,}={0,2}/g;

// Private keyword hashes live in a local-only file and must not enter version control.
function loadLocalTermHashes() {
  if (!fs.existsSync(LOCAL_TERMS_FILE)) {
    console.error(
      `FAIL IP redline scan: local private term hash list missing at ${path.basename(
        LOCAL_TERMS_FILE,
      )}; private term matching was not executed.`,
    );
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LOCAL_TERMS_FILE, 'utf8'));
  } catch (error) {
    console.error(`FAIL IP redline scan: could not parse local private term hash list: ${error.message}`);
    process.exit(2);
  }

  const hashes = Array.isArray(parsed) ? parsed : parsed.hashes;
  if (
    !Array.isArray(hashes) ||
    hashes.length === 0 ||
    !hashes.every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
  ) {
    console.error('FAIL IP redline scan: local private term hash list is empty or invalid.');
    process.exit(2);
  }

  return new Set(hashes.map((value) => value.toLowerCase()));
}

function normalizeTerm(value) {
  return value.normalize('NFKC').toLowerCase();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(normalizeTerm(value), 'utf8').digest('hex');
}

function hasPrivateTermHash(value, termHashes) {
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
    if (!decoded || decoded.includes('\uFFFD') || /[\u0000-\u0008\u000E-\u001F]/.test(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function hasEncodedPrivateTermHash(line, termHashes) {
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
    if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      result.push(path.join(dir, entry.name));
    }
  }
  return result;
}

function scanLine(repoPath, line, index, termHashes) {
  if (isAllowed(repoPath, line)) {
    return [];
  }

  const findings = [];
  if (hasPrivateTermHash(line, termHashes)) {
    findings.push({
      file: repoPath,
      line: index + 1,
      id: 'private-term-hash',
      match: '<redacted private term hash match>',
    });
  }
  if (hasEncodedPrivateTermHash(line, termHashes)) {
    findings.push({
      file: repoPath,
      line: index + 1,
      id: 'encoded-private-term-hash',
      match: '<redacted encoded private term hash match>',
    });
  }

  for (const pattern of REDLINE_PATTERNS) {
    const match = line.match(pattern.regex);
    if (match && (!pattern.predicate || pattern.predicate(match[0]))) {
      findings.push({
        file: repoPath,
        line: index + 1,
        id: pattern.id,
        match: '<redacted redline pattern>',
      });
    }
  }
  return findings;
}

function scanFile(filePath, termHashes) {
  const repoPath = toRepoPath(filePath);
  const buffer = fs.readFileSync(filePath);
  if (isBinary(buffer)) {
    return [];
  }

  return buffer
    .toString('utf8')
    .split(/\r?\n/)
    .flatMap((line, index) => scanLine(repoPath, line, index, termHashes));
}

function main() {
  const termHashes = loadLocalTermHashes();
  const scanRoots = process.argv.slice(2).map((value) => path.resolve(value));
  const roots = scanRoots.length ? scanRoots : [ROOT_DIR];
  const findings = roots.flatMap((root) => listFiles(root).flatMap((filePath) => scanFile(filePath, termHashes)));
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
