// 任務問問題（J5）測試：worker 缺資訊時停下來問人，使用者在 TG 或 API 回答後帶著答案續跑。
// 同一個 process 內起 runtime server 與假 Telegram（只綁 127.0.0.1）；任務用假 claude CLI（放系統暫存目錄）或 mock worker，
// 不連真網路、不叫真 claude。對話、bot、chat_state 一律指到系統暫存目錄，結束時清掉；自己建的任務檔在 after 裡清掉。
//
// npm test 第二步會用 `node tests/task-question.test.js --snapshot-repo-data` 先記下 repo 的 data/conversations
// 與 data/chat_state.json，最後跑這支時比對：整個 npm test 跑完，這兩處不能多檔、也不能被改過。
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const REPO_CONVERSATIONS_DIR = path.join(ROOT_DIR, 'data', 'conversations');
const REPO_CHAT_STATE_FILE = path.join(ROOT_DIR, 'data', 'chat_state.json');
const SNAPSHOT_FILE = path.join(os.tmpdir(), 'aiwff-task-question-repo-data-snapshot.json');

function fileDigest(filePath) {
  try {
    const raw = fs.readFileSync(filePath);
    return { size: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { error: error.code || error.message };
  }
}

function repoDataSnapshot() {
  const conversations = {};
  let names = [];
  try {
    names = fs.readdirSync(REPO_CONVERSATIONS_DIR).sort();
  } catch (_) {
    names = [];
  }
  for (const name of names) {
    conversations[name] = fileDigest(path.join(REPO_CONVERSATIONS_DIR, name));
  }
  return { conversations, chat_state: fileDigest(REPO_CHAT_STATE_FILE) };
}

if (process.argv.includes('--snapshot-repo-data')) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ taken_at: Date.now(), snapshot: repoDataSnapshot() }));
  console.log(`repo data snapshot written: ${SNAPSHOT_FILE}`);
} else {
  defineTests();
}

function defineTests() {
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const net = require('node:net');
  const test = require('node:test');

  const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
  const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');
  const WORKSPACES_DIR = path.join(ROOT_DIR, 'data', 'workspaces');
  const INBOX_DIR = path.join(ROOT_DIR, 'data', 'inbox');
  const TOKEN = 'task-question-fixed-token';
  const AUTH = { 'x-aiwff-runtime-token': TOKEN };
  const ADMIN_CHAT_ID = '5151';
  const OTHER_CHAT_ID = '9999';
  const QUESTION = '要用哪個資料夾？';
  const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwff-task-question-test-'));
  const BIN_DIR = path.join(TMP_ROOT, 'bin');
  const CONVERSATIONS_DIR = path.join(TMP_ROOT, 'conversations');
  const BOTS_DIR = path.join(TMP_ROOT, 'bots');
  const CHAT_STATE_FILE = path.join(TMP_ROOT, 'chat_state.json');
  const CAPTURE_FILE = path.join(TMP_ROOT, 'claude.capture.jsonl');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(BOTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(BOTS_DIR, 'main.md'), '---\nname: 主助理\n---\n你是測試用的主助理。\n');

  const store = require(path.join(ROOT_DIR, 'agent', 'conversation-store.js'));

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  // rawBody 有給就原樣送（測「不帶 body」與壞掉的 JSON）；payload 有給就送 JSON。
  function request(port, method, route, { headers = {}, payload, rawBody } = {}) {
    return new Promise((resolve, reject) => {
      const body = rawBody !== undefined ? rawBody : payload === undefined ? '' : JSON.stringify(payload);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: route,
          method,
          agent: false,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            let json = null;
            try {
              json = raw ? JSON.parse(raw) : null;
            } catch (_) {
              json = null;
            }
            resolve({ status: res.statusCode, json, raw });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  function taskFileNames() {
    try {
      return fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith('.json')).sort();
    } catch (_) {
      return [];
    }
  }

  function readTaskFile(id) {
    return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${id}.json`), 'utf8'));
  }

  function writeFakeClaude(name, scriptBody) {
    const scriptPath = path.join(BIN_DIR, `${name}.js`);
    fs.writeFileSync(scriptPath, scriptBody);
    if (process.platform === 'win32') {
      const commandPath = path.join(BIN_DIR, `${name}.cmd`);
      fs.writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
      return commandPath;
    }
    const commandPath = path.join(BIN_DIR, name);
    fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    fs.chmodSync(commandPath, 0o755);
    return commandPath;
  }

  // 假 claude CLI：每次把 argv 與 stdin 追加一行到 capture 檔。行為看 stdin 裡的指令標記：
  // - 聊天（argv 有 --tools）：回一句固定答案。
  // - [ask-always]：每一棒都印 BLOCKED: 問題、exit 0、不寫結果檔。
  // - [ask-once]：還沒帶回答時問；prompt 裡有上一棒的問答就把結果寫到指定路徑、印 DONE:。
  // - [silent]：什麼都不印、exit 0、不寫結果檔。
  // - [not-last]：印 BLOCKED: 行，但後面還有別的行；不寫結果檔。
  const FAKE_CLAUDE = `
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(CAPTURE_FILE)}, JSON.stringify({ argv, input }) + '\\n');
  if (argv.includes('--tools')) {
    console.log('假 claude 的聊天回答');
    return;
  }
  const answered = input.includes('## 你上一棒問的問題與使用者的回答');
  if (input.includes('[ask-always]') || (input.includes('[ask-once]') && !answered)) {
    console.log('我看了一下任務內容。');
    console.log('');
    console.log(${JSON.stringify(`BLOCKED: ${QUESTION}`)});
    return;
  }
  if (input.includes('[silent]')) {
    return;
  }
  if (input.includes('[not-last]')) {
    console.log('BLOCKED: 這行不是最後一行');
    console.log('其實我想說的是別的');
    return;
  }
  const match = input.match(/結果請寫到: (.+)/);
  if (match) fs.writeFileSync(match[1].trim(), '# 假 worker 的結果\\n帶著回答做完了\\n');
  console.log('DONE: 做完了');
});
`;

  function readCaptures() {
    try {
      return fs
        .readFileSync(CAPTURE_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (_) {
      return [];
    }
  }

  function workerCaptures(taskId) {
    return readCaptures().filter((capture) => !capture.argv.includes('--tools') && capture.input.includes(`任務ID: ${taskId}`));
  }

  function chatCaptures() {
    return readCaptures().filter((capture) => capture.argv.includes('--tools'));
  }

  // 假 Telegram：getUpdates 每次吐一筆排隊的 update；其他方法全部記下來（method、body、回給 runtime 的 message_id）。
  function startFakeTelegram() {
    const queue = [];
    const calls = [];
    let updateId = 7000;
    let messageId = 300;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const method = req.url.split('/').pop();
        if (method === 'getUpdates') {
          const next = queue.shift();
          res.end(JSON.stringify({ ok: true, result: next ? [{ update_id: ++updateId, ...next }] : [] }));
          return;
        }
        const body = JSON.parse(raw || '{}');
        if (method === 'sendMessage') {
          const id = ++messageId;
          calls.push({ method, body, message_id: id });
          res.end(JSON.stringify({ ok: true, result: { message_id: id, chat: { id: body.chat_id }, text: body.text } }));
          return;
        }
        calls.push({ method, body });
        res.end(JSON.stringify({ ok: true, result: true }));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, queue, calls }));
    });
  }

  let nextUserMessageId = 1;
  function tgText(text, { chatId = ADMIN_CHAT_ID, replyTo = null } = {}) {
    const message = { message_id: ++nextUserMessageId, chat: { id: Number(chatId) }, from: { id: Number(chatId) }, text };
    if (replyTo) message.reply_to_message = replyTo;
    return { message };
  }

  let port;
  let agent;
  let server;
  let fakeTg;
  let initialTaskFiles;
  let ownRepoSnapshot;
  let suiteRepoSnapshot = null;
  let claudeCmd;
  const ENV_KEYS = [
    'PORT',
    'TG_API_BASE_URL',
    'TG_POLL_BASE_MS',
    'RETRY_BACKOFF_MS',
    'AIWFF_RUNTIME_TOKEN',
    'AIWFF_MODE',
    'AIWFF_CONFIRM_AUTO_TASK',
    'AIWFF_CONVERSATIONS_DIR',
    'AIWFF_BOTS_DIR',
    'AIWFF_CHAT_STATE_FILE',
    'MOCK_WORKER',
    'ENABLE_REAL_CLAUDE_WORKER',
    'AIWFF_WORKER_PROVIDER',
    'CLAUDE_CMD',
    'CLAUDE_BYPASS_APPROVALS',
    'AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS',
    'TG_BOT_TOKEN',
    'ADMIN_TG_CHAT_ID',
  ];
  const savedEnv = {};

  test.before(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    ownRepoSnapshot = repoDataSnapshot();
    try {
      const saved = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      // 只認這次 npm test 開頭記下的（兩小時內）；單獨跑這支時就跟自己開始時比。
      if (saved && Date.now() - saved.taken_at < 2 * 60 * 60 * 1000) suiteRepoSnapshot = saved.snapshot;
    } catch (_) {
      suiteRepoSnapshot = null;
    }
    process.env.AIWFF_CONVERSATIONS_DIR = CONVERSATIONS_DIR;
    process.env.AIWFF_BOTS_DIR = BOTS_DIR;
    process.env.AIWFF_CHAT_STATE_FILE = CHAT_STATE_FILE;
    fakeTg = await startFakeTelegram();
    port = await getOpenPort();
    process.env.PORT = String(port);
    process.env.TG_API_BASE_URL = `http://127.0.0.1:${fakeTg.port}`;
    process.env.TG_POLL_BASE_MS = '200';
    process.env.RETRY_BACKOFF_MS = '50';
    process.env.AIWFF_RUNTIME_TOKEN = TOKEN;
    claudeCmd = writeFakeClaude('claude-question', FAKE_CLAUDE);
    agent = require(path.join(ROOT_DIR, 'agent', 'index.js'));
    agent.ensureDirectories();
    agent.initRuntimeToken();
    initialTaskFiles = new Set(taskFileNames());
    server = agent.createRuntimeServer();
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fakeTg) await new Promise((resolve) => fakeTg.server.close(resolve));
    // 等 worker 收尾後再清自己建的任務檔、進度、產出、收件匣與 workspace。
    await sleep(500);
    for (const name of taskFileNames()) {
      if (initialTaskFiles.has(name)) continue;
      const id = name.replace(/\.json$/, '');
      for (const dir of [TASKS_DIR, ARTIFACTS_DIR, INBOX_DIR]) {
        for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
          if (file.startsWith(id)) fs.rmSync(path.join(dir, file), { force: true });
        }
      }
      fs.rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true });
    }
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.rmSync(SNAPSHOT_FILE, { force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  // 前一個測試留下、還在等回答的任務會讓「這個 chat 只有一個在等」不成立：每個測試開始前改成 failed 收掉。
  function retireOwnQuestionTasks() {
    for (const name of taskFileNames()) {
      if (initialTaskFiles.has(name)) continue;
      const file = path.join(TASKS_DIR, name);
      let task;
      try {
        task = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        continue;
      }
      if (task && task.status === 'blocked' && task.blocked_reason === 'question') {
        fs.writeFileSync(file, `${JSON.stringify({ ...task, status: 'failed', error: 'retired by test' }, null, 2)}\n`);
      }
    }
  }

  test.beforeEach(() => {
    retireOwnQuestionTasks();
    process.env.AIWFF_MODE = 'task';
    delete process.env.AIWFF_CONFIRM_AUTO_TASK;
    process.env.MOCK_WORKER = '';
    process.env.ENABLE_REAL_CLAUDE_WORKER = '1';
    process.env.AIWFF_WORKER_PROVIDER = '';
    process.env.CLAUDE_CMD = claudeCmd;
    process.env.CLAUDE_BYPASS_APPROVALS = '';
    process.env.AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS = '';
    process.env.TG_BOT_TOKEN = '';
    process.env.ADMIN_TG_CHAT_ID = '';
    fakeTg.calls.length = 0;
    fakeTg.queue.length = 0;
  });

  async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function waitForTask(taskId, predicate, label, timeoutMs = 30000) {
    let last = null;
    await waitFor(
      () => {
        try {
          last = readTaskFile(taskId);
        } catch (_) {
          return false;
        }
        return predicate(last);
      },
      timeoutMs,
      `task ${taskId}: ${label}`,
    );
    return last;
  }

  function waitForQuestion(taskId, resumeCount = 0) {
    return waitForTask(
      taskId,
      (task) => task.status !== 'pending' && task.status !== 'running' && (task.resume_count || 0) === resumeCount,
      `settled after resume #${resumeCount}`,
    );
  }

  async function createTask(instruction, title = '問問題測試') {
    const created = await request(port, 'POST', '/api/tasks', { headers: AUTH, payload: { title, instruction } });
    assert.equal(created.status, 201, created.raw);
    return created.json.id;
  }

  function resume(taskId, options = {}) {
    return request(port, 'POST', `/api/tasks/${taskId}/resume`, { headers: AUTH, ...options });
  }

  function sentTo(chatId, pattern) {
    return fakeTg.calls.filter(
      (call) => call.method === 'sendMessage' && String(call.body.chat_id) === String(chatId) && (!pattern || pattern.test(String(call.body.text))),
    );
  }

  async function withPolling(work) {
    process.env.TG_BOT_TOKEN = 'fake-test-token';
    process.env.ADMIN_TG_CHAT_ID = ADMIN_CHAT_ID;
    const stop = agent.startTelegramPolling();
    try {
      await work();
    } finally {
      stop();
    }
  }

  // 從 TG 建一個任務（task 模式下每則訊息都建任務），等它停下來問問題、而且提問訊息確實送出，回傳任務 id 與那則訊息。
  async function tgTaskThatAsks(instruction) {
    const before = new Set(taskFileNames());
    fakeTg.queue.push(tgText(instruction));
    let taskId = null;
    await waitFor(
      () => {
        const added = taskFileNames().filter((name) => !before.has(name));
        if (added.length) taskId = added[0].replace(/\.json$/, '');
        return Boolean(taskId);
      },
      15000,
      'task created from telegram',
    );
    const task = await waitForQuestion(taskId);
    assert.equal(task.blocked_reason, 'question', JSON.stringify(task));
    await waitFor(() => sentTo(ADMIN_CHAT_ID, /^❓ 任務需要你回答：/).some((call) => call.body.text.includes(task.title)), 15000, 'question message sent');
    const questionMessage = sentTo(ADMIN_CHAT_ID, /^❓ 任務需要你回答：/).filter((call) => call.body.text.includes(task.title)).pop();
    return { taskId, task, questionMessage };
  }

  test('(a) 假 CLI 印出 BLOCKED: 問題後 exit 0：任務變成 blocked、blocked_reason=question、question 正確，而且沒有重試', async () => {
    const taskId = await createTask('[ask-always] 整理專案資料夾');
    const task = await waitForQuestion(taskId);
    assert.equal(task.status, 'blocked', JSON.stringify(task));
    assert.equal(task.blocked_reason, 'question');
    assert.equal(task.question, QUESTION);
    assert.equal(task.retry_count, undefined, '沒有重試');
    assert.equal(agent.taskSchemaViolation(task), null);
    // 重試退避只有 50ms：多等一會兒，確認真的沒有第二棒。
    await sleep(1500);
    assert.equal(workerCaptures(taskId).length, 1, '假 CLI 只被叫 1 次');
    assert.equal(readTaskFile(taskId).status, 'blocked');
    // prompt 有教 worker 怎麼問。
    assert.ok(workerCaptures(taskId)[0].input.includes('最後一行寫 BLOCKED: <一個要問使用者的具體問題>'));
    // 問題截在 1000 字。
    assert.equal(agent.workerQuestionFromStdout(`做了一點\nBLOCKED: ${'問'.repeat(1500)}\n\n`).length, 1000);
    assert.equal(agent.workerQuestionFromStdout('BLOCKED: 中間\n最後一行不是'), null);
    assert.equal(agent.workerQuestionFromStdout('BLOCKED:   \n'), null);
  });

  test('(b) POST resume 帶 answer：下一棒的 stdin 含問題和答案，任務檔有 resume_answer，做完變 done', async () => {
    const taskId = await createTask('[ask-once] 備份檔案');
    await waitForQuestion(taskId);
    const answer = '用 D 槽的 work 資料夾\n裡面的 old 不用管';
    const resumed = await resume(taskId, { payload: { answer } });
    assert.equal(resumed.status, 202, resumed.raw);
    const onDisk = readTaskFile(taskId);
    assert.equal(onDisk.resume_answer, answer);
    assert.equal(onDisk.resume_question, QUESTION);
    assert.equal(onDisk.question, undefined, 'question 是上一棒的收據，續跑時清掉');
    assert.equal(agent.taskSchemaViolation(onDisk), null);
    const done = await waitForQuestion(taskId, 1);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(done.resume_answer, answer);
    const captures = workerCaptures(taskId);
    assert.equal(captures.length, 2);
    const input = captures[1].input;
    assert.ok(input.includes('## 你上一棒問的問題與使用者的回答'), input);
    assert.ok(input.includes(`問：${QUESTION}`), input);
    assert.ok(input.includes('答：（下面縮排的內容是使用者的回答'), input);
    assert.ok(input.includes('  用 D 槽的 work 資料夾\n  裡面的 old 不用管'), input);
    assert.ok(!captures[0].input.includes('## 你上一棒問的問題與使用者的回答'), '第一棒沒有問答段落');
  });

  test('(c) answer 是空字串、只有空白、2001 字、不是字串時回 400；不帶 body 的續跑照舊', async () => {
    const taskId = await createTask('[ask-always] 部署前檢查');
    await waitForQuestion(taskId);
    for (const answer of ['', '   ', '字'.repeat(2001), 42, null]) {
      const refused = await resume(taskId, { payload: { answer } });
      assert.equal(refused.status, 400, `${JSON.stringify(answer).slice(0, 20)} → ${refused.raw}`);
      assert.equal(refused.json.ok, false);
    }
    const badJson = await resume(taskId, { rawBody: '{not json' });
    assert.equal(badJson.status, 400, badJson.raw);
    // 都沒有動到任務。
    const still = readTaskFile(taskId);
    assert.equal(still.status, 'blocked');
    assert.equal(still.resume_count, undefined);
    assert.equal(workerCaptures(taskId).length, 1);

    // 不帶 body：跟以前一樣只用 id 續跑，不會多出問答欄位。
    const plain = await resume(taskId, { rawBody: '' });
    assert.equal(plain.status, 202, plain.raw);
    assert.equal(plain.json.ok, true);
    assert.deepEqual(plain.json.checkpoint_steps, []);
    assert.equal(plain.json.task.resume_count, 1);
    assert.equal(plain.json.task.resume_answer, undefined);
    assert.match(plain.json.task.last_error, /^resumed after blocked: question/);
    await waitForQuestion(taskId, 1);
    assert.ok(!workerCaptures(taskId)[1].input.includes('## 你上一棒問的問題與使用者的回答'));
    // 空物件 body 也是舊行為。
    const emptyObject = await resume(taskId, { payload: {} });
    assert.equal(emptyObject.status, 202, emptyObject.raw);
    assert.equal(readTaskFile(taskId).resume_answer, undefined);
    await waitForQuestion(taskId, 2);
    // 2000 字剛好可以。
    const longest = await resume(taskId, { payload: { answer: '答'.repeat(2000) } });
    assert.equal(longest.status, 202, longest.raw);
    await waitForQuestion(taskId, 3);
    // 舊的拒絕照舊：壞 id、找不到、不是 blocked/failed。
    const badId = await resume('not-a-uuid', { rawBody: '' });
    assert.equal(badId.status, 400);
    assert.equal(badId.json.error, 'invalid task id');
    const missing = await resume('00000000-0000-4000-8000-0000000000aa', { rawBody: '' });
    assert.equal(missing.status, 404);
    const noToken = await request(port, 'POST', `/api/tasks/${taskId}/resume`, { payload: { answer: '沒 token' } });
    assert.equal(noToken.status, 401);
  });

  test('(d) 寫過 checkpoint、連問三個問題（步數沒增加），帶答案續跑都不被 no_progress 擋；不帶答案時煞車照舊', async () => {
    const taskId = await createTask('[ask-always] 一步一步搬資料');
    await waitForQuestion(taskId);
    fs.mkdirSync(path.join(WORKSPACES_DIR, taskId), { recursive: true });
    fs.writeFileSync(agent.checkpointPath(taskId), 'step-1\n');
    for (let round = 1; round <= 3; round += 1) {
      const resumed = await resume(taskId, { payload: { answer: `第 ${round} 個答案` } });
      assert.equal(resumed.status, 202, `round ${round}: ${resumed.raw}`);
      assert.deepEqual(resumed.json.checkpoint_steps, ['step-1']);
      const asked = await waitForQuestion(taskId, round);
      assert.equal(asked.blocked_reason, 'question');
      assert.equal(asked.resume_no_progress_count, 0, `round ${round}`);
    }
    assert.equal(workerCaptures(taskId).length, 4);
    // 不帶答案的續跑仍然算：第一次 +1 放行，第二次到 NO_PROGRESS_LIMIT 回 409。
    const first = await resume(taskId, { rawBody: '' });
    assert.equal(first.status, 202, first.raw);
    await waitForQuestion(taskId, 4);
    const braked = await resume(taskId, { rawBody: '' });
    assert.equal(braked.status, 409, braked.raw);
    assert.equal(braked.json.cause, 'no_progress');
  });

  test('(e) TG：回覆提問訊息、/answer 都能續跑；兩個在等時 /answer 沒帶 id 會列清單；非管理員 chat 無效；task 模式不建新任務', async () => {
    await withPolling(async () => {
      // 回覆提問訊息。
      const first = await tgTaskThatAsks('[ask-once] 幫我整理下載資料夾');
      assert.equal(first.questionMessage.body.parse_mode, undefined, '不帶 parse_mode');
      assert.equal(
        first.questionMessage.body.text,
        `❓ 任務需要你回答：${first.task.title}\n${QUESTION}\n直接回覆這則訊息，或用 /answer <答案>`,
      );
      const conversationId = first.task.conversation_id;
      assert.equal(conversationId, `tg-${ADMIN_CHAT_ID}`);
      const asked = store.readRecent(conversationId, { maxMessages: 100, maxChars: Infinity });
      assert.ok(asked.some((entry) => entry.role === 'system' && entry.text === `任務需要你回答：${first.task.title}\n${QUESTION}`), JSON.stringify(asked));

      const filesBefore = taskFileNames().length;
      // 非管理員 chat 回覆同一則：不理、不續跑。
      fakeTg.queue.push(tgText('我不是管理員', { chatId: OTHER_CHAT_ID, replyTo: { message_id: first.questionMessage.message_id, text: first.questionMessage.body.text } }));
      fakeTg.queue.push(tgText('/answer 我也不是管理員', { chatId: OTHER_CHAT_ID }));
      await waitFor(() => fakeTg.queue.length === 0, 10000, 'non-admin updates consumed');
      await sleep(600);
      assert.equal(sentTo(OTHER_CHAT_ID).length, 0);
      assert.equal(readTaskFile(first.taskId).status, 'blocked');
      assert.equal(readTaskFile(first.taskId).resume_count, undefined);

      fakeTg.queue.push(tgText('放到 archive 資料夾', { replyTo: { message_id: first.questionMessage.message_id, text: first.questionMessage.body.text } }));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^收到，帶著你的答案繼續做$/).length === 1, 15000, 'reply ack');
      const done = await waitForQuestion(first.taskId, 1);
      assert.equal(done.status, 'done', JSON.stringify(done));
      assert.equal(done.resume_answer, '放到 archive 資料夾');
      assert.ok(workerCaptures(first.taskId)[1].input.includes('  放到 archive 資料夾'));
      const history = store.readRecent(conversationId, { maxMessages: 100, maxChars: Infinity });
      assert.ok(history.some((entry) => entry.role === 'user' && entry.text === '放到 archive 資料夾'), JSON.stringify(history));
      assert.ok(history.some((entry) => entry.role === 'system' && entry.text === `已帶著回答續跑：${first.task.title}`));
      assert.equal(taskFileNames().length, filesBefore, '回覆提問訊息不會被建成新任務');

      // 同一則提問再回覆一次：已經不用回答了，不續跑。
      fakeTg.queue.push(tgText('再回一次', { replyTo: { message_id: first.questionMessage.message_id, text: first.questionMessage.body.text } }));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^這題已經不用回答了/).length === 1, 10000, 'stale reply notice');

      // 對照表裡沒有的提問訊息（例如 runtime 重啟過）：請使用者改用 /answer。
      fakeTg.queue.push(tgText('回一則對不上的提問', { replyTo: { message_id: 99999, text: '❓ 任務需要你回答：很久以前的任務\n問題' } }));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /請改用 \/answer <答案>/).length === 1, 10000, 'restart notice');

      // /answer：只有一個在等，直接用。
      const second = await tgTaskThatAsks('[ask-once] 幫我改設定檔');
      const filesBeforeAnswer = taskFileNames().length;
      fakeTg.queue.push(tgText('/answer 改 config.json 就好'));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^收到，帶著你的答案繼續做$/).length === 2, 15000, '/answer ack');
      const secondDone = await waitForQuestion(second.taskId, 1);
      assert.equal(secondDone.status, 'done');
      assert.equal(secondDone.resume_answer, '改 config.json 就好');
      assert.equal(taskFileNames().length, filesBeforeAnswer, '/answer 不會被建成新任務');

      // 兩個在等：/answer 沒帶 id 前綴只列清單、一個都不續跑。
      const third = await tgTaskThatAsks('[ask-always] 第三個任務');
      const fourth = await tgTaskThatAsks('[ask-always] 第四個任務');
      fakeTg.queue.push(tgText('/answer 隨便'));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^有 2 個任務在等你回答/).length === 1, 10000, 'waiting list');
      const list = sentTo(ADMIN_CHAT_ID, /^有 2 個任務在等你回答/)[0].body.text;
      assert.ok(list.includes(third.taskId.slice(0, 8)) && list.includes(fourth.taskId.slice(0, 8)), list);
      assert.ok(list.includes('/answer <任務 id 前 8 碼> <答案>'), list);
      await sleep(400);
      assert.equal(readTaskFile(third.taskId).resume_count, undefined);
      assert.equal(readTaskFile(fourth.taskId).resume_count, undefined);

      // 帶 id 前綴：只續跑那一個。
      fakeTg.queue.push(tgText(`/answer ${fourth.taskId.slice(0, 8)} 指定給第四個`));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^收到，帶著你的答案繼續做$/).length === 3, 15000, 'prefixed /answer ack');
      assert.equal(readTaskFile(fourth.taskId).resume_answer, '指定給第四個');
      assert.equal(readTaskFile(third.taskId).resume_count, undefined);
      await waitForQuestion(fourth.taskId, 1);

      // 沒有在等的任務時說明。
      retireOwnQuestionTasks();
      fakeTg.queue.push(tgText('/answer 有人在等嗎'));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^目前沒有等你回答的任務。$/).length === 1, 10000, 'nothing waiting');
      assert.equal(sentTo(OTHER_CHAT_ID).length, 0, '非管理員 chat 從頭到尾沒收到任何訊息');
    });
  });

  test('(f) both 模式：回覆提問訊息和 /answer 都不會被當成聊天送進假 CLI，也不會建任務', async () => {
    await withPolling(async () => {
      process.env.AIWFF_MODE = 'both';
      const first = await tgTaskThatAsks('/task [ask-once] 幫我寫週報');
      const chatsBefore = chatCaptures().length;
      const filesBefore = taskFileNames().length;
      fakeTg.queue.push(tgText('週報寫給主管看的', { replyTo: { message_id: first.questionMessage.message_id, text: first.questionMessage.body.text } }));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^收到，帶著你的答案繼續做$/).length === 1, 15000, 'reply ack');
      // 確實進到假 CLI 的是下一棒 worker，不是聊天。
      await waitFor(() => workerCaptures(first.taskId).length === 2, 15000, 'second worker run');
      await waitForQuestion(first.taskId, 1);

      const second = await tgTaskThatAsks('/task [ask-once] 幫我寫月報');
      fakeTg.queue.push(tgText('/answer 月報只要重點'));
      await waitFor(() => sentTo(ADMIN_CHAT_ID, /^收到，帶著你的答案繼續做$/).length === 2, 15000, '/answer ack');
      await waitFor(() => workerCaptures(second.taskId).length === 2, 15000, 'second worker run');
      await waitForQuestion(second.taskId, 1);

      // 一般聊天照舊會進模型（確認這個環境的聊天路徑是通的，上面的「沒進」才有意義）。
      const chatsBeforeChat = chatCaptures().length;
      assert.equal(chatsBeforeChat, chatsBefore, '回答沒有被當成聊天');
      fakeTg.queue.push(tgText('今天天氣不錯'));
      await waitFor(() => chatCaptures().length === chatsBeforeChat + 1, 15000, 'plain chat reaches fake CLI');
      assert.equal(taskFileNames().length, filesBefore + 1, '只有建第二個任務那則多了一個任務檔');
    });
  });

  test('(g) 不帶 token 的 GET /api/tasks、GET /api/tasks/:id、HUD 找不到問題和答案，只有 has_question；帶 token 的 /question 拿得到', async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const secret = { question: 'SECRET-QUESTION-文字', resume_answer: 'SECRET-ANSWER-文字', resume_question: 'SECRET-PREVIOUS-文字' };
    const task = { id, title: '外洩測試', instruction: '[ask-always] 外洩測試', status: 'blocked', blocked_reason: 'question', created_at: now, updated_at: now, resume_count: 1, ...secret };
    assert.equal(agent.taskSchemaViolation(task), null);
    fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), `${JSON.stringify(task, null, 2)}\n`);

    for (const route of ['/api/tasks', '/api/tasks?status=blocked', `/api/tasks/${id}`, '/api/hud']) {
      const open = await request(port, 'GET', route);
      assert.equal(open.status, 200, `${route}: ${open.raw}`);
      for (const value of Object.values(secret)) {
        assert.ok(!open.raw.includes(value), `${route} 不能回 ${value}`);
      }
      // blocked_reason 的值本身就是 "question"，所以只比對「欄位名稱後面接冒號」。
      for (const field of ['question', 'resume_answer', 'resume_question']) {
        assert.doesNotMatch(open.raw, new RegExp(`"${field}"\\s*:`), `${route} 不能有 ${field} 欄位`);
      }
    }
    const list = await request(port, 'GET', '/api/tasks');
    const row = list.json.tasks.find((item) => item.id === id);
    assert.equal(row.has_question, true);
    assert.equal(row.blocked_reason, 'question');
    const single = await request(port, 'GET', `/api/tasks/${id}`);
    assert.equal(single.json.task.has_question, true);
    // 沒有問題的任務 has_question 是 false。
    assert.ok(list.json.tasks.filter((item) => item.id !== id && item.status === 'done').every((item) => item.has_question === false));

    const denied = await request(port, 'GET', `/api/tasks/${id}/question`);
    assert.equal(denied.status, 401);
    assert.ok(!denied.raw.includes('SECRET'));
    const allowed = await request(port, 'GET', `/api/tasks/${id}/question`, { headers: AUTH });
    assert.equal(allowed.status, 200, allowed.raw);
    assert.equal(allowed.json.question, secret.question);
    assert.equal(allowed.json.resume_answer, secret.resume_answer);
    assert.equal(allowed.json.resume_question, secret.resume_question);
    assert.equal(allowed.json.waiting_for_answer, true);
    const badId = await request(port, 'GET', '/api/tasks/not-a-uuid/question', { headers: AUTH });
    assert.equal(badId.status, 400);
    // 改成 failed 免得之後的測試把它當成在等回答。
    fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), `${JSON.stringify({ ...task, status: 'failed' }, null, 2)}\n`);
  });

  test('(h) 假 CLI 沒有產出、最後一行也不是 BLOCKED: 時，照舊走失敗重試', async () => {
    const silent = await createTask('[silent] 安靜的任務');
    const notLast = await createTask('[not-last] BLOCKED 不在最後一行');
    for (const taskId of [silent, notLast]) {
      const failed = await waitForTask(taskId, (task) => task.status === 'failed' || task.status === 'blocked', 'failed after retries');
      assert.equal(failed.status, 'failed', JSON.stringify(failed));
      assert.equal(failed.retry_count, agent.MAX_TASK_RETRIES);
      assert.equal(failed.question, undefined);
      assert.equal(failed.blocked_reason, undefined);
      assert.equal(workerCaptures(taskId).length, agent.MAX_TASK_RETRIES + 1);
    }
    assert.match(readTaskFile(silent).error, /no output and no artifact/);
    assert.equal(readTaskFile(notLast).error, 'no artifact produced');
  });

  test('(j) mock worker：instruction 含 [mock-question] 時停成 blocked/question，帶答案續跑後照常做完', async () => {
    process.env.MOCK_WORKER = '1';
    process.env.ENABLE_REAL_CLAUDE_WORKER = '';
    const taskId = await createTask('[mock-question] mock 也會問');
    const asked = await waitForQuestion(taskId);
    assert.equal(asked.status, 'blocked', JSON.stringify(asked));
    assert.equal(asked.blocked_reason, 'question');
    assert.equal(asked.question, '測試問題');
    const resumed = await resume(taskId, { payload: { answer: 'mock 的答案' } });
    assert.equal(resumed.status, 202, resumed.raw);
    const done = await waitForQuestion(taskId, 1);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(done.resume_answer, 'mock 的答案');
  });

  test('(i) 整個 npm test 跑完：repo 的 data/conversations 與 data/chat_state.json 沒有新檔、也沒有被改過', () => {
    const now = repoDataSnapshot();
    assert.deepEqual(now, ownRepoSnapshot, '這支測試本身不能動到 repo 的對話資料');
    if (suiteRepoSnapshot) {
      assert.deepEqual(now, suiteRepoSnapshot, '跟 npm test 開頭記下的不同');
    }
  });
}
