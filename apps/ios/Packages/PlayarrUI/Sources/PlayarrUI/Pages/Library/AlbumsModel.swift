import Foundation
import Observation
import PlayarrAPI

/// Albums, sorted by Artist, Title, Year or Recently added (apps/web/src/pages/Albums.tsx).
@MainActor @Observable
final class AlbumsModel {
  static let sorts: [(sort: AlbumSort, label: String)] = [(.artist, "Artist"), (.title, "Title"), (.year, "Year"), (.added, "Recently added")]

  var sort: AlbumSort {
    didSet { albums = Self.query(sort, session: session) }
  }
  private(set) var albums: Query<[Album]>

  @ObservationIgnored private let session: AccountSession

  init(session: AccountSession, sort: AlbumSort) {
    self.session = session
    self.sort = sort
    albums = Self.query(sort, session: session)
  }

  static func query(_ sort: AlbumSort, session: AccountSession) -> Query<[Album]> {
    let api = session.api
    return Query(.albums(sort), cache: session.queries) { try await api.send(API.Library.albums(sort: sort)) }
  }
}
