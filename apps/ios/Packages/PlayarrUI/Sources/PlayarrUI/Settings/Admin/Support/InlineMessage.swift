import SwiftUI

/// A panel's message in place: what a change did, or the server's `{ error }` when it failed.
struct InlineMessage: View {
  let text: String
  var isError = true

  var body: some View {
    Label(text, systemImage: isError ? "exclamationmark.triangle" : "checkmark.circle")
      .font(.footnote)
      .foregroundStyle(isError ? Color.danger : Color.secondary)
      .accessibilityIdentifier(isError ? "admin.error" : "admin.notice")
  }
}
