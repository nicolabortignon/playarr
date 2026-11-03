import PlayarrAPI
import SwiftUI

/// Every server and its accounts: switch with a tap (no password), add an account or a server, sign out.
struct AccountSwitcherView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var adding: AddServerFlow.Start?

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
                                        Text(record.signedIn ? "@\(record.account.username)" : "Signed out").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if record.key == model.store.active { Image(systemName: "checkmark") }
                                }
                            }
                            .swipeActions {
                                Button("Sign out", role: .destructive) { Task { await model.store.signOut(record.key) } }
                            }
                            .contextMenu {
                                Button("Sign out", role: .destructive) { Task { await model.store.signOut(record.key) } }
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
