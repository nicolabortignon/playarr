import Observation
import PlayarrAPI

/// Songs from outside the library only know an artist's name: look it up, then go where it leads (FindArtist.tsx).
@MainActor @Observable
public final class FindArtistModel {
  public let name: String
  public let album: String?
  public private(set) var destination: DiscoverDestination?
  public private(set) var error: String?

  @ObservationIgnored private let api: any APISending

  public init(api: any APISending, name: String, album: String? = nil) {
    self.api = api
    self.name = name
    self.album = album
  }

  public func load() async {
    guard !name.isEmpty else {
      error = "No artist given."
      return
    }
    do {
      let match = try await api.send(API.Discover.findArtist(name: name))
      destination = .found(match, name: name, album: album)
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }
}
