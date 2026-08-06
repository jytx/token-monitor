import Foundation
import os

// 小组件数据模型 —— 与 src/shared/widgetSnapshot.js 的 schema 2 快照逐字段对齐。
// 快照由 Electron 主进程每次 stats 刷新时写入 widget 自己的沙箱容器
// Documents/widget-stats.json（宿主非沙箱直接按路径写），小组件只读文件、
// 不做任何业务计算（显示名、占比均在写入端算好）。

// 诊断日志：log show --predicate 'subsystem == "com.javis.tokenmonitor.widget"'
private let widgetLog = Logger(subsystem: "com.javis.tokenmonitor.widget", category: "stats")

/// 顶层快照结构（schema: 2，仅 AI 额度/限额数据）
struct WidgetSnapshot: Codable {
  let schema: Int
  let updatedAt: String
  let deviceId: String
  let appVersion: String
  let limits: [WidgetLimit]
}

/// 单个 provider 的剩余额度：percent 为剩余百分比（0-100，条长用），
/// remaining/currency 为余额型（credits）金额；null 表示无该维度
struct WidgetLimit: Codable, Identifiable {
  let name: String
  let percent: Int?
  let remaining: Double?
  let currency: String?
  var id: String { name }
}

/// 从 App Group 共享容器读取快照的单一入口
enum StatsStore {
  /// App Group 标识，与 src/shared/widgetSnapshot.js 中的 GROUP_ID 保持一致
  static let groupId = "group.com.javis.tokenmonitor"
  /// 快照文件名，与写入端一致
  static let snapshotFileName = "widget-stats.json"
  /// 期望的 schema 版本，与写入端一致
  static let expectedSchema = 2

  /// 快照文件 URL。
  /// 通道：widget 自己的沙箱 Documents 容器——宿主 Electron（非沙箱）直接
  /// 按路径写入，widget 读自己容器必定允许（无需任何例外 entitlement）。
  /// 历史踩坑：App Group 容器被 datavault 拒读；userData 文件需要
  /// temporary-exception，而该例外会导致系统拒绝加载扩展（macOS 26）。
  static var snapshotURL: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
      .appendingPathComponent(snapshotFileName)
  }

  /// 读取并解码快照；文件缺失、损坏或 schema 不匹配时返回 nil（视图显示空态）
  static func loadSnapshot() -> WidgetSnapshot? {
    let url = snapshotURL
    widgetLog.info("读取快照: \(url.path, privacy: .public)")
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch {
      widgetLog.error("读取快照失败: \(error.localizedDescription, privacy: .public)")
      return nil
    }
    widgetLog.info("快照字节数: \(data.count)")
    guard let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else {
      widgetLog.error("快照解码失败（schema 或结构不匹配）")
      return nil
    }
    guard snapshot.schema == expectedSchema else { return nil }
    return snapshot
  }
}
