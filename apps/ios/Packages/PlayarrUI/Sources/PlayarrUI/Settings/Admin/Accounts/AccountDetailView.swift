import PlayarrAPI
import SwiftUI

/// One account, for an admin: what it may do, Edit, its devices, a new setup code, Remove. Someone invited who never
/// set up has no devices: Copy invite link and New code instead.
struct AccountDetailView: View {
  let accountId: Int
  @Bindable var model: AccountsModel
  @State private var editing = false
  @State private var askingReset = false
  @State private var askingRemove = false
  /// Copy invite link without a link on this device: asking whether to make a new one.
  @State private var askingInvite = false
  /// A new code, on screen until closed.
  @State private var code: AccountsModel.SetupShown?
  @Environment(\.dismiss) private var dismiss

  private var account: Account? { model.accounts?.first { $0.id == accountId } }

  var body: some View {
    Form {
      if let account {
        Section {
          if !account.hasPassword { Text(AccountsModel.invitedLine).foregroundStyle(.paperDim) }
          Text(model.summary(account)).font(.footnote).foregroundStyle(.secondary)
          if let error = model.error { InlineMessage(text: error) }
          Button("Edit", systemImage: "pencil") { editing = true }
        }
        if account.hasPassword {
          Section("Devices") {
            SessionRows(accountId: account.id, model: model)
          }
        }
        // Each asked from its own button, so a phone's popover points at it.
        Section {
          if !account.hasPassword {
            Button("Copy invite link", systemImage: "doc.on.doc") { if !model.copyInvite(account) { askingInvite = true } }
              .confirmLoss(model.inviteQuestion(account), isPresented: $askingInvite) { Task { code = await model.reset(account) } }
          }
          Button(account.hasPassword ? "New setup code" : "New code", systemImage: "key") { askingReset = true }
            .confirmLoss(model.resetQuestion(account), isPresented: $askingReset) { Task { code = await model.reset(account) } }
          if model.canRemove(account) {
            Button("Remove", systemImage: "trash", role: .destructive) { askingRemove = true }
              .confirmLoss(model.removeQuestion(account), isPresented: $askingRemove) {
                Task {
                  await model.remove(account)
                  if model.error == nil { dismiss() }
                }
              }
          }
        }
      }
    }
    .navigationTitle(account?.name ?? "")
    .task { if account?.hasPassword != false { await model.loadSessions(of: accountId) } }
    .sheet(isPresented: $editing) {
      if let account {
        AccountFormView(title: "Edit \(account.name)", submitLabel: "Save", form: AccountFormModel(account: account, sources: model.sources), model: model) { form in
          await model.update(form)
        }
      }
    }
    .sheet(item: $code) { shown in
      NavigationStack { SetupCodeView(shown: shown) { code = nil } }
    }
  }
}
