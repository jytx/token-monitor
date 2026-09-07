# 为 Token Monitor 新增 macOS 原生 WidgetKit 桌面小组件

## 目标

给现有 Electron 应用增加真正的 macOS 系统小组件（WidgetKit）：用户可从系统小组件库（通知中心 / 桌面）添加，显示**标准三件套**——今日 / 本月 / 总计的 token 数与花费 + 主要工具占比条，支持小、中两种尺寸；点击小组件打开主应用。

现状依据（已探索确认）：
- 项目已是"桌面 widget"形态（无边框透明 + 毛玻璃 + 置顶 + 可折叠气泡），但与系统小组件库无集成点
- 仓库零 Swift 文件、无 entitlements；mac 签名公证在 CI（`.github/workflows/release.yml`，CSC_LINK + Apple API key）完成，`forceCodeSigning: true`，LSUIElement 已设
- local 模式 stats 为纯内存，无现成外部可读快照文件
- Xcode 已装（Xcode.app + xcodebuild + swift 可用）；用户已确认用 xcodegen 生成工程

## 架构：App Group 文件通道

```
Electron 主进程（每次 stats 刷新）──▶ widgetSync 写精简快照
        ~/Library/Group Containers/group.com.javis.tokenmonitor/stats.json（原子写）
Swift Widget extension（TimelineProvider 每 15 分钟刷新）──▶ 读快照 → SwiftUI 渲染
点击 widget ──▶ tokenmonitor:// URL scheme ──▶ Electron 激活窗口
```

选 App Group 而非 localhost HTTP 的原因：widget 处于沙箱无法读 Electron 私有 userData（拿不到 hub secret），且强制开 host 模式会改变现有行为；文件通道对所有数据模式（local/client/host）天然生效。

## 实施步骤

### 1. Swift 小组件工程（新目录 `widget/`）
- `widget/project.yml`（xcodegen 配置，1 个 appex target，deployment target macOS 14.0）
- `widget/TokenMonitorWidget/`：
  - `TokenMonitorWidget.swift` — `@main` Widget + 配置声明（小/中两种 `supportedFamilies`）
  - `StatsProvider.swift` — TimelineProvider：每 15 分钟一个 entry；读取最新快照
  - `StatsStore.swift` — 读 group container 的 `stats.json` + Codable 解码
  - `WidgetViews.swift` — SwiftUI 视图：标题行 + 今日/本月/总计数字 + 前 4 个工具占比条；`containerBackground`（macOS 14 API）
  - `TokenMonitorWidget.entitlements` — `com.apple.security.application-groups` = `group.com.javis.tokenmonitor`
- `scripts/build-widget.sh` — `xcodegen generate` + `xcodebuild` 构建 appex；支持传签名 identity（CI 用真证书、本地用 ad-hoc）

### 2. Electron 侧写快照（`src/shared/widgetSnapshot.js`）
- `buildWidgetSnapshot(stats, settings)`：纯函数，输出 schema 1 快照 —— `{ updatedAt, deviceId, appVersion, currency, periods: { today/month/allTime: { totalTokens, costUsd, topClients: [前4, 含 share 占比] } } }`；工具显示名在快照中直接带（widget 端零映射，客户端列表增长不失效）
- `writeWidgetSnapshot(...)`：仅 darwin 执行；`writeJsonAtomic` 原子写 group container 路径；失败静默降级（开发模式无 entitlement 时不打扰用户）
- `main.js`：在 stats 输出路径（`sendPush` 附近，main.js:3162-3177）调用；新增设置 `widgetEnabled`（默认开，renderer 设置面板加"macOS 桌面小组件"开关）

### 3. 打包集成（electron-builder）
- 新增 `build/entitlements.mac.plist`（application-groups），package.json `build.mac` 加 `entitlements` / `entitlementsInherit`
- `build.mac.protocols`：注册 `tokenmonitor://`（点击 widget 唤起应用）
- `afterPack` hook（`scripts/electron-afterPack.js`）：把构建好的 `TokenMonitorWidget.appex` 拷入 `Contents/PlugIns/`（不存在则跳过，保证纯 JS 开发不受阻）
- `afterSign` hook（`scripts/electron-afterSign.js`）：先给 appex 单独 codesign（identity 从 keychain `find-identity` 取 CI 导入的 Developer ID），再对主 .app 重新签名，使其 seal 覆盖 PlugIns —— 保证公证通过
- `main.js`：`app.on('open-url')` 处理 `tokenmonitor://` → 显示/聚焦主窗口

### 4. CI
- `ci.yml`：macos job 增加 xcodegen + xcodebuild（无签名）编译验证，防 Swift 代码漂移
- `release.yml`：两个 mac job 在 electron-builder 前先 `scripts/build-widget.sh`（用 CI keychain 里的证书 identity）；公证流程不变
- 本地开发验证路径：`npm run pack -- --dir -c.mac.forceCodeSigning=false` + ad-hoc 签名 appex 组装（写入计划文档）

### 5. 测试与文档
- `tests/shared/widgetSnapshot.test.js`（node:test）：快照结构、topClients 排序/截断、share 计算、非 darwin 跳过、原子写
- `npm run verify` 保持通过
- `docs/widget.md`（中文）：架构、开发流程、构建/签名、常见问题

## 风险与取舍（已评估）

| 项 | 说明 |
|---|---|
| 嵌套签名/公证顺序 | 最大不确定点：appex 必须用同一 Developer ID 签名且被主 app seal 覆盖，公证才过；需 CI 实测，afterSign 方案为社区验证过的顺序（appex → 主 app 重签） |
| 本地验证受限 | 本机无 Developer ID 证书，widget 真实运行需签名 app；本地用 ad-hoc 组装验证 UI 与数据流，真实验证依赖 CI |
| 数据新鲜度 | macOS timeline 调度为分钟级（15 分钟一档），非实时——符合"标准三件套"定位；打开主应用时窗口数据仍实时 |
| 系统要求 | 桌面小组件需 macOS 14+（通知中心 11+）；旧系统自动无此功能，不影响主应用 |
| 无 entitlement 开发模式 | Electron 直接写 group container 同用户可写，失败则 try/catch 降级，不弹错 |

## 明确不做（YAGNI）
- 大尺寸 widget、可交互 widget（AppIntent）——后续可加，本期只做小/中静态展示 + 点击唤起
- widget 内多设备切换——只显示当前窗口视图（与窗口数据一致，所有 hub 模式通用）
- 不引入 tokscale 依赖到 Swift 侧——保持快照通道单向、解耦

## 需执行的命令类别
- `npm run verify` / `npm test` / `npm run pack`（本地验证）
- `brew install xcodegen`（若未安装）、`xcodegen generate`、`xcodebuild`（构建 Swift 工程）
- `codesign`（本地 ad-hoc 签名验证 appex）
- `npm run lint`