import PlayarrAPI
import SwiftUI

/// The sidebar's foot: the library in four numbers, the status dots, the MusicBrainz queue and the version.
struct SidebarFooterView: View {
  let footer: SidebarFooter
  let version: AppVersion

  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !footer.stats.isEmpty {
        let columns = Array(repeating: GridItem(.flexible(), alignment: .leading), count: typeSize.isAccessibilitySize ? 1 : 2)
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
          ForEach(footer.stats, id: \.label) { stat in
            VStack(alignment: .leading, spacing: 2) {
              Text(stat.label.uppercased()).font(.caption2.monospaced()).tracking(1.5).foregroundStyle(.muted)
              Text(stat.value).font(.caption.monospaced())
            }
            .accessibilityElement(children: .combine)
          }
        }
      }
      ForEach(footer.statuses, id: \.label) { status in
        HStack(spacing: 8) {
          Circle().fill(color(status.state)).frame(width: 6, height: 6).accessibilityHidden(true)
          Text(status.label)
          if status.saysOffline { Text("offline").foregroundStyle(.red.opacity(0.8)) }
        }
        .font(.caption.monospaced())
        .foregroundStyle(.muted)
        .accessibilityElement(children: .combine)
        .accessibilityValue(spoken(status))
      }
      MusicBrainzIndicator()
      Text(SidebarFooter.version(version)).font(.caption2.monospaced()).foregroundStyle(.muted)
        .accessibilityLabel("Playarr \(version.label)")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("sidebar.footer")
  }

  private func color(_ state: SidebarFooter.Status.State) -> Color {
    switch state {
    case .unknown: .gray
    case .ok: .green
    case .down: .red
    }
  }

  /// "Working, local" / "Not working, Connection refused".
  private func spoken(_ status: SidebarFooter.Status) -> String {
    let state = switch status.state {
    case .unknown: "Checking"
    case .ok: "Working"
    case .down: "Not working"
    }
    return [state, status.detail].compactMap(\.self).joined(separator: ", ")
  }
}
