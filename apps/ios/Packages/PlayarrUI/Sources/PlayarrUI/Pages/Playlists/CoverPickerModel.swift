import Observation
import PlayarrAPI

/// "New cover": one candidate per style, drawn by the server from the playlist's songs as they are now;
/// Shuffle asks for other variations (components/CoverPicker.tsx).
@MainActor @Observable
final class CoverPickerModel {
  /// The six layouts, in the picker's order, with their names.
  static let styles: [(layout: CoverLayout, label: String)] = [
    (.currents, "Currents"), (.colonies, "Colonies"), (.horizon, "Horizon"), (.ridges, "Ridges"), (.grooves, "Grooves"), (.blocks, "Blocks"),
  ]

  let playlistId: Int
  let intro: String
  /// About this cover: what the songs are like, and whether it's still being drawn or the songs have moved on from it.
  let note: CoverNote
  /// Starts past the cover's own variation, so every candidate is new.
  private(set) var variant: Int
  var chosen: CoverLayout

  init(playlist: PlaylistDetail) {
    playlistId = playlist.id
    intro = "Drawn from the \(playlist.trackCount) songs in this playlist as they are now."
    note = CoverNote(playlist.cover)
    variant = playlist.cover.variant + 1
    chosen = playlist.cover.layout
  }

  func shuffle() { variant += 1 }

  /// The server path of a candidate (the image loader adds `size`), as MediaURLs.playlistCoverPreview builds it.
  func preview(_ layout: CoverLayout) -> String {
    "/art/playlist/\(playlistId)/preview?layout=\(layout.rawValue)&variant=\(variant)"
  }
}
