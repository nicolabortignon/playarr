import PlayarrAPI
import SwiftUI

/// Feeling lucky (docs/design.md, "Controls" and "Moments"; apps/web/src/components/LuckyButton.tsx): 15 songs the
/// server puts together now, starting from one that suits the hour, new at every press; a toast says why when nothing
/// can be. While they're picked the sparkles twinkle, and covers come out from behind the button, fanning open like a
/// hand of cards, the first song's dealt last and on top (`CoverFan`). The songs are asked for as a press looks likely
/// (a finger touching the button, the pointer coming over it, or it taking the focus), so that card goes out in the same
/// rhythm as the rest. On Home, and as what fills an empty queue, Made for you or Your listening; in the iPad's idle
/// player bar, regular-sized, and outlined beside Resume.
struct FeelingLuckyButton: View {
  var variant: PillVariant = .primary
  var size: PillSize = .large
  @Environment(AccountSession.self) private var session
  @Environment(\.reducesMotion) private var reducesMotion
  @State private var model = FeelingLuckyModel()
  @FocusState private var focused: Bool

  var body: some View {
    Button {
      Task { await model.press(session, still: reducesMotion) }
    } label: {
      // The sparkles twinkle in turn while the songs are picked.
      Label {
        Text("Feeling lucky")
      } icon: {
        Twinkle(on: model.picking, size: size.icon)
      }
    }
    // A finger coming down on it: a press looks likely.
    .buttonStyle(Pressing(pill: .pill(variant, size: size)) { prepare() })
    // The fan behind it, the button on top. While the songs are picked the sparkles say so: the button stays lit rather
    // than dimming (a press then does nothing).
    .background { fan }
    .onHover { if $0 { prepare() } }
    .focused($focused)
    .onChange(of: focused) { _, focused in if focused { prepare() } }
    .accessibilityLabel("Feeling lucky")
    .accessibilityHint("Plays 15 songs picked for this hour, new every time")
    .sensoryFeedback(.success, trigger: model.picking, condition: Self.landed)
  }

  @ViewBuilder private var fan: some View {
    if let deal = model.deal {
      let press = model.presses
      // Each press deals afresh.
      CoverFan(deal: deal, small: size != .large, pill: size.height) { model.dealt(press: press) }
        .id(press)
    }
  }

  private func prepare() {
    model.prepare(session, still: reducesMotion)
  }

  /// When the success tap comes: the songs have been picked. A function outside the main actor, as SwiftUI keeps it to
  /// call later.
  nonisolated static func landed(_ wasPicking: Bool, _ picking: Bool) -> Bool {
    wasPicking && !picking
  }
}

/// A pill that says when a finger comes down on it (or a click starts).
private struct Pressing: ButtonStyle {
  let pill: PillButtonStyle
  let pressed: @MainActor () -> Void

  func makeBody(configuration: Configuration) -> some View {
    pill.makeBody(configuration: configuration)
      .onChange(of: configuration.isPressed) { _, isPressed in if isPressed { pressed() } }
  }
}

extension QuickPlay {
  /// Feeling lucky from a button: what it can't do goes in a toast (an empty library says so without alarm). `mix`, the
  /// songs asked for ahead. The songs it plays: none when it couldn't.
  @discardableResult
  static func feelingLucky(session: AccountSession, mix: Task<LuckyMix, any Error>? = nil) async -> [Track] {
    do {
      return try await QuickPlay(session: session).feelingLucky(mix)
    } catch {
      session.toasts.push(error.localizedDescription, tone: error == .emptyLibrary ? .info : .error)
      return []
    }
  }
}
