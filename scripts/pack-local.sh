#!/usr/bin/env bash
# 本机自用打包：免签名的 --dir 构建（不触发 codesign / 钥匙串弹窗）。
# 用法: ./scripts/pack-local.sh
#
# 产物: dist/mac-arm64/Token Monitor.app（ad-hoc 签名，本机可直接运行）。
# 正式分发（公证、WidgetKit 扩展等）请走 dist:mac:widget，不要用本脚本。

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

# 项目 config 默认 forceCodeSigning: true 且会自动发现 Apple Development
# 证书，--dir 模式下同样会调 codesign 并在钥匙串授权弹窗处卡死——两项都
# 必须显式压掉（本机自用结论，见 scripts/electron-builder.config.js）。
npx electron-builder --config scripts/electron-builder.config.js --dir \
  --config.mac.identity=null \
  --config.mac.forceCodeSigning=false \
  2>&1 | tee -a "$LOG_DIR/pack-local.log"
