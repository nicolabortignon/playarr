import PlayarrAPI
import SwiftUI

/// The iPad sidebar (apps/web/src/components/Nav.tsx `Sidebar`): the desktop links, Requests while there are some
/// (with how many are on their way), your playlists with "+" for a new one, Settings, and the foot. Songs dragged
/// onto one of your playlists are added to it; onto Queue, to the queue.
struct Sidebar: View {
  let session: AccountSession
  @State private var health: Query<HealthStatus>
  @State private var dropped = 0
  @Environment(AppModel.self) private var app
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?

  init(session: AccountSession) {
    self.session = session
    let api = session.api
    _health = State(initialValue: Query(.health, cache: session.queries, staleAfter: 30) { try await api.send(API.Server.health()) })
  }

  var body: some View {
    let router = session.router
    List(selection: Binding<SidebarItem?>(get: { router.sidebar }, set: { if let item = $0 { router.select(sidebar: item) } })) {
      Section {
        ForEach(SidebarItem.links, id: \.self) { item in
          if item == .queue {
            link(item).dropDestination(for: TrackDrag.self) { drops, _ in
              session.actions.addToQueue(TrackDrag.tracks(drops))
              dropped += 1
              return true
            }
          } else {
            link(item)
          }
        }
        if let requests = discover?.requests, (requests.requests?.count ?? 0) > 0 {
          link(.requests).badge(requests.activeCount)
        }
      }
      Section {
        if let list = session.playlists.playlists {
          ForEach(list) { playlist in
            playlistRow(playlist)
          }
          if list.isEmpty {
            Text("No playlists yet.").font(.callout).foregroundStyle(.muted)
          }
        }
      } header: {
        HStack {
          Button("Playlists") { router.select(sidebar: .playlists) }
            .buttonStyle(.plain)
            .accessibilityIdentifier(SidebarItem.playlists.identifier)
          Spacer()
          Button { session.newPlaylist() } label: {
            Image(systemName: "plus").frame(width: 44, height: 44).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .pointerHover()
          .accessibilityLabel("New playlist")
          .accessibilityIdentifier("sidebar.newPlaylist")
        }
      }
      Section {
        link(.settings)
      } footer: {
        SidebarFooterView(footer: SidebarFooter(health: health.value, failed: health.error != nil), version: app.appVersion)
          .padding(.top, 8)
      }
    }
    .listStyle(.sidebar)
    // On Playarr's own dark rather than the translucent sidebar over the page, so its words keep their contrast.
    .scrollContentBackground(.hidden)
    .background(Color(red: 0x0F / 255, green: 0x0E / 255, blue: 0x0C / 255))
    .navigationTitle("Playarr")
    // ↑ and ↓ are the volume, as on the web, also while the sidebar has the keyboard's focus (where they'd move its
    // selection). Tab and the pointer still move through it.
    .onKeyPress(keys: [.upArrow, .downArrow]) { press in
      guard press.modifiers.isEmpty else { return .ignored }
      KeyCommandHandler(session: session).perform(press.key == .upArrow ? .volumeUp : .volumeDown)
      return .handled
    }
    .sensoryFeedback(Haptic.dropped, trigger: dropped)
    .task {
      // The foot's dots follow the server as the web's do (health is asked again once it's 30 s old).
      while !Task.isCancelled {
        await health.load()
        try? await Task.sleep(for: .seconds(30))
      }
    }
    .task { await session.playlists.load() }
    .refreshable {
      await health.refresh()
      await session.playlists.load()
    }
  }

  private func link(_ item: SidebarItem) -> some View {
    Label(item.title, systemImage: item.systemImage)
      // One element per row (its icon and name), so UI tests find the row itself by its identifier.
      .accessibilityElement(children: .combine)
      .tag(item)
      .accessibilityIdentifier(item.identifier)
  }

  private func playlistRow(_ playlist: PlaylistSummary) -> some View {
    Label(playlist.name, systemImage: SidebarItem.playlist(playlist.id).systemImage)
      .essentialLineLimit()
      .accessibilityElement(children: .combine)
      .tag(SidebarItem.playlist(playlist.id))
      .accessibilityIdentifier(SidebarItem.playlist(playlist.id).identifier)
      .dropDestination(for: TrackDrag.self) { drops, _ in
        guard TrackDrag.accepts(playlist) else { return false }
        session.add(TrackDrag.tracks(drops), to: playlist)
        dropped += 1
        return true
      }
  }
}
