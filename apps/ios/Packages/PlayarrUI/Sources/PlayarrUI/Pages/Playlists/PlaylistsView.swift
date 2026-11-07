import PlayarrAPI
import SwiftUI

/// Playlists: "New playlist", then every playlist you can see, with whose it is when it isn't yours
/// (apps/web/src/pages/Playlists.tsx).
struct PlaylistsView: View {
  let session: AccountSession

  var body: some View {
    let store = session.playlists
    ScrollView {
      if let error = store.error {
        ErrorState(message: error) { await store.load() }
      } else if store.playlists?.isEmpty == true {
        EmptyState(
          systemImage: "music.note.list", line: PageLines.playlists,
          fill: .action(EmptyState.Action("New playlist", systemImage: "plus") { session.addToPlaylist([]) }))
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16, alignment: .top)], alignment: .leading, spacing: 24) {
          Button { session.addToPlaylist([]) } label: {
            VStack(spacing: 12) {
              Image(systemName: "plus").font(.title2).frame(width: 48, height: 48).background(Circle().fill(.tint)).foregroundStyle(.black)
              Text("New playlist")
            }
            .frame(width: ShelfCard.width, height: ShelfCard.width)
            .overlay(RoundedRectangle(cornerRadius: Radius.cover).strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4])))
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("playlists.new")
          if let playlists = store.playlists {
            ForEach(playlists) { PlaylistCard(playlist: $0) }
          } else {
            CardSkeletons(count: 11, width: ShelfCard.width)
          }
        }
        .padding(20)
      }
    }
    .pageHeader("Playlists", count: store.playlists.map { Format.plural($0.count, "playlist") })
    .task(id: store.pollRound) { await store.poll() }
    .refreshable { await store.load() }
  }
}
