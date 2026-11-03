import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/store.test.ts, plus the rules of store.ts that test didn't cover.
struct QueueStateTests {
  let songs = [song(1), song(2), song(3)]

  @Test func startsOnAutoAndKeepsWhatIsPickedWithTheQueue() throws {
    var q = QueueState()
    #expect(q.mixMode == .auto)
    q.playTracks([song(1), song(2)])
    q.mixMode = .party
    let saved = try JSONDecoder().decode(QueueState.self, from: JSONEncoder().encode(q))
    #expect(saved.mixMode == .party)
  }

  @Test func goesBackToAutoWhenSomethingNewIsPlayed() {
    var q = QueueState()
    q.mixMode = .off
    q.playTracks([song(3)])
    #expect(q.mixMode == .auto)
  }

  @Test func staysAsPickedWhenSongsAreAddedToTheQueue() {
    var q = QueueState()
    q.playTracks([song(1)])
    q.mixMode = .party
    q.addToQueue([song(2)])
    q.playNext([song(3)])
    #expect(q.mixMode == .party)
  }

  @Test func startAtIsAskedOnceAndNeverSaved() throws {
    var q = QueueState()
    q.playTracks([song(1), song(2)], at: 30)
    #expect(q.startAt == 30)
    q.jumpTo(1, at: 12)
    #expect(q.startAt == 12)
    let json = try #require(String(data: JSONEncoder().encode(q), encoding: .utf8))
    #expect(!json.contains("startAt"))
    #expect(!json.contains("playing"))
    #expect(!json.contains("restartToken"))
    q.jumpTo(0)
    #expect(q.startAt == nil)
  }

  @Test func savesWhatTheWebSaves() throws {
    var q = QueueState()
    q.playTracks(songs, source: PlaySource(label: "Album 1", href: "/albums/1"))
    q.repeatMode = .all
    q.resumeAt = 42
    let saved = try JSONDecoder().decode(QueueState.self, from: JSONEncoder().encode(q))
    #expect(saved.queue == q.queue)
    #expect(saved.order == q.order)
    #expect(saved.pos == q.pos)
    #expect(saved.repeatMode == .all)
    #expect(saved.resumeAt == 42)
    #expect(saved.source == q.source)
    #expect(saved.playing == false)  // a relaunch never starts playing by itself
  }

  @Test func anUnknownMixModePlaysAsAuto() throws {
    let json = #"{"queue":[],"order":[],"pos":-1,"mixMode":"club"}"#
    let q = try JSONDecoder().decode(QueueState.self, from: Data(json.utf8))
    #expect(q.mixMode == .auto)
  }

  @Test func theSongANextPressGoesTo() {
    var q = QueueState()
    q.queue = songs
    q.order = [0, 1, 2]
    q.pos = 0
    #expect(q.nextByPress?.id == 2)
    q.pos = 2
    #expect(q.nextByPress == nil)
    q.repeatMode = .all
    #expect(q.nextByPress?.id == 1)
    q.pos = 1
    q.repeatMode = .one
    #expect(q.nextByPress?.id == 3)  // Next leaves the song
    q.order = [2, 0, 1]
    q.pos = 0
    q.repeatMode = .off
    #expect(q.nextByPress?.id == 1)  // the play order, not the queue's
    q.pos = 2
    q.repeatMode = .all
    #expect(q.nextByPress?.id == 3)
  }

  @Test func theSongThatPlaysNextOnItsOwn() {
    var q = QueueState()
    q.queue = songs
    q.order = [0, 1, 2]
    q.pos = 1
    #expect(q.upNext?.id == 3)
    q.pos = 2
    #expect(q.upNext == nil)
    q.repeatMode = .all
    #expect(q.upNext?.id == 1)
    q.repeatMode = .one
    #expect(q.upNext == nil)
    q.repeatMode = .all
    q.queue = [song(1)]
    q.order = [0]
    q.pos = 0
    #expect(q.upNext == nil)  // a queue of one with repeat all restarts instead
  }

  @Test func playNextGoesRightAfterTheCurrentSongAndAddToQueueAtTheEnd() {
    var q = QueueState()
    q.playTracks(songs)
    q.playNext([song(9)])
    #expect(q.order == [0, 3, 1, 2])
    q.addToQueue([song(8)])
    #expect(q.order == [0, 3, 1, 2, 4])
    #expect(q.queue.map(\.id) == [1, 2, 3, 9, 8])
  }

  @Test func addingToAnEmptyQueuePlaysIt() {
    var q = QueueState()
    q.addToQueue([song(5)])
    #expect(q.pos == 0)
    #expect(q.playing)
    #expect(q.currentTrack?.id == 5)
  }

  @Test func removingNeverRemovesTheCurrentSongAndKeepsIndices() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 1)
    q.removeAt(1)
    #expect(q.order == [0, 1, 2])
    q.removeAt(0)
    #expect(q.order == [1, 2])
    #expect(q.pos == 0)
    #expect(q.currentTrack?.id == 2)
    #expect(q.queue.count == 3)
  }

  @Test func movingKeepsTheCurrentSongCurrent() {
    var q = QueueState()
    q.playTracks(songs)
    q.move(from: 0, to: 2)
    #expect(q.order == [1, 2, 0])
    #expect(q.pos == 2)
    #expect(q.currentTrack?.id == 1)
  }

  @Test func setAndClearUpcoming() {
    var q = QueueState()
    q.playTracks(songs)
    q.setUpcoming([2, 0, 7, 1])
    #expect(q.order == [0, 2, 1])  // never the current song, never an unknown index
    q.clearUpcoming()
    #expect(q.order == [0])
  }

  @Test func theEndOfTheQueueStopsOnTheLastSong() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 2)
    let token = q.restartToken
    q.next(auto: true)
    #expect(q.pos == 2)
    #expect(!q.playing)
    #expect(q.restartToken == token + 1)
  }

  @Test func repeatOneRestartsWhenTheSongEndsButNextLeavesIt() {
    var q = QueueState()
    q.playTracks(songs)
    q.repeatMode = .one
    let token = q.restartToken
    q.next(auto: true)
    #expect(q.pos == 0)
    #expect(q.restartToken == token + 1)
    q.next()
    #expect(q.pos == 1)
  }

  @Test func repeatAllGoesRoundToTheFirst() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 2)
    q.repeatMode = .all
    q.next(auto: true)
    #expect(q.pos == 0)
    #expect(q.playing)
  }

  @Test func previousRestartsPastThreeSecondsElseGoesBack() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 1)
    let token = q.restartToken
    q.prev(currentTime: 3.5)
    #expect(q.pos == 1)
    #expect(q.restartToken == token + 1)
    q.prev(currentTime: 2)
    #expect(q.pos == 0)
    q.prev(currentTime: 0)
    #expect(q.pos == 0)  // the first song restarts
    #expect(q.restartToken == token + 2)
    q.repeatMode = .all
    q.prev(currentTime: 0)
    #expect(q.pos == 2)  // round to the last
  }

  @Test func shuffleKeepsHistoryAndShufflesOnlyWhatIsUpcoming() {
    var q = QueueState()
    q.playTracks((1...10).map { song($0) }, startIndex: 3)
    var rng = SeededRandom(7)
    q.toggleShuffle(using: &rng)
    #expect(q.shuffle)
    #expect(Array(q.order.prefix(4)) == [0, 1, 2, 3])
    #expect(Set(q.order.dropFirst(4)) == Set(4...9))
    #expect(q.pos == 3)
    q.next()
    let current = q.order[q.pos]
    q.toggleShuffle(using: &rng)
    #expect(!q.shuffle)
    #expect(q.order == Array(0...9))
    #expect(q.order[q.pos] == current)
  }

  @Test func shufflePlayStartsAnywhereAndPlaysEverySongOnce() {
    var q = QueueState()
    var rng = SeededRandom(1)
    q.playTracks((1...10).map { song($0) }, shuffle: true, using: &rng)
    #expect(q.pos == 0)
    #expect(q.shuffle)
    #expect(Set(q.order) == Set(0...9))
  }

  @Test func repeatCyclesOffAllOne() {
    var q = QueueState()
    q.cycleRepeat()
    #expect(q.repeatMode == .all)
    q.cycleRepeat()
    #expect(q.repeatMode == .one)
    q.cycleRepeat()
    #expect(q.repeatMode == .off)
  }

  @Test func volumeIsClampedAndUnmutes() {
    var q = QueueState()
    q.muted = true
    q.setVolume(1.5)
    #expect(q.volume == 1)
    #expect(!q.muted)
    q.setVolume(-1)
    #expect(q.volume == 0)
  }

  @Test func toggleNeedsASong() {
    var q = QueueState()
    q.toggle()
    #expect(!q.playing)
    q.playTracks(songs)
    q.toggle()
    #expect(!q.playing)
  }

  @Test func aDamagedFileStartsEmpty() throws {
    let json = #"{"queue":[],"order":[3],"pos":0}"#
    let q = try JSONDecoder().decode(QueueState.self, from: Data(json.utf8))
    #expect(q == QueueState())
  }
}
