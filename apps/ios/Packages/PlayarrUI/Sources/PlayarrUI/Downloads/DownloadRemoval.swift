import PlayarrPlayer

/// Taking a download off this device (the Download button tapped again, Downloads' ×): at once, with Undo in the toast,
/// which puts it back as it was (docs/design.md, "Taking things back"; `removeDownloadWithUndo` in
/// apps/web/src/components/DownloadButton.tsx). Without a toast center (Downloads' UI test page) the store says it.
@MainActor
enum DownloadRemoval {
  static func remove(_ download: PinnedDownload, from store: DownloadStore, toasts: ToastCenter?) {
    store.remove(download.key)
    let message = OfflineWording.removed(download.title)
    guard let toasts else { return store.announce(message, false) }
    toasts.undo(message) { store.restore(download) }
  }
}
