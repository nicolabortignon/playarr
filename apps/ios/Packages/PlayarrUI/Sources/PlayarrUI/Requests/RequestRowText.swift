import Foundation
import PlayarrAPI

/// A Requests row's small print: Lidarr's message or the state, and when it was asked for, and on an admin's list by whom
/// (pages/Requests.tsx).
public enum RequestRowText {
  /// "Downloading 2 of 12 · requested 2 hours ago", "Ready to play · requested yesterday", "Waiting for approval ·
  /// requested by Sam just now".
  public static func status(_ request: AlbumRequest, now: Date = Date(), locale: Locale = .current) -> String {
    "\(state(request)) · \(requested(request, now: now, locale: locale))"
  }

  /// Lidarr's message, or the state: "Downloading 2 of 12", "Ready to play", "Waiting for approval".
  public static func state(_ request: AlbumRequest) -> String {
    let state = request.availability.state
    return request.availability.message ?? (state == .available ? "Ready to play" : state.rawValue)
  }

  /// "requested 2 hours ago", "requested by Sam yesterday", "requested by you and Sam just now" (the web's requestedLine).
  /// Who asked comes only on an admin's list, and an admin's own, asked for by nobody else, needs no name.
  public static func requested(_ request: AlbumRequest, now: Date = Date(), locale: Locale = .current) -> String {
    let others = request.askedBy ?? []
    let who = !others.isEmpty && request.mine == true ? ["you"] + others : others
    let when = ago(request.requestedAt, now: now, locale: locale)
    return who.isEmpty ? "requested \(when)" : "requested by \(names(who)) \(when)"
  }

  /// "Sam", "Sam and Zoe", "you, Sam and Zoe".
  static func names(_ list: [String]) -> String {
    guard list.count > 1, let last = list.last else { return list.first ?? "" }
    return "\(list.dropLast().joined(separator: ", ")) and \(last)"
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
