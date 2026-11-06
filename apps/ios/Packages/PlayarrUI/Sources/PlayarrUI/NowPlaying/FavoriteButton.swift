import PlayarrAPI
import SwiftUI

/// The heart on a song, wherever it shows (song rows, Now Playing): fills at once, and goes back if the server says no
/// (apps/web/src/components/FavoriteButton.tsx).
struct FavoriteButton: View {
  enum Size { case row, large }

  let track: Track
  var size: Size = .large
  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme
  @State private var popped = 0

  var body: some View {
    let favorite = session.favorites.isFavorite(track.recordingId)
    Button {
      if !favorite { popped += 1 }
      Task { await session.favorites.toggle(track) }
    } label: {
      Image(systemName: favorite ? "heart.fill" : "heart")
        .font(size == .large ? .title2 : .body)
        .foregroundStyle(favorite ? theme.accent.color : .secondary)
        .symbolEffect(.bounce, value: popped)
        // 44 points to tap, whatever it looks like.
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .sensoryFeedback(.impact(weight: .light), trigger: popped)
    .accessibilityLabel(favorite ? "Remove “\(track.title)” from Favorites" : "Add “\(track.title)” to Favorites")
    .accessibilityAddTraits(favorite ? .isSelected : [])
  }
}
