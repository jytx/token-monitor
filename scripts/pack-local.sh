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

# 同步上游代码后 node_modules 可能落后于 lock（tokscale 版本不符会把旧
# 扫描器打进包，0.74.0 曾因此带 4.18.0 导致采集降级变慢），打包前先对齐
# 依赖，再按上游正式打包入口的惯例换入 pinned fork 版 tokscale。
npm install

# ensure-vendored-tokscale 用 Node 原生 fetch 下载 GitHub release：
# Node 22 的 fetch 不读代理环境变量、直连会超时中止，需 Node 24 并启用
# NODE_USE_ENV_PROXY（走本机 v2rayN 代理）。若找不到 v24 则回退当前
# node 直连尝试。
export NODE_USE_ENV_PROXY=1
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
ENSURE_NODE="$(command -v node)"
if [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
  LATEST_V24="$(ls -d "$HOME"/.nvm/versions/node/v24.* 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$LATEST_V24" ] && [ -x "$LATEST_V24/bin/node" ]; then
    ENSURE_NODE="$LATEST_V24/bin/node"
  fi
fi
"$ENSURE_NODE" scripts/ensure-vendored-tokscale.js --platform=darwin-arm64

# 项目 config 默认 forceCodeSigning: true 且会自动发现 Apple Development
# 证书，--dir 模式下同样会调 codesign 并在钥匙串授权弹窗处卡死——两项都
# 必须显式压掉（本机自用结论，见 scripts/electron-builder.config.js）。
npx electron-builder --config scripts/electron-builder.config.js --dir \
  --config.mac.identity=null \
  --config.mac.forceCodeSigning=false \
  2>&1 | tee -a "$LOG_DIR/pack-local.log"
