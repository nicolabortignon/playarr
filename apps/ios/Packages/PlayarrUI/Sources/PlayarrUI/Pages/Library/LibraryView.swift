import PlayarrAPI
import SwiftUI

/// The Library tab (apps/web/src/pages/Library.tsx): everything that's yours in one place, and your playlists.
/// Requests join the rows while there are some (phase 8), Downloads in phase 7; the MusicBrainz queue shows at the foot
/// while lookups wait (the desktop sidebar's footer).
struct LibraryView: View {
  @State private var health: Query<HealthStatus>
  @State private var favorites: Query<[FavoriteTrack]>
  @State private var playlists: Query<[PlaylistSummary]>
  @Environment(AppModel.self) private var app
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?
  @Environment(Theme.self) private var theme

  init(session: AccountSession) {
    let api = session.api
    _health = State(initialValue: Query(.health, cache: session.queries, staleAfter: 30) { try await api.send(API.Server.health()) })
    _favorites = State(initialValue: Query(.favorites, cache: session.queries, staleAfter: 60) { try await api.send(API.Favorites.list()) })
    _playlists = State(initialValue: Query(.playlists, cache: session.queries, staleAfter: 60) { try await api.send(API.Playlists.list()) })
  }

  var body: some View {
    let library = health.value?.library
    List {
      Section {
        row("Made for you", "sparkles", .mixes)
        row("Your listening", "chart.bar", .listening)
        row("Favorites", "heart", .favorites, detail: favorites.value.map { Format.plural($0.count, "song") })
        row("Artists", "music.mic", .artists, detail: library.map { String($0.artists) })
        row("Albums", "square.stack", .albums(.artist), detail: library.map { String($0.albums) })
        if let count = discover?.requests.requests?.count, count > 0 {
          row("Requests", "arrow.down.circle", .requests, detail: String(count)).accessibilityIdentifier("library-requests")
        }
        // Phase 9 finds Settings by this identifier.
        row("Settings", "gearshape", .settings).accessibilityIdentifier("settings")
      }
      if let playlists = playlists.value, !playlists.isEmpty {
        Section("Playlists") {
          ForEach(playlists) { playlist in
            NavigationLink(value: Route.playlist(playlist.id)) {
              HStack(spacing: 14) {
                PlaylistCover(cover: playlist.cover, points: 56, name: playlist.name).frame(width: 56, height: 56)
                VStack(alignment: .leading) {
                  Text(playlist.name).lineLimit(1)
                  Text(Format.plural(playlist.trackCount, "song")).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
      }
      Section {
      } footer: {
        MusicBrainzIndicator()
      }
    }
    .navigationTitle("Library")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button("Accounts", systemImage: "person.crop.circle") { app.showingAccounts = true }
      }
    }
    .task {
      await health.load()
      await favorites.load()
      await playlists.load()
    }
    .refreshable {
      await health.refresh()
      await favorites.refresh()
      await playlists.refresh()
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
        if let detail { Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary) }
      }
    }
  }
}
