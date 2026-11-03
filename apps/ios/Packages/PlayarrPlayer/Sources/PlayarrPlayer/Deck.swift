import AVFoundation

/// A player node and its mixer, fed from one `PCMSource` at a time onto the engine's shared timeline. It decodes
/// ahead in blocks of half a second, applies its `GainEnvelope` to each block and schedules it at its exact sample.
/// Near the end of a song it holds back the last seconds until the end is known, so a fade out can still be applied.
///
/// A deck never stops its node on its own: stopping resets a node's clock, and the decks only share one while they
/// are started together (see `AudioEngine.resetEpoch`).
@MainActor
final class Deck {
  struct Segment {
    let id: UUID
    let source: any PCMSource
    /// The song frame the segment starts at (0, or where playback started in the song).
    let firstFrame: Int64
    /// Frames the song is expected to have from `firstFrame` on (from its duration): where holding back starts.
    let expectedFrames: Int64
    /// Frames kept back near the end until the end is known.
    let holdback: Int64
    /// Timeline sample of `firstFrame`; nil while cued (decoding ahead, not placed yet).
    var timelineStart: SampleTime?
    var envelope: GainEnvelope
    var pending: [PCMBlock] = []
    var decoded: Int64 = 0
    var scheduled: Int64 = 0
    var finished = false

    var end: SampleTime? { finished ? timelineStart.map { $0 + decoded } : nil }
    var scheduledEnd: SampleTime? { timelineStart.map { $0 + scheduled } }
    var fullyScheduled: Bool { finished && pending.isEmpty }
  }

  let name: String
  let node = AVAudioPlayerNode()
  let mixer = AVAudioMixerNode()
  private(set) var segment: Segment?
  private(set) var reading: Task<Void, Never>?
  /// A read finished: the engine looks at what changed.
  var onProgress: (() -> Void)?
  var onError: ((UUID, any Error) -> Void)?

  init(name: String) { self.name = name }

  func load(id: UUID, source: any PCMSource, firstFrame: Int64, expectedFrames: Int64, holdback: Int64, envelope: GainEnvelope) {
    release()
    segment = Segment(id: id, source: source, firstFrame: firstFrame, expectedFrames: expectedFrames, holdback: holdback, envelope: envelope)
  }

  func place(at sample: SampleTime) { segment?.timelineStart = sample }
  func setFadeIn(_ ramp: Ramp) { segment?.envelope.fadeIn = ramp }
  func setFadeOut(_ ramp: Ramp) { segment?.envelope.fadeOut = ramp }
  func setGain(_ gainDb: Double) { segment?.envelope.gain = GainEnvelope(gainDb: gainDb).gain }

  /// Forgets the segment (its source is closed). What's already scheduled still plays: only `stop` clears that.
  func release() {
    reading?.cancel()
    reading = nil
    if let source = segment?.source { Task { await source.close() } }
    segment = nil
  }

  /// Clears what's scheduled and resets the node's clock: only as part of a new epoch.
  func stop() {
    release()
    node.stop()
  }

  /// Schedules what is decoded and due, and reads more if fewer than `ahead + holdback` frames are decoded ahead.
  func pump(now: SampleTime, ahead: Int64, block: Int64) {
    scheduleReady(now: now, ahead: ahead)
    guard reading == nil, let s = segment, !s.finished else { return }
    let decodedAhead = s.timelineStart.map { $0 + s.decoded - now } ?? s.decoded
    guard decodedAhead < ahead + s.holdback + block else { return }
    let (source, id) = (s.source, s.id)
    reading = Task { [weak self] in
      do {
        let pcm = try await source.read(maxFrames: Int(block))
        self?.received(pcm, for: id)
      } catch is CancellationError {
        return
      } catch {
        self?.failed(error, for: id)
      }
    }
  }

  private func received(_ pcm: PCMBlock?, for id: UUID) {
    guard segment?.id == id else { return }
    reading = nil
    if let pcm {
      if pcm.frames > 0 {
        segment?.pending.append(pcm)
        segment?.decoded += Int64(pcm.frames)
      }
    } else {
      segment?.finished = true
    }
    onProgress?()
  }

  private func failed(_ error: any Error, for id: UUID) {
    guard segment?.id == id else { return }
    reading = nil
    onError?(id, error)
  }

  private func scheduleReady(now: SampleTime, ahead: Int64) {
    guard var s = segment, let start = s.timelineStart else { return }
    let holdFrom = s.expectedFrames - s.holdback
    while let pcm = s.pending.first {
      let at = start + s.scheduled
      let blockEnd = s.scheduled + Int64(pcm.frames)
      guard at < now + ahead else { break }
      // Near the end, a block waits until the end is known or enough beyond it is decoded: it might fade out.
      if !s.finished && s.holdback > 0 && blockEnd > holdFrom && blockEnd > s.decoded - s.holdback { break }
      s.pending.removeFirst()
      var scaled = pcm
      s.envelope.apply(to: &scaled, at: at)
      if let buffer = scaled.makeBuffer() {
        node.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: at, atRate: EngineFormat.sampleRate), options: [], completionHandler: nil)
      }
      s.scheduled = blockEnd
    }
    segment = s
  }

  func snapshot(title: String?) -> DeckSnapshot {
    DeckSnapshot(
      name: name, title: segment == nil ? nil : title, startsAt: segment?.timelineStart.map(EngineFormat.seconds),
      decodedSeconds: EngineFormat.seconds(segment?.decoded ?? 0), scheduledSeconds: EngineFormat.seconds(segment?.scheduled ?? 0),
      finished: segment?.finished ?? false, gain: segment?.envelope.gain ?? 1)
  }
}
