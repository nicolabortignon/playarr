/// What every empty and failed page says, the same on both apps (docs/design.md, "Empty, loading and error" → The
/// lines): one line in a record shop's voice, warm and brief, and a quieter one only where the first can't say it all.
/// The pages add the action that fills them (`EmptyState`).
enum PageLines {
  struct Line: Equatable, Sendable {
    let title: String
    var hint: String?

    init(_ title: String, _ hint: String? = nil) {
      self.title = title
      self.hint = hint
    }
  }

  static let queue = Line("The deck’s empty.")
  static let favorites = Line("No hearts yet.", "Heart a song and it lands here.")
  static let downloads = Line(
    "Nothing in the record bag yet.", "Download an album, a playlist or a mix, and it plays here with or without a connection.")
  static let playlists = Line("Make a playlist for a mood, a trip or a friend.")

  /// A playlist with no songs: its owner is told how to add some; anyone else, only that there's nothing yet.
  static func playlist(mine: Bool) -> Line {
    mine
      ? Line("This playlist is waiting for its first song.", "Choose Add to playlist… in any song’s ⋯ menu.")
      : Line("Nothing in this playlist yet.")
  }

  /// No albums: an admin can add music (and gets the button); a member waits for one to.
  static func albums(admin: Bool) -> Line { Line("Your crates are empty.", libraryHint(admin: admin)) }
  static func artists(admin: Bool) -> Line { Line("Nobody on the roster yet.", libraryHint(admin: admin)) }

  private static func libraryHint(admin: Bool) -> String {
    admin ? "Add Lidarr or a folder of music, and it shows up here." : "Music shows up here once an admin adds some."
  }

  static func artist(_ name: String) -> Line { Line("Nothing by \(name) here yet.") }
  static let mixes = Line("Your mixes are on their way.", "They appear as you listen, and as Playarr learns your library.")
  static let stats = Line("No spins in this period yet.", "A song counts once it’s heard for 30 seconds.")

  /// Nothing in the library for what was typed. `beyond`: what's out there beyond the library follows (Lidarr's
  /// results under it); `nothingAnywhere`: beyond was asked too and has nothing, so what to try instead.
  static func search(_ query: String, beyond: Bool = false, nothingAnywhere: Bool = false) -> Line {
    if nothingAnywhere {
      return Line(
        "Not in your crates.",
        "Nothing in your library or beyond it matches “\(query)”. Check the spelling, try fewer words, or pick an artist you have.")
    }
    return Line("Not in your crates.", "Nothing in your library matches “\(query)”." + (beyond ? " Here’s what’s out there:" : ""))
  }

  /// Above results that are a letter or two away from what was typed, so nobody takes them for exact.
  static func near(_ query: String) -> String { "Nothing called “\(query)”. These come close:" }

  /// A whole page that couldn't load; the reason goes under it.
  static let failed = "The needle skipped."
}
