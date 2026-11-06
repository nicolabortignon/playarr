import PlayarrAPI
import SwiftUI

/// "Organize files": the proposed moves by album with a tick each, All and None, Move N files, and Undo.
struct OrganizeView: View {
  @State private var model: OrganizeModel
  @Environment(\.dismiss) private var dismiss

  init(sourceId: Int, api: any APISending, libraryChanged: @escaping @MainActor () -> Void) {
    _model = State(initialValue: OrganizeModel(sourceId: sourceId, api: api, libraryChanged: libraryChanged))
  }

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Organize files")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() } }
          if let plan = model.plan, plan.writable, plan.reason == nil, !plan.moves.isEmpty {
            ToolbarItem(placement: .confirmationAction) {
              Button(model.applyLabel, systemImage: "checkmark", role: .confirm) { Task { await model.apply() } }.disabled(!model.canApply)
            }
          }
        }
    }
    .task { await model.load() }
  }

  @ViewBuilder private var content: some View {
    if let plan = model.plan {
      if let reason = plan.reason {
        Text(reason).padding()
      } else if !plan.writable {
        Text(OrganizeModel.notWritable).padding()
      } else {
        list(plan)
      }
    } else if let error = model.loadError {
      ContentUnavailableView("Organize files", systemImage: "exclamationmark.triangle", description: Text(error))
    } else {
      ProgressView()
    }
  }

  private func list(_ plan: OrganizePlan) -> some View {
    List {
      Section {
        Text(OrganizeModel.intro).font(.footnote).foregroundStyle(.secondary)
        if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
        if let last = model.lastBatchText {
          HStack {
            Text(last).font(.footnote)
            Spacer()
            Button("Undo", systemImage: "arrow.uturn.backward") { Task { await model.undo() } }
              .buttonStyle(.borderless)
              .disabled(model.working)
          }
        }
      }
      if plan.moves.isEmpty {
        Text("Everything is already where it belongs.")
      } else {
        Section {
          HStack {
            Text(model.selectionText).font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Button("All") { model.chooseAll() }.buttonStyle(.borderless)
            Button("None") { model.chooseNone() }.buttonStyle(.borderless)
          }
        }
        ForEach(model.albums, id: \.title) { album in
          Section(album.title) {
            ForEach(album.moves, id: \.from) { move in
              Button { model.toggle(move) } label: { moveRow(move) }.foregroundStyle(.primary)
            }
          }
        }
      }
      if let title = model.skippedTitle {
        Section {
          DisclosureGroup(title) {
            ForEach(plan.skipped, id: \.from) { skip in
              Text("\(skip.from) · \(skip.reason)").font(.caption.monospaced())
            }
          }
        }
      }
    }
  }

  private func moveRow(_ move: OrganizeMove) -> some View {
    HStack(alignment: .top) {
      Image(systemName: model.chosen.contains(move.from) ? "checkmark.square.fill" : "square").foregroundStyle(.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(move.from).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        Label(move.to, systemImage: "arrow.right").lineLimit(1).truncationMode(.middle)
      }
      .font(.caption.monospaced())
      Spacer()
      if !move.confident { Text("GUESS").font(.caption2.monospaced()).foregroundStyle(.secondary) }
    }
    .accessibilityAddTraits(model.chosen.contains(move.from) ? .isSelected : [])
  }
}
