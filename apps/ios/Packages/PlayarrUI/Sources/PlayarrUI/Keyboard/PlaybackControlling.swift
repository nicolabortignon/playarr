import PlayarrAPI
import PlayarrPlayer

/// What the keyboard drives: the player, or a fake in tests.
@MainActor
public protocol PlaybackControlling: AnyObject {
  /// The song playing or paused, if any.
  var song: Track? { get }
  var time: Double { get }
  var duration: Double { get }
  /// The app's own volume, 0 to 1.
  var masterVolume: Double { get }
  func togglePlay()
  func seek(to seconds: Double)
  func next()
  func previous()
  func setVolume(_ volume: Double)
  func toggleMute()
  func toggleShuffle()
}

extension Player: PlaybackControlling {
  public var song: Track? { queue.currentTrack }
  public var masterVolume: Double { queue.volume }
}
