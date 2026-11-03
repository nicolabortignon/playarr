import AVFoundation
import AudioToolbox

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

  public private(set) var state: EngineState = .idle
  public var onEvent: ((EngineEvent) -> Void)?
  public let tuning: Tuning

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
  private var lastNow: SampleTime = 0
  private var endReported: UUID?
  private var pumping = false
  private var pumpAgain = false
  private var events: [EngineEvent] = []

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
    if let item, item.id == upcoming?.item.id {
      guard !placed else { return }
      upcoming = (item, join)
      items[item.id] = item
      upcomingDeck?.setGain(item.gainDb)
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

  /// Seconds into the current item.
  public var position: Double {
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
    reportEnd(now: now)
  }

  private func prepareUpcoming() {
    guard let (item, _) = upcoming, upcomingDeck == nil, let cur = current, let s = cur.segment, let curItem = items[s.id],
      let deck = decks.first(where: { $0 !== cur && $0.segment == nil })
    else { return }
    let remaining = curItem.track.duration - position
    guard remaining <= tuning.preload || s.finished else { return }
    open(item, on: deck)
    upcomingDeck = deck
  }

  private func placeUpcoming(now: SampleTime) {
    guard let next = upcomingDeck, next.segment?.timelineStart == nil, let cur = current?.segment, let end = cur.end,
      let scheduledEnd = cur.scheduledEnd, case .crossfade(let seconds)? = upcoming?.join
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

  private func advance(now: SampleTime) {
    guard nodesStarted, let next = upcomingDeck, let s = next.segment, let start = s.timelineStart, now >= start else { return }
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
  }

  private func startWhenReady(now: SampleTime) {
    guard state == .loading, let s = current?.segment, let start = s.timelineStart else { return }
    let ready = s.fullyScheduled || start + s.scheduled - now >= EngineFormat.frames(tuning.highWater)
    guard ready else { return }
    guard wantsToPlay else { return state = .paused }
    startNodes()
  }

  private func reportEnd(now: SampleTime) {
    guard let s = current?.segment, let end = s.end, now >= end, upcomingDeck?.segment?.timelineStart == nil, endReported != s.id else { return }
    endReported = s.id
    events.append(.ended(s.id))
  }

  // MARK: Epochs

  private func open(_ item: EngineItem, on deck: Deck) {
    items[item.id] = item
    let firstFrame = EngineFormat.frames(item.startAt)
    let length = EngineFormat.frames(item.track.duration)
    // A fade is never longer than a third of the song (see JoinRules.fadeSeconds): no need to hold back more.
    deck.load(
      id: item.id, source: makeSource(item, firstFrame), firstFrame: firstFrame, expectedFrames: max(0, length - firstFrame),
      holdback: min(EngineFormat.frames(tuning.maxFade), length / 3), envelope: GainEnvelope(gainDb: item.gainDb))
  }

  /// Stops all nodes (clearing what they had scheduled and their clocks): the next start begins a new epoch at 0.
  private func resetEpoch() {
    for deck in decks + [transitionDeck] { deck.stop() }
    current = nil
    upcomingDeck = nil
    nodesStarted = false
    lastNow = 0
    endReported = nil
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
    for deck in decks + [transitionDeck] { deck.node.play(at: when) }
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
      transitionDeck.release()
    }
    events.append(.failed(id, playbackError))
    pump()
  }
}
