const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');
const taskId = process.argv[2];

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskPath(id) {
  return path.join(TASKS_DIR, `${id}.json`);
}

function progressPath(id) {
  return path.join(TASKS_DIR, `${id}.progress.jsonl`);
}

function artifactPath(id) {
  return path.join(ARTIFACTS_DIR, `${id}.result.json`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Authoritative write: if the filesystem rejects it, the caller must see a
// named reason. Never let a rejected write return as if it had succeeded.
// A write call that returns without throwing only proves the syscall was
// accepted, so every authoritative write reads its own bytes back before the
// caller is allowed to treat the state as settled.
function writeJsonFile(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(filePath, payload);
  } catch (error) {
    const rejection = new Error(
      `write_rejected: ${filePath} (${error.code || error.name}): ${error.message}`,
    );
    rejection.code = 'WRITE_REJECTED';
    rejection.rejected_path = filePath;
    rejection.reason = error.code || error.name;
    throw rejection;
  }

  let readback;
  try {
    readback = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const failure = new Error(
      `write_readback_failed: ${filePath} (${error.code || error.name}): ${error.message}`,
    );
    failure.code = 'WRITE_READBACK_FAILED';
    failure.rejected_path = filePath;
    failure.reason = error.code || error.name;
    throw failure;
  }
  if (readback !== payload) {
    const failure = new Error(
      `write_readback_mismatch: ${filePath} (expected ${payload.length} chars, read ${readback.length})`,
    );
    failure.code = 'WRITE_READBACK_FAILED';
    failure.rejected_path = filePath;
    failure.reason = 'readback_mismatch';
    throw failure;
  }
}

// Observability-only write: best-effort. A failure here must not abort a task
// that otherwise succeeded, but it must still be reported with a named reason
// instead of being swallowed.
function appendObservationLine(filePath, line) {
  try {
    fs.appendFileSync(filePath, line);
    return { written: true };
  } catch (error) {
    const reason = error.code || error.name;
    console.error(`WARN observation_write_skipped: ${filePath} (${reason}): ${error.message}`);
    return { written: false, reason };
  }
}

const TERMINAL_STATUSES = new Set(['done', 'failed']);
// 終局狀態的擁有者不一定在這個行程裡：daemon 的 timeout 路徑會先把任務標成
// blocked（blocked_reason=timeout）再砍 worker，所以「誰已經終局了」只有磁碟上的
// 任務檔說得準。只認行程內變數的話，逾時判決下來後仍在跑的這一棒會把 blocked
// 覆寫成 done，重跑同一個 id 也會把別人的終局判決洗成 running——兩者都無聲無息。
// blocked 列在這裡就是為了認得 daemon 那個逾時標記。
const PERSISTED_TERMINAL_STATUSES = new Set(['done', 'failed', 'blocked']);
// The terminal status has exactly one owner: whoever claims it first. A later
// writer must not quietly overwrite it — it says who already owns it instead.
let terminalStatusOwner = null;

// 磁碟上的現況只有三種答案：非終局（回 null，可寫）、已終局（回那個狀態）、
// 讀不出來。讀不出來本身就是歧義，不得當成「沒人擁有」而放行覆寫，所以一樣
// 回一個具名的值讓呼叫端走拒絕分支。
function persistedStatusClaim(id) {
  let persisted;
  try {
    persisted = readJsonFile(taskPath(id));
  } catch (error) {
    return `unreadable(${error.code || error.name})`;
  }
  const status = persisted && typeof persisted.status === 'string' ? persisted.status.trim() : '';
  if (status === '') {
    return 'unreadable(missing_status)';
  }
  return PERSISTED_TERMINAL_STATUSES.has(status) ? status : null;
}

function updateTaskStatus(task, status, extra = {}) {
  if (TERMINAL_STATUSES.has(status) && terminalStatusOwner) {
    console.error(
      `WARN terminal_status_already_owned: ${task.id} is already ${terminalStatusOwner}, refusing to overwrite with ${status}`,
    );
    return null;
  }

  // 本行程還沒 claim 過終局狀態時，磁碟是唯一的擁有者來源。已被別人擁有或判不
  // 出來 → 不寫權威標記，改吐具名診斷並 fail closed，把處置權還給呼叫端。
  if (!terminalStatusOwner) {
    const claim = persistedStatusClaim(task.id);
    if (claim) {
      console.error(
        `WARN terminal_status_owned_on_disk: ${task.id} is already ${claim} on disk and this process never claimed it, refusing to write ${status}`,
      );
      return null;
    }
  }

  const nextTask = {
    ...task,
    ...extra,
    status,
    updated_at: nowIso(),
  };
  writeJsonFile(taskPath(task.id), nextTask);
  // Claimed only after the write read itself back: a status that never landed
  // must stay unowned so the failure path can still record why.
  if (TERMINAL_STATUSES.has(status)) {
    terminalStatusOwner = status;
  }
  return nextTask;
}

// 被拒的狀態寫入不能只回 null 就當沒事：呼叫端若照常往下跑，會拿一個 null 任務
// 去 deref（變成沒有具名理由的 TypeError），或帶著一份沒人承認的結果 exit 0。
function claimStatusOrThrow(task, status, extra = {}) {
  const nextTask = updateTaskStatus(task, status, extra);
  if (nextTask) {
    return nextTask;
  }
  const refusal = new Error(
    `status_write_refused: ${task.id} could not be marked ${status} — the authoritative status is owned elsewhere (see the WARN line above)`,
  );
  refusal.code = 'STATUS_WRITE_REFUSED';
  throw refusal;
}

async function main() {
  if (!taskId) {
    throw new Error('Usage: node examples/mock-worker/worker.js <taskId>');
  }

  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  let task = readJsonFile(taskPath(taskId));
  task = claimStatusOrThrow(task, 'running');

  for (let index = 1; index <= 3; index += 1) {
    const progress = {
      task_id: task.id,
      step: index,
      total_steps: 3,
      message: `Mock worker progress ${index}/3`,
      at: nowIso(),
    };
    appendObservationLine(progressPath(task.id), `${JSON.stringify(progress)}\n`);
    await sleep(1000);
  }

  const artifact = {
    task_id: task.id,
    title: task.title,
    summary: `Mock worker completed task: ${task.title}`,
    completed_at: nowIso(),
  };
  writeJsonFile(artifactPath(task.id), artifact);

  // 收官這一寫是權威標記：逾時判決在我們跑完前落下來時，這裡要拒寫並讓這一棒
  // 以非零收場，不能悄悄把 blocked 蓋成 done、也不能帶著沒人承認的結果 exit 0。
  claimStatusOrThrow(task, 'done', {
    artifact_path: path.relative(ROOT_DIR, artifactPath(task.id)).replaceAll(path.sep, '/'),
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    if (taskId) {
      try {
        const task = readJsonFile(taskPath(taskId));
        updateTaskStatus(task, 'failed', { error: error.message });
      } catch (statusError) {
        // Nothing else can be written safely if the task file is missing or
        // invalid — say why instead of dropping the reason on the floor.
        console.error(`WARN failed_status_not_persisted: ${statusError.message}`);
      }
    }
    console.error(error.message);
    process.exit(1);
  });

