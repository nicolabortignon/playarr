import SwiftUI

/// A whole page that couldn't load (docs/design.md, "Empty, loading and error"; apps/web/src/components/States.tsx
/// `ErrorState`): "The needle skipped." with the reason under it, Try again (saying so while it tries) and Back home.
/// Home itself leaves out Back home (`home: false`). A part of a page that failed is an `InlineError` instead.
struct ErrorState: View {
  let message: String
  /// Back home is offered: false on Home.
  var home = true
  let retry: () async -> Void

  @Environment(AccountSession.self) private var session: AccountSession?
  @State private var retrying = false

  init(message: String, home: Bool = true, retry: @escaping () async -> Void) {
    self.message = message
    self.home = home
    self.retry = retry
  }

  var body: some View {
    StateLayout(systemImage: "exclamationmark.circle", tone: .danger, title: PageLines.failed, hint: message) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 12) { buttons }
        VStack(spacing: 12) { buttons }
      }
      .padding(.top, 28)
    }
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var buttons: some View {
    Button(retrying ? "Trying again…" : "Try again", systemImage: "arrow.clockwise") {
      Task {
        retrying = true
        await retry()
        retrying = false
      }
    }
    .buttonStyle(.pill(.primary))
    .disabled(retrying)
    if home, let session {
      Button("Back home", systemImage: "house") { session.router.goHome() }
        .buttonStyle(.pill(.secondary))
    }
  }
}
