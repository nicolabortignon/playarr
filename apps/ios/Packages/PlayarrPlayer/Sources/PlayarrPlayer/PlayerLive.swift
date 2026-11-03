import Foundation

#if canImport(UIKit)
  import UIKit
#endif

extension Player {
  /// The player as the app runs it: lock-screen controls and Now Playing, the audio session (iOS), the network for
  /// prefetching, its 10 Hz clock, and a last report when the app is closed.
  public static func live(backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings()) throws -> Player {
    let player = try Player(backend: backend, directory: directory, settings: settings)
    player.nowPlaying = NowPlayingBridge(
      commands: NowPlayingBridge.Commands(
        play: { [weak player] in player?.setPlaying(true) },
        pause: { [weak player] in player?.setPlaying(false) },
        toggle: { [weak player] in player?.togglePlay() },
        next: { [weak player] in player?.next() },
        previous: { [weak player] in player?.previous() },
        seek: { [weak player] in player?.seek(to: $0) }),
      artwork: { await backend.artwork($0, size: NowPlayingBridge.artworkSize) })
    let network = NetworkMonitor()
    player.network = { network.kind }
    #if os(iOS)
      player.session = AudioSessionController { [weak player] in player?.handle($0) }
    #endif
    #if canImport(UIKit)
      NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.appWillTerminate() }
      }
    #endif
    player.start()
    return player
  }
}
