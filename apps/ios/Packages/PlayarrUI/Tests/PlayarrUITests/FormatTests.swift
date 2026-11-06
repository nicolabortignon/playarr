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

  @Test func namesTheFormatLeavingOutWhatsOrdinary() {
    // As apps/web/src/lib/format.test.ts: the detail only when it's out of the ordinary (256 kbps or more, CD quality).
    let hiRes = AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 88_200, lossless: true)
    let cd = AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)
    let dvd = AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 48_000, lossless: true)
    let mp3 = AudioFormat(codec: "MP3", container: "mp3", bitrate: 320, lossless: false)
    #expect(Format.badge(AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, lossless: true)) == "FLAC · 24/96")
    #expect(Format.badge(hiRes) == "FLAC · 24/88.2")
    #expect(Format.badge(AudioFormat(codec: "FLAC", container: "flac", bits: 8, sampleRate: 22_050, lossless: true)) == "FLAC · 8/22.1")
    #expect(Format.badge(cd) == "FLAC")
    #expect(Format.badge(dvd) == "FLAC")
    #expect(Format.badge(AudioFormat(codec: "ALAC", container: "m4a", lossless: true)) == "ALAC")
    #expect(Format.badge(mp3) == "MP3")
    #expect(Format.badge(AudioFormat(codec: "MP3", container: "mp3", bitrate: 256, lossless: false)) == "MP3")
    #expect(Format.badge(AudioFormat(codec: "MP3", container: "mp3", bitrate: 128, lossless: false)) == "MP3 · 128 kbps")
    #expect(Format.badge(AudioFormat(codec: "MP3", container: "mp3", bitrate: 8, lossless: false)) == "MP3 · 8 kbps")
    #expect(Format.badge(AudioFormat(codec: "AAC", container: "m4a", lossless: false)) == "AAC")
    #expect(Format.badgeParts(AudioFormat(codec: "MP3", container: "mp3", bitrate: 191.6, lossless: false))?.detail == "192 kbps")
    #expect(Format.badge(nil) == nil)
    #expect(Format.isHiRes(hiRes))
    #expect(!Format.isHiRes(cd))
    #expect(!Format.isHiRes(mp3))
  }

  @Test func spellsOutEveryDetailOfAFormat() {
    // A badge's accessibility value (the web's badge title).
    let hiRes = AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, channels: 2, lossless: true)
    #expect(Format.details(hiRes) == "FLAC · 24-bit / 96 kHz · stereo · Hi-Res lossless")
    let cd = AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)
    #expect(Format.details(cd) == "FLAC · 16-bit / 44.1 kHz · lossless")
    let mp3 = AudioFormat(codec: "MP3", container: "mp3", sampleRate: 44_100, bitrate: 128, channels: 1, lossless: false)
    #expect(Format.details(mp3) == "MP3 · 44.1 kHz · 128 kbps · mono · lossy")
  }

  @Test func namesAReleaseByItsPrimaryTypeQualifiedOrReplacedByItsFirstSecondaryType() {
    // As apps/web/src/lib/format.test.ts.
    #expect(Format.releaseKind("Album") == "Album")
    #expect(Format.releaseKind("EP", []) == "EP")
    #expect(Format.releaseKind("Album", ["Live"]) == "Live album")
    #expect(Format.releaseKind("EP", ["Live"]) == "Live EP")
    #expect(Format.releaseKind("Album", ["Compilation", "Live"]) == "Compilation")
    #expect(Format.releaseKind("Album", ["DJ-mix"]) == "DJ mix")
    #expect(Format.releaseKind("Album", ["Mixtape/Street"]) == "Mixtape")
    #expect(Format.releaseKind("Album", ["Soundtrack"]) == "Soundtrack")
    #expect(Format.releaseKind("Single", ["Remix"]) == "Remix single")
  }

  @Test func saysSomethingReadableForLooseSongsAndTypesItDoesntKnow() {
    #expect(Format.releaseKind("Loose") == "Loose songs")
    #expect(Format.releaseKind("Other") == "Release")
    #expect(Format.releaseKind("Other", ["Live"]) == "Live album")
    #expect(Format.releaseKind("") == "Album")
    #expect(Format.releaseKind("Album", ["bonus"]) == "Bonus")
    #expect(Format.releaseKind("Album", [""]) == "Album")
  }

  @Test func aLineOfPhrasesWrapsOnlyBetweenThem() {
    let nbsp = "\u{00A0}"
    #expect(Format.wrapsAtDots("0 of 3 songs · 0 MB") == "0\(nbsp)of\(nbsp)3\(nbsp)songs\(nbsp)· 0\(nbsp)MB")
    // A part that starts with its dot (a download's failures) keeps it with the phrase before.
    #expect(Format.wrapsAtDots(" · 3 couldn’t download") == "\(nbsp)· 3\(nbsp)couldn’t\(nbsp)download")
    #expect(Format.wrapsAtDots("") == "")
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
