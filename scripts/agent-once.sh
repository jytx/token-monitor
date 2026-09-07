#!/usr/bin/env bash
# 一次性运行 headless 采集器（collect + post；--dry-run 只采集不上报）。
# 用法: ./scripts/agent-once.sh [--dry-run]
#
# 与桌面挂件互相独立：不抢 Electron 单实例锁，可随时运行。
# 默认读取 .env / 环境变量里的 TOKEN_MONITOR_CLIENTS 等配置；如需完全
# 隔离验证（不碰挂件共享的 data/ 目录），可自行前置
# TOKEN_MONITOR_SHARED_DIR=<隔离目录> ./scripts/agent-once.sh --dry-run

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

npm run agent:once -- "$@" 2>&1 | tee -a "$LOG_DIR/agent-once.log"
