import PlayarrPlayer
import SwiftUI

/// Shows that a song is on this device, or how far along its download is (apps/web/src/components/OfflineMark.tsx).
public struct OfflineMark: View {
  let store: DownloadStore
  let fileId: Int

  public init(store: DownloadStore, fileId: Int) {
    self.store = store
    self.fileId = fileId
  }

  public var body: some View {
    if let active = store.active, active.fileId == fileId {
      ProgressRing(fraction: active.fraction, lineWidth: 1.75)
        .frame(width: 14, height: 14)
        .accessibilityElement()
        .accessibilityLabel("Downloading, \(Int((active.fraction * 100).rounded()))%")
    } else if store.isKept(fileId) {
      Image(systemName: "arrow.down.circle.fill")
        .font(.sans(.caption))
        .foregroundStyle(.tint.opacity(0.8))
        .accessibilityLabel("On this device")
    }
  }
}
