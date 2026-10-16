// worker 卡片標題：worker 在產出檔開頭寫的 `# 標題` 會被讀成 worker_title，
// 沒有標題行就回 null（畫面退回工單 title / id）。自己種的 data/artifacts 檔案在測試結束清掉。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');
const { readWorkerTitle } = require(path.join(ROOT_DIR, 'agent', 'index.js'));

function seedArtifact(text) {
  const taskId = crypto.randomUUID();
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const file = path.join(ARTIFACTS_DIR, `${taskId}.result.md`);
  fs.writeFileSync(file, text, 'utf8');
  return { taskId, file };
}

test('reads the first markdown heading as the worker title', (t) => {
  const { taskId, file } = seedArtifact('﻿\n# 整理本週會議重點\n\n內容……\n');
  t.after(() => fs.rmSync(file, { force: true }));
  assert.equal(readWorkerTitle(taskId), '整理本週會議重點');
});

test('returns null when the first non-empty line is not a heading', (t) => {
  const { taskId, file } = seedArtifact('只是內文，沒有標題\n# 後面的標題不算\n');
  t.after(() => fs.rmSync(file, { force: true }));
  assert.equal(readWorkerTitle(taskId), null);
});

test('returns null when the artifact does not exist', () => {
  assert.equal(readWorkerTitle(crypto.randomUUID()), null);
});

test('truncates long titles to 80 chars', (t) => {
  const { taskId, file } = seedArtifact(`# ${'長'.repeat(120)}\n`);
  t.after(() => fs.rmSync(file, { force: true }));
  const title = readWorkerTitle(taskId);
  assert.equal(title.length, 80);
  assert.ok(title.endsWith('...'));
});
