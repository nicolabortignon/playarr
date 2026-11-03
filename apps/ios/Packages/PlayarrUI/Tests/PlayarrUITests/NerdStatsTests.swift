import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

/// Stats for nerds' rows, in StatsForNerds.tsx's words (and the native ones where the engine differs).
struct NerdStatsTests {
  let track = Track(
    id: 7, recordingId: "rec-7", fileId: 9000, albumId: 70, artistId: 7, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine",
    trackNumber: 1, discNumber: 1, duration: 379.4, explicit: false,
    format: AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, channels: 2, lossless: true), size: 1, streamUrl: "/stream/9000")
  let map = MixMapEntry(
    version: 8, duration: 379.4, bpm: 120, firstBeat: 0.5, downbeatOffset: 1, downbeatConfidence: 0.8, gridStable: true, beatConfidence: 0.91,
    key: .init(camelot: "8A", confidence: 0.62), introEnd: 32.5, outroStart: 320.5, firstDrop: 64.5, coldStart: false, coldEnd: true,
    soundStart: 0.4, soundEnd: 378.9, beatsFrom: .model, phraseEnergy: [0.2, 0.5, nil, 1], phraseDrift: [3, 31, nil, -2], edgesStable: true)

  func row(_ groups: [NerdStats.Group], _ group: String, _ label: String) -> String? {
    guard case .text(let text)? = groups.first(where: { $0.title == group })?.rows.first(where: { $0.label == label })?.value else { return nil }
    return text
  }

  @Test func formatsAsTheWebDoes() {
    #expect(NerdFormat.at(83.46) == "1:23.4")
    #expect(NerdFormat.time(3723) == "1:02:03")
    #expect(NerdFormat.dB(-5.25) == "−5.3 dB")
    #expect(NerdFormat.dB(0) == "±0.0 dB")
    #expect(NerdFormat.signed(-9.04) == "−9.0")
    #expect(NerdFormat.format(track.format) == "FLAC · 24-bit / 96 kHz · stereo · lossless")
    #expect(NerdFormat.making(RenderProgress(step: .mixing, done: 0.437)) == "43% · mixing")
    #expect(NerdFormat.making(RenderProgress(step: .waiting, done: 0, ahead: 2)) == "waiting · 2 ahead")
  }

  @Test func readsTheBeatGridKeyAndSections() {
    // The first bar is at 0.5 + 1 beat = 1 s; 2 s a bar, 8 s a phrase.
    #expect(NerdStats.gridPosition(map, 18.2) == .init(bar: 9, beat: 3, phrase: 3, barOfPhrase: 1))
    #expect(NerdStats.gridPosition(map, 0.9) == nil)
    #expect(NerdStats.keyName("8A") == "A minor")
    #expect(NerdStats.keyName("8B") == "C major")
    #expect(NerdStats.keyName("3A") == "B♭ minor")
    #expect(NerdStats.section(map, 10) == "intro")
    #expect(NerdStats.section(map, 70) == "main, past the drop")
    #expect(NerdStats.section(map, 379) == "silence")
    #expect(NerdStats.drift([3, 31, nil, -2], .init(bar: 5, beat: 1, phrase: 2, barOfPhrase: 1)) == "+31 ms, drifts · 1 of 4 phrases drift")
    #expect(NerdStats.summary(map: map, level: TrackLevel(track: -5, lufs: -9.04), time: 18.2) == "120.0 BPM · 8A · 9.3 · −9.0 LUFS")
  }

  @Test func theEnergyStripMarksThePhrasePlayingAndTheIntroAndOutro() throws {
    let strip = try #require(NerdStats.energyStrip(map, 9.5))
    #expect(strip.bars.count == 48)  // to where its sound ends: (378.9 − 1) / 8 phrases, rounded up
    #expect(strip.bars[1].state == .now)
    #expect(strip.bars[2].state == .unmeasured)
    #expect(strip.energyNow == "0.50")
    #expect(strip.introLabel == "intro ends 0:32.5")
  }

  @Test func everyGroupWithTheNativeStreamDecksAndChangeovers() {
    let report = MixReport(kind: .mixIn, way: .server, songs: "Angel → Teardrop", sample: 154_350, songTime: 207.5, headroom: 2.61)
    let deck = DeckSnapshot(name: "A", title: "Angel", startsAt: 0, decodedSeconds: 12.34, scheduledSeconds: 2.5, finished: false, gain: 0.5)
    let groups = NerdStats.groups(.init(
      track: track, time: 18.25, duration: 379.5, buffered: 9.96, loading: false, playing: true, map: map,
      level: TrackLevel(track: -6, album: -4.2, lufs: -8, peak: -0.5), gainDb: -6, levelVolume: true, transitions: .dj, mixMode: .party,
      next: track, upcoming: .answer(.pending(.init(plan: TransitionFiles.plan, render: .init(step: .mixing, done: 0.43)))), djWanted: true,
      reports: [.mixIn: report], decks: [deck]))
    #expect(groups.map(\.title) == ["Song", "Playback", "Rhythm", "Structure", "Loudness", "Next"])
    #expect(row(groups, "Song", "Ids") == "track 7 · file 9000")
    #expect(row(groups, "Playback", "Position") == "0:18.2 / 6:19.5 · playing")
    #expect(row(groups, "Playback", "Buffer") == "10.0 s ahead")
    #expect(row(groups, "Playback", "Stream") == "its own file, levelled on this device at −6.0 dB")
    #expect(row(groups, "Playback", "Deck A") == "Angel · placed at 0:00.0 · 12.3 s decoded, 2.5 s scheduled · −6.0 dB")
    #expect(row(groups, "Playback", "Transitions") == "DJ mix · party")
    #expect(row(groups, "Playback", "Mix in") == "Angel → Teardrop · made on the server · at A’s 3:27.5, sample 154350 · scheduled 2.6 s ahead")
    #expect(row(groups, "Playback", "Mix out") == "none yet")
    #expect(row(groups, "Rhythm", "Beat") == "91% sure · steady · holds where mixed · beat model")
    #expect(row(groups, "Rhythm", "Key") == "8A · A minor · 62% sure")
    #expect(row(groups, "Structure", "Outro") == "from 5:20.5 · cold end")
    #expect(row(groups, "Loudness", "Applied") == "−6.0 dB on this device (track gain)")
    #expect(row(groups, "Loudness", "Heard at") == "≈ −14.0 LUFS")
    #expect(row(groups, "Next", "Mix") == "being made · long, 64 beats")
    #expect(row(groups, "Next", "Making") == "43% · mixing")
    #expect(row(groups, "Next", "Length") == "30.0 s · next takes over at +16.0 s · on from 0:46.0")
    #expect(row(groups, "Next", "Mix at") == "3:20.0 (in 3:01) → 0:16.0 of the next")
  }
}

enum TransitionFiles {
  static let plan = TransitionPlan(
    style: .long, aStart: 200, bStart: 16, length: 30, bResume: 46, switchAt: 16, bRate: [.init(at: 0, value: 1)], aGain: [.init(at: 0, value: 1)],
    bGain: [.init(at: 0, value: 0)], aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)],
    reason: "Same tempo, keys compatible: 64-beat blend", beats: 64)
}
