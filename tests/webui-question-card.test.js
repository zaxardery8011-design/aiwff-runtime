// WebUI 任務面板：worker 進度 tail 裡的 `BLOCKED:` 行要抬成唯讀卡片，其餘情況不出卡片。
// 任務 blocked、blocked_reason=question 時改成回答卡：問題（用 textContent 填）、輸入框、「送出回答並續跑」按鈕。
// 只把 webui.html 裡相關的函式（加上 escapeHtml / fmtDate）抽進 node:vm，不起 server。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'agent', 'webui.html'), 'utf8');

function extractFunction(name) {
  const marker = HTML.indexOf('async function ' + name + '(') >= 0 ? 'async function ' + name + '(' : 'function ' + name + '(';
  const start = HTML.indexOf(marker);
  assert.ok(start >= 0, 'webui.html 找不到 function ' + name);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error('function ' + name + ' 括號不成對');
}

const FUNCTIONS = [
  'escapeHtml',
  'fmtDate',
  'workerQuestion',
  'isAnswerableQuestionTask',
  'questionCardHtml',
  'questionTextFor',
  'fillQuestionCards',
  'submitTaskAnswer',
];

function load(progress, extra = {}) {
  const context = {
    state: {
      progress,
      tasks: [],
      questions: {},
      questionErrors: {},
      answerDrafts: {},
      answerBusy: {},
      answerStatus: {},
    },
    renders: 0,
    rerenderQuestionLists() {
      context.renders += 1;
    },
    JSON,
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(FUNCTIONS.map(extractFunction).join('\n'), context);
  return context;
}

// 很小的假 DOM：解析 questionCardHtml 吐出的 data-* 屬性，querySelectorAll 回傳對應的節點。
function fakeRoot(html) {
  const nodes = [];
  const re = /<(\w+)[^>]*?\s(data-question-text|data-answer-input|data-answer-status|data-answer-submit)="([^"]*)"/g;
  let match;
  while ((match = re.exec(html))) {
    const attrs = { [match[2]]: match[3] };
    nodes.push({ tag: match[1], attrs, textContent: '', value: '', getAttribute: (name) => attrs[name] });
  }
  return {
    nodes,
    querySelectorAll(selector) {
      const name = selector.replace(/^\[|\]$/g, '');
      return nodes.filter((node) => Object.prototype.hasOwnProperty.call(node.attrs, name));
    },
  };
}

const QUESTION_TASK = {
  id: '11111111-2222-4333-8444-555555555555',
  status: 'blocked',
  blocked_reason: 'question',
  has_question: true,
  updated_at: '2026-10-13T00:00:00.000Z',
};

test('進度裡有 BLOCKED: 行時顯示唯讀卡片並跳脫 HTML', () => {
  const ctx = load({ t1: ['working...', '  BLOCKED: 要用 <prod> 還是 staging？'] });
  const html = ctx.questionCardHtml({ id: 't1', updated_at: '2026-10-13T00:00:00.000Z' });
  assert.match(html, /class="task-question-card"/);
  assert.match(html, /唯讀/);
  assert.match(html, /BLOCKED: 要用 &lt;prod&gt; 還是 staging？/);
  assert.doesNotMatch(html, /<prod>/);
  assert.doesNotMatch(html, /<textarea|<button/, '一般的 BLOCKED 行沒有輸入框和按鈕');
});

test('blocked 但不是 question 的任務（例如逾時）仍然只有唯讀卡', () => {
  const ctx = load({ t1: ['BLOCKED: 等人決定'] });
  const html = ctx.questionCardHtml({ id: 't1', status: 'blocked', blocked_reason: 'timeout' });
  assert.match(html, /唯讀/);
  assert.doesNotMatch(html, /<textarea|<button/);
});

test('沒有 BLOCKED: 行（或只在行中間出現）時不出卡片', () => {
  const ctx = load({ t1: ['done', 'note: not BLOCKED: here'] });
  assert.equal(ctx.questionCardHtml({ id: 't1' }), '');
  assert.equal(ctx.questionCardHtml({ id: 'missing' }), '');
});

test('blocked_reason=question：出現輸入框和按鈕；問題含 <img src=x onerror=…> 時以文字顯示', () => {
  const evil = '<img src=x onerror=alert(1)> 要用哪個資料夾？';
  const ctx = load({ [QUESTION_TASK.id]: ['BLOCKED: ' + evil] });
  ctx.state.questions[QUESTION_TASK.id] = evil;
  ctx.state.tasks = [QUESTION_TASK];
  const html = ctx.questionCardHtml(QUESTION_TASK);
  assert.match(html, /<textarea[^>]*data-answer-input="11111111-2222-4333-8444-555555555555"/);
  assert.match(html, /<button[^>]*data-answer-submit="11111111-2222-4333-8444-555555555555"[^>]*>送出回答並續跑<\/button>/);
  assert.doesNotMatch(html, /唯讀/);
  assert.ok(!html.includes('<img'), '問題不能進 HTML 字串');
  assert.ok(!html.includes('onerror'), '問題不能進 HTML 字串（連跳脫過的也不放，一律 textContent）');

  const root = fakeRoot(html);
  ctx.state.answerDrafts[QUESTION_TASK.id] = '草稿還在';
  ctx.fillQuestionCards(root);
  const text = root.querySelectorAll('[data-question-text]');
  assert.equal(text.length, 1);
  assert.equal(text[0].textContent, evil, '問題用 textContent 原樣顯示成文字');
  assert.equal(root.querySelectorAll('[data-answer-input]')[0].value, '草稿還在');
});

test('問題優先用 task.question；讀不到時顯示原因', () => {
  const ctx = load({});
  ctx.state.questions[QUESTION_TASK.id] = '從 token 端點讀的';
  assert.equal(ctx.questionTextFor(QUESTION_TASK.id, { ...QUESTION_TASK, question: '任務本身帶的' }), '任務本身帶的');
  assert.equal(ctx.questionTextFor(QUESTION_TASK.id, QUESTION_TASK), '從 token 端點讀的');
  delete ctx.state.questions[QUESTION_TASK.id];
  ctx.state.questionErrors[QUESTION_TASK.id] = '沒登入';
  assert.match(ctx.questionTextFor(QUESTION_TASK.id, QUESTION_TASK), /沒登入/);
});

test('按下「送出回答並續跑」：POST /api/tasks/:id/resume，body 含 answer；空的不送', async () => {
  const calls = [];
  const ctx = load(
    {},
    {
      fetch: async (route, options) => {
        calls.push({ route, options });
        return { ok: true, status: 202, json: async () => ({ ok: true, task: { ...QUESTION_TASK, status: 'pending', blocked_reason: undefined } }) };
      },
    },
  );
  ctx.state.tasks = [QUESTION_TASK];

  await ctx.submitTaskAnswer(QUESTION_TASK.id);
  assert.equal(calls.length, 0, '沒寫回答不送');
  assert.equal(ctx.state.answerStatus[QUESTION_TASK.id], '請先寫下回答');

  ctx.state.answerDrafts[QUESTION_TASK.id] = '  用 D 槽  ';
  await ctx.submitTaskAnswer(QUESTION_TASK.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/tasks/11111111-2222-4333-8444-555555555555/resume');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body), { answer: '用 D 槽' });
  assert.equal(ctx.state.answerDrafts[QUESTION_TASK.id], undefined, '送出成功後清掉草稿');
  assert.equal(ctx.state.tasks[0].status, 'pending');
  assert.match(ctx.state.answerStatus[QUESTION_TASK.id], /已送出/);
  assert.equal(ctx.state.answerBusy[QUESTION_TASK.id], false);
});

test('續跑被拒時顯示後端給的原因，草稿保留', async () => {
  const ctx = load(
    {},
    {
      fetch: async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ ok: false, error: 'answer 最多 2000 字' }) }),
    },
  );
  ctx.state.tasks = [QUESTION_TASK];
  ctx.state.answerDrafts[QUESTION_TASK.id] = '很長的回答';
  await ctx.submitTaskAnswer(QUESTION_TASK.id);
  assert.equal(ctx.state.answerStatus[QUESTION_TASK.id], '送出失敗：answer 最多 2000 字');
  assert.equal(ctx.state.answerDrafts[QUESTION_TASK.id], '很長的回答');
});
