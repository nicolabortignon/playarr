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

  /// "2 albums · 5 tracks".
  var counts: String? {
    artist.value.map { "\(Format.plural($0.albumCount, "album")) · \(Format.plural($0.trackCount, "track"))" }
  }

  /// "trip hop · electronic", or "Artist".
  var kicker: String {
    let genres = artist.value?.genres.prefix(3) ?? []
    return genres.isEmpty ? "Artist" : genres.joined(separator: " · ")
  }

  func play(shuffle: Bool = false) async {
    do {
      let api = session.api
      let id = self.id
      let tracks = try await session.queries.fetch(.artistTracks(id)) { try await api.send(API.Library.artistTracks(id: id)) }
      let source = tracks.first.map { PlaySource(label: $0.artistName, href: "/artists/\(id)") }
      session.player.play(tracks, source: source, shuffle: shuffle)
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
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
