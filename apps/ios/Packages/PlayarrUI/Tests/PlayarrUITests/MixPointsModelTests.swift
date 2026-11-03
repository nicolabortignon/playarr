import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor final class FakePreviewer: MixPreviewing {
  var previews: [(id: Int, from: Double, length: Double)] = []
  var ended = 0
  func preview(_ track: Track, from seconds: Double, length: Double) { previews.append((track.id, seconds, length)) }
  func endPreviews() { ended += 1 }
}

@MainActor @Suite struct MixPointsModelTests {
  let log = EventLog()
  let previewer = FakePreviewer()

  static let song = Track(
    id: 7, recordingId: "rec-7", fileId: 7, albumId: 1, artistId: 1, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine",
    trackNumber: 1, discNumber: 1, duration: 200, explicit: false, format: AudioFormat(codec: "FLAC", container: "flac", lossless: true),
    size: 1, streamUrl: "/stream/7")
  static let cues = "/api/recordings/rec-7/cues"

  private func model(_ api: FakeAPI, cues: CuePoints? = nil, onChange: @escaping @MainActor (String) -> Void = { _ in }) -> MixPointsModel {
    api.on(.post, "/api/mix-maps", ["rec-7": mixMap(cues: cues)])
    api.on(.put, Self.cues, CuePoints())
    return MixPointsModel(track: Self.song, api: api, player: previewer, toast: log.toast, invalidate: log.invalidate, cuesChanged: onChange)
  }

  @Test func saysWhenASongHasntBeenAnalysed() async {
    let api = FakeAPI()
    api.on(.post, "/api/mix-maps", json: "{}")
    let m = MixPointsModel(track: Self.song, api: api, player: previewer, toast: log.toast, invalidate: log.invalidate, cuesChanged: { _ in })
    await m.load()
    #expect(m.loaded)
    #expect(m.editor == nil)
    #expect(api.bodies(.post, "/api/mix-maps") == [#"{"ids":["rec-7"]}"#])
  }

  @Test func previewsEightSecondsFromAMarkerThenEndsOnClose() async {
    let m = model(FakeAPI())
    await m.load()
    #expect(m.phrases.map(\.at) == [0.5, 8.5, 24.5])  // the unmeasured phrase is left blank
    #expect(m.bars.count == 100)
    m.play(from: .mixOut)
    #expect(previewer.previews.map(\.from) == [176.5])
    #expect(previewer.previews.map(\.length) == [8])
    m.close()
    #expect(previewer.ended == 1)
  }

  @Test func savesBothPointsAndRefreshesTheMixMaps() async {
    let api = FakeAPI()
    var changed: [String] = []
    let m = model(api) { changed.append($0) }
    await m.load()
    m.drag(.mixIn, to: 33)
    #expect(await m.save())
    #expect(api.bodies(.put, Self.cues) == [#"{"mixIn":32.5,"mixOut":null}"#])
    #expect(log.toasts == ["Mix points saved"])
    #expect(log.invalidated == [.mixMaps])
    #expect(changed == ["rec-7"])
    #expect(m.editor?.changed == false)
  }

  @Test func resetsWithoutTheServerWhenNothingWasSaved() async {
    let api = FakeAPI()
    let m = model(api)
    await m.load()
    m.step(.mixIn, forward: true, phrase: true)
    await m.reset()
    #expect(api.calls(.put, Self.cues).isEmpty)
    #expect(m.editor?.points == .init())
  }

  @Test func resetsSavedPointsOnTheServer() async {
    let api = FakeAPI()
    let m = model(api, cues: CuePoints(mixIn: 20.5))
    await m.load()
    await m.reset()
    #expect(api.bodies(.put, Self.cues) == [#"{"mixIn":null,"mixOut":null}"#])
    #expect(m.editor?.anySet == false)
    #expect(log.toasts.isEmpty)
  }

  @Test func saysWhySavingFailed() async {
    let api = FakeAPI()
    let m = model(api)
    api.fail(.put, Self.cues, status: 404, "Song not found in the library")
    await m.load()
    m.drag(.mixOut, to: 150)
    #expect(await m.save() == false)
    #expect(m.saveError == "Couldn’t save the mix points: Song not found in the library")
  }
}
