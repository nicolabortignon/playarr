import Foundation
import Observation
import PlayarrAPI

/// "Songs like these" under your own playlist: ListenBrainz neighbours, split into songs you have (Add) and songs you
/// don't (phase 8's Request button). Other suggestions asks for another set (apps/web/src/components/PlaylistRecommendations.tsx).
@MainActor @Observable
final class RecommendationsModel {
  static let missingPreview = 8

  private(set) var recommendations: Recommendations?
  private(set) var error: String?
  private(set) var loading = false
  private(set) var variant = 0
  var showAll = false
  /// Songs added from here: they leave the list.
  private(set) var added: Set<String> = []

  @ObservationIgnored private let playlist: PlaylistModel

  init(playlist: PlaylistModel) {
    self.playlist = playlist
  }

  /// Nothing to show: no songs to start from.
  var hidden: Bool { recommendations?.seedCount == 0 }
  var owned: [RecommendedTrack] { (recommendations?.owned ?? []).filter { !added.contains($0.recordingId) } }
  var missing: [RecommendedTrack] { recommendations?.missing ?? [] }
  var shownMissing: [RecommendedTrack] { showAll ? missing : Array(missing.prefix(Self.missingPreview)) }
  /// "Show all 14" / "Show fewer", when there are more than the preview.
  var moreLabel: String? { missing.count > Self.missingPreview ? (showAll ? "Show fewer" : "Show all \(missing.count)") : nil }
  /// ListenBrainz knows nothing to suggest.
  var empty: Bool { recommendations != nil && owned.isEmpty && missing.isEmpty }

  /// Keeps the last set on screen while the next one comes.
  func load() async {
    loading = true
    defer { loading = false }
    do {
      recommendations = try await playlist.session.api.send(API.Playlists.recommendations(id: playlist.id, variant: variant))
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  func newMix() async {
    variant += 1
    showAll = false
    await load()
  }

  func add(_ recommendation: RecommendedTrack) async {
    guard let track = recommendation.track else { return }
    if await playlist.add([track]) { added.insert(recommendation.recordingId) }
  }

  func play(_ recommendation: RecommendedTrack) {
    guard let track = recommendation.track else { return }
    playlist.session.player.play([track])
  }

  /// Where a row's artist leads (lib/links.ts artistHref): the library's artist, else the discography.
  static func artist(_ recommendation: RecommendedTrack) -> DiscoverDestination {
    .artist(id: recommendation.artistId, mbid: recommendation.artistMbid, name: recommendation.artistName)
  }

  /// Where a row's album leads: its page when (some of) it is in the library, else the artist's discography with it
  /// highlighted (PlaylistRecommendations.tsx Row).
  static func album(_ recommendation: RecommendedTrack) -> DiscoverDestination {
    let here = recommendation.availability.flatMap { $0.state == .available || $0.have != nil ? $0.albumId : nil }
    return .album(
      id: recommendation.track?.albumId ?? here, artistMbid: recommendation.artistMbid, artistName: recommendation.artistName,
      title: recommendation.albumTitle)
  }
}
