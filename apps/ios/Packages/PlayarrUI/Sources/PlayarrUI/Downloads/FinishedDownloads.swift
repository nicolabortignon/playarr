import PlayarrPlayer
import SwiftUI

/// Says when a download's last song has arrived, as its ring closes into the tick: "“Mezzanine” is on this iPhone",
/// with the toast's light tap (docs/design.md, Moments). A view of its own, behind the app, so only it looks at the
/// downloads each time they change.
struct FinishedDownloads: View {
  let downloads: DownloadStore
  let toasts: ToastCenter

  var body: some View {
    Color.clear
      .accessibilityHidden(true)
      .onChange(of: downloads.manifest) { before, after in
        for download in OfflineWording.justDownloaded(before: before, after: after) {
          toasts.push(OfflineWording.onThisDevice(download.title, device: OfflineWording.device))
        }
      }
  }
}
