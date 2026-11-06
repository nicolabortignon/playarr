import SwiftUI

/// The line atop a server panel a member opens (the web's `AwayNotice`): they can read it, but only an admin can change
/// what's in it.
struct AdminOnlyNotice: View {
  var text = AdminOnlyNotice.settings

  static let settings = "Only an admin can change these settings."

  var body: some View {
    Section {
      Label(text, systemImage: "lock")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }
}
