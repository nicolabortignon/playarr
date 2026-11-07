import PlayarrAPI
import SwiftUI

/// Every album, sorted by Artist, Title, Year or Recently added (apps/web/src/pages/Albums.tsx), read a page at a time as
/// the grid nears its end (`AlbumsModel`).
struct AlbumsView: View {
  @State private var model: AlbumsModel
  let session: AccountSession

  init(session: AccountSession, sort: AlbumSort) {
    self.session = session
    _model = State(initialValue: AlbumsModel(session: session, sort: sort))
  }

  var body: some View {
    ScrollView {
      if let error = model.first.error {
        ErrorState(message: error) { await model.refresh() }
      } else if model.albums?.isEmpty == true {
        LibraryEmptyState(systemImage: "square.stack", line: PageLines.albums, session: session)
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)], spacing: 24) {
          if let albums = model.albums {
            ForEach(albums) { AlbumCard(album: $0) }
          } else {
            CardSkeletons()
          }
        }
        .padding(20)
        if model.hasMore {
          Group {
            if model.moreFailed {
              Button("Load more albums", systemImage: "arrow.clockwise") { Task { await model.loadMore() } }
            } else {
              // Made as the grid nears its end: the next page, and the one after while it stays in view.
              ProgressView().task(id: model.albums?.count) { await model.loadMore() }
            }
          }
          .padding(.bottom, 24)
        }
      }
    }
    .pageHeader("Albums", count: model.total.map { Format.plural($0, "album") })
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
    .task(id: model.sort) { await model.load() }
    .refreshable { await model.refresh() }
  }
}
