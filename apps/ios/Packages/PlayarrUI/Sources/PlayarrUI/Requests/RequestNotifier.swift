import PlayarrAPI

/// Tells the listener about their requests when the app isn't on screen (a local notification on iOS): one of theirs is
/// ready, or, for an admin, someone's request waits for an answer.
@MainActor public protocol RequestNotifier: AnyObject {
  /// The listener asked for an album, or an admin answered a request: the moment to ask for permission, once.
  func requested()
  /// Requests the listener asked for became playable.
  func landed(_ requests: [AlbumRequest])
  /// Requests someone else asked for wait for the listener's answer (an admin's).
  func waiting(_ requests: [AlbumRequest])
}
