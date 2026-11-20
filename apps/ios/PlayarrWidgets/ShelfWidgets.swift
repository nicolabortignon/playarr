import AppIntents
import PlayarrWidgetData
import SwiftUI
import UIKit
import WidgetKit

/// Jump back in: the albums heard lately, as on Home. A tap plays the album from the start.
struct JumpBackInWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKind.jumpBackIn, provider: SnapshotProvider()) { entry in
      ShelfView(title: "Jump back in", items: entry.snapshot?.albums, signedIn: entry.snapshot?.account != nil,
                empty: "Play an album in Playarr and it shows up here.") { item in
        PlayAlbumIntent(albumId: Int(item.id) ?? 0)
      }
      .containerBackground(Color.widgetInk, for: .widget)
    }
    .configurationDisplayName("Jump back in")
    .description("The albums you played lately, a tap from playing again.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}

/// Made for you: Home's mixes, with the covers the app draws for them. A tap plays the mix from the start.
struct MadeForYouWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKind.madeForYou, provider: SnapshotProvider()) { entry in
      ShelfView(title: "Made for you", items: entry.snapshot?.mixes, signedIn: entry.snapshot?.account != nil,
                empty: "Your mixes show up here once Playarr has made them.") { item in
        PlayMixIntent(mixKey: item.id)
      }
      .containerBackground(Color.widgetInk, for: .widget)
    }
    .configurationDisplayName("Made for you")
    .description("Your mixes, from Discovery Weekly to Wind down.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}

/// A shelf of covers under its title: one row of four on a medium widget, two on a large one.
struct ShelfView<Intent: AppIntent>: View {
  let title: LocalizedStringKey
  let items: [WidgetSnapshot.Item]?
  let signedIn: Bool
  let empty: LocalizedStringKey
  let intent: (WidgetSnapshot.Item) -> Intent

  @Environment(\.widgetFamily) private var family

  var body: some View {
    if !signedIn {
      SignInPrompt()
    } else {
      let shown = Array((items ?? []).prefix(family == .systemLarge ? 8 : 4))
      VStack(alignment: .leading, spacing: 8) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        if shown.isEmpty {
          Spacer(minLength: 0)
          Text(empty)
            .font(.subheadline)
            .foregroundStyle(.white)
          Spacer(minLength: 0)
        } else {
          Grid(horizontalSpacing: 8, verticalSpacing: 8) {
            ForEach(Array(stride(from: 0, to: shown.count, by: 4)), id: \.self) { start in
              GridRow {
                ForEach(start..<start + 4, id: \.self) { index in
                  if index < shown.count {
                    ShelfTile(item: shown[index], intent: intent(shown[index]))
                  } else {
                    Color.clear
                  }
                }
              }
            }
          }
          .frame(maxHeight: .infinity, alignment: .top)
        }
      }
    }
  }
}

/// A cover and its name; a tap runs the item's intent.
struct ShelfTile<Intent: AppIntent>: View {
  let item: WidgetSnapshot.Item
  let intent: Intent

  var body: some View {
    Button(intent: intent) {
      VStack(alignment: .leading, spacing: 4) {
        WidgetCover(name: item.cover)
        Text(item.title)
          .font(.caption2.weight(.medium))
          .foregroundStyle(.white)
          .lineLimit(1)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text("\(item.title), \(item.subtitle)"))
  }
}

/// A cover from the snapshot's folder, square, with design.md's cover corners (4); a record-groove stand-in without one.
struct WidgetCover: View {
  let name: String?

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        if let name, let store = WidgetStore.live(), let picture = UIImage(contentsOfFile: store.cover(name).path) {
          // In the tinted Home Screen style, a cover goes grey rather than a flat block of the tint.
          Image(uiImage: picture)
            .resizable()
            .widgetAccentedRenderingMode(.desaturated)
            .scaledToFill()
        } else {
          ZStack {
            Color.white.opacity(0.08)
            Image(systemName: "music.note")
              .font(.title3)
              .foregroundStyle(.white.opacity(0.4))
          }
        }
      }
      .clipShape(.rect(cornerRadius: 4))
  }
}

#Preview("Jump back in", as: .systemMedium) {
  JumpBackInWidget()
} timeline: {
  SnapshotEntry(date: .now, snapshot: .placeholder)
  SnapshotEntry(date: .now, snapshot: WidgetSnapshot(account: WidgetSnapshot.placeholder.account))
}

#Preview("Made for you", as: .systemLarge) {
  MadeForYouWidget()
} timeline: {
  SnapshotEntry(date: .now, snapshot: .placeholder)
}
