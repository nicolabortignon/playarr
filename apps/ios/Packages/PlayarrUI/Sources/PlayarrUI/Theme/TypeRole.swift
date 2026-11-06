import SwiftUI

/// The type scale, by role, with the web's names (`type-kicker`…, docs/design.md). A role sets the font, and for
/// kickers and badges their capitals and spacing, never the color. Every size grows with Dynamic Type.
public enum TypeRole: Sendable {
  /// A page's title: Gloock at the large title's size.
  case pageTitle
  /// A section's title on a page: Gloock.
  case sectionTitle
  /// The small line above a title or a section ("ALBUM", "MADE FOR YOU"): DM Mono in spaced capitals, `.muted`.
  case kicker
  /// Row titles and paragraphs: Schibsted Grotesk at 15.
  case body
  /// Row subtitles and secondary lines: 13.
  case small
  /// Times and counts: DM Mono at 12, with figures of one width.
  case meta
  /// Format and status badges: DM Mono at 10, in capitals.
  case badge
}

extension View {
  /// Text in one of the design language's type roles.
  public func typeRole(_ role: TypeRole) -> some View {
    modifier(TypeRoleStyle(role: role))
  }
}

private struct TypeRoleStyle: ViewModifier {
  let role: TypeRole
  /// Letter spacing grows with the text, as `em` does on the web.
  @ScaledMetric(relativeTo: .caption2) private var scale: CGFloat = 1
  @Environment(\.dynamicTypeSize) private var typeSize

  @ViewBuilder func body(content: Content) -> some View {
    switch role {
    case .pageTitle: content.font(.display(.largeTitle))
    case .sectionTitle: content.font(.display(.title2))
    case .kicker: content.font(.mono(.caption2)).tracking(spacing(2.2)).textCase(.uppercase)
    case .body: content.font(.sans(.subheadline))
    case .small: content.font(.sans(.footnote))
    case .meta: content.font(.mono(.caption)).monospacedDigit()
    case .badge: content.font(.mono(size: 10, relativeTo: .caption2)).tracking(spacing(0.8)).textCase(.uppercase)
    }
  }

  /// None at the accessibility sizes, where spaced capitals would break "MADE FOR YOU" over two lines.
  private func spacing(_ points: CGFloat) -> CGFloat {
    typeSize.isAccessibilitySize ? 0 : points * scale
  }
}
