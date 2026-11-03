import PlayarrAPI
import SwiftUI

/// The song menu's "Show metadata" and (with DJ mix on) "Edit mix points", for phase 4's track menus and Now Playing.
public struct TrackLibraryMenuItems: View {
  let track: Track

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(track: Track) {
    self.track = track
  }

  public var body: some View {
    if let sheets = context?.sheets {
      Button("Show metadata", systemImage: "info.circle") { sheets.showMetadata(track.id) }
      if sheets.offersMixPoints(for: track) {
        Button("Edit mix points", systemImage: "waveform") { sheets.editMixPoints(track) }
      }
    }
  }
}
