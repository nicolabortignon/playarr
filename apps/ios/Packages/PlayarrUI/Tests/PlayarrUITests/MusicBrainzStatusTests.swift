import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MusicBrainzStatusTests {
  private func status(queued: Int, background: Int = 0, eta: Double = 0) -> MusicBrainzStatus {
    MusicBrainzStatus(queued: queued, background: background, etaSeconds: eta, matching: 0)
  }

  @Test func asksQuicklyWhileLookupsWaitAndSlowlyOtherwise() async {
    let api = FakeAPI()
    api.on(.get, "/api/musicbrainz/status", status(queued: 3))
    api.then(.get, "/api/musicbrainz/status", status(queued: 1))
    api.then(.get, "/api/musicbrainz/status", status(queued: 0))
    let clock = TestClock()
    let model = MusicBrainzStatusModel(api: api, clock: clock)
    let watching = Task { await model.watch() }
    var waits: [Duration] = []
    for _ in 0..<3 {
      let wait = await clock.nextSleep()
      waits.append(wait)
      clock.advance(by: wait)
    }
    _ = await clock.nextSleep()
    watching.cancel()
    #expect(waits == [.milliseconds(1500), .milliseconds(1500), .seconds(15)])
    #expect(model.status?.queued == 0)
  }

  @Test func explainsTheWaitInTheWebsWords() {
    #expect(SlowLookupText.waiting(for: "“Air”", status: nil) == "Asking MusicBrainz for “Air”. It answers about one request per second.")
    #expect(SlowLookupText.waiting(for: "this album", status: status(queued: 1, background: 1)) == "Asking MusicBrainz for this album. It answers about one request per second.")
    #expect(
      SlowLookupText.waiting(for: "this album", status: status(queued: 40, background: 38, eta: 130))
        == "Asking MusicBrainz for this album. It answers about one request per second, and Playarr is also identifying your folder music, so there’s a line: about 2 min to go.")
    #expect(SlowLookupText.queued(status(queued: 4)) == "4 queued")
    #expect(SlowLookupText.explanation(status(queued: 4, eta: 3.2)) == "About 3 s of MusicBrainz lookups waiting (it answers about once a second)")
    #expect(SlowLookupText.explanation(status(queued: 4, background: 2, eta: 0.2)) == "About 1 s of MusicBrainz lookups waiting (it answers about once a second); 2 of them identifying your folder music")
  }
}
