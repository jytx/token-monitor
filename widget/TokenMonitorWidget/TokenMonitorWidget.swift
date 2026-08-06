import WidgetKit
import SwiftUI

// 小组件主入口：声明一种小组件，支持小、中两种尺寸。
// 点击小组件通过 tokenmonitor:// URL scheme 唤起主应用（见 main.js 的 open-url 处理）。
// 各尺寸视图与格式化工具见 WidgetViews.swift。

@main
struct TokenMonitorWidget: Widget {
  let kind = "TokenMonitorWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: StatsProvider()) { entry in
      TokenMonitorWidgetView(entry: entry)
    }
    .configurationDisplayName("Token Monitor")
    .description("Live token usage & cost for your AI coding tools")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

/// 按尺寸分发到具体视图；快照缺失时显示空态
struct TokenMonitorWidgetView: View {
  let entry: StatsEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        switch family {
        case .systemSmall:
          SmallWidgetView(snapshot: snapshot)
        default:
          MediumWidgetView(snapshot: snapshot)
        }
      } else {
        EmptyWidgetView()
      }
    }
    .containerBackground(.ultraThinMaterial, for: .widget)
    .widgetURL(URL(string: "tokenmonitor://"))
  }
}
