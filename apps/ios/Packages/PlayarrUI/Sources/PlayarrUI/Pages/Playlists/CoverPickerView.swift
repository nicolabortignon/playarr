import PlayarrAPI
import SwiftUI

/// "New cover": one candidate per style from the server, Shuffle for others, "Use this" to keep the chosen one
/// (apps/web/src/components/CoverPicker.tsx).
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
        Text(picker.intro).font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
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
      }
      .padding(20)
      .navigationTitle("New cover")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .secondaryAction) { Button("Shuffle", systemImage: "dice") { picker.shuffle() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Use this") {
            Task { if await playlist.setCover(layout: picker.chosen, variant: picker.variant) { dismiss() } }
          }
          .disabled(playlist.busy)
        }
      }
    }
  }
}
