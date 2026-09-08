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
// The terminal status has exactly one owner: whoever claims it first. A later
// writer must not quietly overwrite it — it says who already owns it instead.
let terminalStatusOwner = null;

function updateTaskStatus(task, status, extra = {}) {
  if (TERMINAL_STATUSES.has(status) && terminalStatusOwner) {
    console.error(
      `WARN terminal_status_already_owned: ${task.id} is already ${terminalStatusOwner}, refusing to overwrite with ${status}`,
    );
    return null;
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

async function main() {
  if (!taskId) {
    throw new Error('Usage: node examples/mock-worker/worker.js <taskId>');
  }

  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  let task = readJsonFile(taskPath(taskId));
  task = updateTaskStatus(task, 'running');

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

  updateTaskStatus(task, 'done', {
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

