'use strict';

// MiniMax Code 模型名找回（model recovery）。
//
// 背景：v2 记账表 local_runtime_token_usage 自 2026-08 中旬起 model 列不再
// 落值（MiniMax Code 改版行为），按 turn 聚合的模型维度会全部落到占位名
// 'Pi Agent'。真实模型名仍在同库消息表 local_runtime_message_rows 的
// assistant 消息 data_json.context_usage_telemetry.model 里，且 token 行的
// turn_id 可稳定关联到该 turn 的消息行（实测覆盖率 100%）。
//
// 本模块只做一件事：给定一批 turn_id，返回 turnId → 真实模型名的映射。
// 读取路径与 usage.js 的主读一致：sqlite3 CLI 优先、node:sqlite 兜底；
// 任何失败都静默降级为空映射（保持占位名），绝不影响主读的成败语义。

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

// 消息表通过 data_json 的 JSON 路径携带模型名；LIKE 前置过滤把 json_extract
// 的执行范围压到真正带遥测的行（消息表本身只有数千行，全扫亦在毫秒级）。
const MODEL_SOURCE_TABLE = 'local_runtime_message_rows';
const MODEL_JSON_PATH = '$.context_usage_telemetry.model';
const MODEL_LIKE_FILTER = '%context_usage_telemetry%';
// IN 列表分块：node:sqlite 默认变量上限 999，取 500 留余量；CLI 内联同块。
const TURN_CHUNK_SIZE = 500;
// turn_id 来自 MiniMax 自建库的 UUID，仅允许安全字符集；不匹配者直接跳过
// （防注入：CLI 路径无法参数绑定，内联前必须白名单过滤）。
const SAFE_TURN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 生成分块的找回 SQL：CLI 内联版（cliSql，字面量展开）与 node:sqlite 参数版
 * （paramSql，占位符）。纯函数：不执行任何 IO。
 * @param {string[]} turnIds 已去重、已通过白名单的 turn_id 列表
 * @param {number} chunkIndex 分块下标
 * @returns {{ cliSql: string, paramSql: string, params: string[] } | null} 越界返回 null
 */
function buildRecoveryQuery(turnIds, chunkIndex) {
  const start = chunkIndex * TURN_CHUNK_SIZE;
  if (start >= turnIds.length) return null;
  const chunk = turnIds.slice(start, start + TURN_CHUNK_SIZE);
  const inlineList = chunk.map((id) => `'${id}'`).join(', ');
  const placeholders = chunk.map(() => '?').join(', ');
  const select = `SELECT turn_id AS turnId, MAX(json_extract(data_json, '${MODEL_JSON_PATH}')) AS model
FROM ${MODEL_SOURCE_TABLE}
WHERE data_json LIKE `;
  const inSuffix = (list) => ` AND turn_id IN (${list}) GROUP BY turn_id`;
  return {
    cliSql: `${select}'${MODEL_LIKE_FILTER}'${inSuffix(inlineList)}`,
    paramSql: `${select}?${inSuffix(placeholders)}`,
    params: [MODEL_LIKE_FILTER, ...chunk]
  };
}

/**
 * 解析找回查询结果行，合并进映射。空模型名的行不写入（保持占位名回退）。
 * @param {unknown[]} rows sqlite3 -json / node:sqlite 返回的行
 * @param {Map<string, string>} into 目标映射
 * @returns {Map<string, string>} 传入的映射（便于链式）
 */
function mergeRecoveryRows(rows, into) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const turnId = String(row?.turnId || row?.turn_id || '').trim();
    const model = String(row?.model || '').trim();
    if (turnId && model && !into.has(turnId)) into.set(turnId, model);
  }
  return into;
}

/**
 * 按 turn_id 找回真实模型名。失败（表缺失 / CLI 与 node:sqlite 均不可用 /
 * 超时等）一律返回已收集到的部分映射或空映射——找回是尽力而为的增强，
 * 不改变主读的成败。
 * @param {{ dbPath: string, turnIds: string[], execFile?: Function, requireFn?: Function, logger?: Function }} options
 * @returns {Promise<Map<string, string>>} turnId → 模型名
 */
async function recoverMinimaxModels(options) {
  const into = new Map();
  const rawIds = Array.isArray(options?.turnIds) ? options.turnIds : [];
  // 去重 + 白名单；无有效 id 时直接返回，避免对 v1 库发无效查询。
  const turnIds = [...new Set(rawIds.map((id) => String(id || '').trim()))].filter((id) => SAFE_TURN_ID.test(id));
  if (turnIds.length === 0) return into;
  const run = options.execFile || execFileAsync;
  for (let chunkIndex = 0; ; chunkIndex += 1) {
    const query = buildRecoveryQuery(turnIds, chunkIndex);
    if (!query) break;
    let filled = false;
    try {
      const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', options.dbPath, query.cliSql], {
        encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000, windowsHide: true
      });
      const parsed = JSON.parse(String(result?.stdout || '').trim() || '[]');
      mergeRecoveryRows(parsed, into);
      filled = true;
    } catch (_) { /* CLI 路径失败，交给 node:sqlite 兜底 */ }
    if (!filled) {
      try {
        const requireFn = options.requireFn || require;
        const { DatabaseSync } = requireFn('node:sqlite');
        const database = new DatabaseSync(options.dbPath, { readOnly: true });
        try {
          database.exec('PRAGMA busy_timeout = 250');
          const statement = database.prepare(query.paramSql);
          mergeRecoveryRows([...statement.iterate(...query.params)], into);
        } finally {
          database.close();
        }
      } catch (_) {
        // 兜底也失败：本块放弃，继续后续块（部分找回优于全量失败）。
        if (typeof options.logger === 'function') options.logger('minimax model recovery skipped a chunk');
      }
    }
  }
  return into;
}

module.exports = {
  MODEL_SOURCE_TABLE,
  TURN_CHUNK_SIZE,
  buildRecoveryQuery,
  mergeRecoveryRows,
  recoverMinimaxModels
};
