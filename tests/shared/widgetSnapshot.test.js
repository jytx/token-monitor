'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WIDGET_SCHEMA_VERSION,
  buildWidgetLimitRow,
  buildWidgetSnapshot,
  widgetSnapshotPath,
  writeWidgetSnapshot
} = require('../../src/shared/widgetSnapshot');

// 构造带 limits 的最小 stats（collectUsageOnce 产物形状：limits.providers）
function makeStats(providers = []) {
  return {
    deviceId: 'device-1',
    updatedAt: '2026-08-06T12:00:00.000Z',
    limits: { providers }
  };
}

// 构造一个配额型 provider（剩余百分比，如 Claude 的 5h 窗口）
function quotaProvider(overrides = {}) {
  return {
    provider: "claude",
    name: 'Claude',
    windows: [
      { kind: 'quota', metric: 'quota', label: '5-hour', remainingPercent: 62, remaining: 124 },
      ...(overrides.windows || [])
    ],
    ...overrides
  };
}

// 构造一个余额型 provider（credits，如 DeepSeek）
function creditsProvider(overrides = {}) {
  return {
    provider: "deepseek",
    name: 'DeepSeek',
    balance: { amount: 12.34, currency: 'CNY', monthSpend: 3 },
    windows: [
      { kind: 'billing', metric: 'credits', label: 'Usage credits', remaining: 12.34, currency: 'CNY' },
      ...(overrides.windows || [])
    ],
    ...overrides
  };
}

test('buildWidgetSnapshot 输出 schema 2 快照，只含 limits', () => {
  const snapshot = buildWidgetSnapshot(makeStats([quotaProvider()]), { appVersion: '0.41.0' });
  assert.equal(snapshot.schema, WIDGET_SCHEMA_VERSION);
  assert.equal(snapshot.deviceId, 'device-1');
  assert.equal(snapshot.updatedAt, '2026-08-06T12:00:00.000Z');
  assert.equal(snapshot.appVersion, '0.41.0');
  assert.equal(snapshot.limits.length, 1);
  assert.ok(!Object.hasOwn(snapshot, 'periods'), 'schema 2 不应再携带 periods');
});

test('配额型 provider：percent 取剩余百分比、remaining 原样', () => {
  const row = buildWidgetLimitRow(quotaProvider());
  assert.equal(row.name, 'Claude');
  assert.equal(row.percent, 62);
  assert.equal(row.remaining, 124);
  assert.equal(row.currency, '');
});

test('余额型 provider：percent 由余额派生、currency 为符号', () => {
  const row = buildWidgetLimitRow(creditsProvider());
  assert.equal(row.name, 'DeepSeek');
  // 余额 12.34 / (12.34 + 月花费 3) ≈ 80.4% → 80
  assert.equal(row.percent, 80);
  assert.equal(row.remaining, 12.34);
  assert.equal(row.currency, '¥');
});

test('无有效窗口的 provider 被过滤', () => {
  const row = buildWidgetLimitRow({
    provider: "empty",
    name: 'Empty',
    windows: [{ kind: 'quota', remainingPercent: null }]
  });
  assert.equal(row, null);
  const snapshot = buildWidgetSnapshot(makeStats([
    { providerId: 'empty', name: 'Empty', windows: [] }
  ]));
  assert.deepEqual(snapshot.limits, []);
});

test('行按剩余百分比升序（最紧张在前），未知百分比排后', () => {
  const snapshot = buildWidgetSnapshot(makeStats([
    creditsProvider({
      balance: { amount: 100, monthSpend: 0 },
      windows: [{ kind: 'billing', metric: 'credits', remaining: 100 }]
    }),
    quotaProvider({ provider: 'claude', windows: [{ kind: 'quota', remainingPercent: 10 }] }),
    quotaProvider({ provider: 'opencode', windows: [{ kind: 'quota', remainingPercent: 90 }] })
  ]));
  // Claude(10%) < OpenCode(90%) < DeepSeek(余额满 100%)
  assert.deepEqual(snapshot.limits.map((row) => row.name), ['Claude', 'OpenCode', 'DeepSeek']);
});

test('多账号 provider 只保留第一行', () => {
  const snapshot = buildWidgetSnapshot(makeStats([
    quotaProvider({ accountKey: 'a' }),
    quotaProvider({ accountKey: 'b', windows: [{ kind: 'quota', remainingPercent: 30 }] })
  ]));
  assert.equal(snapshot.limits.length, 1);
});

test('widgetSnapshotPath 仅 darwin 返回路径，其他平台为 null', () => {
  const options = { platform: 'linux', homeDir: '/home/user' };
  assert.equal(widgetSnapshotPath(options), null);
  const darwin = widgetSnapshotPath({ platform: 'darwin', homeDir: '/Users/test' });
  assert.equal(darwin, '/Users/test/Library/Containers/com.javis.tokenmonitor.widget/Data/Documents/widget-stats.json');
});

test('widgetSnapshotPath 支持目录覆盖（测试/特殊部署）', () => {
  const overridden = widgetSnapshotPath({
    platform: 'darwin',
    homeDir: '/Users/test',
    env: { TOKEN_MONITOR_WIDGET_GROUP_DIR: '/tmp/widget-share' }
  });
  assert.equal(overridden, '/tmp/widget-share/widget-stats.json');
});

test('writeWidgetSnapshot 原子写入成功且内容为格式化 JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-snapshot-'));
  try {
    const snapshot = buildWidgetSnapshot(makeStats([quotaProvider()]), { appVersion: '0.41.0' });
    const written = writeWidgetSnapshot(snapshot, {
      platform: 'darwin',
      homeDir: dir,
      env: { TOKEN_MONITOR_WIDGET_GROUP_DIR: path.join(dir, 'group') }
    });
    assert.equal(written, true);
    const content = fs.readFileSync(path.join(dir, 'group', 'widget-stats.json'), 'utf8');
    assert.deepEqual(JSON.parse(content), snapshot);
    // 原子写不应残留临时文件
    assert.equal(fs.existsSync(path.join(dir, 'group', 'widget-stats.json.tmp')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeWidgetSnapshot 非 darwin 直接跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-snapshot-'));
  try {
    const written = writeWidgetSnapshot({}, { platform: 'win32', homeDir: dir });
    assert.equal(written, false);
    assert.equal(fs.existsSync(path.join(dir, 'group', 'widget-stats.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
