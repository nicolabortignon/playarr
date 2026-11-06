import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MixModelTests {
  let api = FakeAPI.demoLibrary()
  let rome = TimeZone(identifier: "Europe/Rome")!

  @Test func sendsTheDevicesTimeZoneWithEveryCall() async {
    api.on(.get, "/api/mixes/vibes", Listening.mix())
    api.on(.post, "/api/mixes/vibes/regenerate", Listening.mix())
    api.on(.post, "/api/mixes/vibes/save", Listening.playlist(9, "Your vibes · 3 Nov"))
    let session = demoSession(api: api)
    let mixes = MixesStore(api: api, queries: QueryCache(directory: nil), timeZone: rome)
    await mixes.load()
    let mix = MixModel(key: "vibes", session: session, timeZone: rome)
    await mix.load()
    await mix.regenerate()
    #expect(await mix.save()?.id == 9)
    // The list asked again after New mix comes from the session's store, in this device's own zone.
    #expect(api.queries(.get, "/api/mixes", "tz") == ["Europe/Rome", TimeZone.current.identifier])
    for (method, path) in [(HTTPMethod.get, "/api/mixes/vibes"), (.post, "/api/mixes/vibes/regenerate"), (.post, "/api/mixes/vibes/save")] {
      #expect(api.queries(method, path, "tz") == ["Europe/Rome"], "\(path)")
    }
    #expect(session.toasts.toasts.map(\.message) == ["Saved as “Your vibes · 3 Nov”"])
  }

  @Test func saysWhatTheMixIsAndWhenItChanges() async throws {
    api.on(.get, "/api/mixes/vibes", Listening.mix(refreshesAt: "2026-11-03T19:00:00.000Z", tracks: [Listening.angel, Listening.risingson]))
    let mix = MixModel(key: "vibes", session: demoSession(api: api))
    await mix.load()
    let now = try #require(Format.parseDate("2026-11-03T10:00:00.000Z"))
    #expect(mix.facts(now: now) == "2 songs · 11 min · Changes in 9 h")
  }

  @Test func saysWhenANewMixCouldntBeMade() async {
    api.on(.get, "/api/mixes/vibes", Listening.mix())
    api.fail(.post, "/api/mixes/vibes/regenerate", status: 500, "Not enough songs")
    let session = demoSession(api: api)
    let mix = MixModel(key: "vibes", session: session)
    await mix.load()
    await mix.regenerate()
    #expect(session.toasts.toasts.map(\.message) == ["Couldn’t make a new mix: Not enough songs"])
    #expect(!mix.regenerating)
    #expect(mix.mix != nil)
  }

  @Test func playsShufflesAndQueuesTheMix() async {
    api.on(.get, "/api/mixes/vibes", Listening.mix(tracks: [Listening.angel, Listening.risingson]))
    let session = demoSession(api: api)
    let mix = MixModel(key: "vibes", session: session)
    await mix.load()
    mix.play(shuffle: true)
    #expect(session.player.queue.shuffle)
    #expect(session.player.queue.source == PlaySource(label: "Your vibes", href: "/mixes/vibes"))
    mix.queue(next: false)
    #expect(session.toasts.toasts.map(\.message) == ["Added 2 tracks to queue"])
  }

  @Test func playPausesTheMixOnlyWhileItsTheQueue() async {
    api.on(.get, "/api/mixes/vibes", Listening.mix(tracks: [Listening.angel, Listening.risingson]))
    let session = demoSession(api: api)
    let mix = MixModel(key: "vibes", session: session)
    await mix.load()
    #expect(mix.playState == .stopped)
    mix.playOrPause()
    #expect(mix.playState == .playing)
    #expect(!session.player.queue.shuffle)
    mix.playOrPause()
    #expect(mix.playState == .paused)
    // Another page's queue: Play starts the mix again.
    session.player.play([Listening.angel], source: PlaySource(label: "Favorites", href: "/favorites"))
    #expect(mix.playState == .stopped)
  }
}
