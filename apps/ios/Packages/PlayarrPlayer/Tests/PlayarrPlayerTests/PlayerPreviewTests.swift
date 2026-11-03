import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct PlayerPreviewTests {
  /// Plays the preview's engine for `seconds`, ticking the Player as the app's clock would.
  private func listen(_ player: Player, for seconds: Double) async throws {
    let audition = try #require(player.previews?.engine)
    for _ in 0..<Int((seconds * 10).rounded()) {
      _ = try await audition.render(seconds: 0.1)
      player.tick()
    }
  }

  @Test func aPreviewPausesTheQueueWhereItIsAndLeavesItAlone() async throws {
    let player = try Player.testing()
    player.play([song(1), song(2), song(3)], startAt: 1)
    try await player.play(for: 1)
    let (queue, order, pos, at) = (player.queue.queue, player.queue.order, player.queue.pos, player.time)
    player.preview(song(9), from: 30)
    #expect(player.preview == Preview(recordingId: "rec-9", from: 30))
    #expect(!player.queue.playing)
    #expect(player.engine.state == .paused)
    #expect(player.queue.queue == queue && player.queue.order == order && player.queue.pos == pos)
    #expect(abs(player.time - at) < 0.15)
  }

  @Test func aPreviewStopsAfterEightSecondsAndTheQueueWaitsForTheEnd() async throws {
    let player = try Player.testing()
    player.play([song(1)])
    try await player.play(for: 0.5)
    player.preview(song(9), from: 30)
    try await listen(player, for: 7)
    #expect(player.preview != nil)
    try await listen(player, for: 1.5)
    #expect(player.preview == nil)
    #expect(player.previews?.engine == nil)
    #expect(!player.queue.playing)
    player.endPreviews()
    #expect(player.queue.playing)
    #expect(player.previews == nil)
  }

  @Test func anotherPreviewTakesOverAndTheQueueStillGoesOnAfter() throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.preview(song(9), from: 10)
    player.preview(song(9), from: 50)
    #expect(player.preview?.from == 50)
    player.endPreviews()
    #expect(player.queue.playing)
  }

  @Test func aPausedQueueStaysPaused() throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.setPlaying(false)
    player.preview(song(9), from: 10)
    player.endPreviews()
    #expect(!player.queue.playing)
  }

  @Test func theListenerTakingOverEndsThePreview() throws {
    let player = try Player.testing()
    player.play([song(1), song(2)])
    player.preview(song(9), from: 10)
    player.setPlaying(true)  // play, on the mini player or the lock screen
    #expect(player.preview == nil)
    #expect(player.previews == nil)
    #expect(player.queue.playing)
    player.preview(song(9), from: 10)
    player.next()  // Next plays the next song, as on the web
    #expect(player.previews == nil)
    #expect(player.queue.pos == 1)
    #expect(player.queue.playing)
  }

  @Test func closingAfterTheListenerPausedLeavesTheQueuePaused() throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.preview(song(9), from: 10)
    player.setPlaying(false)  // pause, on the lock screen
    player.endPreviews()
    #expect(!player.queue.playing)
  }

  @Test func switchingAccountsAwayEndsThePreview() throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.preview(song(9), from: 10)
    player.shutDown()
    #expect(player.previews == nil)
    #expect(player.preview == nil)
    #expect(!player.queue.playing)
  }

  @Test func aPreviewIsNeverReportedAsAPlay() async throws {
    let backend = FakeBackend()
    let player = try Player.testing(backend)
    player.preview(song(9, duration: 20), from: 0)
    try await listen(player, for: 8.5)
    player.endPreviews()
    try await Task.sleep(for: .milliseconds(50))
    #expect(backend.plays.withLock { $0.isEmpty })
    #expect(player.queue.pos == -1)
  }
}
