import PlayarrAPI
import SwiftUI

/// Settings → Sources: the sources in priority order (drag to reorder), each with its ⋯ menu in words (`SourceMenu`:
/// Sync now, Match again, Organize files, Edit, Move up, Move down, Remove); review of doubtful matches; the AcoustID
/// key; the MusicBrainz queue. A member reads it, and is told only an admin can change it.
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
        if !model.canEdit { AdminOnlyNotice() }
        Section {
          if model.sources.isEmpty {
            Text("No sources yet. Add Lidarr or a folder to start your library.").foregroundStyle(.secondary)
          }
          let sources = model.sources
          ForEach(Array(sources.enumerated()), id: \.element.id) { index, source in
            row(source, at: index, of: sources.count)
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
      // In the text color, as every bar's Edit: the accent on the bar's glass can fall under 4.5:1.
      if model.canEdit, model.sources.count > 1 { EditButton().tint(Color.paper) }
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
  }

  /// A source, its name and where it is (whole, wrapping rather than cut short), its counts and how it's doing, with its
  /// ⋯ for an admin.
  private func row(_ source: SourceInfo, at index: Int, of count: Int) -> some View {
    let status = SourceText.status(source)
    let menu = model.canEdit ? groups(source, at: index, of: count) : []
    let matches = SourceText.matchSummary(source)
    return HStack(alignment: .top, spacing: 12) {
      // What it is is in its words (a path, an address): the glyph is decoration.
      Image(systemName: SourceText.isRemote(source) ? "network" : source.kind == .folder ? "folder" : "server.rack")
        .foregroundStyle(.tint)
        .frame(width: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        HStack {
          Text(source.name).font(.body)
          if !source.enabled { Text("OFF").font(.caption2.monospaced()).foregroundStyle(.secondary) }
        }
        // Where it is, then its counts: wrapping between them, never inside "0 songs".
        Text(Format.wrapsAtDots(SourceText.details(source))).font(.caption.monospaced()).foregroundStyle(.secondary)
        if let summary = SourceText.albumSummary(source) {
          // Wrapping between counters, never inside one ("on complete albums" doesn't break word by word).
          Text(Format.wrapsAtDots(summary.map { "\($0.count) \($0.label)" }.joined(separator: " · ")))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("\(source.kind == .folder ? "Songs" : "Albums"): \(summary.map { "\($0.count) \($0.label)" }.joined(separator: ", "))")
        }
        Text(status.text).font(.caption).foregroundStyle(color(status.tone))
        if let matches {
          HStack(spacing: 6) {
            Text(matches.matched)
            if let notMatched = matches.notMatched {
              Text("·").accessibilityHidden(true)
              if model.canEdit {
                Button(notMatched) { sheet = .review(source.id) }
                  .buttonStyle(.borderless)
                  .foregroundStyle(.tint)
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
          // Read as one line; matching the rest by hand is one of the row's actions.
          .accessibilityElement(children: .ignore)
          .accessibilityLabel([matches.matched, matches.notMatched, matches.leftAsTagged].compactMap(\.self).joined(separator: ", "))
        }
      }
      // One element for VoiceOver, its lines read in order, with Review matches and the ⋯'s items as its actions,
      // rather than lines that each answer the row's long press with a target too small to aim at.
      .accessibilityElement(children: .combine)
      .accessibilityActions {
        if model.canEdit, matches?.notMatched != nil {
          Button("Review matches") { sheet = .review(source.id) }
        }
        ForEach(menu.flatMap(\.self)) { action in
          Button(action.title, action: action.perform)
        }
      }
      Spacer(minLength: 0)
      if source.syncing { ProgressView() }
      if !menu.isEmpty { MoreMenu(title: "“\(source.name)”", groups: menu) }
    }
    .contextMenu { if !menu.isEmpty { MenuButtons(groups: menu) } }
    // Asked from its row (Remove is in its menu and its swipe actions), so a phone's popover points at the source.
    .confirmLoss(Binding(get: { removing?.id == source.id ? removing : nil }, set: { removing = $0 }), question: SourceText.removeQuestion) { source in
      Task { await model.remove(source) }
    }
    .swipeActions(edge: .trailing) {
      if model.canEdit {
        Button("Remove", systemImage: "trash", role: .destructive) { removing = source }
        Button("Edit", systemImage: "pencil") { sheet = .edit(source) }
      }
    }
    .swipeActions(edge: .leading) {
      if model.canEdit, !source.syncing {
        Button(MenuAction.Kind.syncNow.title, systemImage: MenuAction.Kind.syncNow.systemImage) { Task { await model.rescan(source) } }
      }
    }
  }

  /// The source's ⋯, its long press and VoiceOver's: the same items in the same order.
  private func groups(_ source: SourceInfo, at index: Int, of count: Int) -> [[MenuAction]] {
    SourceMenu.groups(
      source, at: index, of: count, rematching: model.rematching.contains(source.id),
      actions: SourceMenu.Actions(
        syncNow: { Task { await model.rescan(source) } },
        matchAgain: { Task { await model.rematch(source) } },
        organize: { sheet = .organize(source.id) },
        edit: { sheet = .edit(source) },
        move: { offset in Task { await model.move(source, by: offset) } },
        remove: { removing = source }))
  }

  private func color(_ tone: SourceText.Tone) -> Color {
    switch tone {
    case .accent: .accentColor
    case .error: .danger
    case .muted: .secondary
    }
  }
}
