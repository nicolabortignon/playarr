import SwiftUI

/// The signed-in account's session couldn't open (`AppModel.sessionFailure`): "The needle skipped." with the reason,
/// Try again, and Accounts to switch to another account or sign this one out (Leave the demo in the demo tried from the
/// welcome screen), rather than a spinner for ever.
struct SessionFailedView: View {
  @Bindable var model: AppModel
  let reason: String

  var body: some View {
    ScrollView {
      StateLayout(systemImage: "exclamationmark.circle", tone: .danger, title: PageLines.failed, hint: reason) {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) { buttons }
          VStack(spacing: 12) { buttons }
        }
        .padding(.top, 28)
      }
    }
    .sheet(isPresented: $model.showingAccounts) { AccountSwitcherView(model: model).environment(model.theme) }
  }

  @ViewBuilder private var buttons: some View {
    Button("Try again", systemImage: "arrow.clockwise") { model.syncSession() }
      .buttonStyle(.pill(.primary))
    if let leave = model.leavesTrial {
      // The demo tried from the welcome screen has no accounts to go to: only the way back.
      Button("Leave the demo", systemImage: "rectangle.portrait.and.arrow.right", action: leave)
        .buttonStyle(.pill(.secondary))
    } else {
      Button("Accounts", systemImage: "person.crop.circle") { model.showingAccounts = true }
        .buttonStyle(.pill(.secondary))
    }
  }
}
