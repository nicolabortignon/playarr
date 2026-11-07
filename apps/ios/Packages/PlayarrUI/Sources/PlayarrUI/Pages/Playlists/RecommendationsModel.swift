import Foundation
import Observation
import PlayarrAPI

/// "Songs like these" under your own playlist or Favorites: ListenBrainz neighbors, split into songs you have (Add puts
/// one in the playlist, or hearts it) and songs you don't (phase 8's Request button). Other suggestions asks for another
/// set (apps/web/src/components/SongsLikeThese.tsx).
@MainActor @Observable
final class RecommendationsModel {
  /// The songs it starts from (apps/web/src/lib/queries.ts RecommendationSource).
  private enum Source {
    case playlist(PlaylistModel)
    case favorites
  }

  static let missingPreview = 8

  private(set) var recommendations: Recommendations?
  private(set) var error: String?
  private(set) var loading = false
  private(set) var variant = 0
  var showAll = false
  /// Songs added from here: they leave the list.
  private(set) var added: Set<String> = []

  @ObservationIgnored private let source: Source
  @ObservationIgnored private let session: AccountSession

  init(playlist: PlaylistModel) {
    source = .playlist(playlist)
    session = playlist.session
  }

  init(favoritesOf session: AccountSession) {
    source = .favorites
    self.session = session
  }

  /// Nothing to show: no songs to start from.
  var hidden: Bool { recommendations?.seedCount == 0 }
  var owned: [RecommendedTrack] { (recommendations?.owned ?? []).filter { !added.contains($0.recordingId) && !hearted($0) } }
  var missing: [RecommendedTrack] { recommendations?.missing ?? [] }
  var shownMissing: [RecommendedTrack] { showAll ? missing : Array(missing.prefix(Self.missingPreview)) }
  /// "Show all 14" / "Show fewer", when there are more than the preview.
  var moreLabel: String? { missing.count > Self.missingPreview ? (showAll ? "Show fewer" : "Show all \(missing.count)") : nil }
  /// ListenBrainz knows nothing to suggest.
  var empty: Bool { recommendations != nil && owned.isEmpty && missing.isEmpty }

  /// What to say when ListenBrainz knows nothing to suggest: how to give it more to go on.
  var emptyLine: String {
    let more = switch source {
    case .playlist: "add a few more songs"
    case .favorites: "heart a few more songs"
    }
    return "ListenBrainz doesn’t know these songs well enough to suggest anything yet. Try other suggestions, or \(more)."
  }

  /// Add's words for VoiceOver: "Add Teardrop to playlist", "Add Teardrop to Favorites".
  func addLabel(_ recommendation: RecommendedTrack) -> String {
    switch source {
    case .playlist: "Add \(recommendation.title) to playlist"
    case .favorites: "Add \(recommendation.title) to Favorites"
    }
  }

  /// Keeps the last set on screen while the next one comes.
  func load() async {
    loading = true
    defer { loading = false }
    do {
      recommendations = try await session.api.send(endpoint)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  private var endpoint: Endpoint<Recommendations> {
    switch source {
    case .playlist(let playlist): API.Playlists.recommendations(id: playlist.id, variant: variant)
    case .favorites: API.Favorites.recommendations(variant: variant)
    }
  }

  func newMix() async {
    variant += 1
    showAll = false
    await load()
  }

  func add(_ recommendation: RecommendedTrack) async {
    guard let track = recommendation.track else { return }
    switch source {
    case .playlist(let playlist):
      if await playlist.add([track]) { added.insert(recommendation.recordingId) }
    case .favorites:
      // The heart shows at once (the song leaves here and joins Favorites) and goes back, with a toast, if the server says
      // no. Once it's taken, a toast says so, as a playlist's Add does.
      await session.favorites.set(track, favorite: true)
      guard session.favorites.isFavorite(track.recordingId) else { return }
      added.insert(recommendation.recordingId)
      session.toasts.push("Added \(TrackActions.named([track])) to Favorites")
    }
  }

  /// On Favorites, a song hearted meanwhile (the player's heart) isn't suggested any more.
  private func hearted(_ recommendation: RecommendedTrack) -> Bool {
    guard case .favorites = source, let track = recommendation.track else { return false }
    return session.favorites.isFavorite(track.recordingId)
  }

  func play(_ recommendation: RecommendedTrack) {
    guard let track = recommendation.track else { return }
    session.player.play([track])
  }

  /// Where a row's artist leads (lib/links.ts artistHref): the library's artist, else the discography.
  static func artist(_ recommendation: RecommendedTrack) -> DiscoverDestination {
    .artist(id: recommendation.artistId, mbid: recommendation.artistMbid, name: recommendation.artistName)
  }

  /// Where a row's album leads: its page when (some of) it is in the library, else the artist's discography with it
  /// highlighted (SongsLikeThese.tsx Row).
  static func album(_ recommendation: RecommendedTrack) -> DiscoverDestination {
    let here = recommendation.availability.flatMap { $0.state == .available || $0.have != nil ? $0.albumId : nil }
    return .album(
      id: recommendation.track?.albumId ?? here, artistMbid: recommendation.artistMbid, artistName: recommendation.artistName,
      title: recommendation.albumTitle)
  }
}
