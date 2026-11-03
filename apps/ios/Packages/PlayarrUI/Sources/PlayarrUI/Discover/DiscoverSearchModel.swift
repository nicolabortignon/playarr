import Observation
import PlayarrAPI

/// Search's "Not in your library": what MusicBrainz, Lidarr and Deezer know matching the query, asked 450 ms after
/// the typing stops and from 2 characters (Search.tsx DiscoverSection, useDiscover). Albums already playable and
/// artists already in the library are left out: they're in the results above.
@MainActor @Observable
public final class DiscoverSearchModel {
  /// The latest answer; kept while the next one loads (keepPreviousData).
  public private(set) var results: DiscoverResults?
  /// The query `results` (or `error`) answer.
  public private(set) var answered = ""
  public private(set) var fetching = false
  public private(set) var error: String?
  /// What was typed (trimmed).
  public private(set) var typed = ""

  public static let debounce: Duration = .milliseconds(450)
  public static let minimumLength = 2
  public static let songsShown = 8

  @ObservationIgnored private let context: DiscoverContext
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private var pending: Task<Void, Never>?

  public init(context: DiscoverContext, clock: any Clock<Duration> = ContinuousClock()) {
    self.context = context
    self.clock = clock
  }

  public var albums: [DiscoverAlbum] { results?.albums.filter { $0.availability.state != .available } ?? [] }
  public var artists: [DiscoverArtist] { results?.artists.filter { $0.artistId == nil } ?? [] }
  public var tracks: [DiscoverTrack] { Array((results?.tracks ?? []).prefix(Self.songsShown)) }
  /// "Nothing found for “…”."
  public var nothing: Bool { results != nil && albums.isEmpty && artists.isEmpty && tracks.isEmpty }
  /// Skeleton rows: nothing to show yet, and an answer is coming.
  public var loading: Bool { results == nil && (fetching || typed != answered) && typed.count >= Self.minimumLength }

  /// The search field changed (the page passes it trimmed).
  public func update(_ text: String) {
    typed = text
    pending?.cancel()
    pending = Task { [weak self, clock] in
      do { try await clock.sleep(for: Self.debounce) } catch { return }
      await self?.search(text)
    }
  }

  /// Asks again for what's typed (a request changed what's available).
  public func reload() async {
    pending?.cancel()
    await search(typed)
  }

  private func search(_ query: String) async {
    answered = query
    guard query.count >= Self.minimumLength else {
      results = nil
      error = nil
      return
    }
    fetching = true
    defer { if answered == query { fetching = false } }
    do {
      let fresh = try await context.discover(query)
      guard answered == query else { return }
      results = fresh
      error = nil
    } catch is CancellationError {
    } catch {
      guard answered == query else { return }
      self.error = error.localizedDescription
    }
  }
}
