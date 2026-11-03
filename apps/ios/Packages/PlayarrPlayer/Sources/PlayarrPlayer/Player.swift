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
  /// DJ mix: the transition into the next song, its file, the songs' mix maps.
  public let transitions: TransitionCoordinator

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
  /// Edit mix points' "Play from": the song previewing now, if any.
  public private(set) var preview: Preview?
  /// The previews of one edit, on their own engine, while the queue waits paused.
  @ObservationIgnored private(set) var previews: PreviewSession?
  /// A press of Next being mixed live into the next song: its item and the mix (kept over later syncs).
  @ObservationIgnored private var pressed: (id: UUID, join: Join)?
  /// A press of Next waiting for the mix into that song about to start.
  @ObservationIgnored private var pressAwaits: UUID?
  /// Items whose mix couldn't be placed in time: they follow gapless.
  @ObservationIgnored private var missedMixes: Set<UUID> = []
  /// The sleep timer ended the song in the middle of a mix: the music stops where the mix ends.
  @ObservationIgnored private var pauseAtMixEnd: SampleTime?
  @ObservationIgnored private var seekedSinceTick = false

  /// The next song's mix couldn't be placed in time: it follows gapless (Stats for nerds says so).
  public var upcomingMixMissed: Bool { upcoming.map { missedMixes.contains($0.item.id) } ?? false }

  /// With DJ mix the engine keeps 2.5 s scheduled (not 10), so a press of Next mixes a few seconds after it.
  static let djScheduleAhead = 2.5
  /// Room for scheduling between a press of Next and where its mix may start.
  static let pressMargin = 0.25

  /// `directory` is this server and account's folder in Application Support: the queue, unsent plays and the stream
  /// cache live there. `makeSource` replaces the real sources (tests); `makeEngine` the real engine.
  public init(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    makeEngine: (@MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine)? = nil,
    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil, scheduler: (any Scheduling)? = nil
  ) throws {
    let cache = StreamCache(directory: directory.appending(path: "stream", directoryHint: .isDirectory))
    let levels = LevelStore { ids in try await backend.levels(ids) }
    let reports = PlayReportQueue(file: directory.appending(path: "pending-plays.json")) { try await backend.reportPlays($0) }
    let sources: @MainActor (EngineItem, Int64) -> any PCMSource = makeSource ?? { item, frame in
      // After a transition into an MP3: the server's rest of it, which runs on from the transition sample for sample.
      if let rest = item.continuation {
        return TrackSource(
          track: Track.continuation(of: item.track, url: rest.url, from: rest.from), firstFrame: frame - EngineFormat.frames(rest.from),
          origin: TrackSource.Origin(stream: backend.transitionRequest(rest.url), levelled: nil), cache: cache)
      }
      return TrackSource(
        track: item.track, firstFrame: frame,
        origin: TrackSource.Origin(
          stream: backend.streamRequest(item.track),
          levelled: levels.levels[item.track.recordingId] == nil ? nil : backend.levelledRequest(item.track)),
        cache: cache)
    }
    let build = { try makeEngine?(sources) ?? AudioEngine(makeSource: sources) }
    let scheduler = scheduler ?? TaskScheduling()
    transitions = TransitionCoordinator(
      planner: TransitionPlanner(scheduler: scheduler) { try await backend.transition($0) },
      mixMaps: MixMapStore(scheduler: scheduler) { try await backend.mixMaps($0) },
      download: { path in
        let name = URL(string: path)?.lastPathComponent ?? path
        if let kept = await cache.completedTransition(named: name) { return kept }
        let download = await cache.transition(named: name, request: backend.transitionRequest(path))
        try await download.waitUntilFinished()
        return await cache.transitionFile(named: name)
      })
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
    transitions.planner.isPlaying = { [weak self] in self?.queue.playing ?? false }
    transitions.planner.isOnline = { [weak self] in self?.network() != .offline }
    transitions.onChange = { [weak self] in self?.updateUpcoming() }
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
    endPreviews(resume: false)
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
  /// A press of Next. With DJ mix it's mixed into the next song on the next bar, when it can be (see `takeNextPress`).
  public func next() {
    if takeNextPress() { return }
    change { $0.next() }
  }
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
    endPreviews(resume: false)
    guard loaded != nil else { return }
    tracker.pause()
    seekedSinceTick = true
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
    endPreviews(resume: false)
    appWillTerminate()
    queue.playing = false
    // A closed session asks the server nothing more.
    transitions.planner.update(wanted: nil, playing: nil)
    engine.stop()
    nowPlaying?.update(track: nil, elapsed: 0, playing: false)
    nowPlaying?.unregister()
    nowPlaying = nil
  }

  /// The 10 Hz clock: moves the engine on, the time, the history, the sleep timer's fade; saves where it is every 5 s.
  public func tick(now: Date = Date()) {
    engine.pump()
    tickPreview()
    if loaded != nil { time = engine.position }
    buffered = engine.bufferedAhead
    loading = engine.state == .loading || engine.state == .buffering
    if engine.state == .playing { tracker.tick(time) } else { tracker.pause() }
    transitions.planner.clock(time, seeked: seekedSinceTick)
    seekedSinceTick = false
    if let end = pauseAtMixEnd, engine.now >= end {
      // The sleep timer: the mix played out, and the next song waits here, paused.
      pauseAtMixEnd = nil
      setPlaying(false)
    }
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
    // The listener took over: a preview stops, and the queue does what they asked.
    endPreviews(resume: false)
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
    updateTransitions()
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
    pressed = nil
    pressAwaits = nil
    pauseAtMixEnd = nil
    loaded = (entry, item)
    upcoming = nil
    error = nil
    (time, duration) = (start, track.duration)
    if queue.playing { try? session?.activate() }
    engine.load(item, playing: queue.playing)
  }

  /// Tells the engine what plays after the current song and how: the album in order never fades (JoinRules), repeat
  /// one plays the song again without a gap, the sleep timer's "end of song" plays nothing after it. With DJ mix, the
  /// join DJJoin picks (a transition, a mix played live, a cut on the beat), or a press of Next's mix.
  private func updateUpcoming() {
    // A mix already placed plays out (the sleep timer then stops where it ends): taking it back would cost a new epoch.
    if sleep.endOfSong, engine.upcomingPlaced, upcoming?.join.leaveTime != nil { return }
    guard let current = loaded, !sleep.endOfSong,
      let index = queue.repeatMode == .one ? current.entry.index : queue.upNextIndex
    else {
      upcoming = nil
      engine.setUpcoming(nil)
      return
    }
    let track = queue.queue[index]
    let id = upcoming?.index == index ? upcoming?.item.id ?? UUID() : UUID()
    var item = EngineItem(id: id, track: track, gainDb: gainDb(track))
    let join: Join
    if let pressed, pressed.id == id {
      join = pressed.join
    } else if settings.transitions == .dj, queue.repeatMode != .one, track.fileId != current.item.track.fileId, !missedMixes.contains(id) {
      let decided = DJJoin.decide(djContext(current.item, track, gainB: item.gainDb))
      join = decided.join
      item.continuation = decided.continuation
    } else {
      let fade = queue.repeatMode == .one ? 0 : JoinRules.fadeSeconds(current.item.track, track, crossfade: settings.crossfadeSeconds)
      join = .crossfade(seconds: fade)
    }
    upcoming = (index, item, join)
    engine.setUpcoming(item, join: join)
  }

  private func djContext(_ a: EngineItem, _ b: Track, gainB: Double) -> DJJoin.Context {
    let result = transitions.result(from: a.track, to: b)
    return DJJoin.Context(
      result: result, file: transitions.file(for: result), a: transitions.mixMaps.map(a.track.recordingId),
      b: transitions.mixMaps.map(b.recordingId), mode: queue.mixMode,
      sameAlbumInOrder: JoinRules.continues(a.track, b) && DJJoin.playsAlbum(queue.source, a.track), aDuration: a.track.duration,
      position: time, gainA: a.gainDb, gainB: gainB)
  }

  /// DJ mix: the pair the planner asks the server about (none with mixing off, no next song, or the sleep timer
  /// ending this song), at the levels the songs play at; the songs' mix maps; and less scheduled ahead.
  private func updateTransitions() {
    engine.tuning.scheduleAhead = settings.transitions == .dj ? Self.djScheduleAhead : AudioEngine.Tuning().scheduleAhead
    guard settings.transitions == .dj, let current = loaded else {
      transitions.planner.update(wanted: nil, playing: nil)
      return
    }
    let a = current.item
    let next = queue.upNext.flatMap { $0.fileId == a.track.fileId ? nil : $0 }
    var wanted: TransitionPlanner.Pair?
    if let next, queue.mixMode != .off, !sleep.endOfSong {
      let gainB = gainDb(next)
      wanted = TransitionPlanner.Pair(
        from: a.track, to: next, mode: queue.mixMode, fade: settings.djFadeSeconds, albumQueue: DJJoin.playsAlbum(queue.source, a.track),
        levels: a.gainDb != 0 || gainB != 0 ? .init(a: a.gainDb, b: gainB) : nil)
    }
    transitions.planner.update(wanted: wanted, playing: (a.track.fileId, current.entry.token))
    let maps = transitions.mixMaps
    if maps.map(a.track.recordingId) == nil || next.map({ maps.map($0.recordingId) == nil }) == true {
      Task {
        await maps.load([a.track, next])
        updateUpcoming()
      }
    }
  }

  /// A song's mix points were edited (phase 8's Edit mix points): its map is asked for again, and a coming transition
  /// planned with the old points is asked for afresh (the web's `forgetMixMap` and `refreshUpcomingTransition`).
  public func mixPointsChanged(recordingId: String) {
    let maps = transitions.mixMaps
    maps.forget(recordingId)
    transitions.planner.refresh(recordingId: recordingId)
    let tracks = [queue.currentTrack, queue.upNext].filter { $0?.recordingId == recordingId }
    guard !tracks.isEmpty else { return }
    Task {
      await maps.load(tracks)
      updateUpcoming()
    }
  }

  /// A press of Next with DJ mix: taken over (true) to mix into the song it goes to on A's next bar (planned here, as
  /// the server never plans skips), or to wait for a mix into that song about to start; else the queue moves on at
  /// once. Pressed again while waiting: no more waiting. As `takeNext` in the web's AudioEngine.tsx, which only a
  /// desktop browser could do; the engine here mixes it with both songs' own audio, on the lock screen too.
  private func takeNextPress() -> Bool {
    if pressAwaits != nil || pressed != nil {
      pressAwaits = nil
      pressed = nil
      return false
    }
    guard settings.transitions == .dj, queue.mixMode != .off, queue.repeatMode != .one, queue.playing, !sleep.endOfSong,
      engine.state == .playing, engine.mix == nil, !engine.upcomingPlaced, let current = loaded, let to = queue.nextByPress,
      to.fileId != current.item.track.fileId, let index = queue.upNextIndex, queue.queue[index].fileId == to.fileId
    else { return false }
    if let up = upcoming, up.index == index, let begins = up.join.mixBegins, begins - time >= -1, begins - time <= TransitionCoordinator.mixSoon {
      pressAwaits = up.item.id
      return true
    }
    guard let a = transitions.mixMaps.map(current.item.track.recordingId), let b = transitions.mixMaps.map(to.recordingId) else { return false }
    let at = time + engine.tuning.scheduleAhead + engine.tuning.block + Self.pressMargin
    let sameAlbum = JoinRules.continues(current.item.track, to) && DJJoin.playsAlbum(queue.source, current.item.track)
    let plan = SkipPlanner.plan(a: a, b: b, mode: queue.mixMode, sameAlbumInOrder: sameAlbum, at: at)
    guard plan.style != .straight else { return false }
    let id = upcoming?.index == index ? upcoming?.item.id ?? UUID() : UUID()
    pressed = (id, .mix(plan))
    updateUpcoming()
    return true
  }

  private func gainDb(_ track: Track) -> Double {
    levels.gainDb(for: track, in: queue, enabled: settings.levelVolume) ?? 0
  }

  private func loadLevels() {
    let tracks = [queue.currentTrack, queue.upNext]
    Task {
      await levels.load(tracks)
      // The next song's gain, if it came in time; with DJ mix the transition is asked for at it.
      updateTransitions()
      updateUpcoming()
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
      // Joined on its own at the end of the song: heard through; mixed for a press of Next: skipped.
      let skipped = pressed?.id == id || pressAwaits == id
      pressed = nil
      pressAwaits = nil
      tracker.finish(skipped ? .changed : .ended)
      // The sleep timer ends this song: in a mix, the music stops where the mix ends; at a cut, here.
      if sleep.stopsAtSongEnd() {
        if let mix = engine.mix, mix.to == id { pauseAtMixEnd = mix.end } else { queue.playing = false }
      }
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
    case .mixMissed(let id):
      missedMixes.insert(id)
      // A press of Next whose mix couldn't be made in time goes through as a plain skip.
      if pressed?.id == id || pressAwaits == id {
        pressed = nil
        pressAwaits = nil
        change { $0.next() }
      }
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

// MARK: Previews (Edit mix points → Play from)

extension Player {
  /// How long a preview plays.
  public static let previewSeconds: Double = 8

  /// Plays `track` from `seconds` for `length` seconds on a second engine, with the queue paused where it is: its
  /// engine keeps every buffer it scheduled (a transition too), so it goes on from the same sample. More previews
  /// may follow; `endPreviews()` lets the queue go on if it was playing before the first. A preview is never
  /// reported as a play, and the queue, its order and "Playing from" stay as they were.
  public func preview(_ track: Track, from seconds: Double, length: Double = Player.previewSeconds) {
    var previewing = previews ?? PreviewSession(resume: queue.playing)
    previewing.engine?.stop()
    previewing.engine = nil
    if queue.playing {
      queue.playing = false
      sync()
    }
    do {
      let audition = try makeEngine()
      let item = EngineItem(track: track, gainDb: gainDb(track), startAt: max(0, seconds))
      audition.onEvent = { [weak self] event in self?.previewEvent(event) }
      try? session?.activate()
      audition.load(item, playing: true)
      previewing.engine = audition
      previewing.until = item.startAt + length
      previews = previewing
      preview = Preview(recordingId: track.recordingId, from: item.startAt)
    } catch {
      previews = previewing
      preview = nil
      notice = Notice(text: "Couldn’t play a preview: \(error.localizedDescription)", isError: true)
    }
  }

  /// The edit is over (Edit mix points closed): a preview still playing stops, and the queue goes on if it was
  /// playing before the first preview.
  public func endPreviews() { endPreviews(resume: true) }

  func endPreviews(resume: Bool) {
    guard let ended = previews else { return }
    ended.engine?.stop()
    previews = nil
    preview = nil
    if resume, ended.resume, queue.pos >= 0 {
      queue.playing = true
      sync()
    }
  }

  /// The 10 Hz tick moves the preview on, and stops it after its few seconds.
  func tickPreview() {
    guard let previewing = previews, let audition = previewing.engine else { return }
    audition.pump()
    if audition.position >= previewing.until { stopPreview() }
  }

  private func previewEvent(_ event: EngineEvent) {
    switch event {
    case .advanced, .mixMissed:
      break
    case .ended:
      stopPreview()
    case .failed(_, let failure):
      notice = Notice(text: failure.message, isError: true)
      stopPreview()
    }
  }

  /// This preview is done; the queue waits for `endPreviews()`.
  private func stopPreview() {
    previews?.engine?.stop()
    previews?.engine = nil
    preview = nil
  }
}
