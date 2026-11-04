import SwiftUI
#if os(iOS)
import UIKit
#endif

/// A new or reset account's one-time code, and the link that fills it in: Copy, or the share sheet.
/// Shown inside a navigation stack: the add-account sheet's, or its own after a reset.
struct SetupCodeView: View {
  let shown: AccountsModel.SetupShown
  let done: () -> Void
  @State private var copied = false

  var body: some View {
    Form {
      Section {
        Text(AccountsModel.setupText(shown.setup))
        Text(shown.setup.code)
          .font(.system(.largeTitle, design: .monospaced))
          .tracking(6)
          .textSelection(.enabled)
          .accessibilityIdentifier("setup.code")
      }
      Section {
        Text(shown.setup.link)
          .font(.footnote.monospaced())
          .textSelection(.enabled)
          .accessibilityIdentifier("setup.link")
        Button(copied ? "Link copied" : "Copy", systemImage: "doc.on.doc") { copy() }
        if let url = URL(string: shown.setup.link) {
          ShareLink(item: url, subject: Text("Playarr"), message: Text("Your Playarr setup code: \(shown.setup.code)"))
        }
      }
    }
    .navigationTitle("Setup code for \(shown.account.name)")
    .navigationBarBackButtonHidden()
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } }
  }

  private func copy() {
    #if os(iOS)
    UIPasteboard.general.string = shown.setup.link
    #endif
    copied = true
  }
}
