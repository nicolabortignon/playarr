import SwiftUI

/// The line atop a device settings panel an admin has locked for this account (Settings → Accounts).
struct LockedNotice: View {
  let panel: String

  var body: some View {
    Section {
      Label("Only an admin can change \(panel) for your account.", systemImage: "lock")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }
}
