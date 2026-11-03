import Observation
import PlayarrAPI
import PlayarrPlayer

/// Which song sheet is open: Show metadata or Edit mix points (the web's useUI metadataTrackId and mixPointsTrack).
/// Song menus anywhere open them; the app's root presents them once (`trackSheets(player:)`).
@MainActor @Observable
public final class TrackSheets {
  /// A song id, for `.sheet(item:)`.
  public struct MetadataTarget: Identifiable, Hashable, Sendable {
    public let id: Int
  }

  public var metadata: MetadataTarget?
  public var mixPoints: Track?
  /// Settings → Playback on this device: Edit mix points is offered only with DJ mix on.
  @ObservationIgnored public var settings: PlaybackSettings?
  /// The player forgets a song's mix map and asks again for a coming transition made with old points (phase 5).
  @ObservationIgnored public var cuesChanged: @MainActor (String) -> Void = { _ in }

  public init() {}

  public func showMetadata(_ trackId: Int) { metadata = MetadataTarget(id: trackId) }

  public func editMixPoints(_ track: Track) { mixPoints = track }

  /// "Edit mix points" belongs in this song's menu: DJ mix is on (the only setting that uses them) and the song has
  /// a recording id to save them under.
  public func offersMixPoints(for track: Track) -> Bool {
    settings?.transitions == .dj && !track.recordingId.isEmpty
  }
}
