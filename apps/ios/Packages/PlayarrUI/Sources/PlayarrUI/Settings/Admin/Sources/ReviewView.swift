import PlayarrAPI
import SwiftUI

/// "Review matches": one doubtful album at a time, with its MusicBrainz candidates, the edition's details,
/// your files beside its songs, a search, "Fix names", "Leave unmatched" and "Use this album".
struct ReviewView: View {
  @State private var model: ReviewModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  init(sourceId: Int, api: any APISending, sourcesChanged: @escaping @MainActor () -> Void) {
    _model = State(initialValue: ReviewModel(sourceId: sourceId, api: api, sourcesChanged: sourcesChanged))
  }

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Review matches")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() } } }
    }
    .task(id: model.pollRound) { await model.poll() }
  }

  @ViewBuilder private var content: some View {
    if model.groups == nil, let error = model.loadError {
      ContentUnavailableView {
        Label("Couldn’t load the albums to review", systemImage: "exclamationmark.triangle")
      } description: {
        Text(error)
      } actions: {
        Button("Try again") { Task { await model.load() } }
      }
    } else if model.groups == nil {
      ProgressView()
    } else if let group = model.current {
      groupForm(group).id(group.groupKey)
    } else {
      List {
        savedNote
        Text("Nothing left to review.")
      }
    }
  }

  @ViewBuilder private var savedNote: some View {
    if let saved = model.saved {
      if case .failed = saved.state {
        InlineMessage(text: saved.line)
      } else {
        Text(saved.line).font(.footnote).foregroundStyle(.secondary)
      }
    }
  }

  private func groupForm(_ group: ReviewGroup) -> some View {
    Form {
      Section {
        savedNote
        LabeledContent("Your files say") {
          Text(ReviewText.yourAlbum(group))
        }
        Text("\(model.remaining) to review").font(.caption.monospaced()).foregroundStyle(.secondary)
        if group.notFound == true {
          Label("Not found on MusicBrainz", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.warning)
        }
      }
      Section("Albums on MusicBrainz") {
        if group.candidates.isEmpty {
          Text("No albums found on MusicBrainz for these names. Search with other names below (the artist may go by another name there), or fix the names yourself.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        ForEach(group.candidates, id: \.releaseId) { candidate in
          Button { model.chosen = candidate.releaseId } label: { candidateRow(candidate) }
            .foregroundStyle(.primary)
        }
      }
      .disabled(model.searching)
      if let candidate = model.candidate {
        Section("This edition") {
          ForEach(ReviewText.details(candidate), id: \.label) { row in
            LabeledContent(row.label) {
              if let value = row.value { Text(value) } else { ProgressView() }
            }
          }
          if !candidate.detailed {
            Text("Getting this edition’s details from MusicBrainz…").font(.caption).foregroundStyle(.secondary)
          }
          if let url = ReviewText.musicBrainzURL(candidate) {
            Button("Open on MusicBrainz", systemImage: "arrow.up.right.square") { openURL(url) }
          }
        }
        Section("Your file · On MusicBrainz") {
          ForEach(group.files, id: \.rel) { file in
            VStack(alignment: .leading, spacing: 2) {
              Text("\(file.title) \(AdminText.time(file.duration))").foregroundStyle(.secondary)
              Text(ReviewText.matched(file, in: candidate) ?? "not on this album")
                .foregroundStyle(ReviewText.matched(file, in: candidate) == nil ? .secondary : .primary)
            }
          }
        }
      }
      Section {
        TextField("Artist", text: $model.artist).disabled(model.searching)
        TextField("Album", text: $model.album).disabled(model.searching)
        Button(model.searching ? "Searching…" : "Search", systemImage: "magnifyingglass") { Task { await model.search() } }
          .disabled(!model.canSearch)
        if let error = model.error { InlineMessage(text: error) }
      }
      if model.fixing {
        Section {
          ForEach(group.files, id: \.rel) { file in
            TextField(file.rel.split(separator: "/").last.map(String.init) ?? file.rel, text: titleBinding(file.rel))
          }
          Button("Save names", systemImage: "checkmark") { Task { await model.saveNames() } }.disabled(!model.canRename)
          Button("Cancel") { model.fixing = false }
        } header: {
          Text("Songs")
        } footer: {
          Text("Used instead of what the files say, for this album only. The files themselves aren’t changed.")
        }
      }
      Section {
        if !model.fixing {
          Button("Fix names", systemImage: "pencil.line") { model.fixing = true }.disabled(model.searching)
        }
        Button("Leave unmatched") { Task { await model.leaveUnmatched() } }.disabled(model.searching)
        Button("Use this album", systemImage: "checkmark") { Task { await model.useChosen() } }
          .disabled(model.searching || model.candidate == nil)
          .bold()
      }
    }
  }

  private func candidateRow(_ candidate: ReviewCandidate) -> some View {
    HStack(alignment: .top) {
      Image(systemName: candidate.releaseId == model.chosen ? "largecircle.fill.circle" : "circle").foregroundStyle(.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(candidate.disambiguation.map { "\(candidate.title) (\($0))" } ?? candidate.title)
        Text(ReviewText.summary(candidate)).font(.footnote).foregroundStyle(.secondary)
      }
      Spacer()
      Text(ReviewText.score(candidate)).font(.caption.monospaced()).foregroundStyle(.secondary)
    }
    .accessibilityAddTraits(candidate.releaseId == model.chosen ? .isSelected : [])
  }

  private func titleBinding(_ rel: String) -> Binding<String> {
    Binding(get: { model.titles[rel] ?? "" }, set: { model.titles[rel] = $0 })
  }
}
