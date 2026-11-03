import PlayarrAPI
import SwiftUI

/// Track menu → Show metadata: the song's fields and ids, each file with its source (and path, for admins), the
/// file's tags, the sound analysis, and "Match again on MusicBrainz" or "Refresh in Lidarr" (admins).
public struct TrackMetadataSheet: View {
  @State private var model: TrackMetadataModel
  @Environment(\.dismiss) private var dismiss

  public init(model: TrackMetadataModel) {
    _model = State(initialValue: model)
  }

  public var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          if let error = model.error, model.metadata == nil {
            Text("Couldn’t load this song’s metadata: \(error)").foregroundStyle(.red)
          } else if let m = model.metadata {
            content(m)
          } else {
            VStack(alignment: .leading, spacing: 12) {
              RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(height: 32)
              RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(height: 160)
              RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(height: 128)
            }
            .accessibilityLabel("Loading metadata")
          }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .navigationTitle("Song metadata")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .task(id: model.trackId) { await model.load() }
  }

  @ViewBuilder private func content(_ m: TrackMetadata) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(m.title).font(.title3)
      Text("\(m.artistName) · \(m.albumTitle)").font(.subheadline).foregroundStyle(.secondary)
      if let primary = model.primary { rematch(primary) }
      if m.pathsHidden { Text(MetadataFormat.rematchHiddenNote).font(.footnote).foregroundStyle(.secondary).padding(.top, 8) }
    }
    section("Song") { rows(MetadataFormat.song(m)) }
    section(m.copies.count == 1 ? "File" : "Files (\(m.copies.count))") {
      if m.pathsHidden { Text(MetadataFormat.pathsHiddenNote).font(.footnote).foregroundStyle(.secondary) }
      ForEach(m.copies, id: \.fileId) { copyCard($0) }
    }
    if let analysis = m.analysis {
      section("Sound") { rows(MetadataFormat.sound(analysis)) }
    }
  }

  private func copyCard(_ c: TrackCopyMetadata) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Text(c.source.name)
        if let location = c.source.location { Text("· \(location)").foregroundStyle(.secondary).font(.footnote) }
        Spacer()
        if c.playing {
          Label("Plays", systemImage: "play.fill")
            .font(.system(size: 10, design: .monospaced)).textCase(.uppercase)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(.tint.opacity(0.15), in: Capsule()).foregroundStyle(.tint)
        }
      }
      rows(MetadataFormat.copy(c))
      if model.offersRematch(for: c) { rematch(c) }
      if let tags = c.tags {
        DisclosureGroup("Tags in the file") { rows(MetadataFormat.tags(tags)).padding(.top, 6) }
          .font(.system(size: 11, design: .monospaced)).textCase(.uppercase)
      }
    }
    .padding(12)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
  }

  private func rematch(_ c: TrackCopyMetadata) -> some View {
    let lidarr = c.source.kind == .lidarr
    let busy = model.rematching == c.fileId
    return VStack(alignment: .leading, spacing: 8) {
      Button { Task { await model.rematch(c) } } label: {
        HStack(spacing: 8) {
          if busy { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.clockwise") }
          Text(MetadataFormat.rematchLabel(lidarr: lidarr, busy: busy))
        }
        .font(.footnote)
        .padding(.horizontal, 14).frame(height: 32)
        .overlay(Capsule().strokeBorder(.separator))
      }
      .buttonStyle(.plain)
      .disabled(model.rematching != nil)
      if busy && !lidarr { SlowLookup(what: "this album") }
      if let outcome = model.outcomes[c.fileId] {
        Text(outcome.text).font(.footnote).foregroundStyle(outcome.isError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
      }
    }
    .padding(.top, 8)
  }

  private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(2).foregroundStyle(.secondary)
        .accessibilityAddTraits(.isHeader)
      content()
    }
  }

  private func rows(_ rows: [MetadataFormat.Row]) -> some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 6) {
      ForEach(rows) { row in
        GridRow {
          Text(row.label).font(.system(size: 11, design: .monospaced)).textCase(.uppercase).foregroundStyle(.secondary)
          value(row.value).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  @ViewBuilder private func value(_ value: MetadataFormat.Value) -> some View {
    switch value {
    case .text(let text):
      Text(text).textSelection(.enabled)
    case .musicBrainz(let id, let kind):
      if let url = MetadataFormat.musicBrainzURL(id: id, kind: kind) {
        Link(destination: url) { Label(id, systemImage: "arrow.up.right.square").labelStyle(TrailingIcon()) }
          .font(.system(size: 12, design: .monospaced))
      } else {
        Text("\(id) (not on MusicBrainz yet)").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
      }
    case .path(let path):
      HStack(alignment: .top, spacing: 8) {
        Text(path).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
        Button { Pasteboard.copy(path) } label: { Image(systemName: "doc.on.doc") }
          .buttonStyle(.borderless)
          .accessibilityLabel("Copy path")
      }
    case .meter(let percent):
      HStack(spacing: 8) {
        ProgressView(value: Double(percent), total: 100).frame(width: 128)
        Text("\(percent)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityValue("\(percent) percent")
    }
  }
}

/// A label with its icon after the text, as the web's external-link mark.
private struct TrailingIcon: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 4) { configuration.title; configuration.icon }
  }
}
