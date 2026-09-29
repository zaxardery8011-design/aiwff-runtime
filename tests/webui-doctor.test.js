// WebUI refresh 測試：/api/doctor 回 ok:false 時不能讓整頁變成「連線中斷」。
// 不用 jsdom：把 webui.html 的主 inline script 丟進 node:vm，配一個最小假 DOM，
// fetch 轉發到同 process 起的 runtime server（只改寫 /api/doctor 的回應）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT_DIR, 'agent', 'webui.html'), 'utf8');

function mainScriptSource() {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const main = scripts.find((source) => source.includes('async function refresh()'));
  assert.ok(main, 'webui.html 找不到含 refresh() 的 inline script');
  return main;
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.listen(0, '127.0.0.1');
  });
}

function fakeElement() {
  const classes = new Set();
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    closest: () => null,
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

// 在 vm 裡載入 WebUI 主 script。fetchImpl(route, options) 取代瀏覽器 fetch。
function loadWebui(fetchImpl) {
  const elements = new Map();
  const document = {
    documentElement: fakeElement(),
    getElementById(id) {
      if (id === 'jhud-reactor') return null; // 不跑 canvas 動畫
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => fakeElement(), // 聊天訊息節點（chatMessageNode）載入時就會建
  };
  const context = {
    document,
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    fetch: fetchImpl,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    console,
    Date,
    Promise,
    JSON,
    Math,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(mainScriptSource(), context, { filename: 'webui.html#main-script' });
  return {
    context,
    text: (id) => document.getElementById(id).textContent,
    html: (id) => document.getElementById(id).innerHTML,
  };
}

let port;
let agent;
let server;

test.before(async () => {
  port = await getOpenPort();
  process.env.PORT = String(port);
  process.env.MOCK_WORKER = '1';
  process.env.AIWFF_WORKER_PROVIDER = '';
  agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
  agent.ensureDirectories();
  agent.initRuntimeToken();
  server = agent.createRuntimeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function proxyFetch(overrides) {
  return async (route, options) => {
    const override = overrides[route];
    if (override) return override();
    return fetch(`http://127.0.0.1:${port}${route}`, options);
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FAILING_DOCTOR = {
  ok: false,
  checks: [
    { id: 'node_version', ok: true, detail: 'v22 >= 18' },
    { id: 'tasks_dir', ok: false, detail: 'data/tasks is not readable' },
    { id: 'port', ok: true, detail: '8790' },
  ],
  next_actions: ['修正 tasks_dir: data/tasks is not readable'],
};

test('doctor 回 ok:false（HTTP 200）→ 其他區塊照常載入，診斷區塊標出沒過的那一項', async () => {
  const ui = loadWebui(proxyFetch({ '/api/doctor': () => jsonResponse(200, FAILING_DOCTOR) }));
  await ui.context.refresh();
  const state = ui.context.state;

  assert.equal(state.online, true, `不該判成斷線（health-text=${ui.text('health-text')}）`);
  assert.notEqual(ui.text('last-sync'), '連線中斷');
  assert.ok(state.health && state.health.ok, 'health 應載入');
  assert.ok(state.hud, 'HUD 應載入');
  assert.ok(Array.isArray(state.tasks), '任務列表應載入');
  assert.ok(state.settings && state.settings.ok, 'settings 應載入');
  assert.equal(ui.text('health-text'), '在線');

  assert.equal(state.doctor.ok, false);
  const doctorHtml = ui.html('doctor-list');
  assert.match(doctorHtml, /未通過/);
  assert.match(doctorHtml, /任務目錄|tasks_dir/);
  assert.match(doctorHtml, /data\/tasks is not readable/);
});

test('doctor 端點本身壞掉（HTTP 500）→ 其他區塊照常，診斷區塊顯示讀取失敗', async () => {
  const ui = loadWebui(proxyFetch({ '/api/doctor': () => jsonResponse(500, { ok: false, error: 'doctor exploded' }) }));
  await ui.context.refresh();
  const state = ui.context.state;

  assert.equal(state.online, true);
  assert.notEqual(ui.text('last-sync'), '連線中斷');
  assert.ok(Array.isArray(state.tasks));
  assert.match(ui.html('doctor-list'), /doctor exploded/);
});

test('doctor 全部通過 → 診斷區塊不出現「未通過」', async () => {
  const ui = loadWebui(proxyFetch({}));
  await ui.context.refresh();
  assert.equal(ui.context.state.online, true);
  assert.ok(ui.context.state.doctor && Array.isArray(ui.context.state.doctor.checks));
  assert.doesNotMatch(ui.html('doctor-list'), /未通過/);
});

test('全部 API 連不上 → 仍判為斷線，顯示「連線中斷」', async () => {
  const ui = loadWebui(async () => {
    throw new TypeError('Failed to fetch');
  });
  await ui.context.refresh();
  assert.equal(ui.context.state.online, false);
  assert.equal(ui.text('last-sync'), '連線中斷');
  assert.notEqual(ui.text('health-text'), '在線');
});
