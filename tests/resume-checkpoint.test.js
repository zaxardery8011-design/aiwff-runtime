// 斷點續傳：任務中斷（失敗／逾時／runtime 重啟）後用同一個 id 續跑，
// worker 寫在 workspace 的 CHECKPOINT.txt 會被帶進下一棒，已完成的步驟不重做。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const RUNTIME_TOKEN = 'test-runtime-token';
const AUTH_HEADERS = { 'x-aiwff-runtime-token': RUNTIME_TOKEN };
const agentModule = require(path.join(ROOT_DIR, 'agent', 'index.js'));
const { requestJson } = require(path.join(ROOT_DIR, 'scripts', 'demo.js'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

async function startDaemon(env = {}) {
  const port = await getOpenPort();
  const daemon = spawn(process.execPath, [path.join('agent', 'index.js')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      TG_BOT_TOKEN: '',
      ADMIN_TG_CHAT_ID: '',
      CLAUDE_BYPASS_APPROVALS: '',
      MOCK_WORKER: '1',
      ENABLE_REAL_CLAUDE_WORKER: '',
      AIWFF_WORKER_PROVIDER: '',
      AIWFF_RUNTIME_TOKEN: RUNTIME_TOKEN,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { stdout: '', stderr: '' };
  daemon.stdout.on('data', (chunk) => { logs.stdout += chunk.toString(); });
  daemon.stderr.on('data', (chunk) => { logs.stderr += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`daemon exited early with code ${daemon.exitCode}: ${logs.stderr}`);
    }
    try {
      if ((await requestJson(port, 'GET', '/api/health')).ok) {
        return { daemon, logs, port };
      }
    } catch (_) {
      await sleep(100);
    }
  }
  daemon.kill();
  throw new Error('daemon health check timed out');
}

async function stopDaemon(daemon) {
  if (!daemon || daemon.exitCode != null) {
    return;
  }
  daemon.kill();
  const deadline = Date.now() + 3000;
  while (daemon.exitCode == null && Date.now() < deadline) {
    await sleep(50);
  }
}

async function waitForTaskStatus(port, taskId, statuses, timeoutMs = 15000) {
  const wanted = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await requestJson(port, 'GET', `/api/tasks/${taskId}`);
    if (wanted.has(task.status)) {
      return task;
    }
    await sleep(150);
  }
  throw new Error(`task ${taskId} did not reach ${statuses.join('/')} within ${timeoutMs}ms`);
}

function writeFakeClaude(name, scriptBody) {
  const binDir = path.join(DATA_DIR, 'test-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, `${name}.js`);
  fs.writeFileSync(scriptPath, scriptBody);
  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, `${name}.cmd`);
    fs.writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return commandPath;
  }
  const commandPath = path.join(binDir, name);
  fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

function writeTaskFile(task) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task));
}

function progressText(taskId) {
  const file = path.join(TASKS_DIR, `${taskId}.progress.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function countMatches(text, needle) {
  return text.split(needle).length - 1;
}

// 假 worker：三個步驟 A/B/C，每做完一步就照 prompt 的約定在 cwd 的 CHECKPOINT.txt 記一行；
// 第一棒做完 A、B 就以非 0 退出（模擬中途掛掉），之後的棒只做 checkpoint 裡還沒有的步驟。
// 每一步實際執行時記進 executed.log，讓測試數得出哪一步被做了幾次。
function stepwiseClaudeScript(stateDir) {
  return `
const fs = require('fs');
const path = require('path');
const stateDir = ${JSON.stringify(stateDir)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.mkdirSync(stateDir, { recursive: true });
  const counterFile = path.join(stateDir, 'runs.txt');
  let run = 0;
  try { run = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch (_) {}
  run += 1;
  fs.writeFileSync(counterFile, String(run));
  fs.writeFileSync(path.join(stateDir, 'prompt-' + run + '.txt'), input);
  const checkpointMatch = input.match(/就在 (.+CHECKPOINT\\.txt) 追加一行/);
  if (!checkpointMatch) { console.error('prompt has no checkpoint path'); process.exit(4); }
  const checkpoint = checkpointMatch[1];
  let done = [];
  try { done = fs.readFileSync(checkpoint, 'utf8').split(/\\r?\\n/).filter(Boolean); } catch (_) {}
  for (const step of ['A', 'B', 'C']) {
    if (done.includes(step)) continue;
    if (run === 1 && step === 'C') { console.error('crashed before step C'); process.exit(1); }
    fs.appendFileSync(path.join(stateDir, 'executed.log'), step + '\\n');
    fs.appendFileSync(checkpoint, step + '\\n');
  }
  const outMatch = input.match(/結果請寫到: (.+)/);
  fs.writeFileSync(outMatch[1].trim(), 'DONE: all steps\\n');
  console.log('run ' + run + ' finished');
});
`;
}

test('checkpoint file: one step per line, deduped, comments and blanks ignored, missing file means none', () => {
  resetDataDir();
  const taskId = '00000000-0000-4000-8000-0000000000c1';
  assert.deepEqual(agentModule.readCheckpointSteps(taskId), []);
  const file = agentModule.checkpointPath(taskId);
  assert.equal(file, path.join(WORKSPACES_DIR, taskId, 'CHECKPOINT.txt'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# header\nstep-1\r\n\n  step-2  \nstep-1\n');
  assert.deepEqual(agentModule.readCheckpointSteps(taskId), ['step-1', 'step-2']);
  assert.deepEqual(agentModule.readCheckpointSteps('../escape'), []);
});

test('worker prompt always names the checkpoint file and lists finished steps only when resuming', () => {
  resetDataDir();
  const task = { id: '00000000-0000-4000-8000-0000000000c2', title: 't', instruction: 'i' };
  const fresh = agentModule.buildClaudePrompt(task);
  assert.ok(fresh.includes(agentModule.checkpointPath(task.id)), 'fresh prompt must name the checkpoint file');
  assert.ok(!fresh.includes('不要重做'), 'fresh prompt must not claim anything was already done');

  fs.mkdirSync(path.dirname(agentModule.checkpointPath(task.id)), { recursive: true });
  fs.writeFileSync(agentModule.checkpointPath(task.id), 'collect data\nwrite draft\n');
  const resumed = agentModule.buildClaudePrompt(task);
  assert.match(resumed, /不要重做/);
  assert.match(resumed, /^- collect data$/m);
  assert.match(resumed, /^- write draft$/m);
  // 斷點段落不能擠掉既有契約：結果路徑那一行還在，而且只出現一次。
  assert.equal(countMatches(resumed, '結果請寫到: '), 1);
});

test('resume: a worker that crashed mid-task continues from its checkpoint without redoing finished steps', async () => {
  resetDataDir();
  const stateDir = path.join(DATA_DIR, 'stepwise-state');
  const claudeCmd = writeFakeClaude('stepwise-claude', stepwiseClaudeScript(stateDir));
  const runtime = await startDaemon({
    MOCK_WORKER: '',
    ENABLE_REAL_CLAUDE_WORKER: '1',
    CLAUDE_CMD: claudeCmd,
    MAX_TASK_RETRIES: '0',
  });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'stepwise',
      instruction: 'do A, B, C',
      timeout_sec: 20,
    }, AUTH_HEADERS);
    const failed = await waitForTaskStatus(runtime.port, created.id, ['failed']);
    assert.match(failed.error, /crashed before step C/);
    assert.deepEqual(agentModule.readCheckpointSteps(created.id), ['A', 'B']);

    const resumed = await requestJson(runtime.port, 'POST', `/api/tasks/${created.id}/resume`, {}, AUTH_HEADERS);
    assert.equal(resumed.ok, true);
    assert.deepEqual(resumed.checkpoint_steps, ['A', 'B']);
    assert.equal(resumed.task.resume_count, 1);

    const done = await waitForTaskStatus(runtime.port, created.id, ['done']);
    assert.equal(done.resume_count, 1);
    assert.equal(done.error, undefined, 'old failure must not stay on a task that is now done');
    assert.match(done.last_error, /^resumed after failed: .*crashed before step C/);

    // 每一步只真的做過一次：A、B 在第一棒做完，第二棒只做 C。
    const executed = fs.readFileSync(path.join(stateDir, 'executed.log'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(executed, ['A', 'B', 'C']);
    // 第二棒的 prompt 有列出已完成的步驟。
    const secondPrompt = fs.readFileSync(path.join(stateDir, 'prompt-2.txt'), 'utf8');
    assert.match(secondPrompt, /不要重做/);
    assert.match(secondPrompt, /^- A$/m);
    assert.match(secondPrompt, /^- B$/m);
    assert.match(progressText(created.id), /Resume #1: 2 checkpoint step\(s\) carried over \(A, B\)/);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('resume: a task interrupted by a runtime restart skips the steps already in its checkpoint (mock worker)', async () => {
  resetDataDir();
  const taskId = '00000000-0000-4000-8000-0000000000c3';
  const now = new Date().toISOString();
  writeTaskFile({ id: taskId, title: 'interrupted', instruction: 'x', status: 'running', created_at: now, updated_at: now });
  fs.mkdirSync(path.join(WORKSPACES_DIR, taskId), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACES_DIR, taskId, 'CHECKPOINT.txt'), 'step-1\nstep-2\n');
  const runtime = await startDaemon({ MOCK_WORKER: '1' });

  try {
    const { task: swept } = await requestJson(runtime.port, 'GET', `/api/tasks/${taskId}`);
    assert.equal(swept.status, 'blocked');
    assert.equal(swept.blocked_reason, 'interrupted');
    assert.match(swept.last_error, /resume with POST \/api\/tasks\/.+\/resume/);

    const resumed = await requestJson(runtime.port, 'POST', `/api/tasks/${taskId}/resume`, {}, AUTH_HEADERS);
    assert.deepEqual(resumed.checkpoint_steps, ['step-1', 'step-2']);
    const done = await waitForTaskStatus(runtime.port, taskId, ['done']);
    assert.equal(done.blocked_reason, undefined);
    assert.equal(done.resume_count, 1);

    const progress = progressText(taskId);
    assert.equal(countMatches(progress, 'Mock worker progress 1/3'), 0);
    assert.equal(countMatches(progress, 'Mock worker progress 2/3'), 0);
    assert.equal(countMatches(progress, 'Mock worker progress 3/3'), 1);
    assert.equal(countMatches(progress, 'already in checkpoint'), 2);
    assert.deepEqual(agentModule.readCheckpointSteps(taskId), ['step-1', 'step-2', 'step-3']);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('resume: a task longer than its timeout finishes over several resumes, never redoing a checkpointed step', async () => {
  resetDataDir();
  const runtime = await startDaemon({ MOCK_WORKER: '1' });

  try {
    const created = await requestJson(runtime.port, 'POST', '/api/tasks', {
      title: 'longer than budget',
      instruction: 'three one-second steps with a two-second budget',
      timeout_sec: 2,
    }, AUTH_HEADERS);
    let task = await waitForTaskStatus(runtime.port, created.id, ['blocked', 'done'], 8000);
    let resumes = 0;
    while (task.status === 'blocked') {
      assert.equal(task.blocked_reason, 'timeout');
      assert.ok(resumes < 4, 'each run finishes at least one step, so three resumes are enough');
      await sleep(300); // 讓被砍的那一棒確實結束，再讀它留下的 checkpoint
      const carried = agentModule.readCheckpointSteps(created.id);
      const before = progressText(created.id);
      await requestJson(runtime.port, 'POST', `/api/tasks/${created.id}/resume`, {}, AUTH_HEADERS);
      resumes += 1;
      task = await waitForTaskStatus(runtime.port, created.id, ['blocked', 'done'], 8000);
      const after = progressText(created.id);
      for (const step of carried) {
        const label = `Mock worker progress ${step.replace('step-', '')}/3`;
        assert.equal(countMatches(after, label), countMatches(before, label), `${step} was in the checkpoint but ran again`);
      }
    }
    assert.equal(task.status, 'done');
    assert.ok(resumes >= 1, 'a 3-second task cannot finish inside a 2-second budget without resuming');
    assert.equal(task.resume_count, resumes);
    assert.deepEqual(agentModule.readCheckpointSteps(created.id), ['step-1', 'step-2', 'step-3']);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});

test('resume endpoint: needs the write token, refuses tasks that are not blocked or failed, names bad ids', async () => {
  resetDataDir();
  const doneId = '00000000-0000-4000-8000-0000000000c4';
  const now = new Date().toISOString();
  writeTaskFile({ id: doneId, title: 'already done', instruction: 'x', status: 'done', created_at: now, updated_at: now });
  const runtime = await startDaemon({ MOCK_WORKER: '1' });

  try {
    await assert.rejects(
      () => requestJson(runtime.port, 'POST', `/api/tasks/${doneId}/resume`, {}),
      (error) => error.statusCode === 401,
    );
    await assert.rejects(
      () => requestJson(runtime.port, 'POST', `/api/tasks/${doneId}/resume`, {}, AUTH_HEADERS),
      (error) => error.statusCode === 409 && /status=done/.test(error.message),
    );
    await assert.rejects(
      () => requestJson(runtime.port, 'POST', '/api/tasks/00000000-0000-4000-8000-0000000000ff/resume', {}, AUTH_HEADERS),
      (error) => error.statusCode === 404,
    );
    await assert.rejects(
      () => requestJson(runtime.port, 'POST', '/api/tasks/not-a-uuid/resume', {}, AUTH_HEADERS),
      (error) => error.statusCode === 400,
    );
    const { task } = await requestJson(runtime.port, 'GET', `/api/tasks/${doneId}`);
    assert.equal(task.status, 'done');
    assert.equal(task.resume_count, undefined);
  } finally {
    await stopDaemon(runtime.daemon);
  }
});
