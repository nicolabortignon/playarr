import SwiftUI

/// Covers move from where they came from (docs/design.md, Moments): an album's page grows from the cover of the card
/// pressed to open it, and shrinks back into it going back (the zoom navigation transition). Every card is a source of
/// its own, so the same album on two shelves grows from the one pressed: the card opens the page through the router,
/// which keeps which card it was for the page to take as it's made (`AppRouter.open(_:from:)`). Each stack has a
/// namespace for them (`coverZoom`, set by the shells); under Reduce Motion pages come in as any other.
enum CoverZoom {
  /// A card's own: made with the card, kept while it's on screen.
  struct Source: Hashable, Sendable {
    let id: UUID

    init() {
      id = UUID()
    }
  }

  /// How the cover the page grows from is drawn: with its corners.
  nonisolated static func rounded(_ source: EmptyMatchedTransitionSourceConfiguration) -> some MatchedTransitionSourceConfiguration {
    source.clipShape(RoundedRectangle(cornerRadius: Radius.cover))
  }
}

extension EnvironmentValues {
  /// The stack's namespace for pages growing from cards (`CoverZoom`); nil outside the shells' stacks.
  @Entry var coverZoom: Namespace.ID?
}

extension View {
  /// A card's cover, which the page it opens grows from and shrinks back into (`CoverZoom`).
  func zoomSource(_ source: CoverZoom.Source) -> some View {
    modifier(ZoomSource(source: source))
  }

  /// A page that grows from the card pressed to open it, and shrinks back into it (`CoverZoom`); opened another way
  /// (nil), or under Reduce Motion, it comes in as any other page.
  func grows(from source: CoverZoom.Source?) -> some View {
    modifier(GrowsFromCard(source: source))
  }
}

private struct ZoomSource: ViewModifier {
  let source: CoverZoom.Source
  @Environment(\.coverZoom) private var namespace

  func body(content: Content) -> some View {
    if let namespace {
      // The corners by a function outside the main actor, as SwiftUI keeps it to call later.
      content.matchedTransitionSource(id: source, in: namespace, configuration: CoverZoom.rounded)
    } else {
      content
    }
  }
}

private struct GrowsFromCard: ViewModifier {
  let source: CoverZoom.Source?
  @Environment(\.coverZoom) private var namespace
  @Environment(\.reducesMotion) private var reducesMotion

  func body(content: Content) -> some View {
    #if os(iOS)
      if let source, let namespace, !reducesMotion {
        content.navigationTransition(.zoom(sourceID: source, in: namespace))
      } else {
        content
      }
    #else
      content
    #endif
  }
}
