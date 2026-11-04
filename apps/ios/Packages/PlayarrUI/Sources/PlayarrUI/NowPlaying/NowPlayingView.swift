import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Now Playing, over everything (apps/web/src/components/NowPlaying.tsx): swipe down to close, "Playing from", the
/// sleep timer, lyrics, the ⋯ menu, the cover (or lyrics), the song, the seek bar and the transport. On an iPad, the
/// cover beside the song with Up next; on a phone held sideways, the sleeve: the cover on the left, the tracklist
/// and its deck on the right (docs/plans/2026-11-04-ios-now-playing-landscape.md).
struct NowPlayingView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
  #if os(iOS)
    @Environment(\.verticalSizeClass) private var verticalSizeClass
  #endif
  @State private var drag: CGFloat = 0
  /// How far the sideways cover has been pulled towards the next or previous song.
  @State private var swipe: CGFloat = 0
  /// Sideways and left alone while playing: the controls fade and the song playing takes the stage.
  @State private var staged = false
  @State private var touched = Date()

  /// How long sideways Now Playing waits, untouched while playing, before the stage.
  static let stageAfter: Duration = .seconds(12)

  private var layout: NowPlayingLayout {
    #if os(iOS)
      let compactHeight = verticalSizeClass == .compact
    #else
      let compactHeight = false
    #endif
    return NowPlayingLayout.choose(split: session.router.layout == .split, compactHeight: compactHeight, accessibilitySize: typeSize.isAccessibilitySize)
  }

  var body: some View {
    let player = session.player
    let model = NowPlayingModel(session: session)
    @Bindable var router = session.router
    ZStack {
      if let track = player.queue.currentTrack {
        backdrop(track)
        if layout == .sideways {
          sleeve(model, track: track)
        } else {
          VStack(spacing: 24) {
            header(model, track: track)
              .contentShape(Rectangle())
              .gesture(closeGesture)
            if layout == .wide {
              // The web's desktop Now Playing: the cover (or lyrics) beside the song, its controls and Up next.
              HStack(spacing: 64) {
                artwork(track)
                VStack(spacing: 24) {
                  song(track)
                  SeekBar(player: player)
                  Transport(player: player)
                  TransitionLine(player: player)
                  UpNextPreview(session: session)
                }
                .frame(maxWidth: 480)
              }
            } else {
              artwork(track)
              song(track)
              SeekBar(player: player)
              Transport(player: player)
              TransitionLine(player: player)
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 24)
          .padding(.vertical, 12)
        }
      }
    }
    .offset(y: drag)
    .preferredColorScheme(.dark)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Now playing")
    .accessibilityIdentifier("nowPlaying")
    .accessibilityAction(.escape) { router.nowPlaying = false }
    .onChange(of: player.queue.currentTrack == nil) { _, empty in if empty { router.nowPlaying = false } }
    #if os(iOS)
      // Sideways and charging: a phone in a stand keeps its screen on (Settings → Appearance).
      .onChange(of: layout == .sideways && appearance.keepScreenOnSideways, initial: true) { _, on in ScreenAwake.update(sideways: on, enabled: true) }
      .onReceive(NotificationCenter.default.publisher(for: UIDevice.batteryStateDidChangeNotification)) { _ in
        ScreenAwake.update(sideways: layout == .sideways, enabled: appearance.keepScreenOnSideways)
      }
      .onDisappear { ScreenAwake.update(sideways: false, enabled: false) }
    #endif
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

  /// The cover, or the lyrics in its place.
  @ViewBuilder
  private func artwork(_ track: Track) -> some View {
    if session.router.lyrics {
      LyricsView(trackId: track.id, session: session).id(track.id)
    } else {
      cover(track, playing: session.player.queue.playing)
        .gesture(closeGesture)
    }
  }

  /// The cover itself, blown up and blurred.
  private func backdrop(_ track: Track) -> some View {
    ZStack {
      Color.black
      Cover(path: track.coverUrl, points: 300).scaleEffect(1.5).blur(radius: 90).opacity(0.55).saturation(1.5)
      RadialGradient(colors: [.clear, .black.opacity(0.5), .black.opacity(0.92)], center: .top, startRadius: 0, endRadius: 700)
      // A dark wash over it all, so words stay readable over a bright cover.
      Color.black.opacity(0.3)
    }
    .ignoresSafeArea()
  }

  private func header(_ model: NowPlayingModel, track: Track, tail: String? = nil) -> some View {
    HStack {
      Button { session.router.nowPlaying = false } label: { Image(systemName: "chevron.down").font(.title2).frame(width: 44, height: 44).contentShape(Rectangle()) }
        .accessibilityLabel("Close now playing")
        .keyboardShortcut(.cancelAction)
      Spacer()
      VStack(spacing: 2) {
        Kicker(text: "Playing from").accessibilityHidden(true)
        Button(model.playingFrom ?? "") { if let route = model.playingFromRoute { session.router.go(route) } }
          .font(.sans(.footnote)).essentialLineLimit()
          .frame(minHeight: 44)
          .contentShape(Rectangle())
          .accessibilityLabel("Playing from \(model.playingFrom ?? "")")
        if let tail { Text(tail).font(.mono(.caption2)).foregroundStyle(.muted) }
      }
      Spacer()
      SleepTimerMenu(player: session.player)
      Button { session.router.lyrics.toggle() } label: { Image(systemName: "quote.bubble").font(.title3).frame(width: 44, height: 44).contentShape(Rectangle()) }
        .foregroundStyle(session.router.lyrics ? theme.accent.color : .primary)
        .accessibilityLabel("Lyrics")
        .accessibilityAddTraits(session.router.lyrics ? .isSelected : [])
        .sensoryFeedback(Haptic.toggle, trigger: session.router.lyrics)
      Menu {
        Button("Add to playlist…", systemImage: "music.note.list") { session.addToPlaylist([track]) }
        Button("Start radio", systemImage: "dot.radiowaves.left.and.right") { Task { await session.actions.startRadio(track) } }
        Button("Go to album", systemImage: "square.stack") { session.actions.goToAlbum(track) }
        Button("Go to artist", systemImage: "music.mic") { session.actions.goToArtist(track) }
        TrackLibraryMenuItems(track: track)
        Button("Open queue", systemImage: "list.bullet") { session.router.showQueue() }
      } label: {
        Image(systemName: "ellipsis").font(.title3).frame(width: 44, height: 44).contentShape(Rectangle())
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
        Text(track.title).font(.display(.title)).essentialLineLimit(2)
        HStack(spacing: 8) {
          Button(track.artistName) { session.actions.goToArtist(track) }
            .font(.sans(.title3)).foregroundStyle(.secondary).buttonStyle(.plain)
          FormatBadge(format: track.format)
        }
      }
      Spacer()
      FavoriteButton(track: track)
    }
  }

  // MARK: Sideways

  /// The sleeve, opened: the cover on the left, the tracklist (or the lyrics) with its deck on the right.
  private func sleeve(_ model: NowPlayingModel, track: Track) -> some View {
    let player = session.player
    let tracklist = Tracklist(queue: player.queue, transitions: player.settings.transitions, crossfade: player.settings.crossfade, autoplay: player.settings.autoplay)
    return GeometryReader { geometry in
      let side = NowPlayingLayout.coverSide(width: geometry.size.width, height: geometry.size.height, accessibilitySize: typeSize.isAccessibilitySize)
      HStack(spacing: 28) {
        sleeveCover(track, side: side)
        VStack(spacing: 8) {
          if !staged {
            header(model, track: track, tail: tracklist.left(elapsed: player.time))
              .transition(.opacity)
          }
          if session.router.lyrics {
            LyricsView(trackId: track.id, session: session).id(track.id)
          } else {
            NowPlayingTracklist(session: session, staged: staged)
          }
          if !staged {
            NowPlayingDeck(player: player).transition(.opacity)
          }
        }
        .frame(maxWidth: .infinity)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    // Any touch brings the controls back and starts the 12 seconds again.
    .simultaneousGesture(TapGesture().onEnded { wake() })
    .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in if staged { wake() } else { touched = Date() } })
    .task(id: touched) {
      try? await Task.sleep(for: Self.stageAfter)
      guard !Task.isCancelled, player.queue.playing, !voiceOver else { return }
      setStaged(true)
    }
    .onChange(of: player.queue.playing) { _, playing in if !playing { wake() } }
    .onChange(of: voiceOver) { _, on in if on { wake() } }
  }

  /// The cover, as big as the window allows: swipe down to close, left or right for the next or previous song, tap
  /// for the stage.
  private func sleeveCover(_ track: Track, side: CGFloat) -> some View {
    let player = session.player
    return cover(track, playing: player.queue.playing)
      .frame(width: side, height: side)
      .offset(x: swipe)
      .frame(maxHeight: .infinity)
      .onTapGesture { staged ? wake() : setStaged(true) }
      .gesture(
        DragGesture()
          .onChanged { value in
            if abs(value.translation.width) > abs(value.translation.height) {
              // Follows the finger, harder to pull the further it goes.
              swipe = value.translation.width * 0.6
            } else {
              drag = max(0, value.translation.height) * 0.9
            }
          }
          .onEnded { value in
            let width = value.translation.width
            if abs(width) > abs(value.translation.height) {
              if abs(width) > side * 0.3 { width < 0 ? player.next() : player.previous() }
              withAnimation(.spring(duration: 0.35)) { swipe = 0 }
            } else if NowPlayingModel.closes(translation: value.translation.height, velocity: value.velocity.height) {
              session.router.nowPlaying = false
            } else {
              withAnimation(.spring(duration: 0.3)) { drag = 0 }
            }
          }
      )
      .accessibilityLabel("\(track.albumTitle) cover")
      .accessibilityHint("Swipe left or right for the next or previous song")
  }

  private func wake() {
    touched = Date()
    setStaged(false)
  }

  private func setStaged(_ on: Bool) {
    guard on != staged else { return }
    if appearance.reduceMotion(system: systemReduceMotion) {
      staged = on
    } else {
      withAnimation(.easeInOut(duration: 0.6)) { staged = on }
    }
  }
}
