import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// An artist, as apps/web/src/pages/Artist.tsx: Play and Shuffle, the albums in groups, similar artists in the
/// library (from ListenBrainz), and About. "Not in your library" and similar artists to discover are phase 8.
@MainActor @Observable
final class ArtistModel {
  struct Group: Equatable {
    let title: String
    let albums: [Album]
  }

  let id: Int
  let artist: Query<ArtistDetail>
  private(set) var similar: Query<[DiscoverArtist]>?
  var bioOpen = false

  @ObservationIgnored private let session: AccountSession

  init(id: Int, session: AccountSession) {
    self.id = id
    self.session = session
    let api = session.api
    artist = Query(.artist(id), cache: session.queries) { try await api.send(API.Library.artist(id: id)) }
  }

  func load() async {
    await artist.load()
    if similar == nil, let mbid = artist.value?.mbid {
      let api = session.api
      similar = Query(.similarArtists(mbid), cache: session.queries, staleAfter: 60 * 60) { try await api.send(API.Discover.similarArtists(mbid: mbid)) }
    }
    await similar?.load()
  }

  var groups: [Group] { Self.groups(artist.value?.albums ?? []) }

  /// Similar artists with music in the library (their pages open here).
  var similarInLibrary: [DiscoverArtist] { (similar?.value ?? []).filter { $0.artistId != nil } }

  /// The header's meta line: "2 albums · 5 songs".
  var counts: String? {
    artist.value.map { "\(Format.plural($0.albumCount, "album")) · \(Format.plural($0.trackCount, "song"))" }
  }

  /// About's kicker: "trip hop · electronic", or nil without genres.
  var genres: String? {
    let genres = artist.value?.genres.prefix(3) ?? []
    return genres.isEmpty ? nil : genres.joined(separator: " · ")
  }

  /// Play, or Pause and Resume while the queue is this artist's.
  var playState: PlayState { PlayState.of(session.player.queue, href: "/artists/\(id)") }

  /// The Play button: pause or resume this artist's songs, or play them.
  func playOrPause() async {
    if playState.isCurrent { session.player.togglePlay() } else { await play() }
  }

  func play(shuffle: Bool = false) async {
    guard let tracks = await tracks() else { return }
    let source = tracks.first.map { PlaySource(label: $0.artistName, href: "/artists/\(id)") }
    session.player.play(tracks, source: source, shuffle: shuffle)
  }

  /// ⋯'s Play next and Add to queue, with every song of the artist's.
  func queue(next: Bool) async {
    guard let tracks = await tracks() else { return }
    next ? session.actions.playNext(tracks) : session.actions.addToQueue(tracks)
  }

  /// The artist's songs, or nil once a toast has said why they couldn't be had.
  private func tracks() async -> [Track]? {
    let api = session.api
    let id = self.id
    do {
      return try await session.queries.fetch(.artistTracks(id)) { try await api.send(API.Library.artistTracks(id: id)) }
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }

  /// Albums, Soundtracks, EPs & Singles, Live & Compilations, Loose songs (empty groups left out).
  static func groups(_ albums: [Album]) -> [Group] {
    var buckets: [[Album]] = Array(repeating: [], count: 5)
    for album in albums {
      let secondary = album.secondaryTypes.map { $0.lowercased() }
      let index =
        if album.albumType == "Loose" { 4 }
        else if secondary.contains("soundtrack") { 1 }
        else if secondary.contains(where: ["live", "compilation", "remix", "dj-mix", "mixtape/street"].contains) { 3 }
        else if album.albumType == "EP" || album.albumType == "Single" { 2 }
        else { 0 }
      buckets[index].append(album)
    }
    let titles = ["Albums", "Soundtracks", "EPs & Singles", "Live & Compilations", "Loose songs"]
    return zip(titles, buckets).compactMap { title, albums in albums.isEmpty ? nil : Group(title: title, albums: albums) }
  }
}
