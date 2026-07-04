#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'logs']);

const REDLINE_PATTERNS = [
  {
    id: 'internal-keyword',
    regex:
      /SOUL|soul_baseline|baseline\.json|bless|SoulIntegrity|PreToolUse|Lonelybo|lonelybo|寂寞伯|隊長|臻安鑫|韓|AIWFF_演變史|三關|dispatch tier|node_report|peer_inbox|outbox_queue|BPC|factory_stream|工廠直播|名冊|governance_hub|ZAX-CORE|100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|tailscale|tailnet/i,
  },
  {
    id: 'secret-token',
    regex:
      /([0-9]{8,10}:[A-Za-z0-9_-]{35,})|(sk-ant-[A-Za-z0-9_-]{20,})|(ghp_[A-Za-z0-9_]{20,})|(xox[baprs]-[A-Za-z0-9-]{20,})|(AIza[0-9A-Za-z_-]{20,})|(AKIA[0-9A-Z]{16})|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  },
];

const ALLOWLIST = [
  {
    file: 'scripts/ip-redline-scan.js',
    regex: /.*/,
    reason: 'scanner owns the literal redline patterns',
  },
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
