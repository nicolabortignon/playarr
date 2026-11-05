import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A playlist's page (apps/web/src/pages/Playlist.tsx): the cover (tap for a new one), name and description (tap to
/// edit), whose it is, Play, Shuffle, the ⋯ menu, the songs (hold and drag, or Edit, to reorder; sent on the drop) and
/// "Songs like these". Someone else's shared playlist shows the same page without the ways to change it.
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
        ProgressView()
      }
    }
    .task(id: model.pollRound) { await model.poll() }
  }

  private func page(_ playlist: PlaylistDetail) -> some View {
    Group {
      if GatefoldRule.applies(verticalSizeClass) {
        // Sideways: the cover stays on the left, the songs scroll beside it.
        Gatefold { _ in cover(playlist) } page: { list(playlist, cover: false) }
      } else {
        list(playlist, cover: true)
      }
    }
    .navigationTitle(playlist.name)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { if model.mine, model.items.count > 1 { EditButton() } }
    #endif
    .refreshable { await model.load() }
    .sheet(isPresented: $pickingCover) { CoverPickerView(playlist: model, detail: playlist) }
    .confirmationDialog("Delete playlist?", isPresented: $confirmingDelete, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task { if await model.delete() { dismiss() } }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("“\(playlist.name)” will be deleted. The songs stay in your library. This can’t be undone.")
    }
  }

  private func list(_ playlist: PlaylistDetail, cover: Bool) -> some View {
    List {
      Section { header(playlist, cover: cover) }
        .listRowSeparator(.hidden)
      Section {
        if model.items.isEmpty {
          Text("This playlist is empty. Use Add to playlist… from any song’s ⋯ menu, an album, the queue or Now Playing.")
            .foregroundStyle(.secondary)
        }
        ForEach(model.items, id: \.itemId) { item in
          PlaylistItemRow(item: item, actions: model.actions(for: item), onTap: { model.play(from: item) }) { perform($0, on: item) }
        }
        .onMove(perform: model.mine ? { source, destination in Task { await model.move(fromOffsets: source, toOffset: destination) } } : nil)
      }
      if model.mine, !model.items.isEmpty {
        RecommendationsSection(playlist: model)
      }
    }
    .listStyle(.plain)
  }

  /// The cover, which opens the cover picker on your own playlists.
  private func cover(_ playlist: PlaylistDetail) -> some View {
    Button { pickingCover = true } label: {
      PlaylistCover(cover: playlist.cover, points: 256, name: playlist.name)
        .shadow(color: .black.opacity(0.8), radius: 30, y: 20)
    }
    .buttonStyle(.plain)
    .disabled(!model.canPickCover)
    .accessibilityLabel("New cover")
  }

  @ViewBuilder private func header(_ playlist: PlaylistDetail, cover showsCover: Bool) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      if showsCover {
        cover(playlist).frame(maxWidth: 256).frame(maxWidth: .infinity)
      }

      Kicker(text: "Playlist")
      if editing {
        TextField("Playlist name", text: $name).font(.display(.largeTitle)).accessibilityIdentifier("playlist.editName")
        TextField("Add a description", text: $details, axis: .vertical).lineLimit(2...4)
        HStack {
          Button("Save") { Task { if await model.save(name: name, description: details) { editing = false } } }
            .buttonStyle(.pill())
          Button("Cancel") { editing = false }.buttonStyle(.pill(.quiet))
        }
      } else {
        Text(playlist.name).font(.display(.largeTitle)).onTapGesture(perform: startEditing)
        if !playlist.description.isEmpty {
          Text(playlist.description).foregroundStyle(.secondary).onTapGesture(perform: startEditing)
        }
      }
      Text(model.facts).font(.mono(.caption)).foregroundStyle(.secondary)
      if let sharing = model.sharing {
        Text(sharing).font(.mono(.caption)).foregroundStyle(.secondary)
      }
      if model.canPickCover { coverNote(CoverNote(playlist.cover)) }

      FlowRow {
        PlayShuffleButtons(title: playlist.name, disabled: model.playable.isEmpty) {
          model.play(shuffle: false)
        } shuffle: {
          model.play(shuffle: true)
        }
        DownloadButton(
          store: model.session.player.downloads,
          item: DownloadItem(
            key: PinnedDownload.Key.playlist(playlist.id), title: playlist.name, subtitle: "Playlist", coverUrl: playlist.cover.url,
            href: "/playlists/\(playlist.id)"),
          tracks: model.playable)
        Menu {
          ForEach(model.actions, id: \.self) { action in
            Button(action.label, systemImage: action.systemImage, role: action == .delete ? .destructive : nil) { perform(action) }
          }
        } label: {
          Image(systemName: "ellipsis").frame(width: 44, height: 44)
        }
        .accessibilityLabel("Playlist actions")
      }
    }
  }

  private func coverNote(_ note: CoverNote) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if let listening = note.listening {
        Label(listening, systemImage: "circle.fill").symbolEffect(.pulse).font(.sans(.footnote)).foregroundStyle(.secondary)
      } else {
        Text(note.story).font(.sans(.footnote)).foregroundStyle(.secondary)
        Text(note.facts.uppercased()).font(.mono(.caption2)).foregroundStyle(.secondary)
        Button(note.stale ? "The playlist has changed a lot since this cover was drawn. New cover" : "New cover") { pickingCover = true }
          .font(.mono(.caption))
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
    case .playNext: model.queue(next: true)
    case .addToQueue: model.queue(next: false)
    case .newCover: pickingCover = true
    case .share: Task { await model.setShared(true) }
    case .stopSharing: Task { await model.setShared(false) }
    case .delete: confirmingDelete = true
    }
  }

  private func perform(_ action: PlaylistRowAction, on item: PlaylistItem) {
    let session = model.session
    if action == .remove {
      Task { await model.remove(item) }
      return
    }
    guard let track = item.track else { return }
    switch action {
    case .playNext: session.actions.playNext([track])
    case .addToQueue: session.actions.addToQueue([track])
    case .addToPlaylist: session.addToPlaylist([track])
    case .goToAlbum: session.actions.goToAlbum(track)
    case .goToArtist: session.actions.goToArtist(track)
    case .remove: break
    }
  }
}
