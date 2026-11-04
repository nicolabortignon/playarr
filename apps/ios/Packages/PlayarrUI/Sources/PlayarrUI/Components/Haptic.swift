import SwiftUI

/// The app's taps, in one place, so the same kind of thing feels the same everywhere (the system turns them off
/// with Settings → Sounds & Haptics → System Haptics).
enum Haptic {
  /// Play or pause.
  static let playPause = SensoryFeedback.impact(weight: .medium)
  /// Something switched on or off: shuffle, repeat, lyrics, the side column, a favorite.
  static let toggle = SensoryFeedback.selection
  /// A song moved in the queue.
  static let reorder = SensoryFeedback.impact(weight: .light)
  /// Songs dropped on a playlist or the queue.
  static let dropped = SensoryFeedback.success

  static func toast(isError: Bool) -> SensoryFeedback {
    isError ? .error : .success
  }
}
