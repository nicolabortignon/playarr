import PlayarrAPI
import SwiftUI

/// Settings → Sources: the sources in priority order (drag to reorder), each with Rescan, Match again,
/// Organize files, Edit and Remove; review of doubtful matches; the AcoustID key; the MusicBrainz queue.
public struct SourcesPanel: View {
  enum Sheet: Identifiable {
    case add, edit(SourceInfo), review(Int), organize(Int)

    var id: String {
      switch self {
      case .add: "add"
      case .edit(let source): "edit-\(source.id)"
      case .review(let id): "review-\(id)"
      case .organize(let id): "organize-\(id)"
      }
    }
  }

  @State private var model: SourcesModel
  @State private var matching: MatchingModel
  @State private var sheet: Sheet?
  @State private var removing: SourceInfo?
  private let api: any APISending
  private let libraryChanged: @MainActor () -> Void

  public init(api: any APISending, libraryChanged: @escaping @MainActor () -> Void = {}) {
    self.api = api
    self.libraryChanged = libraryChanged
    _model = State(initialValue: SourcesModel(api: api, libraryChanged: libraryChanged))
    _matching = State(initialValue: MatchingModel(api: api))
  }

  public var body: some View {
    List {
      Section {
        Text("Where your music comes from. When a song is in more than one place, Playarr plays the best-quality copy; between equal copies, the source higher in this list wins.")
          .font(.footnote)
          .foregroundStyle(.secondary)
        MusicBrainzIndicator()
        if let error = model.error { InlineMessage(text: error) }
      }
      if !model.loaded, let error = model.loadError {
        Section { InlineMessage(text: error) }
      } else if !model.loaded {
        Section { ProgressView() }
      } else {
        Section {
          if model.sources.isEmpty {
            Text("No sources yet. Add Lidarr or a folder to start your library.").foregroundStyle(.secondary)
          }
          ForEach(model.sources) { source in
            row(source)
          }
          .onMove(perform: model.canEdit ? { from, to in Task { await model.move(fromOffsets: from, toOffset: to) } } : nil)
          if model.canEdit {
            Button("Add source", systemImage: "plus") { sheet = .add }
          }
        }
        if model.canEdit, model.hasFolder {
          MatchingSection(model: matching)
        }
      }
    }
    .navigationTitle("Sources")
    .toolbar {
      #if os(iOS)
      if model.canEdit, model.sources.count > 1 { EditButton() }
      #endif
    }
    .task { await model.poll() }
    .task { await matching.load() }
    .refreshable { await model.load() }
    .sheet(item: $sheet) { sheet in
      switch sheet {
      case .add: SourceFormView(source: nil, hasLidarr: model.hasLidarr, api: api) { Task { await model.saved() } }
      case .edit(let source): SourceFormView(source: source, hasLidarr: model.hasLidarr, api: api) { Task { await model.saved() } }
      case .review(let id): ReviewView(sourceId: id, api: api) { Task { await model.load() } }
      case .organize(let id): OrganizeView(sourceId: id, api: api, libraryChanged: libraryChanged)
      }
    }
    .confirmationDialog(removing.map(SourceText.removeTitle) ?? "", isPresented: removingBinding, titleVisibility: .visible, presenting: removing) { source in
      Button("Remove", role: .destructive) { Task { await model.remove(source) } }
    } message: { _ in
      Text(SourceText.removeMessage)
    }
  }

  private var removingBinding: Binding<Bool> {
    Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
  }

  private func row(_ source: SourceInfo) -> some View {
    let status = SourceText.status(source)
    return HStack(alignment: .top, spacing: 12) {
      Image(systemName: SourceText.isRemote(source) ? "network" : source.kind == .folder ? "folder" : "server.rack")
        .foregroundStyle(.tint)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 2) {
        HStack {
          Text(source.name).font(.body)
          if !source.enabled { Text("OFF").font(.caption2.monospaced()).foregroundStyle(.secondary) }
        }
        Text(SourceText.details(source)).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
        if let summary = SourceText.albumSummary(source) {
          Text(summary.map { "\($0.count) \($0.label)" }.joined(separator: " · "))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("\(source.kind == .folder ? "Songs" : "Albums"): \(summary.map { "\($0.count) \($0.label)" }.joined(separator: ", "))")
        }
        Text(status.text).font(.caption).foregroundStyle(color(status.tone)).lineLimit(2)
        if let matches = SourceText.matchSummary(source) {
          HStack(spacing: 6) {
            Text(matches.matched)
            if let notMatched = matches.notMatched {
              Text("·").accessibilityHidden(true)
              if model.canEdit {
                Button(notMatched) { sheet = .review(source.id) }
                  .buttonStyle(.borderless)
                  .foregroundStyle(.tint)
                  .accessibilityHint("Match them by hand")
              } else {
                Text(notMatched)
              }
            }
            if let leftAsTagged = matches.leftAsTagged {
              Text("·").accessibilityHidden(true)
              Text(leftAsTagged)
            }
          }
          .font(.footnote)
          .foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
      if source.syncing { ProgressView() }
    }
    .contextMenu { if model.canEdit { actions(source) } }
    .swipeActions(edge: .trailing) {
      if model.canEdit {
        Button("Remove", systemImage: "trash", role: .destructive) { removing = source }
        Button("Edit", systemImage: "pencil") { sheet = .edit(source) }
      }
    }
    .swipeActions(edge: .leading) {
      if model.canEdit {
        Button("Rescan", systemImage: "arrow.clockwise") { Task { await model.rescan(source) } }.disabled(source.syncing)
      }
    }
  }

  @ViewBuilder private func actions(_ source: SourceInfo) -> some View {
    Button("Rescan", systemImage: "arrow.clockwise") { Task { await model.rescan(source) } }.disabled(source.syncing)
    if source.kind == .folder {
      Button("Match again", systemImage: "arrow.trianglehead.2.clockwise") { Task { await model.rematch(source) } }
        .disabled(model.rematching.contains(source.id))
      // Offered even when the folder isn't writable: the sheet explains why nothing can move.
      Button("Organize files", systemImage: "folder.badge.gearshape") { sheet = .organize(source.id) }
    }
    Button("Edit", systemImage: "pencil") { sheet = .edit(source) }
    Button("Remove", systemImage: "trash", role: .destructive) { removing = source }
  }

  private func color(_ tone: SourceText.Tone) -> Color {
    switch tone {
    case .accent: .accentColor
    case .error: .red
    case .muted: .secondary
    }
  }
}
