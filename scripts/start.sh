#!/usr/bin/env bash
# 启动 Token Monitor Electron 桌面挂件，日志输出到 logs/
# 用法: ./scripts/start.sh

set -euo pipefail

# 切换到项目根目录（脚本所在目录的上一级）
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# 统一日志目录
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

PID_FILE="$LOG_DIR/token-monitor.pid"
STDOUT_LOG="$LOG_DIR/token-monitor.out.log"
STDERR_LOG="$LOG_DIR/token-monitor.err.log"

# 若已在运行，提示并退出
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[start] Token Monitor 已在运行 (PID $(cat "$PID_FILE"))，如需重启请先执行 ./scripts/stop.sh"
  exit 0
fi

# 后台启动 electron，stdout/stderr 重定向到日志文件
nohup npm start >"$STDOUT_LOG" 2>"$STDERR_LOG" &
APP_PID=$!
echo "$APP_PID" >"$PID_FILE"

echo "[start] Token Monitor 已启动 (PID $APP_PID)"
echo "[start] stdout 日志: $STDOUT_LOG"
echo "[start] stderr 日志: $STDERR_LOG"
