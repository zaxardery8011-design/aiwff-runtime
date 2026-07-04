const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TASKS_DIR = path.join(ROOT_DIR, 'data', 'tasks');
const PORT = Number(process.env.PORT || 3100);
const JSON_MODE = process.argv.includes('--json');

const UNSAFE_FLAGS = new Set(['CLAUDE_BYPASS_APPROVALS']);

function envFlagValue(value) {
  return value === '1' || String(value).toLowerCase() === 'true';
}

function checkNodeVersionText() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    console.log(`PASS Node.js version ${process.version} >= 18`);
    return true;
  }
  console.log(`FAIL Node.js version ${process.version} is below 18`);
  return false;
}

function checkTasksDirectoryText() {
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

function checkPortAvailableText(port) {
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

function makeCheck(id, ok, detail) {
  return { id, ok: Boolean(ok), detail: String(detail || '') };
}

function quoteCommandPart(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

function commandVersion(command) {
  let result;
  if (process.platform === 'win32') {
    const commandLine = [quoteCommandPart(command), '--version'].join(' ');
    result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/)[0] || 'no version output';
  return {
    ok: result.status === 0,
    detail: result.error ? result.error.message : output,
  };
}

function parseDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  const values = {};
  const errors = [];
  if (!fs.existsSync(envPath)) {
    return { exists: false, values, errors };
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      errors.push(`line ${index + 1}: invalid assignment`);
      return;
    }
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] !== quote) {
      errors.push(`line ${index + 1}: unmatched quote`);
      return;
    }
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  });

  return { exists: true, values, errors };
}

function envValue(parsedEnv, name) {
  if (process.env[name] != null && process.env[name] !== '') {
    return process.env[name];
  }
  return parsedEnv.values[name] || '';
}

async function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      resolve({
        ok: false,
        detail: error.code === 'EADDRINUSE' ? `port ${port} is already in use` : error.message,
      });
    });
    server.once('listening', () => {
      server.close(() => resolve({ ok: true, detail: `port ${port} is available` }));
    });
    server.listen(port, '127.0.0.1');
  });
}

function checkDataDirWritable() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const probePath = path.join(DATA_DIR, `.doctor-write-test-${process.pid}`);
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    return makeCheck('data_dir_writable', true, `data directory is writable at ${path.relative(ROOT_DIR, DATA_DIR)}`);
  } catch (error) {
    return makeCheck('data_dir_writable', false, error.message);
  }
}

function checkEnvValid(parsedEnv) {
  const unsafe = [];
  for (const name of UNSAFE_FLAGS) {
    if (envFlagValue(envValue(parsedEnv, name))) {
      unsafe.push(name);
    }
  }
  if (parsedEnv.errors.length || unsafe.length) {
    const detail = []
      .concat(parsedEnv.errors)
      .concat(unsafe.map((name) => `${name} is unsafe for default runs`))
      .join('; ');
    return makeCheck('env_valid', false, detail);
  }
  return makeCheck('env_valid', true, parsedEnv.exists ? '.env parsed without unsafe flags' : '.env absent; environment is safe');
}

function checkTelegramConfig(parsedEnv) {
  const token = envValue(parsedEnv, 'TG_BOT_TOKEN');
  const adminId = envValue(parsedEnv, 'ADMIN_TG_CHAT_ID');
  if (token && !adminId) {
    return makeCheck('tg_config_valid', false, 'ADMIN_TG_CHAT_ID is required when TG_BOT_TOKEN is set');
  }
  return makeCheck('tg_config_valid', true, token ? 'Telegram token and admin chat id are both set' : 'Telegram token is not set');
}

async function runJsonDoctor() {
  const parsedEnv = parseDotEnv();
  const npm = commandVersion('npm');
  const git = commandVersion('git');
  const claudeCmd = envValue(parsedEnv, 'CLAUDE_CMD') || 'claude';
  const claude = commandVersion(claudeCmd);
  const port = await probePort(PORT);
  const nodeMajor = Number(process.versions.node.split('.')[0]);

  const checks = [
    makeCheck('node_version', nodeMajor >= 18, `${process.version} ${nodeMajor >= 18 ? '>=' : '<'} 18`),
    makeCheck('npm_available', npm.ok, npm.detail),
    makeCheck('git_available', git.ok, git.detail),
    makeCheck('port_available', port.ok, port.detail),
    checkDataDirWritable(),
    checkEnvValid(parsedEnv),
    makeCheck('claude_cli_optional', true, claude.ok ? claude.detail : `optional CLI not found: ${claude.detail}`),
    checkTelegramConfig(parsedEnv),
  ];
  const nextActions = [];

  for (const check of checks) {
    if (!check.ok) {
      if (check.id === 'port_available') {
        nextActions.push(`Free port ${PORT} or set PORT to another value.`);
      } else if (check.id === 'tg_config_valid') {
        nextActions.push('Set ADMIN_TG_CHAT_ID or clear TG_BOT_TOKEN.');
      } else if (check.id === 'env_valid') {
        nextActions.push('Fix .env syntax and remove unsafe default flags.');
      } else {
        nextActions.push(`Fix ${check.id}: ${check.detail}`);
      }
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    next_actions: nextActions,
  };
}

async function runTextDoctor() {
  const nodeOk = checkNodeVersionText();
  const dirOk = checkTasksDirectoryText();
  const portStatus = await checkPortAvailableText(PORT);

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

async function main() {
  if (JSON_MODE) {
    const report = await runJsonDoctor();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  await runTextDoctor();
}

main().catch((error) => {
  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checks: [makeCheck('doctor_runtime', false, error.message)],
          next_actions: ['Fix the doctor runtime error and re-run npm run doctor -- --json.'],
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  console.error(`FAIL doctor crashed: ${error.message}`);
  process.exit(1);
});

