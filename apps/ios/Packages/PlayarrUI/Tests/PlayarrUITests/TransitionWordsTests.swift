import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

/// The "Next: …" line and its sheet, in TransitionView.tsx's words.
struct TransitionWordsTests {
  func plan(_ style: TransitionStyle, beats: Double = 0, reason: String = "Same tempo, keys compatible: 32-beat blend") -> TransitionPlan {
    TransitionPlan(
      style: style, aStart: 200, bStart: 16, length: 15, bResume: 31, switchAt: 8, bRate: [.init(at: 0, value: 1)], aGain: [.init(at: 0, value: 1)],
      bGain: [.init(at: 0, value: 0)], aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)],
      reason: reason, beats: beats)
  }

  func map(bpm: Double, key: String? = nil, confidence: Double = 0.8) -> MixMapEntry {
    MixMapEntry(
      version: 8, duration: 200, bpm: bpm, firstBeat: 0.1, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9,
      key: key.map { .init(camelot: $0, confidence: confidence) }, introEnd: 16, outroStart: 180, coldStart: false, coldEnd: false,
      soundEnd: 199, phraseEnergy: [])
  }

  @Test func namesEachStyle() {
    #expect(TransitionWords.styleName(plan(.long, beats: 32)) == "32-beat blend")
    #expect(TransitionWords.styleName(plan(.quick, beats: 8)) == "8-beat quick mix")
    #expect(TransitionWords.styleName(plan(.quick)) == "quick mix")
    #expect(TransitionWords.styleName(plan(.fade)) == "crossfade")
    #expect(TransitionWords.styleName(plan(.straight)) == "straight on")
  }

  @Test func saysWhatIsKnown() {
    #expect(TransitionWords.describe(nil, mixMode: .auto).style == "planning the mix")
    let pending = TransitionWords.describe(.answer(.pending(.init(plan: plan(.long, beats: 64)))), mixMode: .party)
    #expect(pending.style == "64-beat blend" && pending.preparing)
    #expect(TransitionWords.describe(.gaveUp, mixMode: .auto).why == "The mix wasn’t ready in time, so the next song follows straight on.")
    #expect(TransitionWords.describe(nil, mixMode: .off) == .init(style: "no mixing", why: "Mixing is off for this queue, so the next song follows straight on."))
    let unavailable = TransitionWords.describe(.answer(.unavailable(.init(reason: "No mix map yet for the next song (rec-2)"))), mixMode: .auto)
    #expect(unavailable.why == "The next song hasn’t been analysed yet, so the next song follows straight on.")
    #expect(TransitionWords.plainReason("Mixed transitions need audio analysis") == "Mixing needs audio analysis, which is off on this server")
    #expect(TransitionWords.plainReason("something for the logs") == "There’s no mix for these two songs")
  }

  @Test func theLineHasTempoAndKeyOnlyWhenKnownForBoth() {
    let words = TransitionWords.describe(.answer(.straight(.init(plan: plan(.long, beats: 32)))), mixMode: .auto)
    let line = TransitionWords.line(words, map(bpm: 123.6, key: "8A"), map(bpm: 126.2, key: "9A"))
    #expect(line == "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A")
    #expect(TransitionWords.line(words, map(bpm: 124, key: "8A", confidence: 0.2), map(bpm: 0, key: "9A")) == "Next: 32-beat blend")
    #expect(TransitionWords.spoken(line) == "Next: 32-beat blend, 124 to 126 BPM, 8A to 9A")
    #expect(TransitionWords.songFacts(map(bpm: 124, key: "8A")) == "124 BPM · 8A")
  }
}
