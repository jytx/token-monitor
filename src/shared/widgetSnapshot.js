'use strict';

// macOS WidgetKit 小组件的快照生成与写入（schema 2：仅 AI 额度/限额数据）。
// 数据流：每次 stats 刷新时，主进程把各 provider 的「当前剩余额度」精简快照
// 原子写入 userData 下 widget-stats.json；Swift 小组件只读该文件渲染。
// 显示名、剩余百分比（含 credits 金额的派生）均在写入端算好，Swift 端零业务逻辑。
// 仅 darwin 生效；写入失败静默降级（不影响主应用）。

const os = require('node:os');
const path = require('node:path');
const { CURRENCY_RATES, normalizeCurrency } = require('./currency');
const { writeJsonAtomic } = require('./config');
const {
  creditsAmount,
  creditsCurrency,
  creditsMeterPercent,
  isCreditsWindow
} = require('./limitBalanceDisplay');

// 与 widget/TokenMonitorWidget/StatsStore.swift 中的常量保持一致
const WIDGET_GROUP_ID = 'group.com.javis.tokenmonitor';
const WIDGET_SNAPSHOT_FILE = 'widget-stats.json';
const WIDGET_SCHEMA_VERSION = 2;

// provider id → 显示名（与 renderer app.js 的 LIMIT_PROVIDERS label 保持一致；
// 新增 limits provider 时同步更新两处）
const LIMIT_PROVIDER_LABELS = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor',
  antigravity: 'Antigravity', kimi: 'Kimi', grok: 'Grok', copilot: 'GitHub Copilot',
  mimo: 'MiMo', zai: 'GLM', zaiteam: 'GLM Team', kiro: 'Kiro', deepseek: 'DeepSeek',
  openrouter: 'OpenRouter', minimax: 'Minimax', volcengine: 'Volcengine',
  qoder: 'Qoder', ollama: 'Ollama', thirdparty: 'Third-party APIs'
};

// 快照文件路径。仅 darwin 返回；其他平台返回 null（本功能仅 macOS 可用）。
// 最终通道：widget 自己的沙箱容器 Documents 目录——Electron（非沙箱进程）
// 可直接写入该路径（datavault 只约束沙箱进程），widget 读自己容器必定允许。
// 历史踩坑：App Group 容器被 datavault 拒读（宿主非沙箱）；userData 文件 +
// temporary-exception 会导致系统拒绝加载扩展（macOS 26）。见 docs/widget.md。
// TOKEN_MONITOR_WIDGET_GROUP_DIR 可覆盖目录（测试用，命名保留兼容）。
function widgetSnapshotPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  if (platform !== 'darwin') return null;
  if (env.TOKEN_MONITOR_WIDGET_GROUP_DIR) {
    return path.join(env.TOKEN_MONITOR_WIDGET_GROUP_DIR, WIDGET_SNAPSHOT_FILE);
  }
  return path.join(
    homeDir,
    'Library', 'Containers', 'com.javis.tokenmonitor.widget',
    'Data', 'Documents', WIDGET_SNAPSHOT_FILE
  );
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  if (value === null) return null;
  return Math.max(0, Math.min(100, Number(value)));
}

// 取 provider 的主展示 window：优先 credits（余额型，如 DeepSeek/OpenRouter），
// 否则第一个带剩余百分比的窗口（如 Claude 的 5 小时配额）。
function primaryWindow(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  const credits = windows.find((window) => isCreditsWindow(window));
  if (credits) return { window: credits, credits: true };
  const quota = windows.find((window) => finiteNumber(window?.remainingPercent) !== null);
  if (quota) return { window: quota, credits: false };
  return null;
}

// 组装单行结果：无任何剩余维度时返回 null（行被过滤）
function widgetLimitRow(name, percent, remaining, currency) {
  if (percent === null && remaining === null) return null;
  return {
    name,
    percent: percent === null ? null : Math.round(percent),
    remaining,
    currency: currency || ''
  };
}

// 纯函数：单个 provider（limits normalize 后的结构，主字段为 provider）→ widget 行。
// percent 为剩余百分比（0-100，条长用）；remaining/currency 为余额型（credits）金额。
function buildWidgetLimitRow(provider) {
  const primary = primaryWindow(provider);
  if (!primary) return null;
  const { window, credits } = primary;
  const id = String(provider?.provider || '').trim().toLowerCase();
  if (!id) return null;
  const name = LIMIT_PROVIDER_LABELS[id] || id;
  if (credits) {
    const amount = finiteNumber(creditsAmount(provider, window));
    const code = normalizeCurrency(creditsCurrency(provider, window));
    return widgetLimitRow(
      name,
      clampPercent(creditsMeterPercent(provider, window)),
      amount === null ? null : Number(amount.toFixed(2)),
      CURRENCY_RATES[code].symbol
    );
  }
  return widgetLimitRow(
    name,
    clampPercent(finiteNumber(window.remainingPercent)),
    finiteNumber(window.remaining),
    ''
  );
}

// 纯函数：stats（collectUsageOnce 产物，含 limits.providers）→ schema 2 快照。
// 每个 provider 只取第一个有效 account（多账号保持简洁）；
// 行按剩余百分比升序（最紧张的在前），与主应用 Home 的 sort='remaining' 一致。
function buildWidgetSnapshot(stats = {}, options = {}) {
  const providers = stats?.limits?.providers || [];
  const seen = new Set();
  const rows = [];
  for (const provider of providers) {
    const id = String(provider?.provider || '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = buildWidgetLimitRow(provider);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => {
    const pa = a.percent ?? 101;
    const pb = b.percent ?? 101;
    return pa - pb || a.name.localeCompare(b.name);
  });
  return {
    schema: WIDGET_SCHEMA_VERSION,
    updatedAt: stats.updatedAt || new Date().toISOString(),
    deviceId: stats.deviceId || '',
    appVersion: options.appVersion || '',
    limits: rows
  };
}

// 写入快照。非 darwin 直接跳过（返回 false）；写入失败仅告警，不向上抛。
function writeWidgetSnapshot(snapshot, options = {}) {
  const filePath = widgetSnapshotPath(options);
  if (!filePath) return false;
  try {
    writeJsonAtomic(filePath, snapshot);
    return true;
  } catch (error) {
    console.warn(`[widget] 写入小组件快照失败: ${error.message}`);
    return false;
  }
}

module.exports = {
  WIDGET_GROUP_ID,
  WIDGET_SCHEMA_VERSION,
  WIDGET_TOP_CLIENTS: 0, // 保留导出以兼容旧测试引用（schema 2 不再使用）
  buildWidgetLimitRow,
  buildWidgetSnapshot,
  widgetSnapshotPath,
  writeWidgetSnapshot
};
