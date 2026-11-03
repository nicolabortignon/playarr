import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Now Playing, over everything (apps/web/src/components/NowPlaying.tsx): swipe down to close, "Playing from", the
/// sleep timer, lyrics, the ⋯ menu, the cover (or lyrics), the song, the seek bar and the transport.
struct NowPlayingView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @State private var drag: CGFloat = 0

  var body: some View {
    let player = session.player
    let model = NowPlayingModel(session: session)
    @Bindable var router = session.router
    ZStack {
      if let track = player.queue.currentTrack {
        backdrop(track)
        VStack(spacing: 24) {
          header(model, track: track)
            .contentShape(Rectangle())
            .gesture(closeGesture)
          if router.lyrics {
            LyricsView(trackId: track.id, session: session).id(track.id)
          } else {
            cover(track, playing: player.queue.playing)
              .gesture(closeGesture)
          }
          song(track)
          SeekBar(player: player)
          Transport(player: player)
          TransitionLine(player: player)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
      }
    }
    .offset(y: drag)
    .preferredColorScheme(.dark)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Now playing")
    .accessibilityIdentifier("nowPlaying")
    .accessibilityAction(.escape) { router.nowPlaying = false }
    .onChange(of: player.queue.currentTrack == nil) { _, empty in if empty { router.nowPlaying = false } }
  }

  private var closeGesture: some Gesture {
    DragGesture()
      .onChanged { drag = max(0, $0.translation.height) * 0.9 }
      .onEnded { value in
        if NowPlayingModel.closes(translation: value.translation.height, velocity: value.velocity.height) {
          session.router.nowPlaying = false
        } else {
          withAnimation(.spring(duration: 0.3)) { drag = 0 }
        }
      }
  }

  /// The cover itself, blown up and blurred.
  private func backdrop(_ track: Track) -> some View {
    ZStack {
      Color.black
      Cover(path: track.coverUrl, points: 300).scaleEffect(1.5).blur(radius: 90).opacity(0.55).saturation(1.5)
      RadialGradient(colors: [.clear, .black.opacity(0.5), .black.opacity(0.92)], center: .top, startRadius: 0, endRadius: 700)
    }
    .ignoresSafeArea()
  }

  private func header(_ model: NowPlayingModel, track: Track) -> some View {
    HStack {
      Button { session.router.nowPlaying = false } label: { Image(systemName: "chevron.down").font(.title2).frame(width: 44, height: 44) }
        .accessibilityLabel("Close now playing")
      Spacer()
      VStack(spacing: 2) {
        Kicker(text: "Playing from")
        Button(model.playingFrom ?? "") { if let route = model.playingFromRoute { session.router.go(route) } }
          .font(.footnote).lineLimit(1)
      }
      .accessibilityElement(children: .combine)
      Spacer()
      SleepTimerMenu(player: session.player)
      Button { session.router.lyrics.toggle() } label: { Image(systemName: "quote.bubble").font(.title3).frame(width: 44, height: 44) }
        .foregroundStyle(session.router.lyrics ? theme.accent.color : .primary)
        .accessibilityLabel("Lyrics")
        .accessibilityAddTraits(session.router.lyrics ? .isSelected : [])
      Menu {
        Button("Add to playlist…", systemImage: "music.note.list") { session.addToPlaylist([track]) }
        Button("Start radio", systemImage: "dot.radiowaves.left.and.right") { Task { await session.actions.startRadio(track) } }
        Button("Go to album", systemImage: "square.stack") { session.actions.goToAlbum(track) }
        Button("Go to artist", systemImage: "music.mic") { session.actions.goToArtist(track) }
        TrackLibraryMenuItems(track: track)
        Button("Open queue", systemImage: "list.bullet") { session.router.showQueue() }
      } label: {
        Image(systemName: "ellipsis").font(.title3).frame(width: 44, height: 44)
      }
      .accessibilityLabel("More")
    }
    .buttonStyle(.plain)
  }

  private func cover(_ track: Track, playing: Bool) -> some View {
    let reduce = appearance.reduceMotion(system: systemReduceMotion)
    return Cover(path: track.coverUrl, points: 360, label: track.albumTitle, corner: 8)
      .shadow(color: .black.opacity(0.85), radius: 40, y: 30)
      .scaleEffect(playing ? 1 : 0.86)
      .animation(reduce ? nil : .spring(response: 0.45, dampingFraction: 0.7), value: playing)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .contentShape(Rectangle())
  }

  private func song(_ track: Track) -> some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 6) {
        Text(track.title).font(.title.weight(.semibold)).lineLimit(2)
        HStack(spacing: 8) {
          Button(track.artistName) { session.actions.goToArtist(track) }
            .font(.title3).foregroundStyle(.secondary).buttonStyle(.plain)
          FormatBadge(format: track.format)
        }
      }
      Spacer()
      FavoriteButton(track: track)
    }
  }
}
