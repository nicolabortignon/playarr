import PlayarrPlayer
import SwiftUI

extension PinnedDownload {
  /// The library pages a download needs to be browsed offline, by their query keys (`QueryKey`, the web's names in
  /// apps/web/src/lib/queries.ts): its own page and the list that leads to it (Library → Albums opens sorted by
  /// artist). Mix pages aren't among the kept families; a downloaded one is.
  public var pageKeys: [[String]] {
    let parts = key.split(separator: ":", maxSplits: 1).map(String.init)
    switch (parts.first, parts.count) {
    case ("album", 2): return [["album", parts[1]], ["albums", AlbumSortName.library]]
    case ("playlist", 2): return [["playlist", parts[1]], ["playlists"]]
    case ("mix", 2): return [["mix", parts[1]], ["mixes"]]
    default: return [["favorites"]]
    }
  }
}

/// The sort Library → Albums opens with, as its query key names it.
private enum AlbumSortName {
  static let library = QueryKey.albums(.artist).parts[0]
}

extension View {
  /// Keeps the pages of downloaded albums, playlists, mixes and Favorites in the query cache for as long as they're
  /// downloaded: `pin` gets every download's page keys whenever downloads change.
  public func pinningDownloadedPages(_ store: DownloadStore?, pin: @escaping (Set<[String]>) -> Void) -> some View {
    let keys = Set(store?.downloads.flatMap(\.pageKeys) ?? [])
    return onChange(of: keys, initial: true) { _, keys in pin(keys) }
  }
}
