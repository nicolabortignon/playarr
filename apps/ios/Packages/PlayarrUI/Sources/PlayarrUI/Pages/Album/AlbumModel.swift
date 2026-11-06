import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// An album, as apps/web/src/pages/Album.tsx: header, Play/Pause/Resume, Shuffle, ⋯, the songs with disc headers and
/// missing songs grayed out in their place, liner notes and more by the artist. "Request the rest" is phase 8.
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

  /// What it is: "Album", "EP", "Live album" (`Format.releaseKind`).
  var kicker: String? { album.value.map { Format.releaseKind($0.albumType, $0.secondaryTypes) } }

  /// The meta line after the artist: "1998 · 3 songs · 17 min" (`facts(_:)`).
  var facts: String? { album.value.map(Self.facts) }

  /// The artist's small photo beside their name, when they have one of their own (`ArtistDetail.photo`).
  var artistPhoto: String? { artist?.value?.photo }

  /// "1998 · 3 songs · 17 min": when, how many, how long. Missing songs show grayed in the list, and the action row
  /// offers the rest, so the line stays short enough for the format badge after it.
  static func facts(_ album: AlbumDetail) -> String {
    MetaLine.join([album.year.map { String($0) }, Format.plural(album.trackCount, "song"), Format.duration(album.duration)])
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

  /// A song tapped: the album from there, in order. (Its row pauses or resumes the song playing instead.)
  func play(from index: Int) {
    guard let album = album.value else { return }
    session.player.play(album.tracks, startAt: index, source: source)
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
