import SwiftUI

/// How many things are news somewhere (components/Nav.tsx `NewsBadge`): a count on the accent, in its near-black ink,
/// read as "2 new". Nothing at none. The tab bar and the sidebar draw their own (`.badge(_:)`); this is for rows that
/// aren't theirs, as Library's Requests row.
struct NewsBadge: View {
  let count: Int

  var body: some View {
    if count > 0 {
      Text(String(count))
        .typeRole(.badge)
        .monospacedDigit()
        .foregroundStyle(Color.black)
        .padding(.horizontal, 6)
        .frame(minWidth: 20, minHeight: 20)
        .background(Capsule().fill(.tint))
        .accessibilityLabel("\(count) new")
    }
  }
}
