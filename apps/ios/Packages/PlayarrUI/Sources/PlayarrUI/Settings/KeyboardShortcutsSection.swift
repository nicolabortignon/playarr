import SwiftUI

/// Settings → Playback → Keyboard shortcuts (apps/web/src/components/PlaybackPanel.tsx `SHORTCUTS`), shown on an
/// iPad, where a keyboard can be attached.
struct KeyboardShortcutsSection: View {
  /// The web's list: keys (combinations, each of keys) and what they do.
  static let rows: [(keys: [[String]], action: String)] = [
    ([["Space"]], "Play or pause"),
    ([["←"], ["→"]], "Back or ahead 10 seconds"),
    ([["Shift", "←"], ["Shift", "→"]], "Previous or next song"),
    ([["↑"], ["↓"]], "Volume up or down"),
    ([["M"]], "Mute or unmute"),
    ([["S"]], "Shuffle on or off"),
    ([["L"]], "Add the song playing to Favorites, or remove it"),
    ([["/"]], "Search"),
  ]

  /// "Shift + ← or Shift + →", as VoiceOver reads the keys.
  static func spoken(_ keys: [[String]]) -> String {
    keys.map { $0.joined(separator: " + ") }.joined(separator: " or ")
  }

  var body: some View {
    Section {
      ForEach(Self.rows, id: \.action) { row in
        LabeledContent {
          Text(Self.spoken(row.keys)).font(.callout.monospaced())
        } label: {
          Text(row.action)
        }
        .accessibilityElement(children: .combine)
      }
    } header: {
      Text("Keyboard shortcuts")
    } footer: {
      Text("They work anywhere in Playarr, except while you’re typing.")
    }
  }
}
