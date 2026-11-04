import CoreTransferable
import PlayarrAPI
import UniformTypeIdentifiers

extension UTType {
  /// Songs dragged inside Playarr. Declared in Config/Info.plist (`UTExportedTypeDeclarations`).
  public static let playarrTracks = UTType(exportedAs: "me.tracklistme.playarr.tracks")
}

/// Songs being dragged (a song row, on iPad): dropped on one of your playlists in the sidebar, or on the queue.
public struct TrackDrag: Codable, Transferable, Sendable, Equatable {
  public var tracks: [Track]

  public init(tracks: [Track]) {
    self.tracks = tracks
  }

  public static var transferRepresentation: some TransferRepresentation {
    CodableRepresentation(contentType: .playarrTracks)
  }

  /// The songs of everything dropped at once, in order.
  public static func tracks(_ drops: [TrackDrag]) -> [Track] {
    drops.flatMap(\.tracks)
  }

  /// Only your own playlists take songs: a playlist shared with you is changed by its owner.
  public static func accepts(_ playlist: PlaylistSummary) -> Bool {
    playlist.mine
  }
}
