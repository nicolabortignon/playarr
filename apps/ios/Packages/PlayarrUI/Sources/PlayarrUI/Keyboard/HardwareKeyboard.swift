import Foundation
import GameController
import Observation

/// Whether a hardware keyboard is attached, asked again as one connects or disconnects (`changes`): Settings → Playback
/// lists the keyboard shortcuts only where there's a keyboard to press them (docs/design.md, "Patterns"). iPadOS's own
/// overlay, held ⌘, lists the same commands by itself.
@MainActor @Observable
final class HardwareKeyboard {
  private(set) var attached: Bool
  @ObservationIgnored private let probe: @MainActor () -> Bool

  /// What announces a keyboard connecting or disconnecting.
  nonisolated static let changes: [Notification.Name] = [.GCKeyboardDidConnect, .GCKeyboardDidDisconnect]

  /// `probe`: whether one is attached now (GameController's keyboards, by default).
  init(probe: @escaping @MainActor () -> Bool = { GCKeyboard.coalesced != nil }) {
    self.probe = probe
    attached = probe()
  }

  /// A keyboard connected or disconnected (`changes`): asks again, as another may still be there.
  func recheck() {
    attached = probe()
  }

  /// The shortcuts are listed where they work (an iPad, whose menu bar and ⌘ hold them) and only while a keyboard is
  /// attached to press them.
  static func showsShortcuts(onPad: Bool, attached: Bool) -> Bool {
    onPad && attached
  }
}
