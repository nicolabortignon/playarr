import Foundation

/// The web's number, size, wait and date wording (apps/web/src/lib/format.ts), for the Settings panels.
enum AdminText {
  /// 1 → "1 song", 3 → "3 songs".
  static func plural(_ n: Int, _ word: String, _ pluralWord: String? = nil) -> String {
    Format.plural(n, word, pluralWord)
  }

  /// 5678 → "5,678": the panels are in English, so their numbers are too.
  static func count(_ n: Int) -> String {
    n.formatted(.number.locale(Locale(identifier: "en_US")))
  }

  /// 245 → "4:05", 3725 → "1:02:05".
  static func time(_ seconds: Double) -> String { Format.time(seconds) }

  /// A rough wait: "4 s", "2 min".
  static func wait(_ seconds: Double) -> String { Format.wait(seconds) }

  /// 356515840 → "340 MB", 1610612736 → "1.5 GB".
  static func bytes(_ bytes: Int) -> String {
    let gb = Double(bytes) / 1_073_741_824
    if gb >= 1 {
      let whole = gb >= 10 || gb == gb.rounded()
      return whole ? "\(Int(gb.rounded())) GB" : "\(String(format: "%.1f", gb)) GB"
    }
    return "\(Int((Double(bytes) / 1_048_576).rounded())) MB"
  }

  /// "2 minutes ago", "yesterday", "just now", for a Unix time in seconds (the web's Intl.RelativeTimeFormat, numeric "auto").
  static func ago(_ seconds: Int, now: Date = Date()) -> String {
    let diff = Int((Double(seconds) - now.timeIntervalSince1970).rounded())
    for (unit, size) in [("day", 86_400), ("hour", 3_600), ("minute", 60)] where abs(diff) >= size {
      let value = Int((Double(diff) / Double(size)).rounded())
      if unit == "day", value == -1 { return "yesterday" }
      if unit == "day", value == 1 { return "tomorrow" }
      let amount = plural(abs(value), unit)
      return value < 0 ? "\(amount) ago" : "in \(amount)"
    }
    return "just now"
  }

  /// An ISO 8601 time from the server, with or without fractions of a second.
  static func date(_ iso: String) -> Date? { Format.parseDate(iso) }

  /// The web's `toLocaleString()`: date and time, the device's way.
  static func dateTime(_ iso: String) -> String {
    date(iso)?.formatted(date: .numeric, time: .shortened) ?? iso
  }
}
