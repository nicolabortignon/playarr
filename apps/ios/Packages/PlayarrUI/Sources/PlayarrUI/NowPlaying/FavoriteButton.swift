import PlayarrAPI
import SwiftUI

/// The heart. Phase 6 makes it add and remove favorites; until then it's shown but does nothing.
struct FavoriteButton: View {
  let track: Track

  var body: some View {
    Button {} label: { Image(systemName: "heart").font(.title2).frame(width: 44, height: 44) }
      .buttonStyle(.plain)
      .disabled(true)
      .accessibilityLabel("Add to Favorites")
  }
}
