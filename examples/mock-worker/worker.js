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
function writeJsonFile(filePath, value) {
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    const rejection = new Error(
      `write_rejected: ${filePath} (${error.code || error.name}): ${error.message}`,
    );
    rejection.code = 'WRITE_REJECTED';
    rejection.rejected_path = filePath;
    rejection.reason = error.code || error.name;
    throw rejection;
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

function updateTaskStatus(task, status, extra = {}) {
  const nextTask = {
    ...task,
    ...extra,
    status,
    updated_at: nowIso(),
  };
  writeJsonFile(taskPath(task.id), nextTask);
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

