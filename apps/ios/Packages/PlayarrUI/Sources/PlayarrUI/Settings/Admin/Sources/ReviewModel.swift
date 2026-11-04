import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → "N albums to review": one doubtful album at a time; use a MusicBrainz candidate,
/// search with other names, fix the names by hand, or leave it unmatched (ReviewDialog). A decision shows
/// the next album at once while it saves above it; a failed save puts the album back.
@MainActor @Observable
public final class ReviewModel {
  /// What happened to the last album decided on, shown above the next one.
  public struct Saved: Equatable {
    public enum State: Equatable { case saving, done, failed(String) }
    let id: Int
    public let text: String
    public var state: State

    public var line: String {
      switch state {
      case .saving: "Saving: \(text)…"
      case .done: "Saved: \(text)"
      case .failed(let error): "Couldn’t save \(text): \(error). It’s back in the list."
      }
    }
  }

  public private(set) var groups: [ReviewGroup]?
  public private(set) var loadError: String?
  public private(set) var saved: Saved?
  public private(set) var searching = false
  /// Why the last search failed.
  public private(set) var error: String?

  // The album on screen: the candidate chosen, and the names typed.
  public var chosen: String?
  public var artist = ""
  public var album = ""
  public var fixing = false
  public var titles: [String: String] = [:]

  /// Bumped when details are missing again after polling stopped: the view restarts `poll()` with it.
  public private(set) var pollRound = 0

  @ObservationIgnored let sourceId: Int
  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let sourcesChanged: @MainActor () -> Void
  @ObservationIgnored private var hidden: Set<String> = []
  @ObservationIgnored private var editing: String?
  @ObservationIgnored private var updates = 0
  @ObservationIgnored private var polling = false
  @ObservationIgnored private var counter = 0
  @ObservationIgnored var noteTask: Task<Void, Never>?

  /// How many times to ask again while MusicBrainz details are still coming (every 2 s: about a minute).
  static let detailPolls = 30

  public init(sourceId: Int, api: any APISending, clock: any Clock<Duration> = ContinuousClock(), sourcesChanged: @escaping @MainActor () -> Void = {}) {
    self.sourceId = sourceId
    self.api = api
    self.clock = clock
    self.sourcesChanged = sourcesChanged
  }

  /// The albums still to decide on: those being saved stay off the list.
  public var visible: [ReviewGroup]? { groups?.filter { !hidden.contains($0.groupKey) } }
  public var current: ReviewGroup? { visible?.first }
  public var remaining: Int { visible?.count ?? 0 }
  public var candidate: ReviewCandidate? { current?.candidates.first { $0.releaseId == chosen } }

  /// The server fetches edition details in the background for the album on screen and the next one.
  var needsDetails: Bool {
    (groups ?? []).prefix(2).contains { $0.candidates.contains { !$0.detailed } }
  }

  var pollInterval: Duration? { needsDetails && updates < Self.detailPolls ? .seconds(2) : nil }

  public func poll() async {
    polling = true
    defer { polling = false }
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      apply(try await api.send(API.Settings.review(sourceId: sourceId)))
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  public var canSearch: Bool { !searching && !artist.trimmed.isEmpty && !album.trimmed.isEmpty }
  public var canRename: Bool { !artist.trimmed.isEmpty && !album.trimmed.isEmpty }

  /// Look for other candidates with these names; the album stays on screen until they're in.
  public func search() async {
    guard let group = current, canSearch else { return }
    searching = true
    error = nil
    defer { searching = false }
    do {
      _ = try await api.send(API.Settings.reviewAction(sourceId: sourceId, ReviewAction(groupKey: group.groupKey, search: .init(artist: artist.trimmed, album: album.trimmed))))
      await load()
    } catch {
      self.error = failureText(error)
    }
  }

  public func useChosen() async {
    guard let group = current, let candidate else { return }
    await decide(group, ReviewAction(groupKey: group.groupKey, releaseId: .some(candidate.releaseId)), "\(candidate.title) · \(candidate.artistName)")
  }

  public func leaveUnmatched() async {
    guard let group = current else { return }
    await decide(group, ReviewAction(groupKey: group.groupKey, releaseId: .some(nil)), "\(ReviewText.yourAlbum(group)) left unmatched")
  }

  /// "Save names": the user's own artist, album and song titles, used without a MusicBrainz match.
  public func saveNames() async {
    guard let group = current, canRename else { return }
    let names = ReviewAction.Names(artist: artist.trimmed, album: album.trimmed, titles: titles)
    await decide(group, ReviewAction(groupKey: group.groupKey, names: names), "\(names.album) · \(names.artist): names saved")
  }

  private func decide(_ group: ReviewGroup, _ action: ReviewAction, _ text: String) async {
    counter += 1
    let id = counter
    saved = Saved(id: id, text: text, state: .saving)
    hidden.insert(group.groupKey)
    resetEditing()
    do {
      _ = try await api.send(API.Settings.reviewAction(sourceId: sourceId, action))
      groups?.removeAll { $0.groupKey == group.groupKey }
      hidden.remove(group.groupKey)
      if saved?.id == id { saved?.state = .done }
      dropNoteLater(id)
      sourcesChanged()
      await load()
    } catch {
      hidden.remove(group.groupKey)
      resetEditing()
      if saved?.id == id { saved?.state = .failed(failureText(error)) }
    }
  }

  /// "Saved" goes after a moment; errors stay until the next decision.
  private func dropNoteLater(_ id: Int) {
    noteTask?.cancel()
    noteTask = Task { [weak self, clock] in
      do { try await clock.sleep(for: .seconds(4)) } catch { return }
      guard let self, self.saved?.id == id, self.saved?.state == .done else { return }
      self.saved = nil
    }
  }

  private func apply(_ list: [ReviewGroup]) {
    groups = list
    updates += 1
    resetEditing()
    if needsDetails, !polling {
      updates = 0
      pollRound += 1
    }
  }

  /// A new album on screen starts with its best candidate and its own names; background refreshes keep the choice.
  private func resetEditing() {
    guard let group = current else {
      editing = nil
      return
    }
    if editing != group.groupKey {
      editing = group.groupKey
      chosen = group.candidates.first?.releaseId
      artist = group.artistName
      album = group.albumTitle ?? ""
      fixing = false
      titles = Dictionary(group.files.map { ($0.rel, $0.title) }, uniquingKeysWith: { first, _ in first })
    } else if !group.candidates.contains(where: { $0.releaseId == chosen }) {
      chosen = group.candidates.first?.releaseId
    }
  }
}
