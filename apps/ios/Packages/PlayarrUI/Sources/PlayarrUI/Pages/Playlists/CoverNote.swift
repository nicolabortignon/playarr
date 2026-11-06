import PlayarrAPI

/// What the generated cover is made of, so it reads as a portrait of the music rather than decoration: the cover
/// picker's "About this cover" (components/CoverPicker.tsx AboutCover).
struct CoverNote: Equatable {
  /// "Listening to the songs to draw the cover… 3 of 12" while it's still being drawn.
  var listening: String?
  /// How the cover's own layout draws the songs (`story(_:)` for another's).
  var story: String
  /// "120 BPM · Electronic / House · 1990–1999 · energy 72%".
  var facts: String
  /// The playlist changed a lot since the cover was drawn.
  var stale: Bool

  init(_ cover: PlaylistCoverInfo) {
    listening = cover.pending && !cover.frozen ? "Listening to the songs to draw the cover… \(cover.analyzed) of \(cover.total)" : nil
    story = Self.story(cover.layout)
    var facts: [String] = []
    if let tempo = cover.tempo, tempo > 0 { facts.append("\(tempo.formatted(.number.precision(.fractionLength(0...1)).grouping(.never))) BPM") }
    if !cover.styles.isEmpty { facts.append(cover.styles.joined(separator: " / ")) }
    if let era = cover.era, let from = era.first, let to = era.last { facts.append(from == to ? String(from) : "\(from)–\(to)") }
    facts.append("energy \(Int((cover.energy * 100).rounded()))%")
    self.facts = facts.joined(separator: " · ")
    stale = cover.stale
  }

  static func story(_ layout: CoverLayout) -> String {
    switch layout {
    case .ridges: "Each line is a song, traced from its loudness over time."
    case .grooves: "A record of the playlist: each band of grooves is a song, as wide as it is long."
    case .blocks: "A tile per song, sized by its length; each shape follows how it sounds."
    case .horizon: "Each hill is a song’s loudness over time. The slower the music, the bigger the sun."
    case .currents: "Each ribbon belongs to a song: a steady beat flows smoothly, free time swirls; louder songs run wider."
    case .colonies: "Each style is a slime-mold species in its own color, growing with its songs’ tempo and beat."
    case .unknown: "Drawn from what the songs sound like."
    }
  }
}
