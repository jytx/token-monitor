'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../../sqliteReadOnly');
const { zcodeDataBaseDir } = require('../zai/zcodeDiscovery');

// ZCode 的会话标题只写在 CLI 自己的 SQLite 库里（<base>/.zcode/cli/db/
// db.sqlite 的 session.title）：tokscale 扫 ~/.zcode/projects 的 JSONL 产出
// usage 时不读这张表，因此扫描输出的 sessions 元数据只有 client/sessionId 与
// 活跃时间、没有 title，会话行只能退回显示 session id。这里按 tokscale 给出
// 的 session id 直查该库补齐标题，与 cursor/antigravity 读取本地库标题同构。
// 同一张表还写着父子关系（session.parent_id），tokscale 同样不输出，于是
// subagent 与工作流子会话只能平铺；子任务类型一并读出，让它们折进发起它们
// 的交互会话，与 Codex/Claude 的行列一致。
//
// 数据基目录沿用 limits 发现同一条解析链（env ZCODE_DATA_BASE_DIR → HOME →
// homedir，见 zcodeDataBaseDir）：重定向安装下读到的正是 ZCode 自己写的库，
// 而 tokscale 扫描同一路径，两边的 session id 天然对齐。WSL 作用域下 env 置空，
// 与 antigravity 一致——宿主的环境变量不得把查找引向别的 distro。

// 延迟加载：未追踪 zcode 的收集器不应因导入本模块而触发 node:sqlite 的实验性警告
let defaultSqlite;
function resolveSqlite(deps = {}) {
  if (deps?.sqlite !== undefined) return deps.sqlite;
  if (defaultSqlite === undefined) {
    try { defaultSqlite = require('node:sqlite'); } catch (_) { defaultSqlite = null; }
  }
  return defaultSqlite;
}

const TITLE_MAX_CODE_POINTS = 96;

// 工具与工作流派生的子会话：它们的 usage 折叠进发起它们的交互会话行。
// fork 和 selection_side_chat 同带 parent_id，但是用户主动发起的对话，
// 标题已自描述，保持独立行。
const SUBAGENT_TASK_TYPES = new Set(['subagent_child', 'workflow_child']);

// 模块级存活：跨采集 tick 保留，空闲会话不必反复开库
const titleCache = new Map();

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? chars.join('')
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

function zcodeDatabasePath(context = {}) {
  const home = context.home || os.homedir();
  const env = context.deps?.scopedHome ? {} : (context.deps?.env || process.env);
  return path.join(zcodeDataBaseDir(env, home), '.zcode', 'cli', 'db', 'db.sqlite');
}

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

// 主库加 -wal：ZCode 运行时的新标题先落 WAL，只按主库的指纹会漏掉它们
function databaseStamp(dbPath) {
  const main = fileStamp(dbPath);
  return main ? `${main}|${fileStamp(`${dbPath}-wal`)}` : '';
}

// 每个 id 一次主键等值查询，而不是一条 IN 列表：既避开老版本 SQLite 的
// 宿主参数上限，也让"库存在但这行还没有"成为一个可缓存的确定答案。
// 返回值区分三种结局——supported:false 表示这张表没有标题列（确定），
// null 表示打开或查询失败（瞬时，整批下 tick 重试）。
function readTitles(dbPath, sqlite, wantedIds) {
  let db;
  try {
    db = openDb(dbPath, sqlite);
    const columns = new Set(
      db.prepare('PRAGMA table_info(session)').all().map((column) => String(column.name))
    );
    if (!columns.has('id') || !columns.has('title')) return { supported: false, rows: new Map(), misses: new Set() };
    // task_type 与 parent_id 决定这条会话是否折进父会话：只有工具/工作流
    // 派生的子会话（subagent_child、workflow_child）折叠，用户主动分叉的
    // fork 和侧聊 selection_side_chat 保持独立行——它们的标题已自描述，
    // 折进去会把用户可寻址的会话藏起来。列缺失时按无父子关系处理。
    const selectParent = columns.has('parent_id') && columns.has('task_type');
    const statement = db.prepare(
      selectParent
        ? 'SELECT title, task_type, parent_id FROM session WHERE id = ?'
        : 'SELECT title FROM session WHERE id = ?'
    );
    const rows = new Map();
    const misses = new Set();
    for (const id of wantedIds) {
      const row = statement.get(id);
      if (row === undefined) { misses.add(id); continue; }
      const parentSessionId = selectParent && SUBAGENT_TASK_TYPES.has(String(row.task_type || ''))
        ? String(row.parent_id || '').trim()
        : '';
      rows.set(id, {
        title: cleanTitle(row.title),
        parentSessionId: parentSessionId && parentSessionId !== id ? parentSessionId : ''
      });
    }
    return { supported: true, rows, misses };
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* 读取失败不能中断采集 */ }
  }
}

function resolveSessionMetadata(sessionIds, context = {}) {
  const result = new Map();
  const sqlite = resolveSqlite(context.deps);
  if (typeof sqlite?.DatabaseSync !== 'function') return result;
  const dbPath = zcodeDatabasePath(context);
  const stamp = databaseStamp(dbPath);
  if (!stamp) return result;
  const cache = context.deps?.zcodeTitleCache || titleCache;
  let cached = cache.get(dbPath);
  // 指纹变化即全量重查：标题是可变事实（用户可重命名），保留旧值会让
  // 改名永不生效，代价只是每 tick 对可见 id 各一次主键查询
  if (cached?.stamp !== stamp) {
    cached = { stamp, rows: new Map(), misses: new Set(), supported: null };
  }
  if (cached.supported !== false) {
    // 行存在即定论（标题可空、父子关系可选）；只有"库里没有这一行"
    // 和瞬时读取失败留给下一次查询
    const wanted = [...sessionIds].filter((id) => !cached.rows.has(id) && !cached.misses.has(id));
    if (wanted.length > 0) {
      const read = readTitles(dbPath, sqlite, wanted);
      if (read) {
        cached.supported = read.supported;
        for (const [id, row] of read.rows) cached.rows.set(id, row);
        for (const id of read.misses) cached.misses.add(id);
      }
    }
  }
  cache.set(dbPath, cached);
  for (const sessionId of sessionIds) {
    const row = cached.rows.get(sessionId);
    if (!row) continue;
    const meta = {};
    if (row.title) meta.title = row.title;
    if (row.parentSessionId) meta.parentSessionId = row.parentSessionId;
    if (Object.keys(meta).length > 0) result.set(sessionId, meta);
  }
  return result;
}

module.exports = { cleanTitle, readTitles, resolveSessionMetadata, zcodeDatabasePath };
