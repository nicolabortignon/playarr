import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Home, as apps/web/src/pages/Home.tsx: the library line, Shuffle everything and Resume, then Year in review
/// (December and January), Your mixes, Jump back in, Favorites, Playlists, Recently added, Artists and Rediscover.
@MainActor @Observable
final class HomeModel {
  /// How many artists the shelf shows; all of them are a tap away on Artists.
  static let shelfArtistCount = 20

  let health: Query<HealthStatus>
  let recent: Query<[Album]>
  let artists: Query<[Artist]>
  let heardLately: Query<[Album]>
  let review: Query<ListeningStats>?
  let reviewYear: Int?
  private(set) var rediscover: Query<[Album]>
  private(set) var seed = 0

  @ObservationIgnored private let session: AccountSession

  init(session: AccountSession, now: Date = Date()) {
    self.session = session
    let api = session.api
    let cache = session.queries
    health = Query(.health, cache: cache, staleAfter: 30) { try await api.send(API.Server.health()) }
    recent = Query(.albums(.added, limit: 14), cache: cache) { try await api.send(API.Library.albums(sort: .added, limit: 14)) }
    artists = Query(.artists, cache: cache) { try await api.send(API.Library.artists()) }
    heardLately = Query(.recentAlbums, cache: cache, staleAfter: 60) { try await api.send(API.Library.recentAlbums()) }
    reviewYear = Self.reviewYear(now: now)
    review = reviewYear.map { year in
      Query(.stats(String(year)), cache: cache) { try await api.send(API.Stats.listening(String(year))) }
    }
    rediscover = Self.rediscover(seed: 0, session: session)
  }

  /// Everything at once; each section shows when its answer comes.
  func load() async {
    async let a: Void = health.load()
    async let b: Void = recent.load()
    async let c: Void = artists.load()
    async let d: Void = session.favorites.load()
    async let e: Void = session.playlists.load()
    async let f: Void = session.mixes.load()
    async let g: Void = heardLately.load()
    async let h: Void = rediscover.load()
    async let i: Void = review?.load() ?? ()
    _ = await (a, b, c, d, e, f, g, h, i)
  }

  /// Pull to refresh.
  func refresh() async {
    for query in [health.refresh, recent.refresh, artists.refresh, heardLately.refresh] {
      await query()
    }
    await session.refreshListening()
  }

  /// "8 tracks across 3 albums, 44 min of music waiting in your library."
  var libraryLine: String? {
    guard let library = health.value?.library else { return nil }
    return "\(library.tracks) tracks across \(library.albums) albums, \(Format.duration(library.durationSeconds)) of music waiting in your library."
  }

  /// Year in review: the year that's ending (December) or just ended (January), if anything was played in it.
  var yearInReview: (year: Int, minutes: Int, top: Artist?)? {
    guard let year = reviewYear, let stats = review?.value, stats.plays > 0, stats.range == String(year) else { return nil }
    return (year, Int(stats.minutes), stats.topArtists.first?.artist)
  }

  /// Your mixes: hidden once the server says there are none.
  var showsMixes: Bool { session.mixes.mixes.map { !$0.isEmpty } ?? (session.mixes.error == nil) }

  /// Jump back in: shown from three albums.
  var jumpBackIn: [Album] { (heardLately.value?.count ?? 0) >= 3 ? heardLately.value ?? [] : [] }

  /// The first five favorites, as songs to play.
  var favoriteTracks: [Track] { (session.favorites.tracks ?? []).prefix(5).map(\.track) }

  var shelf: [Artist] { Self.shelfArtists(artists.value, recent: recent.value) }

  /// Rediscover's dice: twelve other albums.
  func reshuffle() async {
    seed += 1
    rediscover = Self.rediscover(seed: seed, session: session)
    await rediscover.load()
  }

  /// Shuffle everything: 300 random songs from the library.
  func shuffleEverything() async {
    do {
      let tracks = try await session.api.send(API.Library.randomTracks(limit: 300))
      session.player.play(tracks, source: PlaySource(label: "Your whole library", href: "/albums"), shuffle: true)
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
    }
  }

  /// The song of the listening session, paused (to resume) or playing (to pause from here).
  var listening: Track? { session.player.queue.currentTrack }

  var isPlaying: Bool { session.player.queue.playing }

  func togglePlay() { session.player.setPlaying(!isPlaying) }

  static func rediscover(seed: Int, session: AccountSession) -> Query<[Album]> {
    let api = session.api
    return Query(.randomAlbums(seed: seed), cache: session.queries, staleAfter: .infinity) { try await api.send(API.Library.randomAlbums(limit: 12)) }
  }

  /// December: this year. January: last year. Otherwise none.
  static func reviewYear(now: Date, calendar: Calendar = .current) -> Int? {
    let parts = calendar.dateComponents([.year, .month], from: now)
    guard let year = parts.year else { return nil }
    switch parts.month {
    case 12: return year
    case 1: return year - 1
    default: return nil
    }
  }

  /// The artists of the latest albums first, then those with the most albums, never the whole roster.
  static func shelfArtists(_ artists: [Artist]?, recent: [Album]?) -> [Artist] {
    guard let artists else { return [] }
    let byId = Dictionary(artists.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var picked: [Artist] = []
    var seen = Set<Int>()
    for album in recent ?? [] {
      if let artist = byId[album.artistId], seen.insert(artist.id).inserted { picked.append(artist) }
    }
    for artist in artists.sorted(by: { $0.albumCount > $1.albumCount }) where picked.count < shelfArtistCount {
      if seen.insert(artist.id).inserted { picked.append(artist) }
    }
    return Array(picked.prefix(shelfArtistCount))
  }
}

extension FavoriteTrack {
  /// The favorite as a song to play.
  public var track: Track {
    Track(
      id: id, recordingId: recordingId, fileId: fileId, albumId: albumId, artistId: artistId, title: title,
      artistName: artistName, albumTitle: albumTitle, trackNumber: trackNumber, discNumber: discNumber,
      duration: duration, explicit: explicit, format: format, size: size, streamUrl: streamUrl, coverUrl: coverUrl)
  }
}
