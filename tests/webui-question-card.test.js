// WebUI 任務面板：worker 進度 tail 裡的 `BLOCKED:` 行要抬成唯讀卡片，其餘情況不出卡片。
// 只把 webui.html 裡的 workerQuestion / questionCardHtml（加上 escapeHtml / fmtDate）抽進 node:vm，不起 server。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'agent', 'webui.html'), 'utf8');

function extractFunction(name) {
  const start = HTML.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'webui.html 找不到 function ' + name);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error('function ' + name + ' 括號不成對');
}

function load(progress) {
  const context = { state: { progress } };
  vm.createContext(context);
  vm.runInContext(['escapeHtml', 'fmtDate', 'workerQuestion', 'questionCardHtml'].map(extractFunction).join('\n'), context);
  return context;
}

test('進度裡有 BLOCKED: 行時顯示唯讀卡片並跳脫 HTML', () => {
  const ctx = load({ t1: ['working...', '  BLOCKED: 要用 <prod> 還是 staging？'] });
  const html = ctx.questionCardHtml({ id: 't1', updated_at: '2026-10-13T00:00:00.000Z' });
  assert.match(html, /class="task-question-card"/);
  assert.match(html, /唯讀/);
  assert.match(html, /BLOCKED: 要用 &lt;prod&gt; 還是 staging？/);
  assert.doesNotMatch(html, /<prod>/);
});

test('沒有 BLOCKED: 行（或只在行中間出現）時不出卡片', () => {
  const ctx = load({ t1: ['done', 'note: not BLOCKED: here'] });
  assert.equal(ctx.questionCardHtml({ id: 't1' }), '');
  assert.equal(ctx.questionCardHtml({ id: 'missing' }), '');
});
