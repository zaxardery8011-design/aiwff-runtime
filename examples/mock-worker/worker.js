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

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
    fs.appendFileSync(progressPath(task.id), `${JSON.stringify(progress)}\n`);
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
      } catch (_) {
        // Nothing else can be written safely if the task file is missing or invalid.
      }
    }
    console.error(error.message);
    process.exit(1);
  });

