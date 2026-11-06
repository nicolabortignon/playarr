import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A playlist's page (apps/web/src/pages/Playlist.tsx): the cover (tap for a new one), the name (tap to edit), its
/// songs and whose it is, the action row (Play, Shuffle, Download, ⋯), what it's about, the songs (hold and drag, or
/// Edit, to reorder; sent on the drop) and "Songs like these". What the cover is drawn from is in the cover picker.
/// Someone else's shared playlist shows the same page without the ways to change it.
struct PlaylistView: View {
  @State private var model: PlaylistModel
  @Environment(Theme.self) private var theme
  @Environment(\.dismiss) private var dismiss
  @State private var editing = false
  @State private var name = ""
  @State private var details = ""
  @State private var pickingCover = false
  @State private var confirmingDelete = false
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  init(id: Int, session: AccountSession) {
    _model = State(initialValue: PlaylistModel(id: id, session: session))
  }

  var body: some View {
    Group {
      if let playlist = model.playlist {
        page(playlist)
      } else if let error = model.error {
        ErrorState(message: error) { await model.load() }
      } else {
        ScrollView {
          DetailSkeleton().padding(.horizontal, 20).padding(.top, 12)
        }
      }
    }
    .task(id: model.pollRound) { await model.poll() }
  }

  private func page(_ playlist: PlaylistDetail) -> some View {
    Group {
      if GatefoldRule.applies(verticalSizeClass) {
        // Sideways: the cover stays on the left, the songs scroll beside it.
        Gatefold { side in cover(playlist, points: side).coverShadow(.hero) } page: { list(playlist, cover: false) }
      } else {
        list(playlist, cover: true)
      }
    }
    .titleInBar(playlist.name)
    #if os(iOS)
      // In the bar's text color: the accent on the bar's glass doesn't read at 4.5:1.
      .toolbar { if model.mine, model.items.count > 1 { EditButton().tint(Color.paper) } }
    #endif
    .refreshable { await model.load() }
    .sheet(isPresented: $pickingCover) { CoverPickerView(playlist: model, detail: playlist) }
  }

  private func list(_ playlist: PlaylistDetail, cover: Bool) -> some View {
    List {
      Section { header(playlist, cover: cover) }
        .listRowSeparator(.hidden)
      Section {
        if model.items.isEmpty {
          EmptyState(systemImage: "music.note.list", line: PageLines.playlist(mine: model.mine), underHeader: true)
            .listRowSeparator(.hidden)
        }
        ForEach(Array(model.items.enumerated()), id: \.element.itemId) { index, item in
          row(item, at: index)
        }
        .onMove(perform: model.mine ? { source, destination in Task { await model.move(fromOffsets: source, toOffset: destination) } } : nil)
      }
      if model.mine, !model.items.isEmpty {
        RecommendationsSection(playlist: model)
      }
    }
    .listStyle(.plain)
  }

  /// The page's own cover (without the name drawn on it: it's beside it), which opens the cover picker on your own
  /// playlists, and says so when the songs have moved on from it.
  @ViewBuilder private func cover(_ playlist: PlaylistDetail, points: CGFloat = 256) -> some View {
    let art = PlaylistCover(cover: playlist.cover, points: points, name: playlist.name, titled: false)
    if model.canPickCover {
      Button { pickingCover = true } label: {
        art.overlay(alignment: .bottomTrailing) {
          if playlist.cover.stale {
            Label("New cover", systemImage: "paintpalette")
              .typeRole(.badge)
              .foregroundStyle(.paper)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(.black.opacity(0.8), in: Capsule())
              .padding(10)
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("New cover")
      .accessibilityHint(playlist.cover.stale ? "The playlist has changed a lot since this cover was drawn" : "")
    } else {
      art
    }
  }

  /// The cover, Playlist, the name (tap to rename), its songs and whose it is, the action row, then what it's about.
  private func header(_ playlist: PlaylistDetail, cover showsCover: Bool) -> some View {
    VStack(alignment: .leading, spacing: 24) {
      // Nothing in it yet: a smaller cover, so the line saying so shows on a phone's first screen too.
      DetailHeader(kicker: "Playlist", showsCover: showsCover, smallCover: model.items.isEmpty) {
        cover(playlist)
      } title: {
        if editing {
          editFields
        } else {
          DetailTitle(playlist.name)
            .onTapGesture(perform: startEditing)
            .accessibilityActions { if model.mine { Button("Rename", action: startEditing) } }
        }
      } meta: {
        MetaLine(model.facts, model.sharing)
      } actions: {
        ActionRow(
          title: playlist.name, playState: model.playState, disabled: model.playable.isEmpty, play: model.playOrPause,
          shuffle: { model.play(shuffle: true) },
          download: DownloadButton(
            store: model.session.player.downloads,
            item: DownloadItem(
              key: PinnedDownload.Key.playlist(playlist.id), title: playlist.name, subtitle: "Playlist", coverUrl: playlist.cover.url,
              href: "/playlists/\(playlist.id)"),
            tracks: model.playable),
          moreLabel: "Playlist actions"
        ) {
          MenuButtons(
            groups: PlayableMenu.playlist(
              playlist.id, tracks: model.playable, own: model.ownerActions.map { action in MenuAction(action.kind) { perform(action) } },
              session: model.session))
        }
        // Asked from the row its ⋯ is in, so a phone's popover points there. Attached to the whole page, it pointed
        // below the header, and an iPhone SE showed nothing at all for an empty playlist.
        .confirmLoss(Self.deleteQuestion(playlist, songs: model.items.count), isPresented: $confirmingDelete) {
          Task { if await model.delete() { dismiss() } }
        }
      }
      // What it's about: after the row, so Play comes first on a phone.
      if !editing, !playlist.description.isEmpty {
        Text(playlist.description).typeRole(.body).foregroundStyle(.paperDim).onTapGesture(perform: startEditing)
      }
    }
    // Room for Play's glow to fade out: the next list row would cut it off in a line.
    .padding(.bottom, 16)
  }

  /// Renaming and describing it, in place of the name.
  private var editFields: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("Playlist name", text: $name).font(.display(.largeTitle)).accessibilityIdentifier("playlist.editName")
      TextField("Add a description", text: $details, axis: .vertical).lineLimit(2...4)
      HStack {
        Button("Save") { Task { if await model.save(name: name, description: details) { editing = false } } }
          .buttonStyle(.pill(.primary))
        Button("Cancel") { editing = false }.buttonStyle(.pill(.secondary))
      }
    }
  }

  private func startEditing() {
    guard model.mine, let playlist = model.playlist else { return }
    name = playlist.name
    details = playlist.description
    editing = true
  }

  private func perform(_ action: PlaylistAction) {
    switch action {
    case .rename: startEditing()
    case .newCover: pickingCover = true
    case .share: Task { await model.setShared(true) }
    case .stopSharing: Task { await model.setShared(false) }
    case .delete: confirmingDelete = true
    }
  }

  /// "Delete “Late night”?", and under it what goes and what stays, as the web's dialog says it.
  static func deleteQuestion(_ playlist: PlaylistDetail, songs: Int) -> LossQuestion {
    LossQuestion(title: "Delete “\(playlist.name)”?", message: deleteMessage(shared: playlist.shared, songs: songs), verb: "Delete")
  }

  static func deleteMessage(shared: Bool, songs: Int) -> String {
    let stays = switch songs {
    case 0: ""
    case 1: " Its song stays in your library."
    default: " Its \(songs) songs stay in your library."
    }
    return "The playlist goes for good\(shared ? ", for everyone it’s shared with" : "")." + stays
  }

  /// A song of the playlist: the one song row, with its owner's Move up, Move down and Remove after a line. One the
  /// library no longer has stays in its place, grayed, with only those.
  @ViewBuilder private func row(_ item: PlaylistItem, at index: Int) -> some View {
    let own = model.own(at: index)
    if let track = item.track {
      // Dragged within the list to reorder, so not onto the sidebar.
      SongRow(track: track, drags: false, place: SongMenu.Place(own: own)) { model.play(from: item) }
    } else {
      MissingSongRow(title: item.title, lead: .cover(album: item.albumTitle), subtitle: [item.artistName, item.albumTitle], own: own)
    }
  }
}
