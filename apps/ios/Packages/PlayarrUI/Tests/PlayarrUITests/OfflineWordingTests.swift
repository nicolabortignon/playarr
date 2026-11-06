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
    // The numbers alone, for when they go under the subtitle.
    #expect(OfflineWording.progress(DownloadProgress(done: 0, total: 3, bytes: 0)) == "0 of 3 songs · 0 MB")
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

  @Test func removeAllNamesWhatLeavesThisDeviceAndWhatDoesnt() {
    let gb = OfflineLimit.gigabyte
    #expect(
      OfflineWording.removeAllQuestion(songs: 62, downloads: 2, downloadBytes: gb, saved: 40, savedBytes: 310 * mb)
        == LossQuestion(
          title: "Remove 62 songs from this device?",
          message:
            "2 downloads (1 GB) and 40 songs saved as you listened (310 MB) leave this device. Nothing leaves your library: anything can be downloaded again.",
          verb: "Remove all"))
    #expect(OfflineWording.removeAllQuestion(songs: 1, downloads: 0, downloadBytes: 0, saved: 1, savedBytes: 9 * mb).title == "Remove 1 song from this device?")
    #expect(OfflineWording.whatGoes(downloads: 1, downloadBytes: 484 * mb, saved: 0, savedBytes: 0) == "1 download (484 MB) leaves this device.")
    #expect(OfflineWording.whatGoes(downloads: 0, downloadBytes: 0, saved: 1, savedBytes: 9 * mb) == "1 song saved as you listened (9 MB) leaves this device.")
    #expect(OfflineWording.whatGoes(downloads: 0, downloadBytes: 0, saved: 3, savedBytes: 30 * mb) == "3 songs saved as you listened (30 MB) leave this device.")
  }

  @Test func sayingADownloadStartsOrGoesQuotesItsTitle() {
    #expect(OfflineWording.started("Mezzanine") == "Downloading “Mezzanine”")
    #expect(OfflineWording.removed("Mezzanine") == "Removed “Mezzanine” from this device")
  }
}
