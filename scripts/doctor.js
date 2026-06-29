const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const PORT = Number(process.env.PORT || 3100);

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    console.log(`PASS Node.js version ${process.version} >= 18`);
    return true;
  }
  console.log(`FAIL Node.js version ${process.version} is below 18`);
  return false;
}

function checkTasksDirectory() {
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.accessSync(TASKS_DIR, fs.constants.R_OK | fs.constants.W_OK);
    console.log(`PASS data/tasks can be created at ${path.relative(ROOT_DIR, TASKS_DIR)}`);
    return true;
  } catch (error) {
    console.log(`FAIL data/tasks cannot be created: ${error.message}`);
    return false;
  }
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.log(`WARN port ${port} is already in use`);
        resolve('warn');
        return;
      }
      console.log(`FAIL port ${port} check failed: ${error.message}`);
      resolve('fail');
    });
    server.once('listening', () => {
      server.close(() => {
        console.log(`PASS port ${port} is available`);
        resolve('pass');
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  const nodeOk = checkNodeVersion();
  const dirOk = checkTasksDirectory();
  const portStatus = await checkPortAvailable(PORT);

  if (nodeOk && dirOk && portStatus === 'pass') {
    console.log('✓ Doctor passed — ready to run demo');
    return;
  }

  if (nodeOk && dirOk && portStatus === 'warn') {
    console.log('Doctor completed with warnings — stop the process using the port before running the default demo');
    return;
  }

  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FAIL doctor crashed: ${error.message}`);
  process.exit(1);
});

