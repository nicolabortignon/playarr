import SwiftUI

/// "Try again" (or "Trying again…" while it does), after MusicBrainz couldn't be reached.
struct TryAgainButton: View {
  let busy: Bool
  let action: () -> Void

  var body: some View {
    Button(busy ? "Trying again…" : "Try again", systemImage: "arrow.clockwise", action: action)
      .buttonStyle(.pill(.secondary))
      .disabled(busy)
  }
}
