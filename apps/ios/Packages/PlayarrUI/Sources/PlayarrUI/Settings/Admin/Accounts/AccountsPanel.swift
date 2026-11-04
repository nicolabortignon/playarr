import PlayarrAPI
import SwiftUI

/// Settings → Accounts: you (name, devices, sign out here) and, for admins, everyone.
public struct AccountsPanel: View {
  @State private var model: AccountsModel
  @State private var adding = false

  public init(
    api: any APISending, signOutHere: @escaping @MainActor () async -> Void, accountChanged: @escaping @MainActor (Account) -> Void = { _ in }
  ) {
    _model = State(initialValue: AccountsModel(api: api, signOutHere: signOutHere, accountChanged: accountChanged))
  }

  public var body: some View {
    Form {
      if let me = model.me {
        you(me)
        if model.isAdmin { everyone(me) }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Accounts")
    .task { await model.load() }
    .refreshable { await model.load() }
    .sheet(isPresented: $adding) {
      AccountFormView(title: "Add account", submitLabel: "Add", form: AccountFormModel(account: nil, sources: model.sources), model: model) { form in
        await model.create(form)
      }
    }
  }

  private func you(_ me: Account) -> some View {
    Section {
      HStack {
        TextField("Your name", text: $model.name)
          .accessibilityIdentifier("account.yourName")
        Button("Save") { Task { await model.rename() } }
          .buttonStyle(.borderless)
          .disabled(!model.canRename)
      }
      if let notice = model.notice { InlineMessage(text: notice, isError: false) }
      if let error = model.error, model.accounts == nil { InlineMessage(text: error) }
      NavigationLink("Signed in on") {
        SessionsView(accountId: me.id, title: "Signed in on", model: model)
      }
      Button("Sign out on this device", systemImage: "rectangle.portrait.and.arrow.right") { Task { await model.signOut() } }
    } header: {
      Text("You")
    } footer: {
      Text(model.signedInText)
    }
  }

  private func everyone(_ me: Account) -> some View {
    Section {
      if let error = model.error { InlineMessage(text: error) }
      ForEach(model.accounts ?? []) { account in
        NavigationLink {
          AccountDetailView(accountId: account.id, model: model)
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(account.name)
              if account.id == me.id { Text("you").font(.footnote).foregroundStyle(.secondary) }
            }
            Text(model.summary(account)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            if let activity = model.activityText(account) {
              Text(activity).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      Button("Add account", systemImage: "person.badge.plus") { adding = true }
        .accessibilityIdentifier("accounts.add")
    } header: {
      Text("Everyone")
    } footer: {
      Text(AccountsModel.everyoneIntro)
    }
  }
}
