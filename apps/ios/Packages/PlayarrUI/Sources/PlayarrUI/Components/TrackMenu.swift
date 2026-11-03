import PlayarrAPI
import SwiftUI

/// A song's ⋯ button.
struct TrackMenu: View {
  let track: Track
  var showsAlbum = true

  var body: some View {
    Menu {
      TrackMenuItems(track: track, showsAlbum: showsAlbum)
    } label: {
      Image(systemName: "ellipsis")
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(.secondary)
    .accessibilityLabel("More for \(track.title)")
  }
}

/// What can be done with a song (apps/web/src/components/TrackList.tsx): Play next, Add to queue, Start radio,
/// Go to album (in mixed lists), Go to artist. Add to playlist (phase 6), Show metadata and Edit mix points (phase 8)
/// join them later.
struct TrackMenuItems: View {
  let track: Track
  var showsAlbum = true
  @Environment(AccountSession.self) private var session

  var body: some View {
    Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { session.actions.playNext([track]) }
    Button("Add to queue", systemImage: "text.append") { session.actions.addToQueue([track]) }
    Button("Start radio", systemImage: "dot.radiowaves.left.and.right") { Task { await session.actions.startRadio(track) } }
    if showsAlbum {
      Button("Go to album", systemImage: "square.stack") { session.actions.goToAlbum(track) }
    }
    Button("Go to artist", systemImage: "music.mic") { session.actions.goToArtist(track) }
  }
}
