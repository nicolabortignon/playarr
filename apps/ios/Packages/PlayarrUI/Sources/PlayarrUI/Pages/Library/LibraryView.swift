import PlayarrAPI
import SwiftUI

/// The Library tab (apps/web/src/pages/Library.tsx): everything that's yours in one place, and your playlists.
/// Requests and Downloads join the rows while there are some; the MusicBrainz queue shows at the foot
/// while lookups wait (the desktop sidebar's footer).
struct LibraryView: View {
  @State private var health: Query<HealthStatus>
  let session: AccountSession
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?
  @Environment(Theme.self) private var theme

  init(session: AccountSession) {
    let api = session.api
    self.session = session
    _health = State(initialValue: Query(.health, cache: session.queries, staleAfter: 30) { try await api.send(API.Server.health()) })
  }

  var body: some View {
    let library = health.value?.library
    List {
      Section {
        row("Made for you", "sparkles", .mixes)
        row("Your listening", "chart.bar", .listening)
        row("Favorites", "heart", .favorites, detail: session.favorites.tracks.map { Format.plural($0.count, "song") })
        let downloads = session.player.downloads.manifest.pins.count
        if downloads > 0 { row("Downloads", "arrow.down.circle", .downloads, detail: String(downloads)) }
        row("Artists", "music.mic", .artists, detail: library.map { String($0.artists) })
        row("Albums", "square.stack", .albums(.artist), detail: library.map { String($0.albums) })
        if let count = discover?.requests.requests?.count, count > 0 {
          row("Requests", "arrow.down.circle", .requests, detail: String(count)).accessibilityIdentifier("library-requests")
        }
      }
      Section {
        Button { session.addToPlaylist([]) } label: {
          HStack(spacing: 14) {
            Image(systemName: "plus")
              .foregroundStyle(theme.accent.color)
              .frame(width: 56, height: 56)
              .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4])))
            Text("New playlist")
          }
        }
        .accessibilityIdentifier("library.newPlaylist")
        if let playlists = session.playlists.playlists {
          ForEach(playlists) { playlist in
            NavigationLink(value: Route.playlist(playlist.id)) {
              HStack(spacing: 14) {
                PlaylistCover(cover: playlist.cover, points: 56, name: playlist.name).frame(width: 56, height: 56)
                VStack(alignment: .leading) {
                  Text(playlist.name).lineLimit(1)
                  Text(Format.plural(playlist.trackCount, "song")).font(.mono(.caption)).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
      } header: {
        NavigationLink(value: Route.playlists) { Text("Playlists") }
      }
      Section {
      } footer: {
        VStack(alignment: .leading, spacing: 12) {
          MusicBrainzIndicator()
          // As the web's Library ends: where the songs kept as you listen are managed.
          HStack(spacing: 4) {
            Text("Songs kept on this device:")
            NavigationLink(value: Route.settingsPanel(.playback)) { Text("Settings → Playback").foregroundStyle(.tint) }
              .buttonStyle(.plain)
          }
          .font(.sans(.footnote))
          .foregroundStyle(.paperDim)
          .frame(minHeight: 44)
        }
      }
    }
    .navigationTitle("Library")
    .task {
      await health.load()
      await session.favorites.load()
      await session.playlists.load()
    }
    .refreshable {
      await health.refresh()
      await session.refreshListening()
    }
  }

  private func row(_ title: String, _ icon: String, _ route: Route, detail: String? = nil) -> some View {
    NavigationLink(value: route) {
      HStack(spacing: 14) {
        Image(systemName: icon)
          .foregroundStyle(theme.accent.color)
          .frame(width: 40, height: 40)
          .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.15)))
        Text(title)
        Spacer()
        if let detail { Text(detail).font(.mono(.caption)).foregroundStyle(.secondary) }
      }
    }
  }
}
