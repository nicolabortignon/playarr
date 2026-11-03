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
    List {
      Section { header(playlist) }
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

  @ViewBuilder private func header(_ playlist: PlaylistDetail) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Button { pickingCover = true } label: {
        PlaylistCover(cover: playlist.cover, points: 256, name: playlist.name)
          .frame(maxWidth: 256)
          .shadow(color: .black.opacity(0.8), radius: 30, y: 20)
      }
      .buttonStyle(.plain)
      .disabled(!model.canPickCover)
      .accessibilityLabel("New cover")
      .frame(maxWidth: .infinity)

      Kicker(text: "Playlist")
      if editing {
        TextField("Playlist name", text: $name).font(.largeTitle.weight(.semibold)).accessibilityIdentifier("playlist.editName")
        TextField("Add a description", text: $details, axis: .vertical).lineLimit(2...4)
        HStack {
          Button("Save") { Task { if await model.save(name: name, description: details) { editing = false } } }
            .buttonStyle(.borderedProminent)
          Button("Cancel") { editing = false }.buttonStyle(.bordered)
        }
      } else {
        Text(playlist.name).font(.largeTitle.weight(.semibold)).onTapGesture(perform: startEditing)
        if !playlist.description.isEmpty {
          Text(playlist.description).foregroundStyle(.secondary).onTapGesture(perform: startEditing)
        }
      }
      Text(model.facts).font(.caption.monospaced()).foregroundStyle(.secondary)
      if let sharing = model.sharing {
        Text(sharing).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      if model.canPickCover { coverNote(CoverNote(playlist.cover)) }

      HStack(spacing: 12) {
        Button("Play", systemImage: "play.fill") { model.play(shuffle: false) }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.capsule)
          .tint(theme.accent.color)
          .foregroundStyle(.black)
          .disabled(model.playable.isEmpty)
          .accessibilityLabel("Play \(playlist.name)")
        Button("Shuffle", systemImage: "shuffle") { model.play(shuffle: true) }
          .buttonStyle(.bordered)
          .buttonBorderShape(.capsule)
          .disabled(model.playable.isEmpty)
          .accessibilityLabel("Shuffle \(playlist.name)")
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
        Label(listening, systemImage: "circle.fill").symbolEffect(.pulse).font(.footnote).foregroundStyle(.secondary)
      } else {
        Text(note.story).font(.footnote).foregroundStyle(.secondary)
        Text(note.facts.uppercased()).font(.caption2.monospaced()).foregroundStyle(.secondary)
        Button(note.stale ? "The playlist has changed a lot since this cover was drawn. New cover" : "New cover") { pickingCover = true }
          .font(.caption.monospaced())
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
