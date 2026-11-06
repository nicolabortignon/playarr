import SwiftUI

/// Part of a page that couldn't load or save, in its place (a section, a panel, a sheet): a danger icon, what happened
/// and why, and a small Try again where there's a retry (docs/design.md, "Empty, loading and error";
/// apps/web/src/components/States.tsx `InlineError`). Clarity first: no line in the voice here.
struct InlineError: View {
  /// What happened ("Couldn’t reach ListenBrainz"); `reason` follows it.
  var what: String?
  var reason: String?
  var retry: (() async -> Void)?

  @State private var retrying = false

  init(_ what: String? = nil, reason: String? = nil, retry: (() async -> Void)? = nil) {
    self.what = what
    self.reason = reason
    self.retry = retry
  }

  /// "Couldn’t reach ListenBrainz: timed out", or whichever of the two there is.
  static func text(what: String?, reason: String?) -> String {
    switch (what, reason) {
    case (let what?, let reason?): "\(what): \(reason)"
    case (let what?, nil): what
    case (nil, let reason?): reason
    case (nil, nil): "Something went wrong"
    }
  }

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 16) { content }
      VStack(alignment: .leading, spacing: 12) { content }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private var content: some View {
    Label {
      Text(Self.text(what: what, reason: reason)).fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: "exclamationmark.circle")
    }
    .typeRole(.small)
    .foregroundStyle(.danger)
    if let retry {
      Button(retrying ? "Trying again…" : "Try again", systemImage: "arrow.clockwise") {
        Task {
          retrying = true
          await retry()
          retrying = false
        }
      }
      .buttonStyle(.pill(.secondary, size: .small))
      .disabled(retrying)
    }
  }
}
