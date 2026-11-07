import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The account's favorite songs, and the heart on every song: a toggle shows at once, goes back if the server says no
/// (with the web's toast), and the list is asked for again either way (apps/web/src/lib/queries.ts useToggleFavorite).
/// Un-hearted on the Favorites page, where it leaves the list in view, a song says so with Undo; hearted again, with
/// Undo or the heart, it goes back where it was, the time it was first favorited sent with it (docs/design.md, "Taking
/// things back"). Kept in the answer cache under `favorites`, so the app opens with them.
@MainActor @Observable
public final class FavoritesStore {
  /// Newest first; nil until known.
  public private(set) var tracks: [FavoriteTrack]?
  public private(set) var error: String?
  private var ids: Set<String> = []
  /// Favorites pages on screen (`FavoritesView`): a song un-hearted while one shows leaves the list in view, so a toast
  /// says so, with Undo (the web's FavoriteButton on /favorites).
  @ObservationIgnored var pagesShown = 0
  /// When each song un-hearted since the store opened had first been favorited, until it's hearted again (the web's
  /// `unhearted`).
  @ObservationIgnored private var unhearted: [String: String] = [:]

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
    let id = track.recordingId
    if !favorite, let since = previous?.first(where: { $0.recordingId == id })?.favoritedAt { unhearted[id] = since }
    // Hearted again: the time it was first favorited.
    let since = favorite ? unhearted[id] : nil
    changes += 1
    inFlight += 1
    let rest = (tracks ?? []).filter { $0.recordingId != id }
    if favorite {
      // Taken back, where it was in the list; new, at the top.
      let hearted = FavoriteTrack(track, favoritedAt: since ?? Date().formatted(.iso8601))
      show(since == nil ? [hearted] + rest : Self.inPlace(hearted, in: rest))
    } else {
      show(rest)
      if pagesShown > 0 {
        toasts.removed("Removed “\(track.title)” from Favorites") { [weak self] in
          Task { await self?.set(track, favorite: true) }
        }
      }
    }
    do {
      if favorite {
        _ = try await api.send(API.Favorites.add(recordingId: id, favoritedAt: since))
        unhearted[id] = nil
      } else {
        _ = try await api.send(API.Favorites.remove(recordingId: id))
      }
      inFlight -= 1
    } catch {
      inFlight -= 1
      show(previous)
      toasts.push("Couldn’t update Favorites: \(error.localizedDescription)", tone: .error)
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

  /// A favorite taken back, in its place in a list newest first: before the first one favorited before it.
  nonisolated static func inPlace(_ favorite: FavoriteTrack, in list: [FavoriteTrack]) -> [FavoriteTrack] {
    var list = list
    list.insert(favorite, at: list.firstIndex { $0.favoritedAt < favorite.favoritedAt } ?? list.endIndex)
    return list
  }
}
