import Foundation
import PlayarrAPI

/// How "Review matches" describes a MusicBrainz candidate (ReviewDialog.tsx: summary, CandidateDetails).
enum ReviewText {
  /// "Mezzanine · Massive Attack": what the files say.
  static func yourAlbum(_ group: ReviewGroup) -> String { "\(group.albumTitle ?? "No album") · \(group.artistName)" }

  /// MusicBrainz country codes, including its own XE (Europe) and XW (worldwide).
  static func countryName(_ code: String?, locale: Locale = .current) -> String? {
    guard let code, !code.isEmpty else { return nil }
    switch code {
    case "XE": return "Europe"
    case "XW": return "Worldwide"
    case "XU": return nil
    default: return locale.localizedString(forRegionCode: code) ?? code
    }
  }

  /// "1998-04-20" → "20 Apr 1998", "1998-04" → "Apr 1998", "1998" stays (in the device's way).
  static func releaseDate(_ date: String?, locale: Locale = .current) -> String? {
    guard let date else { return nil }
    let parts = date.split(separator: "-").map { Int($0) ?? 0 }
    guard let year = parts.first, year > 0 else { return date }
    guard parts.count > 1, parts[1] > 0 else { return String(year) }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
    let day = parts.count > 2 ? parts[2] : 0
    guard let value = calendar.date(from: DateComponents(year: year, month: parts[1], day: max(day, 1))) else { return date }
    var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).year().month(.abbreviated)
    if day > 0 { style = style.day() }
    return value.formatted(style)
  }

  /// The second line of a candidate: who, when, where, on what.
  static func summary(_ c: ReviewCandidate, locale: Locale = .current) -> String {
    [
      c.artistName,
      releaseDate(c.date, locale: locale) ?? c.year.map(String.init),
      countryName(c.country, locale: locale),
      c.labels?.first(where: { $0.name != nil })?.name,
      c.format,
      c.type,
      AdminText.plural(c.tracks.count, "track"),
      c.status != nil && c.status != "Official" ? c.status : nil,
    ].compactMap { $0 }.joined(separator: " · ")
  }

  static func score(_ c: ReviewCandidate) -> String { "\(Int((c.score * 100).rounded()))%" }

  /// Rows that only arrive with the edition details: shown as placeholders (nil) while those load.
  static let detailRows: Set<String> = ["Released", "Country", "Label", "Format"]

  /// Everything MusicBrainz says about the chosen edition. A nil value is a placeholder while details load.
  static func details(_ c: ReviewCandidate, locale: Locale = .current) -> [(label: String, value: String?)] {
    let released = releaseDate(c.date, locale: locale)
    let firstYear = c.year.flatMap { year in released?.hasSuffix(String(year)) == false ? String(year) : nil }
    let labels = c.labels?.map { [$0.name, $0.catalogNumber].compactMap { $0 }.joined(separator: " · ") }.joined(separator: ", ")
    let edition = [c.releaseTitle, c.disambiguation].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    let rows: [(String, String?)] = [
      ("Artist", c.artistName),
      ("Album", c.title),
      ("Edition", edition.isEmpty ? nil : edition),
      ("Released", released),
      ("First released", firstYear ?? (c.date == nil ? c.year.map(String.init) : nil)),
      ("Country", countryName(c.country, locale: locale)),
      ("Label", labels?.isEmpty == false ? labels : nil),
      ("Format", c.format),
      ("Type", c.type),
      ("Status", c.status),
      ("Tracks", String(c.tracks.count)),
      ("Barcode", c.barcode),
    ]
    return rows.filter { $0.1 != nil || (!c.detailed && detailRows.contains($0.0)) }.map { (label: $0.0, value: $0.1) }
  }

  /// Each file beside the candidate's song it was matched to: "1. Angel 6:19", or nil (not on this album).
  static func matched(_ file: ReviewFile, in c: ReviewCandidate) -> String? {
    guard let index = c.matches[file.rel], c.tracks.indices.contains(index) else { return nil }
    let track = c.tracks[index]
    return "\(track.position). \(track.title) \(AdminText.time(track.duration))"
  }

  static func musicBrainzURL(_ c: ReviewCandidate) -> URL? {
    URL(string: "https://musicbrainz.org/release/\(c.releaseId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? c.releaseId)")
  }
}
