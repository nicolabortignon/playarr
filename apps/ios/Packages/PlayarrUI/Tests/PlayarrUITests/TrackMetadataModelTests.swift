import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct TrackMetadataModelTests {
  let log = EventLog()

  private func model(_ api: FakeAPI) -> TrackMetadataModel {
    TrackMetadataModel(trackId: 700, api: api, toast: log.toast, invalidate: log.invalidate)
  }

  @Test func offersMatchingAgainOnlyToAdmins() async {
    let folder = MetadataFormatTests.copy(1, kind: .folder, playing: true)
    let member = FakeAPI()
    member.on(.get, "/api/tracks/700/metadata", MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(1, kind: .folder, path: nil)], pathsHidden: true))
    let hidden = model(member)
    await hidden.load()
    #expect(hidden.primary == nil)
    let admin = FakeAPI()
    admin.on(.get, "/api/tracks/700/metadata", MetadataFormatTests.metadata(copies: [folder, MetadataFormatTests.copy(2, kind: .lidarr)]))
    let shown = model(admin)
    await shown.load()
    #expect(shown.primary?.fileId == 1)
    #expect(shown.offersRematch(for: shown.metadata!.copies[1]))
    #expect(!shown.offersRematch(for: shown.metadata!.copies[0]))
  }

  @Test func saysWhatLidarrSaid() async {
    let api = FakeAPI()
    api.on(.get, "/api/tracks/700/metadata", MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(5, kind: .lidarr)]))
    api.on(.post, "/api/files/5/rematch", json: #"{"kind":"lidarr","message":"Lidarr is refreshing Massive Attack from MusicBrainz"}"#)
    let m = model(api)
    await m.load()
    await m.rematch(m.metadata!.copies[0])
    #expect(m.outcomes[5] == .init(text: "Lidarr is refreshing Massive Attack from MusicBrainz", isError: false))
    #expect(log.invalidated == CacheFamily.allCases)
  }

  @Test func followsAFileToItsNewSong() async {
    let api = FakeAPI()
    let song = MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(1, kind: .folder)])
    api.on(.get, "/api/tracks/700/metadata", song)
    api.on(.get, "/api/tracks/901/metadata", song)
    api.on(.post, "/api/files/1/rematch", json: #"{"kind":"folder","state":"auto","trackId":901}"#)
    let m = model(api)
    await m.load()
    await m.rematch(m.metadata!.copies[0])
    #expect(m.trackId == 901)
    #expect(log.toasts == ["Matched on MusicBrainz. The metadata is up to date."])
    #expect(api.calls.map { "\($0.method.rawValue) \($0.path)" } == ["GET /api/tracks/700/metadata", "POST /api/files/1/rematch", "GET /api/tracks/901/metadata"])
  }

  @Test func showsTheServersErrorUnderTheButton() async {
    let api = FakeAPI()
    api.on(.get, "/api/tracks/700/metadata", MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(1, kind: .folder)]))
    api.fail(.post, "/api/files/1/rematch", status: 403, "Admins only")
    let m = model(api)
    await m.load()
    await m.rematch(m.metadata!.copies[0])
    #expect(m.outcomes[1] == .init(text: "Admins only", isError: true))
    #expect(m.rematching == nil)
  }

  @Test func saysWhyTheMetadataCouldntLoad() async {
    let api = FakeAPI()
    api.fail(.get, "/api/tracks/700/metadata", status: 404, "Song not found")
    let m = model(api)
    await m.load()
    #expect(m.error == "Song not found")
  }
}
