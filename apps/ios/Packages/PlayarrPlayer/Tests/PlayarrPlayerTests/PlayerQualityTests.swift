import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Where the player plays a song from at each quality (plan 2 §1): `Player.origin`.
@MainActor
@Suite(.serialized)
struct PlayerQualityTests {
  let rig = StoreRig()
  let support = EncodeSupport()
  let flac = encodable(song(4))

  /// Measured at `kbps` (Automatic quality), or nothing measured yet.
  func origin(_ track: Track, on network: NetworkKind, kbps: Double? = nil) -> TrackSource.Origin {
    let quality = rig.settings.streamQuality(for: track, on: network, kbps: kbps)
    return Player.origin(for: track, at: quality, on: network, backend: rig.backend, downloads: rig.store, levelled: false, support: support)
  }

  @Test func streamsASongsOwnFileAtOriginal() {
    let origin = origin(flac, on: .cellular, kbps: 20_000)
    #expect(origin.encoded == nil)
    #expect(origin.accepts == .original)
  }

  @Test func streamsItEncodedFromAnySampleAtTheQualityTheConnectionKeepsUpWith() {
    // Nothing measured yet: Normal, on Wi-Fi as on mobile data.
    let origin = origin(flac, on: .wifi)
    let encoded = try? #require(origin.encoded)
    #expect(encoded?.quality == .normal)
    #expect(encoded?.request(0).url?.query() == "kbps=128")
    #expect(encoded?.request(44_100).url?.query() == "kbps=128&start=44100")
    #expect(origin.accepts == .normal)
    #expect(self.origin(flac, on: .wifi, kbps: 400).encoded?.request(0).url?.query() == "kbps=256")
    #expect(self.origin(flac, on: .cellular, kbps: 100).encoded?.request(0).url?.query() == "kbps=64")
    // A quality picked holds whatever the connection.
    rig.settings.streaming = .high
    #expect(self.origin(flac, on: .wifi, kbps: 100).encoded?.request(0).url?.query() == "kbps=256")
  }

  @Test func playsAnyCopyOfflineAndAsksNothing() {
    let origin = origin(flac, on: .offline)
    #expect(origin.encoded == nil)
    #expect(origin.accepts == .low)
  }

  @Test func playsAFileAlreadyAboutThatSmallAsItIs() {
    let mp3 = encodable(song(5, container: "mp3"), kbps: 128)
    let origin = origin(mp3, on: .cellular, kbps: 300)
    #expect(origin.encoded == nil)
    #expect(origin.accepts == .original)
  }

  @Test func playsItsOwnFileFromAServerWithoutEncodedStreamsOrOneThatFailedIt() {
    rig.backend.encodes.value = false
    #expect(origin(flac, on: .cellular).encoded == nil)
    rig.backend.encodes.value = true
    support.failed(4, status: 502, message: "This song couldn’t be encoded")
    #expect(origin(flac, on: .cellular).encoded == nil)
  }

  @Test func playsADownloadsCopyWhateverItsQuality() async {
    rig.settings.downloadQuality = .normal
    rig.store.add(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [flac])
    await eventually { rig.transport.runningIDs == [rig.job(4, "normal.m4a")] }
    rig.transport.finish(rig.job(4, "normal.m4a"), bytes: 500)
    await eventually { rig.store.isKept(4) }
    #expect(origin(flac, on: .wifi).kept?.lastPathComponent == "4.normal.m4a")
  }
}
