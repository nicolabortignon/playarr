import SwiftUI

/// A page's empty state (docs/design.md, "Empty, loading and error"; apps/web/src/components/States.tsx `EmptyState`):
/// an icon in a ring, one line in the display face in the app's voice (`PageLines`), a quieter line only where the
/// first can't say it all, and the action that fills the page as a large primary pill: Feeling lucky where nothing else
/// fills it. A second action, where there is one, sits beside it as a secondary pill.
struct EmptyState: View {
  /// A button of the empty state: what it says, its glyph, what it does.
  struct Action {
    let title: String
    let systemImage: String
    var hint: String?
    let perform: @MainActor () -> Void

    init(_ title: String, systemImage: String, hint: String? = nil, perform: @escaping @MainActor () -> Void) {
      self.title = title
      self.systemImage = systemImage
      self.hint = hint
      self.perform = perform
    }
  }

  /// What fills the page.
  enum Fill {
    case action(Action)
    /// Feeling lucky: songs in the queue at once (`FeelingLuckyButton`).
    case lucky
  }

  /// The page's own glyph: a heart for Favorites, a stack for Albums.
  let systemImage: String
  let line: PageLines.Line
  var fill: Fill?
  /// Beside the main action, outlined.
  var secondary: Action?

  init(systemImage: String, line: PageLines.Line, fill: Fill? = nil, secondary: Action? = nil) {
    self.systemImage = systemImage
    self.line = line
    self.fill = fill
    self.secondary = secondary
  }

  var body: some View {
    StateLayout(systemImage: systemImage, tone: .accent, title: line.title, hint: line.hint) {
      if fill != nil || secondary != nil {
        // Side by side where both fit, else one above the other (a phone at the larger text sizes).
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) { buttons }
          VStack(spacing: 12) { buttons }
        }
        .padding(.top, 28)
      }
    }
  }

  @ViewBuilder private var buttons: some View {
    switch fill {
    case .action(let action): button(action, variant: .primary)
    case .lucky: FeelingLuckyButton()
    case nil: EmptyView()
    }
    if let secondary { button(secondary, variant: .secondary) }
  }

  private func button(_ action: Action, variant: PillVariant) -> some View {
    Button(action.title, systemImage: action.systemImage, action: action.perform)
      .buttonStyle(.pill(variant, size: .large))
      .accessibilityHint(action.hint ?? "")
  }
}

/// The look an empty page and a failed one share: an icon in a ring, one line in the display face, a quieter one under
/// it, then the way on.
struct StateLayout<Actions: View>: View {
  enum Tone { case accent, danger }

  let systemImage: String
  let tone: Tone
  let title: String
  var hint: String?
  @ViewBuilder let actions: () -> Actions

  var body: some View {
    VStack(spacing: 0) {
      Image(systemName: systemImage)
        .font(.sans(.title2))
        .foregroundStyle(tone == .accent ? AnyShapeStyle(.tint) : AnyShapeStyle(.danger))
        .frame(width: 56, height: 56)
        .background(Circle().fill(Color.paper.opacity(0.06)))
        .overlay(Circle().strokeBorder(.line, lineWidth: 1))
        .accessibilityHidden(true)
      Text(title)
        .typeRole(.sectionTitle)
        .foregroundStyle(.paper)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 20)
        .accessibilityAddTraits(.isHeader)
      if let hint {
        Text(hint)
          .typeRole(.body)
          .foregroundStyle(.paperDim)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 12)
      }
      actions()
    }
    .frame(maxWidth: 420)
    .padding(.horizontal, 20)
    .padding(.vertical, 48)
    .frame(maxWidth: .infinity)
  }
}
