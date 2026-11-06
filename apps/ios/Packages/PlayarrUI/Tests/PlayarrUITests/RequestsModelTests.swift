import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// Remembers what it was told.
@MainActor final class FakeNotifier: RequestNotifier {
  var asked = 0
  var landed: [[AlbumRequest]] = []
  func requested() { asked += 1 }
  func landed(_ requests: [AlbumRequest]) { landed.append(requests) }
}

@MainActor @Suite struct RequestsModelTests {
  let log = EventLog()
  let notifier = FakeNotifier()

  private func model(_ api: FakeAPI, _ clock: TestClock = TestClock()) -> RequestsModel {
    RequestsModel(api: api, clock: clock, notifier: notifier, toast: log.toast, invalidate: log.invalidate)
  }

  @Test func pollsEveryTenSecondsWhileOnItsWayThenEveryMinute() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .downloading, progress: 0.4)])
    api.then(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .importing)])
    api.then(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .available, albumId: 70)])
    let clock = TestClock()
    let requests = model(api, clock)
    requests.startPolling()
    var waits: [Duration] = []
    for _ in 0..<4 {
      let wait = await clock.nextSleep()
      waits.append(wait)
      clock.advance(by: wait)
    }
    requests.stopPolling()
    #expect(waits == [.seconds(10), .seconds(10), .seconds(60), .seconds(60)])
    #expect(log.toasts == ["“Mezzanine” is ready to play"])
    #expect(log.invalidated == CacheFamily.landed)
    #expect(notifier.landed.map { $0.map(\.mbid) } == [["rg-1"]])
    #expect(requests.activeCount == 0)
  }

  @Test func aRequestAsksForTheRequestsEveryTenSecondsAtOnce() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [AlbumRequest]())
    api.on(.post, "/api/requests", albumRequest("rg-1", "Mezzanine", .searching))
    let clock = TestClock()
    let requests = model(api, clock)
    requests.startPolling()
    #expect(await clock.nextSleep() == .seconds(60))
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .searching)])
    requests.request(AlbumRef(mbid: "rg-1", artistName: "Massive Attack", albumTitle: "Mezzanine"))
    // Not after the minute the poll was already waiting: one is on its way now.
    await eventually { clock.sleeping == 1 && clock.pendingSleep == .seconds(10) }
    #expect(clock.pendingSleep == .seconds(10))
    #expect(requests.activeCount == 1)
    requests.stopPolling()
  }

  @Test func keepsTheNotifierItIsGiven() {
    // The app makes its notifier inline: the model must hold on to it.
    weak var given: FakeNotifier?
    let requests: RequestsModel = {
      let made = FakeNotifier()
      given = made
      return RequestsModel(api: FakeAPI(), notifier: made, toast: log.toast, invalidate: log.invalidate)
    }()
    #expect(given != nil)
    _ = requests
  }

  @Test func saysRequestingThenLookingUpUntilTheServerAnswers() async {
    let api = FakeAPI()
    let answer = Gate()
    api.on(.get, "/api/requests", [AlbumRequest]())
    api.on(.post, "/api/requests", albumRequest("rg-1", "Mezzanine", .searching))
    api.hold(.post, "/api/requests", until: answer)
    let clock = TestClock()
    let requests = model(api, clock)
    let ref = AlbumRef(mbid: "rg-1", artistName: "Massive Attack", albumTitle: "Mezzanine")
    requests.request(ref)
    #expect(requests.pendingState(for: ref) == .requesting)
    #expect(requests.buttonState(for: ref, availability: availability(.noneValue), allowed: true).label == "Requesting…")
    #expect(await clock.nextSleep() == .seconds(2))
    clock.advance(by: .seconds(2))
    await eventually { requests.pendingState(for: ref) == .lookingUp }
    #expect(requests.buttonState(for: ref, availability: availability(.noneValue), allowed: true).label == "Looking up…")
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .searching)])
    await answer.open()
    await eventually { requests.pendingState(for: ref) == nil }
    #expect(log.toasts == ["Requested “Mezzanine”. Lidarr is searching for it"])
    #expect(log.invalidated == CacheFamily.requested)
    #expect(requests.requests?.map(\.mbid) == ["rg-1"])
    #expect(notifier.asked == 1)
    #expect(api.bodies(.post, "/api/requests") == [#"{"albumTitle":"Mezzanine","artistName":"Massive Attack","mbid":"rg-1"}"#])
  }

  @Test func saysWhenLidarrWillSearchOnItsSchedule() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [AlbumRequest]())
    api.on(.post, "/api/requests", albumRequest("rg-1", "Mezzanine", .waiting))
    let requests = model(api)
    requests.request(AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine"))
    await eventually { !log.toasts.isEmpty }
    #expect(log.toasts == ["Requested “Mezzanine”. Lidarr will search for it on its schedule"])
  }

  @Test func showsTheServersReasonWhenARequestIsRefused() async {
    let api = FakeAPI()
    api.fail(.post, "/api/requests", status: 403, "Your account can’t request albums")
    let requests = model(api)
    let ref = AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine")
    requests.request(ref)
    await eventually { requests.pendingState(for: ref) == nil }
    #expect(log.errors == ["Your account can’t request albums"])
    #expect(log.toasts.isEmpty)
  }

  @Test func removesARequestFromTheListOnly() async {
    let api = FakeAPI()
    api.on(.delete, "/api/requests/rg-1", json: "")
    api.on(.get, "/api/requests", [AlbumRequest]())
    let requests = model(api)
    await requests.remove(albumRequest("rg-1", "Mezzanine", .waiting))
    #expect(api.calls(.delete, "/api/requests/rg-1").count == 1)
    #expect(requests.requests == [])
  }

  @Test func offersTheRestOfAnIncompleteAlbum() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [albumRequest("rg-9", "Mezzanine (Deluxe)", .downloading, progress: 0.5)])
    let requests = model(api)
    #expect(requests.rest(of: album(have: 11, total: 11)) == nil)
    #expect(requests.rest(of: album(type: "Loose", have: 3, total: 9)) == nil)
    let fresh = requests.rest(of: album(have: 3, total: 11))
    #expect(fresh?.album == AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine"))
    #expect(fresh?.availability.state == .noneValue)
    #expect(requests.rest(of: album(have: 1, total: 1, mayBeIncomplete: true)) != nil)
    await requests.refresh()
    // Recognised by artist and title when the album has no MusicBrainz id.
    #expect(requests.rest(of: album(have: 3, total: 11))?.availability.state == .downloading)
  }

  @Test func hidesTheRestOnceItIsAllHere() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Something Else", .available, albumId: 70)])
    let requests = model(api)
    await requests.refresh()
    #expect(requests.rest(of: album(mbid: "rg-1", have: 3, total: 11)) == nil)
  }
}
