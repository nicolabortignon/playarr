import Foundation
import PlayarrAPI

/// Show metadata's wording (components/TrackMetadataDialog.tsx): rows, formats, sizes, matches and outcomes.
public enum MetadataFormat {
  /// A label and its value; rows without a value are left out.
  public struct Row: Equatable, Sendable, Identifiable {
    public let label: String
    public let value: Value
    public var id: String { label }
  }

  public enum Value: Equatable, Sendable {
    case text(String)
    /// A MusicBrainz id: a link when it is one, else "… (not on MusicBrainz yet)".
    case musicBrainz(id: String, kind: String)
    /// A path to copy.
    case path(String)
    /// 0–100.
    case meter(Int)
  }

  public static func rows(_ pairs: [(String, Value?)]) -> [Row] {
    pairs.compactMap { label, value in
      guard let value else { return nil }
      if case .text(let text) = value, text.isEmpty { return nil }
      return Row(label: label, value: value)
    }
  }

  /// The song's own rows.
  public static func song(_ m: TrackMetadata) -> [Row] {
    let type = ([m.albumType] + m.secondaryTypes).filter { !$0.isEmpty }.joined(separator: " · ")
    return rows([
      ("Title", .text(m.title)),
      ("Artist", .text(m.artistName)),
      ("Album", .text(m.albumTitle)),
      ("Track", .text(track(disc: m.discNumber, number: m.trackNumber))),
      ("Duration", .text(Format.time(m.duration))),
      ("Explicit", m.explicit ? .text("Yes") : nil),
      ("Album type", .text(type)),
      ("Released", m.releaseDate.map { .text(String($0.prefix(10))) }),
      ("Genres", .text(m.genres.joined(separator: ", "))),
      ("Recording", .musicBrainz(id: m.recordingId, kind: "recording")),
      ("Release group", m.albumMbid.map { .musicBrainz(id: $0, kind: "release-group") }),
      ("Artist id", m.artistMbid.map { .musicBrainz(id: $0, kind: "artist") }),
    ])
  }

  /// One file's rows.
  public static func copy(_ c: TrackCopyMetadata, locale: Locale = .current, timeZone: TimeZone = .current) -> [Row] {
    rows([
      ("Path", c.path.map(Value.path)),
      ("Read from", c.readPath.map(Value.path)),
      ("Format", .text(describe(c.format))),
      ("Size", .text(size(c.size))),
      ("Added", c.addedAt.flatMap { added($0, locale: locale, timeZone: timeZone) }.map(Value.text)),
      ("Identified", c.match.map { .text(match(state: $0.state, score: $0.score)) }),
    ])
  }

  /// A file's own tags.
  public static func tags(_ t: FileTags) -> [Row] {
    rows([
      ("Title", t.title.map(Value.text)),
      ("Artist", t.artist.map(Value.text)),
      ("Album artist", t.albumArtist.map(Value.text)),
      ("Album", t.album.map(Value.text)),
      ("Track", t.trackNumber.map { number in .text(t.trackTotal.map { "\(number) of \($0)" } ?? "\(number)") }),
      ("Disc", t.discNumber.map { .text("\($0)") }),
      ("Year", t.year.map { .text("\($0)") }),
      ("Genres", .text(t.genres.joined(separator: ", "))),
      ("Recording", t.recordingMbid.map { .musicBrainz(id: $0, kind: "recording") }),
      ("Release group", t.releaseGroupMbid.map { .musicBrainz(id: $0, kind: "release-group") }),
      ("Release", t.releaseId.map(Value.text)),
      ("Artist id", t.artistMbid.map { .musicBrainz(id: $0, kind: "artist") }),
      ("Album artist id", t.albumArtistMbid.map { .musicBrainz(id: $0, kind: "artist") }),
    ])
  }

  /// What the song sounds like.
  public static func sound(_ a: TrackMetadata.Analysis) -> [Row] {
    let notYet = Value.text("Not analysed yet")
    return rows([
      ("Tempo", a.bpm.map { $0 > 0 ? .text("\(Int(Format.jsRound($0))) BPM") : notYet } ?? notYet),
      ("Beat", a.pulse.map { .meter(meter($0)) } ?? notYet),
      ("Loudness", .meter(meter(a.loudness))),
      ("Dynamics", .meter(meter(a.dynamics))),
      ("Brightness", .meter(meter(a.brightness))),
      ("Busyness", .meter(meter(a.busyness))),
      ("Bass", .meter(meter(a.bass))),
    ])
  }

  /// "5", or "2-5" on a second disc.
  public static func track(disc: Int, number: Int) -> String { disc > 1 ? "\(disc)-\(number)" : "\(number)" }

  /// "FLAC · 24-bit / 96 kHz · stereo · lossless", "MP3 · 320 kbps · stereo · lossy" (Stats for nerds says it the same way).
  public static func describe(_ f: AudioFormat) -> String { NerdFormat.format(f) }

  /// "1.50 GB", "42.3 MB", "512 KB".
  public static func size(_ bytes: Int) -> String {
    let b = Double(bytes)
    if b >= pow(1024, 3) { return String(format: "%.2f GB", b / pow(1024, 3)) }
    if b >= pow(1024, 2) { return String(format: "%.1f MB", b / pow(1024, 2)) }
    return "\(Int(Format.jsRound(b / 1024))) KB"
  }

  /// How a folder file was identified, with the score for automatic and doubtful matches.
  public static func match(state: String, score: Double?) -> String {
    let text = switch state {
    case "auto": "Matched on MusicBrainz automatically"
    case "manual": "Matched on MusicBrainz by you"
    case "review": "Waiting for your review"
    case "unmatched": "Not found on MusicBrainz: uses its tags"
    case "ignored": "Left unmatched by you: uses its tags"
    default: state
    }
    guard let score, state == "auto" || state == "review" else { return text }
    return "\(text) (\(Int(Format.jsRound(score * 100)))%)"
  }

  /// A MusicBrainz page, when `id` is a MusicBrainz id (not Playarr's own "local:"/"track:" ids).
  public static func musicBrainzURL(id: String, kind: String) -> URL? {
    guard id.wholeMatch(of: #/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/#) != nil else { return nil }
    return URL(string: "https://musicbrainz.org/\(kind)/\(id)")
  }

  /// 0–1 as a whole percentage, clamped.
  public static func meter(_ value: Double) -> Int { Int(Format.jsRound(min(1, max(0, value)) * 100)) }

  /// The file "Match again" acts on for the whole song: a folder file (the one that plays, if it's one), else a
  /// Lidarr file (refreshed in Lidarr).
  public static func primaryCopy(_ copies: [TrackCopyMetadata]) -> TrackCopyMetadata? {
    let folder = copies.filter { $0.source.kind == .folder }
    return folder.first { $0.playing } ?? folder.first ?? copies.first { $0.playing } ?? copies.first
  }

  /// The button: "Match again on MusicBrainz", "Refresh in Lidarr", and while it works "Matching…", "Asking Lidarr…".
  public static func rematchLabel(lidarr: Bool, busy: Bool) -> String {
    switch (lidarr, busy) {
    case (true, true): "Asking Lidarr…"
    case (false, true): "Matching…"
    case (true, false): "Refresh in Lidarr"
    case (false, false): "Match again on MusicBrainz"
    }
  }

  /// What matching a folder file again did.
  public static func outcome(_ state: RematchResult.Folder.State) -> String {
    switch state {
    case .auto, .manual: "Matched on MusicBrainz. The metadata is up to date."
    case .review: "MusicBrainz has a few possible albums: pick one in Settings → Sources → Review matches."
    case .unmatched: "Not found on MusicBrainz: the song keeps the tags in its file."
    case .ignored: "Left with the tags in its file."
    case .unknown: "Done."
    }
  }

  public static let pathsHiddenNote = "File paths and where sources live are shown to admins only."
  public static let rematchHiddenNote = "Matching a song again on MusicBrainz is for admins."

  private static func added(_ iso: String, locale: Locale, timeZone: TimeZone) -> String? {
    guard let date = Format.parseDate(iso) else { return nil }
    var style = Date.FormatStyle(date: .abbreviated, time: .shortened)
    style.locale = locale
    style.timeZone = timeZone
    return date.formatted(style)
  }
}
