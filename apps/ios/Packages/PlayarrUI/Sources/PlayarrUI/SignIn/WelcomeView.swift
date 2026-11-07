import PlayarrAPI
import SwiftUI

/// Add a server: the ones Bonjour finds on the home network, or an address. Before any server is known, what Playarr
/// is first, how to set one up, and the demo library to try meanwhile (plan 4 §1).
struct WelcomeView: View {
    @Bindable var model: AddServerModel
    let onConnected: () -> Void

    var body: some View {
        Form {
            if model.offersTrial { newToPlayarr }
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
                Button(model.busy ? "Connecting…" : "Connect", action: connect)
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

    /// What Playarr is and what it needs, how to set a server up, and the demo to look around meanwhile.
    private var newToPlayarr: some View {
        Section {
            Text("Playarr plays your own music from a server you run at home, on a NAS or a computer, with your music in a folder or in Lidarr. The app has no music of its own: it connects to that server.")
                .foregroundStyle(.paperDim)
            Link(destination: AppModel.setUpURL) {
                Label("How to set up a server", systemImage: "arrow.up.right.square")
            }
            Button("Try it without a server", systemImage: "play.circle", action: model.tryWithoutServer)
        } header: {
            Text("New to Playarr?")
        } footer: {
            Text("The demo is a made-up library, kept on this device, whose songs play silence.")
        }
    }
}
