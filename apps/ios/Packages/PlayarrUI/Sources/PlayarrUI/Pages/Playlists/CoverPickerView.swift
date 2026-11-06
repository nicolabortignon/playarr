import PlayarrAPI
import SwiftUI

/// "New cover": one candidate per style from the server, Shuffle for others, "Use this" to keep the chosen one, and
/// under them what the chosen style draws and what the songs are like (apps/web/src/components/CoverPicker.tsx; kept
/// here, off the playlist's header, so Play comes first).
struct CoverPickerView: View {
  let playlist: PlaylistModel
  @State private var picker: CoverPickerModel
  @Environment(\.dismiss) private var dismiss
  @Environment(Theme.self) private var theme

  init(playlist: PlaylistModel, detail: PlaylistDetail) {
    self.playlist = playlist
    _picker = State(initialValue: CoverPickerModel(playlist: detail))
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        Text(picker.intro).font(.sans(.subheadline)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 16) {
          ForEach(CoverPickerModel.styles, id: \.layout) { style in
            let chosen = picker.chosen == style.layout
            Button { picker.chosen = style.layout } label: {
              VStack(alignment: .leading, spacing: 6) {
                // Some styles take a few seconds to draw: the cover's stand-in shows until they arrive.
                Cover(path: picker.preview(style.layout), points: 170, label: style.label, corner: 6)
                  .id("\(style.layout.rawValue)-\(picker.variant)")
                  .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(chosen ? theme.accent.color : .clear, lineWidth: 3))
                Kicker(text: style.label)
              }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(style.label) cover")
            .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
          }
        }
        .padding(.top, 8)
        AboutThisCover(note: picker.note, story: CoverNote.story(picker.chosen))
          .padding(.top, 24)
      }
      .padding(20)
      .navigationTitle("New cover")
      .toolbar {
        // Each with an icon: on the iPhone Duo's cover screen a full-height sheet's bar buttons move to the column down
        // the right, where buttons with words only don't show (docs/design.md, "Headers").
        ToolbarItem(placement: .cancellationAction) { Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() } }
        ToolbarItem(placement: .secondaryAction) { Button("Shuffle", systemImage: "dice") { picker.shuffle() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Use this", systemImage: "checkmark", role: .confirm) {
            Task { if await playlist.setCover(layout: picker.chosen, variant: picker.variant) { dismiss() } }
          }
          .disabled(playlist.busy)
        }
      }
    }
    // A picker: half the screen at first, the rest a drag away.
    .presentationDetents([.medium, .large])
  }
}

/// About this cover: what the chosen style draws, from what the songs are like (their tempo, styles, years, energy);
/// while the songs are still being listened to, how far along that is.
private struct AboutThisCover: View {
  let note: CoverNote
  /// What the chosen style draws.
  let story: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Kicker(text: "About this cover").accessibilityAddTraits(.isHeader)
      if let listening = note.listening {
        Label(listening, systemImage: "circle.fill")
          .symbolEffect(.pulse)
          .typeRole(.small)
          .foregroundStyle(.paperDim)
      } else {
        Text(story).typeRole(.small).foregroundStyle(.paperDim)
        Text(note.facts).typeRole(.meta).foregroundStyle(.muted)
      }
      if note.stale {
        Text("The playlist has changed a lot since its cover was drawn.").typeRole(.small).foregroundStyle(.paperDim)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 20)
    .overlay(alignment: .top) { Rectangle().fill(.line).frame(height: 1) }
  }
}
