'use strict';

// MiniMax 用量适配器的模型名找回（modelRecovery）测试。
//
// 背景：v2 记账表自 2026-08 中旬起 model 列为空，真实模型名在消息表的
// context_usage_telemetry.model。这里用真实 schema 的 fixture 库走完整
// 读取链路（probe → read → recovery → normalize），验证三种路径：
// 空模型可找回、空模型无遥测保持占位名、自带模型名不被覆盖。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DatabaseSync } = require('node:sqlite');
const { buildRecoveryQuery, TURN_CHUNK_SIZE } = require('../../src/shared/providers/minimax/modelRecovery');
const { collectMinimaxRows, buildMinimaxPeriods } = require('../../src/shared/providers/minimax/usage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

// 三行数据的 token 分量（input/output/reasoning/cacheRead/cacheWrite）与期望合计。
const ROW_TOKENS = {
  s1: [100, 50, 10, 20, 0],
  s2: [200, 80, 10, 20, 0],
  s3: [300, 120, 10, 20, 0]
};
// 提取器口径：input + output + cacheRead + cacheWrite；reasoning 已含在
// output 内不重复计（与 MiniMax 库 raw.totalTokens = input+output+cacheRead
// 的自有记账公式一致，见 usage.js 的行身份注释）。
const rowTotal = (session) => {
  const [input, output, , cacheRead, cacheWrite] = ROW_TOKENS[session];
  return input + output + cacheRead + cacheWrite;
};

function createFixtureDb(dir) {
  const dbPath = path.join(dir, 'runtime-state.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_name TEXT,
      framework_type TEXT,
      turn_id TEXT,
      model TEXT,
      ts INTEGER NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      cost_usd REAL, raw TEXT
    );
    CREATE TABLE local_runtime_message_rows (
      id INTEGER PRIMARY KEY,
      session_id TEXT, turn_id TEXT, msg_id TEXT, role TEXT,
      created_at_ms INTEGER, data_json TEXT
    );
  `);
  const now = Date.now();
  const insertUsage = database.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, agent_name, framework_type, turn_id, model, ts,
     input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?, 'mavis', 'pi-agent', ?, ?, ?, ?, ?, ?, ?, ?)`);
  // 1) 空模型 + 消息表有遥测 → 应找回 MiniMax-M3
  insertUsage.run('s1', 'turn-with-model', '', now, ...ROW_TOKENS.s1);
  // 2) 空模型 + 该 turn 无任何带遥测的消息 → 保持占位名
  insertUsage.run('s2', 'turn-no-telemetry', '', now, ...ROW_TOKENS.s2);
  // 3) 自带模型名（历史行格式，带前缀）→ 不被覆盖
  insertUsage.run('s3', 'turn-own-model', 'minimax/MiniMax-M3', now, ...ROW_TOKENS.s3);

  const insertMessage = database.prepare(`INSERT INTO local_runtime_message_rows
    (session_id, turn_id, msg_id, role, created_at_ms, data_json) VALUES (?, ?, ?, 'assistant', ?, ?)`);
  const telemetry = (model) => JSON.stringify({ context_usage_telemetry: { model } });
  insertMessage.run('s1', 'turn-with-model', 'm1', now, telemetry('MiniMax-M3'));
  // s2 的消息没有遥测字段（LIKE 不命中）
  insertMessage.run('s2', 'turn-no-telemetry', 'm2', now, JSON.stringify({ msg_content: 'plain' }));
  database.close();
  return dbPath;
}

test('collectMinimaxRows recovers models from message telemetry and keeps placeholders otherwise', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-model-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = createFixtureDb(dir);

  const rows = await collectMinimaxRows({ dbPaths: [dbPath], now: () => Date.now() });
  assert.equal(rows.length, 3);
  const bySession = new Map(rows.map((row) => [row.sessionId.split(':').pop(), row]));

  // 1) 空模型行按 turn 关联找回真实模型名。
  assert.equal(bySession.get('s1').model, 'MiniMax-M3');
  // 2) 无遥测的空模型行保持占位名（优雅降级，不是丢行）。
  assert.equal(bySession.get('s2').model, 'Pi Agent');
  // 3) 自带模型名的行原样保留（normalize 只剥 minimax/ 前缀）。
  assert.equal(bySession.get('s3').model, 'MiniMax-M3');
});

test('recovered models flow into the period models map', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-period-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = createFixtureDb(dir);

  const rows = await collectMinimaxRows({ dbPaths: [dbPath] });
  const periods = buildMinimaxPeriods({ now: Date.now(), allTimeSince: '1970-01-01', rows, pricingByModel: null });
  const today = extractUsageFromTokscale(periods.today);
  // 找回的 s1 与自带模型名的 s3 同为 MiniMax-M3（去前缀后同键），合并计入。
  assert.equal(today.models['minimax-m3'], rowTotal('s1') + rowTotal('s3'));
  // 占位名行单独成键，token 数完整。
  assert.equal(today.models['pi agent'], rowTotal('s2'));
  assert.equal(today.clients.minimax, rowTotal('s1') + rowTotal('s2') + rowTotal('s3'));
});

test('buildRecoveryQuery chunks turn ids and emits both SQL flavors', () => {
  const ids = ['a'.repeat(36), 'b'.repeat(36)];
  const query = buildRecoveryQuery(ids, 0);
  assert.ok(query);
  assert.ok(query.cliSql.includes(`'${ids[0]}'`));
  assert.ok(query.paramSql.includes('turn_id IN (?, ?)'));
  assert.deepEqual(query.params, ['%context_usage_telemetry%', ...ids]);
  // 越界分块返回 null；跨块时第二块只带剩余 id。
  assert.equal(buildRecoveryQuery(ids, 1), null);
  const many = Array.from({ length: TURN_CHUNK_SIZE + 1 }, (_, i) => `turn-${i}`);
  assert.equal(buildRecoveryQuery(many, 0).params.length, TURN_CHUNK_SIZE + 1);
  assert.equal(buildRecoveryQuery(many, 1).params.length, 2);
});
