import Foundation

extension Format {
  /// MusicBrainz's secondary types that name what a release is on their own.
  private static let secondaryKinds = [
    "compilation": "Compilation", "soundtrack": "Soundtrack", "spokenword": "Spoken word", "interview": "Interview",
    "audiobook": "Audiobook", "audio drama": "Audio drama", "dj-mix": "DJ mix", "mixtape/street": "Mixtape",
    "field recording": "Field recording",
  ]
  private static let primaryKinds = ["album": "Album", "ep": "EP", "single": "Single", "broadcast": "Broadcast", "other": "Release", "loose": "Loose songs"]

  /// What a release is, from its MusicBrainz types, for a kicker or a card: "Album", "EP", "Live album", "Soundtrack"
  /// (`releaseKind` in apps/web/src/lib/format.ts). Live, remix and demo describe the primary type ("Live EP"); the
  /// other secondary types replace it.
  public static func releaseKind(_ type: String, _ secondaryTypes: [String] = []) -> String {
    let primary = primaryKinds[type.lowercased()] ?? (type.isEmpty ? "Album" : type)
    guard let secondary = secondaryTypes.first?.lowercased(), !secondary.isEmpty else { return primary }
    let named = secondary.prefix(1).uppercased() + secondary.dropFirst()
    if ["live", "remix", "demo"].contains(secondary) {
      let noun = primary == "EP" ? "EP" : primary == "Release" || primary == "Loose songs" ? "album" : primary.lowercased()
      return "\(named) \(noun)"
    }
    return secondaryKinds[secondary] ?? named
  }
}
