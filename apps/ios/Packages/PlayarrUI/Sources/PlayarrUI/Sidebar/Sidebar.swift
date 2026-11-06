import PlayarrAPI
import SwiftUI

/// The iPad sidebar (apps/web/src/components/Nav.tsx `Sidebar`): the desktop links, Requests while there are some
/// (with how many are on their way) and your playlists with "+" for a new one, in one list that scrolls, with Settings
/// kept at the foot. Once the links have scrolled away, a bar at the top keeps the one you're on, so the playlists get
/// the room; back at the top, the links are all there again. Songs dragged onto one of your playlists are added to it;
/// onto Queue, to the queue.
struct Sidebar: View {
  let session: AccountSession
  /// Where the player bar is, in the window. The sidebar runs under it, and keeps Settings above whatever part of
  /// the bar covers it (all of its foot, or none at the largest text sizes, where the bar is a card over the page).
  var bar = CGRect.zero
  @State private var frame = CGRect.zero
  @State private var dropped = 0
  /// The links are scrolled out of sight: the folded bar stands in for them.
  @State private var folded = false
  @State private var rowHeight: CGFloat = 44
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?
  @Environment(Theme.self) private var theme

  init(session: AccountSession, bar: CGRect = .zero) {
    self.session = session
    self.bar = bar
  }

  private var showsRequests: Bool { (discover?.requests.requests?.count ?? 0) > 0 }

  /// The link the page belongs to, for the folded bar; none for a playlist or Settings.
  private var current: SidebarItem? {
    let item = session.router.sidebar
    return SidebarItem.links.contains(item) || item == .requests ? item : nil
  }

  var body: some View {
    let router = session.router
    let links = SidebarItem.links.count + (showsRequests ? 1 : 0)
    // Settings under the list rather than in an inset, so it stays above the player bar.
    VStack(spacing: 0) {
      list(router: router, links: links)
      Divider()
      row(.settings, selected: router.sidebar == .settings) { router.select(sidebar: .settings) }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
    .padding(.bottom, bar.intersects(frame) ? max(0, frame.maxY - bar.minY) : 0)
    .background(Self.dark)
    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
    .navigationTitle("Playarr")
    // ↑ and ↓ are the volume, as on the web, also while the sidebar has the keyboard's focus (where they'd move its
    // selection). Tab and the pointer still move through it.
    .onKeyPress(keys: [.upArrow, .downArrow]) { press in
      guard press.modifiers.isEmpty else { return .ignored }
      KeyCommandHandler(session: session).perform(press.key == .upArrow ? .volumeUp : .volumeDown)
      return .handled
    }
    .sensoryFeedback(Haptic.dropped, trigger: dropped)
    .task { await session.playlists.load() }
  }

  /// The links, Requests and the playlists, scrolling; the folded bar over them once the links are out of sight.
  private func list(router: AppRouter, links: Int) -> some View {
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
        if let requests = discover?.requests, showsRequests {
          link(.requests).badge(requests.activeCount)
        }
      }
      Section {
        if let list = session.playlists.playlists {
          ForEach(list) { playlist in
            playlistRow(playlist)
          }
          if list.isEmpty {
            Text("No playlists yet.").font(.callout).foregroundStyle(.paperDim)
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
    }
    .listStyle(.sidebar)
    // On Playarr's own dark rather than the translucent sidebar over the page, so its words keep their contrast.
    .scrollContentBackground(.hidden)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.contentInsets.top > CGFloat(links) * rowHeight - rowHeight / 2
    } action: { _, past in
      withAnimation(.easeOut(duration: 0.25)) { folded = past }
    }
    .overlay(alignment: .top) {
      if folded, let current {
        row(current, selected: true) { router.select(sidebar: current) }
          .padding(.horizontal, 12)
          .padding(.bottom, 6)
          .background(Self.dark)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .refreshable { await session.playlists.load() }
  }

  /// Playarr's own near-black behind the sidebar.
  private static let dark = Color(red: 0x0F / 255, green: 0x0E / 255, blue: 0x0C / 255)

  /// A row outside the list (Settings at the foot, the folded bar), drawn as the list draws a selected or plain row.
  private func row(_ item: SidebarItem, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(item.title, systemImage: item.systemImage)
        .foregroundStyle(selected ? theme.accent.color : .primary)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 12)
        .background(selected ? Color.white.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 12))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityIdentifier(item.identifier)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func link(_ item: SidebarItem) -> some View {
    Label(item.title, systemImage: item.systemImage)
      // How tall a row is at this text size, for where the links end.
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if item == .home { rowHeight = max(44, $0 + 12) } }
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
