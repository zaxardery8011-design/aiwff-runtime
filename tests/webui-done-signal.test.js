// WebUI 分頁在背景時任務完成：標題要出現「(N) ✓」，回前景清掉；重新整理／重連重送的舊 done 不算。
// 只把 webui.html 的 updateDoneSignal 和它的狀態抽進 node:vm，document 用最小 stub。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'agent', 'webui.html'), 'utf8');
const TITLE = 'AIWFF Runtime 控制台';

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

function extractLine(prefix) {
  const start = HTML.indexOf(prefix);
  assert.ok(start >= 0, 'webui.html 找不到 ' + prefix);
  return HTML.slice(start, HTML.indexOf('\n', start));
}

function page({ hidden, tasks, synced = true }) {
  const context = {
    document: { hidden, title: TITLE },
    state: { tasks, lastSyncMs: synced ? 1 : null },
  };
  vm.createContext(context);
  vm.runInContext(extractLine('var doneSignal = ') + '\n' + extractFunction('updateDoneSignal'), context);
  return context;
}

const task = (id, status) => ({ id, status });

test('背景中變成 done：標題出現訊號，回前景消失', () => {
  const ctx = page({ hidden: false, tasks: [task('a', 'running')] });
  ctx.updateDoneSignal();
  ctx.document.hidden = true;
  ctx.updateDoneSignal();
  assert.equal(ctx.document.title, TITLE);
  ctx.state.tasks = [task('a', 'done')];
  ctx.updateDoneSignal();
  assert.equal(ctx.document.title, '(1) ✓ ' + TITLE);
  ctx.document.hidden = false;
  ctx.updateDoneSignal();
  assert.equal(ctx.document.title, TITLE);
});

test('進背景前就 done 的任務、重連重送的舊 done 不計', () => {
  const ctx = page({ hidden: false, tasks: [task('old', 'done'), task('b', 'running')] });
  ctx.document.hidden = true;
  ctx.updateDoneSignal();
  ctx.state.tasks = [task('old', 'done'), task('b', 'running')];
  ctx.updateDoneSignal();
  assert.equal(ctx.document.title, TITLE);
  ctx.state.tasks = [task('old', 'done'), task('b', 'done'), task('c', 'done')];
  ctx.updateDoneSignal();
  assert.equal(ctx.document.title, '(2) ✓ ' + TITLE);
});

test('背景中重新整理：還沒讀到清單不記名單，第一次讀到的舊 done 不計', () => {
  const ctx = page({ hidden: true, tasks: [], synced: false });
  ctx.updateDoneSignal();
  assert.equal(ctx.doneSignal.baseline, null);
  ctx.state = { tasks: [task('x', 'done'), task('y', 'done')], lastSyncMs: 1 };
  ctx.updateDoneSignal();
  assert.equal(ctx.document.title, TITLE);
  ctx.state.tasks.push(task('z', 'done'));
  ctx.updateDoneSignal();
  assert.equal(ctx.document.title, '(1) ✓ ' + TITLE);
});
