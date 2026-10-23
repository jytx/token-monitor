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
    if (!columns.has('id') || !columns.has('title')) return { supported: false, titles: new Map(), misses: new Set() };
    const statement = db.prepare('SELECT title FROM session WHERE id = ?');
    const titles = new Map();
    const misses = new Set();
    for (const id of wantedIds) {
      const row = statement.get(id);
      const title = cleanTitle(row?.title);
      if (title) titles.set(id, title);
      else misses.add(id);
    }
    return { supported: true, titles, misses };
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
    cached = { stamp, titles: new Map(), misses: new Set(), supported: null };
  }
  if (cached.supported !== false) {
    const wanted = [...sessionIds].filter((id) => !cached.titles.has(id) && !cached.misses.has(id));
    if (wanted.length > 0) {
      const read = readTitles(dbPath, sqlite, wanted);
      if (read) {
        cached.supported = read.supported;
        for (const [id, title] of read.titles) cached.titles.set(id, title);
        for (const id of read.misses) cached.misses.add(id);
      }
    }
  }
  cache.set(dbPath, cached);
  for (const sessionId of sessionIds) {
    const title = cached.titles.get(sessionId);
    if (title) result.set(sessionId, { title });
  }
  return result;
}

module.exports = { cleanTitle, readTitles, resolveSessionMetadata, zcodeDatabasePath };
