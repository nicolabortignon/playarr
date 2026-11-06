import SwiftUI

/// A page that couldn't load: what went wrong and Try again (apps/web/src/components/Section.tsx `ErrorState`).
struct ErrorState: View {
  let message: String
  let retry: () async -> Void

  var body: some View {
    ContentUnavailableView {
      Text("Something skipped.").font(.display(.title))
    } description: {
      Text(message)
    } actions: {
      Button("Try again", systemImage: "arrow.clockwise") { Task { await retry() } }
        .buttonStyle(.pill(.primary))
    }
  }
}
