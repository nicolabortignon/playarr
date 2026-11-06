import Foundation
import Observation
import PlayarrAPI

/// The account's album requests, kept fresh: asked for every 10 s while any is on its way and every minute
/// otherwise; when one becomes playable the library is refreshed and the listener told, once (lib/queries.ts:
/// useRequests, useWatchRequests, useRequestAlbum). One per signed-in account, owned by `DiscoverContext`.
@MainActor @Observable
public final class RequestsModel {
  public private(set) var requests: [AlbumRequest]?
  public private(set) var error: String?
  /// Requests on their way to the server, by `AlbumRef.requestKey`.
  public private(set) var pending: [String: PendingRequest] = [:]

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let toast: @MainActor (String, Bool) -> Void
  /// Where stale families are reported (the owner may set it after making the model).
  @ObservationIgnored var invalidate: @MainActor ([CacheFamily]) -> Void
  @ObservationIgnored private let notifier: (any RequestNotifier)?
  @ObservationIgnored private var watch = RequestWatch()
  @ObservationIgnored private var poller: Task<Void, Never>?

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

  /// Asks for the requests now; announces any that became playable.
  public func refresh() async {
    do {
      let fresh = try await api.send(API.Requests.list())
      requests = fresh
      error = nil
      let landed = watch.landed(in: fresh)
      guard let message = RequestWatch.message(for: landed) else { return }
      invalidate(CacheFamily.landed)
      toast(message, false)
      notifier?.landed(landed)
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func pendingState(for album: AlbumRef) -> PendingRequest? { pending[album.requestKey] }

  public func buttonState(for album: AlbumRef, availability: Availability, allowed: Bool) -> RequestButtonState {
    RequestButtonState.make(availability, allowed: allowed, pending: pendingState(for: album))
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
      toast(
        made.availability.state == .searching
          ? "Requested “\(made.title)”. Lidarr is searching for it"
          : "Requested “\(made.title)”. Lidarr will search for it on its schedule", false)
      invalidate(CacheFamily.requested)
      // One is on its way now: asked for at once and then every 10 s, not after the minute the poll already waits.
      if poller != nil { startPolling() } else { await refresh() }
    } catch {
      toast(error.localizedDescription, true)
    }
  }

  /// Takes a request off the list; Lidarr keeps the album wanted.
  public func remove(_ request: AlbumRequest) async {
    do {
      _ = try await api.send(API.Requests.remove(mbid: request.mbid))
    } catch {
      toast(error.localizedDescription, true)
    }
    await refresh()
  }

  /// A library album missing songs: what to ask Lidarr for, and how a request for it is doing (RequestRest). Nil
  /// for a complete album, the "Loose songs" bucket, or once the whole album is here.
  public func rest(of album: Album) -> (album: AlbumRef, availability: Availability)? {
    guard Self.canRequestRest(album) else { return nil }
    // Albums known only from their tags have no MusicBrainz id: the server finds them by artist and title, and
    // their request is recognised the same way.
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
