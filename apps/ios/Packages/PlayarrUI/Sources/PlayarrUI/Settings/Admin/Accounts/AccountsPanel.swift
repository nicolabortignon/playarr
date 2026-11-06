import PlayarrAPI
import SwiftUI

/// Settings → Accounts: you (name, devices, sign out here) and, for admins, everyone. Someone invited who never set up
/// says so ("Invited · not set up yet"), with Copy invite link and New code under them.
public struct AccountsPanel: View {
  @State private var model: AccountsModel
  @State private var adding = false
  /// A new code made from the list, on screen until closed.
  @State private var code: AccountsModel.SetupShown?
  /// New code from the list: asking first.
  @State private var resetting: Account?
  /// Copy invite link for someone this device has no link for: asking whether to make a new one.
  @State private var inviting: Account?

  /// `invites` keeps the setup links this device makes, to copy again; `toast` says what was copied.
  public init(
    api: any APISending, signOutHere: @escaping @MainActor () async -> Void, accountChanged: @escaping @MainActor (Account) -> Void = { _ in },
    invites: InviteStore = InviteStore(), toast: @escaping @MainActor (String) -> Void = { _ in }
  ) {
    _model = State(
      initialValue: AccountsModel(
        api: api, signOutHere: signOutHere, accountChanged: accountChanged, invites: invites, copy: Pasteboard.copy, toast: toast))
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
    .sheet(item: $code) { shown in
      NavigationStack { SetupCodeView(shown: shown) { code = nil } }
    }
  }

  private func you(_ me: Account) -> some View {
    Section {
      HStack {
        TextField("Your name", text: $model.name)
          .accessibilityIdentifier("account.yourName")
          .submitLabel(.done)
          .onSubmit { if model.canRename { Task { await model.rename() } } }
        // Only once there's a new name to save (Return saves it too): a grayed-out Save reads at 2.3:1.
        if model.canRename {
          Button("Save") { Task { await model.rename() } }
            .buttonStyle(.borderless)
        }
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
            // Never set up: an invite, not an account with nothing played yet.
            if !account.hasPassword { Text(AccountsModel.invitedLine).font(.footnote).foregroundStyle(.paperDim) }
            Text(model.summary(account)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            if let activity = model.activityText(account) {
              Text(activity).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
        // The invite's own buttons, under its row, as one card with it.
        .listRowSeparator(account.hasPassword ? .automatic : .hidden, edges: .bottom)
        if !account.hasPassword { invite(account) }
      }
      Button("Add account", systemImage: "person.badge.plus") { adding = true }
        .accessibilityIdentifier("accounts.add")
    } header: {
      Text("Everyone")
    } footer: {
      Text(AccountsModel.everyoneIntro)
    }
  }

  /// Copy invite link (the link this device made, or after asking a new one) and New code, for someone invited.
  private func invite(_ account: Account) -> some View {
    HStack(spacing: 8) {
      Button("Copy invite link", systemImage: "doc.on.doc") { if !model.copyInvite(account) { inviting = account } }
        .buttonStyle(.pill(.secondary, size: .small))
        // Whose it is, for VoiceOver, while Voice Control still answers to the words on it.
        .accessibilityLabel("Copy \(account.name)’s invite link")
        .accessibilityInputLabels(["Copy invite link", "Copy \(account.name)’s invite link"])
        // Asked from the button, so a phone's popover points at it.
        .confirmLoss(
          model.inviteQuestion(account), isPresented: Binding(get: { inviting?.id == account.id }, set: { if !$0 { inviting = nil } })
        ) {
          Task { code = await model.reset(account) }
        }
      Button("New code", systemImage: "key") { resetting = account }
        .buttonStyle(.pill(.ghost, size: .small))
        .accessibilityLabel("New code for \(account.name)")
        .accessibilityInputLabels(["New code", "New code for \(account.name)"])
        .confirmLoss(
          model.resetQuestion(account), isPresented: Binding(get: { resetting?.id == account.id }, set: { if !$0 { resetting = nil } })
        ) {
          Task { code = await model.reset(account) }
        }
      Spacer(minLength: 0)
    }
  }
}
