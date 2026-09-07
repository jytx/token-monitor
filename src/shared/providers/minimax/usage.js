'use strict';

// MiniMax Code（CLI）本地用量适配器。
//
// 数据源是 MiniMax Code 自己的 SQLite 记账库，历史上换过一次布局：
//   v1: ~/.minimax/sqlite.db，表 token_usage（2026-06 ~ 2026-07，已停写）
//   v2: ~/.minimax/v2/sqlite/runtime-state.sqlite，表 local_runtime_token_usage
// 两张表的列名完全一致，所以一套 SQL 按“表名探测”读两个库；v1 保留是为了
// allTime / 历史面板不丢迁移前的用量。
//
// 与 tokscale 的边界：tokscale 上游有意不读 ~/.minimax（共享 Desktop/Runtime
// session store 缺 model/session 标识），只支持 headless 捕获目录；本适配器
// 读的是 token_usage 记账表，model/session 均有，不受该限制。
//
// cost 口径：v2 库的 cost_usd 恒为 0（v1 有真值但口径不一），所以统一不信任
// 库内 cost，改由 collector 侧的 resolveModelPricing 按模型名查价，与 qodercn
// 适配器同一套约定（pricingByModel 由调用方传入）。

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const MINIMAX_V2_DB_RELATIVE = path.join('.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
const MINIMAX_V1_DB_RELATIVE = path.join('.minimax', 'sqlite.db');
// 两代布局各一张表，列名相同；探测到哪张读哪张，探测失败不缓存（下次重试）。
const MINIMAX_USAGE_TABLES = Object.freeze(['local_runtime_token_usage', 'token_usage']);
const MINIMAX_TABLE_PROBE_SQL = `SELECT name FROM sqlite_master
WHERE type = 'table' AND name IN ('local_runtime_token_usage', 'token_usage')
ORDER BY CASE name WHEN 'local_runtime_token_usage' THEN 0 ELSE 1 END
LIMIT 1`;
const MINIMAX_ROW_COLUMNS = `
  rowid AS row_id, session_id, agent_name, framework_type, turn_id, model, ts,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens
`;
// 行身份说明：turn_id 是“轮次”而非消息——v2 里一轮（子代理扇出、工具循环）
// 可挂上百条 token_usage 行，每行都是一次真实的模型调用，必须逐行累计；
// 两张表都是 AUTOINCREMENT，rowid 不复用，是稳定的行主键。
// MiniMax 的 input_tokens 不含 cache_read（raw.total = input + output + cache.read
// 可证），因此各分量直报，不需要 qodercn 那种 prompt 减 cached 的换算。
const MINIMAX_USAGE_SQL_PREFIX = `SELECT ${MINIMAX_ROW_COLUMNS} FROM `;
const MINIMAX_READ_MAX_BYTES = 50 * 1024 * 1024;
const MINIMAX_READ_MAX_ROWS = 200_000;
const MINIMAX_READ_BUDGET_ERROR = 'MINIMAX_READ_BUDGET_EXCEEDED';

const minimaxTableCache = new Map();

function sourceId(value) {
  return createHash('sha256').update(path.normalize(String(value || ''))).digest('hex').slice(0, 12);
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function timestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1e12 ? number * 1000 : number;
}

// 模型名归一化：剥掉 MiniMax 自己写的 `minimax/` 供应商前缀，让展示名与定价
// 查询（tokscale 目录按展示名小写解析）与 qodercn 的 mmodel → 'MiniMax-M3'
// 映射落到同一个键上。v2 库里 framework_type = 'pi-agent' 的行不记模型（连
// raw 里都没有），归到占位名 'Pi Agent'——定价查不到即 cost 0，与库内记账
// 一致（这些行 MiniMax 自己也记 0 成本）。
function normalizeMinimaxModel(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Pi Agent';
  return raw.replace(/^minimax\//i, '');
}

// 定价查询键：还原记账库里的原始带前缀键（minimax/MiniMax-M3）。目录按
// terminal 匹配 minimax-m3 时会撞上多家供应商转发的同名模型（nebius/
// tencent/fireworks…），防串价逻辑保守拒绝；带前缀的键是唯一 exact 命中。
// 展示名不受影响——这只是 resolveModelPricing 的 normalizeModelId 与
// estimatedMinimaxRowCost 共用的查价键。
function minimaxPricingModelKey(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id) return '';
  return id.startsWith('minimax/') ? id : `minimax/${id}`;
}

function minimaxDataPaths(options) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  // 调试/测试逃生口：逗号分隔的显式库路径，完全替换默认发现。
  const explicit = String(env.TOKEN_MONITOR_MINIMAX_DB_PATH || '').trim();
  if (explicit) {
    return {
      dbPaths: explicit.split(',').map((item) => path.resolve(item.trim())).filter(Boolean)
    };
  }
  return {
    dbPaths: [
      path.join(home, MINIMAX_V2_DB_RELATIVE),
      path.join(home, MINIMAX_V1_DB_RELATIVE)
    ]
  };
}

function isReadBudgetError(error) {
  return error?.code === MINIMAX_READ_BUDGET_ERROR
    || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function readBudgetError(kind, limit, cause) {
  const error = new Error(`minimax sqlite read budget exceeded (${kind} limit ${limit})`, cause ? { cause } : undefined);
  error.code = MINIMAX_READ_BUDGET_ERROR;
  return error;
}

function boundedRows(iterable, maxReadRows) {
  const rows = [];
  for (const row of iterable) {
    if (rows.length >= maxReadRows) throw readBudgetError('rows', maxReadRows);
    rows.push(row);
  }
  return rows;
}

async function probeMinimaxUsageTable(dbPath, options) {
  const cached = minimaxTableCache.get(dbPath);
  if (cached) return cached;
  const run = options.execFile || execFileAsync;
  let name = null;
  try {
    const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, MINIMAX_TABLE_PROBE_SQL], {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000, windowsHide: true
    });
    const parsed = JSON.parse(String(result?.stdout || '').trim() || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) name = String(parsed[0].name || '') || null;
  } catch (_) { /* CLI 不可用时交给 node:sqlite；再失败返回 null 下次重试 */ }
  if (!name) {
    try {
      const requireFn = options.requireFn || require;
      const { DatabaseSync } = requireFn('node:sqlite');
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec('PRAGMA busy_timeout = 250');
        const row = database.prepare(MINIMAX_TABLE_PROBE_SQL).get();
        name = row ? String(row.name || '') || null : null;
      } finally {
        database.close();
      }
    } catch (_) {
      return null;
    }
  }
  // 只缓存命中：探测失败的库保持每次重试，避免把瞬态锁当成永久布局。
  if (name && MINIMAX_USAGE_TABLES.includes(name)) {
    minimaxTableCache.set(dbPath, name);
    return name;
  }
  return null;
}

async function readMinimaxDbRows(dbPath, options) {
  const table = await probeMinimaxUsageTable(dbPath, options);
  if (!table) return [];
  const sinceMs = options.sinceMs;
  const maxReadBytes = options.maxReadBytes || MINIMAX_READ_MAX_BYTES;
  const maxReadRows = options.maxReadRows || MINIMAX_READ_MAX_ROWS;
  const sql = sinceMs
    ? `${MINIMAX_USAGE_SQL_PREFIX}${table} WHERE ts >= ? ORDER BY ts, rowid`
    : `${MINIMAX_USAGE_SQL_PREFIX}${table} ORDER BY ts, rowid`;
  const run = options.execFile || execFileAsync;
  // sqlite3 CLI 一次只接一条 SQL，占位符在参数侧展开（ts 是 INTEGER 毫秒值，
  // 无注入面；与 qodercn 适配器同一做法）。
  const cliSql = sinceMs ? sql.replace('?', String(sinceMs)) : sql;
  try {
    const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, cliSql], {
      encoding: 'utf8', maxBuffer: maxReadBytes, timeout: 30_000, windowsHide: true
    });
    const stdout = String(result?.stdout || '').trim();
    if (Buffer.byteLength(stdout, 'utf8') > maxReadBytes) throw readBudgetError('bytes', maxReadBytes);
    const parsed = JSON.parse(stdout || '[]');
    return boundedRows(Array.isArray(parsed) ? parsed : [], maxReadRows);
  } catch (cliError) {
    if (isReadBudgetError(cliError)) {
      if (typeof options.logger === 'function') options.logger(cliError.message);
      throw cliError;
    }
    try {
      const requireFn = options.requireFn || require;
      const { DatabaseSync } = requireFn('node:sqlite');
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec('PRAGMA busy_timeout = 250');
        const statement = database.prepare(sql);
        const iterator = sinceMs ? statement.iterate(sinceMs) : statement.iterate();
        return boundedRows(iterator, maxReadRows);
      } finally {
        database.close();
      }
    } catch (nodeError) {
      if (isReadBudgetError(nodeError)) {
        if (typeof options.logger === 'function') options.logger(nodeError.message);
        throw nodeError;
      }
      // 读失败要响亮地抛出去：collector 会保留上一份完整快照而不是把用量清零。
      const message = `minimax sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}`;
      if (typeof options.logger === 'function') options.logger(message);
      throw new Error(message, { cause: nodeError });
    }
  }
}

function normalizeMinimaxDbRow(row, source) {
  const input = numeric(row?.input_tokens);
  const output = numeric(row?.output_tokens);
  const reasoning = numeric(row?.reasoning_tokens);
  const cacheRead = numeric(row?.cache_read_tokens);
  const cacheWrite = numeric(row?.cache_write_tokens);
  if (input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null) return null;
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return null;
  const session = String(row?.session_id || '');
  const rowKey = String(row?.row_id || '');
  if (!session || !rowKey) return null;
  return {
    sessionId: `minimax:${source}:${session}`,
    messageId: `minimax:${source}:${session}:${rowKey}`,
    model: normalizeMinimaxModel(row?.model),
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    createdAt: timestampMs(row?.ts),
    messages: 1
  };
}

async function collectMinimaxRows(options) {
  const paths = minimaxDataPaths(options);
  const dbPaths = Array.isArray(options.dbPaths) ? options.dbPaths : paths.dbPaths;
  const rows = [];
  for (const dbPath of dbPaths) {
    if (!options.readDbRows && !fs.existsSync(dbPath)) continue;
    const source = sourceId(dbPath);
    const dbRows = await readMinimaxDbRows(dbPath, { ...options, dbPaths: undefined });
    for (const dbRow of dbRows) {
      const row = normalizeMinimaxDbRow(dbRow, source);
      if (row) rows.push(row);
    }
  }
  // 跨库理论上无重叠（迁移切库即停写旧库），按 messageId 去重兜底。
  const unique = new Map();
  for (const row of rows) unique.set(row.messageId, row);
  return [...unique.values()];
}

// 定价由调用方通过 pricingByModel 注入（collector 的 resolveModelPricing，
// 键为模型名小写）。查不到价的行记 0，与“成本不可用”而非“成本为零”的
// 既有展示口径一致。
function estimatedMinimaxRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[minimaxPricingModelKey(row?.model)];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function buildTokscaleJson(startMs, rows, pricingByModel, includeUndated) {
  const grouped = new Map();
  for (const row of rows) {
    // ts 为 NOT NULL，但防御性保留 qodercn 的口径：无时间戳的行只进 allTime。
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) grouped.set(key, { ...row, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, messages: 0, startedAt: 0, lastUsedAt: 0, cost: 0 });
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.reasoning += row.reasoning;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    const cost = estimatedMinimaxRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }
  const entries = [...grouped.values()].map((row) => ({
    client: 'minimax', mergedClients: null, sessionId: row.sessionId, model: row.model, provider: 'minimax',
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    reasoning: row.reasoning, messageCount: row.messages, cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    projectLabel: '', performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model', entries,
    totalInput: sum('input'), totalOutput: sum('output'), totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'), totalMessages: sum('messageCount'), totalCost: sum('cost'), processingTimeMs: 0
  };
}

function buildMinimaxPeriods(options) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const pricingByModel = options.pricingByModel;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const allTimeSinceMs = timestampMs(options.allTimeSince);
  return {
    today: buildTokscaleJson(todayStart, rows, pricingByModel, false),
    month: buildTokscaleJson(monthStart, rows, pricingByModel, false),
    allTime: buildTokscaleJson(allTimeSinceMs, rows, pricingByModel, true)
  };
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildMinimaxHistoryGraph(options) {
  const days = new Map();
  for (const row of options.rows || []) {
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = { client: 'minimax', modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    const cost = estimatedMinimaxRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.tokens.reasoning += row.reasoning;
    model.cost += cost === null ? 0 : cost;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  MINIMAX_USAGE_TABLES,
  buildMinimaxHistoryGraph,
  buildMinimaxPeriods,
  collectMinimaxRows,
  estimatedMinimaxRowCost,
  minimaxDataPaths,
  minimaxPricingModelKey,
  normalizeMinimaxModel,
  readMinimaxDbRows,
  resetMinimaxTableProbe() { minimaxTableCache.clear(); }
};
