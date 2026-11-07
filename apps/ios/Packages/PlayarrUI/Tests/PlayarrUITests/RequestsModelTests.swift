import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// Remembers what it was told.
@MainActor final class FakeNotifier: RequestNotifier {
  var asked = 0
  var landed: [[AlbumRequest]] = []
  var waiting: [[AlbumRequest]] = []
  func requested() { asked += 1 }
  func landed(_ requests: [AlbumRequest]) { landed.append(requests) }
  func waiting(_ requests: [AlbumRequest]) { waiting.append(requests) }
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

  @Test func hidesARequestAtOnceAndForgetsItOnlyOnceItsUndoHasGone() async {
    let api = FakeAPI()
    let mezzanine = albumRequest("rg-1", "Mezzanine", .waiting)
    let dummy = albumRequest("rg-2", "Dummy", .searching)
    api.on(.get, "/api/requests", [mezzanine, dummy])
    let requests = model(api)
    await requests.refresh()
    requests.hide(mezzanine)
    #expect(requests.shown?.map(\.mbid) == ["rg-2"])
    #expect(api.calls(.delete, "/api/requests/rg-1").isEmpty)
    // Undo: back as it was, and the server never asked.
    requests.unhide(mezzanine)
    #expect(requests.shown?.map(\.mbid) == ["rg-1", "rg-2"])
    // The Undo gone: forgotten by the server, and off the list for good.
    requests.hide(mezzanine)
    api.on(.delete, "/api/requests/rg-1", json: "")
    api.on(.get, "/api/requests", [dummy])
    await requests.remove(mezzanine)
    #expect(api.calls(.delete, "/api/requests/rg-1").count == 1)
    #expect(requests.removing.isEmpty)
    #expect(requests.shown?.map(\.mbid) == ["rg-2"])
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

  // MARK: Requests belong to whoever asked

  @Test func aRequestWaitingForApprovalSaysSoAndIsPendingWhereverTheAlbumShows() async {
    let api = FakeAPI()
    api.on(.post, "/api/requests", waitingRequest("rg-1", "Mezzanine", mine: true))
    api.on(.get, "/api/requests", [waitingRequest("rg-1", "Mezzanine", mine: true)])
    let requests = model(api)
    let ref = AlbumRef(mbid: "rg-1", artistName: "Massive Attack", albumTitle: "Mezzanine")
    requests.request(ref)
    await eventually { requests.pendingState(for: ref) == nil && requests.requests?.isEmpty == false }
    #expect(log.toasts == ["Requested “Mezzanine”. It goes to Lidarr once an admin approves it"])
    // Search still says nobody asked for it (an admin hasn't sent it to Lidarr); the account's own list knows better.
    #expect(requests.buttonState(for: ref, availability: availability(.noneValue), allowed: true) == .awaitingApproval)
    // Known only by name, as an album from its tags is.
    let byName = AlbumRef(artistName: "massive attack", albumTitle: "Mezzanine")
    #expect(requests.buttonState(for: byName, availability: availability(.noneValue), allowed: true) == .awaitingApproval)
    let other = AlbumRef(mbid: "rg-2", artistName: "Massive Attack", albumTitle: "Heligoland")
    #expect(requests.buttonState(for: other, availability: availability(.noneValue), allowed: true) == .request)
  }

  @Test func someoneElsesWaitingRequestIsntPendingForAnAdmin() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [waitingRequest("rg-1", "Mezzanine", mine: false, askedBy: ["Sam"])])
    let requests = model(api)
    await requests.refresh()
    let ref = AlbumRef(mbid: "rg-1", artistName: "Massive Attack", albumTitle: "Mezzanine")
    #expect(requests.buttonState(for: ref, availability: availability(.noneValue), allowed: true) == .request)
  }

  @Test func approvesARequestOnceAndSaysWhereItWent() async {
    let api = FakeAPI()
    let sams = waitingRequest("rg-1", "Mezzanine", mine: false, askedBy: ["Sam"])
    api.on(.get, "/api/requests", [sams])
    let answer = Gate()
    api.on(.post, "/api/requests/rg-1/approve", albumRequest("rg-1", "Mezzanine", .searching, mine: false, askedBy: ["Sam"]))
    api.hold(.post, "/api/requests/rg-1/approve", until: answer)
    let requests = model(api)
    await requests.refresh()
    let approving = Task { await requests.approve(sams) }
    await eventually { requests.answering["rg-1"] == true }
    // Answered once: a second press while the first is on its way does nothing.
    await requests.decline(sams)
    #expect(api.calls(.post, "/api/requests/rg-1/decline").isEmpty)
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .searching, mine: false, askedBy: ["Sam"])])
    await answer.open()
    await approving.value
    #expect(api.calls(.post, "/api/requests/rg-1/approve").count == 1)
    #expect(requests.answering.isEmpty)
    #expect(log.toasts == ["Approved “Mezzanine”. Lidarr is searching for it"])
    #expect(log.invalidated == CacheFamily.requested)
    #expect(requests.requests?.first?.approval == nil)
    #expect(notifier.asked == 1)
  }

  @Test func anAdminDeclinesARequest() async {
    let api = FakeAPI()
    let sams = waitingRequest("rg-1", "Mezzanine", mine: false, askedBy: ["Sam"])
    var declined = albumRequest("rg-1", "Mezzanine", .failed, mine: false, askedBy: ["Sam"], approval: .declined)
    declined.availability.message = "Declined by you"
    api.on(.post, "/api/requests/rg-1/decline", declined)
    api.on(.get, "/api/requests", [declined])
    let requests = model(api)
    await requests.decline(sams)
    #expect(log.toasts == ["Declined “Mezzanine”"])
    #expect(log.invalidated.isEmpty)
    #expect(requests.requests?.first?.approval == .declined)
  }

  @Test func saysWhyAnAnswerWasRefused() async {
    let api = FakeAPI()
    api.fail(.post, "/api/requests/rg-1/decline", status: 409, "“Mezzanine” has already gone to Lidarr")
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .searching)])
    let requests = model(api)
    await requests.decline(waitingRequest("rg-1", "Mezzanine", mine: false))
    #expect(log.errors == ["“Mezzanine” has already gone to Lidarr"])
    #expect(requests.requests?.first?.availability.state == .searching)
  }

  @Test func theBadgeCountsNewsAndWhatWaitsForAnAdminsAnswer() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [
      waitingRequest("rg-1", "Mezzanine", mine: false, askedBy: ["Sam"]),
      albumRequest("rg-2", "Heligoland", .available, mine: true, unseen: true),
      albumRequest("rg-3", "Blue Lines", .available, mine: true, unseen: false),
      albumRequest("rg-4", "Protection", .searching, mine: true),
      // An admin's own never waits; a member's own waiting request is nothing to answer.
      waitingRequest("rg-5", "100th Window", mine: true),
    ])
    let requests = model(api)
    #expect(requests.newsCount == 0)
    await requests.refresh()
    #expect(requests.newsCount == 2)
  }

  @Test func requestsOnScreenHaveTheirNewsSeenAndStayMarkedUntilTheyGo() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [
      albumRequest("rg-1", "Mezzanine", .available, mine: true, unseen: true),
      albumRequest("rg-2", "Heligoland", .searching, mine: true),
    ])
    api.on(.post, "/api/requests/seen", json: "")
    let requests = model(api)
    await requests.refresh()
    #expect(api.calls(.post, "/api/requests/seen").isEmpty)
    await requests.opened()
    #expect(api.bodies(.post, "/api/requests/seen") == [#"{"mbids":["rg-1"]}"#])
    #expect(requests.newsCount == 0)
    #expect(requests.fresh == ["rg-1"])
    // While it stays open, what arrives is seen as it comes, and what was news stays marked.
    api.on(.get, "/api/requests", [
      albumRequest("rg-1", "Mezzanine", .available, mine: true, unseen: false),
      albumRequest("rg-2", "Heligoland", .available, mine: true, unseen: true),
    ])
    await requests.refresh()
    #expect(api.bodies(.post, "/api/requests/seen").last == #"{"mbids":["rg-2"]}"#)
    #expect(requests.fresh == ["rg-1", "rg-2"])
    requests.closed()
    #expect(requests.fresh.isEmpty)
    // Off screen, news waits for the next look.
    api.on(.get, "/api/requests", [albumRequest("rg-3", "Blue Lines", .available, mine: true, unseen: true)])
    await requests.refresh()
    #expect(api.calls(.post, "/api/requests/seen").count == 2)
    #expect(requests.newsCount == 1)
  }

  @Test func opensOnRequestsBeforeTheyHaveComeAndSeesTheirNews() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .available, mine: true, unseen: true)])
    api.on(.post, "/api/requests/seen", json: "")
    let requests = model(api)
    await requests.opened()
    #expect(api.bodies(.post, "/api/requests/seen") == [#"{"mbids":["rg-1"]}"#])
    #expect(requests.newsCount == 0)
  }

  @Test func keepsTheBadgeWhenTheServerCantBeTold() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .available, mine: true, unseen: true)])
    api.fail(.post, "/api/requests/seen", status: 500, "Something went wrong")
    let requests = model(api)
    await requests.opened()
    #expect(requests.newsCount == 1)
    #expect(log.errors.isEmpty)
  }

  @Test func hearsOnlyOfItsOwnArrivalsThoughTheLibraryHasEveryone() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [
      albumRequest("rg-1", "Mezzanine", .searching, mine: false, askedBy: ["Sam"]),
      albumRequest("rg-2", "Heligoland", .searching, mine: true),
    ])
    let requests = model(api)
    await requests.refresh()
    api.on(.get, "/api/requests", [
      albumRequest("rg-1", "Mezzanine", .available, mine: false, askedBy: ["Sam"]),
      albumRequest("rg-2", "Heligoland", .available, mine: true),
    ])
    await requests.refresh()
    #expect(log.toasts == ["“Heligoland” is ready to play"])
    #expect(notifier.landed.map { $0.map(\.mbid) } == [["rg-2"]])
    #expect(log.invalidated == CacheFamily.landed)
  }

  @Test func tellsAnAdminOnceWhenSomeonesRequestStartsWaiting() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [AlbumRequest]())
    let requests = model(api)
    await requests.refresh()
    api.on(.get, "/api/requests", [waitingRequest("rg-1", "Mezzanine", mine: false, askedBy: ["Sam"])])
    await requests.refresh()
    await requests.refresh()
    #expect(log.toasts == ["Sam asked for “Mezzanine”"])
    #expect(notifier.waiting.map { $0.map(\.mbid) } == [["rg-1"]])
  }
}
