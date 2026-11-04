import SwiftUI

/// Folders one level at a time: ".." goes up, a folder opens, "Use this folder" chooses the one on screen.
struct FolderBrowserView: View {
  @State var model: FolderBrowserModel
  let selected: String?
  let choose: (String) -> Void

  var body: some View {
    Group {
      HStack {
        if model.canGoUp {
          Button("..") { Task { await model.up() } }
            .buttonStyle(.borderless)
            .accessibilityLabel("Up one folder")
        }
        Text(model.title).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
      }
      ForEach(model.listing?.folders ?? [], id: \.path) { folder in
        Button { Task { await model.open(folder.path) } } label: {
          Label(folder.name, systemImage: "folder").foregroundStyle(.primary)
        }
      }
      if let empty = model.emptyText { Text(empty).font(.footnote).foregroundStyle(.secondary) }
      if let help = model.emptyRootHelp {
        VStack(alignment: .leading, spacing: 4) {
          Text(help.title)
          Text(help.detail).foregroundStyle(.secondary)
        }
        .font(.footnote)
      }
      if let error = model.error { InlineMessage(text: error) }
      if let footer = model.footer(selected: selected), let path = model.choosable {
        HStack {
          Text(footer).font(.caption).foregroundStyle(.secondary)
          Spacer()
          Button("Use this folder") { choose(path) }.buttonStyle(.borderless)
        }
      }
    }
    .task { await model.load() }
  }
}
