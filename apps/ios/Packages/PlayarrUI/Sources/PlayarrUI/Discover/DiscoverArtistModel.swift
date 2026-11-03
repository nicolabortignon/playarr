import Observation
import PlayarrAPI

/// The Discover artist page: an artist's MusicBrainz discography with what's in the library and what can be
/// requested (pages/DiscoverArtist.tsx).
@MainActor @Observable
public final class DiscoverArtistModel {
  public let mbid: String
  public let wantedAlbum: String?
  public private(set) var artist: DiscoverArtistDetail?
  public private(set) var error: String?
  public private(set) var loading = false

  @ObservationIgnored private let context: DiscoverContext

  public init(context: DiscoverContext, mbid: String, album: String? = nil) {
    self.context = context
    self.mbid = mbid
    wantedAlbum = album
  }

  public var discography: Discography? { artist.map { Discography($0, wanted: wantedAlbum) } }

  /// Loads (or loads again: "Try again" after MusicBrainz failed, or after a request changed what's here).
  public func load(again: Bool = false) async {
    if again { context.invalidate([.discoverArtist]) }
    loading = true
    defer { loading = false }
    do {
      artist = try await context.discoverArtist(mbid)
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }
}
