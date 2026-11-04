import SwiftUI

/// The web's keyboard shortcuts (apps/web/src/player/useKeyboardShortcuts.ts), as menu commands: with a hardware
/// keyboard they work anywhere in the app except while typing, and show when ⌘ is held and in the iPad's menu bar.
public enum KeyCommand: String, CaseIterable, Sendable {
  case playPause, seekBack, seekForward, previous, next, volumeUp, volumeDown, mute, shuffle, favorite, search

  /// The playback menu's commands, in the web's order; Search has a menu of its own.
  public static let playback: [KeyCommand] = [.playPause, .seekBack, .seekForward, .previous, .next, .volumeUp, .volumeDown, .mute, .shuffle, .favorite]

  /// The menu item, in the words of the web's list (apps/web/src/components/PlaybackPanel.tsx `SHORTCUTS`).
  public var title: String {
    switch self {
    case .playPause: "Play or pause"
    case .seekBack: "Back 10 seconds"
    case .seekForward: "Ahead 10 seconds"
    case .previous: "Previous song"
    case .next: "Next song"
    case .volumeUp: "Volume up"
    case .volumeDown: "Volume down"
    case .mute: "Mute or unmute"
    case .shuffle: "Shuffle on or off"
    case .favorite: "Add the song playing to Favorites, or remove it"
    case .search: "Search"
    }
  }

  public var key: KeyEquivalent {
    switch self {
    case .playPause: .space
    case .seekBack, .previous: .leftArrow
    case .seekForward, .next: .rightArrow
    case .volumeUp: .upArrow
    case .volumeDown: .downArrow
    case .mute: "m"
    case .shuffle: "s"
    case .favorite: "l"
    case .search: "/"
    }
  }

  public var modifiers: EventModifiers {
    self == .previous || self == .next ? .shift : []
  }
}
