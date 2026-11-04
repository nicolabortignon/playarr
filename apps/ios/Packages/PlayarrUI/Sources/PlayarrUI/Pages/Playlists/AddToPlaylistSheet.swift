import PlayarrAPI
import SwiftUI

/// "Add to playlist" and "New playlist" (apps/web/src/components/AddToPlaylistDialog.tsx). A playlist made from nothing
/// opens once it's made.
struct AddToPlaylistSheet: View {
  let session: AccountSession
  @State private var model: AddToPlaylistModel
  @Environment(\.dismiss) private var dismiss
  @FocusState private var naming: Bool

  init(tracks: [Track], session: AccountSession) {
    self.session = session
    _model = State(initialValue: AddToPlaylistModel(tracks: tracks, store: session.playlists))
  }

  var body: some View {
    NavigationStack {
      List {
        if model.creating {
          HStack {
            TextField("Playlist name", text: $model.name)
              .focused($naming)
              .submitLabel(.done)
              .onSubmit(create)
              .accessibilityIdentifier("playlist.name")
            Button("Create", action: create)
              .buttonStyle(.borderedProminent)
              .disabled(!model.canCreate)
              .accessibilityIdentifier("playlist.create")
          }
        } else {
          Button("New playlist", systemImage: "plus") {
            model.creating = true
            naming = true
          }
        }
        ForEach(model.choices) { playlist in
          Button {
            Task { if await model.add(to: playlist) { dismiss() } }
          } label: {
            HStack(spacing: 12) {
              PlaylistCover(cover: playlist.cover, points: 48, name: playlist.name).frame(width: 48, height: 48)
              VStack(alignment: .leading) {
                Text(playlist.name).lineLimit(1)
                Text(Format.plural(playlist.trackCount, "song")).font(.mono(.caption)).foregroundStyle(.secondary)
              }
              Spacer(minLength: 0)
            }
            // The whole row, not just its words, takes the tap.
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(model.busy)
          .accessibilityLabel(playlist.name)
        }
      }
      .navigationTitle(model.title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
      .onAppear { naming = model.creating }
    }
    .presentationDetents([.medium, .large])
  }

  private func create() {
    Task {
      guard let playlist = await model.create() else { return }
      dismiss()
      if model.tracks.isEmpty { session.router.open(.playlist(playlist.id)) }
    }
  }
}

extension View {
  /// The "Add to playlist" sheet any screen opens with `AccountSession.addToPlaylist(_:)`. Put on the signed-in app,
  /// and once more inside Now Playing (a sheet can't be presented under a full-screen cover): `active` says which of
  /// the two presents it now, as phase 8's `trackSheets(player:active:)`.
  func addToPlaylistSheet(_ session: AccountSession, active: Bool = true) -> some View {
    sheet(item: Binding(get: { active ? session.picking : nil }, set: { session.picking = $0 })) { pick in
      AddToPlaylistSheet(tracks: pick.tracks, session: session)
    }
  }
}
