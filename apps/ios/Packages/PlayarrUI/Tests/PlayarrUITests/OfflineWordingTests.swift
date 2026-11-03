import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct OfflineWordingTests {
  let mb = OfflineLimit.megabyte

  @Test func theDownloadButtonSaysWhereItIs() {
    #expect(OfflineWording.phase(nil) == .notDownloaded)
    #expect(OfflineWording.phase(DownloadProgress(done: 3, total: 12, bytes: 0)) == .downloading(done: 3, total: 12))
    #expect(OfflineWording.phase(DownloadProgress(done: 12, total: 12, bytes: 0)) == .downloaded)
    #expect(OfflineWording.buttonLabel(.notDownloaded, title: "Mezzanine") == "Download Mezzanine")
    #expect(OfflineWording.buttonLabel(.downloading(done: 3, total: 12), title: "Mezzanine") == "Downloading, 3 of 12: remove Mezzanine from this device")
    #expect(OfflineWording.buttonLabel(.downloaded, title: "Mezzanine") == "Downloaded: remove Mezzanine from this device")
    #expect(OfflineWording.phase(DownloadProgress(done: 3, total: 12, bytes: 0)).fraction == 0.25)
    #expect(OfflineWording.noRoomMessage("Mezzanine", needed: 480 * mb, free: 120 * mb)
      == "Mezzanine needs 480 MB, and 120 MB is free. Remove some downloads in Library → Downloads.")
  }

  @Test func aDownloadsRowCountsSongsBytesAndFailures() {
    let d = PinnedDownload(key: "album:1", title: "Mezzanine", subtitle: "Massive Attack", href: "/albums/1", tracks: [])
    #expect(OfflineWording.rowDetail(d, DownloadProgress(done: 11, total: 11, bytes: 484 * mb)) == "Massive Attack · 11 songs · 484 MB")
    #expect(OfflineWording.rowDetail(d, DownloadProgress(done: 3, total: 11, bytes: 132 * mb)) == "Massive Attack · 3 of 11 songs · 132 MB")
    var mix = d
    mix.subtitle = nil
    #expect(OfflineWording.rowDetail(mix, DownloadProgress(done: 1, total: 1, bytes: 40 * mb)) == "1 song · 40 MB")
    #expect(OfflineWording.failures(2) == " · 2 couldn’t download")
    #expect(OfflineWording.failures(0) == "")
  }

  @Test func onThisDeviceCountsWhatsKeptAgainstTheLimit() {
    #expect(OfflineWording.headline(count: 12, limit: 2 * OfflineLimit.gigabyte) == "12 songs")
    #expect(OfflineWording.headline(count: 12, limit: 0) == "Off")
    #expect(OfflineWording.usage(bytes: 640 * mb, limit: 2 * OfflineLimit.gigabyte) == "640 MB of 2 GB")
    #expect(OfflineWording.usage(bytes: 640 * mb, limit: 0) == nil)
    #expect(OfflineWording.downloadsLine(count: 3, bytes: 1536 * mb)?.link == "3 downloads")
    #expect(OfflineWording.downloadsLine(count: 3, bytes: 1536 * mb)?.rest == " (1.5 GB), kept until you remove them.")
    #expect(OfflineWording.downloadsLine(count: 0, bytes: 0) == nil)
  }
}
