import PlayarrAPI
import SwiftUI

/// Every album, sorted by Artist, Title, Year or Recently added (apps/web/src/pages/Albums.tsx).
struct AlbumsView: View {
  @State private var model: AlbumsModel
  let session: AccountSession

  init(session: AccountSession, sort: AlbumSort) {
    self.session = session
    _model = State(initialValue: AlbumsModel(session: session, sort: sort))
  }

  var body: some View {
    ScrollView {
      if let error = model.albums.error {
        ErrorState(message: error) { await model.albums.refresh() }
      } else if model.albums.value?.isEmpty == true {
        LibraryEmptyState(systemImage: "square.stack", line: PageLines.albums, session: session)
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)], spacing: 24) {
          if let albums = model.albums.value {
            ForEach(albums) { AlbumCard(album: $0) }
          } else {
            CardSkeletons()
          }
        }
        .padding(20)
      }
    }
    .pageHeader("Albums", count: model.albums.value.map { Format.plural($0.count, "album") })
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Menu {
          Picker("Sort albums", selection: $model.sort) {
            ForEach(AlbumsModel.sorts, id: \.sort) { Text($0.label).tag($0.sort) }
          }
        } label: {
          Label("Sort albums", systemImage: "arrow.up.arrow.down")
        }
      }
    }
    .task(id: model.sort) { await model.albums.load() }
    .refreshable { await model.albums.refresh() }
  }
}
