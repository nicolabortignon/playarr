import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Favorites: Play, Shuffle and Download, then the songs with their hearts
/// (apps/web/src/pages/Favorites.tsx).
struct FavoritesView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme

  var body: some View {
    let favorites = session.favorites
    ScrollView {
      if let list = favorites.tracks {
        if list.isEmpty {
          empty
        } else {
          let tracks = list.map(\.track)
          VStack(alignment: .leading, spacing: 16) {
            FlowRow {
              PlayShuffleButtons(title: "Favorites") {
                session.player.play(tracks, source: FavoritesStore.source)
              } shuffle: {
                session.player.play(tracks, source: FavoritesStore.source, shuffle: true)
              }
              DownloadButton(
                store: session.player.downloads,
                item: DownloadItem(key: PinnedDownload.Key.favorites, title: "Favorites", subtitle: "Your favorite songs", href: "/favorites"),
                tracks: tracks)
              Text("\(Format.plural(tracks.count, "song")) · \(Format.duration(favorites.duration))")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }
            LazyVStack(spacing: 0) {
              ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                TrackRow(track: track, style: .mixed) {
                  session.player.play(tracks, startAt: index, source: FavoritesStore.source)
                }
              }
            }
          }
          .padding(.horizontal, 20)
        }
      } else if let error = favorites.error {
        ErrorState(message: error) { await favorites.load() }
      } else {
        LazyVStack(spacing: 12) { ForEach(0..<6, id: \.self) { _ in Skeleton(aspectRatio: nil, height: 56) } }.padding(.horizontal, 20)
      }
    }
    .navigationTitle("Favorites")
    .task { await favorites.load() }
    .refreshable { await favorites.load() }
  }

  private var empty: some View {
    VStack(alignment: .leading, spacing: 12) {
      Image(systemName: "heart").font(.largeTitle).foregroundStyle(.secondary)
      Text("Nothing hearted yet.").font(.display(.title))
      Text("Tap the heart next to any song: in an album, the queue, the player or Now Playing. It shows up here, on every device.")
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(20)
    .padding(.top, 40)
  }
}
