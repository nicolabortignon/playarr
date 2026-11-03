import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/radio.test.ts.
struct RadioTests {
  @Test func asksForSongsLikeTheLastOnesWhenTheLastSongStarts() throws {
    var q = QueueState()
    q.playTracks([song(1), song(2)])
    #expect(Radio.continuation(for: q, autoplay: true) == nil)  // more to play yet
    q.jumpTo(1)
    let ask = try #require(Radio.continuation(for: q, autoplay: true))
    #expect(ask.seeds == ["rec-1", "rec-2"])
    #expect(ask.exclude == ["rec-1", "rec-2"])
  }

  @Test func seedsAreTheLastFivePlayed() throws {
    var q = QueueState()
    q.playTracks((1...8).map { song($0) }, startIndex: 7)
    #expect(try #require(Radio.continuation(for: q, autoplay: true)).seeds == ["rec-4", "rec-5", "rec-6", "rec-7", "rec-8"])
  }

  @Test func staysQuietWhenTurnedOffOrWhenTheQueueRepeats() {
    var q = QueueState()
    q.playTracks([song(1)])
    #expect(Radio.continuation(for: q, autoplay: false) == nil)
    q.repeatMode = .all
    #expect(Radio.continuation(for: q, autoplay: true) == nil)
  }

  @Test func startRadioPlaysFromTheSongsAlbum() {
    #expect(Radio.source(for: song(3, albumId: 9)) == PlaySource(label: "Song 3 radio", href: "/albums/9"))
  }
}
