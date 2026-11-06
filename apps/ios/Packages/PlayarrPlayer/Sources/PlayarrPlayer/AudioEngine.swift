import AVFoundation
import AudioToolbox
import ObjCExceptions
import PlayarrAPI

/// The audio engine: AVAudioEngine with two decks taking turns and a third player node for transition files, each
/// through its own mixer into a bus, an EQ (flat for now) and a peak limiter, then out.
///
/// Everything runs on one sample clock. The three player nodes are started together, at the same host time, so their
/// player timelines are the same timeline ("an epoch"); every buffer is scheduled at an exact sample on it. A song
/// that follows another is placed where the other ends (or `fade` earlier, with equal-power fades applied to the PCM),
/// so joins are gapless or crossfaded to the sample. Seeking, loading another song and anything that would need a
/// node's scheduled audio taken back start a new epoch: all nodes stopped, rescheduled and started together again.
///
/// Pausing pauses the AVAudioEngine itself, which freezes all three nodes at the same sample. Running short of decoded
/// audio does the same (`buffering`) until enough is decoded again, so the decks never drift apart.
///
/// The main actor drives it: `pump()` runs on each finished read and on the Player's 10 Hz tick. Decoding happens in
/// the sources' actors; the render thread only ever sees buffers already scheduled.
@MainActor
public final class AudioEngine {
  public struct Tuning: Sendable {
    /// Prepare the next song this long before the current one ends (`PRELOAD_S` on the web).
    public var preload: Double = 30
    /// Keep this much audio scheduled ahead.
    public var scheduleAhead: Double = 10
    /// Less than this scheduled ahead: hold everything until `highWater` is.
    public var lowWater: Double = 0.5
    public var highWater: Double = 2
    /// The soonest a join can start: the render thread runs a little ahead of what `now` reports.
    public var startMargin: Double = 0.1
    /// The longest crossfade (Settings offers up to 12 s): frames kept back near a song's end.
    public var maxFade: Double = 12
    public var block: Double = 0.5
    public init() {}
  }

  /// A mix placed on the timeline, from where it starts until the next song plays on its own.
  public struct MixInProgress: Sendable, Equatable {
    /// The item mixed into.
    public let to: UUID
    public let plan: TransitionPlan
    public let way: MixReport.Way
    /// Timeline samples: transition time 0 (the plan's `aStart`), the switch to the next song, the end.
    public let start: SampleTime
    public let switchSample: SampleTime
    public let end: SampleTime
  }

  public private(set) var state: EngineState = .idle
  public var onEvent: ((EngineEvent) -> Void)?
  /// Changeable while playing: DJ mix keeps less scheduled ahead, so a mix can be placed a few seconds ahead.
  public var tuning: Tuning
  /// The mix playing (or placed and about to), if any.
  public private(set) var mix: MixInProgress?
  /// The last mix's changeovers, for Stats for nerds.
  public private(set) var mixReports: [MixReport.Kind: MixReport] = [:]

  let engine = AVAudioEngine()
  let decks: [Deck]
  let transitionDeck = Deck(name: "Transition")
  private let bus = AVAudioMixerNode()
  private let eq = AVAudioUnitEQ(numberOfBands: 0)
  private let limiter = AVAudioUnitEffect(
    audioComponentDescription: AudioComponentDescription(
      componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
      componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
  private let makeSource: @MainActor (EngineItem, Int64) -> any PCMSource

  private var items: [UUID: EngineItem] = [:]
  private var current: Deck?
  private var upcoming: (item: EngineItem, join: Join)?
  private var upcomingDeck: Deck?
  private var wantsToPlay = false
  private var nodesStarted = false
  /// Starts in a row whose nodes wouldn't play (see `startNodes`); one that works sets it back to 0.
  private var failedStarts = 0
  private var lastNow: SampleTime = 0
  private var endReported: UUID?
  private var pumping = false
  private var pumpAgain = false
  private var events: [EngineEvent] = []
  private var configurationWatch: Task<Void, Never>?
  /// The deck and segment whose first scheduled block each report's headroom is read from.
  private var reportSources: [MixReport.Kind: (deck: Deck, id: UUID)] = [:]

  /// `makeSource` opens a song's audio from a frame (44.1 kHz) on. `manualRendering` renders offline, for tests.
  public init(tuning: Tuning = Tuning(), manualRendering: Bool = false, makeSource: @escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws {
    self.tuning = tuning
    self.makeSource = makeSource
    decks = [Deck(name: "A"), Deck(name: "B")]
    let format = EngineFormat.av
    for node in [bus, eq, limiter] as [AVAudioNode] { engine.attach(node) }
    for deck in decks + [transitionDeck] {
      engine.attach(deck.node)
      engine.attach(deck.mixer)
      engine.connect(deck.node, to: deck.mixer, format: format)
      engine.connect(deck.mixer, to: bus, fromBus: 0, toBus: bus.nextAvailableInputBus, format: format)
      deck.onProgress = { [weak self] in self?.pump() }
      deck.onError = { [weak self] id, error in self?.failed(id, error) }
    }
    engine.connect(bus, to: eq, format: format)
    engine.connect(eq, to: limiter, format: format)
    engine.connect(limiter, to: engine.mainMixerNode, format: format)
    eq.bypass = true
    // The limiter catches what gains and overlaps push past full scale: +1 dB into it and −1 dB after it, so music
    // below the ceiling passes as it is and peaks stay under −1 dBFS.
    AudioUnitSetParameter(limiter.audioUnit, kLimiterParam_PreGain, kAudioUnitScope_Global, 0, 1, 0)
    engine.mainMixerNode.outputVolume = Float(pow(10, -1.0 / 20))
    if manualRendering {
      try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
    }
    configurationWatch = Task { [weak self, engine] in
      for await _ in NotificationCenter.default.notifications(named: .AVAudioEngineConfigurationChange, object: engine) {
        self?.configurationChanged()
      }
    }
  }

  isolated deinit {
    configurationWatch?.cancel()
  }

  // MARK: Commands

  /// Plays `item` from `item.startAt` on a new epoch (what was playing stops), once its first seconds are decoded.
  public func load(_ item: EngineItem, playing: Bool) {
    resetEpoch()
    upcoming = nil
    wantsToPlay = playing
    let deck = decks[0]
    open(item, on: deck)
    deck.place(at: 0)
    current = deck
    state = .loading
    pump()
  }

  /// What plays after the current item, and how it joins. The same item again (same id) only updates its gain and
  /// join, until it's placed. Another one replaces it: if the old one was already placed, the current song is
  /// reloaded where it is (a new epoch), so its end is as it should be for the new one.
  public func setUpcoming(_ item: EngineItem?, join: Join = .crossfade(seconds: 0)) {
    let placed = upcomingDeck?.segment?.timelineStart != nil
    if let item, let old = upcoming, item.id == old.item.id {
      guard !placed else { return }
      upcoming = (item, join)
      items[item.id] = item
      let opening = sourcePlan(item, join)
      if opening != sourcePlan(old.item, old.join) {
        // Its audio has to come from elsewhere now (another frame, the server's rest, resampled): opened again.
        upcomingDeck?.release()
        upcomingDeck = nil
      } else {
        upcomingDeck?.setGain(opening.gainDb)
      }
      pump()
      return
    }
    upcomingDeck?.release()
    upcomingDeck = nil
    upcoming = item.map { ($0, join) }
    if let item { items[item.id] = item }
    if placed { reloadCurrent() }
    pump()
  }

  public func play() {
    wantsToPlay = true
    guard state == .paused else { return }
    if nodesStarted {
      resumeEngine()
      state = .playing
    } else {
      state = .loading
    }
    pump()
  }

  public func pause() {
    wantsToPlay = false
    switch state {
    case .playing, .buffering:
      engine.pause()
      state = .paused
    case .idle, .loading, .paused:
      break
    }
  }

  /// Plays the current item from `seconds` (a new epoch).
  public func seek(to seconds: Double) {
    guard let id = current?.segment?.id, var item = items[id] else { return }
    item.startAt = max(0, seconds)
    items[id] = item
    reload(item)
  }

  /// Stops and forgets everything.
  public func stop() {
    resetEpoch()
    upcoming = nil
    items = [:]
    wantsToPlay = false
    state = .idle
  }

  /// The sleep timer's fade (and a mute): the bus's volume, 0–1.
  public func setMasterGain(_ gain: Float) { bus.outputVolume = max(0, min(1, gain)) }
  public var masterGain: Float { bus.outputVolume }

  // MARK: Reading

  /// The current sample of the epoch.
  public var now: SampleTime {
    if let t = decks[0].node.lastRenderTime, t.isSampleTimeValid, let p = decks[0].node.playerTime(forNodeTime: t) {
      lastNow = max(0, p.sampleTime)
    }
    return lastNow
  }

  public var currentItem: EngineItem? { current?.segment.flatMap { items[$0.id] } }

  /// The next item is placed on the timeline: changing it now means a new epoch.
  public var upcomingPlaced: Bool { upcomingDeck?.segment?.timelineStart != nil }

  /// Seconds into the current item.
  public var position: Double {
    let now = self.now
    if let m = mix, let id = current?.segment?.id, now < m.end {
      // In a mix the listener sees A until the switch, then B (on B's clock, at its rate).
      let t = EngineFormat.seconds(now - m.start)
      return id == m.to ? MixSequence.bTimeAt(m.plan, t) : m.plan.aStart + t
    }
    guard let s = current?.segment, let start = s.timelineStart else { return currentItem?.startAt ?? 0 }
    let played = min(max(0, now - start), s.finished ? s.decoded : .max)
    return EngineFormat.seconds(s.firstFrame + played)
  }

  /// Seconds of the current item decoded ahead of the playhead.
  public var bufferedAhead: Double {
    guard let s = current?.segment, let start = s.timelineStart else { return 0 }
    return max(0, EngineFormat.seconds(start + s.decoded - now))
  }

  public func snapshot() -> EngineSnapshot {
    EngineSnapshot(
      state: state, now: EngineFormat.seconds(now),
      decks: (decks + [transitionDeck]).map { $0.snapshot(title: $0.segment.flatMap { items[$0.id] }?.track.title) })
  }

  // MARK: Phase 5 seam: transitions

  /// Where frame `songFrame` (44.1 kHz) of an item that's placed sits on the timeline; nil if it isn't placed.
  public func timelineSample(of id: UUID, songFrame: Int64) -> SampleTime? {
    guard let s = decks.compactMap(\.segment).first(where: { $0.id == id }), let start = s.timelineStart else { return nil }
    return start + songFrame - s.firstFrame
  }

  /// Plays `source` on the transition node from timeline sample `sample`, sample-aligned with the decks. The node
  /// must have played out what it had (a node's scheduled audio can't be taken back without a new epoch).
  public func scheduleTransition(_ source: any PCMSource, at sample: SampleTime, envelope: GainEnvelope = GainEnvelope()) {
    transitionDeck.load(id: UUID(), source: source, firstFrame: 0, expectedFrames: .max, holdback: 0, envelope: envelope)
    transitionDeck.place(at: sample)
    pump()
  }

  // MARK: Driving

  /// Moves everything on: schedules and reads, prepares and places the next song, notices joins, ends, and running
  /// short. Events go out once it's done, so their handlers can call back in.
  public func pump() {
    guard !pumping else { return pumpAgain = true }
    pumping = true
    repeat {
      pumpAgain = false
      step()
    } while pumpAgain
    pumping = false
    let out = events
    events = []
    for event in out { onEvent?(event) }
  }

  private func step() {
    let now = self.now
    let ahead = EngineFormat.frames(tuning.scheduleAhead)
    let block = EngineFormat.frames(tuning.block)
    // The join is placed before anything is scheduled: the current song's last blocks may need its fade out.
    prepareUpcoming()
    placeUpcoming(now: now)
    for deck in decks + [transitionDeck] { deck.pump(now: now, ahead: ahead, block: block) }
    advance(now: now)
    retire(now: now)
    startWhenReady(now: now)
    watchBuffer(now: now)
    reportEnd(now: now)
    refreshReports()
  }

  private func prepareUpcoming() {
    guard let (item, join) = upcoming, upcomingDeck == nil, let cur = current, let s = cur.segment, let curItem = items[s.id],
      let deck = decks.first(where: { $0 !== cur && $0.segment == nil })
    else { return }
    // A DJ join begins before A's end: the next song is made ready that long before it begins.
    let remaining = (join.leaveTime ?? curItem.track.duration) - position
    guard remaining <= tuning.preload || s.finished else { return }
    open(item, on: deck, join: join)
    upcomingDeck = deck
  }

  private func placeUpcoming(now: SampleTime) {
    guard let join = upcoming?.join else { return }
    guard case .crossfade(let seconds) = join else { return placeMix(join, now: now) }
    guard let next = upcomingDeck, next.segment?.timelineStart == nil, let cur = current?.segment, let end = cur.end,
      let scheduledEnd = cur.scheduledEnd
    else { return }
    let soonest = now + EngineFormat.frames(tuning.startMargin)
    // A fade can't reach back into what's already scheduled, nor start before the soonest moment.
    let rampStart = max(end - EngineFormat.frames(seconds), scheduledEnd, soonest)
    if rampStart < end {
      let ramp = Ramp(start: rampStart, frames: end - rampStart)
      current?.setFadeOut(ramp)
      next.setFadeIn(ramp)
      next.place(at: rampStart)
    } else {
      next.place(at: max(end, soonest))
    }
    pumpAgain = true
  }

  /// Places a DJ join, as late as it can still be: once its start is within what's scheduled ahead (plus a block), so
  /// until then the join can change without a new epoch. If the next song isn't decoded by then, A's scheduling is
  /// held at the join's start while it gets ready, up to just before A would run short; then the join is missed.
  private func placeMix(_ join: Join, now: SampleTime) {
    guard let next = upcomingDeck, let b = next.segment, b.timelineStart == nil, let cur = current, let a = cur.segment,
      let aStart = a.timelineStart, let item = upcoming?.item, let leave = join.leaveTime
    else { return }
    let sampleOfA = { (seconds: Double) in aStart + EngineFormat.frames(seconds) - a.firstFrame }
    var at = sampleOfA(leave)
    if case .transition(let t) = join { at += t.leadFrames / 2 }
    guard at <= now + EngineFormat.frames(tuning.scheduleAhead + tuning.block) else { return }
    let soonest = now + EngineFormat.frames(tuning.startMargin)
    let scheduledEnd = a.scheduledEnd ?? aStart
    let bReady: Bool = if case .transition = join { true } else { b.finished || b.decoded > 0 }
    if !bReady {
      guard at - now > EngineFormat.frames(tuning.lowWater + tuning.startMargin + 0.1), scheduledEnd <= at else { return missed(item) }
      return cur.hold(at: at)
    }
    let songs = "\(items[a.id]?.track.title ?? "?") → \(item.track.title)"
    switch join {
    case .crossfade:
      return
    case .cut(let c):
      guard at >= max(soonest, scheduledEnd) else { return missed(item) }
      cur.end(at: at)
      next.place(at: at)
      report(.mixIn, MixReport(kind: .mixIn, way: .cut, songs: songs, sample: at, songTime: c.aEnd), from: next)
      mixReports[.mixOut] = nil
    case .mix(let plan):
      guard at >= max(soonest, scheduledEnd) else { return missed(item) }
      let silent = at + EngineFormat.frames(plan.aGain.silentFrom(limit: plan.length))
      cur.setAutomation(.a(plan, start: at))
      cur.end(at: silent)
      next.setAutomation(.b(plan, start: at))
      next.place(at: at)
      mix = MixInProgress(
        to: item.id, plan: plan, way: .live, start: at, switchSample: at + EngineFormat.frames(plan.switchAt),
        end: at + EngineFormat.frames(plan.length))
      report(.mixIn, MixReport(kind: .mixIn, way: .live, songs: songs, sample: at, songTime: plan.aStart), from: next)
      report(.mixOut, MixReport(kind: .mixOut, way: .live, songs: songs, sample: silent, songTime: plan.aStart + plan.aGain.silentFrom(limit: plan.length)), from: next)
    case .transition(let t):
      let t0 = sampleOfA(t.plan.aStart) - t.leadFrames
      // Anywhere in the lead the two files hold the same sound: the middle, or as soon after it as can still be.
      let cut = max(at, scheduledEnd, soonest)
      guard cut <= t0 + t.leadFrames, transitionDeck.segment == nil else { return missed(item) }
      let bAt = t0 + t.leadFrames + t.lengthFrames
      let id = UUID()
      cur.end(at: cut)
      transitionDeck.load(
        id: id, source: TransitionFileSource(t, from: cut - t0, to: t.leadFrames + t.lengthFrames), firstFrame: 0, expectedFrames: .max,
        holdback: 0, envelope: GainEnvelope())
      transitionDeck.place(at: cut)
      next.place(at: bAt)
      mix = MixInProgress(
        to: item.id, plan: t.plan, way: .server, start: t0 + t.leadFrames, switchSample: t0 + t.leadFrames + EngineFormat.frames(t.plan.switchAt),
        end: bAt)
      let cutTime = t.plan.aStart + EngineFormat.seconds(cut - t0 - t.leadFrames)
      report(.mixIn, MixReport(kind: .mixIn, way: .server, songs: songs, sample: cut, songTime: cutTime), from: transitionDeck, id: id)
      report(.mixOut, MixReport(kind: .mixOut, way: .server, songs: songs, sample: bAt, songTime: t.plan.bResume), from: next)
    }
    pumpAgain = true
  }

  /// The join couldn't be placed in time: the next song follows gapless instead, from its start.
  private func missed(_ item: EngineItem) {
    current?.hold(at: nil)
    upcomingDeck?.release()
    upcomingDeck = nil
    upcoming = (item, .crossfade(seconds: 0))
    events.append(.mixMissed(item.id))
    pumpAgain = true
  }

  private func report(_ kind: MixReport.Kind, _ report: MixReport, from deck: Deck, id: UUID? = nil) {
    mixReports[kind] = report
    if let id = id ?? deck.segment?.id { reportSources[kind] = (deck, id) }
  }

  /// Each report's headroom, once its first audio is scheduled.
  private func refreshReports() {
    for (kind, source) in reportSources {
      guard let s = source.deck.segment, s.id == source.id, let headroom = s.firstHeadroom else { continue }
      mixReports[kind]?.headroom = EngineFormat.seconds(headroom)
      reportSources[kind] = nil
    }
  }

  private func advance(now: SampleTime) {
    guard nodesStarted, let next = upcomingDeck, let s = next.segment, let start = s.timelineStart else { return }
    // In a mix the next song takes over at the switch, in the middle of the blend.
    let switchAt = mix.flatMap { $0.to == s.id ? $0.switchSample : nil } ?? start
    guard now >= switchAt else { return }
    current = next
    upcomingDeck = nil
    upcoming = nil
    events.append(.advanced(s.id))
  }

  /// Decks done playing (a song faded out) are freed for the next song.
  private func retire(now: SampleTime) {
    for deck in decks where deck !== current && deck !== upcomingDeck {
      if let s = deck.segment, let end = s.end, s.fullyScheduled, now >= end {
        items[s.id] = nil
        deck.release()
      }
    }
    if let s = transitionDeck.segment, let end = s.end, s.fullyScheduled, now >= end { transitionDeck.release() }
    if let m = mix, now >= m.end { mix = nil }
  }

  private func startWhenReady(now: SampleTime) {
    guard state == .loading, let s = current?.segment, let start = s.timelineStart else { return }
    let ready = s.fullyScheduled || start + s.scheduled - now >= EngineFormat.frames(tuning.highWater)
    guard ready else { return }
    guard wantsToPlay else { return state = .paused }
    startNodes()
  }

  private func watchBuffer(now: SampleTime) {
    guard state == .playing || state == .buffering else { return }
    let low = EngineFormat.frames(tuning.lowWater)
    let audible = (decks + [transitionDeck]).compactMap(\.segment).filter { s in
      guard let start = s.timelineStart else { return false }
      return start <= now + low && !s.fullyScheduled
    }
    let ahead = audible.compactMap { $0.scheduledEnd.map { $0 - now } }.min()
    if state == .playing, let ahead {
      if ahead < 0 { return reloadCurrent() }  // missed: buffers due before now would be dropped
      if ahead < low {
        engine.pause()
        state = .buffering
      }
    } else if state == .buffering, (ahead ?? .max) >= EngineFormat.frames(tuning.highWater) {
      resumeEngine()
      state = .playing
    }
  }

  private func reportEnd(now: SampleTime) {
    guard let s = current?.segment, let end = s.end, now >= end, upcomingDeck?.segment?.timelineStart == nil, endReported != s.id else { return }
    endReported = s.id
    events.append(.ended(s.id))
  }

  // MARK: Epochs

  /// Where an item's audio comes from for a join: the frame its source opens at, the song frame its segment starts at
  /// (they differ when B is resampled), the server's rest of it, and the gain.
  struct SourcePlan: Equatable {
    var readFrom: Int64
    var firstFrame: Int64
    var varispeed: TransitionPlan?
    var continuation: EngineItem.Continuation?
    var gainDb: Double
  }

  func sourcePlan(_ item: EngineItem, _ join: Join?) -> SourcePlan {
    var frame = EngineFormat.frames(item.startAt)
    switch join {
    case .transition(let t)?:
      frame = EngineFormat.frames(t.plan.bResume)
    case .cut(let c)?:
      frame = EngineFormat.frames(c.bStart)
    case .mix(let plan)? where plan.bRate.contains(where: { abs($0.value - 1) > 1e-9 }):
      // B resampled through the mix: its segment counts B's frames as they are after it.
      let length = EngineFormat.frames(plan.length), end = EngineFormat.frames(plan.bResume)
      let from = VarispeedSource.baseStart(plan: plan, lengthFrames: length, endFrame: end)
      return SourcePlan(readFrom: from, firstFrame: end - length, varispeed: plan, continuation: nil, gainDb: item.gainDb)
    case .mix(let plan)?:
      frame = EngineFormat.frames(plan.bStart)
    case .crossfade?, nil:
      break
    }
    // The server's rest of the song serves any frame from where it starts.
    if let c = item.continuation, frame >= EngineFormat.frames(c.from) {
      return SourcePlan(readFrom: frame, firstFrame: frame, varispeed: nil, continuation: c, gainDb: c.gainDb)
    }
    return SourcePlan(readFrom: frame, firstFrame: frame, varispeed: nil, continuation: nil, gainDb: item.gainDb)
  }

  private func open(_ item: EngineItem, on deck: Deck, join: Join? = nil) {
    items[item.id] = item
    let plan = sourcePlan(item, join)
    var opened = item
    opened.continuation = plan.continuation
    var source = makeSource(opened, plan.readFrom)
    if let mix = plan.varispeed {
      source = VarispeedSource(
        base: source, baseStart: plan.readFrom, rate: mix.bRate, lengthFrames: EngineFormat.frames(mix.length),
        endFrame: EngineFormat.frames(mix.bResume), plan: mix)
    }
    let length = EngineFormat.frames(item.track.duration)
    // A fade is never longer than a third of the song (see JoinRules.fadeSeconds): no need to hold back more.
    deck.load(
      id: item.id, source: source, firstFrame: plan.firstFrame, expectedFrames: max(0, length - plan.firstFrame),
      holdback: min(EngineFormat.frames(tuning.maxFade), length / 3), envelope: GainEnvelope(gainDb: plan.gainDb))
  }

  /// Stops all nodes (clearing what they had scheduled and their clocks): the next start begins a new epoch at 0.
  private func resetEpoch() {
    for deck in decks + [transitionDeck] { deck.stop() }
    current = nil
    upcomingDeck = nil
    nodesStarted = false
    lastNow = 0
    endReported = nil
    // A mix doesn't survive a new epoch: the song shown plays on from where it was, on its own.
    mix = nil
    reportSources = [:]
  }

  /// Starts the three nodes at the same moment, so they share one timeline.
  private func startNodes() {
    do {
      if !engine.isRunning {
        engine.prepare()
        try engine.start()
      }
    } catch {
      return state = .paused
    }
    // Offline (tests), nodes started before the first render all begin at sample 0; live, at one host time.
    let when = engine.isInManualRenderingMode ? nil : AVAudioTime(hostTime: mach_absolute_time() + AVAudioTime.hostTime(forSeconds: 0.05))
    do {
      try ObjCExceptions.catching { for deck in decks + [transitionDeck] { deck.node.play(at: when) } }
    } catch {
      // The engine stopped itself as the nodes started (its output changed under it), and a node told to play on a
      // stopped engine raises an exception, which would end the app. Start over from here, twice at most, then wait
      // for Play.
      failedStarts += 1
      if failedStarts == 3 {
        failedStarts = 0
        wantsToPlay = false
      }
      return reloadCurrent()
    }
    failedStarts = 0
    nodesStarted = true
    state = .playing
  }

  private func resumeEngine() {
    if !engine.isRunning { try? engine.start() }
  }

  private func reload(_ item: EngineItem) {
    let keep = upcoming
    let playing = wantsToPlay
    load(item, playing: playing)
    upcoming = keep
    pump()
  }

  /// The current item again from where it is: after a missed buffer, or to take back a join already scheduled.
  private func reloadCurrent() {
    guard let id = current?.segment?.id, var item = items[id] else { return }
    item.startAt = position
    items[id] = item
    reload(item)
  }

  private func configurationChanged() {
    // The output changed (rate, channels): AVAudioEngine stopped itself. Start over from here.
    guard current != nil else { return }
    reloadCurrent()
  }

  private func failed(_ id: UUID, _ error: any Error) {
    let playbackError = error as? PlaybackError ?? .undecodable
    if id == upcoming?.item.id {
      // The next song didn't load: it loads again the usual way when its turn comes.
      upcomingDeck?.release()
      upcomingDeck = nil
      upcoming = nil
    } else if id == current?.segment?.id {
      engine.pause()
      resetEpoch()
      wantsToPlay = false
      state = .idle
    } else if id == transitionDeck.segment?.id {
      // The transition file wouldn't play: the song shown goes on from where it is, on its own.
      transitionDeck.release()
      if mix != nil { reloadCurrent() }
    }
    events.append(.failed(id, playbackError))
    pump()
  }
}
