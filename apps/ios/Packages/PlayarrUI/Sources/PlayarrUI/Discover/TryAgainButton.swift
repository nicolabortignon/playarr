import SwiftUI

/// "Try again" (or "Retrying…" while it does), after MusicBrainz couldn't be reached.
struct TryAgainButton: View {
  let busy: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) { Pill(style: .quiet) { Text(busy ? "Retrying…" : "Try again") } }
      .buttonStyle(.plain)
      .disabled(busy)
  }
}
