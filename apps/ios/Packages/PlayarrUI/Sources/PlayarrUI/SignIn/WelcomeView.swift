import PlayarrAPI
import SwiftUI

/// Add a server: the ones Bonjour finds on the home network, or an address.
struct WelcomeView: View {
    @Bindable var model: AddServerModel
    let onConnected: () -> Void

    var body: some View {
        Form {
            Section {
                if model.discovered.isEmpty {
                    Label("Looking for servers on your network…", systemImage: "antenna.radiowaves.left.and.right")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.discovered) { server in
                    Button {
                        Task { if await model.connect(to: server.baseURL) { onConnected() } }
                    } label: {
                        LabeledContent(server.name, value: model.isAdded(server) ? "Added" : server.baseURL.host() ?? "")
                    }
                    .disabled(model.busy)
                }
            } header: {
                Text("On your network")
            }

            Section {
                TextField("Server address", text: $model.address, prompt: Text("https://music.example.com"))
                    .playarrAddressField()
                    .onSubmit(connect)
                Button("Connect", action: connect)
                    .disabled(model.busy || model.address.trimmingCharacters(in: .whitespaces).isEmpty)
            } header: {
                Text("Or type its address")
            } footer: {
                if let error = model.error { Text(error).foregroundStyle(.danger) }
            }

            Section {
            } footer: {
                Text("Version \(model.appVersion.label)").accessibilityIdentifier("version")
            }
        }
        .navigationTitle("Add a server")
        .overlay { if model.busy { ProgressView() } }
    }

    private func connect() {
        Task { if await model.connect() { onConnected() } }
    }
}
