import PlayarrAPI
import SwiftUI

/// "Add to playlist" and "New playlist" (apps/web/src/components/AddToPlaylistDialog.tsx): your own playlists, each with
/// a tick on its cover when it holds the songs already (a dash when it holds some), to choose one or several and add to
/// them all at once with Add; or a new playlist made with the songs. A playlist made from nothing opens once it's made.
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
            Button(model.busy ? "Creating…" : "Create", action: create)
              .buttonStyle(.pill(.primary, size: .small))
              .disabled(!model.canCreate)
              .accessibilityIdentifier("playlist.create")
          }
        } else {
          Button("New playlist", systemImage: "plus") {
            model.creating = true
            naming = true
          }
        }
        if !model.choices.isEmpty {
          Section {
            ForEach(model.choices) { playlist in
              choice(playlist)
            }
          } header: {
            Text("Your playlists")
          }
        }
      }
      .navigationTitle(model.title)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        if !model.choices.isEmpty {
          ToolbarItem(placement: .confirmationAction) {
            Button(model.addLabel, action: add)
              .disabled(!model.canAdd)
              .accessibilityIdentifier("playlist.add")
          }
        }
      }
      .onAppear { naming = model.creating }
      .task { await model.loadHolding() }
    }
    .presentationDetents([.medium, .large])
  }

  /// A playlist to add to: a checkbox (the circle on the right). On its cover, a tick when it holds every one of the
  /// songs already, a dash when it holds some; its line says so in words too.
  private func choice(_ playlist: PlaylistSummary) -> some View {
    let chosen = model.isChosen(playlist)
    let holds = model.holds(playlist)
    let note = model.note(playlist)
    let line = [Format.plural(playlist.trackCount, "song"), note].compactMap(\.self).joined(separator: " · ")
    return Button { model.toggle(playlist) } label: {
      HStack(spacing: 12) {
        PlaylistCover(cover: playlist.cover, points: 48, name: playlist.name)
          .frame(width: 48, height: 48)
          .overlay(alignment: .bottomTrailing) { HoldingMark(holding: holds).offset(x: 6, y: 6) }
        VStack(alignment: .leading, spacing: 2) {
          Text(playlist.name).typeRole(.body).foregroundStyle(.paper).lineLimit(1)
          Text(line).typeRole(.meta).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer(minLength: 0)
        Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
          .font(.title2)
          .foregroundStyle(chosen ? AnyShapeStyle(.tint) : AnyShapeStyle(Color.paper.opacity(0.25)))
          .accessibilityHidden(true)
      }
      // The whole row, not just its words, takes the tap.
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(model.busy)
    .accessibilityLabel(playlist.name)
    .accessibilityValue(line)
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }

  private func create() {
    Task {
      guard let playlist = await model.create() else { return }
      dismiss()
      if model.tracks.isEmpty { session.router.open(.playlist(playlist.id)) }
    }
  }

  private func add() {
    Task { if await model.add() { dismiss() } }
  }
}

/// On a playlist's cover in Add to playlist: a tick in a green circle when it holds all the songs already, a dash when
/// it holds some (its line says so in words).
private struct HoldingMark: View {
  let holding: AddToPlaylistModel.Holding

  var body: some View {
    switch holding {
    case .none:
      EmptyView()
    case .some:
      mark("minus", fill: Color(white: 0.35), ink: .paper)
    case .all:
      mark("checkmark", fill: .success, ink: .black)
    }
  }

  private func mark(_ symbol: String, fill: Color, ink: Color) -> some View {
    Image(systemName: symbol)
      .font(.sans(size: 11, weight: .bold))
      .foregroundStyle(ink)
      .frame(width: 20, height: 20)
      .background(fill, in: Circle())
      .overlay(Circle().strokeBorder(Color.black.opacity(0.6), lineWidth: 2))
      .accessibilityHidden(true)
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
