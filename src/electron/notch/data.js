'use strict';

const trayLayout = require('../../shared/trayLayout');
const trayText = require('../../shared/trayText');
const balance = require('../../shared/limits/balanceDisplay');
const { limitProviderForClient } = require('../../shared/limits/providers');
const presentation = require('../renderer/edgeDock/presentation');

// Ordinary tray presets select canonical provider/account pairs before layout.
// Custom layouts continue to use their own source selectors unchanged.
function trayQuotaPicks(stats, settings) {
  if (settings.notchFollowTray === false) return null;
  const mode = settings.trayContent;
  if (mode === 'limitsAllSessions' || mode === 'barsAllSessions') return trayText.pickConfiguredLimitProviders(stats, settings);
  const pick = mode === 'barsSession' ? trayText.pickLimitProviderByKindPriority(stats, ['session', 'weekly'])
    : mode === 'barsWeekly' ? trayText.pickWorstLimitProvider(stats, { kind: 'weekly' })
      : mode === 'bars' ? trayText.pickWorstLimitProvider(stats) : undefined;
  return pick === undefined ? null : pick ? [pick] : [];
}

// 同一供应商的多条 legacy 记录（无 accountKey）同时入选 picks 时，
// (provider, '') 区分不开两条 source，resolve 阶段会都落到 remaining
// 最低的那条记录上。这里为每条 pick 生成仅存在于刘海解析输入中的合成
// accountKey（不进 wire、不进存储），让每条 source 精确绑回自己的记录；
// 有真实 accountKey 或每供应商仅一条 pick 时保持原样。
function notchPickKeys(picks) {
  const totals = new Map();
  for (const pick of picks) totals.set(pick.provider, (totals.get(pick.provider) || 0) + 1);
  const seen = new Map();
  return picks.map((pick) => {
    if (pick.providerRecord.accountKey) return pick.providerRecord.accountKey;
    if ((totals.get(pick.provider) || 0) <= 1) return '';
    const index = (seen.get(pick.provider) || 0) + 1;
    seen.set(pick.provider, index);
    return `notch-pick-${pick.provider}-${index}`;
  });
}

// 合成 key 只注入解析用的浅拷贝记录，原记录保持只读。
function notchPickRecord(pick, key) {
  return key && !pick.providerRecord.accountKey ? { ...pick.providerRecord, accountKey: key } : pick.providerRecord;
}

function summaryLayout(settings, stats, picks = trayQuotaPicks(stats, settings)) {
  if (settings.notchFollowTray === false) return trayLayout.normalizeTrayLayout(settings.notchCustomLayout);
  const mode = settings.trayContent || 'tokens';
  if (mode === 'custom') return trayLayout.normalizeTrayLayout(settings.trayCustomLayout);
  const make = (style, id) => trayLayout.createTrayLayoutItem(style, { idFactory: () => id });
  const icon = make(['icon', 'liveTokenRate'].includes(mode) ? 'appIcon' : 'providerIcon', 'notch-icon');
  icon.autoMode = ['tokens', 'tokensAll', 'both', 'bothAll'].includes(mode) ? 'tokens'
    : ['cost', 'costAll'].includes(mode) ? 'cost' : 'lowestLimit';
  icon.period = mode.endsWith('All') ? 'allTime' : 'today';
  const items = [icon];
  const period = mode.endsWith('All') ? 'allTime' : 'today';
  if (['tokens', 'tokensAll', 'both', 'bothAll'].includes(mode)) items.push({ ...make('tokens', 'notch-tokens'), period });
  if (['cost', 'costAll', 'both', 'bothAll'].includes(mode)) items.push({ ...make('cost', 'notch-cost'), period, costFormat: 'full', costDecimals: 'auto' });
  if (mode === 'liveTokenRate') items.push(make('liveTokenRate', 'notch-rate'));
  if (picks) {
    if (picks.length) icon.source.provider = picks[0].provider;
    const keys = notchPickKeys(picks);
    const pair = picks.length > 1
      ? picks.map((pick, index) => ({ pick, key: keys[index], window: pick.primaryWindow }))
      : picks.length ? [{ pick: picks[0], key: keys[0], window: picks[0].primaryWindow }, { pick: picks[0], key: keys[0], window: picks[0].secondaryWindow }] : [];
    const sourceFor = ({ pick, key, window }) => ({
      provider: pick.provider, accountMode: 'specific', accountKey: pick.providerRecord.accountKey || key,
      window: window ? trayLayout.windowKey(window) : 'secondary',
      valueMode: settings.showLimitUsed ? 'used' : 'remaining', creditsDisplay: 'percent'
    });
    if (mode === 'limitsAllSessions') {
      for (const [i, entry] of pair.filter(entry => entry.window).entries()) {
        items.push({ ...make('percent', `notch-limit-${i}`), source: sourceFor(entry) });
      }
    } else if (pair.length) {
      items.push({ ...make('doubleBar', 'notch-limits'), rows: pair.map(sourceFor) });
    } else {
      // The original bar preset falls back to today's tokens without quotas.
      items.push(make('tokens', 'notch-tokens'));
    }
  }
  return { version: trayLayout.VERSION, items };
}

// Numeric facts beside the existing tray-formatted string. Animation never
// reverse-parses localized compact text, currencies or provider labels.
function numericMeasure(item, resolved, stats) {
  if (!resolved.available) return null;
  if (item.metric === 'tokens' || item.metric === 'cost') {
    const period = stats?.periods?.[item.period];
    if (!period) return null;
    const provider = item.usageScope === 'recent' ? trayText.pickRecentUsageProviderId(stats) : null;
    const value = provider ? (item.metric === 'tokens' ? period.clients?.[provider] : period.clientCosts?.[provider])
      : (item.metric === 'tokens' ? period.totalTokens : period.costUsd);
    return value != null && Number.isFinite(Number(value)) ? { metric: item.metric, value: Number(value), costFormat: item.costFormat, costDecimals: item.costDecimals } : null;
  }
  if (item.metric === 'liveTokenRate') {
    const value = resolved.liveTokenRate?.[item.rateMode];
    return Number.isFinite(value) ? { metric: 'rate', value, rateMode: item.rateMode } : null;
  }
  if (item.metric === 'percent') {
    const selection = resolved.selection;
    if (!selection) return null;
    if (selection.moneyText && selection.source?.creditsDisplay !== 'percent') {
      return { metric: 'balance', value: balance.creditsAmount(selection.providerRecord, selection.window), currency: balance.creditsCurrency(selection.providerRecord, selection.window) };
    }
    return { metric: 'percent', value: selection.percent };
  }
  return null;
}

// The shared formatter remains the source of countdown strings. Keep the
// static headline separate so a local clock never parses a numeric reading.
function attachSummaryClock(row, metric, nowMs) {
  if (!['reset', 'percentReset'].includes(metric) || !row.selection) return;
  const resetsAt = row.selection.window.resetsAt;
  const countdown = trayLayout.formatResetCountdown(resetsAt, nowMs);
  const suffix = countdown ? ` · ${countdown}` : '';
  row.clock = { resetsAt, headline: metric === 'percentReset' ? (suffix && row.text.endsWith(suffix) ? row.text.slice(0, -suffix.length) : row.text) : '' };
}

function buildNotchData(stats, cells, settings, options = {}) {
  if (settings.notchSummaryEnabled === false) return { cells, summary: null };
  const picks = trayQuotaPicks(stats, settings);
  const layout = summaryLayout(settings, stats, picks);
  // Preserve the selected record even for legacy accounts without accountKey:
  // reselecting all records can borrow a secondary window from another account.
  // Same-provider legacy duplicates additionally need the synthetic keys so
  // each source resolves to exactly its own record.
  const pickKeys = notchPickKeys(picks || []);
  const summaryStats = picks ? { ...stats, limits: { ...stats?.limits, providers: picks.map((pick, index) => notchPickRecord(pick, pickKeys[index])) } } : stats;
  const resolved = trayLayout.resolveTrayLayout(layout, summaryStats, options);
  resolved.needsClock = trayLayout.trayLayoutNeedsClock(layout);
  for (const output of resolved.items) {
    if (['bars', 'stack'].includes(output.type) && output.icon !== 'none') {
      output.iconProvider = output.icon === 'app' ? 'app' : trayLayout.preferredRowProvider(output.rows, output.icon === 'second' ? 1 : 0) || '?';
    }
  }
  const iconProviders = [...new Set(resolved.items.map(item => item.type === 'icon' ? item.provider : item.iconProvider)
    .filter(provider => provider && provider !== 'app').map(provider => limitProviderForClient(provider) || provider))];
  const missingIconProviders = iconProviders.filter(provider => !cells.some(cell => cell.provider === provider));
  const iconCells = missingIconProviders.length ? presentation.buildEdgeDockCells(stats, {
    ...settings, localDeviceId: settings.deviceId, ...(options.cellOptions || {}),
    items: missingIconProviders.map((provider) => ({ type: 'limit', provider }))
  }) : [];
  for (let i = 0; i < resolved.items.length; i += 1) {
    const item = layout.items[i];
    const output = resolved.items[i];
    output.measure = numericMeasure(item, output, stats);
    attachSummaryClock(output, item.metric, options.nowMs);
    const iconProvider = output.type === 'icon' ? output.provider : output.iconProvider;
    if (iconProvider && iconProvider !== 'app') {
      const provider = limitProviderForClient(iconProvider) || iconProvider;
      // Reuse a configured headline first. A standalone icon uses the same
      // provider projection, independent of whether either dock is enabled.
      const cell = cells.find((entry) => entry.provider === provider) || iconCells.find((entry) => entry.provider === provider);
      if (cell && settings.limitsEnabled !== false && Array.isArray(stats?.limits?.providers) && stats.limits.providers.some((record) => record.provider === provider)) output.providerCell = cell;
    }
    if (item.type === 'stack') {
      for (let j = 0; j < output.rows.length; j += 1) {
        const source = item.rows?.[j] || {};
        const metric = item.metric === 'mixed' ? source.metric : item.metric;
        output.rows[j].metric = metric;
        output.rows[j].measure = numericMeasure({ ...source, metric }, output.rows[j], stats);
        attachSummaryClock(output.rows[j], metric, options.nowMs);
      }
    }
  }
  return {
    cells,
    // An explicitly empty custom layout reuses the idle shell and hover target.
    summary: resolved.items.length ? resolved : null
  };
}
module.exports = { buildNotchData, summaryLayout };
