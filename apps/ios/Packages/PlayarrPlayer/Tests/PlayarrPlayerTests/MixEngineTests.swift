import AVFoundation
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// DJ joins rendered offline: every changeover checked to the sample. The left channel carries "music" that runs on
/// continuously through A, the transition and B (a changeover a sample off shows as a step); the right channel says
/// which file is heard (A's own 0.1, the transition 0.2, B's own 0.3), so each changeover's sample can be read off it.
@MainActor
@Suite(.serialized)
struct MixEngineTests {
  let sr = 44_100

  /// The limiter's delay, found on the left channel.
  func lag(_ out: PCMBlock, _ expected: (Int) -> Float) -> Int { latency(of: out, matching: expected) }

  @Test func aRenderedTransitionLandsOnTheSampleAtBothChangeovers() async throws {
    // A's mix point at 4 s; the file has a 1 s lead, a 2 s transition, a 1 s tail; B goes on from 10 s.
    let aStart = 4 * sr, lead = sr, length = 2 * sr, tail = sr, bResume = 10 * sr
    let music = TransitionFiles.music
    let file = try TransitionFiles.flac(frames: lead + length + tail) { k, c in
      c == 0 ? music(Int64(aStart - lead + k)) : 0.2
    }
    // B's own file holds the same music from where the transition leaves it.
    let audio = try AudioEngine.offline(
      [1: { n, c in c == 0 ? music(n) : 0.1 }, 2: { m, c in c == 0 ? music(m - Int64(bResume) + Int64(aStart + length)) : 0.3 }],
      tuning: .dj)
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let a = EngineItem(track: song(1, duration: 8)), b = EngineItem(track: song(2, duration: 30))
    let plan = TransitionFiles.plan(aStart: 4, length: 2, bResume: 10, switchAt: 1)
    audio.load(a, playing: true)
    audio.setUpcoming(b, join: .transition(TransitionJoin(plan: plan, file: file, leadFrames: Int64(lead), tailFrames: Int64(tail))))
    let out = try await audio.render(seconds: 9)
    let lag = lag(out) { music(Int64($0)) }
    let cut = aStart - lead / 2, landing = aStart + length
    // Not one sample off anywhere: the music runs on through both changeovers.
    let worst = (0..<(8 * sr)).map { abs(out.left[$0 + lag] - music(Int64($0))) }.max() ?? 1
    #expect(worst < 1e-4)
    // A's own file to the transition in the middle of its lead, the transition to B's own file where it ends.
    #expect(abs(out.right[cut - 1 + lag] - 0.1) < 1e-4)
    #expect(abs(out.right[cut + lag] - 0.2) < 1e-4)
    #expect(abs(out.right[landing - 1 + lag] - 0.2) < 1e-4)
    #expect(abs(out.right[landing + lag] - 0.3) < 1e-4)
    // The listener sees B from the switch, at B's time.
    #expect(events.contains(.advanced(b.id)))
    #expect(abs(audio.position - 13) < 0.1)
    #expect(audio.mixReports[.mixIn]?.sample == SampleTime(cut))
    #expect(audio.mixReports[.mixOut]?.sample == SampleTime(landing))
    #expect((audio.mixReports[.mixIn]?.headroom ?? 0) > 0.5)
  }

  @Test func aTransitionMadeAtOtherLevelsIsTurnedToTheSongsLevels() async throws {
    // The songs play at −6 dB and +4 dB; the transition was made at 0 dB for both.
    let aStart = 4 * sr, lead = sr, length = 2 * sr, tail = sr, bResume = 10 * sr
    let music = TransitionFiles.music
    let file = try TransitionFiles.flac(frames: lead + length + tail) { k, _ in music(Int64(aStart - lead + k)) }
    let audio = try AudioEngine.offline(
      [1: { n, _ in music(n) }, 2: { m, _ in music(m - Int64(bResume) + Int64(aStart + length)) }], tuning: .dj)
    let a = EngineItem(track: song(1, duration: 8), gainDb: -6), b = EngineItem(track: song(2, duration: 30), gainDb: 4)
    let plan = TransitionFiles.plan(aStart: 4, length: 2, bResume: 10, switchAt: 1)
    audio.load(a, playing: true)
    audio.setUpcoming(b, join: .transition(TransitionJoin(plan: plan, file: file, leadFrames: Int64(lead), tailFrames: Int64(tail), correctionA: -6, correctionB: 4)))
    let out = try await audio.render(seconds: 8)
    let (ga, gb) = (pow(10, -6.0 / 20), pow(10, 4.0 / 20))
    let expected = { (n: Int) -> Float in
      let t = Double(n - aStart) / Double(self.sr)
      let gain = n < aStart ? ga : n >= aStart + length ? gb : MixSequence.bridgeGain(plan, t, gainA: ga, gainB: gb)
      return Float(gain) * music(Int64(n))
    }
    let lag = lag(out, expected)
    for changeover in [aStart - lead / 2, aStart + length] {
      let worst = ((changeover - 2000)..<(changeover + 2000)).map { abs(out.left[$0 + lag] - expected($0)) }.max() ?? 1
      #expect(worst < 2e-4, "at \(changeover)")
    }
  }

  @Test func aFadeWithoutAFileIsPlayedLiveOnThePlansCurves() async throws {
    // A in the left ear (0.4), B in the right as a ramp that says which of its frames is heard.
    let plan = TransitionFiles.plan(
      style: .fade, aStart: 3, bStart: 0.5, length: 1, bResume: 1.5, switchAt: 0.5,
      aGain: SkipPlanner.equalPower(0, 1, fadingIn: false), bGain: SkipPlanner.equalPower(0, 1, fadingIn: true))
    let audio = try AudioEngine.offline([1: Signals.constant(0.4, 0), 2: { m, c in c == 1 ? Float(m) * 1e-6 : 0 }], tuning: .dj)
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let b = EngineItem(track: song(2, duration: 20))
    audio.load(EngineItem(track: song(1, duration: 6)), playing: true)
    audio.setUpcoming(b, join: .mix(plan))
    let out = try await audio.render(seconds: 5.5)
    let lag = (0..<512).first { out.left[$0] > 0.2 } ?? 0
    let start = 3 * sr
    for i in stride(from: 0, to: sr, by: 441) {
      let t = Double(i) / Double(sr)
      #expect(abs(out.left[start + i + lag] - 0.4 * Float(plan.aGain.value(at: t))) < 1e-4)
      let bFrame = Double(sr / 2 + i)  // B from 0.5 s, at its own speed
      #expect(abs(out.right[start + i + lag] - Float(plan.bGain.value(at: t) * bFrame * 1e-6)) < 1e-4)
    }
    #expect(abs(out.left[start + sr + 10 + lag]) < 1e-6)  // A is gone
    #expect(events.contains(.advanced(b.id)))
    #expect(abs(audio.position - (1.5 + 1.5)) < 0.1)
  }

  @Test func aStretchedQuickMixLandsBOnTheSampleWhereItsOwnPlaybackGoesOn() async throws {
    // B at 0.98 for 0.7 s, back to 1 by 0.9 s, held to 1 s: it must end on exactly frame 5.0 s.
    let rate: Automation = [.init(at: 0, value: 0.98), .init(at: 0.7, value: 0.98), .init(at: 0.9, value: 1)]
    let bStart = 5 - rate.integral(from: 0, to: 1)
    let plan = TransitionFiles.plan(
      style: .quick, aStart: 2, bStart: bStart, length: 1, bResume: 5, switchAt: 0.5, bRate: rate,
      aGain: [.init(at: 0, value: 0)], bGain: [.init(at: 0, value: 1)])
    // B's left channel is its frame number: interpolating a straight line gives back the position exactly.
    let audio = try AudioEngine.offline([1: Signals.constant(0, 0.4), 2: { m, c in c == 0 ? Float(m) * 1e-6 : 0 }], tuning: .dj)
    audio.load(EngineItem(track: song(1, duration: 6)), playing: true)
    audio.setUpcoming(EngineItem(track: song(2, duration: 20)), join: .mix(plan))
    let out = try await audio.render(seconds: 4)
    let lag = (0..<512).first { out.right[$0] > 0.2 } ?? 0
    let start = 2 * sr
    for i in stride(from: 0, to: sr, by: 1000) {
      // Output sample i reads B at 5 s − ∫ rate from i to the end.
      let expected = 5 * Double(sr) - Double(sr) * rate.integral(from: (Double(i)) / Double(sr), to: 1)
      #expect(abs(Double(out.left[start + i + lag]) / 1e-6 - expected) < 0.2, "sample \(i)")
    }
    for i in [sr, sr + 1, sr + 2, sr + 4410] {
      #expect(abs(Double(out.left[start + i + lag]) / 1e-6 - Double(5 * sr + (i - sr))) < 0.1, "after, sample \(i)")
    }
  }

  @Test func aCutOnTheBeatChangesSongsOnOneSample() async throws {
    let audio = try AudioEngine.offline([1: Signals.constant(0.1, 0.1), 2: { m, c in c == 0 ? Float(m) * 1e-6 : 0.3 }], tuning: .dj)
    audio.load(EngineItem(track: song(1, duration: 6)), playing: true)
    audio.setUpcoming(EngineItem(track: song(2, duration: 20)), join: .cut(BeatCut(aEnd: 3, bStart: 1)))
    let out = try await audio.render(seconds: 4)
    let lag = (0..<512).first { out.right[$0] > 0.05 } ?? 0
    #expect(abs(out.right[3 * sr - 1 + lag] - 0.1) < 1e-4)
    #expect(abs(out.right[3 * sr + lag] - 0.3) < 1e-4)
    #expect(abs(Double(out.left[3 * sr + lag]) / 1e-6 - Double(sr)) < 0.1)  // B from its frame at 1 s
  }

  @Test func aMixAskedForTooLateIsMissedAndTheSongsJoinGapless() async throws {
    let audio = try AudioEngine.offline([1: Signals.constant(0.1, 0.1), 2: Signals.constant(0.3, 0.3)], tuning: .dj)
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let b = EngineItem(track: song(2, duration: 20))
    audio.load(EngineItem(track: song(1, duration: 3)), playing: true)
    _ = try await audio.render(seconds: 1)
    audio.setUpcoming(b, join: .cut(BeatCut(aEnd: 1.05, bStart: 1)))  // already scheduled past
    let out = try await audio.render(seconds: 3)
    #expect(events.contains(.mixMissed(b.id)))
    // A to its end at 3 s (2 s into this render), then B from its start: no sample of silence between.
    let join = (2 * sr - 300)..<(2 * sr + 300)
    #expect(abs(out.left[join.lowerBound] - 0.1) < 1e-4)
    #expect(abs(out.left[join.upperBound] - 0.3) < 1e-4)
    #expect(out.left[join].allSatisfy { abs($0 - 0.1) < 1e-4 || abs($0 - 0.3) < 1e-4 })
  }

  @Test func aMixWhoseNextSongIsNotReadyInTimeIsMissedWithoutAGap() async throws {
    let gate = Gate()
    let stalled = SignalSource(seconds: 20, signal: Signals.constant(0.3, 0.3))
    await stalled.stall(after: 0, until: gate)
    let audio = try AudioEngine(tuning: .dj, manualRendering: true) { item, frame in
      item.track.id == 2 ? stalled : SignalSource(seconds: item.track.duration, from: frame, signal: Signals.constant(0.1, 0.1))
    }
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let b = EngineItem(track: song(2, duration: 20))
    audio.load(EngineItem(track: song(1, duration: 8)), playing: true)
    audio.setUpcoming(b, join: .cut(BeatCut(aEnd: 4, bStart: 0)))
    let out = try await audio.render(seconds: 6)
    #expect(events.contains(.mixMissed(b.id)))
    // A played on through where the cut would have been, never short of audio.
    #expect(audio.state == .playing)
    let a = out.left[(3 * sr)..<(5 * sr)]
    #expect(a.allSatisfy { abs($0 - 0.1) < 1e-4 })
    await gate.open()
  }
}
