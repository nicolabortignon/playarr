import PlayarrAPI
import SwiftUI

/// "Request the rest" on an album page: only some of the album is here, so ask Lidarr for the whole of it, then show
/// how that's going (components/Discover.tsx RequestRest). The album's own action in its action row.
public struct RequestRestButton: View {
  let album: Album
  /// The action row has no room for its words: an icon.
  var compact: Bool

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(album: Album, compact: Bool = false) {
    self.album = album
    self.compact = compact
  }

  public var body: some View {
    if let rest = context?.requests.rest(of: album) {
      RequestButton(album: rest.album, availability: rest.availability, placement: .actionRow(compact: compact))
    }
  }
}
