#!/usr/bin/env bash
# 构建 Token Monitor 的 macOS WidgetKit 小组件扩展（TokenMonitorWidget.appex）
# 用法:
#   scripts/build-widget.sh                      # 本地开发构建（ad-hoc 签名，无证书）
#   scripts/build-widget.sh --sign <identity>    # CI 分发构建（Developer ID 证书）
# 产物: widget/build/TokenMonitorWidget.appex（可用 --output 指定输出路径）
# 要求: xcodegen（brew install xcodegen）、Xcode 命令行工具

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

WIDGET_DIR="$PROJECT_ROOT/widget"
BUILD_DIR="$WIDGET_DIR/build"
OUTPUT_APPEX="$BUILD_DIR/TokenMonitorWidget.appex"
SIGN_IDENTITY=""

# 解析参数: --sign <identity> 用于真机分发；--output <path> 自定义产物位置
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sign)
      SIGN_IDENTITY="${2:?--sign 需要证书 identity 参数}"
      shift 2
      ;;
    --output)
      OUTPUT_APPEX="${2:?--output 需要输出路径参数}"
      shift 2
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

# 版本号从 package.json 读取，保证与主应用一致
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
MARKETING_VERSION="${MARKETING_VERSION:-$PACKAGE_VERSION}"
CURRENT_PROJECT_VERSION="${CURRENT_PROJECT_VERSION:-1}"

# 生成 Xcode 工程（工程文件不入库，每次构建时生成）
xcodegen generate --spec "$WIDGET_DIR/project.yml" --project "$WIDGET_DIR"

# 构建参数：默认 ad-hoc 签名（project.yml 已设 CODE_SIGN_IDENTITY=-）；
# 传入 --sign 时用真证书覆盖（CI 场景，identity 取自 keychain 已导入的 Developer ID）
BUILD_SETTINGS=(
  -project "$WIDGET_DIR/TokenMonitorWidget.xcodeproj"
  -scheme TokenMonitorWidget
  -configuration Release
  -derivedDataPath "$BUILD_DIR"
  MARKETING_VERSION="$MARKETING_VERSION"
  CURRENT_PROJECT_VERSION="$CURRENT_PROJECT_VERSION"
)
if [[ -n "$SIGN_IDENTITY" ]]; then
  BUILD_SETTINGS+=(CODE_SIGN_IDENTITY="$SIGN_IDENTITY")
fi

xcodebuild "${BUILD_SETTINGS[@]}" build

# 把构建产物拷到约定位置（xcodebuild 产物路径由 derivedDataPath 决定）
PRODUCT_APPEX="$BUILD_DIR/Build/Products/Release/TokenMonitorWidget.appex"
if [[ "$PRODUCT_APPEX" != "$OUTPUT_APPEX" ]]; then
  mkdir -p "$(dirname "$OUTPUT_APPEX")"
  rm -rf "$OUTPUT_APPEX"
  cp -R "$PRODUCT_APPEX" "$OUTPUT_APPEX"
fi

echo "[build-widget] 构建完成: $OUTPUT_APPEX"
