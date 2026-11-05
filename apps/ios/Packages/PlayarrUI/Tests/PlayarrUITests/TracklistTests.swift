import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@Suite struct NowPlayingLayoutTests {
  @Test func turnsWithThePhone() {
    #expect(NowPlayingLayout.choose(split: false, compactHeight: false, accessibilitySize: false) == .upright)
    #expect(NowPlayingLayout.choose(split: false, compactHeight: true, accessibilitySize: false) == .sideways)
    #expect(NowPlayingLayout.choose(split: false, compactHeight: true, accessibilitySize: true) == .sideways)
    #expect(NowPlayingLayout.choose(split: true, compactHeight: false, accessibilitySize: false) == .wide)
    #expect(NowPlayingLayout.choose(split: true, compactHeight: false, accessibilitySize: true) == .upright)
  }

  @Test func givesTheRecordWhatTheTracklistCanSpare() {
    let deck = NowPlayingLayout.deckHeight
    // iPhone 17 Pro sideways, inside its margins: the deck's width, the cover as tall as the rest.
    #expect(NowPlayingLayout.recordWidth(width: 718, height: 365, deck: deck) == NowPlayingLayout.deckWidth)
    // In the stage the deck is gone and the cover grows, as far as 42% of the width.
    #expect(abs(NowPlayingLayout.recordWidth(width: 718, height: 365, deck: 0) - 301.56) < 0.01)
    #expect(abs(NowPlayingLayout.recordWidth(width: 718, height: 365, deck: 0, accessibilitySize: true) - 258.48) < 0.01)
    // A narrow window: the tracklist keeps its 300 points.
    #expect(NowPlayingLayout.recordWidth(width: 500, height: 300, deck: deck) == 172)
  }
}

@Suite struct TracklistTests {
  func queue(_ tracks: [Track], pos: Int, from href: String, shuffle: Bool = false, repeatMode: RepeatMode = .off) -> QueueState {
    var q = QueueState()
    q.queue = tracks
    q.order = Array(tracks.indices)
    q.pos = pos
    q.source = PlaySource(label: "Source", href: href)
    q.shuffle = shuffle
    q.repeatMode = repeatMode
    return q
  }

  func list(_ q: QueueState, _ transitions: PlaybackSettings.Transitions = .off, autoplay: Bool = false) -> Tracklist {
    Tracklist(queue: q, transitions: transitions, crossfade: 6, autoplay: autoplay)
  }

  @Test func readsAnAlbumInOrderLikeTheBackOfTheRecord() {
    let tracklist = list(queue(Demo.dummyTracks, pos: 1, from: "/albums/80"), .crossfade)
    let lines = tracklist.range.compactMap(tracklist.line(at:))
    #expect(lines.map(\.track.title) == ["Mysterons", "Sour Times", "Glory Box"])
    #expect(lines.map(\.state) == [.played, .playing, .upcoming])
    #expect(lines.map(\.number) == ["1-01", "1-02", "2-01"])  // two discs
    #expect(lines.map(\.joinBefore) == [.none, .continues, .continues])  // heard as one, never faded
    #expect(lines.allSatisfy { !$0.showsArtist && !$0.showsAlbum })
  }

  @Test func songsRadioAddsAfterAnAlbumAreNumberedByPlaceWithTheirArtistAndAlbum() {
    let tracks = Demo.mezzanineTracks + [Demo.dummyTracks[2]]  // Glory Box, disc 2 of another album
    let tracklist = list(queue(tracks, pos: 2, from: "/albums/70"))
    let lines = tracklist.range.compactMap(tracklist.line(at:))
    #expect(lines.map(\.number) == ["2", "4", "1"])  // Mezzanine is one disc; the radio song by its place
    #expect(lines.map(\.showsArtist) == [false, false, true])
    #expect(lines.map(\.showsAlbum) == [false, false, true])
  }

  @Test func numbersAMixFromTheSongPlayingAndNamesItsArtistsAndAlbums() {
    let mix = [Demo.mezzanineTracks[0], Demo.dummyTracks[0], Demo.protectionTracks[0]]
    let tracklist = list(queue(mix, pos: 0, from: "/mixes/vibes"), .crossfade)
    let lines = tracklist.range.compactMap(tracklist.line(at:))
    #expect(tracklist.range == 0..<3)
    #expect(lines.map(\.number) == ["", "1", "2"])
    #expect(lines.allSatisfy { $0.showsArtist })
    #expect(lines.map(\.showsAlbum) == [true, true, true])
    #expect(lines.map(\.joinBefore) == [.none, .crossfade(6), .crossfade(6)])
    #expect(!list(queue(Demo.dummyTracks, pos: 0, from: "/albums/80", shuffle: true)).albumInOrder)
  }

  @Test func showsTheNextMixInWordsAndThePairsAfterItAsDots() {
    let tracklist = list(queue(Demo.mezzanineTracks + Demo.protectionTracks, pos: 1, from: "/artists/7"), .dj)
    let lines = tracklist.range.compactMap(tracklist.line(at:))
    #expect(lines.map(\.track.title) == ["Angel", "Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(lines.map(\.joinBefore) == [.none, .continues, .dj, .djLater, .continues])
    #expect(lines.allSatisfy { !$0.showsArtist })  // one artist's songs
    #expect(list(queue(Demo.mezzanineTracks, pos: 0, from: "/mixes/vibes")).line(at: 2)?.joinBefore == Tracklist.Join.none)
  }

  @Test func saysWhatComesAfterTheLastSongAndHowMuchIsLeft() {
    let mix = [Demo.mezzanineTracks[0], Demo.dummyTracks[0], Demo.protectionTracks[0]]
    #expect(list(queue(mix, pos: 0, from: "/mixes/vibes")).end == "The queue ends here")
    #expect(list(queue(mix, pos: 0, from: "/mixes/vibes"), autoplay: true).end == "Then: more like these")
    #expect(list(queue(mix, pos: 0, from: "/mixes/vibes", repeatMode: .all), autoplay: true).end == "Then from the top")
    #expect(list(queue(mix, pos: 0, from: "/mixes/vibes")).left(elapsed: 100) == "3 songs · 18 min left")
    #expect(list(QueueState()).left(elapsed: 0) == nil)
    #expect(list(QueueState()).range.isEmpty)
  }
}
