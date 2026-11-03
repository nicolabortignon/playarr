import Foundation
import Observation
import PlayarrAPI

/// The player the screens use: the queue (as the web's `usePlayer`) and its clock, driving the audio engine, even
/// volume, play reports, radio continuation, the sleep timer, Now Playing and the stream cache. Everything a screen
/// changes goes through a method here, which updates `queue` and then `sync()`s the engine to it.
@MainActor @Observable
public final class Player {
  public struct Notice: Equatable, Sendable {
    public let id = UUID()
    public let text: String
    public let isError: Bool
  }

  /// A song in the queue at one moment: its index in `queue`, and the restart token (the same song played again is
  /// another entry).
  struct Entry: Equatable {
    let index: Int
    let token: Int
  }

  public private(set) var queue: QueueState
  /// Seconds into the current song.
  public private(set) var time: Double = 0
  public private(set) var duration: Double = 0
  /// Seconds decoded ahead of the playhead.
  public private(set) var buffered: Double = 0
  public private(set) var loading = false
  public private(set) var error: String?
  /// A message for a toast.
  public private(set) var notice: Notice?

  public let settings: PlaybackSettings
  public let levels: LevelStore
  public let sleep = SleepTimer()

  @ObservationIgnored public private(set) var engine: AudioEngine
  @ObservationIgnored public var nowPlaying: NowPlayingBridge?
  @ObservationIgnored public var session: (any AudioSessionControlling)?
  @ObservationIgnored public var network: () -> NetworkKind = { .wifi }

  @ObservationIgnored private let backend: any PlayerBackend
  @ObservationIgnored private let cache: StreamCache
  @ObservationIgnored private let reports: PlayReportQueue
  @ObservationIgnored private let saved: JSONFile<QueueState>
  @ObservationIgnored private let makeEngine: () throws -> AudioEngine
  @ObservationIgnored private var tracker: PlayTracker
  @ObservationIgnored private(set) var loaded: (entry: Entry, item: EngineItem)?
  @ObservationIgnored private(set) var upcoming: (index: Int, item: EngineItem, join: Join)?
  @ObservationIgnored private var policy = SessionPolicy()
  @ObservationIgnored private var firstLoad = true
  @ObservationIgnored private var lastSaved = Date.distantPast
  /// The song whose start was last checked for a radio continuation.
  @ObservationIgnored private var radioAskedAt: Entry?
  @ObservationIgnored private var ticker: Task<Void, Never>?

  /// `directory` is this server and account's folder in Application Support: the queue, unsent plays and the stream
  /// cache live there. `makeSource` replaces the real sources (tests); `makeEngine` the real engine.
  public init(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    makeEngine: (@MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine)? = nil,
    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil
  ) throws {
    let cache = StreamCache(directory: directory.appending(path: "stream", directoryHint: .isDirectory))
    let levels = LevelStore { ids in try await backend.levels(ids) }
    let reports = PlayReportQueue(file: directory.appending(path: "pending-plays.json")) { try await backend.reportPlays($0) }
    let sources: @MainActor (EngineItem, Int64) -> any PCMSource = makeSource ?? { item, frame in
      TrackSource(
        track: item.track, firstFrame: frame,
        origin: TrackSource.Origin(
          stream: backend.streamRequest(item.track),
          levelled: levels.levels[item.track.recordingId] == nil ? nil : backend.levelledRequest(item.track)),
        cache: cache)
    }
    let build = { try makeEngine?(sources) ?? AudioEngine(makeSource: sources) }
    self.backend = backend
    self.settings = settings
    self.levels = levels
    self.cache = cache
    self.reports = reports
    self.makeEngine = build
    saved = JSONFile(directory.appending(path: "queue.json"))
    queue = saved.read() ?? QueueState()
    engine = try build()
    tracker = PlayTracker { _ in }
    tracker = PlayTracker { [weak self] plays in self?.report(plays) }
    engine.onEvent = { [weak self] in self?.handle($0) }
    sync()
    Task { await reports.retry() }
  }

  /// Runs the 10 Hz clock (the app calls this once; tests call `tick()` themselves).
  public func start() {
    ticker?.cancel()
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(100))
        self?.tick()
      }
    }
  }

  // MARK: The queue (as store.ts)

  /// Plays `tracks` from `startAt` (an index), in order unless `shuffle` ("Play means in order"), from `at` seconds.
  public func play(_ tracks: [Track], startAt index: Int = 0, source: PlaySource? = nil, shuffle: Bool = false, at seconds: Double? = nil) {
    queue.playTracks(tracks, startIndex: index, shuffle: shuffle, source: source, at: seconds)
    sync()
  }

  public func playNext(_ tracks: [Track]) { change { $0.playNext(tracks) } }
  public func addToQueue(_ tracks: [Track]) { change { $0.addToQueue(tracks) } }
  public func jump(to orderPos: Int, at seconds: Double? = nil) { change { $0.jumpTo(orderPos, at: seconds) } }
  public func remove(at orderPos: Int) { change { $0.removeAt(orderPos) } }
  public func move(from: Int, to: Int) { change { $0.move(from: from, to: to) } }
  public func setUpcoming(_ queueIndices: [Int]) { change { $0.setUpcoming(queueIndices) } }
  public func clearUpcoming() { change { $0.clearUpcoming() } }
  /// A press of Next.
  public func next() { change { $0.next() } }
  /// Restarts the song past 3 s, else goes back one.
  public func previous() { change { [time] in $0.prev(currentTime: time) } }
  public func toggleShuffle() { change { $0.toggleShuffle() } }
  public func cycleRepeat() { change { $0.cycleRepeat() } }
  public func setVolume(_ volume: Double) { change { $0.setVolume(volume) } }
  public func toggleMute() { change { $0.muted.toggle() } }
  public func setMixMode(_ mode: MixMode) { change { $0.mixMode = mode } }

  public func setPlaying(_ on: Bool) {
    guard queue.pos >= 0 else { return }
    change { $0.playing = on }
  }

  public func togglePlay() { setPlaying(!queue.playing) }

  public func seek(to seconds: Double) {
    guard loaded != nil else { return }
    tracker.pause()
    engine.seek(to: seconds)
    time = seconds
    showNowPlaying()
  }

  /// "Start radio" on a song: it, then songs like it from the library.
  public func startRadio(_ track: Track) async {
    do {
      let more = try await backend.radio(seeds: [track.recordingId], exclude: [track.recordingId], count: Radio.count)
      play([track] + more, source: Radio.source(for: track))
    } catch {
      notice = Notice(text: "Couldn’t start a radio: \(error.localizedDescription)", isError: true)
    }
  }

  // MARK: Sleep timer

  public func sleep(minutes: Double) {
    sleep.sleep(minutes: minutes)
    sync()
  }

  public func sleepAtEndOfSong() {
    sleep.sleepAtEndOfSong()
    sync()
  }

  public func cancelSleep() {
    sleep.cancel()
    sync()
  }

  // MARK: The system

  public func handle(_ event: SessionEvent) {
    switch policy.action(for: event, playing: queue.playing) {
    case .pause:
      setPlaying(false)
    case .resume:
      // The system stopped the engine: a new epoch from where it was.
      setPlaying(true)
      seek(to: time)
    case .rebuild:
      rebuildEngine()
    case .none:
      break
    }
  }

  /// The app is closing: the song so far is reported (never as a skip), the queue saved.
  public func appWillTerminate() {
    tracker.finish(.closed)
    queue.resumeAt = time
    saved.write(queue)
  }

  /// The account is switched away from: the song so far is reported, the queue saved, the engine stopped, and the lock
  /// screen and remote commands let go, so the next account's player owns them.
  public func shutDown() {
    ticker?.cancel()
    ticker = nil
    appWillTerminate()
    queue.playing = false
    engine.stop()
    nowPlaying?.update(track: nil, elapsed: 0, playing: false)
    nowPlaying?.unregister()
    nowPlaying = nil
  }

  /// The 10 Hz clock: moves the engine on, the time, the history, the sleep timer's fade; saves where it is every 5 s.
  public func tick(now: Date = Date()) {
    engine.pump()
    if loaded != nil { time = engine.position }
    buffered = engine.bufferedAhead
    loading = engine.state == .loading || engine.state == .buffering
    if engine.state == .playing { tracker.tick(time) } else { tracker.pause() }
    let volume = queue.muted ? 0 : Float(queue.volume * queue.volume)
    engine.setMasterGain(volume * sleep.gain(at: now))
    if sleep.runsOut(at: now) {
      setPlaying(false)
      notice = Notice(text: "Sleep timer: music stopped", isError: false)
    }
    if loaded != nil, now.timeIntervalSince(lastSaved) >= 5 {
      queue.resumeAt = time
      save(at: now)
    }
  }

  // MARK: Keeping the engine in step

  private func change(_ edit: (inout QueueState) -> Void) {
    edit(&queue)
    sync()
  }

  private var currentEntry: Entry? {
    queue.currentTrack == nil ? nil : Entry(index: queue.order[queue.pos], token: queue.restartToken)
  }

  /// Brings the engine, levels, radio, prefetch, Now Playing and the saved queue in line with `queue`.
  private func sync() {
    let entry = currentEntry
    if entry != loaded?.entry || (entry != nil && queue.playing && engine.state == .idle) {
      loadCurrent(entry)
    } else if loaded != nil {
      if queue.playing {
        try? session?.activate()
        engine.play()
      } else {
        engine.pause()
      }
    }
    updateUpcoming()
    loadLevels()
    continueRadio()
    prefetch()
    showNowPlaying()
    save()
  }

  private func loadCurrent(_ entry: Entry?) {
    guard let entry, let track = queue.currentTrack else {
      tracker.finish(.changed)
      engine.stop()
      loaded = nil
      upcoming = nil
      (time, duration) = (0, 0)
      return
    }
    // Played again from the start (repeat one, "previous" near the start): it counts as heard through.
    tracker.finish(loaded?.entry.index == entry.index ? .ended : .changed)
    tracker.start(track)
    let start = queue.startAt ?? (firstLoad ? queue.resumeAt : 0)
    queue.startAt = nil
    firstLoad = false
    let item = EngineItem(track: track, gainDb: gainDb(track), startAt: start)
    loaded = (entry, item)
    upcoming = nil
    error = nil
    (time, duration) = (start, track.duration)
    if queue.playing { try? session?.activate() }
    engine.load(item, playing: queue.playing)
  }

  /// Tells the engine what plays after the current song and how: the album in order never fades (JoinRules), repeat
  /// one plays the song again without a gap, the sleep timer's "end of song" plays nothing after it.
  private func updateUpcoming() {
    guard let current = loaded, !sleep.endOfSong,
      let index = queue.repeatMode == .one ? current.entry.index : queue.upNextIndex
    else {
      upcoming = nil
      engine.setUpcoming(nil)
      return
    }
    let track = queue.queue[index]
    let fade = queue.repeatMode == .one ? 0 : JoinRules.fadeSeconds(current.item.track, track, crossfade: settings.crossfadeSeconds)
    let id = upcoming?.index == index ? upcoming?.item.id ?? UUID() : UUID()
    let item = EngineItem(id: id, track: track, gainDb: gainDb(track))
    upcoming = (index, item, .crossfade(seconds: fade))
    engine.setUpcoming(item, join: .crossfade(seconds: fade))
  }

  private func gainDb(_ track: Track) -> Double {
    levels.gainDb(for: track, in: queue, enabled: settings.levelVolume) ?? 0
  }

  private func loadLevels() {
    let tracks = [queue.currentTrack, queue.upNext]
    Task {
      await levels.load(tracks)
      updateUpcoming()  // the next song's gain, if it came in time
    }
  }

  /// When the last song of the queue starts (nothing repeating, autoplay on): songs like the last few. Only when a
  /// song starts, as the web's `useAutoplay`: clearing Up next leaves the queue ending after this song.
  private func continueRadio() {
    guard let entry = currentEntry, entry != radioAskedAt else { return }
    radioAskedAt = entry
    guard let ask = Radio.continuation(for: queue, autoplay: settings.autoplay) else { return }
    Task {
      guard let more = try? await backend.radio(seeds: ask.seeds, exclude: ask.exclude, count: Radio.count), !more.isEmpty else { return }
      // Still on that last song (nothing was queued meanwhile): carry on with these.
      guard currentEntry == entry, queue.pos == queue.order.count - 1 else { return }
      addToQueue(more)
    }
  }

  private func prefetch() {
    let ahead = queue.upcoming(PrefetchPolicy.songsAhead(on: network()))
    let keep = Set((ahead + [queue.currentTrack].compactMap { $0 }).map(\.fileId))
    let requests = ahead.map { ($0, backend.streamRequest($0)) }
    Task { [cache] in
      await cache.keepOnly(keep)
      await cache.prefetch(requests)
    }
  }

  private func showNowPlaying() {
    nowPlaying?.update(track: queue.currentTrack, elapsed: time, playing: queue.playing)
  }

  private func save(at now: Date = Date()) {
    lastSaved = now
    saved.write(queue)
  }

  private func report(_ plays: [PlayReport]) {
    // Settings → Playback can keep this device out of the history.
    guard settings.recordPlays else { return }
    Task { [reports] in await reports.send(plays) }
  }

  private func handle(_ event: EngineEvent) {
    switch event {
    case .advanced(let id):
      guard let joined = upcoming, joined.item.id == id else { return }
      // Joined on its own at the end of the song: heard through.
      tracker.finish(.ended)
      tracker.start(joined.item.track)
      queue.next(auto: true)
      if let entry = currentEntry { loaded = (entry, joined.item) }
      upcoming = nil
      time = 0
      duration = joined.item.track.duration
      sync()
    case .ended(let id):
      guard loaded?.item.id == id else { return }
      tracker.finish(.ended)
      queue.next(auto: true)
      // The sleep timer's "end of song": on to the next song, paused, for when you're back.
      if sleep.stopsAtSongEnd() { queue.playing = false }
      sync()
    case .mixMissed:
      break  // Task 12 handles it.
    case .failed(let id, let failure):
      guard loaded?.item.id == id else { return }
      error = failure.message
      notice = Notice(text: failure.message, isError: true)
      queue.playing = false
      showNowPlaying()
    }
  }

  private func rebuildEngine() {
    let at = time
    guard let fresh = try? makeEngine() else { return }
    engine.stop()
    engine = fresh
    engine.onEvent = { [weak self] in self?.handle($0) }
    loaded = nil
    queue.startAt = at
    sync()
  }
}
