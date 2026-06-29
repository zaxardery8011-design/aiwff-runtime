const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'data', 'artifacts');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fail('data/artifacts does not exist');
  }

  const artifacts = fs
    .readdirSync(ARTIFACTS_DIR)
    .filter((name) => name.endsWith('.result.json'))
    .map((name) => {
      const filePath = path.join(ARTIFACTS_DIR, name);
      return { name, filePath, stat: fs.statSync(filePath) };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  if (artifacts.length === 0) {
    fail('no *.result.json artifact exists');
  }

  const latest = artifacts[0];
  if (latest.stat.size <= 0) {
    fail(`${latest.filePath} is empty`);
  }
  pass(`artifact exists and is non-empty: ${latest.filePath}`);

  const artifact = readJsonFile(latest.filePath);
  if (!artifact.completed_at) {
    fail('artifact completed_at is missing');
  }
  pass(`artifact completed_at present: ${artifact.completed_at}`);

  const taskId = artifact.task_id || latest.name.replace(/\.result\.json$/, '');
  const taskFile = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(taskFile)) {
    fail(`task file missing: ${taskFile}`);
  }

  const task = readJsonFile(taskFile);
  if (task.status !== 'done') {
    fail(`task status is ${task.status}, expected done`);
  }
  pass(`task status is done: ${task.id}`);
}

main();

