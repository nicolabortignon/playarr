import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The account's favorite songs, and the heart on every song: a toggle shows at once, goes back if the server says no
/// (with the web's toast), and the list is asked for again either way (apps/web/src/lib/queries.ts useToggleFavorite).
/// Kept in the answer cache under `favorites`, so the app opens with them.
@MainActor @Observable
public final class FavoritesStore {
  /// Newest first; nil until known.
  public private(set) var tracks: [FavoriteTrack]?
  public private(set) var error: String?
  private var ids: Set<String> = []

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let queries: QueryCache
  @ObservationIgnored private let toasts: ToastCenter
  /// Bumped by every toggle, so a list asked for before one doesn't undo it on screen.
  @ObservationIgnored private var changes = 0
  @ObservationIgnored private var inFlight = 0

  public static let source = PlaySource(label: "Favorites", href: "/favorites")

  public init(api: any APISending, queries: QueryCache, toasts: ToastCenter) {
    self.api = api
    self.queries = queries
    self.toasts = toasts
    show(queries.cached(.favorites, as: [FavoriteTrack].self)?.value)
  }

  public func isFavorite(_ recordingId: String) -> Bool { ids.contains(recordingId) }

  /// Seconds of music in the list.
  public var duration: Double { tracks?.reduce(0) { $0 + $1.duration } ?? 0 }

  public func load() async {
    let asked = changes
    do {
      let fresh = try await api.send(API.Favorites.list())
      guard asked == changes, inFlight == 0 else { return }
      show(fresh)
      error = nil
      queries.set(fresh, for: .favorites)
    } catch {
      if tracks == nil { self.error = error.localizedDescription }
    }
  }

  public func toggle(_ track: Track) async {
    await set(track, favorite: !isFavorite(track.recordingId))
  }

  public func set(_ track: Track, favorite: Bool) async {
    let previous = tracks
    changes += 1
    inFlight += 1
    let rest = (tracks ?? []).filter { $0.recordingId != track.recordingId }
    show(favorite ? [FavoriteTrack(track, favoritedAt: Date().formatted(.iso8601))] + rest : rest)
    do {
      if favorite {
        _ = try await api.send(API.Favorites.add(recordingId: track.recordingId))
      } else {
        _ = try await api.send(API.Favorites.remove(recordingId: track.recordingId))
      }
      inFlight -= 1
    } catch {
      inFlight -= 1
      show(previous)
      toasts.push("Couldn't update favorites: \(error.localizedDescription)", tone: .error)
    }
    if inFlight == 0 {
      changes += 1
      await load()
    }
  }

  private func show(_ list: [FavoriteTrack]?) {
    tracks = list
    ids = Set((list ?? []).map(\.recordingId))
  }
}
