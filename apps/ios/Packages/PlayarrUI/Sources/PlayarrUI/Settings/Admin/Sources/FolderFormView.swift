import PlayarrAPI
import SwiftUI

/// Where the folder is (this server, SSH, SFTP or an SMB share), how to reach it, and the folder itself.
struct FolderFormView: View {
  @State var model: FolderFormModel
  let api: any APISending
  let done: () -> Void

  var body: some View {
    Form {
      Section {
        Picker("Where the folder is", selection: accessBinding) {
          ForEach(FolderFormModel.accessChoices, id: \.access) { choice in
            Text(choice.label).tag(choice.access).selectionDisabled(model.isDisabled(choice.access))
          }
        }
        .pickerStyle(.segmented)
        if model.smb, model.smbOff { Text("\(FolderFormModel.smbOffText).").font(.footnote).foregroundStyle(.danger) }
      }
      if model.remote { connection }
      if let request = model.browsing {
        Section("Folder") {
          FolderBrowserView(
            model: FolderBrowserModel(request: request, start: model.path, rootLabel: model.rootLabel, api: api),
            selected: model.path
          ) { model.path = $0 }
          .id(model.attempt)
        }
      }
      Section {
        TextField("Name", text: $model.name, prompt: Text(model.namePlaceholder))
        if model.source != nil { Toggle("Use this source", isOn: $model.enabled) }
      } footer: {
        Text("Playarr only reads this folder. Songs appear after the first scan.")
      }
      Section {
        if let error = model.error { InlineMessage(text: error) }
        Button(model.saving ? "Saving…" : "Save") { Task { if await model.save() { done() } } }.disabled(!model.canSave)
      }
    }
    .task { await model.loadAccess() }
  }

  private var accessBinding: Binding<FolderAccessKind> {
    Binding(get: { model.access }, set: { model.choose($0) })
  }

  private var connection: some View {
    Section {
      TextField("Host", text: $model.host, prompt: Text("192.168.1.10")).adminURLField()
      TextField("Port", value: $model.port, format: .number.grouping(.never)).adminNumberField()
      TextField("User", text: $model.user).adminPlainField()
      if model.replacingPassword {
        SecureField("Password", text: $model.password, prompt: Text(model.passwordSaved ? "New password" : "Password"))
      } else {
        HStack {
          Text("Password")
          Spacer()
          Text("Saved").font(.body.monospaced()).foregroundStyle(.secondary)
          Button("Replace") { model.replacingPassword = true }.buttonStyle(.borderless)
        }
      }
      if model.smb {
        TextField("Domain", text: $model.domain, prompt: Text("WORKGROUP")).adminPlainField()
      } else {
        TextField("Key file on the server", text: $model.keyPath, prompt: Text(FolderFormModel.keyPathPlaceholder))
          .font(.body.monospaced())
          .adminPlainField()
      }
      Button("Connect") { model.connect() }.disabled(!model.canConnect)
    } footer: {
      Text(
        model.smb
          ? "User: guest for guest access, with the password left empty. Playarr reads the share with rclone. Song analysis and fingerprints run on this server."
          : "The password is optional with a key file on the Playarr server or ssh-agent. SSH also runs song analysis and fingerprints on that machine. SFTP only reads files.")
    }
  }
}
