import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct MetadataFormatTests {
  static let recording = "8f1c2e7a-3b4d-4c5e-9f60-718293a4b5c6"

  static func metadata(copies: [TrackCopyMetadata] = [], disc: Int = 1, pathsHidden: Bool = false) -> TrackMetadata {
    TrackMetadata(
      trackId: 700, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine", trackNumber: 1, discNumber: disc,
      duration: 379.4, explicit: false, recordingId: recording, albumId: 70, releaseDate: "1998-04-20T00:00:00Z",
      albumType: "Album", secondaryTypes: ["Remaster"], genres: ["trip hop", "electronic"], artistId: 7, copies: copies,
      pathsHidden: pathsHidden)
  }

  static func copy(_ id: Int, kind: SourceKind, playing: Bool = false, path: String? = "/music/a.flac") -> TrackCopyMetadata {
    TrackCopyMetadata(
      fileId: id, playing: playing, source: .init(id: id, name: kind == .folder ? "NAS" : "Lidarr", kind: kind), path: path, size: 41_234_567,
      format: AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, channels: 2, lossless: true))
  }

  @Test func listsTheSongsFieldsLeavingOutEmptyOnes() {
    let rows = MetadataFormat.song(Self.metadata(disc: 2))
    #expect(rows.map(\.label) == ["Title", "Artist", "Album", "Track", "Duration", "Album type", "Released", "Genres", "Recording"])
    #expect(rows[3].value == .text("2-1"))
    #expect(rows[4].value == .text("6:19"))
    #expect(rows[5].value == .text("Album · Remaster"))
    #expect(rows[6].value == .text("1998-04-20"))
    #expect(rows[7].value == .text("trip hop, electronic"))
  }

  @Test func describesFormatsAndSizesAsTheWebDoes() {
    #expect(MetadataFormat.describe(AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, channels: 2, lossless: true)) == "FLAC · 24-bit / 96 kHz · stereo · lossless")
    #expect(MetadataFormat.describe(AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)) == "FLAC · 16-bit / 44.1 kHz · lossless")
    #expect(MetadataFormat.describe(AudioFormat(codec: "MP3", container: "mp3", bitrate: 319.6, channels: 1, lossless: false)) == "MP3 · 320 kbps · mono · lossy")
    #expect(MetadataFormat.describe(AudioFormat(codec: "AAC", container: "m4a", channels: 6, lossless: false)) == "AAC · 6 ch · lossy")
    #expect(MetadataFormat.size(1_610_612_736) == "1.50 GB")
    #expect(MetadataFormat.size(41_234_567) == "39.3 MB")
    #expect(MetadataFormat.size(524_288) == "512 KB")
  }

  @Test func saysHowAFileWasIdentified() {
    #expect(MetadataFormat.match(state: "auto", score: 0.934) == "Matched on MusicBrainz automatically (93%)")
    #expect(MetadataFormat.match(state: "manual", score: 0.5) == "Matched on MusicBrainz by you")
    #expect(MetadataFormat.match(state: "review", score: 0.61) == "Waiting for your review (61%)")
    #expect(MetadataFormat.match(state: "something", score: nil) == "something")
  }

  @Test func linksOnlyRealMusicBrainzIds() {
    #expect(MetadataFormat.musicBrainzURL(id: Self.recording, kind: "recording")?.absoluteString == "https://musicbrainz.org/recording/\(Self.recording)")
    #expect(MetadataFormat.musicBrainzURL(id: "track:12", kind: "recording") == nil)
  }

  @Test func listsAFilesRowsAndTags() {
    var c = Self.copy(1, kind: .folder)
    c.match = .init(state: "auto", score: 0.9)
    c.addedAt = "2026-11-03T10:00:00.000Z"
    let rows = MetadataFormat.copy(c, locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
    #expect(rows.map(\.label) == ["Path", "Format", "Size", "Added", "Identified"])
    #expect(rows[0].value == .path("/music/a.flac"))
    #expect(rows[3].value == .text("Nov 3, 2026 at 10:00\u{202F}AM"))  // a narrow space before AM
    let tags = MetadataFormat.tags(FileTags(title: "Angel", trackNumber: 1, trackTotal: 11, genres: [], recordingMbid: "x"))
    #expect(tags.map(\.label) == ["Title", "Track", "Recording"])
    #expect(tags[1].value == .text("1 of 11"))
  }

  @Test func measuresTheSound() {
    let rows = MetadataFormat.sound(TrackMetadata.Analysis(bpm: 79.6, loudness: 0.8, dynamics: 1.2, brightness: -0.1, busyness: 0.333, bass: 0.5))
    #expect(rows.map(\.value) == [.text("80 BPM"), .text("Not analyzed yet"), .meter(80), .meter(100), .meter(0), .meter(33), .meter(50)])
  }

  @Test func matchesAgainAFolderFileFirst() {
    let lidarr = Self.copy(1, kind: .lidarr, playing: true)
    let folder = Self.copy(2, kind: .folder)
    #expect(MetadataFormat.primaryCopy([lidarr, folder])?.fileId == 2)
    #expect(MetadataFormat.primaryCopy([lidarr])?.fileId == 1)
    #expect(MetadataFormat.rematchLabel(lidarr: true, busy: false) == "Refresh in Lidarr")
    #expect(MetadataFormat.rematchLabel(lidarr: false, busy: true) == "Matching…")
    #expect(MetadataFormat.outcome(.review) == "MusicBrainz has a few possible albums: pick one in Settings → Sources → Review matches.")
  }
}
