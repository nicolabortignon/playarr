import SwiftUI

/// The account's button in the top-right corner of every tab (Home, Search, Library, Queue): its initial, opening
/// Account (switch, add or sign out: `AccountSwitcherView`), Your listening (a place, not a setting: it's in Library
/// too) and Settings, as the web's avatar menu.
struct AccountMenu: ViewModifier {
  @Environment(AppModel.self) private var app
  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  func body(content: Content) -> some View {
    content.toolbar {
      ToolbarItem(placement: .primaryAction) {
        Menu {
          Button("Account", systemImage: "person.crop.circle") { app.showingAccounts = true }
          Button("Your listening", systemImage: "chart.bar") { session.router.open(.listening) }
          // Phase 9 finds Settings by this identifier.
          Button("Settings", systemImage: "gearshape") { session.router.open(.settings) }
            .accessibilityIdentifier("settings")
        } label: {
          // The initial as a symbol, a picture rather than text: bar buttons don't grow with the text size (a long press
          // shows the large content viewer instead), and the button's label says what it is.
          // Fitted to its frame: drawn at a font size, the circle spills past it, and the menu opening and closing
          // clips the button to its frame's rounded square.
          Image(systemName: initialSymbol)
            .resizable()
            .scaledToFit()
            .symbolRenderingMode(.palette)
            .foregroundStyle(.black, theme.accent.color)
            .frame(width: 34, height: 34)
            .contentShape(Circle())
        }
        .accessibilityLabel("Account and settings")
      }
      // Just the round initial: without this the bar draws its glass capsule around it.
      .sharedBackgroundVisibility(.hidden)
    }
  }

  /// "d.circle.fill" for Demo; a person for a name that doesn't start with a letter A to Z.
  private var initialSymbol: String {
    let first = session.account.name.trimmingCharacters(in: .whitespaces).lowercased().first
    guard let first, ("a"..."z").contains(first) else { return "person.crop.circle.fill" }
    return "\(first).circle.fill"
  }
}

extension View {
  /// The account's menu in the top-right corner (`AccountMenu`).
  func accountMenu() -> some View { modifier(AccountMenu()) }
}
