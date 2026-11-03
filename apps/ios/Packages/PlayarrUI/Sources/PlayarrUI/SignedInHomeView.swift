import PlayarrAPI
import SwiftUI

/// Phase 2's home: who is signed in where, and the library's size (GET /api/health).
struct SignedInHomeView: View {
    @Bindable var model: AppModel
    @State private var stats: LibraryStats?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                if let account = model.store.activeAccount, let server = model.store.activeServer {
                    Text("Signed in as \(account.account.name) on \(server.name)").font(.headline)
                }
                if let stats {
                    Text("\(stats.artists) artists · \(stats.albums) albums · \(stats.tracks) songs").foregroundStyle(.secondary)
                } else if let error {
                    Text(error).foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .padding()
            .navigationTitle("Playarr")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Accounts", systemImage: "person.crop.circle") { model.showingAccounts = true }
                }
            }
            .sheet(isPresented: $model.showingAccounts) { AccountSwitcherView(model: model) }
            .task(id: model.store.active) { await load() }
        }
        #if DEBUG
            .playerLab(for: model)
        #endif
    }

    private func load() async {
        stats = nil
        error = nil
        guard let client = model.store.activeClient else { return }
        do {
            stats = try await client.send(API.Server.health()).library
        } catch {
            self.error = error.localizedDescription
        }
    }
}
