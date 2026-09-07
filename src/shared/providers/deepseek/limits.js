'use strict';

// DeepSeek 余额采集（多账号）。
//
// DeepSeek 没有限流窗口，唯一的配额就是预付余额，以 credits 窗口上报
//（钱，无 wire 百分比）。多账号与单账号兼容路径共存：
// options.deepseekManagedAccounts 非空时逐账号探测返回多行，为空时走旧
// 单 key/env 路径（headless agent 不受影响）。
//
// 消费记录（todaySpend 等）由同目录 balanceHistory 按账号分键存储，
// accountKey = hashKey('deepseek', key) 与单账号时代一致，多账号天然
// 隔离、迁移后历史连续。Reached through providerFetchers() in
// src/shared/limits/collector.js.

const path = require('node:path');
const { recordConsumption } = require('./balanceHistory');
const { sharedDataDir } = require('../../config');
const { normalizeLimitProvider } = require('../../limits/core');
const {
  apiKeyAccountDisplayLabel,
  cleanApiKeySecret,
  managedApiKeyAccountKey,
  scopedApiKeyManagedAccounts
} = require('../../apiKeyAccounts');
const {
  errorWithStatus,
  fetchJson,
  nowIso,
  providerStatusFromError
} = require('../../limits/providerHelpers');

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const DEEPSEEK_KEY_NAMES = ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'];

function deepseekToken(env = process.env, explicitKey = '') {
  const explicit = cleanApiKeySecret(explicitKey);
  if (explicit) return explicit;
  for (const name of DEEPSEEK_KEY_NAMES) {
    const raw = cleanApiKeySecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

// rows: balance_infos from /user/balance. Returns { currency, amount(total), paid(topped_up) }.
function selectFundedRow(rows) {
  const parsed = [];
  for (const row of rows || []) {
    const amount = Number(row && row.total_balance);
    const paid = Number(row && row.topped_up_balance);
    const currency = String((row && row.currency) || '').trim().toUpperCase();
    if (!Number.isFinite(amount) || !Number.isFinite(paid) || !currency) continue;
    parsed.push({ currency, amount, paid });
  }
  if (parsed.length === 0) throw errorWithStatus('unavailable', 'no usable balance rows');
  const funded = parsed
    .filter((r) => r.amount > 0)
    .sort((a, b) => (b.amount - a.amount) || (a.currency === 'USD' ? -1 : b.currency === 'USD' ? 1 : 0));
  if (funded.length) return funded[0];
  return parsed.find((r) => r.currency === 'USD') || parsed[0];
}

// 账号级状态行：多账号路径的失败/未配置行必须携带账号身份，否则
// limitsRuntime 会把不同账号的失败行全部落到 provider 通配 identity 上
// 互相覆盖（rowIdentityKey 优先取 accountKey）。
function deepseekStatusProvider(status, updatedAt, account) {
  return normalizeLimitProvider({
    provider: 'deepseek',
    source: 'api',
    status,
    updatedAt,
    accountKey: account?.accountKey || '',
    accountLabel: account ? apiKeyAccountDisplayLabel(account) : '',
    windows: []
  });
}

// 探测单个 DeepSeek 密钥。account 为 null 表示单账号兼容路径（旧
// settings.deepseekApiKey 或 env 密钥），保持历史行为——错误行不带账号
// 身份、标签为 'Pay-as-you-go' 套餐名。
async function probeDeepSeekAccountKey(key, account, deps) {
  const now = (deps.now || Date.now)();
  try {
    // 共享 fetchJson 的默认映射与 DeepSeek 预期一致：401 → unauthorized，
    // 403 保持 unavailable（DeepSeek 的 403 不是凭据错误），429 → sourceRateLimited。
    const data = await fetchJson(DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, deps);
    if (!data || !Array.isArray(data.balance_infos)) {
      throw errorWithStatus('unavailable', 'unexpected balance response shape');
    }
    const row = selectFundedRow(data.balance_infos);
    const accountKey = account ? account.accountKey : managedApiKeyAccountKey('deepseek', key);
    const dataDir = sharedDataDir({ env: deps.env || process.env });
    const storePath = deps.deepseekStorePath || path.join(dataDir, 'deepseek-balance-v2.json');
    const legacyStorePath = deps.deepseekLegacyStorePath
      || (deps.deepseekStorePath ? null : path.join(dataDir, 'deepseek-balance.json'));
    const spend = recordConsumption(
      { accountKey, currency: row.currency, paid: row.paid, now, storePath, legacyStorePath },
      deps
    );
    return normalizeLimitProvider({
      provider: 'deepseek',
      accountKey,
      accountLabel: account
        ? apiKeyAccountDisplayLabel(account) || 'Pay-as-you-go'
        : 'Pay-as-you-go',
      source: 'api',
      status: 'ok',
      updatedAt: nowIso(now),
      // DeepSeek has no rate-limit windows. The balance is the only quota it
      // exposes, so it ships as a credits window: money, no wire percentage.
      windows: [{
        kind: 'billing',
        metric: 'credits',
        label: 'Balance',
        remaining: row.amount,
        currency: row.currency
      }],
      balance: {
        amount: row.amount,
        currency: row.currency,
        todaySpend: spend.todaySpend,
        weekSpend: spend.weekSpend,
        monthSpend: spend.monthSpend,
        allTimeSpend: spend.allTimeSpend,
        trackingSince: spend.trackingSince,
        monthSinceTracking: spend.monthSinceTracking
      }
    });
  } catch (error) {
    return deepseekStatusProvider(providerStatusFromError(error), nowIso(now), account);
  }
}

async function fetchDeepSeekLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const scope = options.limitRefreshScope?.provider === 'deepseek'
    ? options.limitRefreshScope
    : null;
  const accounts = scopedApiKeyManagedAccounts('deepseek', options.deepseekManagedAccounts, scope);
  if (accounts.length > 0) {
    return Promise.all(accounts.map(
      (account) => probeDeepSeekAccountKey(account.apiKey, account, deps)
    ));
  }
  // 单账号兼容路径：GUI 迁移前的 settings.deepseekApiKey 或 env 密钥
  //（headless agent 仍走这里），行为与多账号改造前完全一致。
  const key = deepseekToken(env, options.deepseekApiKey);
  if (!key) {
    return deepseekStatusProvider('notConfigured', nowIso((deps.now || Date.now)()), null);
  }
  return probeDeepSeekAccountKey(key, null, deps);
}

module.exports = {
  DEEPSEEK_BALANCE_URL,
  DEEPSEEK_KEY_NAMES,
  deepseekToken,
  fetchDeepSeekLimits,
  probeDeepSeekAccountKey,
  selectFundedRow
};
