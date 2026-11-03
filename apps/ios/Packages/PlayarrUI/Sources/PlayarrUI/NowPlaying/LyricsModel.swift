import Foundation
import Observation
import PlayarrAPI

/// Now Playing → Lyrics (apps/web/src/components/LyricsView.tsx): the words of the song playing, following along when
/// they're timed. Following pauses for 4 s after scrolling by hand; a line tapped plays from there.
@MainActor @Observable
final class LyricsModel {
  enum State: Equatable {
    case loading
    case unavailable
    case none
    case instrumental
    case plain(String, Lyrics.Source)
    case synced([Lyrics.SyncedItem], Lyrics.Source)
  }

  /// Following pauses this long after the lines were scrolled by hand.
  static let followPause: TimeInterval = 4

  let trackId: Int
  private(set) var state: State = .loading
  @ObservationIgnored private var touchedAt = Date.distantPast
  @ObservationIgnored private let session: AccountSession

  init(trackId: Int, session: AccountSession) {
    self.trackId = trackId
    self.session = session
  }

  /// Asked once per song, with one retry, as the web does (`staleTime: Infinity`, `retry: 1`).
  func load() async {
    let api = session.api
    let id = trackId
    if let hit = session.queries.cached(.lyrics(id), as: LyricsAnswer.self) {
      state = Self.state(hit.value.lyrics)
      return
    }
    do {
      let answer = try await session.queries.fetch(.lyrics(id)) {
        do { return try await api.send(API.Library.lyrics(trackId: id)) } catch { return try await api.send(API.Library.lyrics(trackId: id)) }
      }
      state = Self.state(answer.lyrics)
    } catch is CancellationError {
    } catch {
      state = .unavailable
    }
  }

  static func state(_ lyrics: Lyrics?) -> State {
    guard let lyrics else { return .none }
    if lyrics.instrumental == true { return .instrumental }
    if let synced = lyrics.synced, !synced.isEmpty { return .synced(synced, lyrics.source) }
    if let plain = lyrics.plain { return .plain(plain, lyrics.source) }
    return .none
  }

  /// The lines were scrolled by hand.
  func touched(at now: Date = Date()) { touchedAt = now }

  /// Whether to scroll to the line being sung.
  func follows(at now: Date = Date()) -> Bool { now.timeIntervalSince(touchedAt) >= Self.followPause }

  func seek(to line: Lyrics.SyncedItem) {
    session.player.seek(to: line.at)
  }

  /// The line being sung at `time`: the last that started (0.15 s early); -1 before the first.
  nonisolated static func lineAt(_ lines: [Double], time: Double) -> Int {
    var low = 0
    var high = lines.count - 1
    var found = -1
    while low <= high {
      let mid = (low + high) / 2
      if lines[mid] <= time + 0.15 {
        found = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }
}
