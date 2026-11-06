import PlayarrAPI
import SwiftUI

/// Add account or Edit <name>: name, username, role, requests and library. A new account's setup code
/// then shows in the same sheet.
struct AccountFormView: View {
  let title: String
  let submitLabel: String
  @State var form: AccountFormModel
  @Bindable var model: AccountsModel
  let submit: (AccountFormModel) async -> Bool
  @State private var code: AccountsModel.SetupShown?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      if let code {
        SetupCodeView(shown: code) { dismiss() }
      } else {
        fields
      }
    }
  }

  private var fields: some View {
    Form {
      Section {
        TextField("Name", text: $form.name).accessibilityIdentifier("account.name")
        TextField("Username", text: $form.username).adminPlainField().accessibilityIdentifier("account.username")
        if let problem = form.usernameProblem { Text(problem).font(.footnote).foregroundStyle(.danger) }
      }
      Section("Role") {
        Picker("Role", selection: $form.role) {
          Text("Member: listens").tag(AccountRole.member)
          Text("Admin: also changes settings, sources and accounts").tag(AccountRole.admin)
        }
        .pickerStyle(.inline)
        .labelsHidden()
      }
      Section {
        Toggle("Can request albums", isOn: $form.canRequest).accessibilityIdentifier("account.canRequest")
      }
      if form.role == .member {
        Section("May change on their devices") {
          ForEach(AccountFormModel.deviceSettings, id: \.label) { item in
            Toggle(item.label, isOn: Binding(get: { form.mayChange(item.setting) }, set: { form.setMayChange(item.setting, $0) }))
          }
        }
      }
      Section("Library") {
        Picker("Library", selection: $form.everySource) {
          Text("Every source").tag(true)
          Text("Only these sources").tag(false)
        }
        .pickerStyle(.inline)
        .labelsHidden()
        if !form.everySource {
          ForEach(form.sources) { source in
            Button { form.toggle(source) } label: {
              Label(source.name, systemImage: form.isPicked(source) ? "checkmark.square.fill" : "square")
            }
            .accessibilityAddTraits(form.isPicked(source) ? .isSelected : [])
          }
        }
      }
      if let error = model.error { Section { InlineMessage(text: error) } }
    }
    .navigationTitle(title)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      ToolbarItem(placement: .confirmationAction) {
        Button(submitLabel) {
          Task {
            guard await submit(form) else { return }
            if let shown = model.setupShown {
              model.setupShown = nil
              code = shown
            } else {
              dismiss()
            }
          }
        }
        .disabled(!form.canSubmit || model.busy)
        .accessibilityIdentifier("account.submit")
      }
    }
  }
}
