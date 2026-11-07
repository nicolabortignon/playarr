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

  func origin(_ track: Track, on network: NetworkKind) -> TrackSource.Origin {
    Player.origin(for: track, on: network, settings: rig.settings, backend: rig.backend, downloads: rig.store, levelled: false, support: support)
  }

  @Test func streamsASongsOwnFileAtOriginal() {
    let origin = origin(flac, on: .wifi)
    #expect(origin.encoded == nil)
    #expect(origin.accepts == .original)
  }

  @Test func streamsItEncodedOnMobileDataFromAnySample() {
    let origin = origin(flac, on: .cellular)
    let encoded = try? #require(origin.encoded)
    #expect(encoded?.quality == .normal)
    #expect(encoded?.request(0).url?.query() == "kbps=128")
    #expect(encoded?.request(44_100).url?.query() == "kbps=128&start=44100")
    #expect(origin.accepts == .normal)
    rig.settings.wifiQuality = .high
    #expect(self.origin(flac, on: .wifi).encoded?.request(0).url?.query() == "kbps=256")
  }

  @Test func playsAnyCopyOfflineAndAsksNothing() {
    let origin = origin(flac, on: .offline)
    #expect(origin.encoded == nil)
    #expect(origin.accepts == .normal)
  }

  @Test func playsAFileAlreadyAboutThatSmallAsItIs() {
    let mp3 = encodable(song(5, container: "mp3"), kbps: 128)
    let origin = origin(mp3, on: .cellular)
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
