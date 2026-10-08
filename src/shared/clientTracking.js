'use strict';

// Tracked-client CSV helpers. The client list itself lives in clientCatalog.js;
// this module only projects it into the CSV shape that settings, the
// TOKEN_MONITOR_CLIENTS env var and the collector already speak. Those CSV
// values are a compatibility surface — they are persisted in user settings, so
// the derivations below must keep producing the same ids in the same order.
const {
  CLIENT_IDS,
  DEFAULT_CLIENT_IDS
} = require('./clientCatalog');

// Tracked on a fresh install.
const DEFAULT_CLIENTS = DEFAULT_CLIENT_IDS.join(',');

// Every wired client id, including the opt-in ones kept out of DEFAULT_CLIENTS.
// Display-preference normalization (hide/pin/reorder) keys off this list, so an
// opt-in client's prefs survive a round-trip instead of being silently dropped.
const KNOWN_CLIENTS = CLIENT_IDS.join(',');

const LEGACY_CLIENT_ID_ALIASES = Object.freeze({
  kilocode: 'kilo',
  'devin-cli': 'devin',
  'devin-desktop': 'devin',
  micode: 'mimo',
  // dev 分支退役的自采通道 id：旧版把 `minimax` 写进过 settings.clients，
  // 而 tokscale 只认 `mcode`。非法 id 会让整个 --client CSV 被 tokscale
  // 拒绝（exit 2），所有客户端一个 token 都采不到，必须在读取时折算。
  // 只映射 tracked 客户端 CSV，不碰 history.js 的用量 vendor id——
  // 归档里的旧 `minimax` 行仍按原 id 展示（NON_CATALOG_CLIENT_LABELS）。
  minimax: 'mcode'
});

function normalizeTrackedClientId(value) {
  const id = String(value || '').trim().toLowerCase();
  return LEGACY_CLIENT_ID_ALIASES[id] || id;
}

function normalizeClientsCsv(value) {
  const seen = new Set();
  const clients = [];
  for (const part of String(value ?? '').split(',')) {
    const client = normalizeTrackedClientId(part);
    if (!client || seen.has(client)) continue;
    seen.add(client);
    clients.push(client);
  }
  return clients.join(',');
}

function clientsCsvForSetting(value, fallback = DEFAULT_CLIENTS) {
  if (value === undefined || value === null) return normalizeClientsCsv(fallback);
  return normalizeClientsCsv(value);
}

module.exports = {
  DEFAULT_CLIENTS,
  KNOWN_CLIENTS,
  LEGACY_CLIENT_ID_ALIASES,
  clientsCsvForSetting,
  normalizeClientsCsv,
  normalizeTrackedClientId
};
