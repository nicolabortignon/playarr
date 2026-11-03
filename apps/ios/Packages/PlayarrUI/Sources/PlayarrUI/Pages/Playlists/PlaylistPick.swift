import Foundation
import PlayarrAPI

/// Songs waiting for "Add to playlist" (none: "New playlist"), shown by the sheet on the signed-in app.
public struct PlaylistPick: Identifiable {
  public let id = UUID()
  public let tracks: [Track]
}
