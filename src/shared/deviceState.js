'use strict';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const PARTIAL_USAGE_CARRY_FIELDS = Object.freeze([
  'month',
  'allTime',
  'clientStatus',
  'clientHealth',
  'wslStatus',
  'periodWindows',
  'projectsEnabled',
  'allTimeProjectsOmitted',
  'allTimeProjectsIncomplete',
  'sessionDetailsOmitted',
  'periodProjectsOmitted',
  'syncUploadIntervalMs'
]);

function cloneValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(cloneValue(entry, seen));
    return copy;
  }
  const copy = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry, seen);
  return copy;
}

function normalizedEnvelope(value) {
  const envelope = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry !== undefined) envelope[key] = cloneValue(entry);
  }
  return envelope;
}

function mergeUsagePart(previous, incoming) {
  const next = cloneValue(incoming || {});
  delete next.limits;
  if (!previous) return next;

  if (!hasOwn(next, 'history') && hasOwn(previous, 'history')) {
    next.history = cloneValue(previous.history);
  }

  const partial = !hasOwn(next, 'month') || !hasOwn(next, 'allTime');
  if (partial) {
    for (const field of PARTIAL_USAGE_CARRY_FIELDS) {
      if (!hasOwn(next, field) && hasOwn(previous, field)) {
        next[field] = cloneValue(previous[field]);
      }
    }
  }
  return next;
}

function createDeviceState(options = {}) {
  const epoch = options.epoch ?? 0;
  const envelope = normalizedEnvelope(options.envelope);
  const onRecord = typeof options.onRecord === 'function' ? options.onRecord : null;
  let usagePart = null;
  let limitsPart = hasOwn(options, 'initialLimits') ? cloneValue(options.initialLimits) : undefined;
  let currentRecord = null;
  let hasCompleteUsageBaseline = false;
  let revision = 0;
  let stopped = false;

  function accepts(meta) {
    if (stopped) return false;
    return !hasOwn(meta, 'epoch') || meta.epoch === epoch;
  }

  function publish(source, reason) {
    if (stopped) return null;
    // 原本这里 `if (!usagePart) return null` 会把 limits 数据挡在门外——collector
    // 首次 full scan 完成前（usagePart 还没填），limits fetch 早就回来了也推不出去，
    // 用户点开 tray 弹窗只能看到空白，必须等到下一次 interval refresh 才能看到额度。
    // 放开后：usage 没就绪时也能把 limits 推出去，让 renderer 立即填回额度行；
    // usage 一就绪就在下一次 publish 里把整张 record 补齐，行为不变。
    const baseRecord = usagePart
      ? { ...cloneValue(usagePart), ...cloneValue(envelope) }
      : { ...cloneValue(envelope) };
    if (limitsPart !== undefined) baseRecord.limits = cloneValue(limitsPart);
    currentRecord = baseRecord;
    revision += 1;
    const meta = { revision, source, reason, epoch };
    if (onRecord) onRecord(cloneValue(baseRecord), meta);
    return cloneValue(baseRecord);
  }

  function updateUsage(summary, reason = 'usage', meta = {}) {
    if (!accepts(meta)) return null;
    usagePart = mergeUsagePart(usagePart, summary);
    if (hasOwn(usagePart, 'month') && hasOwn(usagePart, 'allTime')) {
      hasCompleteUsageBaseline = true;
    }
    if (meta.preview === true && !hasCompleteUsageBaseline) return null;
    return publish('usage', reason);
  }

  function updateLimits(limits, reason = 'limits', meta = {}) {
    if (!accepts(meta)) return null;
    limitsPart = cloneValue(limits);
    return publish('limits', reason);
  }

  function getSnapshot() {
    return currentRecord ? cloneValue(currentRecord) : null;
  }

  function stop() {
    stopped = true;
  }

  return {
    getSnapshot,
    stop,
    updateLimits,
    updateUsage
  };
}

module.exports = {
  createDeviceState
};
