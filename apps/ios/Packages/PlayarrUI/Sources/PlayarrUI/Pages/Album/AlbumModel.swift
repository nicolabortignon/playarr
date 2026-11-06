import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// An album, as apps/web/src/pages/Album.tsx: header, Play/Pause/Resume, Shuffle, ⋯, the songs with disc headers and
/// missing songs greyed out in their place, liner notes and more by the artist. "Request the rest" is phase 8.
@MainActor @Observable
final class AlbumModel {
  enum Row: Equatable, Identifiable {
    case disc(Int)
    case track(Track, index: Int)
    case missing(MissingTrack)

    var id: String {
      switch self {
      case .disc(let n): "disc-\(n)"
      case .track(let track, let index): "track-\(track.id)-\(index)"
      case .missing(let missing): "missing-\(missing.recordingId)-\(missing.discNumber)-\(missing.trackNumber)"
      }
    }
  }

  let id: Int
  let album: Query<AlbumDetail>
  private(set) var artist: Query<ArtistDetail>?
  /// The cover's own colour, for the header's tint.
  private(set) var tint: RGB?

  @ObservationIgnored private let session: AccountSession
  @ObservationIgnored private let theme: Theme?

  init(id: Int, session: AccountSession, theme: Theme? = nil) {
    self.id = id
    self.session = session
    self.theme = theme
    let api = session.api
    album = Query(.album(id), cache: session.queries) { try await api.send(API.Library.album(id: id)) }
  }

  func load() async {
    await album.load()
    guard let detail = album.value else { return }
    if artist == nil {
      let api = session.api
      let artistId = detail.artistId
      artist = Query(.artist(artistId), cache: session.queries) { try await api.send(API.Library.artist(id: artistId)) }
    }
    await artist?.load()
    tint = await theme?.accent(of: detail.coverUrl, images: session.images)
  }

  var rows: [Row] {
    guard let album = album.value else { return [] }
    return Self.rows(album)
  }

  /// "Album · 1998".
  var kicker: String? {
    guard let album = album.value else { return nil }
    let kind = album.secondaryTypes.first ?? album.albumType
    return album.year.map { "\(kind) · \($0)" } ?? kind
  }

  /// "3 tracks · 17 min · 2 missing · added 3 days ago".
  func details(now: Date = Date()) -> String? {
    guard let album = album.value else { return nil }
    var parts = [Format.plural(album.trackCount, "track"), Format.duration(album.duration)]
    if album.trackCount < album.totalTrackCount { parts.append("\(album.totalTrackCount - album.trackCount) missing") }
    if let added = album.addedAt.flatMap({ Format.addedAgo($0, now: now) }) { parts.append("added \(added)") }
    return parts.joined(separator: " · ")
  }

  /// More by the artist: their other albums.
  var moreByArtist: [Album] { (artist?.value?.albums ?? []).filter { $0.id != id } }

  var isCurrent: Bool { session.player.queue.currentTrack?.albumId == id }

  /// Play, or Pause and Resume while one of its songs is playing.
  var playState: PlayState { PlayState(isCurrent: isCurrent, playing: session.player.queue.playing) }

  var source: PlaySource? { album.value.map { PlaySource(label: $0.title, href: "/albums/\($0.id)") } }

  /// The big button: pause or resume this album, or play it from the start, in order.
  func playOrPause() {
    if isCurrent {
      session.player.togglePlay()
    } else if let album = album.value {
      session.player.play(album.tracks, source: source)
    }
  }

  func shuffle() {
    guard let album = album.value else { return }
    session.player.play(album.tracks, source: source, shuffle: true)
  }

  /// A song tapped: pause or resume it if it's the one playing, else play the album from there.
  func tap(_ track: Track, index: Int) {
    if session.player.queue.currentTrack?.fileId == track.fileId {
      session.player.togglePlay()
    } else if let album = album.value {
      session.player.play(album.tracks, startAt: index, source: source)
    }
  }

  /// The album's songs and missing songs in disc and track order, with a header before each disc when there are several.
  static func rows(_ album: AlbumDetail) -> [Row] {
    let songs: [(disc: Int, number: Int, row: Row)] =
      album.tracks.enumerated().map { ($1.discNumber, $1.trackNumber, .track($1, index: $0)) }
      + album.missingTracks.map { ($0.discNumber, $0.trackNumber, .missing($0)) }
    let sorted = album.missingTracks.isEmpty ? songs : songs.sorted { ($0.disc, $0.number) < ($1.disc, $1.number) }
    var rows: [Row] = []
    var disc: Int?
    for song in sorted {
      if album.discCount > 1, song.disc != disc { rows.append(.disc(song.disc)) }
      disc = song.disc
      rows.append(song.row)
    }
    return rows
  }
}
