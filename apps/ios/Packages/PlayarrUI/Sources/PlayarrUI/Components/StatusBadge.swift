import SwiftUI

/// A status that does nothing when tapped (docs/design.md, "Statuses"): "Searching", "42%", "Importing". Badge
/// capitals (`.typeRole(.badge)`) in a capsule outlined in its tone, a spinner or an icon before the words, and a
/// download's share filling it from the leading edge. What can be tapped is a pill button instead.
struct StatusBadge: View {
  enum Tone: Sendable {
    /// Under way: the accent.
    case accent
    /// Done: in the library.
    case success
    /// Only saying something: still being asked for ("Requesting…"), or how much of an album is here.
    case quiet
  }

  let text: String
  var systemImage: String?
  var spinning = false
  /// 0–1: how much is done.
  var progress: Double?
  var tone: Tone = .accent

  var body: some View {
    // The words are what VoiceOver reads; the spinner and icon only echo them.
    HStack(spacing: 6) {
      if spinning { ProgressView().controlSize(.mini).tint(spinnerTint).accessibilityHidden(true) }
      if let systemImage { Image(systemName: systemImage).accessibilityHidden(true) }
      Text(text)
    }
    .typeRole(.badge)
    .lineLimit(1)
    .foregroundStyle(foreground)
    .padding(.horizontal, 10)
    .padding(.vertical, 4)
    // Drawn as tall as a small pill, and taking as much room as one (its 44 points of taps, below), so a card
    // doesn't move as Request turns into Searching.
    .frame(minHeight: PillSize.small.height)
    .background {
      ZStack(alignment: .leading) {
        if let progress {
          GeometryReader { box in
            Rectangle().fill(style(0.15)).frame(width: box.size.width * min(max(progress, 0), 1))
          }
          .clipShape(Capsule())
        }
        Capsule().strokeBorder(tone == .quiet ? AnyShapeStyle(.line) : style(0.4), lineWidth: 1)
      }
    }
    .frame(minHeight: 44)
  }

  private var foreground: AnyShapeStyle { tone == .quiet ? AnyShapeStyle(.paperDim) : style() }

  private var spinnerTint: Color? {
    switch tone {
    case .accent: nil
    case .success: .success
    case .quiet: .secondary
    }
  }

  /// The tone at `opacity`: the accent is the environment's tint.
  private func style(_ opacity: Double = 1) -> AnyShapeStyle {
    switch tone {
    case .accent: AnyShapeStyle(.tint.opacity(opacity))
    case .success: AnyShapeStyle(Color.success.opacity(opacity))
    case .quiet: AnyShapeStyle(Color.paper.opacity(opacity))
    }
  }
}
