import Foundation
import PlayarrAPI

/// A Requests row's small print: Lidarr's message or the state, and when it was asked for (pages/Requests.tsx).
public enum RequestRowText {
  /// "Downloading 2 of 12 · requested 2 hours ago", "Ready to play · requested yesterday".
  public static func status(_ request: AlbumRequest, now: Date = Date(), locale: Locale = .current) -> String {
    let state = request.availability.state
    let what = request.availability.message ?? (state == .available ? "Ready to play" : state.rawValue)
    return "\(what) · requested \(ago(request.requestedAt, now: now, locale: locale))"
  }

  /// The web's ago(): days, hours or minutes, rounded, said the natural way ("yesterday"); under a minute "just now".
  public static func ago(_ iso: String, now: Date = Date(), locale: Locale = .current) -> String {
    guard let date = Format.parseDate(iso) else { return "" }
    let seconds = date.timeIntervalSince(now)
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = locale
    formatter.dateTimeStyle = .named
    for (unit, size) in [(Calendar.Component.day, 86_400.0), (.hour, 3_600), (.minute, 60)] where abs(seconds) >= size {
      var parts = DateComponents()
      parts.setValue(Int(Format.jsRound(seconds / size)), for: unit)
      return formatter.localizedString(from: parts)
    }
    return "just now"
  }
}
