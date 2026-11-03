import PlayarrAPI
import SwiftUI

extension View {
  /// Fetches what a card's page needs once the card has rested on screen for 0.3 s: by the time it's tapped, the page
  /// is usually ready. Scrolling past doesn't fetch (the web prefetches on hover intent the same way).
  func prefetch(_ action: @escaping @MainActor () -> Void) -> some View {
    task {
      try? await Task.sleep(for: .milliseconds(300))
      if !Task.isCancelled { action() }
    }
  }
}

extension AccountSession {
  /// An album page's data, its artist (for "More by") and its big cover.
  func prefetchAlbum(_ id: Int, cover: String?) {
    let api = self.api
    queries.prefetch(.album(id)) { try await api.send(API.Library.album(id: id)) }
    Task { await images.prefetch([cover], size: ImageCache.pixels(points: 320, scale: 3)) }
  }

  func prefetchArtist(_ id: Int) {
    let api = self.api
    queries.prefetch(.artist(id)) { try await api.send(API.Library.artist(id: id)) }
  }
}
