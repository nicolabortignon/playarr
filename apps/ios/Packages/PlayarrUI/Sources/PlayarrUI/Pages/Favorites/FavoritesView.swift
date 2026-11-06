import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Favorites: how many songs, the action row (Play, Shuffle, Download, ⋯), then the songs with their hearts
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
          let playState = PlayState.of(session.player.queue, href: FavoritesStore.source.href)
          VStack(alignment: .leading, spacing: 16) {
            Text("\(Format.plural(tracks.count, "song")) · \(Format.duration(favorites.duration))")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
            ActionRow(
              title: "Favorites", playState: playState,
              play: {
                if playState.isCurrent { session.player.togglePlay() } else { session.player.play(tracks, source: FavoritesStore.source) }
              },
              shuffle: { session.player.play(tracks, source: FavoritesStore.source, shuffle: true) },
              download: DownloadButton(
                store: session.player.downloads,
                item: DownloadItem(key: PinnedDownload.Key.favorites, title: "Favorites", subtitle: "Your favorite songs", href: "/favorites"),
                tracks: tracks),
              moreLabel: "More for Favorites"
            ) {
              Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { session.actions.playNext(tracks) }
              Button("Add to queue", systemImage: "text.append") { session.actions.addToQueue(tracks) }
              Button("Add to playlist…", systemImage: "music.note.list") { session.addToPlaylist(tracks) }
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
