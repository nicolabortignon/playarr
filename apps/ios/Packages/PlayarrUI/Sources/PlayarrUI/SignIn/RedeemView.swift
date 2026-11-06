import SwiftUI

/// A setup code from an admin, and the account's first password.
struct RedeemView: View {
    @Bindable var model: AddServerModel
    @State var code: String
    @State private var password = ""
    @State private var confirm = ""
    let onDone: () -> Void

    init(model: AddServerModel, code: String, onDone: @escaping () -> Void) {
        self.model = model
        _code = State(initialValue: code)
        self.onDone = onDone
    }

    var body: some View {
        Form {
            Section {
                TextField("Setup code", text: $code).playarrCodeField()
                SecureField("Password", text: $password).playarrPasswordField(new: true)
                SecureField("Confirm password", text: $confirm).playarrPasswordField(new: true)
            } footer: {
                if !confirm.isEmpty, confirm != password {
                    Text("The passwords don’t match.").foregroundStyle(.danger)
                } else if let error = model.error {
                    Text(error).foregroundStyle(.danger)
                }
            }
            Button(model.busy ? "Signing in…" : "Set password and sign in") { Task { if await model.redeem(code: code, password: password) { onDone() } } }
                .disabled(model.busy || code.isEmpty || password.isEmpty || password != confirm)
        }
        .navigationTitle("Set your password")
    }
}
