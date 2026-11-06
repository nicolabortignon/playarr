import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Favorites: its header (a heart for a cover, how many songs, the action row: Play, Shuffle, Download, ⋯), then the
/// songs with their hearts (apps/web/src/pages/Favorites.tsx).
struct FavoritesView: View {
  let session: AccountSession

  var body: some View {
    let favorites = session.favorites
    let tracks = favorites.tracks?.map(\.track) ?? []
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        DetailHeader(kicker: "Songs you love") {
          FavoritesCover()
        } title: {
          DetailTitle("Favorites")
        } meta: {
          if !tracks.isEmpty { MetaLine(Format.plural(tracks.count, "song"), Format.duration(favorites.duration)) }
        } actions: {
          // Held in place (disabled) while the songs load, so nothing moves when they arrive.
          if favorites.tracks == nil || !tracks.isEmpty { buttons(tracks) }
        }
        if let list = favorites.tracks {
          if list.isEmpty {
            empty
          } else {
            LazyVStack(spacing: 0) {
              ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                TrackRow(track: track, style: .mixed) {
                  session.player.play(tracks, startAt: index, source: FavoritesStore.source)
                }
              }
            }
          }
        } else if let error = favorites.error {
          ErrorState(message: error) { await favorites.load() }
        } else {
          LazyVStack(spacing: 12) { ForEach(0..<6, id: \.self) { _ in Skeleton(aspectRatio: nil, height: 56) } }
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 12)
      .padding(.bottom, 20)
    }
    .titleInBar("Favorites")
    .task { await favorites.load() }
    .refreshable { await favorites.load() }
  }

  private func buttons(_ tracks: [Track]) -> some View {
    let playState = PlayState.of(session.player.queue, href: FavoritesStore.source.href)
    return ActionRow(
      title: "Favorites", playState: playState, disabled: tracks.isEmpty,
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
  }

  private var empty: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Nothing hearted yet.").font(.display(.title))
      Text("Tap the heart next to any song: in an album, the queue, the player or Now Playing. It shows up here, on every device.")
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 24)
  }
}

/// Favorites' cover, as it has no art of its own: a heart on a wash of the accent (pages/Favorites.tsx FavoritesCover).
struct FavoritesCover: View {
  @Environment(Theme.self) private var theme

  var body: some View {
    let accent = theme.accent.color
    LinearGradient(
      stops: [.init(color: accent.opacity(0.55), location: 0), .init(color: accent.opacity(0.15), location: 0.5), .init(color: Color(white: 0.1), location: 1)],
      startPoint: .topLeading, endPoint: .bottomTrailing
    )
    .aspectRatio(1, contentMode: .fit)
    .overlay {
      GeometryReader { box in
        Image(systemName: "heart.fill")
          .resizable()
          .scaledToFit()
          .frame(width: box.size.width * 0.34)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .foregroundStyle(.paper)
    }
    .clipShape(RoundedRectangle(cornerRadius: Radius.cover))
    .overlay(RoundedRectangle(cornerRadius: Radius.cover).strokeBorder(.white.opacity(0.1)))
    .accessibilityHidden(true)
  }
}
