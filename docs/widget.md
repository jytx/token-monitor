# macOS WidgetKit 桌面小组件

Token Monitor 在 macOS 上提供**原生系统小组件**（WidgetKit）：用户可从通知中心或桌面右键的"编辑小组件"中添加，显示**各 AI 工具的当前剩余额度**（AI Tool Limits 数据）——配额型显示剩余百分比 + 进度条，余额型（DeepSeek/OpenRouter 等）显示剩余金额。点击小组件会唤起主应用窗口。

- 支持 macOS 14+（桌面小组件）；macOS 11–13 仅通知中心可用（extension 在旧系统不会加载，不影响主应用）
- 支持小（3 行）、中（5 行）两种尺寸
- 数据跟随主应用 AI Tool Limits 页面的同一数据源，刷新间隔受 macOS timeline 调度限制（约 15 分钟一档）

## 架构

```
Electron 主进程（每次 stats 刷新）──▶ src/shared/widgetSnapshot.js 写精简快照
      ~/Library/Containers/com.javis.tokenmonitor.widget/Data/Documents/widget-stats.json（原子写）
Swift Widget extension（TimelineProvider 每 15 分钟一档）──▶ StatsStore 读快照 → SwiftUI 渲染
点击 widget ──▶ tokenmonitor:// URL scheme ──▶ main.js 的 open-url 处理 ──▶ 显示主窗口
```

关键设计：

- **数据通道是 widget 自己的沙箱容器 Documents 目录**：宿主 Electron（非沙箱进程）直接按路径写入该目录（datavault 只约束沙箱进程，非沙箱进程同用户可写），widget 读自己容器必定允许——双向都不需要额外 entitlement。
- **两个踩过的坑（勿改回）**：
  1. App Group 容器：宿主非沙箱时，datavault 拒绝扩展读取（`EPERM: 你没有查看它的权限`）。
  2. userData 文件 + `temporary-exception.files.absolute-path.read-only`：该例外会导致系统**拒绝加载扩展**（macOS 26 实测，扩展进程完全不运行，卡片永远显示旧缓存渲染）。
- **快照是写端算好的展示数据**（schema 2）：provider 显示名、剩余百分比（含 credits 金额的派生）都在 `widgetSnapshot.js` 算好（复用 `limitBalanceDisplay.js` 的派生逻辑），Swift 端零业务逻辑、零映射表。每 provider 取第一个有效 account，按剩余百分比升序。
- **没有推送刷新**：WidgetKit 没有面向第三方的推送 API，widget 通过 timeline 定时重载读最新快照。数据新鲜度 ≈ 15 分钟；主应用窗口本身仍是实时的。
- **签名链**：appex 必须用**带 Team ID 的有效签名**（本地开发用 Apple Development 证书，分发用 Developer ID）。**ad-hoc 签名无法被系统后台运行扩展**——前台预览（placeholder）可渲染，后台 timeline 调度静默失败（无任何日志）。

## 代码布局

| 位置 | 职责 |
|---|---|
| `widget/project.yml` | xcodegen 工程描述（工程文件不入库） |
| `widget/TokenMonitorWidget/*.swift` | Widget 入口、TimelineProvider、数据读取、视图 |
| `widget/TokenMonitorWidget/TokenMonitorWidget.entitlements` | extension 的 App Group entitlement |
| `src/shared/widgetSnapshot.js` | 快照生成（纯函数）与写入 |
| `src/shared/clientLabels.js` | 工具 → 显示名唯一映射源（renderer 与快照共用） |
| `build/entitlements.mac.plist` | 主应用的 entitlements（Electron 基础项 + App Group） |
| `scripts/build-widget.sh` | xcodegen + xcodebuild 构建 appex |
| `scripts/electron-afterPack.js` | 把 appex 拷入 `.app/Contents/PlugIns` |
| `scripts/electron-afterSign.js` | 签 appex + 重签主应用 |

## 开发流程

### 1. 构建小组件扩展（首次）

```bash
brew install xcodegen     # 仅开发机需要，不随产品分发
scripts/build-widget.sh   # ad-hoc 签名构建，产物在 widget/build/TokenMonitorWidget.appex
```

CI 里 `ci.yml`（macOS job）每次都会跑这一步做编译验证，防止 Swift 代码漂移。

### 2. 组装 .app 本地验证

本地没有 Developer ID 证书，无法走 `npm run dist:mac`（`forceCodeSigning: true`）。验证用以下路径：

```bash
scripts/build-widget.sh                          # 1. 构建 appex（ad-hoc）
npx electron-builder --dir -c.mac.forceCodeSigning=false   # 2. 打包未签名 .app（afterPack 自动装入 appex）
codesign --force --sign - --entitlements build/entitlements.mac.plist "dist/mac-arm64/Token Monitor.app"  # 3. ad-hoc 签主应用
codesign --force --sign - --entitlements widget/TokenMonitorWidget/TokenMonitorWidget.entitlements "dist/mac-arm64/Token Monitor.app/Contents/PlugIns/TokenMonitorWidget.appex"
open "dist/mac-arm64/Token Monitor.app"
```

启动后打开"编辑小组件"搜索 Token Monitor 添加。注意 ad-hoc 签名的小组件仅本机可用，真实分发由 CI 的 Developer ID 签名链路保证。

### 3. 写入端调试

快照文件在 `~/Library/Application Support/Token Monitor/widget-stats.json`。主应用设置里"桌面小组件"开关控制是否写入（默认开，仅 macOS 显示该开关）。开发模式（无 entitlement）下写入失败会静默降级——可用 `TOKEN_MONITOR_WIDGET_GROUP_DIR` 覆盖目录验证。

### 4. 验证签名（CI 同款）

```bash
codesign --verify --strict --verbose=2 "Token Monitor.app"
codesign --verify --strict --verbose=2 "Token Monitor.app/Contents/PlugIns/TokenMonitorWidget.appex"
```

## 发布（release.yml）

mac job 在 electron-builder 前执行 `scripts/build-widget.sh`（ad-hoc），`afterPack` 装入 appex，`afterSign` 用 CI keychain 里的 Developer ID（由 `CSC_LINK` 导入）签 appex 并重签主应用，随后 electron-builder 正常公证 dmg/zip。公证会校验嵌套签名——appex 未签或顺序错误会导致公证失败，是本功能最大的 CI 风险点。

## 常见问题

- **小组件显示"Open Token Monitor to see your usage"**：主应用未运行或尚未产生第一次 stats；启动应用并等待一次刷新即可。
- **数字不更新**：widget 是分钟级刷新（timeline 调度），不是实时；等下一档或点击打开主应用。
- **改 Swift 代码后不生效**：`widget/TokenMonitorWidget.xcodeproj` 是 xcodegen 生成的，改完 `project.yml` 或新增文件后重新 `scripts/build-widget.sh`（会自动重新 generate）。
- **新增工具后 widget 不显示新工具**：快照按花费取前 4 个工具，且显示名由 `clientLabels.js` 提供——按 AGENTS.md「Adding a tracked client」清单更新即可，Swift 侧无需改动。

## 明确不做

- 大尺寸、可交互（AppIntent）widget：本期只做小/中静态展示 + 点击唤起
- widget 内多设备切换：只显示当前窗口视图
- Swift 侧不引入 tokscale 依赖：保持快照通道单向、解耦
