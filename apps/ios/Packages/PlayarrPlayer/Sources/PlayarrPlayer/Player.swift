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
  /// Songs and transitions kept on this device for this account: downloads, and songs kept as you listen.
  public let downloads: DownloadStore
  public let sleep = SleepTimer()
  /// DJ mix: the transition into the next song, its file, the songs' mix maps.
  public let transitions: TransitionCoordinator
  /// Keeping time with the music (plan 7 §2): the song's clock as it's heard and what the engine's meter hears, for
  /// the now-playing bars, Now Playing's glow and a blend's covers.
  public let pulse = Pulse()
  /// A DJ blend being heard: both songs together, from the start of the transition until the song being left has faded
  /// out of it. The player's cover shows both, and Now Playing says "Mixing into Teardrop".
  public private(set) var blend: Blend?
  /// While something on screen can keep time with the music (the app active, motion not reduced), the engine's meter
  /// listens to what's heard; otherwise it's off and costs nothing.
  public var metering = false {
    didSet { if metering != oldValue { engine.meter(into: metering ? pulse : nil) } }
  }

  @ObservationIgnored public private(set) var engine: AudioEngine
  @ObservationIgnored public var nowPlaying: NowPlayingBridge?
  /// Told what the system's Now Playing is told (the song, where it is, playing or not), on play, pause, seek and song
  /// changes: the Now Playing widget follows it (plan 11).
  @ObservationIgnored public var onNowPlaying: (@MainActor (_ track: Track?, _ elapsed: Double, _ playing: Bool) -> Void)?
  @ObservationIgnored public var session: (any AudioSessionControlling)?
  /// The network the phone is on (the app's `NetworkMonitor`; tests set their own).
  @ObservationIgnored public var network: () -> NetworkKind {
    get { networkReader.read }
    set { networkReader.read = newValue }
  }
  /// What the session has learned of the server's encoded streams (plan 2 §1).
  @ObservationIgnored let encodeSupport: EncodeSupport
  /// How fast songs arrive, measured from the stream cache's downloads: Automatic quality goes by it.
  @ObservationIgnored public let bandwidth: Bandwidth
  /// The quality each song was opened at, by engine item.
  @ObservationIgnored let openedAt: OpenedQualities
  /// How long the queue must stay put before keep-ahead fetches (tests: zero).
  @ObservationIgnored public var settle: Duration = KeepAhead.settle

  @ObservationIgnored private let backend: any PlayerBackend
  @ObservationIgnored private let cache: StreamCache
  @ObservationIgnored private let networkReader: NetworkReader
  @ObservationIgnored private let reports: PlayReportQueue
  /// The queue, written off the main thread a moment after it changes.
  @ObservationIgnored private let saved: JSONWriter<QueueState>
  /// Where in the song it is, written every 5 s on its own (a small file, not the whole queue).
  @ObservationIgnored private let resumePoint: JSONFile<ResumePoint>
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
  @ObservationIgnored private var keepAheadTask: Task<Void, Never>?
  @ObservationIgnored private var keptAhead: [Track] = []
  @ObservationIgnored private var lastNetwork: NetworkKind = .wifi
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
  /// A song stopped by a dead spot, waiting to play on from where it was (`stall`).
  @ObservationIgnored private(set) var stalled: Stall?
  /// Seconds the music has lately spent waiting for the song to arrive: each one waited adds itself, each ten played
  /// take one away. Past `starvedLimit`, Automatic quality goes a quality lower (`stepDown`).
  @ObservationIgnored private(set) var starved: Double = 0
  @ObservationIgnored private var lastTick: Date?
  /// Seconds of waiting for the song that make Automatic quality go lower: about three dry spells of a second, or one
  /// of three.
  static let starvedLimit = 3.0
  /// The song is waiting out a dead spot (Settings → Copy diagnostics says so).
  public var isStalled: Bool { stalled != nil }
  @ObservationIgnored private var seekedSinceTick = false
  /// The clock is ticking twice a second (`tickInterval`): playing again, it goes back to 10 at once.
  @ObservationIgnored private var tickingSlowly = false

  /// The next song's mix couldn't be placed in time: it follows gapless (Stats for nerds says so).
  public var upcomingMixMissed: Bool { upcoming.map { missedMixes.contains($0.item.id) } ?? false }

  /// A song the network stopped (plan 2 §5): where it was, and how many times it has been tried again while the phone
  /// said it was online.
  struct Stall {
    let entry: Entry
    var at: Double
    var tries = 0
    var retry: Task<Void, Never>?
  }

  /// While the phone is online, a stalled song is tried again after these waits; then it gives up and says why (tests:
  /// shorter).
  @ObservationIgnored var stallRetries: [Duration] = [.seconds(2), .seconds(5), .seconds(10), .seconds(20), .seconds(30)]

  /// Where in the current song it was, saved every 5 s beside the queue; taken at launch when it's the same song at the
  /// same place in the queue.
  struct ResumePoint: Codable, Sendable, Equatable {
    var at: Double
    var pos: Int
    var trackId: Int

    func matches(_ queue: QueueState) -> Bool { queue.pos == pos && queue.currentTrack?.id == trackId }
  }

  /// With DJ mix the engine keeps 2.5 s scheduled (not 10), so a press of Next mixes a few seconds after it.
  static let djScheduleAhead = 2.5
  /// Room for scheduling between a press of Next and where its mix may start.
  static let pressMargin = 0.25

  /// `directory` is this server and account's folder in Application Support: the queue, unsent plays, the stream
  /// cache and downloads live there. `transport` fetches downloads (the app's background session; a foreground one by
  /// default). `makeSource` replaces the real sources (tests); `makeEngine` the real engine.
  public init(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    transport: any DownloadTransport = URLSessionTransport(configuration: .default),
    makeEngine: (@MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine)? = nil,
    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil, scheduler: (any Scheduling)? = nil
  ) throws {
    let folder = OfflineFolder(root: directory)
    let networkReader = NetworkReader()
    let bandwidth = Bandwidth(kbps: settings.lastMeasured(on: networkReader.read()))
    let opened = OpenedQualities()
    let cache = StreamCache(directory: folder.stream, bandwidth: bandwidth)
    let support = EncodeSupport()
    let downloads = DownloadStore(folder: folder, settings: settings, cache: cache, transport: transport, backend: backend, support: support)
    let levels = LevelStore(file: directory.appending(path: "levels.json")) { ids in try await backend.levels(ids) }
    levels.remember(downloads.keptLevels)
    downloads.learnedLevels = { [weak levels] found in levels?.remember(found) }
    let reports = PlayReportQueue(file: directory.appending(path: "pending-plays.json")) { try await backend.reportPlays($0) }
    let sources: @MainActor (EngineItem, Int64) -> any PCMSource = makeSource ?? { item, frame in
      // After a transition into an MP3: the server's rest of it, which runs on from the transition sample for sample.
      if let rest = item.continuation {
        return TrackSource(
          track: Track.continuation(of: item.track, url: rest.url, from: rest.from), firstFrame: frame - EngineFormat.frames(rest.from),
          origin: TrackSource.Origin(
            stream: backend.transitionRequest(rest.url), levelled: nil, kept: downloads.keptTransitionFile(rest.url)),
          cache: cache)
      }
      let network = networkReader.read()
      let quality = settings.streamQuality(for: item.track, on: network, kbps: bandwidth.estimate())
      opened.record(item.id, quality)
      return TrackSource(
        track: item.track, firstFrame: frame,
        origin: Self.origin(
          for: item.track, at: quality, on: network, backend: backend, downloads: downloads,
          levelled: levels.levels[item.track.recordingId] != nil, support: support),
        cache: cache)
    }
    let build = { try makeEngine?(sources) ?? AudioEngine(makeSource: sources) }
    let scheduler = scheduler ?? TaskScheduling()
    transitions = TransitionCoordinator(
      planner: TransitionPlanner(scheduler: scheduler) { try await backend.transition($0) },
      mixMaps: MixMapStore(scheduler: scheduler) { try await backend.mixMaps($0) },
      download: { path in
        // Kept with a download: played from here, online too (the names are content keys).
        if let local = await downloads.keptTransitionFile(path) { return local }
        let name = URL(string: path)?.lastPathComponent ?? path
        if let kept = await cache.completedTransition(named: name) { return kept }
        let download = await cache.transition(named: name, request: backend.transitionRequest(path))
        try await download.waitUntilFinished()
        return await cache.transitionFile(named: name)
      })
    self.backend = backend
    self.networkReader = networkReader
    self.bandwidth = bandwidth
    openedAt = opened
    encodeSupport = support
    self.settings = settings
    self.levels = levels
    self.downloads = downloads
    self.cache = cache
    self.reports = reports
    self.makeEngine = build
    saved = JSONWriter(directory.appending(path: "queue.json"))
    resumePoint = JSONFile(directory.appending(path: "resume.json"))
    var restored = saved.read() ?? QueueState()
    if let point = resumePoint.read(), point.matches(restored) { restored.resumeAt = point.at }
    queue = restored
    engine = try build()
    tracker = PlayTracker { _ in }
    tracker = PlayTracker { [weak self] plays in self?.report(plays) }
    engine.onEvent = { [weak self] in self?.handle($0) }
    downloads.announce = { [weak self] text, isError in self?.notice = Notice(text: text, isError: isError) }
    transitions.planner.isPlaying = { [weak self] in self?.queue.playing ?? false }
    transitions.planner.isOnline = { [weak self] in self?.network() != .offline }
    transitions.onChange = { [weak self] in self?.updateUpcoming() }
    // A transition kept with a download plays instead of asking: always offline, online while its mix point is well
    // ahead (the planner's rule, `OfflinePlayback.useKept`'s). Levelled when the player sends the pair's gains.
    transitions.planner.kept = { [weak downloads] pair, online in
      downloads?.keptTransition(from: pair.from, to: pair.to, mode: pair.mode, online: online, levelled: pair.levels != nil)
        .map { .ready($0.transition.answer) }
    }
    downloads.playerPair = { [weak transitions] in
      guard let upcoming = transitions?.planner.upcoming, let from = upcoming.fromFileId, let to = upcoming.toFileId else { return nil }
      return (fromFileId: from, toFileId: to)
    }
    transitions.planner.onPairChange = { [weak downloads] in downloads?.playerMoved() }
    sync()
    Task { await reports.retry() }
  }

  /// Runs the clock (the app calls this once; tests call `tick()` themselves): 10 times a second while something moves,
  /// twice a second while it's all paused (plan 3 §2).
  public func start() {
    ticker?.cancel()
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        let wait = self?.tickInterval ?? .milliseconds(100)
        self?.tickingSlowly = wait > .milliseconds(100)
        try? await Task.sleep(for: wait)
        self?.tick()
      }
    }
  }

  /// 10 a second while a song plays or loads, or a preview plays; twice a second otherwise, which is enough for the
  /// sleep timer, the downloads and the saves.
  var tickInterval: Duration {
    let moving = queue.playing || previews != nil || engine.state == .loading || engine.state == .buffering
    return moving ? .milliseconds(100) : .milliseconds(500)
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
    stalled?.at = seconds
    // The bars and the glow wait at the new place until the music plays from it.
    pulse.setClock(songTime: seconds, engineTime: 0, at: Pulse.hostNow(), playing: false, latency: session?.outputLatency ?? 0)
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
    let action = policy.action(for: event, playing: queue.playing)
    Log.engine.info("Audio session: \(String(describing: event), privacy: .public), \(String(describing: action), privacy: .public)")
    switch action {
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

  /// The network changed (NetworkMonitor): keep-ahead plans again, downloads wait or go on, play reports waiting go out
  /// once back online, a song stopped by a dead spot plays on, and offline the next song joined is one on this device.
  public func networkChanged(_ kind: NetworkKind) {
    let wasOffline = lastNetwork == .offline
    // Another connection: what was measured on this one is kept for next time, and the new one starts from what was
    // last measured on its kind, if lately.
    if kind != lastNetwork {
      rememberBandwidth()
      bandwidth.reset(to: settings.lastMeasured(on: kind))
    }
    lastNetwork = kind
    Log.network.info("Network: \(String(describing: kind), privacy: .public)")
    downloads.networkChanged(kind)
    if wasOffline && kind != .offline { Task { [reports] in await reports.retry() } }
    // A song stopped by a dead spot plays on from where it was, on whatever network is here now.
    if kind != .offline { playOnAfterStall() }
    updateUpcoming()
    prefetch()
  }

  /// The app is closing: the song so far is reported (never as a skip), the queue saved.
  public func appWillTerminate() {
    tracker.finish(.closed)
    queue.resumeAt = time
    flushSaves()
  }

  /// The app is going to the background, or closing: the queue, where it is in the song and the downloads' list are
  /// written now rather than in a moment.
  public func flushSaves() {
    rememberBandwidth()
    _queue.resumeAt = time
    saved.write(queue)
    saved.flush()
    saveResumePoint()
    downloads.flushSaves()
    levels.flushSaves()
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
    // The stalled song plays again: its dead spot is over. Until then the time stays where it stopped.
    if engine.state == .playing { endStall() }
    if loaded != nil { time = stalled?.at ?? engine.position }
    buffered = engine.bufferedAhead
    loading = engine.state == .loading || engine.state == .buffering
    watchForStarving(now)
    if engine.state == .playing { tracker.tick(time) } else { tracker.pause() }
    transitions.planner.clock(time, seeked: seekedSinceTick)
    seekedSinceTick = false
    let latency = session?.outputLatency ?? 0
    pulse.setClock(
      songTime: time, engineTime: EngineFormat.seconds(engine.now), at: engine.renderHost ?? Pulse.hostNow(),
      playing: loaded != nil && engine.state == .playing, latency: latency)
    updateBlend(latency: latency)
    if let end = pauseAtMixEnd, engine.now >= end {
      // The sleep timer: the mix played out, and the next song waits here, paused.
      pauseAtMixEnd = nil
      setPlaying(false)
      sleep.fellAsleep(at: now)
    }
    let volume = queue.muted ? 0 : Float(queue.volume * queue.volume)
    engine.setMasterGain(volume * sleep.gain(at: now))
    if sleep.runsOut(at: now) {
      // Now Playing says goodnight, or a toast where it's closed (the app's to say: it knows which).
      setPlaying(false)
      sleep.fellAsleep(at: now)
    }
    if loaded != nil, now.timeIntervalSince(lastSaved) >= 5 {
      // Past the queue's observation (`_queue`, the macro's storage): nothing shows where to resume, and a change to
      // `queue` every 5 s redrew every view of it, closing any menu open on one of them. The place goes to a file of
      // its own: the queue itself is written when it changes.
      _queue.resumeAt = time
      lastSaved = now
      saveResumePoint()
      rememberBandwidth()
    }
  }

  // MARK: Automatic quality

  /// The music ran dry waiting for the song (the engine buffering while it should play): the connection doesn't keep
  /// up with the song. Waiting adds up, smooth playing wears it down; past `starvedLimit` the song goes a quality lower.
  private func watchForStarving(_ now: Date) {
    let elapsed = lastTick.map { min(max(now.timeIntervalSince($0), 0), 0.5) } ?? 0
    lastTick = now
    guard queue.playing, loaded != nil, stalled == nil else { return }
    switch engine.state {
    case .buffering:
      starved += elapsed
      if starved >= Self.starvedLimit {
        starved = 0
        stepDown()
      }
    case .playing:
      starved = max(0, starved - elapsed / 10)
    default:
      break
    }
  }

  /// The quality the current song was opened at, or would be now.
  private func currentQuality(_ item: EngineItem) -> StreamQuality {
    openedAt.quality(of: item.id) ?? settings.streamQuality(for: item.track, on: network(), kbps: bandwidth.estimate())
  }

  /// Automatic quality, when the current song couldn't keep up: the connection is taken to be slower than its bitrate
  /// for a while (`Bandwidth.fellBehind`), so it and the next songs go a quality lower. False when there's none lower,
  /// or the quality isn't Automatic.
  @discardableResult
  private func fellBehind() -> Bool {
    guard settings.streaming == .automatic, network() != .offline, let current = loaded, current.item.continuation == nil else { return false }
    let track = current.item.track
    let quality = currentQuality(current.item)
    guard let lower = AutoQuality.below(quality, for: track) else { return false }
    bandwidth.fellBehind(at: quality.bitrate(of: track))
    Log.player.notice("Song \(track.id) fell behind at \(quality.rawValue, privacy: .public): \(lower.rawValue, privacy: .public) or lower from here")
    return true
  }

  /// The song keeps running dry: it plays on from where it is a quality lower, its download at the quality it leaves
  /// stopped, so the two don't share the connection. The same play.
  private func stepDown() {
    guard let current = loaded, fellBehind() else { return }
    let at = time
    let fileId = current.item.track.fileId
    Task { [cache] in await cache.stopDownloads(of: fileId) }
    loadCurrent(current.entry, resumingAt: at)
    prefetch()
  }

  /// What's measured is kept for the next time on this kind of network.
  private func rememberBandwidth() {
    guard let kbps = bandwidth.measured else { return }
    settings.remember(measured: kbps, on: lastNetwork)
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
    // Playing again: the goodnight is over, and the clock ticks 10 times a second again, from now.
    if queue.playing { sleep.wake() }
    if queue.playing, tickingSlowly, ticker != nil { start() }
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
    loadMixMaps()
    loadLevels()
    continueRadio()
    prefetch()
    showNowPlaying()
    save()
  }

  /// Loads the current song: from `resumingAt` as the same play (a quality lower, `stepDown`), from where a dead spot
  /// stopped it, or from its start.
  private func loadCurrent(_ entry: Entry?, resumingAt: Double? = nil) {
    guard let entry, let track = queue.currentTrack else {
      tracker.finish(.changed)
      engine.stop()
      loaded = nil
      upcoming = nil
      (time, duration) = (0, 0)
      return
    }
    if network() == .offline, !downloads.isKept(track.fileId), skipToKept() { return loadCurrent(currentEntry) }
    let resumed = resumingAt ?? (stalled?.entry == entry ? stalled?.at : nil)
    if resumed == nil {
      endStall()
      // Played again from the start (repeat one, "previous" near the start): it counts as heard through.
      tracker.finish(loaded?.entry.index == entry.index ? .ended : .changed)
      tracker.start(track)
    }
    // A stalled song goes on from where it stopped, its play counted as one.
    let start = queue.startAt ?? resumed ?? (firstLoad ? queue.resumeAt : 0)
    queue.startAt = nil
    firstLoad = false
    let item = EngineItem(track: track, gainDb: gainDb(track), startAt: start)
    Log.player.info("Song \(track.id) from \(start, format: .fixed(precision: 1)) s\(resumingAt != nil ? ", a quality lower" : resumed == nil ? "" : ", after a dead spot", privacy: .public)")
    starved = 0
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
      let index = queue.repeatMode == .one ? current.entry.index : queue.upNextIndex,
      // Offline, a song not on this device isn't joined: the current one ends, and the next kept one is found then.
      network() != .offline || downloads.isKept(queue.queue[index].fileId)
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
  }

  /// The mix maps of the song playing and the next, whatever the transitions: the accent glides to the next song's
  /// color over one beat of it, and the end of a song counts its last bar (`handoff`). With DJ mix the next song's
  /// join is picked again once they're here.
  private func loadMixMaps() {
    let maps = transitions.mixMaps
    let songs = [queue.currentTrack, queue.upNext]
    guard songs.contains(where: { $0.map { maps.map($0.recordingId) == nil } ?? false }) else { return }
    Task {
      await maps.load(songs)
      if settings.transitions == .dj { updateUpcoming() }
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

  // MARK: The end of a song

  /// How the song playing gives way to the next (`EndOfSong`), by the join the engine has for it or the mix it has
  /// placed. None when nothing follows it on its own (repeat one, the end of the queue, offline with the next song not
  /// on this device) or when the sleep timer stops the music after it.
  public var handoff: EndOfSong.Handoff? {
    guard !sleep.endOfSong, queue.repeatMode != .one, let current = loaded, let next = upcoming, duration > 0 else { return nil }
    let mix = engine.mix.flatMap { $0.to == next.item.id ? $0.plan : nil }
    let bpm = transitions.mixMaps.map(current.item.track.recordingId)?.bpm
    return EndOfSong.handoff(next: next.item.track, join: next.join, mix: mix, duration: duration, bpm: bpm)
  }

  /// What the player's second line says as the song playing ends ("Next: Teardrop"), else nil (plan 7 §5).
  public var endOfSongLine: String? { endOfSongWords?.text }

  /// `endOfSongLine` with what it says where it's short of room (the last bar's "Mixing on the next bar").
  public var endOfSongWords: EndOfSong.Words? { EndOfSong.words(handoff, time: time) }

  /// The blend being heard (`blend`): a blend or a quick mix the engine plays, from its start, as heard, until the
  /// song being left has faded out of it; the songs are the ones it started with, across the switch.
  private func updateBlend(latency: Double) {
    var heard: Blend?
    if let mix = engine.mix, Blend.isBlend(mix.plan) {
      let songs: (from: Track, to: Track)? =
        if let blend, blend.into == mix.to, blend.plan == mix.plan {
          (blend.from, blend.to)
        } else if let next = upcoming, next.item.id == mix.to, let current = loaded {
          (current.item.track, next.item.track)
        } else {
          nil
        }
      let t = EngineFormat.seconds(engine.now - mix.start) - latency
      if let songs, t >= 0, t < Blend.overlap(mix.plan, bpmA: transitions.mixMaps.map(songs.from.recordingId)?.bpm ?? 0) {
        heard = Blend(from: songs.from, to: songs.to, plan: mix.plan, start: EngineFormat.seconds(mix.start), into: mix.to)
      }
    }
    if heard != blend { blend = heard }
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

  /// What plays now and next: read by the engine, so never dropped or stopped, whatever the limit.
  private var playingSongs: [Track] { [queue.currentTrack, queue.upNext].compactMap { $0 } }

  /// Keep ahead (apps/web/src/player/loadAhead.ts): what plays now and next is protected at once; once the queue has
  /// settled, the plan for this network is too, and the stream cache fetches what of it isn't here, one at a time.
  private func prefetch() {
    downloads.protect(Set((playingSongs + keptAhead).map(\.fileId)))
    keepAheadTask?.cancel()
    keepAheadTask = Task { [weak self, settle] in
      if settle > .zero { try? await Task.sleep(for: settle) }
      guard !Task.isCancelled else { return }
      self?.keepAhead()
    }
  }

  private func keepAhead() {
    let network = network()
    keptAhead = KeepAhead.plan(queue, network: network, limit: settings.offlineLimit)
    let keep = Set((playingSongs + keptAhead).map(\.fileId))
    downloads.protect(keep)
    // Each at the quality it would play at now: its encoded stream, or its own file.
    let kbps = bandwidth.estimate()
    let requests = keptAhead.compactMap { track -> (Track, StreamQuality, URLRequest)? in
      let chosen = settings.streamQuality(for: track, on: network, kbps: kbps)
      let quality = chosen.of(track)
      guard !downloads.keeps(track, atLeast: quality) else { return nil }
      if Self.playsEncoded(track, at: chosen, on: network, backend: backend, support: encodeSupport), let kbps = quality.kbps,
        let request = backend.encodedRequest(track, kbps: kbps, start: 0)
      {
        return (track, quality, request)
      }
      return (track, .original, backend.streamRequest(track))
    }
    Task { [cache] in
      await cache.keepOnly(keep)
      await cache.prefetch(requests)
    }
  }

  /// The quality the current song streams at when it comes encoded (Stats for nerds); nil when it plays its own file
  /// or a copy on this device.
  public func encodedQuality(of track: Track) -> StreamQuality? {
    let network = network()
    let quality = loaded.flatMap { $0.item.track.fileId == track.fileId ? openedAt.quality(of: $0.item.id) : nil }
      ?? settings.streamQuality(for: track, on: network, kbps: bandwidth.estimate())
    guard Self.playsEncoded(track, at: quality, on: network, backend: backend, support: encodeSupport),
      !downloads.keeps(track, atLeast: quality.of(track))
    else { return nil }
    return quality
  }

  /// Where a song plays from (plan 2 §1): a download's copy, whatever its quality (the listener chose it); else a copy
  /// the stream cache has at the quality wanted on this network (any copy offline); else its encoded stream when it
  /// comes encoded here; else its own file.
  static func origin(
    for track: Track, at quality: StreamQuality, on network: NetworkKind, backend: any PlayerBackend, downloads: DownloadStore,
    levelled: Bool, support: EncodeSupport
  ) -> TrackSource.Origin {
    var encoded: TrackSource.Encoded?
    if playsEncoded(track, at: quality, on: network, backend: backend, support: support), let kbps = quality.kbps {
      encoded = TrackSource.Encoded(quality: quality, support: support) { start in
        backend.encodedRequest(track, kbps: kbps, start: start) ?? backend.streamRequest(track)
      }
    }
    return TrackSource.Origin(
      stream: backend.streamRequest(track), levelled: levelled ? backend.levelledRequest(track) : nil,
      kept: downloads.downloadedFile(track), accepts: network == .offline ? .low : quality.of(track), encoded: encoded)
  }

  /// The song streams encoded here now: online, at a quality that encodes it, from a server that has encoded streams
  /// and hasn't failed this song's.
  static func playsEncoded(
    _ track: Track, at quality: StreamQuality, on network: NetworkKind, backend: any PlayerBackend, support: EncodeSupport
  ) -> Bool {
    guard network != .offline, quality.encodes(track), let kbps = quality.kbps, support.allows(track.fileId) else { return false }
    return backend.encodedRequest(track, kbps: kbps, start: 0) != nil
  }

  /// Offline, a song not on this device can't play: on to the next one that is, with the web's toast. False online,
  /// or when none is.
  private func skipToKept() -> Bool {
    guard network() == .offline, let p = OfflinePlayback.nextKept(in: queue, isKept: downloads.isKept) else { return false }
    let playing = queue.playing
    queue.jumpTo(p)
    queue.playing = playing
    notice = Notice(text: OfflinePlayback.skippedNotice, isError: false)
    return true
  }

  private func showNowPlaying() {
    nowPlaying?.update(track: queue.currentTrack, elapsed: time, playing: queue.playing)
    onNowPlaying?(queue.currentTrack, time, queue.playing)
  }

  private func save(at now: Date = Date()) {
    lastSaved = now
    saved.write(queue)
  }

  private func saveResumePoint() {
    guard let track = queue.currentTrack else { return }
    resumePoint.write(ResumePoint(at: time, pos: queue.pos, trackId: track.id))
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
        if let mix = engine.mix, mix.to == id {
          pauseAtMixEnd = mix.end
        } else {
          queue.playing = false
          sleep.fellAsleep()
        }
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
      if sleep.stopsAtSongEnd() {
        queue.playing = false
        sleep.fellAsleep()
      }
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
      guard let current = loaded, current.item.id == id else { return }
      if skipToKept() { return sync() }
      // The song kept breaking off while the server answers: Automatic quality tries again a quality lower.
      if failure == .keptBreakingOff, network() != .offline { fellBehind() }
      if failure.isNetwork, stall(current.entry) { return }
      endStall()
      Log.player.error("Song \(current.item.track.id) failed: \(failure.message, privacy: .public)")
      error = failure.message
      notice = Notice(text: failure.message, isError: true)
      queue.playing = false
      showNowPlaying()
    }
  }

  /// The network stopped the song (a dead spot): it waits, paused where it was, and plays on from there once the
  /// network is back (`networkChanged`). While the phone says it's online (its server, not the phone, out of reach),
  /// it's tried again after each of `stallRetries`; false once they're used up, for the error to be shown.
  private func stall(_ entry: Entry) -> Bool {
    var stall = stalled?.entry == entry ? stalled! : Stall(entry: entry, at: time)
    stall.retry?.cancel()
    stall.retry = nil
    let online = network() != .offline
    if online {
      guard stall.tries < stallRetries.count else { return false }
      let wait = stallRetries[stall.tries]
      stall.tries += 1
      stall.retry = Task { [weak self] in
        try? await Task.sleep(for: wait)
        if !Task.isCancelled { self?.playOnAfterStall() }
      }
    }
    if stalled == nil { notice = Notice(text: OfflinePlayback.stalledNotice, isError: false) }
    Log.player.notice("Stalled at \(stall.at, format: .fixed(precision: 1)) s, \(online ? "tried again soon" : "offline", privacy: .public) (\(stall.tries) tries)")
    stalled = stall
    time = stall.at
    queue.playing = false
    showNowPlaying()
    return true
  }

  /// The network is back, or it's time to try again: the stalled song plays on from where it stopped. Not when the
  /// listener has already pressed play, or moved on to another song.
  private func playOnAfterStall() {
    guard let stall = stalled, !queue.playing else { return }
    guard stall.entry == currentEntry else { return endStall() }
    queue.playing = true
    sync()
  }

  private func endStall() {
    stalled?.retry?.cancel()
    stalled = nil
  }

  private func rebuildEngine() {
    let at = time
    Log.engine.notice("Rebuilding the audio engine at \(at, format: .fixed(precision: 1)) s")
    guard let fresh = try? makeEngine() else { return Log.engine.error("The audio engine couldn't be rebuilt") }
    engine.stop()
    engine = fresh
    engine.onEvent = { [weak self] in self?.handle($0) }
    if metering { engine.meter(into: pulse) }
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

/// Where the player reads the network from: the app's monitor, set after the player is made (`Player.network`).
@MainActor final class NetworkReader {
  var read: () -> NetworkKind = { .wifi }
}

/// The quality each song was opened at (`Player`'s sources record it), by engine item: the last few.
@MainActor final class OpenedQualities {
  private var byItem: [(UUID, StreamQuality)] = []

  func record(_ item: UUID, _ quality: StreamQuality) {
    byItem.removeAll { $0.0 == item }
    byItem.append((item, quality))
    if byItem.count > 8 { byItem.removeFirst() }
  }

  func quality(of item: UUID) -> StreamQuality? { byItem.last { $0.0 == item }?.1 }
}
