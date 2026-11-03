import PlayarrAPI
import SwiftUI

/// "Request the rest" on an album page: only some of the album is here, so ask Lidarr for the whole of it, then show
/// how that's going (components/Discover.tsx RequestRest).
public struct RequestRestButton: View {
  let album: Album

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(album: Album) {
    self.album = album
  }

  public var body: some View {
    if let rest = context?.requests.rest(of: album) {
      RequestButton(album: rest.album, availability: rest.availability)
    }
  }
}
