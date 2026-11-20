import AppIntents
import PlayarrWidgetData
import SwiftUI
import WidgetKit

/// Quick play: Feeling lucky, Play my Favorites and Start radio, played without opening Playarr. Small has Feeling
/// lucky only.
struct QuickPlayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKind.quickPlay, provider: SnapshotProvider()) { entry in
      QuickPlayView(entry: entry)
        .containerBackground(Color.widgetInk, for: .widget)
    }
    .configurationDisplayName("Quick play")
    .description("Feeling lucky, your Favorites or a radio, without opening Playarr.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct QuickPlayView: View {
  let entry: SnapshotEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    if entry.snapshot?.account == nil {
      SignInPrompt()
    } else if family == .systemSmall {
      VStack(alignment: .leading) {
        Text("Playarr")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
        QuickPlayButton(intent: FeelingLuckyIntent(), title: "Feeling lucky", symbol: "sparkles", primary: true)
      }
    } else {
      VStack(alignment: .leading) {
        Text("Playarr")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
        HStack(spacing: 8) {
          QuickPlayButton(intent: FeelingLuckyIntent(), title: "Feeling lucky", symbol: "sparkles", primary: true)
          QuickPlayButton(intent: PlayFavoritesIntent(), title: "Favorites", symbol: "heart.fill", primary: false)
          QuickPlayButton(intent: StartRadioIntent(), title: "Radio", symbol: "dot.radiowaves.left.and.right", primary: false)
        }
      }
    }
  }
}

/// One of Quick play's buttons: the symbol over its name, in a rounded tile. Feeling lucky, the main one, is filled
/// with the accent, as Home's button is.
struct QuickPlayButton<Intent: AppIntent>: View {
  let intent: Intent
  let title: LocalizedStringKey
  let symbol: String
  let primary: Bool

  var body: some View {
    Button(intent: intent) {
      VStack(spacing: 6) {
        Image(systemName: symbol)
          .font(.title3)
        Text(title)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .foregroundStyle(primary ? Color.widgetInk : Color.white)
      .background(primary ? AnyShapeStyle(.tint) : AnyShapeStyle(.white.opacity(0.12)), in: ContainerRelativeShape())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(title))
  }
}

#Preview("Small", as: .systemSmall) {
  QuickPlayWidget()
} timeline: {
  SnapshotEntry(date: .now, snapshot: .placeholder)
  SnapshotEntry(date: .now, snapshot: .signedOut)
}

#Preview("Medium", as: .systemMedium) {
  QuickPlayWidget()
} timeline: {
  SnapshotEntry(date: .now, snapshot: .placeholder)
}
