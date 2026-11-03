import Foundation
import PlayarrAPI
@testable import PlayarrUI

/// Small builders for phase 8's tests (Discover, requests, metadata, mix points).
func availability(_ state: AvailabilityState, albumId: Int? = nil, have: Int? = nil, total: Int? = nil, progress: Double? = nil, message: String? = nil) -> Availability {
  Availability(state: state, albumId: albumId, have: have, total: total, progress: progress, message: message)
}

func albumRequest(_ mbid: String, _ title: String, _ state: AvailabilityState, albumId: Int? = nil, progress: Double? = nil) -> AlbumRequest {
  AlbumRequest(mbid: mbid, title: title, artistName: "Massive Attack", requestedAt: "2026-11-03T10:00:00.000Z", availability: availability(state, albumId: albumId, progress: progress))
}

func account(canRequest: Bool = true, role: AccountRole = .member) -> Account {
  Account(id: 2, username: "sam", name: "Sam", role: role, canRequest: canRequest, sources: nil, hasPassword: true)
}

func health(lidarr: Bool = true, requests: Bool = true) -> HealthStatus {
  HealthStatus(ok: true, lidarr: lidarr ? .init(ok: true, version: "2.9") : nil, media: .init(source: .local, ok: true), requests: requests)
}

func album(id: Int = 70, title: String = "Mezzanine", mbid: String? = nil, type: String = "Album", have: Int = 11, total: Int = 11, mayBeIncomplete: Bool? = nil) -> Album {
  Album(
    id: id, title: title, artistId: 7, artistName: "Massive Attack", albumType: type, secondaryTypes: [], genres: [],
    duration: 3000, trackCount: have, totalTrackCount: total, mbid: mbid, mayBeIncomplete: mayBeIncomplete)
}

/// What the models said to the rest of the app.
@MainActor final class EventLog {
  var toasts: [String] = []
  var errors: [String] = []
  var invalidated: [CacheFamily] = []

  func toast(_ text: String, _ isError: Bool) {
    if isError { errors.append(text) } else { toasts.append(text) }
  }

  func invalidate(_ families: [CacheFamily]) { invalidated += families }
}

/// Waits (up to a second) for something another task does.
@MainActor func eventually(_ condition: () -> Bool) async {
  for _ in 0..<1000 where !condition() { try? await Task.sleep(for: .milliseconds(1)) }
}
