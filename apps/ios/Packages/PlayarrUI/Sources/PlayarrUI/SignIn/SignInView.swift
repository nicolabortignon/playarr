import SwiftUI

/// Sign in to a server with a username and password.
struct SignInView: View {
    @Bindable var model: AddServerModel
    @State var username: String
    @State private var password = ""
    let onDone: () -> Void
    var onSetupCode: (() -> Void)?

    init(model: AddServerModel, username: String, onDone: @escaping () -> Void, onSetupCode: (() -> Void)? = nil) {
        self.model = model
        _username = State(initialValue: username)
        self.onDone = onDone
        self.onSetupCode = onSetupCode
    }

    var body: some View {
        Form {
            Section {
                TextField("Username", text: $username).playarrUsernameField()
                SecureField("Password", text: $password).playarrPasswordField(new: false)
            } footer: {
                if let error = model.error { Text(error).foregroundStyle(.danger) }
            }
            Section {
                Button("Sign in") { Task { if await model.signIn(username: username, password: password) { onDone() } } }
                    .disabled(model.busy || username.isEmpty || password.isEmpty)
                if let onSetupCode {
                    Button("I have a setup code", action: onSetupCode)
                }
            }
        }
        .navigationTitle("Sign in to \(model.connected?.info.name ?? "Playarr")")
    }
}
