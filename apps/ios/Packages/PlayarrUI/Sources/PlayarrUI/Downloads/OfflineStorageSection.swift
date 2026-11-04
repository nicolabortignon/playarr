import PlayarrPlayer
import SwiftUI

/// Settings → Playback → On this device: what's kept, how much may be, a way to free the space, and whether downloads
/// may use mobile data (apps/web/src/components/OfflineStorage.tsx; the mobile-data switch is the app's own).
public struct OfflineStorageSection: View {
  @Bindable var store: DownloadStore
  let openDownloads: () -> Void
  @State private var confirmingRemoveAll = false

  public init(store: DownloadStore, openDownloads: @escaping () -> Void) {
    self.store = store
    self.openDownloads = openDownloads
  }

  public var body: some View {
    let kept = store.keptAsYouListen
    let limit = store.limit
    let downloads = store.manifest.pins.count
    Section {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          Label(OfflineWording.headline(count: kept.count, limit: limit), systemImage: "internaldrive")
          Spacer()
          if let usage = OfflineWording.usage(bytes: kept.bytes, limit: limit) {
            Text(usage).font(.sans(.caption).monospacedDigit()).foregroundStyle(.secondary)
          }
        }
        if limit > 0 {
          ProgressView(value: Double(min(kept.bytes, limit)), total: Double(limit))
            .accessibilityLabel("Space used")
        }
      }
      if let line = OfflineWording.downloadsLine(count: downloads, bytes: store.downloadsBytes) {
        Button(action: openDownloads) {
          Text("Plus \(Text(line.link).foregroundStyle(.tint))\(line.rest)")
            .font(.sans(.subheadline))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
      }
      Picker("Keep up to", selection: $store.limit) {
        ForEach(OfflineLimit.options, id: \.self) { Text(OfflineLimit.label($0)).tag($0) }
      }
      Toggle("Allow downloads on mobile data", isOn: $store.cellularDownloads)
      if kept.count > 0 || downloads > 0 {
        Button("Remove all", role: .destructive) { confirmingRemoveAll = true }
          .confirmationDialog("Remove all songs and downloads from this device?", isPresented: $confirmingRemoveAll, titleVisibility: .visible) {
            Button("Remove all", role: .destructive) { store.removeAll() }
          }
      }
    } header: {
      Text("On this device")
    } footer: {
      Text(OfflineWording.explanation + " Downloads wait for Wi-Fi unless mobile data is allowed.")
    }
  }
}
