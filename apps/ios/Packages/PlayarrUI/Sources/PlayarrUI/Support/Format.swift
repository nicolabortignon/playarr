import Foundation
import PlayarrAPI

/// Times, sizes and counts written as the web writes them (apps/web/src/lib/format.ts).
public enum Format {
  /// 245 → "4:05", 3725 → "1:02:05".
  public static func time(_ seconds: Double) -> String {
    let total = seconds.isFinite && seconds > 0 ? Int(seconds) : 0
    let s = total % 60
    let m = (total / 60) % 60
    let h = total / 3600
    let ss = s < 10 ? "0\(s)" : "\(s)"
    return h > 0 ? "\(h):\(m < 10 ? "0\(m)" : "\(m)"):\(ss)" : "\(m):\(ss)"
  }

  /// 2564 → "43 min", 7300 → "2 hr 2 min".
  public static func duration(_ seconds: Double) -> String {
    let h = Int(seconds / 3600)
    let m = Int((seconds.truncatingRemainder(dividingBy: 3600) / 60).rounded())
    if h == 0 { return "\(m) min" }
    return m > 0 ? "\(h) hr \(m) min" : "\(h) hr"
  }

  /// "1 track", "12 tracks".
  public static func plural(_ n: Int, _ word: String, _ pluralWord: String? = nil) -> String {
    "\(n) \(n == 1 ? word : pluralWord ?? "\(word)s")"
  }

  /// A rough wait: "4 s", "2 min" (`formatWait`).
  public static func wait(_ seconds: Double) -> String {
    seconds < 60 ? "\(max(1, Int(jsRound(seconds)))) s" : "\(Int(jsRound(seconds / 60))) min"
  }

  /// JavaScript's Math.round: halves go up (Swift's `rounded()` takes -2.5 to -3, JavaScript to -2).
  public static func jsRound(_ value: Double) -> Double { (value + 0.5).rounded(.down) }

  /// "FLAC 24/88.2", "MP3 320", "AAC".
  public static func badge(_ format: AudioFormat?) -> String? {
    guard let format else { return nil }
    if format.lossless {
      guard let bits = format.bits, let rate = format.sampleRate else { return format.codec }
      let khz = Double(rate) / 1000
      let spec = khz == khz.rounded() ? String(Int(khz)) : String(format: "%.1f", khz)
      return "\(format.codec) \(bits)/\(spec)"
    }
    guard let bitrate = format.bitrate else { return format.codec }
    return "\(format.codec) \(Int(bitrate))"
  }

  /// More than CD quality (16-bit/44.1 kHz).
  public static func isHiRes(_ format: AudioFormat?) -> Bool {
    guard let format, format.lossless else { return false }
    return (format.bits ?? 0) > 16 || (format.sampleRate ?? 0) > 48_000
  }

  /// "today", "3 days ago", "2 months ago": when an album entered the library.
  public static func addedAgo(_ iso: String, now: Date = Date(), locale: Locale = .current) -> String? {
    guard let date = parseDate(iso) else { return nil }
    let days = Int((date.timeIntervalSince(now) / 86_400).rounded())
    if days > -1 { return "today" }
    let relative = RelativeDateTimeFormatter()
    relative.locale = locale
    relative.dateTimeStyle = .named
    var parts = DateComponents()
    if days > -30 {
      parts.day = days
    } else if days > -365 {
      parts.month = Int((Double(days) / 30).rounded())
    } else {
      parts.year = Int((Double(days) / 365).rounded())
    }
    return relative.localizedString(from: parts)
  }

  /// The server's ISO 8601 dates, with or without fractions of a second.
  public static func parseDate(_ iso: String) -> Date? {
    let precise = ISO8601DateFormatter()
    precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return precise.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  }
}
