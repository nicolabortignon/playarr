import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct FormatTests {
  @Test func writesTimesAsTheWebDoes() {
    #expect(Format.time(245) == "4:05")
    #expect(Format.time(3725) == "1:02:05")
    #expect(Format.time(-3) == "0:00")
    #expect(Format.time(.nan) == "0:00")
  }

  @Test func writesDurations() {
    #expect(Format.duration(2564) == "43 min")
    #expect(Format.duration(7300) == "2 hr 2 min")
    #expect(Format.duration(7200) == "2 hr")
  }

  @Test func countsInWords() {
    #expect(Format.plural(1, "track") == "1 track")
    #expect(Format.plural(12, "track") == "12 tracks")
  }

  @Test func writesAWaitRoughly() {
    #expect(Format.wait(0.2) == "1 s")
    #expect(Format.wait(3.2) == "3 s")
    #expect(Format.wait(130) == "2 min")
  }

  @Test func roundsHalvesUpAsJavaScriptDoes() {
    #expect(Format.jsRound(2.5) == 3)
    #expect(Format.jsRound(-2.5) == -2)
    #expect(Format.jsRound(0.425 * 100) == 43)
  }

  @Test func namesTheFormat() {
    let hiRes = AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 88_200, lossless: true)
    let cd = AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)
    let mp3 = AudioFormat(codec: "MP3", container: "mp3", bitrate: 320, lossless: false)
    #expect(Format.badge(hiRes) == "FLAC 24/88.2")
    #expect(Format.badge(cd) == "FLAC 16/44.1")
    #expect(Format.badge(mp3) == "MP3 320")
    #expect(Format.badge(AudioFormat(codec: "AAC", container: "m4a", lossless: false)) == "AAC")
    #expect(Format.isHiRes(hiRes))
    #expect(!Format.isHiRes(cd))
    #expect(!Format.isHiRes(mp3))
  }

  @Test func saysWhenAnAlbumWasAdded() {
    let now = Format.parseDate("2026-11-03T12:00:00.000Z")!
    let english = Locale(identifier: "en_US")
    #expect(Format.addedAgo("2026-11-03T08:00:00Z", now: now, locale: english) == "today")
    #expect(Format.addedAgo("2026-10-31T12:00:00.000Z", now: now, locale: english) == "3 days ago")
    #expect(Format.addedAgo("2026-09-01T12:00:00.000Z", now: now, locale: english) == "2 months ago")
    #expect(Format.addedAgo("not a date", now: now) == nil)
  }
}
