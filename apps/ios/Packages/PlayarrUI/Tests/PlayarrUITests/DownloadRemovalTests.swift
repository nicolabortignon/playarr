import Foundation
import PlayarrPlayer
import Testing
@testable import PlayarrUI

/// Taking a download off this device: at once, with Undo, which puts it back as it was (docs/design.md, "Taking things
/// back").
@MainActor @Suite(.serialized) struct DownloadRemovalTests {
  @Test func removesADownloadAtOnceAndUndoPutsItBack() throws {
    let demo = DownloadsDemo()
    let store = demo.store
    let toasts = ToastCenter(clock: TestClock())
    let mezzanine = try #require(store.download("album:1"))
    DownloadRemoval.remove(mezzanine, from: store, toasts: toasts)
    #expect(store.download("album:1") == nil)
    #expect(!store.isDownloaded(1))
    let toast = try #require(toasts.toasts.first)
    #expect(toast.message == "Removed “Mezzanine” from this device")
    #expect(toast.action?.label == "Undo")
    toasts.perform(toast)
    #expect(store.download("album:1") == mezzanine)
    #expect(store.downloads.map(\.key) == ["playlist:2", "album:1"])
    #expect(store.isDownloaded(1))
  }

  @Test func withoutToastsTheStoreSaysItWithNoUndo() throws {
    let demo = DownloadsDemo()
    let store = demo.store
    var said: [String] = []
    store.announce = { text, _ in said.append(text) }
    DownloadRemoval.remove(try #require(store.download("playlist:2")), from: store, toasts: nil)
    #expect(store.download("playlist:2") == nil)
    #expect(said == ["Removed “Late Night” from this device"])
  }
}
