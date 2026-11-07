import Foundation
import Observation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct PlayerTests {
  @Test func restoresTheSavedQueuePausedWhereItWas() async throws {
    let directory = temporaryDirectory()
    var saved = QueueState()
    saved.playTracks([song(1), song(2)], startIndex: 1)
    saved.resumeAt = 42
    JSONFile<QueueState>(directory.appending(path: "queue.json")).write(saved)
    let player = try Player.testing(directory: directory)
    #expect(player.queue.currentTrack?.id == 2)
    #expect(!player.queue.playing)
    #expect(player.engine.currentItem?.startAt == 42)
    #expect(player.time == 42)
  }

  @Test func savesTheQueueAsItChanges() throws {
    let directory = temporaryDirectory()
    let player = try Player.testing(directory: directory)
    player.play([song(1), song(2), song(3)], startAt: 1)
    let saved = try #require(JSONFile<QueueState>(directory.appending(path: "queue.json")).read())
    #expect(saved.pos == 1)
    #expect(saved.queue.count == 3)
  }

  @Test func savesWhereItIsEveryFiveSecondsWithoutRedrawingTheQueue() async throws {
    // A menu open on a page closes when the page redraws: nothing shows where to resume, so the views of the queue
    // aren't told when it's saved.
    let directory = temporaryDirectory()
    let player = try Player.testing(directory: directory)
    player.play([song(1), song(2)])
    try await player.play(for: 1.5)
    let redrawn = Mutex(false)
    withObservationTracking { _ = player.queue } onChange: { redrawn.withLock { $0 = true } }
    player.tick(now: Date() + 6)
    #expect(!redrawn.withLock { $0 })
    let saved = try #require(JSONFile<QueueState>(directory.appending(path: "queue.json")).read())
    #expect(saved.resumeAt > 1)
    #expect(saved.resumeAt == player.time)
  }

  @Test func anAlbumInOrderNeverFadesOtherSongsDo() throws {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    settings.transitions = .crossfade
    settings.crossfade = 6
    let player = try Player.testing(settings: settings)
    player.play([song(1), song(2), song(7, albumId: 2)])
    #expect(player.upcoming?.join == .crossfade(seconds: 0))
    player.next()
    #expect(player.upcoming?.join == .crossfade(seconds: 6))
  }

  @Test func repeatOnePlaysTheSongAgainWithoutAGap() throws {
    let player = try Player.testing()
    player.play([song(1), song(2)])
    player.cycleRepeat()
    player.cycleRepeat()
    #expect(player.queue.repeatMode == .one)
    #expect(player.upcoming?.index == 0)
    #expect(player.upcoming?.join == .crossfade(seconds: 0))
  }

  @Test func aJoinMovesTheQueueOnAndReportsThePlay() async throws {
    let backend = FakeBackend()
    let player = try Player.testing(backend)
    player.play([song(1, duration: 2), song(2, duration: 2)])
    try await player.play(for: 2.6)
    #expect(player.queue.pos == 1)
    #expect(player.time > 0.3 && player.time < 0.9)
    await eventually { !backend.plays.withLock { $0.isEmpty } }
    #expect(backend.plays.withLock { $0.map(\.trackId) } == [1])
    #expect(backend.plays.withLock { $0.first?.skipped } == false)
  }

  @Test func theEndOfTheQueueStopsOnTheLastSongAtItsStart() async throws {
    let player = try Player.testing()
    player.play([song(1, duration: 1)])
    try await player.play(for: 1.5)
    #expect(!player.queue.playing)
    #expect(player.queue.pos == 0)
    #expect(player.engine.currentItem?.startAt == 0)
  }

  @Test func previousRestartsPastThreeSecondsElseGoesBack() async throws {
    let player = try Player.testing()
    player.play([song(1), song(2)], startAt: 1)
    try await player.play(for: 3.5)
    player.previous()
    #expect(player.queue.pos == 1)
    #expect(player.time == 0)
    player.previous()
    #expect(player.queue.pos == 0)
  }

  @Test func theSleepTimersEndOfSongMovesOnAndPauses() async throws {
    let player = try Player.testing()
    player.play([song(1, duration: 1), song(2, duration: 1)])
    player.sleepAtEndOfSong()
    #expect(player.upcoming == nil)
    try await player.play(for: 1.5)
    #expect(player.queue.pos == 1)
    #expect(!player.queue.playing)
    #expect(!player.sleep.endOfSong)
  }

  @Test func theSleepTimerFadesOverItsLastTwentySecondsThenStops() throws {
    let player = try Player.testing()
    player.play([song(1)])
    let start = Date()
    player.sleep.sleep(minutes: 1, from: start)
    player.tick(now: start + 50)
    #expect(abs(player.engine.masterGain - 0.5) < 0.01)
    player.tick(now: start + 60)
    #expect(!player.queue.playing)
    #expect(player.notice?.text == "Sleep timer: music stopped")
  }

  @Test func radioCarriesOnWhenTheLastSongStarts() async throws {
    let backend = FakeBackend()
    backend.radioAnswer.withLock { $0 = [song(10), song(11)] }
    let player = try Player.testing(backend)
    player.play([song(1), song(2)])
    #expect(backend.radioAsks.withLock { $0.isEmpty })
    player.next()
    await eventually { player.queue.queue.count == 4 }
    #expect(player.queue.queue.map(\.id) == [1, 2, 10, 11])
    #expect(backend.radioAsks.withLock { $0.first?.seeds } == ["rec-1", "rec-2"])
  }

  @Test func clearingUpNextDoesntStartARadio() async throws {
    // The web asks for more only when the last song starts (radio.ts), so Clear leaves the queue ending here.
    let backend = FakeBackend()
    backend.radioAnswer.withLock { $0 = [song(10), song(11)] }
    let player = try Player.testing(backend)
    player.play([song(1), song(2), song(3)])
    player.clearUpcoming()
    try await Task.sleep(for: .milliseconds(50))
    #expect(backend.radioAsks.withLock { $0.isEmpty })
    #expect(player.queue.queue.count == 3)
    #expect(player.queue.upcoming(5).isEmpty)
  }

  @Test func evenVolumeUsesTheServersLevels() async throws {
    let backend = FakeBackend()
    backend.levelTable.withLock { $0 = ["rec-1": TrackLevel(track: -5, album: -3), "rec-2": TrackLevel(track: 4, album: -3)] }
    let player = try Player.testing(backend)
    player.play([song(1), song(2)])
    await eventually { player.upcoming?.item.gainDb == -3 }
    #expect(player.upcoming?.item.gainDb == -3)  // within the album, in order: the album's level
    player.settings.levelVolume = false
    player.next()
    #expect(player.engine.currentItem?.gainDb == 0)
  }

  @Test func aSongThatFailsShowsTheWebsMessageAndPauses() async throws {
    struct Broken: PCMSource {
      func read(maxFrames: Int) async throws -> PCMBlock? { throw PlaybackError.keptBreakingOff }
      func close() async {}
    }
    let player = try Player(
      backend: FakeBackend(), directory: temporaryDirectory(), settings: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) }, makeSource: { _, _ in Broken() })
    player.play([song(1)])
    await player.engine.settle()
    #expect(player.error == "The song kept stopping loading: the Playarr server or the network is too busy")
    #expect(!player.queue.playing)
  }

  @Test func headphonesUnpluggedPause() async throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.handle(.oldDeviceUnavailable)
    #expect(!player.queue.playing)
  }

  @Test func shutsDownWhenItsAccountIsSwitchedAway() throws {
    let directory = temporaryDirectory()
    let player = try Player.testing(directory: directory)
    player.play([song(1), song(2)])
    player.shutDown()
    #expect(!player.queue.playing)
    #expect(player.engine.state == .idle)
    let saved = try #require(JSONFile<QueueState>(directory.appending(path: "queue.json")).read())
    #expect(saved.queue.count == 2)
    #expect(saved.pos == 0)
  }
}
