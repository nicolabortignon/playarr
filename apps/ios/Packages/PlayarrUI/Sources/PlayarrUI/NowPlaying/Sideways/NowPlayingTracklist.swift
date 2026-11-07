import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The back of the sleeve, when Now Playing is held sideways: the song before, the song playing as the open line
/// (big, with its artist, format and heart), then the rest of the queue, with how each song becomes the next between
/// them. Tap a line to play from it, long-press for its menu, swipe it away to take it out of the queue. The list
/// follows the song playing; scroll away and it stops, comes back with "Now", or on its own after 8 seconds. On an iPad
/// and the iPhone Duo it ends the column under the song and its controls, from the next song (the song playing, a line
/// like the others, is a scroll up).
struct NowPlayingTracklist: View {
  let session: AccountSession
  /// The stage: the other lines dim, and the open line grows and moves to the middle with the time left under it.
  var staged = false
  /// The song playing as the open line; false where the song is shown big above the list already (the iPad, the Duo).
  var openLine = true

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
    GeometryReader { geometry in
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
            .font(.mono(.caption2)).tracking(2).foregroundStyle(.paperDim)
            .frame(minHeight: 44)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .opacity(staged ? 0.25 : 1)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        // In the stage, room above the first line and below the last, so the open line can sit in the middle wherever it
        // is in the queue.
        .contentMargins(.vertical, staged ? geometry.size.height * 0.4 : 0, for: .scrollContent)
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
        .onAppear { scroll(proxy, to: player.queue.pos) }
        .onChange(of: player.queue.pos) { _, pos in if following { follow(proxy, pos: pos) } }
        // Into the stage the open line moves to the middle, and back out to the top; once more as the fade ends, as the
        // line has grown (or shrunk) meanwhile.
        .onChange(of: staged) { if following { follow(proxy, pos: player.queue.pos) } }
        .task(id: staged) {
          try? await Task.sleep(for: .milliseconds(650))
          if !Task.isCancelled, following { follow(proxy, pos: player.queue.pos) }
        }
        // Scrolled away and left alone: back to the song playing, as the lyrics do.
        .task(id: touched) {
          guard !following else { return }
          try? await Task.sleep(for: Self.returnAfter)
          if !Task.isCancelled { follow(proxy, pos: player.queue.pos) }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("nowPlaying.tracklist")
  }

  /// The song playing second from the top, with the one before above it; in the stage, in the middle. Where the song
  /// playing is shown big above the list, the next song at the top (what's played and playing are a scroll away).
  private func follow(_ proxy: ScrollViewProxy, pos: Int) {
    following = true
    if reducesMotion {
      scroll(proxy, to: pos)
    } else {
      withAnimation(.spring(duration: 0.5)) { scroll(proxy, to: pos) }
    }
  }

  private func scroll(_ proxy: ScrollViewProxy, to pos: Int) {
    if staged {
      proxy.scrollTo(pos, anchor: .center)
    } else if openLine {
      proxy.scrollTo(max(0, pos - 1), anchor: .top)
    } else {
      proxy.scrollTo(min(pos + 1, max(pos, session.player.queue.order.count - 1)), anchor: .top)
    }
  }

  @ViewBuilder
  private func row(_ line: Tracklist.Line) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      join(line.joinBefore, playing: line.state == .playing)
      if line.state == .playing, openLine {
        openLine(line)
      } else if line.state == .playing {
        playingLine(line)
      } else {
        HStack(spacing: 4) {
          closedLine(line)
          FavoriteButton(track: line.track, size: .row)
        }
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

  /// The song playing: two lines, the title in Gloock, its artist, format and heart, and the bars that keep time with it
  /// while it plays.
  private func openLine(_ line: Tracklist.Line) -> some View {
    let track = line.track
    let playing = session.player.queue.playing
    return HStack(alignment: .center, spacing: 12) {
      Equalizer(playing: playing)
        .foregroundStyle(theme.accent.color)
        .frame(width: 32)
      VStack(alignment: .leading, spacing: 4) {
        Text(track.title)
          // Grows with Dynamic Type, as the lines around it do.
          .font(.display(size: staged ? 34 : 22, relativeTo: staged ? .largeTitle : .title2))
          .essentialLineLimit(2)
          .foregroundStyle(theme.accent.color)
        HStack(spacing: 8) {
          // As the song ends, what comes next in the artist's place.
          PlayerSecondLine(player: session.player, usual: Button(track.artistName) { session.actions.goToArtist(track) }.buttonStyle(.plain))
            .font(.sans(.subheadline)).foregroundStyle(.paperDim)
            .frame(minHeight: 32)
          FormatBadge(format: track.format)
        }
        // The stage hides the header, which said it: the time left, under the song, as a clock on a stand would.
        if staged { TimeLeftLine(player: session.player).transition(.opacity) }
      }
      Spacer(minLength: 8)
      FavoriteButton(track: track, size: .row)
    }
    .padding(.vertical, 8)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Now playing: \(track.title), \(track.artistName)")
  }

  /// The song playing where it's shown big above the list: a line like the others, the bars that keep time with it in
  /// its number's place and its title in the accent.
  private func playingLine(_ line: Tracklist.Line) -> some View {
    let track = line.track
    return HStack(spacing: 12) {
      Equalizer(playing: session.player.queue.playing)
        .foregroundStyle(theme.accent.color)
        .frame(width: 32)
      VStack(alignment: .leading, spacing: 1) {
        Text(track.title).font(.sans(.body)).foregroundStyle(theme.accent.color).essentialLineLimit()
        if let detail = detail(line) {
          Text(detail).font(.sans(.footnote)).foregroundStyle(.paperDim).essentialLineLimit()
        }
      }
      Spacer(minLength: 8)
      SongLength(track: track, font: .mono(.footnote))
      // As every line has: the lengths line up down the list.
      FavoriteButton(track: track, size: .row)
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Now playing: \(track.title), \(track.artistName)")
  }

  private func closedLine(_ line: Tracklist.Line) -> some View {
    let track = line.track
    return Button { session.player.jump(to: line.orderPos) } label: {
      HStack(spacing: 12) {
        Text(line.number).font(.mono(.footnote)).foregroundStyle(.paperDim).frame(width: 32, alignment: .center)
        VStack(alignment: .leading, spacing: 1) {
          Text(track.title).font(.sans(.body)).essentialLineLimit()
          if let detail = detail(line) {
            Text(detail).font(.sans(.footnote)).foregroundStyle(.paperDim).essentialLineLimit()
          }
        }
        OfflineMark(store: session.player.downloads, fileId: track.fileId)
        Spacer(minLength: 8)
        SongLength(track: track, font: .mono(.footnote))
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(spoken(line))
    .accessibilityHint("Plays from this song")
    // The long press's menu, Move up and Move down included, one swipe away.
    .accessibilityActions { menu(line, divided: false) }
  }

  /// "Massive Attack · Blue Lines": the artist when the source isn't theirs, the album when it changes.
  private func detail(_ line: Tracklist.Line) -> String? {
    let parts = [line.showsArtist ? line.track.artistName : nil, line.showsAlbum ? line.track.albumTitle : nil].compactMap(\.self)
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private func spoken(_ line: Tracklist.Line) -> String {
    let track = line.track
    let place = line.state == .played ? "played" : line.orderPos == session.player.queue.pos + 1 ? "next" : nil
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
      Label("\(seconds) s", systemImage: "arrow.left.and.right").font(.mono(.caption2)).foregroundStyle(.paperDim)
        .padding(.leading, 44).frame(height: 18).accessibilityHidden(true)
    case .dj:
      // The next mix in words, opening the transition sheet (phase 5's line).
      TransitionLine(player: session.player).padding(.leading, 44)
    case .djLater:
      Rectangle().stroke(style: StrokeStyle(lineWidth: 1, dash: [2, 3])).foregroundStyle(.white.opacity(0.2))
        .frame(width: 1, height: 10).frame(width: 32).accessibilityHidden(true)
    }
  }

  /// The one song menu: a song to come has Up next's (Play next moves it up; Move up, Move down and Remove from queue
  /// after a line), the song before the one playing the plain one.
  private func menu(_ line: Tracklist.Line, divided: Bool = true) -> some View {
    let queue = session.player.queue
    let place =
      line.state == .upcoming
      ? SongMenu.upNext(offset(line), of: max(0, queue.order.count - queue.pos - 1), session: session) : SongMenu.Place()
    return MenuButtons(groups: SongMenu.groups(line.track, place: place, session: session), divided: divided)
  }

  /// Where the line sits in the queue model's Up next.
  private func offset(_ line: Tracklist.Line) -> Int { line.orderPos - session.player.queue.pos - 1 }

  /// Swiped away: out of the queue, with Undo.
  private func remove(_ line: Tracklist.Line) {
    QueueModel(session: session).remove(offset(line))
  }
}

/// "7 songs · 38 min left", under the open line in the stage: a view of its own, as the only part of the list that
/// reads the clock (plan 3 §2).
private struct TimeLeftLine: View {
  let player: Player

  var body: some View {
    let tracklist = Tracklist(
      queue: player.queue, transitions: player.settings.transitions, crossfade: player.settings.crossfade, autoplay: player.settings.autoplay)
    if let left = tracklist.left(elapsed: player.time) {
      Text(left).font(.mono(.footnote)).foregroundStyle(.paperDim).lineLimit(1)
    }
  }
}
