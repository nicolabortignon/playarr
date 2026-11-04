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

  @Test func givesTheCoverWhatTheTracklistCanSpare() {
    #expect(NowPlayingLayout.coverSide(width: 874, height: 402) == 370)  // iPhone 17 Pro: as tall as it can be
    #expect(abs(NowPlayingLayout.coverSide(width: 667, height: 375) - 306.82) < 0.01)  // iPhone SE: bound by width
    #expect(abs(NowPlayingLayout.coverSide(width: 874, height: 402, accessibilitySize: true) - 314.64) < 0.01)
    #expect(NowPlayingLayout.coverSide(width: 500, height: 300) == 172)  // the tracklist keeps its 300 points
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
