import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Every server and its accounts: switch with a tap (no password), add an account or a server, sign out.
struct AccountSwitcherView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var adding: AddServerFlow.Start?
    @State private var leaving: KeptForAccount?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.store.servers) { server in
                    Section(server.name) {
                        ForEach(server.accounts) { record in
                            Button {
                                model.store.activate(record.key)
                                dismiss()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(record.account.name)
                                        Text(record.signedIn ? "@\(record.account.username)" : "Signed out").font(.sans(.caption)).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if record.key == model.store.active { Image(systemName: "checkmark") }
                                }
                            }
                            .swipeActions {
                                Button("Sign out", role: .destructive) { signOut(record) }
                            }
                            .contextMenu {
                                Button("Sign out", role: .destructive) { signOut(record) }
                            }
                        }
                        Button("Add account") { adding = .server(server.baseURL, username: nil) }
                    }
                }
                Section {
                    Button("Add a server") { adding = .address }
                }
            }
            .navigationTitle("Accounts")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(item: $adding) { start in
                AddServerFlow(app: model, start: start) {
                    adding = nil
                    dismiss()
                }
                .onAppear { if start == .address { model.browser.start() } }
                .onDisappear { model.browser.stop() }
            }
            .confirmationDialog("Sign out of \(leaving?.name ?? "")?", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible, presenting: leaving) { kept in
                Button("Sign out and remove downloads", role: .destructive) {
                    Task { await kept.signOutRemovingDownloads { await model.store.signOut($0) } }
                }
                Button("Sign out, keep downloads") { Task { await model.store.signOut(kept.key) } }
                Button("Cancel", role: .cancel) {}
            } message: { kept in
                Text(kept.message)
            }
        }
    }

    private func signOut(_ record: AccountRecord) {
        if let kept = KeptForAccount.of(record.key, name: record.account.name) {
            leaving = kept
        } else {
            Task { await model.store.signOut(record.key) }
        }
    }
}

extension AddServerFlow.Start: Identifiable {
    public var id: String {
        switch self {
        case .address: "address"
        case .server(let url, let username): "server:\(url.absoluteString):\(username ?? "")"
        case .redeem(let link): "redeem:\(link.id)"
        }
    }
}
