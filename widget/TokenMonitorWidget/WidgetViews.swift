import SwiftUI

// 各尺寸的 SwiftUI 视图与展示格式化工具。
// 展示内容：各 AI 工具的当前剩余额度（limits）——剩余百分比/余额金额 + 进度条。
// 文案使用英文短标签（widget 空间有限，且避免引入本地化工程）；
// 需要多语言时再为小组件增加 String Catalog。

// MARK: - 格式化工具

enum WidgetFormatting {
  /// 金额：>=100 用 K/M 缩写，否则 2 位小数
  static func money(_ value: Double, symbol: String) -> String {
    let amount = max(0, value)
    if amount >= 1_000_000 { return "\(symbol)\(String(format: "%.1f", amount / 1_000_000))M" }
    if amount >= 100_000 { return "\(symbol)\(String(format: "%.0f", amount / 1_000))K" }
    return "\(symbol)\(String(format: "%.2f", amount))"
  }

  /// 更新时间：仅显示本地时区的 HH:mm
  static func shortTime(_ isoString: String) -> String {
    guard let date = parseISO8601(isoString) else { return "" }
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"
    formatter.locale = Locale.current
    return formatter.string(from: date)
  }

  /// ISO8601 解析（兼容带/不带小数秒）
  private static func parseISO8601(_ value: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: value) { return date }
    let plain = ISO8601DateFormatter()
    return plain.date(from: value)
  }

  /// 单个 provider 行：名称 + 剩余值 + 按剩余百分比填充的进度条
  static func limitRow(_ limit: WidgetLimit) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 4) {
        Text(limit.name)
          .font(.system(size: 9, weight: .medium))
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 4)
        Text(remainingText(limit))
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      if let percent = limit.percent {
        GeometryReader { geo in
          ZStack(alignment: .leading) {
            Capsule()
              .fill(.quaternary)
            Capsule()
              .fill(.tint)
              .frame(width: max(4, geo.size.width * CGFloat(percent) / 100))
          }
        }
        .frame(height: 4)
      }
    }
  }

  /// 剩余值文案：余额金额优先，否则剩余百分比
  private static func remainingText(_ limit: WidgetLimit) -> String {
    if let remaining = limit.remaining, remaining >= 0 {
      return money(remaining, symbol: limit.currency ?? "")
    }
    if let percent = limit.percent {
      return "\(percent)%"
    }
    return ""
  }
}

// MARK: - 空态

/// 快照缺失（应用未运行/尚未产生数据）时的提示
struct EmptyWidgetView: View {
  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: "gauge.with.needle")
        .font(.system(size: 22))
        .foregroundStyle(.secondary)
      Text("Open Token Monitor\nto see your limits")
        .font(.caption)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
    }
  }
}

// MARK: - 小尺寸

/// 小尺寸：前 3 个 provider 的剩余额度
struct SmallWidgetView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      header
      Spacer(minLength: 0)
      limitRows(snapshot.limits.prefix(3))
    }
    .fontDesign(.rounded)
  }

  private var header: some View {
    HStack {
      Text("AI LIMITS")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.secondary)
      Spacer()
      Text(WidgetFormatting.shortTime(snapshot.updatedAt))
        .font(.system(size: 9))
        .foregroundStyle(.tertiary)
    }
  }

  private func limitRows(_ limits: ArraySlice<WidgetLimit>) -> some View {
    VStack(spacing: 6) {
      ForEach(limits) { limit in
        WidgetFormatting.limitRow(limit)
      }
    }
  }
}

// MARK: - 中尺寸

/// 中尺寸：前 5 个 provider 的剩余额度
struct MediumWidgetView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("AI LIMITS")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(.secondary)
        Spacer()
        Text(WidgetFormatting.shortTime(snapshot.updatedAt))
          .font(.system(size: 9))
          .foregroundStyle(.tertiary)
      }
      limitRows(snapshot.limits.prefix(5))
    }
    .fontDesign(.rounded)
  }

  private func limitRows(_ limits: ArraySlice<WidgetLimit>) -> some View {
    VStack(spacing: 7) {
      ForEach(limits) { limit in
        WidgetFormatting.limitRow(limit)
      }
    }
  }
}
