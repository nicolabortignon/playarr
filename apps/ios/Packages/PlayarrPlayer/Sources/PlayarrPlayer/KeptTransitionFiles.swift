import Foundation

/// A kept transition ready to play offline: its plan and lead/tail, and its files on this device.
public struct KeptTransitionFiles: Sendable, Equatable {
  public var transition: KeptTransition
  /// The transition's file.
  public var file: URL
  /// B's remainder, when the transition has one (played from `plan.bResume`, instead of B's own file).
  public var continuation: URL?

  public init(transition: KeptTransition, file: URL, continuation: URL?) {
    self.transition = transition
    self.file = file
    self.continuation = continuation
  }
}
