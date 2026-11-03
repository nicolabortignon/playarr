import PlayarrAPI
import SwiftUI

/// Every album, sorted by Artist, Title, Year or Recently added (apps/web/src/pages/Albums.tsx).
struct AlbumsView: View {
  @State private var model: AlbumsModel

  init(session: AccountSession, sort: AlbumSort) {
    _model = State(initialValue: AlbumsModel(session: session, sort: sort))
  }

  var body: some View {
    ScrollView {
      if let error = model.albums.error {
        ErrorState(message: error) { await model.albums.refresh() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 24) {
          if let albums = model.albums.value {
            ForEach(albums) { AlbumCard(album: $0) }
          } else {
            ForEach(0..<12, id: \.self) { _ in Skeleton() }
          }
        }
        .padding(20)
      }
    }
    .navigationTitle("Albums")
    .navigationSubtitle(model.albums.value.map { Format.plural($0.count, "album") } ?? "")
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
