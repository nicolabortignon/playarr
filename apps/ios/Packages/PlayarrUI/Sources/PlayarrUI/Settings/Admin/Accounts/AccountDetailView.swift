import PlayarrAPI
import SwiftUI

/// One account, for an admin: what it may do, Edit, its devices, a new setup code, Remove.
struct AccountDetailView: View {
  let accountId: Int
  @Bindable var model: AccountsModel
  @State private var editing = false
  @State private var askingReset = false
  @State private var askingRemove = false
  @Environment(\.dismiss) private var dismiss

  private var account: Account? { model.accounts?.first { $0.id == accountId } }

  var body: some View {
    Form {
      if let account {
        Section {
          Text(model.summary(account)).font(.footnote).foregroundStyle(.secondary)
          if let error = model.error { InlineMessage(text: error) }
          Button("Edit", systemImage: "pencil") { editing = true }
        }
        Section("Devices") {
          SessionRows(accountId: account.id, model: model)
        }
        Section {
          Button("New setup code", systemImage: "key") { askingReset = true }
          if model.canRemove(account) {
            Button("Remove", systemImage: "trash", role: .destructive) { askingRemove = true }
          }
        }
      }
    }
    .navigationTitle(account?.name ?? "")
    .task { await model.loadSessions(of: accountId) }
    .sheet(isPresented: $editing) {
      if let account {
        AccountFormView(title: "Edit \(account.name)", submitLabel: "Save", form: AccountFormModel(account: account, sources: model.sources), model: model) { form in
          await model.update(form)
        }
      }
    }
    .sheet(item: $model.setupShown) { shown in
      NavigationStack { SetupCodeView(shown: shown) { model.setupShown = nil } }
    }
    .confirmationDialog(account.map(model.resetTitle) ?? "", isPresented: $askingReset, titleVisibility: .visible) {
      Button("New setup code", role: .destructive) { if let account { Task { await model.reset(account) } } }
    } message: {
      Text(AccountsModel.resetMessage)
    }
    .confirmationDialog(account.map(model.removeTitle) ?? "", isPresented: $askingRemove, titleVisibility: .visible) {
      Button("Remove", role: .destructive) {
        guard let account else { return }
        Task {
          await model.remove(account)
          if model.error == nil { dismiss() }
        }
      }
    } message: {
      Text(AccountsModel.removeMessage)
    }
  }
}
