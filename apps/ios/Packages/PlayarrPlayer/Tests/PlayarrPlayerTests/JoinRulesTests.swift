import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/decks.test.ts.
struct JoinRulesTests {
  @Test func neverFadesWithinAnAlbumPlayedInOrderNorForMoreThanAThird() {
    #expect(JoinRules.continues(song(1), song(2)))
    #expect(JoinRules.continues(song(9, disc: 1), song(1, disc: 2)))
    #expect(!JoinRules.continues(song(1), song(3)))
    #expect(JoinRules.fadeSeconds(song(1), song(2), crossfade: 6) == 0)
    #expect(JoinRules.fadeSeconds(song(1), song(3), crossfade: 6) == 6)
    #expect(JoinRules.fadeSeconds(song(1), song(3, duration: 9), crossfade: 6) == 3)
    #expect(JoinRules.fadeSeconds(song(1), song(3), crossfade: 0) == 0)
  }

  @Test func turnsSongsByTheirOwnLevelOrTheAlbumsWithinAnAlbum() {
    var q = QueueState()
    q.queue = [song(1), song(2), song(7, albumId: 2)]
    q.order = [0, 1, 2]
    q.pos = 0
    let level = TrackLevel(track: -6, album: -3)
    #expect(JoinRules.levelDb(song(1), level, in: q) == -3)
    #expect(JoinRules.levelDb(q.queue[2], level, in: q) == -6)
    #expect(JoinRules.levelDb(song(1), TrackLevel(track: -6), in: q) == -6)
  }
}
