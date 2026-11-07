import SwiftUI

/// Feeling lucky (docs/design.md, "Controls"): 15 songs the server puts together now, starting from one that suits the
/// hour, new at every press; the sparkles twinkle while they're picked, and a toast says why when nothing can be
/// (apps/web/src/components/LuckyButton.tsx). On Home, and as what fills an empty queue, Made for you or Your listening;
/// in the iPad's idle player bar, regular-sized, and outlined beside Resume.
struct FeelingLuckyButton: View {
  var variant: PillVariant = .primary
  var size: PillSize = .large
  @Environment(AccountSession.self) private var session
  @State private var picking = false

  var body: some View {
    Button {
      Task {
        picking = true
        await QuickPlay.feelingLucky(session: session)
        picking = false
      }
    } label: {
      // The sparkles twinkle in turn while the songs are picked.
      Label {
        Text("Feeling lucky")
      } icon: {
        Twinkle(on: picking, size: size.icon)
      }
    }
    .buttonStyle(.pill(variant, size: size))
    .disabled(picking)
    .accessibilityLabel("Feeling lucky")
    .accessibilityHint("Plays 15 songs picked for this hour, new every time")
    .sensoryFeedback(.success, trigger: picking) { wasPicking, nowPicking in wasPicking && !nowPicking }
  }
}

extension QuickPlay {
  /// Feeling lucky from a button: what it can't do goes in a toast (an empty library says so without alarm).
  static func feelingLucky(session: AccountSession) async {
    do {
      try await QuickPlay(session: session).feelingLucky()
    } catch {
      session.toasts.push(error.localizedDescription, tone: error == .emptyLibrary ? .info : .error)
    }
  }
}
