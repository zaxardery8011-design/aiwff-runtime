// WebUI 進度面板：讀取失敗時要顯示具名錯誤；有上次成功的內容就一併保留，不畫成空清單。
// 只把 webui.html 的 renderEvents 抽進 node:vm，周邊 helper 用最小 stub。
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

function render(progress, progressErrors) {
  const out = {};
  const context = {
    state: { events: [], progress, progressErrors, truncation: { events: null, progress: {} } },
    setHtml: (id, html) => { out[id] = html; },
    truncationRow: () => '',
    empty: (text) => '<empty>' + text + '</empty>',
    fmtAgo: () => '', statusLabel: () => '',
  };
  vm.createContext(context);
  vm.runInContext(['escapeHtml', 'fmtDate', 'renderEvents'].map(extractFunction).join('\n'), context);
  context.renderEvents();
  return out['progress-list'];
}

test('讀取失敗且沒有舊內容：只顯示具名錯誤', () => {
  const html = render({ t1: [] }, { t1: '網路問題' });
  assert.match(html, /進度讀取失敗：網路問題/);
  assert.doesNotMatch(html, /<pre>/);
});

test('讀取失敗但有上次內容：錯誤行和舊內容都在', () => {
  const html = render({ t1: ['step 1 ok'] }, { t1: '網路問題' });
  assert.match(html, /進度讀取失敗：網路問題/);
  assert.match(html, /<pre>step 1 ok<\/pre>/);
});

test('讀取成功：照常顯示內容、沒有錯誤行', () => {
  const html = render({ t1: ['line a'] }, {});
  assert.doesNotMatch(html, /進度讀取失敗/);
  assert.match(html, /<pre>line a<\/pre>/);
});
