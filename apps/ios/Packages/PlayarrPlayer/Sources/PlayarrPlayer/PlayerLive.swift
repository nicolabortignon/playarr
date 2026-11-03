import Foundation
import PlayarrAPI

#if canImport(UIKit)
  import UIKit
#endif

extension Player {
  /// The player as the app runs it: lock-screen controls and Now Playing, the audio session (iOS), the network for
  /// keeping ahead, offline playback and downloads, downloads on the app's background session, its 10 Hz clock, and a
  /// last report when the app is closed. `like` is what the lock screen's like command does with the song playing (the
  /// app toggles it in favorites); nil leaves the command off.
  public static func live(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    transport: any DownloadTransport = URLSessionTransport.background,
    like: (@MainActor (Track) -> Void)? = nil
  ) throws -> Player {
    let player = try Player(backend: backend, directory: directory, settings: settings, transport: transport)
    player.nowPlaying = NowPlayingBridge(
      commands: NowPlayingBridge.Commands(
        play: { [weak player] in player?.setPlaying(true) },
        pause: { [weak player] in player?.setPlaying(false) },
        toggle: { [weak player] in player?.togglePlay() },
        next: { [weak player] in player?.next() },
        previous: { [weak player] in player?.previous() },
        seek: { [weak player] in player?.seek(to: $0) },
        like: like.map { like in
          { [weak player] in
            guard let track = player?.queue.currentTrack else { return }
            like(track)
          }
        }),
      artwork: { await backend.artwork($0, size: NowPlayingBridge.artworkSize) })
    let network = NetworkMonitor()
    player.network = { network.kind }
    network.onChange = { [weak player] in player?.networkChanged($0) }
    #if os(iOS)
      player.session = AudioSessionController { [weak player] in player?.handle($0) }
    #endif
    #if canImport(UIKit)
      NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.appWillTerminate() }
      }
      // Going to the background (inactive comes first, while new tasks still start at once): downloads hand the
      // system more songs, so they go on with the app closed.
      NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.downloads.appMovedToBackground() }
      }
      NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.downloads.appBecameActive() }
      }
    #endif
    player.start()
    return player
  }
}
