import SwiftUI

/// The app's taps, in one place, so the same kind of thing feels the same everywhere (plan 7 §7; the system turns them
/// off with Settings → Sounds & Haptics → System Haptics). Four kinds: a toggle, a success, a selection tick and a
/// warning; play and pause have a firmer tap of their own, and a toast saying something failed the system's error.
enum Haptic {
  /// Play or pause.
  static let playPause = SensoryFeedback.impact(weight: .medium)
  /// Something switched on or off: shuffle, repeat, lyrics, the side column, a favorite.
  static let toggle = SensoryFeedback.selection
  /// It worked: a download finished, a request sent, Feeling lucky's songs playing (and every toast that isn't an error
  /// or a removal).
  static let success = SensoryFeedback.success
  /// A tick: a song landing in its new place, scrubbing past a section, a new roll of Rediscover's dice.
  static let selection = SensoryFeedback.selection
  /// Something taken out, alongside the toast with its Undo ("Removed “Teardrop” from the queue").
  static let warning = SensoryFeedback.warning
  /// A song moved in the queue or a playlist: a selection tick.
  static let reorder = selection
  /// Songs dropped on a playlist or the queue.
  static let dropped = SensoryFeedback.success

  static func toast(isError: Bool) -> SensoryFeedback {
    isError ? .error : .success
  }

  /// A toast as it shows: a removal with its Undo warns, an error is an error, anything else a success.
  static func toast(_ toast: ToastCenter.Toast) -> SensoryFeedback {
    toast.removal ? warning : self.toast(isError: toast.tone == .error)
  }
}
