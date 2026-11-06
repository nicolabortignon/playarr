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

  /// "1 song", "12 songs".
  public static func plural(_ n: Int, _ word: String, _ pluralWord: String? = nil) -> String {
    "\(n) \(n == 1 ? word : pluralWord ?? "\(word)s")"
  }

  /// A rough wait: "4 s", "2 min" (`formatWait`).
  public static func wait(_ seconds: Double) -> String {
    seconds < 60 ? "\(max(1, Int(jsRound(seconds)))) s" : "\(Int(jsRound(seconds / 60))) min"
  }

  /// JavaScript's Math.round: halves go up (Swift's `rounded()` takes -2.5 to -3, JavaScript to -2).
  public static func jsRound(_ value: Double) -> Double { (value + 0.5).rounded(.down) }

  /// A line of phrases joined by dots that wraps only between them, never inside one ("0 of 3 songs · 0 MB ·" over
  /// "3 couldn’t download", not "… · 3" over "couldn’t download"): the spaces inside each phrase don't break, and each dot
  /// stays at the end of the phrase before it.
  public static func wrapsAtDots(_ line: String) -> String {
    line.components(separatedBy: " · ").map { $0.replacingOccurrences(of: " ", with: "\u{00A0}") }.joined(separator: "\u{00A0}· ")
  }

  /// Lossy at this bitrate or more sounds as good as lossy gets: its badge leaves the bitrate out.
  static let ordinaryKbps: Double = 256

  /// What a format badge says (docs/design.md, Words): the codec, and the detail only when it's out of the ordinary.
  /// "MP3" (256 kbps or more), "MP3" with "128 kbps"; "FLAC" (CD quality: 16-bit at 44.1 or 48 kHz), "FLAC" with
  /// "24/96" (`formatBadge` in apps/web/src/lib/format.ts). `details(_:)` has the rest.
  public static func badgeParts(_ format: AudioFormat?) -> (codec: String, detail: String?)? {
    guard let format else { return nil }
    if format.lossless {
      // CD quality is ordinary; more is Hi-Res, and less is worth knowing too.
      let ordinary = format.bits == 16 && (format.sampleRate == 44_100 || format.sampleRate == 48_000)
      guard !ordinary, let bits = format.bits, let rate = format.sampleRate, rate > 0 else { return (format.codec, nil) }
      let khz = Double(rate) / 1000
      let spec = khz == khz.rounded() ? String(Int(khz)) : String(format: "%.1f", khz)
      return (format.codec, "\(bits)/\(spec)")
    }
    guard let bitrate = format.bitrate, bitrate > 0, bitrate < ordinaryKbps else { return (format.codec, nil) }
    return (format.codec, "\(Int(jsRound(bitrate))) kbps")
  }

  /// A badge's words on one line: "MP3 · 128 kbps", "FLAC · 24/96", "FLAC" (`badgeText`).
  public static func badge(_ format: AudioFormat?) -> String? {
    badgeParts(format).map { parts in parts.detail.map { "\(parts.codec) · \($0)" } ?? parts.codec }
  }

  /// Everything about a format, for a badge's accessibility value and Show metadata: "FLAC · 24-bit / 96 kHz · stereo ·
  /// Hi-Res lossless" (`formatDetails`).
  public static func details(_ format: AudioFormat) -> String {
    var parts = [format.codec]
    let depth = [format.bits.map { "\($0)-bit" }, format.sampleRate.map { "\(kilohertz($0)) kHz" }].compactMap(\.self)
    if !depth.isEmpty { parts.append(depth.joined(separator: " / ")) }
    if let bitrate = format.bitrate, bitrate > 0 { parts.append("\(Int(jsRound(bitrate))) kbps") }
    if let channels = format.channels { parts.append(channels == 1 ? "mono" : channels == 2 ? "stereo" : "\(channels) ch") }
    parts.append(isHiRes(format) ? "Hi-Res lossless" : format.lossless ? "lossless" : "lossy")
    return parts.joined(separator: " · ")
  }

  /// 44100 → "44.1", 96000 → "96", as JavaScript writes the division.
  private static func kilohertz(_ rate: Int) -> String {
    let khz = Double(rate) / 1000
    return khz == khz.rounded() ? String(Int(khz)) : String(khz)
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
