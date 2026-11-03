import Foundation

extension Format {
  /// 5678 → "5,678" in English.
  public static func number(_ value: Int, locale: Locale = .current) -> String {
    value.formatted(.number.locale(locale))
  }

  /// Minutes heard: 45 → "45 min", 95 → "1 h 35 min", 120 → "2 h" (pages/Stats.tsx minutesLabel).
  public static func minutes(_ value: Double, locale: Locale = .current) -> String {
    let m = Int(value.rounded())
    if m < 60 { return "\(m) min" }
    return "\(number(m / 60, locale: locale)) h" + (m % 60 == 0 ? "" : " \(m % 60) min")
  }

  /// When a mix is made again: "Changes in 40 min", "Changes in 9 h", "Changes on Monday" (pages/Mix.tsx changesLabel).
  public static func changes(at date: Date, now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> String {
    let minutes = max(1, Int((date.timeIntervalSince(now) / 60).rounded()))
    if minutes < 90 { return "Changes in \(minutes) min" }
    if minutes < 24 * 60 { return "Changes in \(Int((Double(minutes) / 60).rounded())) h" }
    var style = Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.wide)
    style.calendar = Calendar(identifier: .gregorian)
    return "Changes on \(date.formatted(style))"
  }
}
