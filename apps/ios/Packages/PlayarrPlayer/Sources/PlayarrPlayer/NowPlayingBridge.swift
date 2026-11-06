import Foundation
import MediaPlayer
import PlayarrAPI

#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

/// What the lock screen and Control Center show.
public struct NowPlayingInfo: Equatable, Sendable {
  public var title: String
  public var artist: String
  public var album: String
  public var duration: Double
  public var elapsed: Double
  public var playing: Bool

  public init(track: Track, elapsed: Double, playing: Bool) {
    title = track.title
    artist = track.artistName
    album = track.albumTitle
    duration = track.duration
    self.elapsed = elapsed
    self.playing = playing
  }

  /// The system extrapolates the elapsed time from the rate: updated on play, pause, seek and song changes only.
  public var dictionary: [String: Any] {
    [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyArtist: artist,
      MPMediaItemPropertyAlbumTitle: album,
      MPMediaItemPropertyPlaybackDuration: duration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
  }
}

/// The lock screen, Control Center, headphone buttons and CarPlay-style remotes: Now Playing info out
/// (`MPNowPlayingInfoCenter`), commands in (`MPRemoteCommandCenter`), as the web's Media Session handlers.
@MainActor
public final class NowPlayingBridge {
  public struct Commands {
    public var play: () -> Void
    public var pause: () -> Void
    public var toggle: () -> Void
    public var next: () -> Void
    /// Restarts the song past 3 s, else the one before (the Player's rule).
    public var previous: () -> Void
    public var seek: (Double) -> Void
    /// Phase 6 wires this to favorites; nil leaves the like button off.
    public var like: (() -> Void)?

    public init(
      play: @escaping () -> Void, pause: @escaping () -> Void, toggle: @escaping () -> Void, next: @escaping () -> Void,
      previous: @escaping () -> Void, seek: @escaping (Double) -> Void, like: (() -> Void)? = nil
    ) {
      self.play = play
      self.pause = pause
      self.toggle = toggle
      self.next = next
      self.previous = previous
      self.seek = seek
      self.like = like
    }
  }

  /// Album art at this size (px) from the server's `?size=`.
  nonisolated public static let artworkSize = 512

  private let commands: Commands
  private let artwork: @Sendable (Track) async -> Data?
  private var info: NowPlayingInfo?
  private var artworkTrack: Int?
  private var art: MPMediaItemArtwork?

  public init(commands: Commands, artwork: @escaping @Sendable (Track) async -> Data?) {
    self.commands = commands
    self.artwork = artwork
    register()
  }

  public func update(track: Track?, elapsed: Double, playing: Bool) {
    guard let track else {
      info = nil
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      return
    }
    let next = NowPlayingInfo(track: track, elapsed: elapsed, playing: playing)
    guard next != info || artworkTrack != track.id else { return }
    info = next
    if artworkTrack != track.id {
      artworkTrack = track.id
      art = nil
      Task { [weak self, artwork] in
        guard let data = await artwork(track) else { return }
        self?.show(data, for: track.id)
      }
    }
    publish()
  }

  /// Whether the song playing is a favorite: the like command shows it (filled) and says what a press does.
  public func setLiked(_ liked: Bool) {
    let like = MPRemoteCommandCenter.shared().likeCommand
    like.isActive = liked
    like.localizedTitle = liked ? "Remove from Favorites" : "Add to Favorites"
  }

  /// Lets go of the remote commands (the next player registers its own).
  public func unregister() {
    let center = MPRemoteCommandCenter.shared()
    let commands: [MPRemoteCommand] = [
      center.playCommand, center.pauseCommand, center.togglePlayPauseCommand, center.nextTrackCommand,
      center.previousTrackCommand, center.changePlaybackPositionCommand, center.likeCommand, center.stopCommand,
    ]
    for command in commands { command.removeTarget(nil) }
  }

  private func show(_ data: Data, for trackId: Int) {
    guard artworkTrack == trackId else { return }
    art = Self.artwork(data)
    publish()
  }

  /// Made outside the main actor: MediaPlayer asks for the image on its own queue, and a closure made in
  /// here would be the main actor's, trapping when called there.
  nonisolated private static func artwork(_ data: Data) -> MPMediaItemArtwork {
    MPMediaItemArtwork(boundsSize: CGSize(width: artworkSize, height: artworkSize)) { _ in image(data) }
  }

  private func publish() {
    guard var dictionary = info?.dictionary else { return }
    if let art { dictionary[MPMediaItemPropertyArtwork] = art }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = dictionary
  }

  #if canImport(UIKit)
    nonisolated private static func image(_ data: Data) -> UIImage { UIImage(data: data) ?? UIImage() }
  #else
    nonisolated private static func image(_ data: Data) -> NSImage { NSImage(data: data) ?? NSImage() }
  #endif

  private func register() {
    let center = MPRemoteCommandCenter.shared()
    // Remote command handlers are called on the main thread.
    center.playCommand.addTarget { [weak self] _ in self?.run { $0.play() } ?? .commandFailed }
    center.pauseCommand.addTarget { [weak self] _ in self?.run { $0.pause() } ?? .commandFailed }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.run { $0.toggle() } ?? .commandFailed }
    center.nextTrackCommand.addTarget { [weak self] _ in self?.run { $0.next() } ?? .commandFailed }
    center.previousTrackCommand.addTarget { [weak self] _ in self?.run { $0.previous() } ?? .commandFailed }
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime else { return .commandFailed }
      return self?.run { $0.seek(position) } ?? .commandFailed
    }
    center.likeCommand.isEnabled = commands.like != nil
    if commands.like != nil {
      center.likeCommand.addTarget { [weak self] _ in self?.run { $0.like?() } ?? .commandFailed }
    }
    center.stopCommand.addTarget { [weak self] _ in self?.run { $0.pause() } ?? .commandFailed }
  }

  nonisolated private func run(_ action: @MainActor (Commands) -> Void) -> MPRemoteCommandHandlerStatus {
    MainActor.assumeIsolated { action(commands) }
    return .success
  }
}
