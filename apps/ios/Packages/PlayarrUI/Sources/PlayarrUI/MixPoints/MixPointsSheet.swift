import PlayarrAPI
import SwiftUI

/// Edit mix points, as a sheet: the strip with its two markers, a card for each point (its time, set by hand or
/// detected, step buttons for a bar or a phrase, and "Play from"), Reset and Save.
public struct MixPointsSheet: View {
  @State private var model: MixPointsModel
  @Environment(\.dismiss) private var dismiss

  public init(model: MixPointsModel) {
    _model = State(initialValue: model)
  }

  public var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 2) {
            Text(model.track.title).font(.sans(.title3)).lineLimit(1)
            Text(model.track.artistName).font(.sans(.subheadline)).foregroundStyle(.secondary).lineLimit(1)
          }
          if let error = model.error {
            Text("Couldn’t load this song’s mix points: \(error)").foregroundStyle(.danger)
          } else if let editor = model.editor {
            editorView(editor)
          } else if model.loaded {
            Text(MixPointsModel.notAnalysed).font(.sans(.subheadline)).foregroundStyle(.secondary)
          } else {
            RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(height: 96).accessibilityLabel("Loading mix points")
          }
        }
        .padding(20)
      }
      .navigationTitle("Edit mix points")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { Task { if await model.save() { dismiss() } } }
            .disabled(model.editor?.changed != true || model.saving)
        }
      }
    }
    .task { await model.load() }
    .onDisappear { model.close() }
  }

  @ViewBuilder private func editorView(_ editor: MixPointsEditor) -> some View {
    Text(editor.hint).font(.sans(.subheadline)).foregroundStyle(.secondary)
    VStack(alignment: .leading, spacing: 8) {
      Text("Energy through the song").font(.mono(size: 11, relativeTo: .caption2)).textCase(.uppercase).tracking(2).foregroundStyle(.secondary)
      MixPointsStrip(
        editor: editor, phrases: model.phrases, bars: model.bars,
        onDrag: { model.drag($0, to: $1) },
        onStep: { model.step($0, forward: $1, phrase: false) })
      HStack {
        Text("0:00")
        Spacer()
        Text(Format.time(editor.duration))
      }
      .font(.sans(.caption2).monospacedDigit()).foregroundStyle(.secondary)
      Text("The shaded ends are where this song can overlap the songs before and after it; the dashed lines are the points Playarr found on its own.")
        .font(.sans(.caption)).foregroundStyle(.secondary)
    }
    card(editor, .mixIn, label: "Mix in", hint: "Where the song is fully in")
    card(editor, .mixOut, label: "Mix out", hint: "Where the song starts to give way")
    if let error = model.saveError { Text(error).font(.sans(.footnote)).foregroundStyle(.danger) }
    Button("Reset") { Task { await model.reset() } }
      .disabled(!editor.anySet || model.saving)
  }

  private func card(_ editor: MixPointsEditor, _ point: MixPointsEditor.Point, label: String, hint: String) -> some View {
    let beat = editor.bpm > 0
    return VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(label).font(.mono(size: 11, relativeTo: .caption2)).textCase(.uppercase).tracking(1.5).foregroundStyle(.secondary)
        Text(editor.setByHand(point) ? "Set by hand" : "Detected").font(.sans(.caption2)).foregroundStyle(.secondary)
      }
      Text(Format.time(editor.time(point))).font(.sans(.title2).monospacedDigit())
      Text(hint).font(.sans(.caption)).foregroundStyle(.secondary)
      HStack(spacing: 8) {
        stepButton(point, forward: false, phrase: true, icon: "backward.end.alt", label: beat ? "Back a phrase" : "Back 10 seconds")
        stepButton(point, forward: false, phrase: false, icon: "chevron.backward", label: beat ? "Back a bar" : "Back a second")
        stepButton(point, forward: true, phrase: false, icon: "chevron.forward", label: beat ? "On a bar" : "On a second")
        stepButton(point, forward: true, phrase: true, icon: "forward.end.alt", label: beat ? "On a phrase" : "On 10 seconds")
        Spacer()
        Button { model.play(from: point) } label: {
          Label("Play from \(label.lowercased())", systemImage: "play.fill").font(.sans(.footnote))
            .padding(.horizontal, 12).frame(minHeight: 44)
            .overlay(Capsule().strokeBorder(.separator))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(12)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
  }

  private func stepButton(_ point: MixPointsEditor.Point, forward: Bool, phrase: Bool, icon: String, label: String) -> some View {
    Button { model.step(point, forward: forward, phrase: phrase) } label: {
      Image(systemName: icon).frame(width: 36, height: 44)
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(label)
  }
}
