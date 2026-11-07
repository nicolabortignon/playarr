import Foundation
import Observation
import PlayarrAPI

/// The account's album requests, kept fresh: asked for every 10 s while any is on its way and every minute otherwise.
/// When one of the account's own becomes playable the library is refreshed and the listener told, once; when someone's
/// starts waiting for an admin's answer, the admin is told (lib/queries.ts: useRequests, useWatchRequests,
/// useRequestAlbum, useAnswerRequest). A member's list holds the requests they asked for, an admin's every request. One
/// per signed-in account, owned by `DiscoverContext`.
@MainActor @Observable
public final class RequestsModel {
  public private(set) var requests: [AlbumRequest]?
  public private(set) var error: String?
  /// Requests on their way to the server, by `AlbumRef.requestKey`.
  public private(set) var pending: [String: PendingRequest] = [:]
  /// Requests taken off the list whose Undo hasn't gone yet, by MusicBrainz id: hidden, and forgotten by the server only
  /// once it has. Asking Lidarr again couldn't bring one back (an album that has arrived can't be requested), so the
  /// removal waits (pages/Requests.tsx `useRemoving`; docs/design.md, "Taking things back").
  public private(set) var removing: Set<String> = []
  /// An admin's answers on their way to the server, by MusicBrainz id: true for Approve, false for Decline.
  public private(set) var answering: [String: Bool] = [:]
  /// The requests that were news when Requests showed them (arrived, or declined, since the last look): marked as new
  /// for as long as the page stays open, though the server has been told they've been seen (useSeeRequests).
  public private(set) var fresh: Set<String> = []

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let toast: @MainActor (String, Bool) -> Void
  /// Where stale families are reported (the owner may set it after making the model).
  @ObservationIgnored var invalidate: @MainActor ([CacheFamily]) -> Void
  @ObservationIgnored private let notifier: (any RequestNotifier)?
  @ObservationIgnored private var watch = RequestWatch()
  @ObservationIgnored private var poller: Task<Void, Never>?
  /// Requests is on screen: what's news there is seen as it comes.
  @ObservationIgnored private var showing = false
  @ObservationIgnored private var marking = false

  public init(
    api: any APISending, clock: any Clock<Duration> = ContinuousClock(), notifier: (any RequestNotifier)? = nil,
    toast: @escaping @MainActor (String, Bool) -> Void, invalidate: @escaping @MainActor ([CacheFamily]) -> Void
  ) {
    self.api = api
    self.clock = clock
    self.notifier = notifier
    self.toast = toast
    self.invalidate = invalidate
  }

  /// "2 requests in progress".
  public var activeCount: Int { RequestPolling.activeCount(requests) }

  /// The badge on Requests: the account's own requests that arrived or were declined since it last looked, and for an
  /// admin those waiting for their answer (a member's list never holds another's) (requestNewsCount).
  public var newsCount: Int {
    requests?.filter { $0.unseen == true || ($0.approval == .waiting && $0.mine == false) }.count ?? 0
  }

  /// The list as Requests shows it: without those being taken off it.
  public var shown: [AlbumRequest]? { requests?.filter { !removing.contains($0.mbid) } }

  /// Asks now, then every 10 s or 60 s until `stopPolling()`.
  public func startPolling() {
    poller?.cancel()
    poller = Task { [weak self, clock] in
      while !Task.isCancelled {
        guard let wait = await self?.refreshForNextPoll() else { return }
        do { try await clock.sleep(for: wait) } catch { return }
      }
    }
  }

  public func stopPolling() {
    poller?.cancel()
    poller = nil
  }

  private func refreshForNextPoll() async -> Duration {
    await refresh()
    return RequestPolling.interval(after: requests)
  }

  /// Asks for the requests now; announces what changed, and with Requests on screen, has its news seen.
  public func refresh() async {
    do {
      let fresh = try await api.send(API.Requests.list())
      requests = fresh
      error = nil
      announce(watch.changes(in: fresh))
      if showing { await markSeen() }
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// The library has what landed, whoever asked; the listener hears only of their own, and an admin of what waits for them.
  private func announce(_ changes: RequestWatch.Changes) {
    if !changes.landed.isEmpty { invalidate(CacheFamily.landed) }
    let yours = changes.landedForYou
    if let message = RequestWatch.message(for: yours) {
      toast(message, false)
      notifier?.landed(yours)
    }
    if let message = RequestWatch.waitingMessage(for: changes.waiting) {
      toast(message, false)
      notifier?.waiting(changes.waiting)
    }
  }

  /// Requests came on screen: its news has now been seen, and so is what comes while it stays open.
  public func opened() async {
    showing = true
    if requests == nil { await refresh() } else { await markSeen() }
  }

  /// Requests went off screen: what comes waits for the next look, and nothing stays marked as new.
  public func closed() {
    showing = false
    fresh = []
  }

  /// Tells the server the account has seen its news, which leaves the badge at once; it stays marked as new on the page.
  private func markSeen() async {
    let unseen = (requests ?? []).filter { $0.unseen == true }.map(\.mbid)
    guard !unseen.isEmpty, !marking else { return }
    marking = true
    defer { marking = false }
    fresh.formUnion(unseen)
    do {
      _ = try await api.send(API.Requests.seen(mbids: unseen))
      requests = requests?.map { request in
        var seen = request
        if unseen.contains(request.mbid) { seen.unseen = false }
        return seen
      }
    } catch {
      // Not said: the next look tries again. The badge stays meanwhile, which is all that's lost.
    }
  }

  public func pendingState(for album: AlbumRef) -> PendingRequest? { pending[album.requestKey] }

  public func buttonState(for album: AlbumRef, availability: Availability, allowed: Bool) -> RequestButtonState {
    RequestButtonState.make(availability, allowed: allowed, pending: pendingState(for: album), awaitingApproval: awaitsApproval(album))
  }

  /// The account asked for this album and an admin hasn't answered yet. Search and artist pages know nothing of it (to
  /// anyone else the album is still to be asked for), so it's found in the account's own requests: by release group, or
  /// by artist and title for an album known only by name.
  public func awaitsApproval(_ album: AlbumRef) -> Bool {
    requests?.contains { request in
      request.approval == .waiting && request.mine != false
        && ((album.mbid != nil && request.mbid == album.mbid)
          || (TitleKey.of(request.artistName) == TitleKey.of(album.artistName) && TitleKey.of(request.title) == TitleKey.of(album.albumTitle)))
    } ?? false
  }

  /// Asks Lidarr for the album. Returns at once; the button shows "Requesting…" (then "Looking up…") meanwhile.
  public func request(_ album: AlbumRef) {
    let key = album.requestKey
    guard pending[key] == nil else { return }
    pending[key] = .requesting
    notifier?.requested()
    let slow = Task { [weak self, clock] in
      do { try await clock.sleep(for: PendingRequest.slowAfter) } catch { return }
      guard let self, self.pending[key] == .requesting else { return }
      self.pending[key] = .lookingUp
    }
    Task {
      await send(album, key: key)
      slow.cancel()
    }
  }

  private func send(_ album: AlbumRef, key: String) async {
    defer { pending[key] = nil }
    do {
      let made = try await api.send(API.Requests.request(album))
      toast(Self.requestedMessage(made), false)
      invalidate(CacheFamily.requested)
      // One is on its way now: asked for at once and then every 10 s, not after the minute the poll already waits.
      if poller != nil { startPolling() } else { await refresh() }
    } catch {
      toast(error.localizedDescription, true)
    }
  }

  /// What a request's toast says: where it went (useRequestAlbum).
  static func requestedMessage(_ made: AlbumRequest) -> String {
    if made.approval == .waiting { return "Requested “\(made.title)”. It goes to Lidarr once an admin approves it" }
    return made.availability.state == .searching
      ? "Requested “\(made.title)”. Lidarr is searching for it"
      : "Requested “\(made.title)”. Lidarr will search for it on its schedule"
  }

  /// An admin's yes to a request waiting for approval: it goes to Lidarr.
  public func approve(_ request: AlbumRequest) async { await answer(request, yes: true) }

  /// An admin's no: whoever asked sees it declined.
  public func decline(_ request: AlbumRequest) async { await answer(request, yes: false) }

  private func answer(_ request: AlbumRequest, yes: Bool) async {
    guard answering[request.mbid] == nil else { return }
    answering[request.mbid] = yes
    defer { answering[request.mbid] = nil }
    // Hearing of the next one is plainly useful once an admin has answered one: the moment to ask to notify.
    notifier?.requested()
    do {
      let answered = try await api.send(yes ? API.Requests.approve(mbid: request.mbid) : API.Requests.decline(mbid: request.mbid))
      toast(Self.answeredMessage(answered, yes: yes), false)
      if yes { invalidate(CacheFamily.requested) }
    } catch {
      toast(error.localizedDescription, true)
    }
    await refresh()
  }

  /// "Approved “Heligoland”. Lidarr is searching for it", "Declined “Heligoland”" (useAnswerRequest).
  static func answeredMessage(_ request: AlbumRequest, yes: Bool) -> String {
    guard yes else { return "Declined “\(request.title)”" }
    return request.availability.state == .searching
      ? "Approved “\(request.title)”. Lidarr is searching for it"
      : "Approved “\(request.title)”. Lidarr will search for it on its schedule"
  }

  /// Off the list at once, while its Undo lasts (`unhide(_:)` puts it back); `remove(_:)` once it has gone.
  public func hide(_ request: AlbumRequest) { removing.insert(request.mbid) }
  public func unhide(_ request: AlbumRequest) { removing.remove(request.mbid) }

  /// Takes a request off the list for good (an admin's: off everyone's); Lidarr keeps the album wanted.
  public func remove(_ request: AlbumRequest) async {
    do {
      _ = try await api.send(API.Requests.remove(mbid: request.mbid))
    } catch {
      toast(error.localizedDescription, true)
    }
    await refresh()
    removing.remove(request.mbid)
  }

  /// A library album missing songs: what to ask Lidarr for, and how a request for it is doing (RequestRest). Nil
  /// for a complete album, the "Loose songs" bucket, or once the whole album is here.
  public func rest(of album: Album) -> (album: AlbumRef, availability: Availability)? {
    guard Self.canRequestRest(album) else { return nil }
    // Albums known only from their tags have no MusicBrainz id: the server finds them by artist and title, and
    // their request is recognized the same way.
    let made = requests?.first { request in
      (album.mbid != nil && request.mbid == album.mbid)
        || (TitleKey.of(request.artistName) == TitleKey.of(album.artistName) && TitleKey.of(request.title) == TitleKey.of(album.title))
    }
    let availability = made?.availability ?? Availability(state: .noneValue)
    guard availability.state != .available else { return nil }
    return (AlbumRef(mbid: album.mbid, artistName: album.artistName, albumTitle: album.title), availability)
  }

  /// Songs are missing and it's a real album (canRequestRest).
  public static func canRequestRest(_ album: Album) -> Bool {
    album.albumType != "Loose" && (album.trackCount < album.totalTrackCount || album.mayBeIncomplete == true)
  }
}
