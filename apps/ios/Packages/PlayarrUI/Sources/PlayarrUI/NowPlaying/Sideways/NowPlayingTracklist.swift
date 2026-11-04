import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The back of the sleeve, when Now Playing is held sideways: the song before, the song playing as the open line
/// (big, with its artist, format and heart), then the rest of the queue, with how each song becomes the next between
/// them. Tap a line to play from it, long-press for its menu, swipe it away to take it out of the queue. The list
/// follows the song playing; scroll away and it stops, comes back with "Now", or on its own after 8 seconds.
struct NowPlayingTracklist: View {
  let session: AccountSession
  /// The stage: the other lines dim and the open line grows (`NowPlayingStage`).
  var staged = false

  @Environment(Theme.self) private var theme
  @Environment(\.reducesMotion) private var reducesMotion
  @State private var following = true
  @State private var touched = Date.distantPast

  /// How long the list stays where it was scrolled to before it goes back to the song playing.
  static let returnAfter: Duration = .seconds(8)

  var body: some View {
    let player = session.player
    let tracklist = Tracklist(
      queue: player.queue, transitions: player.settings.transitions, crossfade: player.settings.crossfade, autoplay: player.settings.autoplay)
    ScrollViewReader { proxy in
      List {
        ForEach(tracklist.range, id: \.self) { orderPos in
          if let line = tracklist.line(at: orderPos) {
            row(line)
              .id(orderPos)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
              .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
          }
        }
        Text(tracklist.end.uppercased())
          .font(.mono(.caption2)).tracking(2).foregroundStyle(.muted)
          .frame(minHeight: 44)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .opacity(staged ? 0.25 : 1)
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .onScrollPhaseChange { _, phase in
        if phase == .interacting {
          following = false
          touched = Date()
        }
      }
      .overlay(alignment: .top) {
        if !following {
          Button { follow(proxy, pos: player.queue.pos) } label: {
            Label("Now", systemImage: "waveform").font(.mono(.caption)).padding(.horizontal, 14).frame(minHeight: 36)
          }
          .buttonStyle(.plain)
          .glassEffect()
          .padding(.top, 6)
          .accessibilityLabel("Back to the song playing")
          .transition(.opacity)
        }
      }
      .onAppear { proxy.scrollTo(max(0, player.queue.pos - 1), anchor: .top) }
      .onChange(of: player.queue.pos) { _, pos in if following { follow(proxy, pos: pos) } }
      // Scrolled away and left alone: back to the song playing, as the lyrics do.
      .task(id: touched) {
        guard !following else { return }
        try? await Task.sleep(for: Self.returnAfter)
        if !Task.isCancelled { follow(proxy, pos: player.queue.pos) }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("nowPlaying.tracklist")
  }

  /// The song playing second from the top, with the one before above it.
  private func follow(_ proxy: ScrollViewProxy, pos: Int) {
    following = true
    if reducesMotion {
      proxy.scrollTo(max(0, pos - 1), anchor: .top)
    } else {
      withAnimation(.spring(duration: 0.5)) { proxy.scrollTo(max(0, pos - 1), anchor: .top) }
    }
  }

  @ViewBuilder
  private func row(_ line: Tracklist.Line) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      join(line.joinBefore, playing: line.state == .playing)
      if line.state == .playing {
        openLine(line)
      } else {
        closedLine(line)
          .opacity(staged ? 0.25 : line.state == .played ? 0.5 : 1)
      }
    }
    .contextMenu { if line.state != .playing { menu(line) } }
    .swipeActions(edge: .trailing) {
      if line.state == .upcoming {
        Button("Remove from queue", systemImage: "xmark", role: .destructive) { remove(line) }
      }
    }
  }

  /// The song playing: two lines, the title in Gloock, its artist, format and heart, and a level meter that moves
  /// while it plays.
  private func openLine(_ line: Tracklist.Line) -> some View {
    let track = line.track
    let playing = session.player.queue.playing
    return HStack(alignment: .center, spacing: 12) {
      Image(systemName: "waveform")
        .symbolEffect(.variableColor.iterative, isActive: playing && !reducesMotion)
        .foregroundStyle(theme.accent.color)
        .frame(width: 32)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(track.title)
          .font(.display(size: staged ? 34 : 22))
          .essentialLineLimit(2)
          .foregroundStyle(theme.accent.color)
        HStack(spacing: 8) {
          Button(track.artistName) { session.actions.goToArtist(track) }
            .font(.sans(.subheadline)).foregroundStyle(.muted).buttonStyle(.plain)
            .frame(minHeight: 32)
          FormatBadge(format: track.format)
        }
      }
      Spacer(minLength: 8)
      FavoriteButton(track: track, size: .row)
    }
    .padding(.vertical, 8)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Now playing: \(track.title), \(track.artistName)")
  }

  private func closedLine(_ line: Tracklist.Line) -> some View {
    let track = line.track
    return Button { session.player.jump(to: line.orderPos) } label: {
      HStack(spacing: 12) {
        Text(line.number).font(.mono(.footnote)).foregroundStyle(.muted).frame(width: 32, alignment: .center)
        VStack(alignment: .leading, spacing: 1) {
          Text(track.title).font(.sans(.body)).essentialLineLimit()
          if let detail = detail(line) {
            Text(detail).font(.sans(.footnote)).foregroundStyle(.muted).essentialLineLimit()
          }
        }
        OfflineMark(store: session.player.downloads, fileId: track.fileId)
        Spacer(minLength: 8)
        Text(Format.time(track.duration)).font(.mono(.footnote)).foregroundStyle(.muted)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(spoken(line))
    .accessibilityHint("Plays from this song")
  }

  /// "Massive Attack · Blue Lines": the artist when the source isn't theirs, the album when it changes.
  private func detail(_ line: Tracklist.Line) -> String? {
    let parts = [line.showsArtist ? line.track.artistName : nil, line.showsAlbum ? line.track.albumTitle : nil].compactMap(\.self)
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private func spoken(_ line: Tracklist.Line) -> String {
    let track = line.track
    let place = line.state == .played ? "played" : line.number == "1" ? "next" : nil
    let joined = line.joinBefore == .continues ? "joined to the song before" : nil
    return [line.number.isEmpty ? nil : line.number, track.title, line.showsArtist ? track.artistName : nil, Format.time(track.duration), place, joined]
      .compactMap(\.self).joined(separator: ", ")
  }

  /// Between two lines, how the first becomes the second.
  @ViewBuilder
  private func join(_ join: Tracklist.Join, playing: Bool) -> some View {
    switch join {
    case .none:
      EmptyView()
    case .continues:
      // Heard as one: a hairline down the number column.
      Rectangle().fill(.white.opacity(0.18)).frame(width: 1, height: 10).frame(width: 32).accessibilityHidden(true)
    case .crossfade(let seconds):
      Label("\(seconds) s", systemImage: "arrow.left.and.right").font(.mono(.caption2)).foregroundStyle(.muted)
        .padding(.leading, 44).frame(height: 18).accessibilityHidden(true)
    case .dj:
      // The next mix in words, opening the transition sheet (phase 5's line).
      TransitionLine(player: session.player).padding(.leading, 44)
    case .djLater:
      Rectangle().stroke(style: StrokeStyle(lineWidth: 1, dash: [2, 3])).foregroundStyle(.white.opacity(0.2))
        .frame(width: 1, height: 10).frame(width: 32).accessibilityHidden(true)
    }
  }

  @ViewBuilder
  private func menu(_ line: Tracklist.Line) -> some View {
    let track = line.track
    if line.state == .upcoming, line.orderPos > session.player.queue.pos + 1 {
      Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { playNext(line) }
    }
    Button("Add to playlist…", systemImage: "music.note.list") { session.addToPlaylist([track]) }
    Button("Go to album", systemImage: "square.stack") { session.actions.goToAlbum(track) }
    Button("Go to artist", systemImage: "music.mic") { session.actions.goToArtist(track) }
    if line.state == .upcoming {
      Button("Remove from queue", systemImage: "xmark", role: .destructive) { remove(line) }
    }
  }

  /// Where the line sits in the queue model's Up next.
  private func offset(_ line: Tracklist.Line) -> Int { line.orderPos - session.player.queue.pos - 1 }

  private func remove(_ line: Tracklist.Line) {
    QueueModel(session: session).remove([offset(line)])
  }

  private func playNext(_ line: Tracklist.Line) {
    let model = QueueModel(session: session)
    let upcoming = model.upcoming
    let at = offset(line)
    guard upcoming.indices.contains(at) else { return }
    model.playNext(upcoming[at])
  }
}
