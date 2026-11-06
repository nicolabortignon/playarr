import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// Search's "Not in your library", as the web's (Search.tsx `Beyond`): whenever there's something out there, with or
/// without Lidarr, saying where it's from, with Request only where requesting is possible.
@MainActor @Suite struct BeyondLibraryTests {
  @Test func withoutLidarrItSaysItsFromMusicBrainzAndOffersNoRequest() {
    let gate = RequestGate(health: health(lidarr: false, requests: false), account: account(canRequest: true))
    #expect(BeyondLibrary.kicker(gate) == "MusicBrainz · Deezer")
    #expect(BeyondLibrary.explanation(gate) == "Music from MusicBrainz and Deezer that isn’t in your library yet.")
    #expect(BeyondLibrary.songsKicker(gate) == nil)
    #expect(RequestButtonState.make(availability(.noneValue), allowed: gate.allowsRequests, pending: nil) == .hidden)
    // Partly here: what's here opens, with nothing to request.
    let partial = RequestButtonState.make(availability(.partial, albumId: 70, have: 3, total: 5), allowed: gate.allowsRequests, pending: nil)
    #expect(partial == .partial(count: "3/5", summary: "3 of 5 songs in your library", albumId: 70, canRequest: false))
  }

  @Test func withLidarrAndRequestsOnItOffersRequest() {
    let gate = RequestGate(health: health(), account: account(canRequest: true))
    #expect(BeyondLibrary.kicker(gate) == "Lidarr · MusicBrainz · Deezer")
    #expect(BeyondLibrary.explanation(gate) == "Request an album and Lidarr will search your indexers for it. It lands in your library when it’s ready.")
    #expect(BeyondLibrary.songsKicker(gate) == "Request the album it’s on")
    // An account that may not request reads what this is instead.
    let reader = RequestGate(health: health(), account: account(canRequest: false))
    #expect(BeyondLibrary.kicker(reader) == "Lidarr · MusicBrainz · Deezer")
    #expect(BeyondLibrary.explanation(reader) == "Music from MusicBrainz and Deezer that isn’t in your library yet.")
  }

  @Test func showsWhileAskingAndWithAnswersButNotWhenNothingIsOutThere() async {
    let api = FakeAPI()
    let clock = TestClock()
    let beyond = DiscoverSearchModel(context: DiscoverContext(api: api, account: account(), clock: TestClock(), toast: { _, _ in }), clock: clock)
    #expect(!BeyondLibrary.shows(query: "m", model: beyond))
    // Asked about: there, with skeletons, until the answer.
    beyond.update("mass")
    #expect(BeyondLibrary.shows(query: "mass", model: beyond))
    api.on(.get, "/api/discover/search", Demo.discover("mass"))
    clock.advance(by: await clock.nextSleep())
    await eventually { beyond.results != nil }
    #expect(BeyondLibrary.shows(query: "mass", model: beyond))
    // Nothing anywhere: the page above says so, and the section goes.
    api.on(.get, "/api/discover/search", Demo.discover("zzzz"))
    beyond.update("zzzz")
    clock.advance(by: await clock.nextSleep())
    await eventually { beyond.answered == "zzzz" && !beyond.fetching }
    #expect(!BeyondLibrary.shows(query: "zzzz", model: beyond))
    // Couldn't ask: it stays, to say so with Try again.
    api.fail(.get, "/api/discover/search", status: 502, "MusicBrainz didn’t answer")
    beyond.update("air")
    clock.advance(by: await clock.nextSleep())
    await eventually { beyond.error != nil }
    #expect(BeyondLibrary.shows(query: "air", model: beyond))
    #expect(BeyondLibrary.failed(query: "air", model: beyond))
  }

  @Test func theDemoServerWithoutLidarrAnswersFromMusicBrainz() async throws {
    let context = DiscoverContext(api: DemoAPI(), account: Demo.account, clock: TestClock(), toast: { _, _ in })
    await context.refreshHealth()
    #expect(!context.gate.hasLidarr && !context.gate.allowsRequests)
    let answer = try await context.discover("mass")
    #expect(answer.albums.map(\.title) == ["Mezzanine", "Heligoland", "Blue Lines"])
    #expect(answer.artists.map(\.name) == ["Massive Attack", "Mass Gothic"])
    #expect(answer.tracks.map(\.title) == ["Teardrop", "Paradise Circus"])
    #expect(try await context.discover("zzzz") == DiscoverResults(artists: [], albums: [], tracks: []))
  }
}
