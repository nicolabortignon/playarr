import PlayarrAPI

/// Tells the listener a request is ready when the app isn't on screen (a local notification on iOS).
@MainActor public protocol RequestNotifier: AnyObject {
  /// The listener asked for an album: the moment to ask for permission, once.
  func requested()
  /// Requests became playable.
  func landed(_ requests: [AlbumRequest])
}
