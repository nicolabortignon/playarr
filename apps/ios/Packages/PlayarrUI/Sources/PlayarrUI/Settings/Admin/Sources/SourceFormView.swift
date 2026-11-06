import PlayarrAPI
import SwiftUI

/// Add source (choose Lidarr or a folder) or Edit <name>.
struct SourceFormView: View {
  let source: SourceInfo?
  let hasLidarr: Bool
  let api: any APISending
  let onSaved: () -> Void
  @State private var kind: SourceKind?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        switch source?.kind ?? kind {
        case .lidarr: LidarrFormView(model: LidarrFormModel(source: source, api: api), done: done)
        case .folder: FolderFormView(model: FolderFormModel(source: source, api: api), api: api, done: done)
        default: chooser
        }
      }
      .navigationTitle(source.map { "Edit \($0.name)" } ?? "Add source")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() } } }
    }
  }

  private var chooser: some View {
    List {
      Button { kind = .lidarr } label: {
        option("server.rack", "Lidarr", hasLidarr ? "Playarr connects to one Lidarr, and it’s already added." : "Your Lidarr library, with requests.")
      }
      .disabled(hasLidarr)
      Button { kind = .folder } label: {
        option("folder", "Folder", "Music in a folder: on this server, another machine over SSH or SFTP, or an SMB share. Playarr only reads it.")
      }
    }
  }

  private func option(_ icon: String, _ title: String, _ detail: String) -> some View {
    Label {
      VStack(alignment: .leading) {
        Text(title)
        Text(detail).font(.footnote).foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: icon)
    }
  }

  private func done() {
    onSaved()
    dismiss()
  }
}
