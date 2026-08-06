import WidgetKit

// Timeline 提供者：按固定间隔生成条目，驱动小组件按系统调度刷新。
// WidgetKit 没有面向第三方应用的推送刷新机制，因此采用"读取最新快照 + 定时重载"：
// 每个条目都携带读取时的最新快照，系统按条目的 date 依次展示；
// 刷新频率受 macOS timeline 调度限制（分钟级），属于设计内取舍，见 docs/widget.md。

/// Timeline 条目：date 为展示时间点，snapshot 为读取时的数据
struct StatsEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?
}

/// 每档刷新间隔（秒）：15 分钟
let widgetRefreshInterval: TimeInterval = 15 * 60
/// 单次 timeline 提供的档位数（约 90 分钟窗口）
let widgetTimelineCount = 6

/// Timeline 提供者（TimelineProvider 要求实例方法，故用 struct 而非 enum）
struct StatsProvider: TimelineProvider {
  /// 无数据的占位图（小组件库预览/加载中）
  func placeholder(in context: Context) -> StatsEntry {
    StatsEntry(date: Date(), snapshot: nil)
  }

  /// 临时快照：小组件库展示或首次放置时立即读取一次
  func getSnapshot(in context: Context, completion: @escaping (StatsEntry) -> Void) {
    completion(StatsEntry(date: Date(), snapshot: StatsStore.loadSnapshot()))
  }

  /// 常规时间线：读一次快照，生成多档条目；数据在下次重载时更新
  func getTimeline(in context: Context, completion: @escaping (Timeline<StatsEntry>) -> Void) {
    let snapshot = StatsStore.loadSnapshot()
    let now = Date()
    let entries = (0..<widgetTimelineCount).map { index in
      StatsEntry(
        date: now.addingTimeInterval(widgetRefreshInterval * Double(index)),
        snapshot: snapshot
      )
    }
    let timeline = Timeline(entries: entries, policy: .atEnd)
    completion(timeline)
  }
}
