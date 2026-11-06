import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The next transition: its style and why, both songs' tempo and key, their energy around the mix, and this queue's
/// mixing (Auto, Party, No mixing). The `Sheet` of TransitionView.tsx.
struct TransitionSheet: View {
  let player: Player
  let from: Track
  let to: Track
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let maps = player.transitions.mixMaps
    let a = maps.map(from.recordingId), b = maps.map(to.recordingId)
    let words = TransitionWords.describe(player.transitions.result(from: from, to: to), mixMode: player.queue.mixMode)
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 6) {
            Text(words.style.prefix(1).uppercased() + words.style.dropFirst())
              .font(.display(.title2))
            if words.preparing {
              Text("Getting the mix ready…".uppercased())
                .font(.mono(.caption2))
                .tracking(1.5)
                .foregroundStyle(.secondary)
            }
            Text(words.why)
              .font(.sans(.subheadline))
              .foregroundStyle(.secondary)
          }
          VStack(alignment: .leading, spacing: 6) {
            facts("Now", from, a)
            facts("Next", to, b)
          }
          if let plan = words.plan, let a, let b {
            EnergyAroundTheMix(strips: EnergyPicture.aroundTheMix(plan, a: (from.title, a), b: (to.title, b)))
          }
          VStack(alignment: .leading, spacing: 8) {
            Text("Mixing for this queue".uppercased())
              .font(.mono(.caption2))
              .tracking(2)
              .foregroundStyle(.secondary)
            Picker("Mixing for this queue", selection: Binding(get: { player.queue.mixMode }, set: { player.setMixMode($0) })) {
              ForEach(TransitionWords.modes) { Text($0.label).tag($0.value) }
            }
            .pickerStyle(.segmented)
            Text(TransitionWords.modes.first { $0.value == player.queue.mixMode }?.hint ?? "")
              .font(.sans(.footnote))
              .foregroundStyle(.secondary)
          }
        }
        .padding(20)
      }
      .navigationTitle("Next transition")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() } } }
    }
  }

  private func facts(_ label: String, _ track: Track, _ map: MixMapEntry?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label.uppercased())
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
        .frame(width: 40, alignment: .leading)
      Text(track.title)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let facts = TransitionWords.songFacts(map) {
        Text(facts)
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }
    }
    .font(.sans(.subheadline))
  }
}
