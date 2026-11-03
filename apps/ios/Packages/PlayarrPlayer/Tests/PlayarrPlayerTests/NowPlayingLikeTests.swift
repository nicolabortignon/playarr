import Foundation
import MediaPlayer
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor @Suite(.serialized) struct NowPlayingLikeTests {
  private func bridge(like: (() -> Void)?) -> NowPlayingBridge {
    NowPlayingBridge(
      commands: NowPlayingBridge.Commands(play: {}, pause: {}, toggle: {}, next: {}, previous: {}, seek: { _ in }, like: like),
      artwork: { _ in nil })
  }

  @Test func showsWhetherTheSongIsAFavorite() {
    let bridge = bridge(like: {})
    let like = MPRemoteCommandCenter.shared().likeCommand
    #expect(like.isEnabled)
    bridge.setLiked(true)
    #expect(like.isActive)
    #expect(like.localizedTitle == "Remove from favorites")
    bridge.setLiked(false)
    #expect(!like.isActive)
    #expect(like.localizedTitle == "Add to favorites")
  }
}
