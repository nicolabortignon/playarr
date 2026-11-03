import Foundation

/// One measure across ordered categories (hours, weekdays, months) as columns, shaped for Swift Charts:
/// the busiest labelled, every column's full label for VoiceOver and the numbers (components/ColumnChart.tsx).
struct ListeningChart: Equatable {
  struct Column: Identifiable, Equatable {
    let id: Int
    let label: String
    let minutes: Double
    /// Gets an axis label underneath.
    let tick: Bool
  }

  let title: String
  let columns: [Column]

  init(title: String, minutes: [Double], labels: [String], tick: (Int) -> Bool = { _ in true }) {
    self.title = title
    columns = zip(minutes.indices, zip(minutes, labels)).map { Column(id: $0, label: $1.1, minutes: $1.0, tick: tick($0)) }
  }

  /// The busiest column, when anything was heard.
  var peak: Column? {
    guard let top = columns.max(by: { $0.minutes < $1.minutes }), top.minutes > 0 else { return nil }
    return columns.first { $0.minutes == top.minutes }
  }

  /// "Most: 9 PM · 2 h 5 min", or the column the finger is on.
  func caption(selected: Int? = nil, locale: Locale = .current) -> String? {
    if let selected, let column = columns.first(where: { $0.id == selected }), column.minutes > 0 {
      return "\(column.label) · \(Format.minutes(column.minutes, locale: locale))"
    }
    return peak.map { "Most: \($0.label) · \(Format.minutes($0.minutes, locale: locale))" }
  }

  static func hours(_ minutes: [Double], locale: Locale = .current) -> ListeningChart {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.setLocalizedDateFormatFromTemplate("j")
    let labels = (0..<24).map { formatter.string(from: Date(timeIntervalSince1970: Double($0) * 3600)) }
    return ListeningChart(title: "By hour of the day", minutes: minutes, labels: labels, tick: { $0 % 6 == 0 })
  }

  /// Sunday first, as the server counts.
  static func weekdays(_ minutes: [Double], locale: Locale = .current) -> ListeningChart {
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = locale
    return ListeningChart(title: "By day of the week", minutes: minutes, labels: calendar.shortWeekdaySymbols)
  }

  static func months(_ minutes: [Double], locale: Locale = .current) -> ListeningChart {
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = locale
    return ListeningChart(title: "By month", minutes: minutes, labels: calendar.shortMonthSymbols)
  }
}
