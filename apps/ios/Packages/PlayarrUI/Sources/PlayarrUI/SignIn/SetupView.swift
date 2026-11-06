import SwiftUI

/// A server no one has claimed yet: its owner chooses a username and password (home network only).
struct SetupView: View {
    @Bindable var model: AddServerModel
    @State private var username = ""
    @State private var name = ""
    @State private var password = ""
    @State private var confirm = ""
    let onDone: () -> Void

    var body: some View {
        Form {
            Section {
                Text("No one owns this server yet. Choose the owner’s username and password: the owner changes settings and adds accounts.")
                    .foregroundStyle(.secondary)
            }
            Section {
                TextField("Username", text: $username).playarrUsernameField()
                TextField("Your name", text: $name)
                SecureField("Password", text: $password).playarrPasswordField(new: true)
                SecureField("Confirm password", text: $confirm).playarrPasswordField(new: true)
            } footer: {
                if !confirm.isEmpty, confirm != password {
                    Text("The passwords don’t match.").foregroundStyle(.danger)
                } else if let error = model.error {
                    Text(error).foregroundStyle(.danger)
                }
            }
            Button("Claim this server") { Task { if await model.claim(username: username, name: name, password: password) { onDone() } } }
                .disabled(model.busy || username.isEmpty || name.isEmpty || password.isEmpty || password != confirm)
        }
        .navigationTitle("Set up \(model.connected?.info.name ?? "Playarr")")
    }
}
