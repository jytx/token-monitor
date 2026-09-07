#!/usr/bin/env bash
# 停止 Token Monitor Electron 桌面挂件
# 用法: ./scripts/stop.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG_DIR="$PROJECT_ROOT/logs"
PID_FILE="$LOG_DIR/token-monitor.pid"

# 通过 PID 文件拿 npm 父进程；如果文件缺失就只按进程名兜底查找 Electron 主进程
NPM_PID=""
if [[ -f "$PID_FILE" ]]; then
  NPM_PID="$(cat "$PID_FILE")"
fi

# 找所有相关进程：npm 父进程 + Electron 主进程 + GPU/网络/渲染器 helper
ALL_PIDS=""
if [[ -n "$NPM_PID" ]] && kill -0 "$NPM_PID" 2>/dev/null; then
  ALL_PIDS="$NPM_PID"
fi
ELECTRON_PIDS="$(pgrep -f 'token-monitor/node_modules/electron' || true)"
if [[ -n "$ELECTRON_PIDS" ]]; then
  if [[ -n "$ALL_PIDS" ]]; then
    ALL_PIDS="$ALL_PIDS
$ELECTRON_PIDS"
  else
    ALL_PIDS="$ELECTRON_PIDS"
  fi
fi

if [[ -z "$ALL_PIDS" ]]; then
  echo "[stop] 未发现运行中的 Token Monitor 进程"
  rm -f "$PID_FILE"
  exit 0
fi

echo "[stop] 发现进程: $ALL_PIDS"
echo "[stop] 先发送 SIGTERM（触发 Electron 优雅退出）..."
for PID in $ALL_PIDS; do
  kill -TERM "$PID" 2>/dev/null || true
done

# 等 5 秒让 Electron 优雅退出（SIGTERM 路径）
GRACE_SECONDS=5
for _ in $(seq 1 "$GRACE_SECONDS"); do
  STILL_RUNNING=""
  for PID in $ALL_PIDS; do
    if kill -0 "$PID" 2>/dev/null; then
      STILL_RUNNING="$STILL_RUNNING $PID"
    fi
  done
  if [[ -z "$STILL_RUNNING" ]]; then
    break
  fi
  sleep 1
done

if [[ -n "$STILL_RUNNING" ]]; then
  echo "[stop] 进程未在 ${GRACE_SECONDS}s 内退出，强杀:$STILL_RUNNING"
  for PID in $STILL_RUNNING; do
    kill -9 "$PID" 2>/dev/null || true
  done
fi

# 兜底：再扫一遍项目相关的 Electron 进程（处理 npm 中间层未传递信号的情况）
REMAINING="$(pgrep -f 'token-monitor/node_modules/electron' || true)"
if [[ -n "$REMAINING" ]]; then
  echo "[stop] 仍有残留进程，强杀:$REMAINING"
  for PID in $REMAINING; do
    kill -9 "$PID" 2>/dev/null || true
  done
fi

echo "[stop] 已停止"
rm -f "$PID_FILE"