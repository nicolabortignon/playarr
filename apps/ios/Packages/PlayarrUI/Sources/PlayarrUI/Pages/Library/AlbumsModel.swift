import Foundation
import Observation
import PlayarrAPI

/// Albums, sorted by Artist, Title, Year or Recently added (apps/web/src/pages/Albums.tsx), a page at a time (plan 3
/// §1): the first from the cache at once and kept there, the next ones as the list nears its end. A collector's 11,000
/// albums were 4.4 MB at once; a page is 120.
@MainActor @Observable
final class AlbumsModel {
  static let sorts: [(sort: AlbumSort, label: String)] = [(.artist, "Artist"), (.title, "Title"), (.year, "Year"), (.added, "Recently added")]
  /// Albums a page.
  static let pageSize = 120

  var sort: AlbumSort {
    didSet {
      first = Self.query(sort, session: session)
      more = []
      moreFailed = false
    }
  }
  /// The first page (an older server's whole list), cached.
  private(set) var first: Query<AlbumPage>
  /// The albums of the pages read after it.
  private(set) var more: [Album] = []
  private(set) var loadingMore = false
  /// The last page asked for didn't come (offline, say): the grid offers to ask again.
  private(set) var moreFailed = false

  @ObservationIgnored private let session: AccountSession

  init(session: AccountSession, sort: AlbumSort) {
    self.session = session
    self.sort = sort
    first = Self.query(sort, session: session)
  }

  /// The albums read so far, in order.
  var albums: [Album]? { first.value.map { $0.albums + more } }
  /// How many there are in all.
  var total: Int? { first.value?.total }
  /// Pages are left to read.
  var hasMore: Bool { (albums?.count ?? 0) < (total ?? 0) }

  func load() async { await first.load() }

  /// Pull to refresh, Try again: from the first page.
  func refresh() async {
    more = []
    moreFailed = false
    await first.refresh()
  }

  /// The next page. One read after the library changed (another version) starts again from the first, as the pages
  /// before it may have moved. A failure keeps what's shown, and says so (`moreFailed`) for the next try.
  func loadMore() async {
    guard hasMore, !loadingMore, let page = first.value else { return }
    loadingMore = true
    moreFailed = false
    defer { loadingMore = false }
    let (sort, read) = (sort, more.count)
    let next: AlbumPage
    do {
      next = try await session.api.send(API.Library.albumPage(sort: sort, offset: page.albums.count + read, limit: Self.pageSize)).page
    } catch {
      moreFailed = !(error is CancellationError)
      return
    }
    // Still the list this page goes on: not another sort, nor read again meanwhile (pull to refresh).
    guard sort == self.sort, more.count == read, first.value?.version == page.version else { return }
    guard next.version == page.version else { return await refresh() }
    more += next.albums
  }

  static func query(_ sort: AlbumSort, session: AccountSession) -> Query<AlbumPage> {
    let api = session.api
    return Query(.albums(sort), cache: session.queries) {
      try await api.send(API.Library.albumPage(sort: sort, offset: 0, limit: pageSize)).page
    }
  }
}
