/// What the audio session tells the app (iOS: `AudioSessionController` turns notifications into these).
public enum SessionEvent: Sendable, Equatable {
  /// A call, Siri, an alarm: the system has stopped the audio.
  case interruptionBegan
  case interruptionEnded(shouldResume: Bool)
  /// Headphones unplugged, a Bluetooth speaker gone.
  case oldDeviceUnavailable
  /// The media server restarted: every audio object is gone.
  case mediaServicesReset
}

public enum SessionAction: Sendable, Equatable {
  case pause
  /// Play again from where it was (on a new epoch: the system stopped the engine).
  case resume
  /// Build a new engine and play on from where it was.
  case rebuild
  case none
}

/// How the player answers the session, as Apple's guidance and the web: pause for interruptions and resume after
/// them only when the system says so and music was playing; pause when headphones go away; rebuild after a reset.
public struct SessionPolicy: Sendable {
  private var resumeAfterInterruption = false

  public init() {}

  public mutating func action(for event: SessionEvent, playing: Bool) -> SessionAction {
    switch event {
    case .interruptionBegan:
      resumeAfterInterruption = playing
      return playing ? .pause : .none
    case .interruptionEnded(let shouldResume):
      defer { resumeAfterInterruption = false }
      return shouldResume && resumeAfterInterruption ? .resume : .none
    case .oldDeviceUnavailable:
      return playing ? .pause : .none
    case .mediaServicesReset:
      return .rebuild
    }
  }
}

/// The audio session as the Player needs it: iOS only (`AudioSessionController`); nil on the Mac and in tests.
@MainActor
public protocol AudioSessionControlling: AnyObject {
  /// Category `.playback`, active: plays with the screen locked and the silent switch on.
  func activate() throws
}
