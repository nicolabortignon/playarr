import Foundation
import MediaPlayer
import Testing
@testable import PlayarrPlayer

@MainActor @Suite(.serialized) struct NowPlayingArtworkTests {
  /// MediaPlayer asks for the artwork on its own queue: answering it must not need the main actor (build 509
  /// crashed on launch, the song's artwork asked for off the main thread).
  @Test func handsTheArtworkOverOnAnyQueue() async throws {
    let bridge = NowPlayingBridge(
      commands: NowPlayingBridge.Commands(play: {}, pause: {}, toggle: {}, next: {}, previous: {}, seek: { _ in }),
      artwork: { _ in Data([1, 2, 3]) })
    bridge.update(track: song(1), elapsed: 0, playing: true)
    var published: MPMediaItemArtwork?
    for _ in 0..<200 where published == nil {
      published = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork] as? MPMediaItemArtwork
      if published == nil { try await Task.sleep(for: .milliseconds(10)) }
    }
    nonisolated(unsafe) let artwork = try #require(published)
    let answered = await Task.detached { artwork.image(at: CGSize(width: 64, height: 64)) != nil }.value
    #expect(answered)
    bridge.update(track: nil, elapsed: 0, playing: false)
  }
}
