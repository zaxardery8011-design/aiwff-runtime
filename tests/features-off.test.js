// doctor 的 features_off：一列講清楚哪些功能被環境變數關掉或換成模擬。
const assert = require('node:assert/strict');
const test = require('node:test');

const KEYS = ['MOCK_WORKER', 'ENABLE_REAL_CLAUDE_WORKER', 'AIWFF_WORKER_PROVIDER', 'ENABLE_AGY_WORKER', 'TG_BOT_TOKEN'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const agent = require('../agent/index.js');

function withEnv(env, fn) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('MOCK_WORKER=1 且沒填 TG_BOT_TOKEN：兩項都列出、具名原因，ok 仍是 true', () => {
  withEnv({ MOCK_WORKER: '1' }, () => {
    const check = agent.featuresOffCheck();
    assert.equal(check.ok, true);
    assert.equal(check.off.length, 2);
    assert.match(check.detail, /模擬回覆（MOCK_WORKER 有設）/);
    assert.match(check.detail, /Telegram 關閉（TG_BOT_TOKEN 未填）/);
  });
});

test('沒設 MOCK_WORKER 也沒開真 worker：原因寫 ENABLE_REAL_CLAUDE_WORKER 沒開', () => {
  withEnv({ TG_BOT_TOKEN: 'fake' }, () => {
    const check = agent.featuresOffCheck();
    assert.deepEqual(check.off, ['任務和聊天用模擬回覆（ENABLE_REAL_CLAUDE_WORKER 沒開）']);
  });
});

test('真 worker 開著、Telegram 有填：沒有功能被關掉', () => {
  withEnv({ ENABLE_REAL_CLAUDE_WORKER: '1', TG_BOT_TOKEN: 'fake' }, () => {
    const check = agent.featuresOffCheck();
    assert.deepEqual(check.off, []);
    assert.equal(check.detail, '沒有功能被關掉或換成模擬');
  });
});

test('openai_compatible provider 不算模擬', () => {
  withEnv({ AIWFF_WORKER_PROVIDER: 'openai_compatible', TG_BOT_TOKEN: 'fake' }, () => {
    assert.deepEqual(agent.featuresOffCheck().off, []);
  });
});
