import SwiftUI

/// The account's button in the top-right corner of every tab (Home, Search, Library, Queue): its initial, opening
/// Account (switch, add or sign out: `AccountSwitcherView`) and Settings.
struct AccountMenu: ViewModifier {
  @Environment(AppModel.self) private var app
  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  func body(content: Content) -> some View {
    content.toolbar {
      ToolbarItem(placement: .primaryAction) {
        Menu {
          Button("Account", systemImage: "person.crop.circle") { app.showingAccounts = true }
          // Phase 9 finds Settings by this identifier.
          Button("Settings", systemImage: "gearshape") { session.router.open(.settings) }
            .accessibilityIdentifier("settings")
        } label: {
          Text(initial)
            .font(.sans(.subheadline).weight(.semibold))
            .foregroundStyle(.black)
            .frame(width: 30, height: 30)
            .background(theme.accent.color, in: Circle())
        }
        .accessibilityLabel("Account and settings")
      }
    }
  }

  private var initial: String {
    String(session.account.name.trimmingCharacters(in: .whitespaces).first ?? "?").uppercased()
  }
}

extension View {
  /// The account's menu in the top-right corner (`AccountMenu`).
  func accountMenu() -> some View { modifier(AccountMenu()) }
}
